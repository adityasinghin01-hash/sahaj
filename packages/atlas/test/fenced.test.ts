import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { createAtlas } from '../src/index';
import { CheckpointFence, FenceLostError, createFencedCheckpointer, type FenceClient, type FencePool } from '../src/fenced';

/**
 * Fake single-session pg client. Models what matters for the fence: one session, advisory lock ownership by session,
 * transactions whose writes become visible only at COMMIT, and a "killed" connection that rolls back and drops the lock.
 */
function fakeServer() {
  const committed: string[] = [];
  let lockOwner: number | null = null, nextSession = 1;
  const sessions: Array<{ kill(): void; id: number }> = [];
  const pool: FencePool = {
    async connect() {
      const id = nextSession++;
      let alive = true, inTx = false, pending: string[] = [];
      const listeners: Record<string, Array<() => void>> = {};
      const client: FenceClient & { kill(): void } = {
        async query(q, _values) {
          const text = (typeof q === 'string' ? q : q.text).trim();
          if (!alive) throw Object.assign(new Error('connection terminated'), { code: '57P01' });
          if (text.startsWith('select pg_try_advisory_lock')) { if (lockOwner === null) { lockOwner = id; return { rows: [{ ok: true }] }; } return { rows: [{ ok: false }] }; }
          if (text.startsWith('select pg_advisory_unlock')) { if (lockOwner === id) lockOwner = null; return { rows: [] }; }
          if (text.startsWith('select exists(select 1 from pg_locks')) return { rows: [{ held: lockOwner === id }] };
          if (text === 'BEGIN') { inTx = true; pending = []; return { rows: [] }; }
          if (text === 'COMMIT') { committed.push(...pending); inTx = false; pending = []; return { rows: [] }; }
          if (text === 'ROLLBACK') { inTx = false; pending = []; return { rows: [] }; }
          if (inTx) pending.push(text.slice(0, 40)); else committed.push(text.slice(0, 40));
          return { rows: [] };
        },
        release() {},
        on(event, listener) { (listeners[event] ??= []).push(listener as () => void); return client; },
        kill() { alive = false; inTx = false; pending = []; if (lockOwner === id) lockOwner = null; for (const l of listeners.error ?? []) l(); },
      };
      sessions.push({ id, kill: () => client.kill() });
      return client;
    },
  };
  return { pool, committed, sessions, get lockOwner() { return lockOwner; }, dropLockSilently() { lockOwner = null; } };
}

