import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { verifiedDatabaseUrl } from '../scripts/database-url.mjs';
import { CHECKPOINT_SCHEMA } from './postgres';

/** Structural pg client so tests can drive the fence without a database. */
export interface FenceClient {
  query(text: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(destroy?: Error | boolean): void;
  on?(event: 'error' | 'end', listener: (...args: unknown[]) => void): unknown;
}
export interface FencePool { connect(): Promise<FenceClient>; end?(): Promise<void> }

export class FenceLostError extends Error {
  constructor() { super('checkpoint_fence_lost'); this.name = 'FenceLostError'; }
}

const sqlText = (q: string | { text: string }) => (typeof q === 'string' ? q : q.text).trim().toUpperCase();

/**
 * Exclusive, fenced checkpoint access for ONE Atlas thread.
 *
 * A session advisory lock is taken on a dedicated connection, and EVERY PostgresSaver statement for this thread runs on that
 * same connection. So the lock and the checkpoint writes share one session:
 *  - if the connection dies, PostgreSQL rolls back any open checkpoint transaction AND releases the lock in the same instant;
 *    no other connection can commit that in-flight mutation;
 *  - before each COMMIT the fence re-verifies, inside the open transaction, that this session still holds the lock
 *    (pg_locks for pg_backend_pid()); if not, it rolls back;
 *  - once `lose()` is called (lease heartbeat failure, abort, connection error), every later statement is refused and a
 *    pending COMMIT becomes ROLLBACK.
 * Another worker cannot take the thread until the lock is released, so two processes never write one thread.
 */
export class CheckpointFence {
  private lostFlag = false;
  private released = false;
  private readonly listeners: Array<() => void> = [];
  private constructor(private readonly client: FenceClient, private readonly lockKey: string) {
    client.on?.('error', () => this.lose());
    client.on?.('end', () => this.lose());
  }

  /** Returns null when another session holds the thread. */
  static async acquire(pool: FencePool, threadId: string): Promise<CheckpointFence | null> {
    if (typeof threadId !== 'string' || threadId.length < 1 || threadId.length > 255) throw new Error('invalid_thread');
    const client = await pool.connect();
    const key = `sahaj.thread:${threadId}`;
    let ok = false;
    try {
      const r = await client.query('select pg_try_advisory_lock(hashtextextended($1,7)) as ok', [key]);
      ok = r.rows[0]?.ok === true;
    } catch (error) { client.release(true); throw error; }
    if (!ok) { client.release(); return null; }
    return new CheckpointFence(client, key);
  }

  get held(): boolean { return !this.lostFlag && !this.released; }
  assertHeld(): void { if (!this.held) throw new FenceLostError(); }
  onLost(listener: () => void): void { if (!this.held) listener(); else this.listeners.push(listener); }
  /** Mark the fence lost. Idempotent. Further statements are refused; open transactions roll back. */
  lose(): void {
    if (this.lostFlag) return;
    this.lostFlag = true;
    this.failWaiters();
    for (const l of this.listeners.splice(0)) { try { l(); } catch { /* listener errors never unfence */ } }
  }

  private async verifyLockInSession(): Promise<boolean> {
    const r = await this.client.query(
      `select exists(select 1 from pg_locks where locktype='advisory' and pid=pg_backend_pid() and granted and objsubid=1
         and ((classid::bigint<<32)|objid::bigint)=hashtextextended($1,7)) as held`, [this.lockKey]);
    return r.rows[0]?.held === true;
  }

  /** Execute one statement on the locked session, enforcing the fence. */
  async run(text: string | { text: string; values?: unknown[] }, values?: unknown[]) {
    const verb = sqlText(text);
    if (verb === 'ROLLBACK') return this.client.query(text as string, values);
    if (!this.held) throw new FenceLostError();
    if (verb === 'COMMIT') {
      let held = false;
      try { held = await this.verifyLockInSession(); } catch { held = false; }
      if (!held || !this.held) {
        this.lose();
        try { await this.client.query('ROLLBACK'); } catch { /* connection already gone: server rolled back */ }
        throw new FenceLostError();
      }
    }
    try { return await this.client.query(text as string, values); }
    catch (error) { if (verb === 'COMMIT') this.lose(); throw error; }
  }

