import { createHash } from "node:crypto";
import {
  AdapterError, fetchTwilioRecording, getSarvamRecording, MAX_TWILIO_RECORDING_BYTES, verifySarvamAttemptInteraction, type FetchTransport,
} from "@sahaj/adapters";
import { decryptWebhook } from "../webhook-security";
import { effectiveConsent } from "../provider-ingestion/gateway";
import { validateObjectPath } from "../media/paths";
import { RecordingError, type RawEventRow, type RecordingOutcome, type RecordingStorage, type RecordingStore } from "./types";

export const RETRIEVAL_EVENT = "twilio.recording.retrieval_requested";
export const SARVAM_RETRIEVAL_EVENT = "sarvam.recording.retrieval_requested";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_SID = /^AC[a-f0-9]{32}$/i, CALL_SID = /^CA[a-f0-9]{32}$/i, RECORDING_SID = /^RE[a-f0-9]{32}$/i;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const CALL_REF = /^[A-Za-z0-9_.\/:-]{1,160}$/;
const INTERACTION_ID = /^\d{8}\/(?!\.+$)[A-Za-z0-9_.:-]{1,128}$/;
const MAX_DURATION_SECONDS = 6 * 3600;

export interface SarvamRecordingConfig { apiKey: string; orgId: string; workspaceId: string; appId: string; lookbackHours?: number }
export interface RecordingWorkerDeps {
  store: RecordingStore;
  storage: RecordingStorage;
  /** Scripted in tests. Production passes global fetch; nothing here calls it directly. */
  transport: FetchTransport;
  /** WEBHOOK_ENCRYPTION_KEY (64 hex chars), read by the caller. */
  encryptionKey: string;
  accountSid: string;
  authToken: string;
  /** CALL_CONSENT_VERSION. A consent on any other version is not effective. */
  consentVersion: string;
  /** Optional. Absent means Sarvam recording retrieval is explicitly unavailable and such events are rejected, not guessed at. */
  sarvam?: SarvamRecordingConfig;
  retentionDays?: number;
  maxBytes?: number;
  timeoutMs?: number;
  now?: () => Date;
}

const isWav = (b: Uint8Array) =>
  b.length >= 44 && String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === "RIFF" && String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === "WAVE";
const str = (v: unknown, re: RegExp): string => { if (typeof v === "string" && re.test(v)) return v; throw new RecordingError("invalid_event"); };

/** Everything provider specific: which recording, which call reference it must match, and how to fetch it. */
interface Plan { refHash: string; callRef: string; fetch(limit: number, now: Date): Promise<Uint8Array> }

function twilioPlan(deps: RecordingWorkerDeps, payload: Record<string, unknown>, personId: string): Plan {
  const accountSid = str(payload.account_sid, ACCOUNT_SID), callSid = str(payload.call_sid, CALL_SID), recordingSid = str(payload.recording_sid, RECORDING_SID);
  if (accountSid !== deps.accountSid) throw new RecordingError("wrong_provider_account");
  return {
    refHash: createHash("sha256").update(`twilio:${accountSid.toLowerCase()}:${recordingSid.toLowerCase()}`).digest("hex"),
    callRef: callSid,
    async fetch(limit) {
      const key = `recording:${accountSid}:${recordingSid}`;
      const res = await fetchTwilioRecording(
        { transport: deps.transport, accountSid: deps.accountSid, authToken: deps.authToken, timeoutMs: deps.timeoutMs },
        { personId, idempotencyKey: key, payload: { recordingSid },
          authorization: { decision: "allow", consent: true, personId, action: "twilio.recording.read", idempotencyKey: key, expiresAt: Date.now() + 60_000 } },
        { maxBytes: limit });
      return res.data.audio;
    },
  };
}

