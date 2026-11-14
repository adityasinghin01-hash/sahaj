import { AdapterError, dispatchOnce, requireAuthorization, type DispatchLedger, type FetchTransport, type ProviderRequest, type ProviderResult } from "./contracts";
import { assertE164, digits, isRecord, parseJson, send, str } from "./http";
import { AI_DISCLOSURE } from "./audio";

const OUTBOUND_HOST = "https://apps.sarvam.ai/api/outbounds/v1";
const ANALYTICS_HOST = "https://apps.sarvam.ai/api/analytics/v1";
const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const INTERACTION_ID = /^\d{8}\/(?!\.+$)[A-Za-z0-9_.:-]{1,128}$/;
const MAX_RECORDING_BYTES = 50 * 1024 * 1024;

export interface SarvamConfig {
  transport: FetchTransport;
  apiKey: string;
  orgId: string;
  workspaceId: string;
  timeoutMs?: number;
}
export interface SarvamOutboundDeps extends SarvamConfig {
  ledger: DispatchLedger;
  appId: string;
  appVersion: number;
  connectionId: string;
  agentPhoneNumber: string;
  /** Public HTTPS URL of the backend's outbound webhook route. */
  webhookUrl: string;
}
export interface OutboundCallPayload {
  userPhoneNumber: string;
  language?: "Hindi" | "English";
  /** Optional extra opening text. It is always preceded by the AI disclosure. */
  openingMessage?: string;
}

function checkConfig(c: SarvamConfig): void {
  if (!c.apiKey || !SAFE_ID.test(c.orgId) || !SAFE_ID.test(c.workspaceId)) throw new AdapterError("invalid_payload", "sarvam");
}

