import { ACTION_PROVIDER, DispatchError, type ClaimedOutbox, type DispatchCommand, type DispatchOutcome, type DispatchPayload, type DispatchStore, type StoredBinding } from "./types";
import { dispatchOutbound, sweepStaleClaims, type DispatchDeps } from "./dispatch";
import { normalizeDeliveryOutcome } from "./normalize";

/** What a workflow runner should do with the job it handed to a Phase 2 entrypoint. Codes only, never content. */
export type JobDisposition = { action: "complete" | "retry"; code: string };

/** Trusted composition of the provider payload for a claimed row. Returns null to refuse (nothing is claimed in the ledger). */
export type ComposePayload = (row: ClaimedOutbox, binding: StoredBinding) => Promise<{ payload: DispatchPayload; aiDisclosureAttested?: boolean } | null>;

export interface OutboxTickDeps extends Omit<DispatchDeps, "store"> {
  store: DispatchStore;
  /** Side effects stay off until the parent turns this on explicitly. When false nothing is claimed and nothing is sent. */
  enabled: boolean;
  compose: ComposePayload;
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  /** Seconds after which a claim without a recorded result is marked delivery_unknown. */
  staleClaimSeconds?: number;
}
export interface OutboxTickSummary { enabled: boolean; claimed: number; outcomes: Record<DispatchOutcome["status"] | "refused", number> }

/**
 * One scheduler tick of the outbound dispatcher. Order is fixed: sweep abandoned claims to delivery_unknown, claim ready rows
 * (existing claim_outbox, which itself turns expired leases into delivery_unknown), load each row's IMMUTABLE binding, compose the
 * provider payload through the trusted callback, then `dispatchOutbound` (reauthorize, ledger claim, adapter, atomic result).
 * A row with no binding, or whose binding does not match what the composer returns, is finished as failed without any claim.
 * Nothing here retries an uncertain dispatch: delivery_unknown rows are never claimed again.
 */
export async function runOutboxDispatchTick(deps: OutboxTickDeps): Promise<OutboxTickSummary> {
  const summary: OutboxTickSummary = { enabled: deps.enabled, claimed: 0, outcomes: { dispatched: 0, delivery_unknown: 0, failed: 0, denied: 0, duplicate: 0, refused: 0 } };
  if (!deps.enabled) return summary;
  await sweepStaleClaims(deps.store, deps.staleClaimSeconds ?? 120);
  const rows = await deps.store.claimOutbox(deps.workerId, Math.min(Math.max(Math.trunc(deps.limit ?? 5), 1), 25), deps.leaseSeconds ?? 120);
  summary.claimed = rows.length;
  for (const row of rows) {
    const refuse = async (code: string) => { summary.outcomes.refused++; try { await deps.store.finishOutbox(row.id, row.lease, false, code); } catch { /* lease expiry covers it */ } };
    let binding: StoredBinding | null;
    try { binding = await deps.store.getBinding(row.familyId, row.id); } catch { await refuse("binding_lookup_failed"); continue; }
    if (!binding) { await refuse("binding_missing"); continue; }
    let composed;
    try { composed = await deps.compose(row, binding); } catch { await refuse("compose_failed"); continue; }
    // The composed action must be exactly the bound provider operation: the composer cannot redirect a row.
    if (!composed || composed.payload.action !== binding.action || ACTION_PROVIDER[composed.payload.action] !== binding.provider) { await refuse("payload_mismatch"); continue; }
    const cmd: DispatchCommand = {
      familyId: row.familyId, personId: binding.personId, outboxId: row.id, outboxLease: row.lease, attempt: row.attempt,
      callId: binding.callId, aiDisclosureAttested: composed.aiDisclosureAttested, payload: composed.payload,
    };
    try { summary.outcomes[(await dispatchOutbound(deps, cmd)).status]++; }
    catch (error) {
      // Invalid command shape (DispatchError) happens before any claim. Anything else after a claim is already recorded as unknown.
      if (error instanceof DispatchError) await refuse(error.code); else summary.outcomes.delivery_unknown++;
    }
  }
  return summary;
}

const STATUS_SOURCES: Record<string, "sarvam" | "twilio" | "whatsapp"> = { "sarvam:sarvam.outbound": "sarvam", "twilio:twilio.call_status": "twilio", "whatsapp:whatsapp.status": "whatsapp" };
export interface RawStatusEvent { familyId: string; source: string; eventType: string; metadata: Record<string, unknown> }
export interface StatusJobDeps { store: DispatchStore; readRaw(id: string): Promise<RawStatusEvent | null> }

/**
 * Entrypoint for a `core1.provider_status`-style job over ONE durably processed raw provider callback. Normalizes it into verified
 * delivery proof when (and only when) the status is a supported outcome and every link resolves from stored records; otherwise the
 * dispatch stays as it was. Completing this job never means delivered. Infrastructure errors ask for a retry.
 */
export async function runStatusNormalizationJob(deps: StatusJobDeps, rawEventId: string): Promise<JobDisposition> {
  let raw: RawStatusEvent | null;
  try { raw = await deps.readRaw(rawEventId); } catch { return { action: "retry", code: "store_unavailable" }; }
  if (!raw) return { action: "complete", code: "event_not_found" };
  const provider = STATUS_SOURCES[`${raw.source}:${raw.eventType}`];
  const status = typeof raw.metadata.status === "string" ? raw.metadata.status : "";
  if (!provider) return { action: "complete", code: "unsupported_event" };
  try {
    const r = await normalizeDeliveryOutcome(deps.store, { familyId: raw.familyId, sourceEventId: rawEventId, provider, status });
    if (r.status === "pending") return { action: "complete", code: r.reason };
    return { action: "complete", code: r.dispatchReconciled ? (r.outboxReconciled ? "proved_reconciled" : "proved_dispatch_only") : "proved_no_unknown_dispatch" };
  } catch { return { action: "retry", code: "store_unavailable" }; }
}
