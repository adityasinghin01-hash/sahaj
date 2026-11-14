import type { ActionAuthorization, FetchTransport } from "@sahaj/adapters/communication";
import { call, type RpcDb } from "./db";

/**
 * Tick-boundary composition of the Phase 2 provider lane. Nothing here runs inside an Atlas graph node.
 *
 * `Phase2Entrypoints` is the exact public surface of `apps/api/src/lib/provider-dispatch` and `recording-worker`
 * (Phase 2 CONTRACTS.md). It is passed in, never imported, so this branch builds without Phase 2 source. At integration
 * `phase2-modules.ts` exports the real module functions; until then it exports null and every provider capability reports
 * `unavailable` while its work stays queued. No path fabricates a provider result.
 */

// ---- structural slices of the Phase 2 public API (shapes from its exported types, not its implementation)
export type ContactProvider = "sarvam" | "twilio" | "whatsapp";
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
export interface Phase2PurgeSummary { purged: number; skipped: number; failed: number; refused: number; enabled: boolean }
export type ContactResolver = (familyId: string, personId: string, provider: ContactProvider) => Promise<string | null>;
export interface Phase2Entrypoints {
  dispatchStore(db: unknown): unknown;
  runOutboxDispatchTick(deps: Record<string, unknown>): Promise<{ enabled: boolean; claimed: number; outcomes: Record<string, number> }>;
  runStatusNormalizationJob(deps: { store: unknown; readRaw(id: string): Promise<Phase2RawStatusEvent | null> }, rawEventId: string): Promise<Phase2Disposition>;
  recordingStore(db: unknown): unknown;
  recordingStorage(db: unknown): unknown;
  runRecordingJob(deps: Record<string, unknown>, db: unknown, rawEventId: string): Promise<Phase2Disposition>;
  /** Agreed Phase 2 API: provider-dispatch `createContactResolver(db, { encryptionKeyHex, identitySecret, accounts })`. */
  createContactResolver(db: unknown, cfg: { encryptionKeyHex: string; identitySecret: string; accounts: Partial<Record<ContactProvider, string>> }): ContactResolver;
  /** recording-worker `purgeStore(db)` and `runRecordingPurgeTick({ store, storage, enabled, now?, limit? })`. */
  purgeStore(db: unknown): unknown;
  runRecordingPurgeTick(deps: Record<string, unknown>): Promise<Phase2PurgeSummary>;
}

// ---- configuration exactly as the adapters accept it (minus ledger/transport, which are injected here)
export interface SarvamProviderConfig { apiKey: string; orgId: string; workspaceId: string; appId: string; appVersion: number; connectionId: string; agentPhoneNumber: string; webhookUrl: string }
export interface TwilioProviderConfig { accountSid: string; authToken: string; fromNumber: string; statusCallbackUrl: string; allowedWebhookHosts: readonly string[] }
export interface WhatsAppProviderConfig { accessToken: string; phoneNumberId: string; graphVersion: string }

/** Everything that must be injected for each capability. Absent pieces leave that capability unavailable. */
export interface ProviderRuntimeConfig {
  /** Explicit switch for outbound side effects. Each provider additionally needs its own enable flag and complete config. */
  dispatchEnabled: boolean;
  transport?: FetchTransport;
  identitySecret?: string;
  providers?: { sarvam?: SarvamProviderConfig; twilio?: TwilioProviderConfig; whatsapp?: WhatsAppProviderConfig };
  /** Key for `provider_identities.contact_ciphertext`. Must equal the key the Phase 4 registration path encrypts with. */
  contactEncryptionKey?: string;
  /** Twilio only: TwiML URL whose content speaks the AI disclosure and uses the signed Gather action. */
  twilioTwimlUrl?: string;
  /** Recording worker settings (Phase 2 RecordingWorkerDeps minus store/storage/transport). */
  recording?: { encryptionKey: string; accountSid: string; authToken: string; consentVersion: string; sarvam?: Record<string, unknown> };
  /** Explicit switch for recording purge. Off means the purge entrypoint is never called (nothing listed, nothing deleted). */
  purgeEnabled?: boolean;
  purgeLimit?: number;
  /** Names of invalid configuration values found while loading (names only). */
  problems?: string[];
}

/**
 * Content for outbound WhatsApp text. Phase 4 owns care content; until it injects this, WhatsApp rows are refused before
 * any claim (`payload_mismatch`) while Sarvam and Twilio dispatch stay usable.
 */
export type TextComposer = (binding: Phase2Binding) => Promise<string | null>;

