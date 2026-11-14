import { AI_DISCLOSURE, assertSafeUrl, type ActionAuthorization, type FetchTransport } from "@sahaj/adapters";
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
export type ContactResolver = ((familyId: string, personId: string, provider: ContactProvider) => Promise<string | null>) & {
  resolveIdentity(familyId: string, personId: string, provider: ContactProvider): Promise<{
    e164: string; identityId: string; accountId: string; identityHash: string;
  } | null>;
};
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

export type RecordingProvider = "twilio" | "sarvam";
/** Per-provider recording retrieval settings (Phase 2 RecordingWorkerDeps minus store/storage/transport). Independent. */
export interface RecordingTwilioConfig { encryptionKey: string; consentVersion: string; accountSid: string; authToken: string }
export interface RecordingSarvamConfig { encryptionKey: string; consentVersion: string; sarvam: { apiKey: string; orgId: string; workspaceId: string; appId: string } }

/** Everything that must be injected for each capability. Absent pieces leave that capability unavailable. */
export interface ProviderRuntimeConfig {
  /** Explicit switch for outbound side effects. Each provider additionally needs its own enable flag and complete config. */
  dispatchEnabled: boolean;
  transport?: FetchTransport;
  identitySecret?: string;
  providers?: { sarvam?: SarvamProviderConfig; twilio?: TwilioProviderConfig; whatsapp?: WhatsAppProviderConfig };
  /** Key for `provider_identities.contact_ciphertext`. Must equal the key the Phase 4 registration path encrypts with. */
  contactEncryptionKey?: string;
  recordingTwilio?: RecordingTwilioConfig;
  recordingSarvam?: RecordingSarvamConfig;
  /** Explicit switch for recording purge. Off means the purge entrypoint is never called (nothing listed, nothing deleted). */
  purgeEnabled?: boolean;
  purgeLimit?: number;
  /** Names of invalid configuration values found while loading (names only). */
  problems?: string[];
}

/** Content for outbound WhatsApp text (Phase 4 owns care content). Without it WhatsApp rows are never claimed. */
export type TextComposer = (binding: Phase2Binding) => Promise<string | null>;

/**
 * Owned TwiML renderer for responder calls. A URL alone cannot prove what Twilio will hear, so Twilio dispatch is enabled
 * only when CODE injects this port: the route that serves `url` must return exactly `render()`, and `render()` is verified
 * at composition to speak the adapter's AI disclosure (`AI_DISCLOSURE.Hindi`) before a signed DTMF Gather posting to
 * `gatherActionUrl`. `provenance` names that route and its version (for example `api.twilio.voice.responder:v1`).
 */
export interface TwilioResponderRenderer { provenance: string; url: string; gatherActionUrl: string; render(): string }

