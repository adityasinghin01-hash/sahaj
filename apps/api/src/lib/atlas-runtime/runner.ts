import { createHash } from "node:crypto";
import { call, RuntimeError, UUID, type RpcDb } from "./db";
import { alwaysLive, type LeaseGuard } from "./lease-guard";
import type { ThreadLock } from "./thread-lock";
import type { ProviderBridge, RecordingProvider } from "./bridge";

export const KIND_ATLAS = "core1.atlas";
export const KIND_PROOF = "core1.proof";
export const KIND_STATUS = "core1.provider_status";
/** Legacy, provider-unspecific recording kind (jobs routed before per-provider kinds). Claimed only when BOTH providers work. */
export const KIND_RECORDING = "core1.recording";
export const KIND_RECORDING_TWILIO = "core1.recording.twilio";
export const KIND_RECORDING_SARVAM = "core1.recording.sarvam";
const RECORDING_KINDS: Record<string, RecordingProvider | "legacy"> = { [KIND_RECORDING]: "legacy", [KIND_RECORDING_TWILIO]: "twilio", [KIND_RECORDING_SARVAM]: "sarvam" };
/** Kinds this runtime executes. */
export const RUNTIME_KINDS = [KIND_ATLAS, KIND_PROOF, KIND_STATUS, KIND_RECORDING, KIND_RECORDING_TWILIO, KIND_RECORDING_SARVAM] as const;
/**
 * Kinds claimed this tick. Status and recording jobs are claimed only when their provider capability is configured, so
 * unavailable work stays pending with its attempt count unchanged instead of being claimed and failed.
 */
export function claimableKinds(bridge?: ProviderBridge): string[] {
  const rec = bridge?.recordingJobs ?? {};
  return [KIND_ATLAS, KIND_PROOF, ...(bridge?.statusJob ? [KIND_STATUS] : []),
    ...(rec.twilio ? [KIND_RECORDING_TWILIO] : []), ...(rec.sarvam ? [KIND_RECORDING_SARVAM] : []),
    ...(rec.twilio && rec.sarvam ? [KIND_RECORDING] : [])];
}
const recordingProviderOf = (source: string, eventType: string): RecordingProvider | null =>
  source === "twilio" && eventType === "twilio.recording.retrieval_requested" ? "twilio"
    : source === "sarvam" && eventType === "sarvam.recording.retrieval_requested" ? "sarvam" : null;

/**
 * Raw event type to workflow kind. Anything not listed is an explicit dead letter, never a care action.
 * Delivery and acceptance proofs are persisted facts that the Atlas wake-up reads; they do not act by themselves.
 */
