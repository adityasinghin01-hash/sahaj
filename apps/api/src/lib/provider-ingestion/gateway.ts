import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookError } from "../webhook-security";
import {
  isRecord, parseSarvamInbound, parseSarvamOutbound, parseTeleCmiMissed, parseTwilioRecording, parseTwilioStatus, phoneDigits,
} from "./parsers";

export interface Identity { familyId: string; personId: string }
export type ConsentPurpose = "call_recording" | "call_transcript";
export interface CallRow extends Identity { callId: string; aiDisclosed: boolean }
export interface ConsentRow {
  id: string; familyId: string; personId: string; callId: string | null; purpose: string;
  answer: boolean; version: string; createdAt: string;
}
export interface ProviderEvent {
  source: "sarvam" | "telecmi" | "twilio";
  id: string; type: string; status: string; familyId: string; personId: string;
  /** Encrypted by the store. IDs, enums and counters, plus consented call content for Sarvam only. */
  payload: Record<string, unknown>;
  /** ID-only, non-content metadata. Never put transcripts, numbers or free text here. */
  callId?: string; consentId?: string; review?: "consent_missing";
}
/** Every method must throw WebhookError (503 on infrastructure failure) or return null/[] for "unknown". */
export interface ProviderStore {
  /** Server-stored Sarvam outbound attempt for this app (provider_identities, binding_kind 'attempt'). */
  findSarvamAttempt(appId: string, attemptId: string): Promise<Identity | null>;
  /** Registered caller (provider_identities, binding_kind 'contact'). externalId is phone digits. */
  resolveContact(source: "sarvam" | "telecmi", account: string, externalId: string): Promise<Identity | null>;
  /** calls row by provider and external_id (Twilio CallSid, Sarvam attempt id or interaction id). */
  findCall(provider: "twilio" | "sarvam", externalId: string): Promise<CallRow | null>;
  /** Newest consents rows for this call plus the person's call-independent rows (call_id null), for one purpose. */
  findConsents(familyId: string, personId: string, callId: string, purpose: ConsentPurpose): Promise<ConsentRow[]>;
  /** Must resolve only after ingest_raw_event has durably committed. */
  ingest(event: ProviderEvent): Promise<void>;
}

/**
 * Effective consent for one call. consents is append-only, so the newest row decides:
 * - only rows for this family, person and purpose count; rows for other calls are ignored, so a later yes
 *   on a different call never revives this call;
 * - the newest call-specific row must be an affirmative answer on the required version;
 * - the newest call-independent REFUSAL at or after that answer overrides it (ties go to refusal). Call-independent\n *   affirmations are ignored: they never restore consent a refusal ended.
 * Returns the consent row id, or null when collection is not proven.
 */
export function effectiveConsent(rows: ConsentRow[], want: { familyId: string; personId: string; callId: string; purpose: ConsentPurpose; version: string }): string | null {
  if (!want.version) return null;
  const at = (r: ConsentRow) => Date.parse(r.createdAt);
  const mine = rows.filter((r) => r.familyId === want.familyId && r.personId === want.personId && r.purpose === want.purpose);
  if (mine.some((r) => Number.isNaN(at(r)))) return null;
  const newest = (list: ConsentRow[]) => [...list].sort((a, b) => at(a) - at(b) || Number(b.answer) - Number(a.answer)).at(-1);
  const call = newest(mine.filter((r) => r.callId === want.callId));
  if (!call || !call.answer || call.version !== want.version) return null;
  // Only refusals matter here: a later global yes must never restore a consent that a refusal ended.
  const refusal = newest(mine.filter((r) => r.callId === null && !r.answer));
  if (refusal && at(refusal) >= at(call)) return null;
  return call.id;
}

async function consentFor(store: ProviderStore, call: CallRow | null, who: Identity, purpose: ConsentPurpose, version: string | undefined) {
  if (!version || !call || call.familyId !== who.familyId || call.personId !== who.personId) return null;
  const rows = await store.findConsents(call.familyId, call.personId, call.callId, purpose);
  const consentId = effectiveConsent(rows, { familyId: call.familyId, personId: call.personId, callId: call.callId, purpose, version });
  return consentId ? { callId: call.callId, consentId } : null;
}

export interface SarvamConfig { appId: string; agentDigits: string; deploymentId?: string; consentVersion?: string }
export interface TeleCmiConfig { appId: number; virtualDigits: string }
export interface TwilioConfig { accountSid: string; authToken: string; statusUrl?: string; recordingUrl?: string; consentVersion?: string }
export interface GatewayResult { status: number; body: Record<string, unknown> }

const reject = (code: string, status: number): never => { throw new WebhookError(code, status); };
const accepted = (): GatewayResult => ({ status: 200, body: { accepted: true, processing: "queued" } });

