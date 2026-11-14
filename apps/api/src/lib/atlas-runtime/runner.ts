import { createHash } from "node:crypto";
import { call, RuntimeError, UUID, type RpcDb } from "./db";
import { alwaysLive, type LeaseGuard } from "./lease-guard";
import type { ThreadLock } from "./thread-lock";

export const KIND_ATLAS = "core1.atlas";
export const KIND_PROOF = "core1.proof";
export const KIND_STATUS = "core1.provider_status";
export const KIND_RECORDING = "core1.recording";
/** Kinds this runtime executes. Recording retrieval belongs to the provider worker. */
export const RUNTIME_KINDS = [KIND_ATLAS, KIND_PROOF, KIND_STATUS] as const;

/**
 * Raw event type to workflow kind. Anything not listed is an explicit dead letter, never a care action.
 * Delivery and acceptance proofs are persisted facts that the Atlas wake-up reads; they do not act by themselves.
 */
export function routeEventKind(eventType: string): string | null {
  if (typeof eventType !== "string") return null;
  // Anything that can carry check-in or nudge input goes through understanding or durable review, never to a status fact.
  if (/^whatsapp\.[a-z_]{1,40}$/.test(eventType) || eventType === "sarvam.inbound" || eventType === "sarvam.outbound" || eventType === "telecmi.missed_call") return KIND_ATLAS;
  if (eventType === "delivery.confirmed" || eventType === "delivery.not_sent" || eventType === "responder.accepted") return KIND_PROOF;
  if (eventType === "twilio.call_status") return KIND_STATUS;
  if (eventType === "twilio.recording.retrieval_requested") return KIND_RECORDING;
  return null;
}

export interface ClaimedEvent { id: string; event_type: string; lease_token: string }

/** Route each claimed event independently so one bad event cannot strand the rest of the batch. */
export async function dispatchEvents(db: RpcDb, events: ClaimedEvent[]) {
  let dispatched = 0, deadLettered = 0, failed = 0;
  for (const event of events) {
    try {
      const kind = routeEventKind(event.event_type);
      if (!kind) {
        await call(db, "dead_letter_raw_event", { p_event_id: event.id, p_lease_token: event.lease_token, p_error_code: "unknown_event_type" }, "dead_letter_failed");
        deadLettered++; continue;
      }
      await call(db, "dispatch_raw_event", { p_event_id: event.id, p_lease_token: event.lease_token, p_workflow_kind: kind, p_thread_id: `raw:${event.id}` }, "dispatch_failed");
      dispatched++;
    } catch {
      failed++;
      try { await db.rpc("finish_raw_event", { p_event_id: event.id, p_lease_token: event.lease_token, p_success: false, p_error_code: "dispatch_failed" }); } catch { /* lease expiry recovers it */ }
    }
  }
  return { dispatched, deadLettered, failed };
}

export interface ClaimedJob { id: string; family_id: string; workflow_kind: string; lease_token: string; checkpoint_ref: string | null }
export interface AtlasSnapshot {
  next: readonly string[];
  tasks: ReadonlyArray<{ interrupts?: ReadonlyArray<{ id?: string; value?: unknown }> }>;
  config?: { configurable?: { checkpoint_id?: string } };
  values?: { status?: string };
}
export interface AtlasLike { start(scope: { familyId: string; jobId: string }): Promise<AtlasSnapshot>; resume(scope: { familyId: string; jobId: string }): Promise<AtlasSnapshot> }
export interface RunnerDeps {
  db: RpcDb;
  workerId: string;
  /** Builds Atlas with ports bound to this job's lease and heartbeat guard. */
  atlasFor(job: ClaimedJob, guard: LeaseGuard): AtlasLike;
  /** Starts a lease heartbeat for the job. Omit only in tests. */
  heartbeat?(job: ClaimedJob): LeaseGuard;
  /** Durable cross-process thread exclusivity. Returns null when another process holds the thread. */
  lockThread?(job: ClaimedJob): Promise<ThreadLock | null>;
  limit?: number;
}
/** Stable reference to what the job awaits. Contains only the interrupt kind and a hash, never payload. */
export function interruptRef(snapshot: AtlasSnapshot): { checkpoint: string; interrupt: string } | null {
  const interrupt = snapshot.tasks.flatMap(t => t.interrupts ?? [])[0];
  const checkpoint = snapshot.config?.configurable?.checkpoint_id;
  const kind = (interrupt?.value as { kind?: unknown } | undefined)?.kind;
  if (!interrupt || typeof checkpoint !== "string" || (kind !== "review_required" && kind !== "delivery_pending")) return null;
  const digest = createHash("sha256").update(`${kind}\n${checkpoint}`).digest("hex").slice(0, 32);
  return { checkpoint, interrupt: `${kind}:${digest}` };
}

