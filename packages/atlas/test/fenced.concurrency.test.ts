import { describe, expect, it } from 'vitest';
import { CheckpointFence, FenceLostError, createFencedCheckpointer, type FenceClient, type FencePool } from '../src/fenced';

/**
 * One PostgreSQL-like session with a statement log. Transactions are per session (as in PostgreSQL): a second BEGIN inside
 * an open transaction is a protocol error, COMMIT publishes everything since BEGIN, ROLLBACK discards it. `failOn` makes a
 * matching statement error (aborting the transaction like PostgreSQL does); `hold` pauses a matching statement.
 */
function session() {
  const log: string[] = [], committed: string[] = [];
  let inTx = false, aborted = false, pending: string[] = [], alive = true, lockHeld = false;
  let failOn: RegExp | null = null, hold: { re: RegExp; release: Promise<void> } | null = null;
  const listeners: Array<() => void> = [];
  const client: FenceClient = {
    async query(q, values) {
      const text = (typeof q === 'string' ? q : q.text).trim();
      const vals = (typeof q === 'string' ? values : q.values ?? values) ?? [];
      const tag = text.startsWith('select pg_try_advisory_lock') ? 'LOCK' : text.startsWith('select exists(select 1 from pg_locks') ? 'VERIFY'
        : text.startsWith('select pg_advisory_unlock') ? 'UNLOCK' : /^(BEGIN|COMMIT|ROLLBACK)$/.test(text) ? text
        : `${text.split(/\s+/).slice(0, 3).join(' ')}#${vals.filter(v => typeof v === 'string').join('|')}`;
      if (hold && hold.re.test(tag)) await hold.release;
      if (!alive) throw Object.assign(new Error('terminated'), { code: '57P01' });
      log.push(tag);
      if (tag === 'LOCK') { lockHeld = true; return { rows: [{ ok: true }] }; }
      if (tag === 'UNLOCK') { lockHeld = false; return { rows: [] }; }
      if (tag === 'VERIFY') return { rows: [{ held: lockHeld }] };
      if (tag === 'BEGIN') { if (inTx) throw new Error('nested BEGIN on one session: transactions interleaved'); inTx = true; aborted = false; pending = []; return { rows: [] }; }
      if (tag === 'COMMIT') { if (!aborted) committed.push(...pending); inTx = false; pending = []; return { rows: [] }; }
      if (tag === 'ROLLBACK') { inTx = false; pending = []; aborted = false; return { rows: [] }; }
      if (aborted) throw new Error('current transaction is aborted');
      if (failOn && failOn.test(tag)) { if (inTx) aborted = true; throw new Error('injected statement failure'); }
      if (inTx) pending.push(tag); else committed.push(tag);
      return { rows: [] };
    },
    release() {},
    on(event, l) { if (event === 'error') listeners.push(l as () => void); return client; },
  };
  const pool: FencePool = { async connect() { return client; } };
  return {
    pool, log, committed,
    failOn(re: RegExp | null) { failOn = re; },
    holdUntil(re: RegExp) { let r!: () => void; hold = { re, release: new Promise<void>(x => { r = x; }) }; return () => { hold = null; r(); }; },
    kill() { alive = false; inTx = false; pending = []; lockHeld = false; listeners.forEach(l => l()); },
  };
}

const cfg = (ckpt?: string) => ({ configurable: { thread_id: 'atlas:v1:t', checkpoint_ns: '', ...(ckpt ? { checkpoint_id: ckpt } : {}) } });
const checkpoint = (id: string) => ({ v: 4, id, ts: new Date(0).toISOString(), channel_values: { a: 1 }, channel_versions: { a: 1 }, versions_seen: {} });
const meta = { source: 'loop', step: 1, parents: {} };
/** Each BEGIN must be followed by its own statements and COMMIT/ROLLBACK before the next BEGIN. */
function transactionsAreContiguous(log: string[]): boolean {
  let open = false;
  for (const s of log) { if (s === 'BEGIN') { if (open) return false; open = true; } else if (s === 'COMMIT' || s === 'ROLLBACK') open = false; }
  return true;
}

