import { createHash } from "node:crypto";
import type { AtlasJob, AtlasPorts, DeliveryObservation, EnqueueResult, JobScope, OutboxCommand, Understanding } from "@sahaj/atlas";
import { evaluateGate, requestFingerprint, type GateAction, type GateApproval, type GateConsent, type GateDecision, type GateInput, type GateRequest, type SetupPermission } from "@sahaj/gate";
import { decryptWebhook, encryptWebhook } from "../webhook-security";
import { call, RuntimeError, stableUuid, UUID, type JobLease, type RpcDb } from "./db";
import { alwaysLive, type LeaseGuard } from "./lease-guard";
import { extractContent, projectUnderstanding, type StructuredUnderstandingPort } from "./understanding";

export interface TimelineAppender {
  (input: { familyId: string; eventType: string; entityId: string | null; humanLine: string; payload: unknown; dedupeKey: string; fence: { jobId: string; token: string } }): Promise<unknown>;
}
export interface AtlasRepositoryDeps {
  db: RpcDb;
  lease: JobLease;
  /** Hex AES-256-GCM key for raw events and outbox payloads. Injected so no module reads the environment. */
  encryptionKeyHex: string;
  appendTimeline: TimelineAppender;
  understanding?: StructuredUnderstandingPort;
  /** Heartbeat view of the lease; every port call throws once it is lost. Defaults to always live (tests only). */
  guard?: LeaseGuard;
}

const HUMAN_LINE = {
  denied: "A requested care action was not permitted.",
  delivered: "A care action was delivered.",
  accepted: "A responder accepted the urgent request.",
  failed: "A care action could not be delivered.",
} as const;
const GATE_ACTIONS: ReadonlySet<string> = new Set(["check_in", "urgent_responder", "voice_message", "medicine_refill",
  "missed_call_nudge", "send_alert", "family_report", "record_audio", "share_data"]);

export const requestIdFor = (scope: JobScope) => stableUuid(["atlas-request", scope.familyId, scope.jobId]);

type SnapshotApproval = Omit<GateApproval, "requestId" | "requestFingerprint" | "permissionId" | "familyId">;
interface Snapshot {
  found: boolean; now?: string; revision?: string; actorActive?: boolean; block?: "deny" | "ask" | null;
  request?: { id: string; familyId: string; action: GateAction; actorId: string | null; personId: string; amountMinor: number; vendorId: string | null;
    itemIds: string[]; consentSubjectId: string | null; targetId: string | null; status: string; consumed: boolean; expired: boolean;
    hasDenial: boolean; fingerprint: string | null };
  permissions?: SetupPermission[]; approvals?: SnapshotApproval[]; consents?: GateConsent[];
}