function sarvamPlan(deps: RecordingWorkerDeps, payload: Record<string, unknown>, personId: string, callRef: string): Plan {
  const cfg = deps.sarvam;
  if (!cfg) throw new RecordingError("sarvam_recording_unavailable");
  const appId = str(payload.app_id, SAFE_ID), interactionId = str(payload.interaction_id, INTERACTION_ID);
  if (appId !== cfg.appId) throw new RecordingError("wrong_provider_account");
  const sarvam = { transport: deps.transport, apiKey: cfg.apiKey, orgId: cfg.orgId, workspaceId: cfg.workspaceId, timeoutMs: deps.timeoutMs };
  const grant = (action: string, key: string) => ({ decision: "allow" as const, consent: true, personId, action, idempotencyKey: key, expiresAt: Date.now() + 60_000 });
  return {
    refHash: createHash("sha256").update(`sarvam:${appId}:${interactionId}`).digest("hex"),
    callRef,
    async fetch(limit, now) {
      const key = `recording:sarvam:${appId}:${interactionId}`;
      // The webhook is unsigned. For an outbound call the stored external id is the attempt id, so the interaction in the
      // body is only believed once Sarvam itself says that attempt produced it. For inbound calls the stored id IS the interaction.
      if (callRef !== interactionId) {
        const hours = Math.min(Math.max(cfg.lookbackHours ?? 72, 1), 24 * 14);
        const check = await verifySarvamAttemptInteraction(sarvam, {
          personId, idempotencyKey: `${key}:verify`, authorization: grant("sarvam.attempts.read", `${key}:verify`),
          payload: { appId, attemptId: callRef, interactionId, windowStart: new Date(now.getTime() - hours * 3_600_000), windowEnd: new Date(now.getTime() + 3_600_000) },
        });
        if (!check.confirmed) throw new RecordingError("interaction_unverified");
      }
      const res = await getSarvamRecording(sarvam,
        { personId, idempotencyKey: key, authorization: grant("sarvam.recording.read", key), payload: { appId, interactionId } }, { maxBytes: limit });
      return res.data.audio;
    },
  };
}

/**
 * Retrieve one consented provider recording and store it privately. The decision to fetch rests on facts re-read from the
 * database now, not on the consent id carried by the event:
 *  - the event is a retrieval request for a supported provider, and its encrypted payload agrees with its metadata;
 *  - the call row has that person, that provider and an external id equal to the call reference in the payload;
 *  - the call disclosed AI and has an effective call_recording consent on the configured version for exactly this call
 *    (call-specific newest row, global refusals win, a global yes never grants). Checked before the fetch and after it,
 *    and `put_call_recording` checks it again in SQL under the person/call locks when writing metadata.
 * Provider URLs are built by the adapters from validated ids; no URL from an event or a provider response is followed.
 * Multiple recordings per call: the first stored one keeps the slot; later distinct ones are ignored and deleted.
 * A recording that was purged (retention or revocation) is never stored again. Nothing is logged; outcomes carry codes only.
 */
