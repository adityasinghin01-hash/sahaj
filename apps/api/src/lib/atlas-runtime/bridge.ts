import type { ActionAuthorization } from "@sahaj/adapters";
import { call, UUID, type RpcDb } from "./db";

/**
 * Tick-boundary bridges to the provider lanes (Phase 2). Nothing here runs inside an Atlas graph node, and nothing here
 * imports Phase 2 code: the parent injects the real entrypoints (`dispatchOutbound`, `normalizeDeliveryOutcome`,
 * `processRecordingEvent`, stores, transports, identity resolution). Absent entrypoints are reported as unavailable and
 * their work stays queued; they are never replaced with a success.
 */

/** Structural subset of Phase 2's DispatchCommand. */
export interface DispatchCommandLike {
  familyId: string; personId: string; outboxId: string; outboxLease: string; attempt: number; callId?: string;
  aiDisclosureAttested?: boolean;
  payload: { action: "sarvam.outbound_call"; language?: "Hindi" | "English"; openingMessage?: string }
    | { action: "twilio.create_call"; twimlUrl: string } | { action: "whatsapp.send_text"; body: string };
}
export type DispatchOutcomeLike = { status: "dispatched" | "delivery_unknown" | "failed" | "denied" | "duplicate" };

export interface NormalizeInput { familyId: string; sourceEventId: string; provider: "sarvam" | "twilio" | "whatsapp"; status: string }
export type NormalizeFn = (input: NormalizeInput) => Promise<{ status: "pending" | "proved" }>;

export interface RecordingEventInput { familyId: string; eventId: string; source: string; providerEventId: string; eventType: string }
export type RecordingFn = (input: RecordingEventInput) => Promise<{ status: "stored" | "already_stored" | "ignored_additional" | "rejected" | "retry"; code?: string }>;

export interface ProviderBridge {
  /** Phase 2 normalizeDeliveryOutcome bound to a real DispatchStore. */
  normalize?: NormalizeFn;
  /** Phase 2 processRecordingEvent bound to real store, storage, transports and consent readers. */
  recording?: RecordingFn;
  /** Phase 2 dispatchOutbound bound to real store, transport, identity resolution and provider config. */
  dispatch?: (command: DispatchCommandLike) => Promise<DispatchOutcomeLike>;
  /** Phase 2 sweepStaleClaims. */
  sweepStale?: () => Promise<number>;
  /** Builds the provider payload for a bound action. Return null when content or configuration is unavailable. */
  payloadFor?: (providerAction: string, domainAction: string) => DispatchCommandLike["payload"] | null;
}

/** Only exact, parameter-free payloads are built here. Anything needing content or URLs must be injected. */
export const defaultPayloadFor: NonNullable<ProviderBridge["payloadFor"]> = (providerAction) =>
  providerAction === "sarvam.outbound_call" ? { action: "sarvam.outbound_call", language: "Hindi" } : null;

interface Recheck { ok: boolean; reason?: string; personId?: string; provider?: string; providerAction?: string; callId?: string | null;
  domainAction?: string; incidentId?: string | null; assignmentId?: string | null }

async function recheck(db: RpcDb, outboxId: string, lease: string): Promise<Recheck> {
  const out = await call<Recheck | null>(db, "recheck_dispatch_authorization", { p_outbox_id: outboxId, p_lease_token: lease }, "recheck_failed");
  return out && typeof out === "object" ? out : { ok: false, reason: "no_result" };
}

/**
 * The authorizer the dispatch worker runs on EVERY dispatch (after the outbox claim, before the ledger claim). It
 * re-reads current facts in SQL: live lease, executed request, active principal and recipient, unrevoked permission,
 * no deny/ask overlap, current consent. The grant names the exact person, provider action and key and lives 60 seconds.
 * The adapters check the same fields again.
 */
export function createDispatchAuthorizer(db: RpcDb, now: () => number = Date.now) {
  return async (cmd: DispatchCommandLike, key: string): Promise<ActionAuthorization | null> => {
    const r = await recheck(db, cmd.outboxId, cmd.outboxLease);
    if (!r.ok || r.personId !== cmd.personId || r.providerAction !== cmd.payload.action || (r.callId ?? undefined) !== cmd.callId) return null;
    return { decision: "allow", consent: true, personId: cmd.personId, action: cmd.payload.action, idempotencyKey: key, expiresAt: now() + 60_000 };
  };
}

interface ClaimedOutbox { id: string; family_id: string; lease_token: string; attempt_count: number }

export interface DispatchTickSummary { status: "ok" | "unavailable"; claimed: number; dispatched: number; unknown: number; failed: number; denied: number; duplicate: number; swept: number }

/**
 * One dispatch pass. Claims outbox rows, derives the command ONLY from the immutable binding that the atomic enqueue
 * wrote (never from the payload or caller), and hands it to the injected Phase 2 dispatcher, which re-authorizes,
 * claims the ledger and calls the provider through its injected transport. Nothing is retried here: delivery_unknown
 * rows are never reclaimed and a failed row only returns through claim_outbox with a higher attempt number.
 */
export async function runDispatchTick(db: RpcDb, bridge: ProviderBridge, workerId: string, limit = 5): Promise<DispatchTickSummary> {
  const summary: DispatchTickSummary = { status: "ok", claimed: 0, dispatched: 0, unknown: 0, failed: 0, denied: 0, duplicate: 0, swept: 0 };
  if (!bridge.dispatch) return { ...summary, status: "unavailable" };
  if (bridge.sweepStale) summary.swept = await bridge.sweepStale();
  const rows = await call<ClaimedOutbox[] | null>(db, "claim_outbox", { p_worker_id: workerId, p_limit: limit, p_lease_seconds: 120 }, "outbox_claim_failed");
  const payloadFor = bridge.payloadFor ?? defaultPayloadFor;
  const finishOutbox = (row: ClaimedOutbox, code: string) =>
    call(db, "finish_outbox", { p_outbox_id: row.id, p_lease_token: row.lease_token, p_success: false, p_error_code: code }, "finish_failed").catch(() => undefined);
  for (const row of rows ?? []) {
    summary.claimed++;
    if (!UUID.test(row.id) || !UUID.test(row.family_id)) { summary.failed++; continue; }
    let r: Recheck;
    try { r = await recheck(db, row.id, row.lease_token); } catch { summary.failed++; continue; }
    if (!r.ok || !r.personId || !r.providerAction || !r.domainAction) { summary.denied++; await finishOutbox(row, "authorization_denied"); continue; }
    const payload = payloadFor(r.providerAction, r.domainAction);
    if (!payload || payload.action !== r.providerAction) { summary.failed++; await finishOutbox(row, "payload_unavailable"); continue; }
    try {
      const outcome = await bridge.dispatch({ familyId: row.family_id, personId: r.personId, outboxId: row.id, outboxLease: row.lease_token,
        attempt: row.attempt_count, ...(r.callId ? { callId: r.callId } : {}), payload });
      if (outcome.status === "dispatched") summary.dispatched++;
      else if (outcome.status === "delivery_unknown") summary.unknown++;
      else if (outcome.status === "duplicate") summary.duplicate++;
      else if (outcome.status === "denied") summary.denied++;
      else summary.failed++;
    } catch { summary.failed++; } // the dispatcher finishes the outbox itself; an unfinished lease expires into delivery_unknown
  }
  return summary;
}
