import type {
  Core2AuthPort,
  Core2CryptoPort,
  Core2DispatchPort,
  Core2GatePort,
  Core2Person,
  Core2Repository,
  Core2TimelinePort,
} from "@/lib/core2/contracts";
import type { VoiceNotifyDeps } from "@/lib/core1/voice-notify";
import type { FetchTransport } from "@sahaj/adapters";

export class Core2ProofError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 401 | 403 | 404 | 409 | 415 | 422 | 429 | 503,
    message: string,
  ) {
    super(message);
    this.name = "Core2ProofError";
  }
}

export interface ProofWordEntry {
  word: string;
  aliases: readonly string[];
}

export const PROOF_WORD_BANK: readonly ProofWordEntry[] = [
  { word: "gulab", aliases: ["gulab", "gulaab", "गुलाब"] },
  { word: "kamal", aliases: ["kamal", "कमल"] },
  { word: "suraj", aliases: ["suraj", "sooraj", "सूरज"] },
  { word: "champa", aliases: ["champa", "चम्पा", "चंपा"] },
  { word: "koyal", aliases: ["koyal", "कोयल"] },
  { word: "tara", aliases: ["tara", "taara", "तारा"] },
  { word: "neem", aliases: ["neem", "नीम"] },
  { word: "nadi", aliases: ["nadi", "नदी"] },
  { word: "baadal", aliases: ["baadal", "badal", "बादल"] },
  { word: "imli", aliases: ["imli", "इमली"] },
  { word: "saathi", aliases: ["saathi", "sathi", "साथी"] },
  { word: "dhaniya", aliases: ["dhaniya", "धनिया"] },
] as const;

export const PROOF_DEFAULT_TTL_MS = 60_000;
export const MAX_STT_AUDIO_SECONDS = 30;
export const MAX_STT_AUDIO_BYTES = 5 * 1024 * 1024;
export const ANY_PHONE_MAX_ATTEMPTS = 3;
export const ANY_PHONE_LOCK_MS = 15 * 60_000;

export const ANY_PHONE_GRANTED_POWERS = [
  "reassure_parent",
  "request_local_circle_help",
] as const;

export const ANY_PHONE_DENIED_POWERS = [
  "change_settings",
  "view_location",
  "approve_money",
] as const;

export type ProofChallengeStatus =
  | "pending"
  | "verified"
  | "word_mismatch"
  | "expired"
  | "escalated";

export interface ProofChallengeRow {
  id: string;
  familyId: string;
  requesterPersonId: string;
  subjectPersonId: string;
  wordToken: string;
  wordAliases: string[];
  status: ProofChallengeStatus;
  ttlSeconds: number;
  expiresAt: string;
  answeredAt: string | null;
  verifiedAt: string | null;
  escalatedAt: string | null;
  voiceMediaId: string | null;
  voicePostId: string | null;
  voiceObjectPath: string | null;
  sttTranscript: string | null;
  sttMatched: boolean;
  incidentId: string | null;
  requestId: string | null;
  offeredContactPersonId: string | null;
  offeredContactName: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface AnyPhoneAttemptOutcome {
  locked: boolean;
  lockedUntil: string | null;
  failedAttempts: number;
  remainingAttempts: number;
}

export interface AnyPhoneSessionRow {
  id: string;
  familyId: string;
  subjectPersonId: string;
  incidentId: string;
  requestId: string;
  callRefHash: string | null;
  callerChannel: string;
  grantedPowers: string[];
  deniedPowers: string[];
  codeWordRotated: boolean;
  voicePostId: string | null;
  voiceObjectPath: string | null;
  statusMessageHi: string;
  statusMessageEn: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProofPersonCandidate extends Core2Person {
  aliases: string[];
}

export interface SaarasSttInput {
  audio: Uint8Array;
  contentType: string;
  filename?: string;
  durationS?: number | null;
  languageCode?: string;
}

export interface SaarasSttResult {
  transcript: string;
  languageCode: string | null;
  provider: "saaras";
}

export interface SaarasSttPort {
  transcribe(input: SaarasSttInput): Promise<SaarasSttResult>;
}

export interface VoiceAudioLookup {
  voiceMediaId: string | null;
  voicePostId: string | null;
  senderId: string;
  recipientId: string;
  objectPath: string;
  contentType: string;
  durationS: number | null;
  bytes: Uint8Array;
}

export interface ProofStoragePort {
  readVoiceMediaForAnswer(input: {
    familyId: string;
    subjectPersonId: string;
    voiceMediaId?: string | null;
    voicePostId?: string | null;
    mediaObjectPath?: string | null;
  }): Promise<VoiceAudioLookup | null>;
  uploadVoiceBytes(objectPath: string, bytes: Uint8Array, contentType: string): Promise<void>;
  createSignedVoiceUrl(input: {
    familyId: string;
    actorUserId: string;
    actorPersonId: string;
    actorRole: "parent" | "child" | "circle";
    voicePostId: string | null;
    objectPath: string;
    expiresInSeconds?: number;
  }): Promise<{ url: string; expiresInSeconds: number } | null>;
}

export interface ProofAnyPhoneRepo {
  findPersonByNameOrAlias(
    familyId: string,
    saidName: string,
    role?: "child" | "parent" | "circle",
  ): Promise<ProofPersonCandidate | null>;
  listPushTokensForPerson(familyId: string, personId: string): Promise<string[]>;

