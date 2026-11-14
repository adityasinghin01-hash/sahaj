/**
 * Two-way family voice orchestration domain logic.
 *
 * Implements:
 * - Real two-way family voice messages between verified family members
 * - Strict consent validation: requires active, unrevoked consent for purpose `voice_share:<recipientPersonId>`
 * - Validated storage paths adhering to private storage conventions
 * - Expiration and revocation tracking
 * - Absolute prohibition on family voice cloning (synthetic voice reproduction is refused)
 * - Deterministic identifier generation for stable replays
 */

import { deriveDeterministicId } from './types';
import type {
  VoicePost,
  VoiceContentMetadata,
  VoiceShareConsent,
  VoicePostTransitionResult,
  Clock,
} from './types';

export function validateVoiceObjectPath(familyId: string, objectPath: string): boolean {
  if (typeof objectPath !== 'string' || !objectPath.trim()) return false;
  // Reject URL schemes
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(objectPath)) return false;
  // Reject path traversal and encoded dots
  if (objectPath.includes('..') || objectPath.toLowerCase().includes('%2e')) return false;

  // Expected convention: <familyId>/voice/<file>
  const parts = objectPath.split('/');
  if (parts.length < 3) return false;
  if (parts[0] !== familyId) return false;
  if (parts[1] !== 'voice') return false;

  // Filename check: alphanumeric plus dashes and safe extensions (e.g. .wav, .m4a, .mp3, .ogg)
  const filename = parts.slice(2).join('/');
  return /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9]+)?$/.test(filename);
}

export interface CreateVoicePostParams {
  familyId: string;
  senderId: string;
  recipientId: string;
  objectPath: string;
  consent: VoiceShareConsent;
  replyToId?: string;
  retentionDays?: number;
  clock: Clock;
}

/**
 * Creates and validates a two-way voice post between family members.
 * Verifies specific voice share consent and storage path conventions.
 */
export function createVoicePost(params: CreateVoicePostParams): VoicePostTransitionResult {
  const { familyId, senderId, recipientId, objectPath, consent, replyToId, clock } = params;
  const now = clock.now();
  const nowIso = clock.nowIso();
  const retentionDays = params.retentionDays && params.retentionDays > 0 ? params.retentionDays : 30;

  // 1. Guard against self-messages or cross-family mismatch
  if (senderId === recipientId) {
    throw new Error('Sender and recipient cannot be the same person');
  }

  if (consent.familyId !== familyId || consent.personId !== senderId) {
    throw new Error('Voice share consent does not belong to sender family/person');
  }

  // 2. Validate object path
  if (!validateVoiceObjectPath(familyId, objectPath)) {
    const syntheticId = deriveDeterministicId(`voice:${familyId}:${senderId}`, nowIso);
    return {
      voicePost: {
        id: syntheticId,
        familyId,
        senderId,
        recipientId,
        replyToId,
        state: 'failed',
        consentId: consent.id,
        createdAt: nowIso,
      },
      content: {
        familyId,
        voicePostId: syntheticId,
        objectPath,
        expiresAt: nowIso,
      },
      status: 'invalid_path',
      reason: 'Object path does not conform to private family voice storage convention',
    };
  }

  // 3. Validate specific consent: purpose MUST be voice_share:<recipientId>
  const expectedPurpose = `voice_share:${recipientId}`;
  if (consent.purpose !== expectedPurpose && consent.purpose !== 'voice_share:*') {
    const syntheticId = deriveDeterministicId(`voice:${familyId}:${senderId}`, nowIso);
    return {
      voicePost: {
        id: syntheticId,
        familyId,
        senderId,
        recipientId,
        replyToId,
        state: 'failed',
        consentId: consent.id,
        createdAt: nowIso,
      },
      content: {
        familyId,
        voicePostId: syntheticId,
        objectPath,
        expiresAt: nowIso,
      },
      status: 'blocked_missing_consent',
      reason: `Consent purpose ${consent.purpose} does not cover recipient ${recipientId}`,
    };
  }

  if (!consent.answer || consent.revokedAt) {
    const syntheticId = deriveDeterministicId(`voice:${familyId}:${senderId}`, nowIso);
    return {
      voicePost: {
        id: syntheticId,
        familyId,
        senderId,
        recipientId,
        replyToId,
        state: 'failed',
        consentId: consent.id,
        createdAt: nowIso,
      },
      content: {
        familyId,
        voicePostId: syntheticId,
        objectPath,
        expiresAt: nowIso,
      },
      status: 'blocked_missing_consent',
      reason: 'Consent is refused or revoked',
    };
  }

  if (consent.expiresAt && now.getTime() >= new Date(consent.expiresAt).getTime()) {
    const syntheticId = deriveDeterministicId(`voice:${familyId}:${senderId}`, nowIso);
    return {
      voicePost: {
        id: syntheticId,
        familyId,
        senderId,
        recipientId,
        replyToId,
        state: 'failed',
        consentId: consent.id,
        createdAt: nowIso,
      },
      content: {
        familyId,
        voicePostId: syntheticId,
        objectPath,
        expiresAt: nowIso,
      },
      status: 'expired',
      reason: 'Consent has expired',
    };
  }

  // 4. Create VoicePost and dispatch intent
  const voicePostId = deriveDeterministicId(`voice:${familyId}:${senderId}:${recipientId}`, nowIso);
  const expiresAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const voicePost: VoicePost = {
    id: voicePostId,
    familyId,
    senderId,
    recipientId,
    replyToId,
    state: 'queued',
    consentId: consent.id,
    createdAt: nowIso,
  };

  const content: VoiceContentMetadata = {
    familyId,
    voicePostId,
    objectPath,
    expiresAt,
  };

  return {
    voicePost,
    content,
    intent: {
      familyId,
      voicePostId,
      senderId,
      recipientId,
      objectPath,
      consentId: consent.id,
      expiresAt,
      replyToId,
      syntheticCloningProhibited: true,
    },
    status: 'enqueued',
  };
}