async function finish(db: RpcDb, job: ClaimedJob, state: "completed" | "interrupted" | "failed", checkpoint: string | null, interrupt: string | null, code: string | null) {
  return call<boolean>(db, "finish_workflow_job", { p_job_id: job.id, p_lease_token: job.lease_token, p_state: state,
    p_checkpoint_ref: checkpoint, p_interrupt_ref: interrupt, p_error_code: code }, "finish_failed");
}

export async function runWorkflowJobs(deps: RunnerDeps) {
  const { db } = deps;
  const woken = await call<number>(db, "wake_ready_interrupted_jobs", { p_limit: 20 }, "wake_failed");
  const jobs = await call<ClaimedJob[] | null>(db, "claim_workflow_jobs_for_kinds",
    { p_worker_id: deps.workerId, p_kinds: [...RUNTIME_KINDS], p_limit: deps.limit ?? 10, p_lease_seconds: 120 }, "job_claim_failed");
  const summary = { woken: Number(woken) || 0, completed: 0, interrupted: 0, failed: 0, leaseLost: 0 };
  for (const job of jobs ?? []) {
    let guard: LeaseGuard = alwaysLive, lock: ThreadLock | null = null;
    try {
      if (!UUID.test(job.id) || !UUID.test(job.family_id)) throw new RuntimeError("invalid_job");
      if (job.workflow_kind !== KIND_ATLAS) {
        // Delivery proof and provider status facts are already durable. Nothing is claimed as a care action here.
        (await finish(db, job, "completed", null, null, null)) ? summary.completed++ : summary.leaseLost++;
        continue;
      }
      guard = deps.heartbeat ? deps.heartbeat(job) : alwaysLive;
      if (deps.lockThread) {
        lock = await deps.lockThread(job);
        if (!lock) throw new RuntimeError("thread_busy");
      }
      const atlas = deps.atlasFor(job, guard);
      const scope = { familyId: job.family_id, jobId: job.id };
      let snap = job.checkpoint_ref ? await atlas.resume(scope) : await atlas.start(scope);
      // A crash can leave a started thread mid-graph with no interrupt. start() returns it unchanged, so continue it.
      if (!job.checkpoint_ref && snap.next.length && !interruptRef(snap)) snap = await atlas.resume(scope);
      // Lease or thread lock lost during the run: the result must not be recorded by this worker.
      guard.assertLive();
      lock?.assertHeld();
      if (!snap.next.length) {
        (await finish(db, job, "completed", null, null, null)) ? summary.completed++ : summary.leaseLost++;
        continue;
      }
      const ref = interruptRef(snap);
      if (!ref) throw new RuntimeError("unexpected_pause");
      (await finish(db, job, "interrupted", ref.checkpoint, ref.interrupt, null)) ? summary.interrupted++ : summary.leaseLost++;
    } catch (error) {
      const code = error instanceof RuntimeError && /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code : "atlas_failed";
      if (code === "stale_lease" || guard.lost) { summary.leaseLost++; continue; }
      try { await finish(db, job, "failed", job.checkpoint_ref, null, code); } catch { /* lease expiry makes it claimable again */ }
      summary.failed++;
    } finally {
      guard.stop();
      await lock?.release().catch(() => undefined);
    }
  }
  return summary;
}