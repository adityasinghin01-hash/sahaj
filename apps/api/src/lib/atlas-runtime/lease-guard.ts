import { call, RuntimeError, type JobLease, type RpcDb } from "./db";

/** Live view of one job lease. Port calls assert it; the heartbeat keeps it alive during long work. */
export interface LeaseGuard {
  assertLive(): void;
  readonly lost: boolean;
  /** Called once when the lease is lost (used to abort the graph and the checkpoint fence). */
  onLost?(listener: () => void): void;
  stop(): void;
}

/** A guard for tests and callers that manage the lease elsewhere. */
export const alwaysLive: LeaseGuard = { assertLive() {}, lost: false, stop() {} };

/**
 * Renews the lease on a timer while model, checkpoint or database work runs. If a renewal reports the lease is gone
 * (or errors), the guard turns `lost` and every later `assertLive()` throws, which cancels the graph at its next port
 * call. Database writes are separately fenced inside their own transactions, so work that is already in flight when
 * the lease expires still cannot commit.
 */
export function startLeaseHeartbeat(db: RpcDb, lease: JobLease, options: { intervalMs?: number; seconds?: number } = {}): LeaseGuard {
  const seconds = options.seconds ?? 120;
  const interval = options.intervalMs ?? Math.max(1000, Math.floor((seconds * 1000) / 3));
  let lost = false, stopped = false, busy = false;
  const listeners: Array<() => void> = [];
  const markLost = () => { if (lost) return; lost = true; for (const l of listeners.splice(0)) { try { l(); } catch { /* ignore */ } } };
  const timer = setInterval(() => {
    if (stopped || lost || busy) return;
    busy = true;
    call<boolean>(db, "renew_workflow_lease", { p_job_id: lease.jobId, p_lease_token: lease.token, p_lease_seconds: seconds }, "lease_check_failed")
      .then(ok => { if (ok !== true) markLost(); }, () => markLost())
      .finally(() => { busy = false; });
  }, interval);
  (timer as { unref?: () => void }).unref?.();
  return {
    assertLive() { if (lost) throw new RuntimeError("stale_lease"); },
    get lost() { return lost; },
    onLost(listener) { if (lost) listener(); else listeners.push(listener); },
    stop() { stopped = true; clearInterval(timer); },
  };
}