export interface ProviderBridge {
  statusJob?(event: Phase2RawStatusEvent & { id: string }): Promise<Phase2Disposition>;
  /** Recording retrieval per provider. A provider without a handler has its jobs left unclaimed (pending). */
  recordingJobs: Partial<Record<RecordingProvider, (rawEventId: string) => Promise<Phase2Disposition>>>;
  dispatchTick?(workerId: string): Promise<{ enabled: boolean; claimed: number; outcomes: Record<string, number> }>;
  /** `<provider action>:<care action>` pairs this runtime can actually send. Only these rows are ever claimed. */
  dispatchCapabilities: string[];
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

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
/**
 * Verify an injected responder renderer. Returns null when it is acceptable, otherwise a reason name. Checks: provenance id
 * shape; `url` and `gatherActionUrl` pass `assertSafeUrl` against the Twilio webhook allowlist; the TwiML is a single
 * <Response>, speaks the exact AI disclosure in a <Say> BEFORE the first <Gather>, and has a DTMF one-digit Gather whose
 * action is exactly `gatherActionUrl`.
 */
export function verifyResponderRenderer(r: TwilioResponderRenderer | undefined, allowedHosts: readonly string[]): string | null {
  if (!r) return "twilio_responder_renderer";
  try {
    if (!/^[a-z0-9_.:-]{3,80}$/.test(r.provenance)) return "twilio_renderer_provenance";
    assertSafeUrl(r.url, allowedHosts, "twilio"); assertSafeUrl(r.gatherActionUrl, allowedHosts, "twilio");
    const twiml = r.render();
    if (typeof twiml !== "string" || !/^\s*(<\?xml[^>]*\?>\s*)?<Response>[\s\S]*<\/Response>\s*$/.test(twiml)) return "twilio_renderer_twiml";
    const gatherAt = twiml.indexOf("<Gather");
    const disclosureAt = twiml.search(/<Say[^>]*>/);
    const say = disclosureAt >= 0 ? twiml.slice(disclosureAt, twiml.indexOf("</Say>", disclosureAt)) : "";
    if (gatherAt < 0 || disclosureAt < 0 || disclosureAt > gatherAt || !(say.includes(AI_DISCLOSURE.Hindi) || say.includes(xmlEscape(AI_DISCLOSURE.Hindi)))) return "twilio_renderer_disclosure";
    const gather = /<Gather\b([^>]*)>/.exec(twiml)![1];
    const attr = (n: string) => new RegExp(`\\b${n}="([^"]*)"`).exec(gather)?.[1];
    if (attr("input") !== "dtmf" || attr("numDigits") !== "1" || attr("action") !== xmlEscape(r.gatherActionUrl) && attr("action") !== r.gatherActionUrl) return "twilio_renderer_gather";
    return null;
  } catch { return "twilio_renderer_invalid"; }
}

/**
 * Trusted payload composer for Phase 2's runOutboxDispatchTick. It only composes rows inside `capabilities` (the claim
 * already filtered them; this is defence in depth). Twilio is attested only through a verified owned renderer.
 */
export function createPayloadComposer(capabilities: readonly string[], opts: { renderer?: TwilioResponderRenderer; text?: TextComposer }) {
  return async (_row: Phase2ClaimedOutbox, b: Phase2Binding): Promise<{ payload: Phase2Payload; aiDisclosureAttested?: boolean } | null> => {
    if (!capabilities.includes(`${b.action}:${b.outboxAction}`)) return null;
    if (b.action === "sarvam.outbound_call") return { payload: { action: "sarvam.outbound_call", language: "Hindi" } };
    if (b.action === "twilio.create_call" && opts.renderer && b.assignmentId) {
      return { payload: { action: "twilio.create_call", twimlUrl: opts.renderer.url }, aiDisclosureAttested: true };
    }
    if (b.action === "whatsapp.send_text" && opts.text) {
      const body = await opts.text(b);
      if (typeof body === "string" && body.length > 0 && body.length <= 4096) return { payload: { action: "whatsapp.send_text", body } };
    }
    return null;
  };
}

/** Phase 2 DispatchStore with claimOutbox replaced by the capability-filtered claim (20261115000000). */
export function withCapabilityClaims(store: unknown, db: RpcDb, capabilities: readonly string[]): unknown {
  return {
    ...(store as Record<string, unknown>),
    async claimOutbox(workerId: string, limit: number, leaseSeconds: number) {
      const data = await call<Array<Record<string, unknown>> | null>(db, "claim_outbox_for_capabilities",
        { p_worker_id: workerId, p_capabilities: [...capabilities], p_limit: limit, p_lease_seconds: leaseSeconds }, "outbox_claim_failed");
      if (!Array.isArray(data)) throw new Error("outbox_claim_failed");
      return data.flatMap(r => (typeof r.id === "string" && typeof r.family_id === "string" && Number.isSafeInteger(r.attempt_count) && typeof r.lease_token === "string"
        ? [{ id: r.id, familyId: r.family_id, attempt: r.attempt_count as number, lease: r.lease_token }] : []));
    },
  };
}

export interface BridgeOptions { textComposer?: TextComposer; twilioResponder?: TwilioResponderRenderer }

/** Compose the bridge from injected Phase 2 entrypoints and configuration. Each capability is present only when complete. */
export function buildProviderBridge(phase2: Phase2Entrypoints | null, db: RpcDb, cfg: ProviderRuntimeConfig, options: BridgeOptions = {}): ProviderBridge {
  const unavailable: string[] = [...(cfg.problems ?? [])];
  if (!phase2) return { unavailable: ["phase2_entrypoints", ...unavailable], recordingJobs: {}, dispatchCapabilities: [] };
  const store = phase2.dispatchStore(db);
  const bridge: ProviderBridge = { unavailable, recordingJobs: {}, dispatchCapabilities: [] };

  bridge.statusJob = event => phase2.runStatusNormalizationJob({ store, readRaw: async id => (id === event.id ? event : null) }, event.id);

  // Recording: each provider is its own capability. The Phase 2 worker reads the event itself, so the runner calls a
  // provider's handler only for jobs whose event belongs to that provider (see runner.ts recording kinds).
  if (cfg.transport && cfg.recordingTwilio) {
    const deps = { store: phase2.recordingStore(db), storage: phase2.recordingStorage(db), transport: cfg.transport, ...cfg.recordingTwilio };
    bridge.recordingJobs.twilio = id => phase2.runRecordingJob(deps, db, id);
  } else unavailable.push("recording_twilio");
  if (cfg.transport && cfg.recordingSarvam) {
    // accountSid/authToken are Twilio-only worker fields; the Sarvam path never reads them. Empty values make any Twilio
    // event that could reach this handler fail closed, and the runner never routes one here.
    const deps = { store: phase2.recordingStore(db), storage: phase2.recordingStorage(db), transport: cfg.transport, accountSid: "", authToken: "", ...cfg.recordingSarvam };
    bridge.recordingJobs.sarvam = id => phase2.runRecordingJob(deps, db, id);
  } else unavailable.push("recording_sarvam");

  if (cfg.purgeEnabled === true) {
    const deps = { store: phase2.purgeStore(db), storage: phase2.recordingStorage(db), enabled: true, limit: Math.min(Math.max(Math.trunc(cfg.purgeLimit ?? 25), 1), 100) };
    bridge.purgeTick = () => phase2.runRecordingPurgeTick(deps);
  } else unavailable.push("purge_disabled");

  const configured = cfg.providers ?? {};
  // Capabilities: provider configured AND its content/attestation available. Only these rows are ever claimed.
  const caps: string[] = [];
  const providers: ProviderRuntimeConfig["providers"] = {};
  if (configured.sarvam) { caps.push("sarvam.outbound_call:check_in"); providers.sarvam = configured.sarvam; }
  if (configured.twilio) {
    const problem = verifyResponderRenderer(options.twilioResponder, configured.twilio.allowedWebhookHosts);
    if (problem) unavailable.push(problem); else { caps.push("twilio.create_call:urgent_responder"); providers.twilio = configured.twilio; }
  }
  if (configured.whatsapp) {
    if (options.textComposer) { caps.push("whatsapp.send_text:family_report"); providers.whatsapp = configured.whatsapp; }
    else unavailable.push("whatsapp_text_content");
  }
  const accounts: Partial<Record<ContactProvider, string>> = {
    ...(providers.sarvam ? { sarvam: providers.sarvam.appId } : {}),
    ...(providers.twilio ? { twilio: providers.twilio.accountSid } : {}),
    ...(providers.whatsapp ? { whatsapp: providers.whatsapp.phoneNumberId } : {}),
  };
  const missing = [!cfg.dispatchEnabled && "dispatch_disabled", !cfg.transport && "transport", !cfg.identitySecret && "identity_secret",
    !cfg.contactEncryptionKey && "contact_encryption_key", !caps.length && "no_dispatch_capability"].filter(Boolean) as string[];
  if (!missing.length) {
    bridge.dispatchCapabilities = caps;
    const resolveDestination = phase2.createContactResolver(db, { encryptionKeyHex: cfg.contactEncryptionKey!, identitySecret: cfg.identitySecret!, accounts });
    const deps = { store: withCapabilityClaims(store, db, caps), enabled: true,
      compose: createPayloadComposer(caps, { renderer: options.twilioResponder, text: options.textComposer }),
      authorize: createDispatchAuthorizer(db), resolveDestination, transport: cfg.transport, identitySecret: cfg.identitySecret, providers };
    bridge.dispatchTick = workerId => phase2.runOutboxDispatchTick({ ...deps, workerId });
  } else unavailable.push(...missing);
  return bridge;
}