  createProofChallenge(input: {
    familyId: string;
    requesterPersonId: string;
    subjectPersonId: string;
    wordToken: string;
    wordAliases: readonly string[];
    ttlSeconds: number;
    expiresAt: string;
  }): Promise<ProofChallengeRow>;
  getProofChallenge(familyId: string, challengeId: string): Promise<ProofChallengeRow | null>;
  getLatestProofChallenge(familyId: string, subjectPersonId?: string): Promise<ProofChallengeRow | null>;
  updateProofChallengeAnswer(input: {
    familyId: string;
    challengeId: string;
    status: "verified" | "word_mismatch";
    answeredAt: string;
    verifiedAt: string | null;
    voiceMediaId: string | null;
    voicePostId: string | null;
    voiceObjectPath: string | null;
    sttTranscript: string;
    sttMatched: boolean;
    attempts: number;
  }): Promise<ProofChallengeRow>;
  markProofChallengeEscalated(input: {
    familyId: string;
    challengeId: string;
    escalatedAt: string;
    incidentId: string;
    requestId: string;
    offeredContactPersonId: string | null;
    offeredContactName: string | null;
  }): Promise<ProofChallengeRow>;
  claimDueProofChallenges(nowIso: string, limit: number): Promise<ProofChallengeRow[]>;

  getCodeWordHash(familyId: string): Promise<string | null>;
  rotateCodeWordHash(familyId: string, newHashHex: string): Promise<void>;
  recordAnyPhoneAttempt(input: {
    familyId: string;
    ok: boolean;
    maxAttempts: number;
    lockSeconds: number;
    nowIso: string;
  }): Promise<AnyPhoneAttemptOutcome>;
  createAnyPhoneSession(input: {
    familyId: string;
    subjectPersonId: string;
    incidentId: string;
    requestId: string;
    callRefHash: string | null;
    grantedPowers: readonly string[];
    deniedPowers: readonly string[];
    codeWordRotated: boolean;
    statusMessageHi: string;
    statusMessageEn: string;
  }): Promise<AnyPhoneSessionRow>;
  getAnyPhoneSession(familyId: string, sessionId: string): Promise<AnyPhoneSessionRow | null>;
  getLatestAnyPhoneSession(familyId: string): Promise<AnyPhoneSessionRow | null>;
  attachVoiceToAnyPhoneSession(input: {
    familyId: string;
    sessionId: string;
    voicePostId: string;
    voiceObjectPath: string;
  }): Promise<AnyPhoneSessionRow>;

  recordVoiceShareConsent(input: {
    familyId: string;
    personId: string;
    recipientId: string;
    version: string;
  }): Promise<{ consentId: string }>;
  createVoicePostWithMedia(input: {
    familyId: string;
    senderId: string;
    recipientId: string;
    objectPath: string;
    consentId: string;
  }): Promise<{ voicePostId: string }>;
}

export interface Core2ProofDeps {
  auth: Core2AuthPort;
  core2Repo: Core2Repository;
  proofRepo: ProofAnyPhoneRepo;
  storage: ProofStoragePort;
  stt: SaarasSttPort;
  dispatch: Core2DispatchPort;
  gate: Core2GatePort;
  timeline: Core2TimelinePort;
  crypto: Core2CryptoPort;
  voiceNotifyDeps?: VoiceNotifyDeps;
  notifyOnVoicePost?: (
    deps: VoiceNotifyDeps,
    input: {
      familyId: string;
      voicePostId: string;
      senderId: string;
      recipientId: string;
      replyToId?: string | null;
    },
  ) => Promise<unknown>;
  sendPush?: (
    messages: Array<{ to: string; title: string; body: string; sound?: "default"; data?: Record<string, string> }>,
  ) => Promise<{ sent: number; failed: number }>;
  fetchTwilioRecordingAudio?: (input: { recordingSid: string }) => Promise<{ audio: Uint8Array; contentType: "audio/wav" }>;
  fetchSarvamRecordingAudio?: (input: { appId: string; interactionId: string }) => Promise<{ audio: Uint8Array; contentType: "audio/wav" }>;
  verifyTwilioSignature?: (request: Request, rawBody: string) => boolean;
  transport?: FetchTransport;
  now?: () => Date;
  uuid?: () => string;
  randomIndex?: (maxExclusive: number) => number;
  env?: Record<string, string | undefined>;
}

export interface PublicProofChallengeDto {
  id: string;
  family_id: string;
  requester_person_id: string;
  subject_person_id: string;
  word_token: string;
  prompt_hi: string;
  prompt_en: string;
  status: ProofChallengeStatus;
  ttl_seconds: number;
  expires_at: string;
  answered_at: string | null;
  verified_at: string | null;
  escalated_at: string | null;
  voice_media_id: string | null;
  voice_post_id: string | null;
  stt_matched: boolean;
  incident_id: string | null;
  offered_contact_name: string | null;
  freshness_seconds: number | null;
  freshness_stamp_hi: string | null;
  freshness_stamp_en: string | null;
  escalation_message_hi: string | null;
  escalation_message_en: string | null;
  media_url: string | null;
  media_expires_in: number | null;
  attempts: number;
  created_at: string;
}

export interface PublicAnyPhoneSessionDto {
  id: string;
  family_id: string;
  subject_person_id: string;
  incident_id: string;
  offered_contact_name: string | null;
  granted_powers: string[];
  denied_powers: string[];
  code_word_rotated: boolean;
  voice_post_id: string | null;
  media_url: string | null;
  media_expires_in: number | null;
  status_message_hi: string;
  status_message_en: string;
  created_at: string;
}