/** Production AtlasPorts over service-only RPCs. One instance is bound to one claimed job lease. */
export function createAtlasPorts(deps: AtlasRepositoryDeps): AtlasPorts {
  const { db, lease } = deps;
  const guard = deps.guard ?? alwaysLive;
  const own = (scope: JobScope) => {
    guard.assertLive();
    if (scope.familyId !== lease.familyId || scope.jobId !== lease.jobId) throw new RuntimeError("scope_mismatch");
  };
  const gateRequestFor = (job: AtlasJob, action: GateAction): GateRequest => ({ id: job.requestId, familyId: job.familyId, action, targetId: job.targetId });

  async function loadRaw(scope: JobScope) {
    own(scope);
    const row = await call<Record<string, unknown> | null>(db, "load_atlas_job",
      { p_family_id: lease.familyId, p_job_id: lease.jobId, p_lease_token: lease.token }, "job_load_failed");
    if (!row || typeof row.ciphertext !== "string" || typeof row.source !== "string" || typeof row.providerEventId !== "string"
      || typeof row.eventId !== "string" || typeof row.eventType !== "string" || row.personActive !== true) throw new RuntimeError("job_unusable");
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(decryptWebhook(row.ciphertext, deps.encryptionKeyHex, `${row.source}:${row.providerEventId}`).toString("utf8"));
    } catch { throw new RuntimeError("event_decrypt_failed"); }
    const personId = payload?.person_id;
    // The verified identity bound at ingestion must match in both the hashed envelope and the row metadata.
    if (typeof personId !== "string" || !UUID.test(personId) || personId !== row.metadataPersonId || !UUID.test(row.eventId)) throw new RuntimeError("identity_binding_failed");
    const principalId = typeof row.principalId === "string" && UUID.test(row.principalId) ? row.principalId : null;
    return { eventId: row.eventId, eventType: row.eventType, personId, principalId, payload };
  }

  async function snapshot(job: AtlasJob): Promise<Snapshot> {
    const data = await call<Snapshot>(db, "load_gate_snapshot",
      { p_family_id: job.familyId, p_job_id: job.jobId, p_request_id: job.requestId }, "permission_load_failed");
    if (!data || typeof data !== "object") throw new RuntimeError("permission_load_failed");
    return data;
  }

  /** Rebuild the gate request from stored columns and require the stored fingerprint to match it exactly. */
  function requestOf(s: Snapshot): GateRequest {
    const r = s.request!;
    const request: GateRequest = { id: r.id, familyId: r.familyId, action: r.action, targetId: r.targetId ?? "", amountMinor: r.amountMinor,
      ...(r.vendorId ? { vendorId: r.vendorId } : {}), itemIds: r.itemIds, ...(r.consentSubjectId ? { consentSubjectId: r.consentSubjectId } : {}) };
    if (!r.fingerprint || requestFingerprint(request) !== r.fingerprint) throw new RuntimeError("request_fingerprint_mismatch");
    return request;
  }

  function candidateInputs(job: AtlasJob, s: Snapshot): GateInput[] {
    const r = s.request!;
    const request = requestOf(s);
    // Consumed, expired, rejected or non-pending requests, a revoked principal or any deny row make the actor inactive.
    const usable = !r.consumed && !r.expired && !r.hasDenial && s.block !== "deny" && (r.status === "pending" || r.status === "approved");
    const actor = { id: r.actorId ?? "", familyId: job.familyId, active: s.actorActive === true && usable };
    return (s.permissions ?? []).map(permission => ({
      actor, request, now: String(s.now), consents: s.consents ?? [], permissions: [permission],
      approvals: (s.approvals ?? []).map(a => ({ ...a, requestId: r.id, requestFingerprint: r.fingerprint!, permissionId: permission.id, familyId: job.familyId })),
    }));
  }

  /** One evaluation per candidate permission in the same order SQL selects them; first allow wins. */
  function decide(job: AtlasJob, s: Snapshot): GateDecision {
    if (s.block === "deny") return { decision: "deny", reason: "no_permission" };
    if (s.block === "ask") return { decision: "ask", reason: "no_permission" };
    const inputs = candidateInputs(job, s);
    if (!inputs.length) return { decision: "ask", reason: "no_permission" };
    let best: GateDecision | null = null;
    for (const input of inputs) {
      const d = evaluateGate(input);
      if (d.decision === "allow") return d;
      if (!best || (best.decision === "deny" && d.decision === "ask")) best = d;
    }
    return best!;
  }

  const ports: AtlasPorts = {
    async loadJob(scope) {
      const raw = await loadRaw(scope);
      // Actor is the server-owned principal, never the subject. Without one, a sentinel that matches no permission.
      const actorId = raw.principalId ?? stableUuid(["no-principal", lease.familyId]);
      return { familyId: lease.familyId, jobId: lease.jobId, eventId: raw.eventId, actorId, requestId: requestIdFor(scope), targetId: raw.personId };
    },

    async understand(job): Promise<Understanding> {
      const raw = await loadRaw(job);
      // Missing consent, status-only or empty events go to durable review. They are never successful processing.
      const extracted = extractContent(raw.eventType, raw.payload);
      if (extracted.kind === "review") return { action: "unknown", certainty: "uncertain" };
      const result = await projectUnderstanding({ eventType: raw.eventType, text: extracted.text, content: extracted.content }, deps.understanding);
      guard.assertLive();
      if (result.certainty === "ready" && GATE_ACTIONS.has(result.action)) {
        // Idempotent. Subject and target come from the verified identity, never from model output.
        // A null id means the family has no active principal: stay uncertain so the job pauses for review.
        const created = await call<string | null>(db, "ensure_action_request", { p_family_id: job.familyId, p_job_id: job.jobId,
          p_lease_token: lease.token, p_request_id: job.requestId, p_person_id: job.targetId, p_action: result.action,
          p_target_id: job.targetId, p_request_fingerprint: requestFingerprint(gateRequestFor(job, result.action as GateAction)) }, "request_create_failed");
        if (created !== job.requestId) return { action: "unknown", certainty: "uncertain" };
      }
      return result as Understanding;
    },

    async loadGateInput(job, action) {
      const s = await snapshot(job);
      if (!s.found || !s.request || s.request.action !== action || s.request.targetId !== job.targetId || s.request.actorId !== job.actorId) throw new RuntimeError("request_missing");
      const inputs = candidateInputs(job, s);
      // The graph runs evaluateGate on this single input. Return the input for the permission Cedar would pick.
      const chosen = inputs.find(i => evaluateGate(i).decision === "allow") ?? inputs[0];
      if (s.block) return { actor: { id: job.actorId, familyId: job.familyId, active: s.block === "ask" }, request: requestOf(s),
        permissions: [], approvals: [], consents: [], now: String(s.now) };
      return chosen ?? { actor: { id: job.actorId, familyId: job.familyId, active: true }, request: requestOf(s),
        permissions: [], approvals: [], consents: [], now: String(s.now) };
    },

    async enqueueAuthorized(command: OutboxCommand): Promise<EnqueueResult> {
      own(command);
      const job = await ports.loadJob(command);
      const s = await snapshot(job);
      if (!s.found || !s.request || s.request.action !== command.action || typeof s.revision !== "string") return { status: "denied" };
      requestOf(s); // fingerprint must match before anything is committed
      // A consumed request can only be a recovery of our own earlier commit; the RPC verifies that by dedupe key and payload hash.
      if (!s.request.consumed) {
        const decision = decide(job, s);
        if (decision.decision === "ask") return { status: "review" };
        if (decision.decision !== "allow") return { status: "denied" };
      }
      const plaintext = Buffer.from(JSON.stringify({ v: 1, action: command.action, requestId: job.requestId, eventId: command.eventId }));
      const payload = encryptWebhook(plaintext, deps.encryptionKeyHex, `outbox:${command.familyId}:${command.idempotencyKey}`);
      const out = await call<{ status?: string; outbox_id?: string } | null>(db, "enqueue_authorized_command", {
        p_family_id: command.familyId, p_job_id: command.jobId, p_lease_token: lease.token, p_action_request_id: job.requestId,
        p_action: command.action, p_dedupe_key: command.idempotencyKey, p_payload_ciphertext: payload,
        p_payload_hash: createHash("sha256").update(plaintext).digest("hex"), p_revision: s.revision, p_incident_id: null,
      }, "outbox_write_failed");
      if (out?.status === "enqueued" && typeof out.outbox_id === "string") return { status: "enqueued", outboxId: out.outbox_id };
      return { status: out?.status === "review" ? "review" : "denied" };
    },

    async observeDelivery(scope, outboxId): Promise<DeliveryObservation> {
      own(scope);
      const out = await call<{ verified?: unknown; status?: unknown; responderAccepted?: unknown } | null>(db, "observe_delivery",
        { p_family_id: scope.familyId, p_job_id: scope.jobId, p_outbox_id: outboxId }, "delivery_load_failed");
      const status = out?.status === "delivered" || out?.status === "failed" ? out.status : "pending";
      return { verified: out?.verified === true, status, responderAccepted: out?.responderAccepted === true };
    },

    async appendSignedOutcome(entry) {
      own(entry);
      // The append itself is fenced inside its database transaction (append_timeline_event_fenced).
      await deps.appendTimeline({ familyId: entry.familyId, eventType: `atlas.outcome.${entry.status}`, entityId: entry.jobId,
        humanLine: HUMAN_LINE[entry.status], payload: { jobId: entry.jobId, eventId: entry.eventId, status: entry.status },
        dedupeKey: entry.idempotencyKey, fence: { jobId: lease.jobId, token: lease.token } });
    },

    async withJobLock<T>(scope: JobScope, work: () => Promise<T>): Promise<T> {
      own(scope);
      const renew = async () => {
        const ok = await call<boolean>(db, "renew_workflow_lease", { p_job_id: lease.jobId, p_lease_token: lease.token, p_lease_seconds: 120 }, "lease_check_failed");
        if (ok !== true) throw new RuntimeError("stale_lease");
      };
      await renew();
      const result = await work();
      await renew();
      return result;
    },
  };
  return ports;
}
