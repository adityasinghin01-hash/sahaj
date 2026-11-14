import { describe, expect, it } from 'vitest';
// @ts-expect-error pg ships no types in this workspace; only Pool is used, typed structurally below.
import pgModule from 'pg';
import { CheckpointFence, createFencedCheckpointer, type FencePool } from '../src/fenced';

/**
 * Real-PostgreSQL proof for the checkpoint fence. SKIPPED unless the parent provides a disposable scratch database:
 *   SAHAJ_SCRATCH_OK=1 SAHAJ_SCRATCH_DATABASE_URL=postgres://... pnpm --filter @sahaj/atlas exec vitest run test/fenced.pg.test.ts
 * Uses the administrative scratch connection (no TLS rewrite) and a synthetic thread id; never point it at production.
 */
const url = process.env.SAHAJ_SCRATCH_OK === '1' ? process.env.SAHAJ_SCRATCH_DATABASE_URL : undefined;
const Pool = (pgModule as unknown as { Pool: new (o: { connectionString: string; max: number }) => FencePool & { end(): Promise<void>; query(t: string, v?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> } }).Pool;

describe.skipIf(!url)('CheckpointFence on real PostgreSQL', () => {
  it('a checkpoint transaction in flight when the lock session is terminated never commits; the thread becomes free', async () => {
    const pool = new Pool({ connectionString: url!, max: 4 });
    const thread = `synthetic-fence-${Date.now()}`;
    const opened: CheckpointFence[] = [];
    const take = async (id: string) => { const f = await CheckpointFence.acquire(pool, id); if (f) opened.push(f); return f; };
    try {
      const setupFence = (await take(`${thread}-setup`))!;
      await createFencedCheckpointer(setupFence).setup();
      await setupFence.release();

      const fence = (await take(thread))!;
      expect(await take(thread)).toBeNull();
      const session = await fence.pool().connect() as unknown as { query(t: string, v?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
      const pid = (await session.query('select pg_backend_pid() as pid')).rows[0].pid;
      await session.query('BEGIN');
      await session.query(`insert into sahaj_checkpoints.checkpoints(thread_id,checkpoint_ns,checkpoint_id,checkpoint,metadata) values($1,'','in-flight','{}','{}')`, [thread]);
      await pool.query('select pg_terminate_backend($1)', [pid]);
      await new Promise(r => setTimeout(r, 200));
      await expect(session.query('COMMIT')).rejects.toThrow();
      const rows = await pool.query('select count(*)::int as n from sahaj_checkpoints.checkpoints where thread_id=$1', [thread]);
      expect(rows.rows[0].n).toBe(0);
      const next = await take(thread);
      expect(next?.held).toBe(true);
      await next!.release();
      await fence.release();
    } finally {
      for (const f of opened) await f.release().catch(() => undefined); // never leave a checked-out session behind
      await pool.query('delete from sahaj_checkpoints.checkpoints where thread_id like $1', ['synthetic-fence-%']).catch(() => undefined);
      await pool.end();
    }
  }, 30_000);

  it('parallel put/putWrites through one fence on real PostgreSQL: a write failing mid-transaction rolls back only itself', async () => {
    const pool = new Pool({ connectionString: url!, max: 4 });
    const thread = `synthetic-fence-par-${Date.now()}`;
    let fence: CheckpointFence | null = null;
    try {
      fence = (await CheckpointFence.acquire(pool, thread))!;
      const saver = createFencedCheckpointer(fence);
      const cfg = (c?: string) => ({ configurable: { thread_id: thread, checkpoint_ns: '', ...(c ? { checkpoint_id: c } : {}) } });
      const ck = { v: 4, id: '1ef0000000000099', ts: new Date(0).toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} };
      // task-bad: the first row inserts, the second is refused BY THE SERVER (NUL byte in a text column), inside the same
      // transaction. Only task-bad may be rolled back.
      const results = await Promise.allSettled([
        saver.put(cfg() as never, ck as never, { source: 'loop', step: 1, parents: {} } as never, {}),
        saver.putWrites(cfg(ck.id) as never, [['ok-bad-1', 1], ['nul\u0000channel', 2]], 'task-bad'),
        saver.putWrites(cfg(ck.id) as never, [['ok', 1]], 'task-good'),
      ]);
      expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
      const writes = await pool.query('select task_id,channel from sahaj_checkpoints.checkpoint_writes where thread_id=$1 order by task_id', [thread]);
      expect(writes.rows).toEqual([{ task_id: 'task-good', channel: 'ok' }]);
      const cps = await pool.query('select count(*)::int as n from sahaj_checkpoints.checkpoints where thread_id=$1', [thread]);
      expect(cps.rows[0].n).toBe(1);
      expect(fence.held).toBe(true); // an ordinary server error does not lose the fence; the session is reusable
      await saver.putWrites(cfg(ck.id) as never, [['after', 3]], 'task-after');
      const after = await pool.query('select count(*)::int as n from sahaj_checkpoints.checkpoint_writes where thread_id=$1 and task_id=$2', [thread, 'task-after']);
      expect(after.rows[0].n).toBe(1);
    } finally {
      await fence?.release().catch(() => undefined); // always return the session, or pool.end() would wait forever
      await pool.query('delete from sahaj_checkpoints.checkpoint_writes where thread_id like $1', ['synthetic-fence-%']).catch(() => undefined);
      await pool.query('delete from sahaj_checkpoints.checkpoints where thread_id like $1', ['synthetic-fence-%']).catch(() => undefined);
      await pool.end();
    }
  }, 30_000);});