describe('fenced PostgresSaver under concurrent operations', () => {
  it('parallel put and putWrites run as separate, non-interleaved transactions', async () => {
    const s = session();
    const fence = (await CheckpointFence.acquire(s.pool, 'atlas:v1:t'))!;
    const saver = createFencedCheckpointer(fence);
    await Promise.all([
      saver.put(cfg() as never, checkpoint('ck-put') as never, meta as never, { a: 1 }),
      saver.putWrites(cfg('ck-put') as never, [['a', 2], ['b', 3]], 'task-1'),
      saver.putWrites(cfg('ck-put') as never, [['c', 4]], 'task-2'),
    ]);
    expect(transactionsAreContiguous(s.log)).toBe(true);
    expect(s.log.filter(x => x === 'BEGIN')).toHaveLength(3);
    expect(s.log.filter(x => x === 'COMMIT')).toHaveLength(3);
    // Every COMMIT is preceded by its own VERIFY, inside its own transaction.
    s.log.forEach((x, i) => { if (x === 'COMMIT') expect(s.log[i - 1]).toBe('VERIFY'); });
  });

  it('a failing operation rolls back only itself; the concurrent operation commits all of its rows', async () => {
    const s = session();
    const fence = (await CheckpointFence.acquire(s.pool, 'atlas:v1:t'))!;
    const saver = createFencedCheckpointer(fence);
    s.failOn(/^INSERT INTO .*task-bad/i);
    const results = await Promise.allSettled([
      saver.put(cfg() as never, checkpoint('ck-ok') as never, meta as never, { a: 1 }),
      saver.putWrites(cfg('ck-ok') as never, [['x', 1]], 'task-bad'),
      saver.putWrites(cfg('ck-ok') as never, [['y', 2]], 'task-good'),
    ]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(transactionsAreContiguous(s.log)).toBe(true);
    expect(s.committed.some(x => x.includes('task-bad'))).toBe(false);
    expect(s.committed.some(x => x.includes('task-good'))).toBe(true);
    expect(s.committed.some(x => x.includes('.checkpoints#') && x.includes('ck-ok'))).toBe(true);
    expect(fence.held).toBe(true); // an ordinary statement error does not lose the fence
  });

  it('lock lost while one write is in flight and another is waiting: neither commits, the waiter is rejected', async () => {
    const s = session();
    const fence = (await CheckpointFence.acquire(s.pool, 'atlas:v1:t'))!;
    const saver = createFencedCheckpointer(fence);
    const release = s.holdUntil(/^VERIFY$/); // the first operation pauses right before its commit check
    const first = saver.put(cfg() as never, checkpoint('ck-inflight') as never, meta as never, { a: 1 });
    const second = saver.putWrites(cfg('ck-inflight') as never, [['z', 9]], 'task-waiting');
    await new Promise(r => setTimeout(r, 20));
    expect(s.log.filter(x => x === 'BEGIN')).toHaveLength(1); // second has not started: it waits for the session
    s.kill();
    release();
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.every(o => o.status === 'rejected')).toBe(true);
    // Whichever operation was waiting for the session is refused by the fence and never reaches the session.
    expect(outcomes.some(o => o.status === 'rejected' && o.reason instanceof FenceLostError)).toBe(true);
    expect(s.log.filter(x => x === 'BEGIN')).toHaveLength(1);
    expect(s.committed.filter(x => !['LOCK'].includes(x))).toEqual([]);
    expect(fence.held).toBe(false);
  });

  it('fence loss while an operation waits for the session rejects the waiter without touching the session', async () => {
    const s = session();
    const fence = (await CheckpointFence.acquire(s.pool, 'atlas:v1:t'))!;
    const pool = fence.pool();
    const owner = await pool.connect();
    const waiting = pool.connect();
    const waitingQuery = pool.query('SELECT 1');
    fence.lose();
    await expect(waiting).rejects.toBeInstanceOf(FenceLostError);
    await expect(waitingQuery).rejects.toBeInstanceOf(FenceLostError);
    owner.release();
    await expect(pool.connect()).rejects.toBeInstanceOf(FenceLostError);
  });

  it('a client released with an open transaction is rolled back before the next owner runs', async () => {
    const s = session();
    const fence = (await CheckpointFence.acquire(s.pool, 'atlas:v1:t'))!;
    const pool = fence.pool();
    const a = await pool.connect();
    await a.query('BEGIN'); await a.query('INSERT INTO checkpoint_writes x', [0, 0, 'abandoned']);
    const b = pool.connect();
    a.release(); // error path that forgot ROLLBACK
    const bc = await b;
    await bc.query('BEGIN'); await bc.query('INSERT INTO checkpoint_writes y', [0, 0, 'next']); await bc.query('COMMIT'); bc.release();
    expect(s.committed.some(x => x.includes('#abandoned'))).toBe(false);
    expect(s.committed.some(x => x.includes('#next'))).toBe(true);
    expect(transactionsAreContiguous(s.log)).toBe(true);
    await expect(a.query('SELECT 1')).rejects.toThrow('checkout_released');
  });
});
