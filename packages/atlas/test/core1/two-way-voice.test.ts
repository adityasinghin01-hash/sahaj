import { describe, it, expect } from 'vitest';
import { createVoicePost, validateVoiceObjectPath } from '../../src/core1/two-way-voice';
import { createClock } from '../../src/core1/types';
import type { VoiceShareConsent } from '../../src/core1/types';

describe('Two-Way Family Voice Domain Logic', () => {
  const familyId = '11111111-1111-4111-8111-111111111111';
  const senderId = '22222222-2222-4222-8222-222222222222'; // Maa
  const recipientId = '33333333-3333-4333-8333-333333333333'; // Child

  const validConsent: VoiceShareConsent = {
    id: 'consent-voice-1',
    familyId,
    personId: senderId,
    purpose: `voice_share:${recipientId}`,
    answer: true,
  };

  it('enqueues two-way voice post with verified consent and private storage path', () => {
    const clock = createClock('2026-11-15T12:00:00.000Z');
    const objectPath = `${familyId}/voice/msg_20261115_001.m4a`;

    const result = createVoicePost({
      familyId,
      senderId,
      recipientId,
      objectPath,
      consent: validConsent,
      clock,
    });

    expect(result.status).toBe('enqueued');
    expect(result.voicePost.state).toBe('queued');
    expect(result.voicePost.senderId).toBe(senderId);
    expect(result.voicePost.recipientId).toBe(recipientId);
    expect(result.intent).toBeDefined();
    // Guard: Absolutely prohibits AI synthetic cloning
    expect(result.intent?.syntheticCloningProhibited).toBe(true);
  });

  it('rejects path traversal, url schemes, and cross-family storage paths', () => {
    expect(validateVoiceObjectPath(familyId, `${familyId}/voice/safe.m4a`)).toBe(true);

    // Path traversal
    expect(validateVoiceObjectPath(familyId, `${familyId}/voice/../../etc/passwd`)).toBe(false);
    expect(validateVoiceObjectPath(familyId, `${familyId}/voice/%2e%2e/file.m4a`)).toBe(false);

    // URL schemes
    expect(validateVoiceObjectPath(familyId, 'https://evil.com/audio.m4a')).toBe(false);
    expect(validateVoiceObjectPath(familyId, 's3://bucket/audio.m4a')).toBe(false);

    // Wrong family
    expect(validateVoiceObjectPath(familyId, '99999999-9999-4999-8999-999999999999/voice/file.m4a')).toBe(false);

    // Wrong bucket
    expect(validateVoiceObjectPath(familyId, `${familyId}/public/file.m4a`)).toBe(false);
  });

  it('blocks voice message when consent purpose does not cover recipient', () => {
    const clock = createClock('2026-11-15T12:00:00.000Z');
    const wrongRecipientConsent: VoiceShareConsent = {
      ...validConsent,
      purpose: 'voice_share:44444444-4444-4444-8444-444444444444', // Different recipient!
    };

    const result = createVoicePost({
      familyId,
      senderId,
      recipientId,
      objectPath: `${familyId}/voice/msg.m4a`,
      consent: wrongRecipientConsent,
      clock,
    });

    expect(result.status).toBe('blocked_missing_consent');
    expect(result.voicePost.state).toBe('failed');
  });

  it('blocks voice message when consent is revoked or expired', () => {
    const clock = createClock('2026-11-15T12:00:00.000Z');

    const revokedConsent: VoiceShareConsent = {
      ...validConsent,
      revokedAt: '2026-11-15T11:00:00.000Z',
    };
    const rRevoked = createVoicePost({
      familyId,
      senderId,
      recipientId,
      objectPath: `${familyId}/voice/msg.m4a`,
      consent: revokedConsent,
      clock,
    });
    expect(rRevoked.status).toBe('blocked_missing_consent');

    const expiredConsent: VoiceShareConsent = {
      ...validConsent,
      expiresAt: '2026-11-14T00:00:00.000Z',
    };
    const rExpired = createVoicePost({
      familyId,
      senderId,
      recipientId,
      objectPath: `${familyId}/voice/msg.m4a`,
      consent: expiredConsent,
      clock,
    });
    expect(rExpired.status).toBe('expired');
  });

  it('throws on sender and recipient identity collision', () => {
    const clock = createClock('2026-11-15T12:00:00.000Z');
    expect(() =>
      createVoicePost({
        familyId,
        senderId,
        recipientId: senderId, // same person!
        objectPath: `${familyId}/voice/msg.m4a`,
        consent: validConsent,
        clock,
      })
    ).toThrow('Sender and recipient cannot be the same person');
  });
});