export function toResult(error: unknown): GatewayResult {
  if (error instanceof WebhookError) return { status: error.status, body: { error: error.code } };
  return { status: 503, body: { error: "event_persistence_failed" } };
}

function json(raw: Buffer): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")); } catch { return reject("invalid_json", 400); }
  if (!isRecord(value)) return reject("invalid_payload", 400);
  return value;
}

/**
 * Transcript and final variables, read only from the field names in Sarvam's webhook payloads
 * (`interaction_transcript`, `final_agent_variables`). They may hold health information, so they go
 * into the encrypted payload only, and only when consent for call_transcript is proven.
 */
function sarvamContent(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const t = body.interaction_transcript;
  if (t !== undefined && t !== null) {
    if (!Array.isArray(t) || t.length > 2000) reject("invalid_payload", 400);
    out.interaction_transcript = t;
  }
  const v = body.final_agent_variables;
  if (v !== undefined && v !== null) {
    if (!isRecord(v)) reject("invalid_payload", 400);
    out.final_agent_variables = v;
  }
  return out;
}

/**
 * Sarvam post-call webhook. Sarvam sends no signature, so the URL secret is only a gate. Sender identity
 * rests on configured app/agent/deployment plus either a server-stored attempt (outbound) or a
 * registered caller (inbound). Provider IDs alone never authenticate a sender.
 */
export async function handleSarvam(raw: Buffer, cfg: SarvamConfig, getStore: () => ProviderStore): Promise<GatewayResult> {
  const body = json(raw);
  const outboundEvent = typeof body.attempt_id === "string";
  const e = outboundEvent ? parseSarvamOutbound(body) : parseSarvamInbound(body);
  const content = sarvamContent(body);
  if (e.appId !== cfg.appId || e.agentDigits !== cfg.agentDigits) reject("wrong_provider_account", 403);
  if (!("attemptId" in e)) {
    if (!cfg.deploymentId) reject("provider_account_not_configured", 503);
    if (e.deploymentId !== cfg.deploymentId) reject("wrong_provider_account", 403);
  }
  const store = getStore();
  let who: Identity | null;
  let callRef: string;
  if ("attemptId" in e) { who = await store.findSarvamAttempt(e.appId, e.attemptId); callRef = e.attemptId; if (!who) reject("unknown_attempt", 403); }
  else { who = await store.resolveContact("sarvam", e.appId, e.callerDigits); callRef = e.interactionId; if (!who) reject("unregistered_sender", 403); }
  const identity = who!;
  const consent = Object.keys(content).length
    ? await consentFor(store, await store.findCall("sarvam", callRef), identity, "call_transcript", cfg.consentVersion)
    : null;
  const retained = consent ? { ...content, call_id: consent.callId, consent_id: consent.consentId } : {};
  const review = !consent && Object.keys(content).length ? ({ review_required: "consent_missing" } as const) : {};
  const flag = !consent && Object.keys(content).length ? ("consent_missing" as const) : undefined;
  if ("attemptId" in e) {
    await store.ingest({
      source: "sarvam", id: `${e.appId}:outbound:${e.attemptId}:${e.status}`, type: "sarvam.outbound", status: e.status, ...identity,
      payload: { app_id: e.appId, app_version: e.appVersion, attempt_id: e.attemptId, status: e.status, duration_seconds: e.durationSeconds, interaction_id: e.interactionId, ...retained, ...review },
      ...(consent ?? {}), review: flag,
    });
  } else {
    await store.ingest({
      source: "sarvam", id: `${e.deploymentId}:inbound:${e.interactionId}`, type: "sarvam.inbound", status: "completed", ...identity,
      payload: { app_id: e.appId, deployment_id: e.deploymentId, interaction_id: e.interactionId, duration_seconds: e.durationSeconds, started_at: e.startedAt, ended_at: e.endedAt, ...retained, ...review },
      ...(consent ?? {}), review: flag,
    });
  }
  return accepted();
}

/** TeleCMI missed-call CDR. Unsigned: configured appid + virtual number and a registered caller are required. */
export async function handleTeleCmi(raw: Buffer, cfg: TeleCmiConfig, getStore: () => ProviderStore, now = Date.now()): Promise<GatewayResult> {
  const e = parseTeleCmiMissed(json(raw), now);
  if (e.appId !== cfg.appId || e.virtualDigits !== cfg.virtualDigits) reject("wrong_provider_account", 403);
  const store = getStore();
  const identity = await store.resolveContact("telecmi", String(e.appId), e.callerDigits);
  if (!identity) reject("unregistered_sender", 403);
  await store.ingest({
    source: "telecmi", id: `${e.appId}:missed:${e.callId}`, type: "telecmi.missed_call", status: "missed", ...identity!,
    payload: { app_id: e.appId, call_id: e.callId, occurred_at: e.occurredAt },
  });
  return accepted();
}

