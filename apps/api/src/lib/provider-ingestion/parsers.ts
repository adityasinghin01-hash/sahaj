import { WebhookError } from "../webhook-security";

/**
 * Strict, allowlist-only provider payload parsers. Every returned object holds IDs, enums, counters
 * and timestamps only. Transcripts, agent variables, phone numbers, recording URLs and free text
 * are never copied out of the provider payload.
 *
 * Field names come from the Sarvam, TeleCMI and Twilio contracts already encoded in the adapters
 * branch (feature/core1-adapters) and Twilio's documented status/recording callback parameters.
 * They were NOT re-verified against live provider docs in this session (web access was denied).
 */
type Json = Record<string, unknown>;
const invalid = () => new WebhookError("invalid_payload", 400);

export const isRecord = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const INTERACTION_ID = /^\d{8}\/(?!\.+$)[A-Za-z0-9_.:-]{1,128}$/;

function safeId(v: unknown): string {
  if (typeof v !== "string" || !SAFE_ID.test(v)) throw invalid();
  return v;
}

/** Digits only, 8 to 15 long (E.164 range). Used for comparison; never persisted or logged. */
export function phoneDigits(v: unknown): string {
  if (typeof v !== "string" && typeof v !== "number") throw invalid();
  const d = String(v).replace(/[\s()+-]/g, "");
  if (!/^\d{8,15}$/.test(d)) throw invalid();
  return d;
}

export type SarvamOutboundStatus = "connected" | "no_answer" | "busy" | "failed";
const OUTBOUND_STATUSES = new Set<string>(["connected", "no_answer", "busy", "failed"]);

export interface SarvamOutbound {
  attemptId: string; appId: string; appVersion: number; status: SarvamOutboundStatus;
  durationSeconds: number | null; interactionId: string | null; agentDigits: string;
}
export function parseSarvamOutbound(body: Json): SarvamOutbound {
  const status = body.status;
  if (typeof status !== "string" || !OUTBOUND_STATUSES.has(status)) throw invalid();
  if (!isRecord(body.channel_info)) throw invalid();
  if (typeof body.app_version !== "number" || !Number.isSafeInteger(body.app_version)) throw invalid();
  const duration = body.duration ?? null;
  if (duration !== null && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 86400)) throw invalid();
  const interaction = body.interaction_id ?? null;
  if (interaction !== null && !(typeof interaction === "string" && INTERACTION_ID.test(interaction))) throw invalid();
  return {
    attemptId: safeId(body.attempt_id), appId: safeId(body.app_id), appVersion: body.app_version,
    status: status as SarvamOutboundStatus, durationSeconds: duration, interactionId: interaction,
    agentDigits: phoneDigits(body.channel_info.agent_phone_number),
  };
}

export interface SarvamInbound {
  interactionId: string; deploymentId: string; appId: string; callerDigits: string; agentDigits: string;
  durationSeconds: number; startedAt: string | null; endedAt: string | null;
}
export function parseSarvamInbound(body: Json): SarvamInbound {
  const interactionId = body.interaction_id;
  if (typeof interactionId !== "string" || !INTERACTION_ID.test(interactionId)) throw invalid();
  const duration = body.duration ?? 0;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 86400) throw invalid();
  const ts = (v: unknown) => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  return {
    interactionId, deploymentId: safeId(body.deployment_id), appId: safeId(body.app_id),
    callerDigits: phoneDigits(body.user_phone_number), agentDigits: phoneDigits(body.agent_phone_number),
    durationSeconds: duration, startedAt: ts(body.start_datetime), endedAt: ts(body.end_datetime),
  };
}

export interface TeleCmiMissed { callId: string; appId: number; virtualDigits: string; callerDigits: string; occurredAt: number }
/** Webhook CDR: type "cdr", direction "inbound", status "missed", appid, virtual_number, cmiuuid, from, time (ms). */
export function parseTeleCmiMissed(body: Json, now: number): TeleCmiMissed {
  if (body.type !== "cdr" || body.direction !== "inbound" || body.status !== "missed") throw invalid();
  const callId = body.cmiuuid;
  if (typeof callId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(callId)) throw invalid();
  const appid = typeof body.appid === "number" ? body.appid : typeof body.appid === "string" && /^\d{1,12}$/.test(body.appid) ? Number(body.appid) : NaN;
  const time = body.time;
  if (!Number.isSafeInteger(appid) || typeof time !== "number" || !Number.isFinite(time) || time <= 1_000_000_000_000 || time > now + 24 * 3600_000) throw invalid();
  return { callId, appId: appid, virtualDigits: phoneDigits(body.virtual_number), callerDigits: phoneDigits(body.from), occurredAt: time };
}

const ACCOUNT_SID = /^AC[a-f0-9]{32}$/;
const CALL_SID = /^CA[a-f0-9]{32}$/;
const RECORDING_SID = /^RE[a-f0-9]{32}$/;
const CALL_STATUSES = ["queued", "initiated", "ringing", "in-progress", "completed", "busy", "failed", "no-answer", "canceled"] as const;
const RECORDING_STATUSES = ["in-progress", "completed", "absent", "failed"] as const;
export type TwilioCallStatus = (typeof CALL_STATUSES)[number];
export type TwilioRecordingStatus = (typeof RECORDING_STATUSES)[number];

function single(params: URLSearchParams, key: string): string | null {
  const all = params.getAll(key);
  if (all.length > 1) throw invalid();
  return all[0] ?? null;
}
function oneOf<T extends string>(v: string | null, set: readonly T[]): T {
  if (v === null || !(set as readonly string[]).includes(v)) throw invalid();
  return v as T;
}
function sid(params: URLSearchParams, key: string, re: RegExp): string {
  const v = single(params, key);
  if (v === null || !re.test(v)) throw invalid();
  return v;
}
function optionalCount(params: URLSearchParams, key: string): string {
  const v = single(params, key);
  if (v === null) return "0";
  if (!/^\d{1,9}$/.test(v)) throw invalid();
  return String(Number(v));
}

export interface TwilioStatus { accountSid: string; callSid: string; status: TwilioCallStatus; sequence: string }
export function parseTwilioStatus(params: URLSearchParams): TwilioStatus {
  return {
    accountSid: sid(params, "AccountSid", ACCOUNT_SID), callSid: sid(params, "CallSid", CALL_SID),
    status: oneOf(single(params, "CallStatus"), CALL_STATUSES), sequence: optionalCount(params, "SequenceNumber"),
  };
}

export interface TwilioRecording { accountSid: string; callSid: string; recordingSid: string; status: TwilioRecordingStatus; durationSeconds: string }
export function parseTwilioRecording(params: URLSearchParams): TwilioRecording {
  return {
    accountSid: sid(params, "AccountSid", ACCOUNT_SID), callSid: sid(params, "CallSid", CALL_SID),
    recordingSid: sid(params, "RecordingSid", RECORDING_SID), status: oneOf(single(params, "RecordingStatus"), RECORDING_STATUSES),
    durationSeconds: optionalCount(params, "RecordingDuration"),
  };
}