export async function processRecordingEvent(deps: RecordingWorkerDeps, row: RawEventRow): Promise<RecordingOutcome> {
  let cleanupPath: string | null = null;
  const cleanup = async (): Promise<boolean> => {
    if (!cleanupPath) return true;
    try { await deps.storage.remove(cleanupPath); return true; } catch { return false; }
  };
  const reject = async (code: string): Promise<RecordingOutcome> =>
    (await cleanup()) ? { status: "rejected", code } : { status: "retry", code: "cleanup_failed" };
  try {
    const provider = row.eventType === RETRIEVAL_EVENT && row.source === "twilio" ? "twilio"
      : row.eventType === SARVAM_RETRIEVAL_EVENT && row.source === "sarvam" ? "sarvam" : null;
    if (!provider) return { status: "rejected", code: "wrong_event_type" };
    if (provider === "sarvam" && !deps.sarvam) return { status: "rejected", code: "sarvam_recording_unavailable" };
    if (!row.payloadCiphertext || !UUID.test(row.familyId)) return { status: "rejected", code: "invalid_event" };
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(decryptWebhook(row.payloadCiphertext, deps.encryptionKey, `${row.source}:${row.providerEventId}`).toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch { return { status: "rejected", code: "payload_unreadable" }; }

    const callId = str(payload.call_id, UUID), eventConsentId = str(payload.consent_id, UUID), personId = str(payload.person_id, UUID);
    const m = row.metadata;
    if (payload.status !== "completed" || m.status !== "completed" || m.call_id !== callId || m.consent_id !== eventConsentId || m.person_id !== personId) return { status: "rejected", code: "event_mismatch" };
    const duration = payload.duration_seconds;
    if (provider === "twilio" && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > MAX_DURATION_SECONDS)) return { status: "rejected", code: "invalid_event" };

    const callRef = provider === "twilio" ? str(payload.call_sid, CALL_SID) : str(payload.call_ref, CALL_REF);
    const plan = provider === "twilio" ? twilioPlan(deps, payload, personId) : sarvamPlan(deps, payload, personId, callRef);
    const path = `${row.familyId}/calls/${callId}/${plan.refHash.slice(0, 32)}.wav`;
    if (!validateObjectPath(path, row.familyId)) return { status: "rejected", code: "invalid_event" };

    const call = await deps.store.getCall(row.familyId, callId);
    if (!call || call.personId !== personId) return { status: "rejected", code: "call_not_found" };
    if (call.provider !== provider || call.externalId !== plan.callRef) return { status: "rejected", code: "call_identity_mismatch" };

    const slot = await deps.store.slot(row.familyId, callId, plan.refHash);
    if (slot === "same") return { status: "already_stored" };
    if (slot === "purged") return { status: "rejected", code: "recording_purged" };
    cleanupPath = path; // from here an object at this deterministic path can only be ours and unreferenced
    if (slot === "other") return (await cleanup()) ? { status: "ignored_additional" } : { status: "retry", code: "cleanup_failed" };

    const consentNow = async (): Promise<string | null> => {
      if (!call.aiDisclosed) return null;
      const rows = await deps.store.findConsents(row.familyId, personId, callId);
      const effective = effectiveConsent(rows, { familyId: row.familyId, personId, callId, purpose: "call_recording", version: deps.consentVersion });
      // The consent the event points at must still be a yes on this exact call, so a forged or substituted id is refused.
      const linked = rows.some((r) => r.id === eventConsentId && r.familyId === row.familyId && r.personId === personId && r.callId === callId && r.answer);
      return effective && linked ? effective : null;
    };
    if (!(await consentNow())) return reject("consent_not_effective");

    const limit = Math.min(deps.maxBytes ?? MAX_TWILIO_RECORDING_BYTES, MAX_TWILIO_RECORDING_BYTES);
    const now = (deps.now ?? (() => new Date()))();
    let audio: Uint8Array;
    try {
      audio = await plan.fetch(limit, now);
    } catch (error) {
      if (error instanceof RecordingError) return reject(error.code);
      if (!(error instanceof AdapterError)) return { status: "retry", code: "fetch_failed" };
      if (error.code === "payload_too_large") return reject("media_too_large");
      if (error.code === "provider_rejected") {
        if (error.status === 404) return { status: "retry", code: "recording_not_ready" };
        if (error.status === 200) return reject("media_type_rejected");
        return reject("provider_rejected");
      }
      if (error.code === "provider_unavailable") return { status: "retry", code: "provider_unavailable" };
      return reject("fetch_rejected");
    }
    if (audio.length === 0 || audio.length > limit || !isWav(audio)) return reject("media_invalid");

    // Consent may have been withdrawn while the bytes were in flight. Discard them without writing.
    const consentId = await consentNow();
    if (!consentId) return reject("consent_not_effective");

    try { await deps.storage.put(path, audio, "audio/wav"); } catch { return { status: "retry", code: "storage_unavailable" }; }
    // 'exists' means an earlier attempt already wrote the same recording: continue to the metadata write.

    const days = Math.min(Math.max(Math.trunc(deps.retentionDays ?? 90), 1), 365);
    try {
      const result = await deps.store.put({ familyId: row.familyId, callId, consentId, objectPath: path, expiresAt: new Date(now.getTime() + days * 86_400_000), refHash: plan.refHash });
      if (result === "ignored_additional") return (await cleanup()) ? { status: "ignored_additional" } : { status: "retry", code: "cleanup_failed" };
      if (result === "purged") return reject("recording_purged");
      return { status: result };
    } catch (error) {
      // Consent or metadata refused by SQL: delete the object. Any other failure keeps it so the retry resumes from 'exists'.
      if (error instanceof RecordingError && !error.retryable) return reject(error.code);
      return { status: "retry", code: "metadata_unavailable" };
    }
  } catch (error) {
    if (error instanceof RecordingError) return error.retryable ? { status: "retry", code: error.code } : reject(error.code);
    return { status: "retry", code: "store_unavailable" };
  }
}