export function routeEventKind(eventType: string): string | null {
  if (typeof eventType !== "string") return null;
  // Anything that can carry check-in or nudge input goes through understanding or durable review, never to a status fact.
  if (eventType === "whatsapp.status") return KIND_STATUS;
  if (/^whatsapp\.[a-z_]{1,40}$/.test(eventType) || eventType === "sarvam.inbound" || eventType === "sarvam.outbound" || eventType === "telecmi.missed_call") return KIND_ATLAS;
  if (eventType === "delivery.confirmed" || eventType === "delivery.not_sent" || eventType === "responder.accepted") return KIND_PROOF;
  if (eventType === "twilio.call_status") return KIND_STATUS;
  if (eventType === "twilio.recording.retrieval_requested") return KIND_RECORDING_TWILIO;
  if (eventType === "sarvam.recording.retrieval_requested") return KIND_RECORDING_SARVAM;
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
type RunOptions = { signal?: AbortSignal };
export interface AtlasLike { start(scope: { familyId: string; jobId: string }, options?: RunOptions): Promise<AtlasSnapshot>; resume(scope: { familyId: string; jobId: string }, options?: RunOptions): Promise<AtlasSnapshot> }
export interface RunnerDeps {
  db: RpcDb;
  workerId: string;
  /** Builds Atlas with ports bound to this job's lease and heartbeat guard, checkpointing through the thread lock's fence. */
  atlasFor(job: ClaimedJob, guard: LeaseGuard, lock: ThreadLock | null): AtlasLike;
  /** Starts a lease heartbeat for the job. Omit only in tests. */
  heartbeat?(job: ClaimedJob): LeaseGuard;
  /** Durable cross-process thread exclusivity. Returns null when another process holds the thread. */
  lockThread?(job: ClaimedJob): Promise<ThreadLock | null>;
  limit?: number;
  /** Injected Phase 2 entrypoints for status normalization and recording retrieval. */
  bridge?: ProviderBridge;
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

interface JobEvent { eventId: string; source: string; providerEventId: string; eventType: string; metadata: Record<string, unknown> }
async function loadJobEvent(db: RpcDb, job: ClaimedJob): Promise<JobEvent> {
  const row = await call<Record<string, unknown> | null>(db, "load_job_event",
    { p_family_id: job.family_id, p_job_id: job.id, p_lease_token: job.lease_token }, "event_load_failed");
  if (!row || typeof row.eventId !== "string" || typeof row.source !== "string" || typeof row.providerEventId !== "string" || typeof row.eventType !== "string") {
    throw new RuntimeError("event_unusable");
  }
  const metadata = typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
  return { eventId: row.eventId, source: row.source, providerEventId: row.providerEventId, eventType: row.eventType, metadata };
}

/** Disposition codes go to last_error_code, which allows only [a-z0-9_]. */
const safeCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80) || "unknown";

/** Phase 2 runStatusNormalizationJob over this job's durable raw callback. Throws on retry so the job backs off. */
async function normalizeStatus(bridge: ProviderBridge | undefined, ev: JobEvent, familyId: string): Promise<string> {
  if (!bridge?.statusJob) throw new RuntimeError("status_normalization_unavailable");
  const out = await bridge.statusJob({ id: ev.eventId, familyId, source: ev.source, eventType: ev.eventType, metadata: ev.metadata });
  if (out.action === "retry") throw new RuntimeError(`status_${safeCode(out.code)}`.slice(0, 80));
  return safeCode(out.code);
}
export async function runWorkflowJobs(deps: RunnerDeps) {
  const { db } = deps;
  const woken = await call<number>(db, "wake_ready_interrupted_jobs", { p_limit: 20 }, "wake_failed");
  const jobs = await call<ClaimedJob[] | null>(db, "claim_workflow_jobs_for_kinds",
    { p_worker_id: deps.workerId, p_kinds: claimableKinds(deps.bridge), p_limit: deps.limit ?? 10, p_lease_seconds: 120 }, "job_claim_failed");
  const summary = { woken: Number(woken) || 0, completed: 0, interrupted: 0, failed: 0, leaseLost: 0 };
  for (const job of jobs ?? []) {
    let guard: LeaseGuard = alwaysLive, lock: ThreadLock | null = null;
    try {
      if (!UUID.test(job.id) || !UUID.test(job.family_id)) throw new RuntimeError("invalid_job");
      if (job.workflow_kind === KIND_PROOF) {
        // Normalized proof is already durable and is read by Atlas through observe_delivery. Nothing acts here.
        (await finish(db, job, "completed", null, null, null)) ? summary.completed++ : summary.leaseLost++;
        continue;
      }
      if (job.workflow_kind === KIND_STATUS || job.workflow_kind in RECORDING_KINDS) {
        const ev = await loadJobEvent(db, job);
        let code: string;
        if (job.workflow_kind === KIND_STATUS) {
          // Completing never means delivered: unsupported or unprovable statuses stay pending. Only proof is written.
          code = await normalizeStatus(deps.bridge, ev, job.family_id);
        } else {
          // The handler is chosen from the EVENT, and must agree with the job kind. A mismatch is never sent to the other
          // provider's handler (which would reject it permanently); it fails with backoff for review.
          const provider = recordingProviderOf(ev.source, ev.eventType);
          const kind = RECORDING_KINDS[job.workflow_kind];
          if (!provider || (kind !== "legacy" && kind !== provider)) throw new RuntimeError("recording_kind_mismatch");
          const handler = deps.bridge?.recordingJobs?.[provider];
          if (!handler) throw new RuntimeError("recording_unavailable");
          const out = await handler(ev.eventId);
          if (out.action === "retry") throw new RuntimeError(`recording_${safeCode(out.code)}`.slice(0, 80));
          code = safeCode(out.code);
        }
        (await finish(db, job, "completed", null, null, code)) ? summary.completed++ : summary.leaseLost++;
        continue;
      }
      if (job.workflow_kind !== KIND_ATLAS) throw new RuntimeError("unknown_kind");
      // A Sarvam outbound status may be delivery evidence AND carry consented content: write proof first, then understand.
      // Without the Phase 2 entrypoint the job fails with backoff (explicitly unavailable) instead of skipping the evidence.
      {
        const ev = await loadJobEvent(db, job);
        if (ev.eventType === "sarvam.outbound") await normalizeStatus(deps.bridge, ev, job.family_id);
      }
      guard = deps.heartbeat ? deps.heartbeat(job) : alwaysLive;
      if (deps.lockThread) {
        lock = await deps.lockThread(job);
        if (!lock) throw new RuntimeError("thread_busy");
      }
      // Losing either the lease or the thread lock cancels in-flight graph work and fences further checkpoint writes.
      const controller = new AbortController();
      const cancel = () => { controller.abort(); lock?.lose?.(); };
      guard.onLost?.(cancel);
      lock?.onLost?.(cancel);
      const run = { signal: controller.signal };
      const atlas = deps.atlasFor(job, guard, lock);
      const scope = { familyId: job.family_id, jobId: job.id };
      let snap = job.checkpoint_ref ? await atlas.resume(scope, run) : await atlas.start(scope, run);
      // A crash can leave a started thread mid-graph with no interrupt. start() returns it unchanged, so continue it.
      if (!job.checkpoint_ref && snap.next.length && !interruptRef(snap)) snap = await atlas.resume(scope, run);
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
      if (code === "stale_lease" || code === "thread_lock_lost" || guard.lost || (lock && !lock.held)) { summary.leaseLost++; continue; }
      try { await finish(db, job, "failed", job.checkpoint_ref, null, code); } catch { /* lease expiry makes it claimable again */ }
      summary.failed++;
    } finally {
      guard.stop();
      await lock?.release().catch(() => undefined);
    }
  }
  return summary;
}