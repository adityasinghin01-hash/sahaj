import { describe, it, expect } from 'vitest';
import { executeCore1Command } from '../../src/lib/core1';
import {
  createTestServicePorts,
  createHttpRequest,
  SYNTHETIC_FAMILY_A,
  SYNTHETIC_FAMILY_B,
  SYNTHETIC_USER_CHILD,
  SYNTHETIC_PERSON_CHILD,
  SYNTHETIC_PERSON_PARENT,
} from './helpers';

describe('Core 1 Auth & Membership Resolution', () => {
  it('rejects requests missing Bearer token with 401', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      body: {
        command: 'check_in',
        personId: SYNTHETIC_PERSON_PARENT,
      },
      idempotencyKey: 'idemp-1',
    });

    await expect(executeCore1Command(req, ports)).rejects.toMatchObject({
      code: 'unauthorized_missing_bearer_token',
      status: 401,
    });
  });

  it('rejects requests with invalid Bearer token with 401', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'invalid-or-expired-token',
      body: {
        command: 'check_in',
        personId: SYNTHETIC_PERSON_PARENT,
      },
      idempotencyKey: 'idemp-1',
    });

    await expect(executeCore1Command(req, ports)).rejects.toMatchObject({
      code: 'unauthorized_invalid_bearer_token',
      status: 401,
    });
  });

  it('resolves explicit requested family when supplied', async () => {
    const { ports } = createTestServicePorts({
      memberships: [
        {
          familyId: SYNTHETIC_FAMILY_A,
          userId: SYNTHETIC_USER_CHILD,
          personId: SYNTHETIC_PERSON_CHILD,
          role: 'child',
        },
        {
          familyId: SYNTHETIC_FAMILY_B,
          userId: SYNTHETIC_USER_CHILD,
          personId: 'c2000000-0000-4000-8000-000000000099',
          role: 'child',
        },
      ],
      entities: {
        [`person:${SYNTHETIC_FAMILY_B}`]: new Set(['c2000000-0000-4000-8000-000000000099']),
      },
    });

    const req = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'check_in',
        familyId: SYNTHETIC_FAMILY_B,
        personId: 'c2000000-0000-4000-8000-000000000099',
      },
      idempotencyKey: 'idemp-multi-1',
    });

    const result = await executeCore1Command(req, ports);
    expect(result.status).toBe('queued');
    expect(result.deduped).toBe(false);
  });

  it('BLOCKER 4 FIX: rejects ambiguous multi-family membership when familyId is not requested', async () => {
    const { ports } = createTestServicePorts({
      memberships: [
        {
          familyId: SYNTHETIC_FAMILY_A,
          userId: SYNTHETIC_USER_CHILD,
          personId: SYNTHETIC_PERSON_CHILD,
          role: 'child',
        },
        {
          familyId: SYNTHETIC_FAMILY_B,
          userId: SYNTHETIC_USER_CHILD,
          personId: 'c2000000-0000-4000-8000-000000000099',
          role: 'child',
        },
      ],
    });

    const req = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'check_in',
        // familyId omitted deliberately!
        personId: SYNTHETIC_PERSON_PARENT,
      },
      idempotencyKey: 'idemp-ambiguous',
    });

    await expect(executeCore1Command(req, ports)).rejects.toMatchObject({
      code: 'ambiguous_family_membership_family_id_required',
      status: 400,
    });
  });

  it('rejects requested family if user is not an active member of that family', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'check_in',
        familyId: '99999999-9999-4999-8999-999999999999', // Not a member!
        personId: SYNTHETIC_PERSON_PARENT,
      },
      idempotencyKey: 'idemp-non-member',
    });

    await expect(executeCore1Command(req, ports)).rejects.toMatchObject({
      code: 'family_membership_not_found',
      status: 403,
    });
  });
});
