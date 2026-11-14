import { createHash } from "node:crypto";
import { AdapterError, fetchTwilioRecording, MAX_TWILIO_RECORDING_BYTES, type FetchTransport } from "@sahaj/adapters";
import { decryptWebhook } from "../webhook-security";
import { effectiveConsent } from "../provider-ingestion/gateway";
import { validateObjectPath } from "../media/paths";
import { RecordingError, type RawEventRow, type RecordingOutcome, type RecordingStorage, type RecordingStore } from "./types";

export const RETRIEVAL_EVENT = "twilio.recording.retrieval_requested";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_SID = /^AC[a-f0-9]{32}$/i, CALL_SID = /^CA[a-f0-9]{32}$/i, RECORDING_SID = /^RE[a-f0-9]{32}$/i;
const MAX_DURATION_SECONDS = 6 * 3600;

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
  retentionDays?: number;
  maxBytes?: number;
  timeoutMs?: number;
  now?: () => Date;
}

const isWav = (b: Uint8Array) =>
  b.length >= 44 && String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === "RIFF" && String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === "WAVE";
const str = (v: unknown, re: RegExp): string => { if (typeof v === "string" && re.test(v)) return v; throw new RecordingError("invalid_event"); };

/**
 * Retrieve one consented Twilio recording and store it privately. The decision to fetch rests on facts re-read from the
 * database now, not on the consent id carried by the event:
 *  - the event is the signed-callback type for this source, and its payload (encrypted) agrees with its metadata;
 *  - the call row has that person, provider twilio and external id equal to the CallSid in the payload;
 *  - the call disclosed AI and has an effective call_recording consent on the configured version for exactly this call
 *    (call-specific newest row, global refusals win, a global yes never grants). It is checked before the fetch and again
 *    after it, and `put_call_recording` checks it a third time in SQL when writing metadata.
 * The URL is built by the adapter from SIDs; no URL from the event or the provider is ever followed.
 * Multiple recordings per call: the first stored one keeps the slot; later distinct ones are ignored (deleted).
 * Nothing is logged. Outcomes carry short codes only.
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
    if (row.source !== "twilio" || row.eventType !== RETRIEVAL_EVENT) return { status: "rejected", code: "wrong_event_type" };
    if (!row.payloadCiphertext || !UUID.test(row.familyId)) return { status: "rejected", code: "invalid_event" };
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(decryptWebhook(row.payloadCiphertext, deps.encryptionKey, `${row.source}:${row.providerEventId}`).toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch { return { status: "rejected", code: "payload_unreadable" }; }

    const accountSid = str(payload.account_sid, ACCOUNT_SID), callSid = str(payload.call_sid, CALL_SID), recordingSid = str(payload.recording_sid, RECORDING_SID);
    const callId = str(payload.call_id, UUID), eventConsentId = str(payload.consent_id, UUID), personId = str(payload.person_id, UUID);
    const m = row.metadata;
    if (payload.status !== "completed" || m.status !== "completed" || m.call_id !== callId || m.consent_id !== eventConsentId || m.person_id !== personId) return { status: "rejected", code: "event_mismatch" };
    if (accountSid !== deps.accountSid) return { status: "rejected", code: "wrong_provider_account" };
    const duration = payload.duration_seconds;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > MAX_DURATION_SECONDS) return { status: "rejected", code: "invalid_event" };

    const refHash = createHash("sha256").update(`twilio:${accountSid.toLowerCase()}:${recordingSid.toLowerCase()}`).digest("hex");
    const path = `${row.familyId}/calls/${callId}/${refHash.slice(0, 32)}.wav`;
    if (!validateObjectPath(path, row.familyId)) return { status: "rejected", code: "invalid_event" };

    const call = await deps.store.getCall(row.familyId, callId);
    if (!call || call.personId !== personId) return { status: "rejected", code: "call_not_found" };
    if (call.provider !== "twilio" || call.externalId !== callSid) return { status: "rejected", code: "call_identity_mismatch" };

    const slot = await deps.store.slot(row.familyId, callId, refHash);
    if (slot === "same") return { status: "already_stored" };
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
      const res = await fetchTwilioRecording(
        { transport: deps.transport, accountSid: deps.accountSid, authToken: deps.authToken, timeoutMs: deps.timeoutMs },
        { personId, idempotencyKey: `recording:${refHash}`, payload: { recordingSid },
          authorization: { decision: "allow", consent: true, personId, action: "twilio.recording.read", idempotencyKey: `recording:${refHash}`, expiresAt: Date.now() + 60_000 } },
        { maxBytes: limit });
      audio = res.data.audio;
    } catch (error) {
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

    let stored: "created" | "exists";
    try { stored = await deps.storage.put(path, audio, "audio/wav"); } catch { return { status: "retry", code: "storage_unavailable" }; }
    void stored; // 'exists' means an earlier attempt already wrote the same recording: continue to the metadata write.

    const days = Math.min(Math.max(Math.trunc(deps.retentionDays ?? 90), 1), 365);
    try {
      const result = await deps.store.put({ familyId: row.familyId, callId, consentId, objectPath: path, expiresAt: new Date(now.getTime() + days * 86_400_000), refHash });
      if (result === "ignored_additional") return (await cleanup()) ? { status: "ignored_additional" } : { status: "retry", code: "cleanup_failed" };
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