/**
 * Twilio signature (HMAC-SHA1, base64): URL, then each parameter name sorted, each name's values
 * de-duplicated and sorted, appended as name+value. Matches twilio-node toFormUrlEncodedParam
 * and packages/adapters verifyTwilioFormSignature.
 */
export function verifyTwilioSignature(publicUrl: string, params: URLSearchParams, signature: string | null, authToken: string): boolean {
  if (!authToken || !signature || !publicUrl.startsWith("https://")) return false;
  let data = publicUrl;
  for (const key of [...new Set(params.keys())].sort()) for (const v of [...new Set(params.getAll(key))].sort()) data += key + v;
  const expected = createHmac("sha1", authToken).update(data).digest();
  const actual = Buffer.from(signature, "base64");
  return /^[A-Za-z0-9+/]{27}=$/.test(signature) && actual.length === expected.length && timingSafeEqual(actual, expected);
}

function twilioParams(raw: Buffer, contentType: string | null, signature: string | null, url: string | undefined, cfg: TwilioConfig): URLSearchParams {
  if (!cfg.authToken || !cfg.accountSid) reject("not_configured", 503);
  if (!url) reject("provider_account_not_configured", 503);
  if (!contentType?.toLowerCase().startsWith("application/x-www-form-urlencoded")) reject("unsupported_media_type", 415);
  const params = new URLSearchParams(raw.toString("utf8"));
  if ([...params.keys()].length > 100) reject("payload_too_large", 413);
  if (!verifyTwilioSignature(url!, params, signature, cfg.authToken)) reject("unauthorized", 401);
  return params;
}

/** Twilio call status callback. Signature uses the configured public URL, never the request's Host header. */
export async function handleTwilioStatus(raw: Buffer, contentType: string | null, signature: string | null, cfg: TwilioConfig, getStore: () => ProviderStore): Promise<GatewayResult> {
  const e = parseTwilioStatus(twilioParams(raw, contentType, signature, cfg.statusUrl, cfg));
  if (e.accountSid !== cfg.accountSid) reject("wrong_provider_account", 403);
  const store = getStore();
  const call = await store.findCall("twilio", e.callSid);
  if (!call) reject("unknown_call", 403);
  await store.ingest({
    source: "twilio", id: `${e.accountSid}:call:${e.callSid}:${e.status}:${e.sequence}`, type: "twilio.call_status", status: e.status,
    familyId: call!.familyId, personId: call!.personId,
    payload: { account_sid: e.accountSid, call_sid: e.callSid, status: e.status, sequence: Number(e.sequence) },
  });
  return accepted();
}

/**
 * Twilio recording status callback. A persisted 'completed' event queues retrieval for a worker; it does not
 * mean the recording was fetched, stored, delivered or heard. Requires AI disclosure on the call and an effective
 * call_recording consent row for this exact call. The event carries that call_id and consent_id; the worker must
 * re-check consent when it fetches. Unconsented calls are rejected before any write.
 */
export async function handleTwilioRecording(raw: Buffer, contentType: string | null, signature: string | null, cfg: TwilioConfig, getStore: () => ProviderStore): Promise<GatewayResult> {
  const e = parseTwilioRecording(twilioParams(raw, contentType, signature, cfg.recordingUrl, cfg));
  if (e.accountSid !== cfg.accountSid) reject("wrong_provider_account", 403);
  if (!cfg.consentVersion) reject("consent_version_not_configured", 503);
  const store = getStore();
  const call = await store.findCall("twilio", e.callSid);
  if (!call) reject("unknown_call", 403);
  const consent = call!.aiDisclosed ? await consentFor(store, call, call!, "call_recording", cfg.consentVersion) : null;
  if (!consent) reject("recording_consent_missing", 403);
  await store.ingest({
    source: "twilio", id: `${e.accountSid}:recording:${e.recordingSid}:${e.status}`,
    type: e.status === "completed" ? "twilio.recording.retrieval_requested" : "twilio.recording.status", status: e.status,
    familyId: call!.familyId, personId: call!.personId, ...consent!,
    payload: { account_sid: e.accountSid, call_sid: e.callSid, recording_sid: e.recordingSid, status: e.status, duration_seconds: Number(e.durationSeconds), call_id: consent!.callId, consent_id: consent!.consentId },
  });
  return accepted();
}

/** Normalise configured numbers once; a malformed configured number fails closed as 503. */
export function configuredDigits(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return phoneDigits(value); } catch { return undefined; }
}