  // ---- exclusive checkout: one PostgresSaver operation owns the pinned session from connect() to release().
  private owner: symbol | null = null;
  private readonly waiters: Array<{ grant(): void; fail(e: Error): void }> = [];

  private acquireSession(): Promise<symbol> {
    if (!this.held) return Promise.reject(new FenceLostError());
    const token = Symbol('checkout');
    if (this.owner === null) { this.owner = token; return Promise.resolve(token); }
    return new Promise<symbol>((resolve, reject) => {
      const waiter = { grant: () => { this.owner = token; resolve(token); }, fail: reject };
      this.waiters.push(waiter);
    });
  }
  private releaseSession(token: symbol): void {
    if (this.owner !== token) return;
    this.owner = null;
    const next = this.waiters.shift();
    if (!next) return;
    if (!this.held) { next.fail(new FenceLostError()); this.failWaiters(); return; }
    next.grant();
  }
  private failWaiters(): void {
    for (const w of this.waiters.splice(0)) w.fail(new FenceLostError());
  }

  /**
   * Pool facade for PostgresSaver. `connect()` waits for exclusive ownership of the pinned session and keeps it until the
   * returned client's `release()`, so concurrent saver operations (for example `put` and `putWrites` from parallel tasks)
   * run their BEGIN..COMMIT blocks one after another and can never commit or roll back each other's statements. Standalone
   * `query()` takes the same queue for one statement. Waiters are rejected when the fence is lost. If an owner releases with
   * its transaction still open (an error path that skipped ROLLBACK), the facade rolls it back before the next owner starts.
   */
  pool(): FencePool & { query: CheckpointFence['run'] } {
    const connect = async () => {
      const token = await this.acquireSession();
      let open = false, done = false;
      const query = async (t: string | { text: string; values?: unknown[] }, v?: unknown[]) => {
        if (done) throw new Error('checkout_released');
        const verb = sqlText(t);
        try {
          const r = await this.run(t, v);
          if (verb === 'BEGIN') open = true; else if (verb === 'COMMIT' || verb === 'ROLLBACK') open = false;
          return r;
        } catch (error) {
          if (verb === 'COMMIT' || verb === 'ROLLBACK') open = false; // the fence already rolled back
          throw error;
        }
      };
      const release = () => {
        if (done) return;
        done = true;
        if (!open) { this.releaseSession(token); return; }
        open = false;
        // Close the abandoned transaction on this session before anyone else may use it.
        this.client.query('ROLLBACK').catch(() => this.lose()).finally(() => this.releaseSession(token));
      };
      return { query, release };
    };
    const query = async (t: string | { text: string; values?: unknown[] }, v?: unknown[]) => {
      const c = await connect();
      try { return await c.query(t, v); } finally { c.release(); }
    };
    return { connect, query, end: async () => undefined } as unknown as FencePool & { query: CheckpointFence['run'] };
  }
  async release(): Promise<void> {
    if (this.released) return;
    const wasLost = this.lostFlag;
    this.released = true;
    this.lose();
    if (wasLost) { this.client.release(true); return; } // destroy: never reuse a session in an unknown state
    try { await this.client.query('select pg_advisory_unlock(hashtextextended($1,7))', [this.lockKey]); this.client.release(); }
    catch { this.client.release(true); }
  }
}

/** PostgresSaver whose every statement goes through the fence. One per job run. */
export function createFencedCheckpointer(fence: CheckpointFence): PostgresSaver {
  return new PostgresSaver(fence.pool() as never, undefined, { schema: CHECKPOINT_SCHEMA });
}

/** Pool for fence sessions (restricted checkpoint role, verify-full TLS). Direct or session-mode only. */
export function createCheckpointPool(connectionString: string): FencePool & { end(): Promise<void> } {
  // Reuse the saver package's own pg dependency; this saver instance is never used for checkpoint I/O.
  return (PostgresSaver.fromConnString(verifiedDatabaseUrl(connectionString), { schema: CHECKPOINT_SCHEMA }) as unknown as { pool: FencePool & { end(): Promise<void> } }).pool;
}
