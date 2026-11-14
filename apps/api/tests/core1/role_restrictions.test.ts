import { describe, it, expect } from 'vitest';
import { executeCore1Command } from '../../src/lib/core1';
import {
  createTestServicePorts,
  createHttpRequest,
  SYNTHETIC_FAMILY_A,
  SYNTHETIC_PERSON_PARENT,
  SYNTHETIC_PERSON_CIRCLE,
  SYNTHETIC_USER_CIRCLE,
} from './helpers';

describe('Role & Circle Capabilities (Blocker 5 Fix)', () => {
  it('allows active, consented circle member to access urgent help commands', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-circle',
      body: {
        command: 'urgent_help',
        subjectPersonId: SYNTHETIC_PERSON_PARENT,
        severity: 'urgent',
      },
      idempotencyKey: 'idemp-circle-1',
    });

    const res = await executeCore1Command(req, ports);
    expect(res.status).toBe('queued');
  });

  it('BLOCKER 5 FIX: fails closed when circle member has no linked circle record', async () => {
    const { ports } = createTestServicePorts({
      circles: [], // NO circle record!
    });

    const req = createHttpRequest({
      token: 'token-circle',
      body: {
        command: 'urgent_help',
        subjectPersonId: SYNTHETIC_PERSON_PARENT,
        severity: 'urgent',
      },
      idempotencyKey: 'idemp-circle-missing',
    });

    await expect(executeCore1Command(req, ports)).rejects.toMatchObject({
      code: 'circle_record_missing_fail_closed',
      status: 403,
    });
  });

  it('BLOCKER 5 FIX: fails closed when circle record is inactive or revoked', async () => {
    // Inactive circle member
    const { ports: portsInactive } = createTestServicePorts({
      circles: [
        {
          familyId: SYNTHETIC_FAMILY_A,
          personId: SYNTHETIC_PERSON_CIRCLE,
          rank: 1,
          active: false, // Inactive!
          approvedAt: '2026-11-01T00:00:00.000Z',
          consentAt: '2026-11-01T00:00:00.000Z',
          revokedAt: null,
        },
      ],
    });

    const req1 = createHttpRequest({
      token: 'token-circle',
      body: {
        command: 'urgent_help',
        subjectPersonId: SYNTHETIC_PERSON_PARENT,
        severity: 'urgent',
      },
      idempotencyKey: 'idemp-circle-inactive',
    });

    await expect(executeCore1Command(req1, portsInactive)).rejects.toMatchObject({
      code: 'circle_member_inactive',
      status: 403,
    });

    // Revoked circle member
    const { ports: portsRevoked } = createTestServicePorts({
      circles: [
        {
          familyId: SYNTHETIC_FAMILY_A,
          personId: SYNTHETIC_PERSON_CIRCLE,
          rank: 1,
          active: true,
          approvedAt: '2026-11-01T00:00:00.000Z',
          consentAt: '2026-11-01T00:00:00.000Z',
          revokedAt: '2026-11-14T00:00:00.000Z', // Revoked!
        },
      ],
    });

    const req2 = createHttpRequest({
      token: 'token-circle',
      body: {
        command: 'urgent_help',
        subjectPersonId: SYNTHETIC_PERSON_PARENT,
        severity: 'urgent',
      },
      idempotencyKey: 'idemp-circle-revoked',
    });

    await expect(executeCore1Command(req2, portsRevoked)).rejects.toMatchObject({
      code: 'circle_member_revoked',
      status: 403,
    });
  });

  it('restricts circle member from executing child-only family reports or refill proposals', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-circle',
      body: {
        command: 'family_report',
        periodStart: '2026-11-01T00:00:00.000Z',
        periodEnd: '2026-11-15T00:00:00.000Z',
      },
      idempotencyKey: 'idemp-circle-unauth',
    });

    await expect(executeCore1Command(req, ports)).rejects.toMatchObject({
      code: 'circle_role_unauthorized_for_family_report',
      status: 403,
    });
  });
});