export interface ProviderBridge {
  statusJob?(event: Phase2RawStatusEvent & { id: string }): Promise<Phase2Disposition>;
  recordingJob?(rawEventId: string): Promise<Phase2Disposition>;
  dispatchTick?(workerId: string): Promise<{ enabled: boolean; claimed: number; outcomes: Record<string, number> }>;
  /** One retention/consent purge pass. Present only when purge is explicitly enabled and configured. */
  purgeTick?(): Promise<Phase2PurgeSummary>;
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
 * Trusted payload composer for Phase 2's runOutboxDispatchTick. Sarvam check-in calls use a fixed language (the AI
 * disclosure is always spoken by the adapter); Twilio responder calls use the configured TwiML URL; WhatsApp text needs
 * the injected composer. Anything else is refused: the row fails `payload_mismatch` before any ledger claim.
 */
export function createPayloadComposer(cfg: Pick<ProviderRuntimeConfig, "twilioTwimlUrl">, text?: TextComposer) {
  return async (_row: Phase2ClaimedOutbox, b: Phase2Binding): Promise<{ payload: Phase2Payload; aiDisclosureAttested?: boolean } | null> => {
    if (b.action === "sarvam.outbound_call" && b.outboxAction === "check_in") return { payload: { action: "sarvam.outbound_call", language: "Hindi" } };
    if (b.action === "twilio.create_call" && b.outboxAction === "urgent_responder" && cfg.twilioTwimlUrl && b.assignmentId) {
      return { payload: { action: "twilio.create_call", twimlUrl: cfg.twilioTwimlUrl }, aiDisclosureAttested: true };
    }
    if (b.action === "whatsapp.send_text" && text) {
      const body = await text(b);
      if (typeof body === "string" && body.length > 0 && body.length <= 4096) return { payload: { action: "whatsapp.send_text", body } };
    }
    return null;
  };
}

export interface BridgeOptions { textComposer?: TextComposer }

/** Compose the bridge from injected Phase 2 entrypoints and configuration. Each capability is present only when complete. */
export function buildProviderBridge(phase2: Phase2Entrypoints | null, db: RpcDb, cfg: ProviderRuntimeConfig, options: BridgeOptions = {}): ProviderBridge {
  const unavailable: string[] = [...(cfg.problems ?? [])];
  if (!phase2) return { unavailable: ["phase2_entrypoints", ...unavailable] };
  const store = phase2.dispatchStore(db);
  const bridge: ProviderBridge = { unavailable };

  bridge.statusJob = event => phase2.runStatusNormalizationJob({ store, readRaw: async id => (id === event.id ? event : null) }, event.id);

  const rec = cfg.recording;
  if (rec && cfg.transport && rec.encryptionKey && rec.accountSid && rec.authToken && rec.consentVersion) {
    const deps = { store: phase2.recordingStore(db), storage: phase2.recordingStorage(db), transport: cfg.transport, ...rec };
    bridge.recordingJob = id => phase2.runRecordingJob(deps, db, id);
  } else unavailable.push("recording_config");

  if (cfg.purgeEnabled === true) {
    const deps = { store: phase2.purgeStore(db), storage: phase2.recordingStorage(db), enabled: true, limit: Math.min(Math.max(Math.trunc(cfg.purgeLimit ?? 25), 1), 100) };
    bridge.purgeTick = () => phase2.runRecordingPurgeTick(deps);
  } else unavailable.push("purge_disabled");

  const providers = cfg.providers ?? {};
  const accounts: Partial<Record<ContactProvider, string>> = {
    ...(providers.sarvam ? { sarvam: providers.sarvam.appId } : {}),
    ...(providers.twilio ? { twilio: providers.twilio.accountSid } : {}),
    ...(providers.whatsapp ? { whatsapp: providers.whatsapp.phoneNumberId } : {}),
  };
  const missing = [!cfg.dispatchEnabled && "dispatch_disabled", !cfg.transport && "transport", !cfg.identitySecret && "identity_secret",
    !cfg.contactEncryptionKey && "contact_encryption_key", !Object.keys(accounts).length && "provider_config"].filter(Boolean) as string[];
  if (!missing.length) {
    const resolveDestination = phase2.createContactResolver(db, { encryptionKeyHex: cfg.contactEncryptionKey!, identitySecret: cfg.identitySecret!, accounts });
    const deps = { store, enabled: true, compose: createPayloadComposer(cfg, options.textComposer), authorize: createDispatchAuthorizer(db),
      resolveDestination, transport: cfg.transport, identitySecret: cfg.identitySecret, providers };
    bridge.dispatchTick = workerId => phase2.runOutboxDispatchTick({ ...deps, workerId });
    if (providers.whatsapp && !options.textComposer) unavailable.push("whatsapp_text_content");
    if (providers.twilio && !cfg.twilioTwimlUrl) unavailable.push("twilio_responder_twiml");
  } else unavailable.push(...missing);
  return bridge;
}
