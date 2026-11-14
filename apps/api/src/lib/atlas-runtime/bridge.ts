import type { ActionAuthorization, FetchTransport } from "@sahaj/adapters/communication";
import { call, type RpcDb } from "./db";

/**
 * Tick-boundary composition of the Phase 2 provider lane. Nothing here runs inside an Atlas graph node.
 *
 * `Phase2Entrypoints` is the exact public surface of `apps/api/src/lib/provider-dispatch` and `recording-worker`
 * (Phase 2 CONTRACTS.md section 4). It is passed in, never imported, so this branch builds without Phase 2 source.
 * At integration `phase2-modules.ts` exports the real module objects; until then it exports null and every provider
 * capability reports `unavailable` while its work stays queued. No path fabricates a provider result.
 */

// ---- structural slices of the Phase 2 public API (shapes copied from its exported types, not its implementation)
export interface Phase2DispatchCommand {
  familyId: string; personId: string; outboxId: string; outboxLease: string; attempt: number; callId?: string;
  aiDisclosureAttested?: boolean; payload: Phase2Payload;
}
export type Phase2Payload = { action: "sarvam.outbound_call"; language?: "Hindi" | "English"; openingMessage?: string }
  | { action: "twilio.create_call"; twimlUrl: string } | { action: "whatsapp.send_text"; body: string };
export interface Phase2ClaimedOutbox { id: string; familyId: string; attempt: number; lease: string }
export interface Phase2Binding { familyId: string; outboxId: string; personId: string; provider: string; action: string; callId?: string;
  incidentId?: string; assignmentId?: string; actionRequestId: string | null; outboxAction: string | null }
export type Phase2Disposition = { action: "complete" | "retry"; code: string };
export interface Phase2RawStatusEvent { familyId: string; source: string; eventType: string; metadata: Record<string, unknown> }
export interface Phase2Entrypoints {
  dispatchStore(db: unknown): unknown;
  runOutboxDispatchTick(deps: Record<string, unknown>): Promise<{ enabled: boolean; claimed: number; outcomes: Record<string, number> }>;
  runStatusNormalizationJob(deps: { store: unknown; readRaw(id: string): Promise<Phase2RawStatusEvent | null> }, rawEventId: string): Promise<Phase2Disposition>;
  recordingStore(db: unknown): unknown;
  recordingStorage(db: unknown): unknown;
  runRecordingJob(deps: Record<string, unknown>, db: unknown, rawEventId: string): Promise<Phase2Disposition>;
}

/** Everything that must be injected for each capability. Absent pieces leave that capability unavailable. */
export interface ProviderRuntimeConfig {
  /** Explicit switch. Outbound provider side effects never start implicitly. */
  dispatchEnabled: boolean;
  transport?: FetchTransport;
  identitySecret?: string;
  /** Server-side contact lookup (family AND person). No scheme exists in the repository yet, so production has none. */
  resolveDestination?: (familyId: string, personId: string, provider: "sarvam" | "twilio" | "whatsapp") => Promise<string | null>;
  providers?: { sarvam?: Record<string, unknown>; twilio?: Record<string, unknown>; whatsapp?: Record<string, unknown> };
  /** Twilio only: TwiML URL whose content speaks the AI disclosure and uses the signed Gather action. */
  twilioTwimlUrl?: string;
  /** Recording worker settings (Phase 2 RecordingWorkerDeps minus store/storage/transport). */
  recording?: { encryptionKey: string; accountSid: string; authToken: string; consentVersion: string; sarvam?: Record<string, unknown> };
}

export interface ProviderBridge {
  /** Status normalization for one durable raw callback (twilio.call_status, sarvam.outbound, whatsapp.status). */
  statusJob?(event: Phase2RawStatusEvent & { id: string }): Promise<Phase2Disposition>;
  /** Recording retrieval for one raw event id (Twilio or Sarvam). */
  recordingJob?(rawEventId: string): Promise<Phase2Disposition>;
  /** One outbound dispatch pass. */
  dispatchTick?(workerId: string): Promise<{ enabled: boolean; claimed: number; outcomes: Record<string, number> }>;
  /** Names of missing pieces, for the tick report. Never values. */
  unavailable: string[];
}