/** Instant outbound AI call. Authorization action: "sarvam.outbound_call". The caller must persist the returned attemptId with appId before the webhook can match. */
export async function createSarvamOutboundCall(deps: SarvamOutboundDeps, request: ProviderRequest<OutboundCallPayload>): Promise<ProviderResult<{ attemptId: string }>> {
  const action = "sarvam.outbound_call";
  requireAuthorization(request, action);
  checkConfig(deps);
  const phone = assertE164(request.payload.userPhoneNumber);
  const language = request.payload.language ?? "Hindi";
  if (language !== "Hindi" && language !== "English") throw new AdapterError("invalid_payload", "sarvam");
  const extra = request.payload.openingMessage;
  if (extra !== undefined && (typeof extra !== "string" || extra.length > 300)) throw new AdapterError("invalid_payload", "sarvam");
  if (!SAFE_ID.test(deps.appId) || !Number.isSafeInteger(deps.appVersion) || !SAFE_ID.test(deps.connectionId)) throw new AdapterError("invalid_payload", "sarvam");
  const agentNumber = assertE164(deps.agentPhoneNumber);
  if (!deps.webhookUrl.startsWith("https://")) throw new AdapterError("unsafe_url", "sarvam");

  const body = {
    app_config: {
      app_id: deps.appId,
      app_version: deps.appVersion,
      connection_config: { connection_id: deps.connectionId, agent_phone_number: agentNumber },
      app_overrides: {
        initial_bot_message: extra ? `${AI_DISCLOSURE[language]} ${extra}` : AI_DISCLOSURE[language],
        initial_language_name: language,
      },
    },
    user_config: { user_phone_number: phone },
    // Echoed back on the webhook. Only an opaque key: no phone numbers or health data.
    webhook_config: { url: deps.webhookUrl, metadata: { idempotency_key: request.idempotencyKey } },
  };
  const url = `${OUTBOUND_HOST}/orgs/${encodeURIComponent(deps.orgId)}/workspaces/${encodeURIComponent(deps.workspaceId)}/outbounds`;

  return dispatchOnce(deps.ledger, request, "sarvam", action, async () => {
    const res = await send(url, {
      method: "POST",
      headers: { "X-API-Key": deps.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, { provider: "sarvam", transport: deps.transport, timeoutMs: deps.timeoutMs, readOnly: false });
    // 2xx without a usable attempt_id: the call may exist, so this is delivery-unknown, not a clean failure.
    let attemptId: string | undefined;
    try { attemptId = str(parseJson(res.body, "sarvam").attempt_id, 128); } catch { /* handled below */ }
    if (!attemptId) throw new AdapterError("delivery_unknown", "sarvam");
    return { data: { attemptId }, providerRef: attemptId };
  });
}

export interface RecordingRef { appId: string; interactionId: string }
/** Fetch a call recording (WAV). Authorization action: "sarvam.recording.read". Never log or persist outside approved storage. */
export async function getSarvamRecording(deps: SarvamConfig, request: ProviderRequest<RecordingRef>, opts: { maxBytes?: number } = {}): Promise<ProviderResult<{ audio: Uint8Array; contentType: string }>> {
  requireAuthorization(request, "sarvam.recording.read");
  checkConfig(deps);
  const { appId, interactionId } = request.payload;
  if (!SAFE_ID.test(appId) || !INTERACTION_ID.test(interactionId)) throw new AdapterError("invalid_payload", "sarvam");
  const url = `${ANALYTICS_HOST}/${encodeURIComponent(deps.orgId)}/${encodeURIComponent(deps.workspaceId)}/${encodeURIComponent(appId)}/recordings/${encodeURIComponent(interactionId)}`;
  const res = await send(url, { method: "GET", headers: { "X-API-Key": deps.apiKey } },
    { provider: "sarvam", transport: deps.transport, timeoutMs: deps.timeoutMs ?? 30_000, maxBytes: opts.maxBytes ?? MAX_RECORDING_BYTES, readOnly: true });
  if (!/^audio\/(x-)?wav/i.test(res.contentType) || res.body.length === 0) throw new AdapterError("provider_rejected", "sarvam", res.status);
  return { provider: "sarvam", idempotencyKey: request.idempotencyKey, data: { audio: res.body, contentType: "audio/wav" } };
}

/** Stored by the backend when the call was created. */
export interface StoredOutboundAttempt { attemptId: string; appId: string; agentPhoneNumber?: string }
export type SarvamOutboundStatus = "connected" | "no_answer" | "busy" | "failed";
export interface SarvamOutboundEvent {
  kind: "sarvam_outbound";
  attemptId: string;
  appId: string;
  appVersion: number;
  status: SarvamOutboundStatus;
  durationSeconds: number | null;
  interactionId: string | null;
  /** Truncated provider text. May contain provider names. Not user content. */
  failureReason: string | null;
  idempotencyKey: string | null;
}
const OUTBOUND_STATUSES = new Set<string>(["connected", "no_answer", "busy", "failed"]);

/**
 * Outbound callback. Sarvam sends no signature, so identity rests on the stored attempt:
 * attempt_id and app_id must match. Unknown or mismatched identity fails closed.
 * Transcript and agent variables are deliberately dropped: they can contain health information.
 */
export function parseSarvamOutboundWebhook(body: unknown, stored: StoredOutboundAttempt | null): SarvamOutboundEvent {
  if (!isRecord(body)) throw new AdapterError("invalid_payload", "sarvam");
  const attemptId = str(body.attempt_id, 128), appId = str(body.app_id, 128);
  if (!attemptId || !appId) throw new AdapterError("invalid_payload", "sarvam");
  if (!stored || stored.attemptId !== attemptId || stored.appId !== appId) throw new AdapterError("unknown_identity", "sarvam");
  const status = body.status;
  if (typeof status !== "string" || !OUTBOUND_STATUSES.has(status)) throw new AdapterError("invalid_payload", "sarvam");
  const channel = body.channel_info;
  if (!isRecord(channel)) throw new AdapterError("invalid_payload", "sarvam");
  if (stored.agentPhoneNumber && digits(channel.agent_phone_number) !== digits(stored.agentPhoneNumber)) throw new AdapterError("unknown_identity", "sarvam");
  if (!Number.isSafeInteger(body.app_version)) throw new AdapterError("invalid_payload", "sarvam");
  const duration = body.duration;
  if (duration !== null && duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)) throw new AdapterError("invalid_payload", "sarvam");
  const interactionId = body.interaction_id ?? null;
  if (interactionId !== null && !(typeof interactionId === "string" && INTERACTION_ID.test(interactionId))) throw new AdapterError("invalid_payload", "sarvam");
  const reason = body.failure_reason;
  if (reason !== null && reason !== undefined && typeof reason !== "string") throw new AdapterError("invalid_payload", "sarvam");
  const meta = isRecord(body.webhook_config) && isRecord(body.webhook_config.metadata) ? body.webhook_config.metadata : null;
  return {
    kind: "sarvam_outbound", attemptId, appId, appVersion: body.app_version as number, status: status as SarvamOutboundStatus,
    durationSeconds: typeof duration === "number" ? duration : null,
    interactionId: interactionId as string | null,
    failureReason: typeof reason === "string" ? reason.slice(0, 200) : null,
    idempotencyKey: meta ? str(meta.idempotency_key, 128) ?? null : null,
  };
}

export interface InboundDeployment { deploymentId: string; appId: string; agentPhoneNumber: string }
export interface RegisteredCaller { personId: string }
export interface SarvamInboundEvent {
  kind: "sarvam_inbound";
  interactionId: string;
  deploymentId: string;
  appId: string;
  personId: string;
  durationSeconds: number;
  startedAt: string | null;
  endedAt: string | null;
}
/**
 * Inbound deployment callback. Must match the configured deployment, app and agent number,
 * and the caller number must resolve to a registered person. Anything else fails closed.
 * Transcript, agent variables and metadata are dropped.
 */
export async function parseSarvamInboundWebhook(
  body: unknown,
  deployment: InboundDeployment,
  resolveCaller: (e164: string) => Promise<RegisteredCaller | null> | RegisteredCaller | null,
): Promise<SarvamInboundEvent> {
  if (!isRecord(body)) throw new AdapterError("invalid_payload", "sarvam");
  const interactionId = body.interaction_id;
  const deploymentId = str(body.deployment_id, 128), appId = str(body.app_id, 128);
  const user = str(body.user_phone_number, 32), agent = str(body.agent_phone_number, 32);
  if (typeof interactionId !== "string" || !INTERACTION_ID.test(interactionId) || !deploymentId || !appId || !user || !agent) throw new AdapterError("invalid_payload", "sarvam");
  if (deploymentId !== deployment.deploymentId || appId !== deployment.appId || digits(agent) !== digits(deployment.agentPhoneNumber)) throw new AdapterError("unknown_identity", "sarvam");
  const caller = await resolveCaller(assertE164(user));
  if (!caller || !caller.personId) throw new AdapterError("unknown_identity", "sarvam");
  const duration = body.duration ?? 0;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) throw new AdapterError("invalid_payload", "sarvam");
  const ts = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
  return { kind: "sarvam_inbound", interactionId, deploymentId, appId, personId: caller.personId, durationSeconds: duration, startedAt: ts(body.start_datetime), endedAt: ts(body.end_datetime) };
}
