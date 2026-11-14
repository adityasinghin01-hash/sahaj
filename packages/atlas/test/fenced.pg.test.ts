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
    try {
      const setupFence = (await CheckpointFence.acquire(pool, `${thread}-setup`))!;
      await createFencedCheckpointer(setupFence).setup();
      await setupFence.release();

      const fence = (await CheckpointFence.acquire(pool, thread))!;
      expect(await CheckpointFence.acquire(pool, thread)).toBeNull();
      const session = await fence.pool().connect() as unknown as { query(t: string, v?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
      const pid = (await session.query('select pg_backend_pid() as pid')).rows[0].pid;
      await session.query('BEGIN');
      await session.query(`insert into sahaj_checkpoints.checkpoints(thread_id,checkpoint_ns,checkpoint_id,checkpoint,metadata) values($1,'','in-flight','{}','{}')`, [thread]);
      await pool.query('select pg_terminate_backend($1)', [pid]);
      await new Promise(r => setTimeout(r, 200));
      await expect(session.query('COMMIT')).rejects.toThrow();
      const rows = await pool.query('select count(*)::int as n from sahaj_checkpoints.checkpoints where thread_id=$1', [thread]);
      expect(rows.rows[0].n).toBe(0);
      const next = await CheckpointFence.acquire(pool, thread);
      expect(next?.held).toBe(true);
      await next!.release();
      await fence.release();
    } finally {
      await pool.query('delete from sahaj_checkpoints.checkpoints where thread_id like $1', ['synthetic-fence-%']).catch(() => undefined);
      await pool.end();
    }
  }, 30_000);

  it('parallel put/putWrites through one fence on real PostgreSQL: a write that fails never takes the other writes with it (mid-transaction failures are covered by fenced.concurrency.test.ts)', async () => {
    const pool = new Pool({ connectionString: url!, max: 4 });
    const thread = `synthetic-fence-par-${Date.now()}`;
    try {
      const fence = (await CheckpointFence.acquire(pool, thread))!;
      const saver = createFencedCheckpointer(fence);
      const cfg = (c?: string) => ({ configurable: { thread_id: thread, checkpoint_ns: '', ...(c ? { checkpoint_id: c } : {}) } });
      const ck = { v: 4, id: '1ef0000000000099', ts: new Date(0).toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} };
      const bad = new Proxy({}, { get() { throw new Error('unserializable'); } });
      const results = await Promise.allSettled([
        saver.put(cfg() as never, ck as never, { source: 'loop', step: 1, parents: {} } as never, {}),
        saver.putWrites(cfg(ck.id) as never, [['ok', 1]], 'task-good'),
        saver.putWrites(cfg(ck.id) as never, [['bad', bad]], 'task-bad'),
      ]);
      expect(results[0].status).toBe('fulfilled'); expect(results[1].status).toBe('fulfilled');
      const writes = await pool.query('select task_id from sahaj_checkpoints.checkpoint_writes where thread_id=$1', [thread]);
      expect(writes.rows.map(r => r.task_id)).toEqual(['task-good']);
      const cps = await pool.query('select count(*)::int as n from sahaj_checkpoints.checkpoints where thread_id=$1', [thread]);
      expect(cps.rows[0].n).toBe(1);
      await fence.release();
    } finally {
      await pool.query('delete from sahaj_checkpoints.checkpoint_writes where thread_id like $1', ['synthetic-fence-%']).catch(() => undefined);
      await pool.query('delete from sahaj_checkpoints.checkpoints where thread_id like $1', ['synthetic-fence-%']).catch(() => undefined);
      await pool.end();
    }
  }, 30_000);
});