/**
 * Ports and contracts for private voice media access.
 * Everything here is data shape only: no network, no secrets, no logging.
 */

/** Fixed private bucket allowlist. Mirrors the storage section of 20261114130240_core1_security_workflows.sql. */
export const MEDIA_BUCKETS = {
  "sahaj-voice": { maxBytes: 15_728_640 },
  "sahaj-recordings": { maxBytes: 52_428_800 },
  "sahaj-lines": { maxBytes: 5_242_880 },
} as const;
export type MediaBucket = keyof typeof MEDIA_BUCKETS;

export const ALLOWED_AUDIO_MIME = ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"] as const;

/** Hard ceiling for signed download URL lifetime. */
export const MAX_SIGNED_URL_SECONDS = 60;

/** Consent purpose for call recordings (answer is about the call's own person). */
export const RECORDING_CONSENT_PURPOSE = "call_recording";
/**
 * Voice-post sharing consent is recipient-specific by encoding the recipient person id in the
 * purpose text, because public.consents has no recipient column. See report: a dedicated column is preferable.
 */
export const voiceShareConsentPurpose = (recipientId: string) => `voice_share:${recipientId}`;

export type MemberRole = "parent" | "child" | "circle";

export interface VerifiedUser { userId: string }

export interface Membership { familyId: string; userId: string; personId: string; role: MemberRole; revokedAt: string | null }

export interface VoicePostRow {
  id: string; familyId: string; senderId: string; recipientId: string; consentId: string;
}
export interface VoiceContentRow { familyId: string; voicePostId: string; objectPath: string; expiresAt: string }
export interface CallRow { id: string; familyId: string; personId: string }
export interface CallContentRow {
  familyId: string; callId: string; consentId: string; recordingObjectPath: string | null; expiresAt: string;
}
export interface ConsentRow {
  id: string; familyId: string; personId: string; callId: string | null; purpose: string;
  answer: boolean; version: string; createdAt: string;
}

/** Verifies a bearer token with the identity provider (Supabase auth.getUser). Returns null when invalid. */
export interface AuthPort { verifyBearer(token: string): Promise<VerifiedUser | null> }

/** Read-only repository. Every method must be backed by live rows; implementations must not cache grants. */
export interface MediaRepository {
  getMembership(userId: string, familyId: string): Promise<Membership | null>;
  getVoicePost(postId: string): Promise<VoicePostRow | null>;
  getVoiceContent(familyId: string, postId: string): Promise<VoiceContentRow | null>;
  getCall(callId: string): Promise<CallRow | null>;
  getCallContent(familyId: string, callId: string): Promise<CallContentRow | null>;
  getConsent(familyId: string, consentId: string): Promise<ConsentRow | null>;
  /**
   * Append-only history for one person and purpose (any order). With `callId`, only rows for that exact call plus
   * explicit global refusals (call_id null, answer false) are required; global grants must not be returned.
   * Implementations must throw rather than return a possibly truncated history.
   */
  listConsentHistory(familyId: string, personId: string, purpose: string, callId?: string): Promise<ConsentRow[]>;
}

export interface ObjectInfo { size: number; contentType: string }
/** Read-only storage port. */
export interface StorageSigner {
  stat(bucket: MediaBucket, path: string): Promise<ObjectInfo | null>;
  createSignedUrl(bucket: MediaBucket, path: string, expiresInSeconds: number): Promise<string | null>;
}

/**
 * Facts the service has already proven from live rows, handed to the trusted authorization decision
 * (to be backed by @sahaj/gate / Cedar). Object size and MIME are not included: the decision runs
 * before any storage call.
 */
export interface MediaAuthorizationContext {
  action: "read_voice_media" | "read_call_recording";
  familyId: string;
  actor: { userId: string; personId: string; role: MemberRole };
  subject: { kind: "voice_post" | "call"; id: string; senderId?: string; recipientId?: string; personId?: string };
  consent: { id: string; purpose: string; personId: string; callId: string | null; grantedAt: string };
  object: { bucket: MediaBucket; path: string; expiresAt: string };
  now: string;
}
export type MediaDecision = "allow" | "ask" | "deny";
/** Only the exact value "allow" permits a read. Anything else, or a thrown error, denies. */
export type MediaAuthorizer = (context: MediaAuthorizationContext) => Promise<MediaDecision>;

export interface MediaDeps {
  auth: AuthPort;
  repo: MediaRepository;
  storage: StorageSigner;
  /** Mandatory. No default exists in the service. */
  authorizeMedia: MediaAuthorizer;
  now: () => Date;
}
export interface MediaOptions {
  /** Signed URL lifetime; must be 1..60. Defaults to 60. */
  signedUrlSeconds?: number;
  /** Optional maximum age of an affirmative consent. Unset means no age bound (schema has no expiry column). */
  consentMaxAgeMs?: number;
}

export type DenyCode =
  | "unauthenticated" | "not_found" | "forbidden" | "consent_required" | "expired"
  | "invalid_object" | "unavailable";
export type MediaResult =
  | { ok: true; url: string; expiresInSeconds: number }
  | { ok: false; code: DenyCode; status: 401 | 403 | 404 | 410 | 422 | 503 };
