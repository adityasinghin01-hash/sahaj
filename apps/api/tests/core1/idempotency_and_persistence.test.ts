import { describe, it, expect } from 'vitest';
import { executeCore1Command, deriveScopedIdempotencyKey } from '../../src/lib/core1';
import {
  createTestServicePorts,
  createHttpRequest,
  SYNTHETIC_FAMILY_A,
  SYNTHETIC_FAMILY_B,
  SYNTHETIC_PERSON_CHILD,
  SYNTHETIC_PERSON_PARENT,
} from './helpers';

describe('Scoped Idempotency & Persistence Security', () => {
  it('BLOCKER 3 FIX: derives distinct domain-separated keys across families and actors', () => {
    const rawKey = 'client-idemp-12345';
    const keyFamA = deriveScopedIdempotencyKey(SYNTHETIC_FAMILY_A, SYNTHETIC_PERSON_CHILD, rawKey);
    const keyFamB = deriveScopedIdempotencyKey(SYNTHETIC_FAMILY_B, SYNTHETIC_PERSON_CHILD, rawKey);
    const keyActor2 = deriveScopedIdempotencyKey(SYNTHETIC_FAMILY_A, SYNTHETIC_PERSON_PARENT, rawKey);

    expect(keyFamA).not.toBe(keyFamB);
    expect(keyFamA).not.toBe(keyActor2);
    expect(keyFamA).toMatch(/^idemp-[0-9a-f]{32}$/);
  });

  it('replays identical request idempotently with deduped: true', async () => {
    const { ports } = createTestServicePorts();
    const req1 = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'check_in',
        personId: SYNTHETIC_PERSON_PARENT,
      },
      idempotencyKey: 'idemp-replay-test',
    });

    const res1 = await executeCore1Command(req1, ports);
    expect(res1.status).toBe('queued');
    expect(res1.deduped).toBe(false);

    // Replay with identical body
    const req2 = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'check_in',
        personId: SYNTHETIC_PERSON_PARENT,
      },
      idempotencyKey: 'idemp-replay-test',
    });

    const res2 = await executeCore1Command(req2, ports);
    expect(res2.status).toBe('queued');
    expect(res2.deduped).toBe(true);
    expect(res2.eventId).toBe(res1.eventId);
  });

  it('BLOCKER 3 FIX: raises 409 conflict when idempotency key is reused with changed body', async () => {
    const { ports } = createTestServicePorts();
    const req1 = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'check_in',
        personId: SYNTHETIC_PERSON_PARENT,
        cancellationReason: 'First reason',
      },
      idempotencyKey: 'idemp-conflict-test',
    });

    const res1 = await executeCore1Command(req1, ports);
    expect(res1.status).toBe('queued');

    // Second request with SAME idempotency key but CHANGED body
    const req2 = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'check_in',
        personId: SYNTHETIC_PERSON_PARENT,
        cancellationReason: 'DIFFERENT reason!', // Body altered!
      },
      idempotencyKey: 'idemp-conflict-test',
    });

    await expect(executeCore1Command(req2, ports)).rejects.toMatchObject({
      code: 'idempotency_conflict_body_mismatch',
      status: 409,
    });
  });

  it('BLOCKER 8 FIX: maps invalid or malformed encryption configuration to 503 free of secrets', async () => {
    // Malformed hex key (e.g. wrong characters or wrong length)
    const { ports: portsBadKey } = createTestServicePorts();
    portsBadKey.encryptionKeyHex = 'invalid-non-hex-key';

    const req = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'check_in',
        personId: SYNTHETIC_PERSON_PARENT,
      },
      idempotencyKey: 'idemp-enc-fail',
    });

    await expect(executeCore1Command(req, portsBadKey)).rejects.toMatchObject({
      code: 'service_unavailable_encryption',
      status: 503,
    });
  });
});
