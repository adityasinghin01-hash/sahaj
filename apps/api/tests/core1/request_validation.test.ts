import { describe, it, expect } from 'vitest';
import { executeCore1Command } from '../../src/lib/core1';
import {
  createTestServicePorts,
  createHttpRequest,
  SYNTHETIC_FAMILY_A,
  SYNTHETIC_PERSON_PARENT,
} from './helpers';

describe('Strict Request Validation & Path Security', () => {
  it('BLOCKER 7 FIX: rejects unknown or extraneous fields in command payload', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'check_in',
        personId: SYNTHETIC_PERSON_PARENT,
        extraneousSneakyField: 'malicious_input', // Unknown field!
      },
      idempotencyKey: 'idemp-unknown-field',
    });

    await expect(executeCore1Command(req, ports)).rejects.toMatchObject({
      code: 'unknown_field_extraneousSneakyField_in_check_in',
      status: 400,
    });
  });

  it('BLOCKER 2 FIX: rejects URL schemes in mediaObjectPath', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'voice_message',
        recipientPersonId: SYNTHETIC_PERSON_PARENT,
        mediaObjectPath: 'https://attacker.com/audio.m4a', // URL scheme!
        consentId: 'consent-111',
      },
      idempotencyKey: 'idemp-url-path',
    });

    await expect(executeCore1Command(req, ports)).rejects.toMatchObject({
      code: 'media_path_url_prohibited',
      status: 400,
    });
  });

  it('BLOCKER 2 FIX: rejects directory traversal and encoded dots (%2e%2e)', async () => {
    const { ports } = createTestServicePorts();

    // Directory traversal
    const req1 = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'voice_message',
        recipientPersonId: SYNTHETIC_PERSON_PARENT,
        mediaObjectPath: `${SYNTHETIC_FAMILY_A}/voice/../../etc/shadow`,
        consentId: 'consent-111',
      },
      idempotencyKey: 'idemp-traversal-1',
    });
    await expect(executeCore1Command(req1, ports)).rejects.toMatchObject({
      code: 'media_path_traversal_prohibited',
      status: 400,
    });

    // Encoded traversal
    const req2 = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'voice_message',
        recipientPersonId: SYNTHETIC_PERSON_PARENT,
        mediaObjectPath: `${SYNTHETIC_FAMILY_A}/voice/%2e%2e/data.m4a`,
        consentId: 'consent-111',
      },
      idempotencyKey: 'idemp-traversal-2',
    });
    await expect(executeCore1Command(req2, ports)).rejects.toMatchObject({
      code: 'media_path_traversal_prohibited',
      status: 400,
    });
  });

  it('BLOCKER 2 FIX: rejects other-family paths and wrong storage buckets', async () => {
    const { ports } = createTestServicePorts();

    // Cross-family path
    const reqCross = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'voice_message',
        recipientPersonId: SYNTHETIC_PERSON_PARENT,
        mediaObjectPath: '99999999-9999-4999-8999-999999999999/voice/audio.m4a',
        consentId: 'consent-111',
      },
      idempotencyKey: 'idemp-cross-fam-path',
    });
    await expect(executeCore1Command(reqCross, ports)).rejects.toMatchObject({
      code: 'media_path_cross_family_mismatch',
      status: 403,
    });

    // Wrong category bucket
    const reqBucket = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'voice_message',
        recipientPersonId: SYNTHETIC_PERSON_PARENT,
        mediaObjectPath: `${SYNTHETIC_FAMILY_A}/public_uploads/audio.m4a`,
        consentId: 'consent-111',
      },
      idempotencyKey: 'idemp-wrong-bucket',
    });
    await expect(executeCore1Command(reqBucket, ports)).rejects.toMatchObject({
      code: 'invalid_media_bucket_category',
      status: 400,
    });
  });

  it('rejects oversized payloads exceeding 64KB with 413', async () => {
    const { ports } = createTestServicePorts();
    const largeStr = 'a'.repeat(70000);
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'check_in',
        personId: SYNTHETIC_PERSON_PARENT,
        cancellationReason: largeStr,
      },
      idempotencyKey: 'idemp-huge',
    });

    await expect(executeCore1Command(req, ports)).rejects.toMatchObject({
      code: 'payload_too_large',
      status: 413,
    });
  });

  it('rejects missing idempotency key with 400', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'check_in',
        personId: SYNTHETIC_PERSON_PARENT,
      },
      // idempotencyKey omitted!
    });

    await expect(executeCore1Command(req, ports)).rejects.toMatchObject({
      code: 'missing_idempotency_key',
      status: 400,
    });
  });
});
