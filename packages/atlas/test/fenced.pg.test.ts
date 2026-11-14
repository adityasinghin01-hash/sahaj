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
});
