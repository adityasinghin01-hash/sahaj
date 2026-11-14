/**
 * Test helpers, synthetic fixtures, and mock ports for Core 1 API tests.
 */

import type { User } from '@supabase/supabase-js';
import {
  Core1CommandError,
  type AuthPort,
  type Core1RepositoryPort,
  type Core1ServicePorts,
  type FamilyMembership,
  type CircleRecord,
  type StoredRawEvent,
} from '../../src/lib/core1';

export const SYNTHETIC_ENCRYPTION_KEY_HEX =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export const SYNTHETIC_FAMILY_A = '11111111-1111-4111-8111-111111111111';
export const SYNTHETIC_FAMILY_B = '22222222-2222-4222-8222-222222222222';

export const SYNTHETIC_USER_CHILD = 'u1000000-0000-4000-8000-000000000001';
export const SYNTHETIC_PERSON_CHILD = 'c1000000-0000-4000-8000-000000000001';

export const SYNTHETIC_USER_PARENT = 'u2000000-0000-4000-8000-000000000002';
export const SYNTHETIC_PERSON_PARENT = 'c2000000-0000-4000-8000-000000000002';

export const SYNTHETIC_USER_CIRCLE = 'u3000000-0000-4000-8000-000000000003';
export const SYNTHETIC_PERSON_CIRCLE = 'c3000000-0000-4000-8000-000000000003';

export const SYNTHETIC_MEDICINE = 'a0000000-0000-4000-8000-000000000001';
export const SYNTHETIC_VENDOR = 'b0000000-0000-4000-8000-000000000001';
export const SYNTHETIC_CONSENT = 'c0000000-0000-4000-8000-000000000001';
export const SYNTHETIC_INCIDENT = 'd0000000-0000-4000-8000-000000000001';
export const SYNTHETIC_SCHEDULE = 'e0000000-0000-4000-8000-000000000001';

export function createMockAuthPort(users: Record<string, User>): AuthPort {
  return {
    getUser: async (token: string) => {
      const user = users[token];
      if (!user) {
        throw new Error('Invalid token');
      }
      return user;
    },
  };
}

export interface InMemoryDb {
  memberships: FamilyMembership[];
  circles: CircleRecord[];
  entities: Record<string, Set<string>>; // `${table}:${familyId}` -> Set of entityIds
  rawEvents: StoredRawEvent[];
}

export function createInMemoryRepository(db: InMemoryDb): Core1RepositoryPort {
  return {
    getMembership: async (userId: string, requestedFamilyId?: string) => {
      let matches = db.memberships.filter(m => m.userId === userId);
      if (requestedFamilyId) {
        matches = matches.filter(m => m.familyId === requestedFamilyId);
      }
      if (matches.length === 0) {
        throw new Core1CommandError('family_membership_not_found', 403);
      }
      if (!requestedFamilyId && matches.length > 1) {
        throw new Core1CommandError('ambiguous_family_membership_family_id_required', 400);
      }
      return matches[0];
    },

    getCircleRecord: async (familyId: string, personId: string) => {
      const rec = db.circles.find(c => c.familyId === familyId && c.personId === personId);
      return rec ?? null;
    },

    validateEntityOwnership: async (entityType: string, familyId: string, entityId: string) => {
      const key = `${entityType}:${familyId}`;
      const set = db.entities[key];
      return set ? set.has(entityId) : false;
    },

    findEventByIdempotency: async (scopedKey: string) => {
      const found = db.rawEvents.find(e => e.providerEventId === scopedKey);
      return found ?? null;
    },

    persistCommandEvent: async (params) => {
      const existing = db.rawEvents.find(e => e.providerEventId === params.scopedIdempotencyKey);
      if (existing) {
        throw new Core1CommandError('duplicate_command_event', 409);
      }
      db.rawEvents.push({
        id: params.eventId,
        familyId: params.familyId,
        source: 'core1_command',
        providerEventId: params.scopedIdempotencyKey,
        payloadHash: params.payloadHash,
        payloadCiphertext: params.payloadCiphertext,
        status: 'queued',
      });
    },
  };
}

export function createTestServicePorts(initialDb?: Partial<InMemoryDb>): {
  ports: Core1ServicePorts;
  db: InMemoryDb;
} {
  const db: InMemoryDb = {
    memberships: initialDb?.memberships ?? [
      {
        familyId: SYNTHETIC_FAMILY_A,
        userId: SYNTHETIC_USER_CHILD,
        personId: SYNTHETIC_PERSON_CHILD,
        role: 'child',
      },
      {
        familyId: SYNTHETIC_FAMILY_A,
        userId: SYNTHETIC_USER_PARENT,
        personId: SYNTHETIC_PERSON_PARENT,
        role: 'parent',
      },
      {
        familyId: SYNTHETIC_FAMILY_A,
        userId: SYNTHETIC_USER_CIRCLE,
        personId: SYNTHETIC_PERSON_CIRCLE,
        role: 'circle',
      },
    ],
    circles: initialDb?.circles ?? [
      {
        familyId: SYNTHETIC_FAMILY_A,
        personId: SYNTHETIC_PERSON_CIRCLE,
        rank: 1,
        active: true,
        approvedAt: '2026-11-01T00:00:00.000Z',
        consentAt: '2026-11-01T00:00:00.000Z',
        revokedAt: null,
      },
    ],
    entities: initialDb?.entities ?? {
      [`person:${SYNTHETIC_FAMILY_A}`]: new Set([
        SYNTHETIC_PERSON_CHILD,
        SYNTHETIC_PERSON_PARENT,
        SYNTHETIC_PERSON_CIRCLE,
      ]),
      [`incident:${SYNTHETIC_FAMILY_A}`]: new Set([SYNTHETIC_INCIDENT, 'inc-222']),
      [`medicine:${SYNTHETIC_FAMILY_A}`]: new Set([SYNTHETIC_MEDICINE]),
      [`vendor:${SYNTHETIC_FAMILY_A}`]: new Set([SYNTHETIC_VENDOR]),
      [`consent:${SYNTHETIC_FAMILY_A}`]: new Set([SYNTHETIC_CONSENT]),
      [`schedule:${SYNTHETIC_FAMILY_A}`]: new Set([SYNTHETIC_SCHEDULE]),
    },
    rawEvents: initialDb?.rawEvents ?? [],
  };

  const users: Record<string, User> = {
    'token-child': { id: SYNTHETIC_USER_CHILD, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' },
    'token-parent': { id: SYNTHETIC_USER_PARENT, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' },
    'token-circle': { id: SYNTHETIC_USER_CIRCLE, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' },
  };

  const ports: Core1ServicePorts = {
    auth: createMockAuthPort(users),
    repo: createInMemoryRepository(db),
    encryptionKeyHex: SYNTHETIC_ENCRYPTION_KEY_HEX,
  };

  return { ports, db };
}

export function createHttpRequest(params: {
  method?: string;
  url?: string;
  body?: unknown;
  token?: string;
  idempotencyKey?: string;
}): Request {
  const headers = new Headers();
  if (params.token) {
    headers.set('authorization', `Bearer ${params.token}`);
  }
  if (params.idempotencyKey) {
    headers.set('idempotency-key', params.idempotencyKey);
  }
  headers.set('content-type', 'application/json');

  const bodyStr = params.body !== undefined ? JSON.stringify(params.body) : undefined;
  return new Request(params.url ?? 'http://localhost/api/core1', {
    method: params.method ?? 'POST',
    headers,
    body: bodyStr,
  });
}
