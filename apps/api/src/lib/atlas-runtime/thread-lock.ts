import { RuntimeError } from "./db";

export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(error?: Error | boolean): void;
  on?(event: "error", listener: () => void): unknown;
}
export interface PgPoolLike { connect(): Promise<PgClientLike> }
export interface ThreadLock { readonly held: boolean; assertHeld(): void; release(): Promise<void> }

/**
 * Durable, cross-process exclusivity for one Atlas thread: a PostgreSQL session advisory lock held on a dedicated
 * connection for the whole run. If this process dies or loses the connection, PostgreSQL drops the lock, so a second
 * worker can only run the thread after the first can no longer write. Returns null when another process holds it.
 * Requires a direct or session-mode connection; a transaction-mode pooler would break session locks.
 */
export async function acquireThreadLock(pool: PgPoolLike, threadId: string): Promise<ThreadLock | null> {
  if (typeof threadId !== "string" || threadId.length < 1 || threadId.length > 255) throw new RuntimeError("invalid_thread");
  const client = await pool.connect();
  let held = false, released = false;
  const key = `sahaj.thread:${threadId}`;
  try {
    client.on?.("error", () => { held = false; });
    const result = await client.query("select pg_try_advisory_lock(hashtextextended($1,7)) as ok", [key]);
    held = result.rows[0]?.ok === true;
  } catch {
    client.release(true);
    throw new RuntimeError("thread_lock_failed");
  }
  if (!held) { client.release(); return null; }
  return {
    get held() { return held && !released; },
    assertHeld() { if (!held || released) throw new RuntimeError("thread_lock_lost"); },
    async release() {
      if (released) return;
      released = true;
      try { await client.query("select pg_advisory_unlock(hashtextextended($1,7))", [key]); client.release(); }
      catch { client.release(true); } // destroying the connection drops the session lock
    },
  };
}