describe('CheckpointFence', () => {
  it('gives one thread to one session at a time and releases it', async () => {
    const s = fakeServer();
    const a = await CheckpointFence.acquire(s.pool, 'atlas:v1:t');
    expect(a?.held).toBe(true);
    expect(await CheckpointFence.acquire(s.pool, 'atlas:v1:t')).toBeNull();
    await a!.release();
    expect((await CheckpointFence.acquire(s.pool, 'atlas:v1:t'))?.held).toBe(true);
  });

  it('an in-flight checkpoint transaction cannot commit after the lock connection dies, and the thread becomes free', async () => {
    const s = fakeServer();
    const fence = (await CheckpointFence.acquire(s.pool, 'atlas:v1:t'))!;
    const pool = fence.pool();
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('INSERT INTO checkpoints ... in-flight');
    s.sessions[0].kill(); // connection dies mid-transaction: server rolls back and drops the lock
    await expect(client.query('COMMIT')).rejects.toBeInstanceOf(FenceLostError);
    expect(s.committed.some(x => x.includes('in-flight'))).toBe(false);
    expect(fence.held).toBe(false);
    expect((await CheckpointFence.acquire(s.pool, 'atlas:v1:t'))?.held).toBe(true); // another worker may now take over
  });

  it('after lose() (lease lost) a pending COMMIT becomes ROLLBACK and every later statement is refused', async () => {
    const s = fakeServer();
    const fence = (await CheckpointFence.acquire(s.pool, 'atlas:v1:t'))!;
    const c = await fence.pool().connect();
    await c.query('BEGIN'); await c.query('INSERT INTO checkpoint_writes ... late');
    let notified = false; fence.onLost(() => { notified = true; });
    fence.lose();
    expect(notified).toBe(true);
    await expect(c.query('COMMIT')).rejects.toBeInstanceOf(FenceLostError);
    await expect(c.query('SELECT 1')).rejects.toBeInstanceOf(FenceLostError);
    await expect(fence.pool().connect()).rejects.toBeInstanceOf(FenceLostError);
    expect(s.committed.some(x => x.includes('late'))).toBe(false);
  });

  it('re-verifies lock ownership inside the transaction before COMMIT, even without a connection error event', async () => {
    const s = fakeServer();
    const fence = (await CheckpointFence.acquire(s.pool, 'atlas:v1:t'))!;
    const c = await fence.pool().connect();
    await c.query('BEGIN'); await c.query('INSERT INTO checkpoints ... kept');
    await c.query('COMMIT');
    expect(s.committed.some(x => x.includes('kept'))).toBe(true);
    await c.query('BEGIN'); await c.query('INSERT INTO checkpoints ... orphaned');
    s.dropLockSilently(); // lock no longer owned by this session, no event fired
    await expect(c.query('COMMIT')).rejects.toBeInstanceOf(FenceLostError);
    expect(s.committed.some(x => x.includes('orphaned'))).toBe(false);
    expect(fence.held).toBe(false);
  });
  it('a real PostgresSaver write through the fence fails once the session is gone, and nothing is committed', async () => {
    const s = fakeServer();
    const fence = (await CheckpointFence.acquire(s.pool, 'atlas:v1:t'))!;
    const saver = createFencedCheckpointer(fence);
    const config = { configurable: { thread_id: 'atlas:v1:t', checkpoint_ns: '' } };
    const checkpoint = { v: 4, id: '1ef0000000000000', ts: new Date(0).toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} };
    await saver.put(config as never, checkpoint as never, { source: 'input', step: -1, parents: {} } as never, {});
    const before = s.committed.length;
    expect(before).toBeGreaterThan(0);
    s.sessions[0].kill();
    await expect(saver.put(config as never, { ...checkpoint, id: '1ef0000000000001' } as never, { source: 'loop', step: 0, parents: {} } as never, {})).rejects.toThrow();
    await expect(saver.putWrites({ configurable: { ...config.configurable, checkpoint_id: '1ef0000000000001' } } as never, [['x', 1]], 'task')).rejects.toThrow();
    expect(s.committed.length).toBe(before);
  });
});

describe('Atlas cancellation', () => {
  it('aborting during in-flight model work stops the graph before enqueue and before any later checkpoint write', async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
    const job = { familyId: id(1), jobId: id(2), eventId: id(3), actorId: id(4), requestId: id(5), targetId: id(6) };
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let enqueued = 0, started = false;
    const saver = new MemorySaver(); let puts = 0; const put = saver.put.bind(saver);
    saver.put = (async (...a: Parameters<typeof put>) => { puts++; return put(...a); }) as typeof saver.put;
    const ports = {
      loadJob: async () => job,
      understand: async () => { started = true; await gate; return { action: 'check_in' as const, certainty: 'ready' as const }; },
      loadGateInput: async () => { throw new Error('unreachable'); },
      enqueueAuthorized: async () => { enqueued++; return { status: 'enqueued' as const, outboxId: id(9) }; },
      observeDelivery: async () => ({ verified: false, status: 'pending' as const, responderAccepted: false }),
      appendSignedOutcome: async () => undefined,
      withJobLock: async <T,>(_s: unknown, w: () => Promise<T>) => w(),
    };
    const controller = new AbortController();
    const run = createAtlas(ports, saver).start({ familyId: job.familyId, jobId: job.jobId }, { signal: controller.signal });
    while (!started) await new Promise(r => setTimeout(r, 5));
    const putsAtAbort = puts;
    controller.abort();
    release();
    await expect(run).rejects.toThrow();
    await new Promise(r => setTimeout(r, 50));
    expect(enqueued).toBe(0);
    expect(puts).toBe(putsAtAbort);
  });
});