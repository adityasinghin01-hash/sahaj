import type { ConsentRow } from "../provider-ingestion/gateway";

export interface RawEventRow {
  id: string; familyId: string; source: string; providerEventId: string; eventType: string;
  metadata: Record<string, unknown>; payloadCiphertext: string | null;
}
export interface CallRecord { personId: string; provider: string; externalId: string | null; aiDisclosed: boolean }
export type PutResult = "stored" | "already_stored" | "ignored_additional" | "purged";

/** Service-role persistence. Only IDs, hashes, paths and expiry cross this boundary. No transcripts or phone numbers. */
export interface RecordingStore {
  getCall(familyId: string, callId: string): Promise<CallRecord | null>;
  /** Exact-call rows plus global refusals for this person, newest first and bounded (see the gateway store). */
  findConsents(familyId: string, personId: string, callId: string): Promise<ConsentRow[]>;
  slot(familyId: string, callId: string, refHash: string): Promise<"none" | "same" | "other" | "purged">;
  /** put_call_recording: re-validates consent in SQL at write time. */
  put(input: { familyId: string; callId: string; consentId: string; objectPath: string; expiresAt: Date; refHash: string }): Promise<PutResult>;
}
/** Private bucket `sahaj-recordings`. Never a public URL. */
export interface RecordingStorage {
  put(path: string, bytes: Uint8Array, contentType: "audio/wav"): Promise<"created" | "exists">;
  remove(path: string): Promise<void>;
}

export type RecordingOutcome =
  | { status: "stored" | "already_stored" | "ignored_additional"; code?: undefined }
  /** Permanent: do not retry. Includes refusals (no consent, revoked, wrong identity) and bad media. */
  | { status: "rejected"; code: string }
  /** Transient: the caller may retry with the same raw event. Retrying is safe: paths and hashes are deterministic. */
  | { status: "retry"; code: string };

/** Error codes only. */
export class RecordingError extends Error {
  constructor(public readonly code: string, public readonly retryable = false) { super(code); this.name = "RecordingError"; }
}