interface Recheck { ok: boolean; reason?: string; personId?: string; providerAction?: string; callId?: string | null }

/**
 * `authorize` for Phase 2's dispatchOutbound: re-reads current authorization in SQL on every dispatch. The ledger insert
 * trigger repeats the same check atomically with the claim, so this is a fast refusal, not the only fence.
 */
export function createDispatchAuthorizer(db: RpcDb, now: () => number = Date.now) {
  return async (cmd: Phase2DispatchCommand, key: string): Promise<ActionAuthorization | null> => {
    const r = await call<Recheck | null>(db, "recheck_dispatch_authorization", { p_outbox_id: cmd.outboxId, p_lease_token: cmd.outboxLease }, "recheck_failed");
    if (!r?.ok || r.personId !== cmd.personId || r.providerAction !== cmd.payload.action || (r.callId ?? undefined) !== cmd.callId) return null;
    return { decision: "allow", consent: true, personId: cmd.personId, action: cmd.payload.action, idempotencyKey: key, expiresAt: now() + 60_000 };
  };
}

/**
 * Trusted payload composer for Phase 2's runOutboxDispatchTick. Only bound operations with server-defined content are
 * composed: Sarvam check-in calls (fixed language) and Twilio responder calls with the configured TwiML URL. WhatsApp text
 * needs report content that does not exist yet, so it is refused (the row fails `payload_mismatch`, nothing is sent).
 */
export function createPayloadComposer(cfg: Pick<ProviderRuntimeConfig, "twilioTwimlUrl">) {
  return async (_row: Phase2ClaimedOutbox, b: Phase2Binding): Promise<{ payload: Phase2Payload; aiDisclosureAttested?: boolean } | null> => {
    if (b.action === "sarvam.outbound_call" && b.outboxAction === "check_in") return { payload: { action: "sarvam.outbound_call", language: "Hindi" } };
    if (b.action === "twilio.create_call" && b.outboxAction === "urgent_responder" && cfg.twilioTwimlUrl && b.assignmentId) {
      return { payload: { action: "twilio.create_call", twimlUrl: cfg.twilioTwimlUrl }, aiDisclosureAttested: true };
    }
    return null;
  };
}

/** Compose the bridge from injected Phase 2 entrypoints and configuration. Each capability is present only when complete. */
export function buildProviderBridge(phase2: Phase2Entrypoints | null, db: RpcDb, cfg: ProviderRuntimeConfig): ProviderBridge {
  const unavailable: string[] = [];
  if (!phase2) return { unavailable: ["phase2_entrypoints"] };
  const store = phase2.dispatchStore(db);
  const bridge: ProviderBridge = { unavailable };

  bridge.statusJob = event => phase2.runStatusNormalizationJob({ store, readRaw: async id => (id === event.id ? event : null) }, event.id);

  const rec = cfg.recording;
  if (rec && cfg.transport && rec.encryptionKey && rec.accountSid && rec.authToken && rec.consentVersion) {
    const deps = { store: phase2.recordingStore(db), storage: phase2.recordingStorage(db), transport: cfg.transport, ...rec };
    bridge.recordingJob = id => phase2.runRecordingJob(deps, db, id);
  } else unavailable.push("recording_config");

  const missing = [!cfg.dispatchEnabled && "dispatch_disabled", !cfg.transport && "transport", !cfg.identitySecret && "identity_secret",
    !cfg.resolveDestination && "resolve_destination", !cfg.providers || !Object.values(cfg.providers).some(Boolean) ? "provider_config" : false].filter(Boolean) as string[];
  if (!missing.length) {
    const deps = { store, enabled: true, compose: createPayloadComposer(cfg), authorize: createDispatchAuthorizer(db), resolveDestination: cfg.resolveDestination,
      transport: cfg.transport, identitySecret: cfg.identitySecret, providers: cfg.providers ?? {} };
    bridge.dispatchTick = workerId => phase2.runOutboxDispatchTick({ ...deps, workerId });
  } else unavailable.push(...missing);
  return bridge;
}
