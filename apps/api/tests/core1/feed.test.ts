import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MediaDeps } from '@/lib/media/contracts';
import {
  getCheckInsFeed,
  getIncidentsFeed,
  getRefillsFeed,
  getVoiceFeed,
  handleCore1FeedRoute,
  sanitizeSummaryText,
} from '@/app/api/core1/feed/_lib/service';
import { handleVoiceFeedMediaGet } from '@/app/api/core1/feed/_lib/media';
import { createSupabaseCore1FeedRepository } from '@/app/api/core1/feed/_lib/supabase-repo';
import type {
  CheckInsFeedResponse,
  Core1FeedPorts,
  Core1FeedReadRepository,
  IncidentFeedItem,
  RefillFeedItem,
  VoiceFeedItem,
} from '@/app/api/core1/feed/_lib/types';
import {
  createInMemoryRepository,
  createMockAuthPort,
  SYNTHETIC_CONSENT,
  SYNTHETIC_FAMILY_A,
  SYNTHETIC_FAMILY_B,
  SYNTHETIC_INCIDENT,
  SYNTHETIC_MEDICINE,
  SYNTHETIC_PERSON_CHILD,
  SYNTHETIC_PERSON_CIRCLE,
  SYNTHETIC_PERSON_PARENT,
  SYNTHETIC_SCHEDULE,
  SYNTHETIC_USER_CHILD,
  SYNTHETIC_USER_CIRCLE,
  SYNTHETIC_USER_PARENT,
  SYNTHETIC_VENDOR,
  type InMemoryDb,
} from './helpers';

const SYNTHETIC_VOICE_POST = 'f1000000-0000-4000-8000-000000000001';
const SYNTHETIC_VOICE_POST_B = 'f2000000-0000-4000-8000-000000000002';
const SYNTHETIC_ASSIGNMENT_1 = 'a1000000-0000-4000-8000-000000000001';
const SYNTHETIC_REFILL_REQ = 'd1000000-0000-4000-8000-000000000001';
const SYNTHETIC_CALL = 'c4000000-0000-4000-8000-000000000001';
const SYNTHETIC_NUDGE = 'e1000000-0000-4000-8000-000000000001';

// Pure-UUID identifiers for media service tests (media/paths.ts enforces strict hex UUIDs)
const MEDIA_USER_CHILD = '01000000-0000-4000-8000-000000000001';
const MEDIA_USER_PARENT = '02000000-0000-4000-8000-000000000002';
const MEDIA_USER_CIRCLE = '03000000-0000-4000-8000-000000000003';

function createFeedFixture(options?: {
  memberships?: InMemoryDb['memberships'];
  circles?: InMemoryDb['circles'];
}) {
  const db: InMemoryDb = {
    memberships: options?.memberships ?? [
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
    circles: options?.circles ?? [
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
    entities: {},
    rawEvents: [],
  };

  const voiceByFamily: Record<string, VoiceFeedItem[]> = {
    [SYNTHETIC_FAMILY_A]: [
      {
        id: SYNTHETIC_VOICE_POST,
        direction: 'inbound',
        from_person_id: SYNTHETIC_PERSON_PARENT,
        from_display_name: 'Meena',
        to_person_id: SYNTHETIC_PERSON_CHILD,
        to_display_name: 'Riya',
        state: 'delivered',
        created_at: '2026-11-15T04:30:00.000Z',
        duration_s: 12,
        played_at: null,
        reply_to: null,
      },
    ],
  };

  const incidentsByFamily: Record<string, IncidentFeedItem[]> = {
    [SYNTHETIC_FAMILY_A]: [
      {
        id: SYNTHETIC_INCIDENT,
        subject_person_id: SYNTHETIC_PERSON_PARENT,
        subject_display_name: 'Meena',
        state: 'accepted',
        severity: 'urgent',
        responder: {
          assignment_id: SYNTHETIC_ASSIGNMENT_1,
          person_id: SYNTHETIC_PERSON_CIRCLE,
          display_name: 'Sharma uncle',
          state: 'accepted',
          offered_at: '2026-11-15T16:11:00.000Z',
          expires_at: '2026-11-15T16:14:00.000Z',
          accepted_at: '2026-11-15T16:12:30.000Z',
        },
        assignments: [
          {
            assignment_id: SYNTHETIC_ASSIGNMENT_1,
            person_id: SYNTHETIC_PERSON_CIRCLE,
            display_name: 'Sharma uncle',
            state: 'accepted',
            offered_at: '2026-11-15T16:11:00.000Z',
            expires_at: '2026-11-15T16:14:00.000Z',
            accepted_at: '2026-11-15T16:12:30.000Z',
          },
        ],
        promised_at: '2026-11-15T16:27:30.000Z',
        created_at: '2026-11-15T16:11:00.000Z',
      },
    ],
  };

  const refillsByFamily: Record<string, RefillFeedItem[]> = {
    [SYNTHETIC_FAMILY_A]: [
      {
        id: SYNTHETIC_REFILL_REQ,
        person_id: SYNTHETIC_PERSON_PARENT,
        person_display_name: 'Meena',
        medicine_id: SYNTHETIC_MEDICINE,
        medicine: 'Amlodipine 5 mg',
        amount_minor: 18400,
        currency: 'INR',
        vendor_id: SYNTHETIC_VENDOR,
        vendor: 'Gupta Medical',
        state: 'pending',
        two_person_required: false,
        who_approved: [],
        approvals: [],
        created_at: '2026-11-15T08:30:00.000Z',
        expires_at: '2026-11-15T20:30:00.000Z',
      },
    ],
  };

  const listCheckInsSpy = vi.fn<Core1FeedReadRepository['listCheckIns']>(
    async (familyId, restrictToPersonId): Promise<Omit<CheckInsFeedResponse, 'family_id'>> => {
      if (familyId !== SYNTHETIC_FAMILY_A) {
        return { next_checkin: null, items: [], missed_call_nudges: [] };
      }
      const items = [
        {
          id: SYNTHETIC_CALL,
          person_id: SYNTHETIC_PERSON_PARENT,
          person_display_name: 'Meena',
          scheduled_for: '2026-11-15T04:30:00.000Z',
          started_at: '2026-11-15T04:44:00.000Z',
          ended_at: '2026-11-15T04:48:00.000Z',
          state: 'completed' as const,
          short_summary: 'Check-in call · all well',
          ai_disclosed: true,
        },
      ].filter((c) => !restrictToPersonId || c.person_id === restrictToPersonId);

      return {
        next_checkin: {
          schedule_id: SYNTHETIC_SCHEDULE,
          person_id: SYNTHETIC_PERSON_PARENT,
          person_display_name: 'Meena',
          scheduled_for: '2026-11-16T04:30:00.000Z',
          timezone: 'Asia/Kolkata',
          enabled: true,
        },
        items,
        missed_call_nudges: [
          {
            id: SYNTHETIC_NUDGE,
            person_id: SYNTHETIC_PERSON_PARENT,
            person_display_name: 'Meena',
            kind: 'missed_call_single',
            status: 'pending' as const,
            scheduled_at: '2026-11-15T12:10:00.000Z',
          },
        ].filter((n) => !restrictToPersonId || n.person_id === restrictToPersonId),
      };
    }
  );

  const feedRepo: Core1FeedReadRepository = {
    listVoicePosts: async (familyId) => voiceByFamily[familyId] ?? [],
    listIncidents: async (familyId) => incidentsByFamily[familyId] ?? [],
    listRefills: async (familyId) => refillsByFamily[familyId] ?? [],
    listCheckIns: listCheckInsSpy,
  };

  const ports: Core1FeedPorts = {
    auth: createMockAuthPort({
      'token-child': {
        id: SYNTHETIC_USER_CHILD,
        app_metadata: {},
        user_metadata: {},
        aud: 'authenticated',
        created_at: '',
      },
      'token-parent': {
        id: SYNTHETIC_USER_PARENT,
        app_metadata: {},
        user_metadata: {},
        aud: 'authenticated',
        created_at: '',
      },
      'token-circle': {
        id: SYNTHETIC_USER_CIRCLE,
        app_metadata: {},
        user_metadata: {},
        aud: 'authenticated',
        created_at: '',
      },
    }),
    membershipRepo: createInMemoryRepository(db),
    feedRepo,
  };

  return { ports, listCheckInsSpy };
}

function makeMediaDepsFixture(options?: { consentRevoked?: boolean }): MediaDeps {
  const now = new Date('2026-11-15T05:00:00.000Z');
  return {
    auth: {
      verifyBearer: async (token) => {
        if (token === 'token-child') return { userId: MEDIA_USER_CHILD };
        if (token === 'token-parent') return { userId: MEDIA_USER_PARENT };
        if (token === 'token-circle') return { userId: MEDIA_USER_CIRCLE };
        return null;
      },
    },
    repo: {
      getMembership: async (userId, familyId) => {
        if (familyId !== SYNTHETIC_FAMILY_A) return null;
        if (userId === MEDIA_USER_CHILD) {
          return {
            familyId: SYNTHETIC_FAMILY_A,
            userId,
            personId: SYNTHETIC_PERSON_CHILD,
            role: 'child',
            revokedAt: null,
          };
        }
        if (userId === MEDIA_USER_CIRCLE) {
          return {
            familyId: SYNTHETIC_FAMILY_A,
            userId,
            personId: SYNTHETIC_PERSON_CIRCLE,
            role: 'circle',
            revokedAt: null,
          };
        }
        return null;
      },
      getVoicePost: async (postId) => {
        if (postId === SYNTHETIC_VOICE_POST) {
          return {
            id: SYNTHETIC_VOICE_POST,
            familyId: SYNTHETIC_FAMILY_A,
            senderId: SYNTHETIC_PERSON_PARENT,
            recipientId: SYNTHETIC_PERSON_CHILD,
            consentId: SYNTHETIC_CONSENT,
          };
        }
        if (postId === SYNTHETIC_VOICE_POST_B) {
          return {
            id: SYNTHETIC_VOICE_POST_B,
            familyId: SYNTHETIC_FAMILY_B,
            senderId: SYNTHETIC_PERSON_PARENT,
            recipientId: SYNTHETIC_PERSON_CHILD,
            consentId: SYNTHETIC_CONSENT,
          };
        }
        return null;
      },
      getVoiceContent: async (familyId, postId) => ({
        familyId,
        voicePostId: postId,
        objectPath: `${familyId}/voice/reply-1.m4a`,
        expiresAt: '2026-12-01T00:00:00.000Z',
      }),
      getCall: async () => null,
      getCallContent: async () => null,
      getConsent: async (familyId, consentId) => ({
        id: consentId,
        familyId,
        personId: SYNTHETIC_PERSON_PARENT,
        callId: null,
        purpose: `voice_share:${SYNTHETIC_PERSON_CHILD}`,
        answer: true,
        version: 'v1',
        createdAt: '2026-11-15T04:00:00.000Z',
      }),
      listConsentHistory: async (familyId, personId, purpose) => {
        const rows = [
          {
            id: SYNTHETIC_CONSENT,
            familyId,
            personId,
            callId: null,
            purpose,
            answer: true,
            version: 'v1',
            createdAt: '2026-11-15T04:00:00.000Z',
          },
        ];
        if (options?.consentRevoked) {
          rows.push({
            id: 'c0000000-0000-4000-8000-000000000009',
            familyId,
            personId,
            callId: null,
            purpose,
            answer: false,
            version: 'v1',
            createdAt: '2026-11-15T04:10:00.000Z',
          });
        }
        return rows;
      },
    },
    storage: {
      stat: async () => ({ size: 24000, contentType: 'audio/mp4' }),
      createSignedUrl: async (bucket, path, seconds) =>
        `https://storage.example.test/${bucket}/${path}?ttl=${seconds}`,
    },
    authorizeMedia: async () => 'allow',
    now: () => now,
  };
}

function getReq(path: string, token?: string, headers?: Record<string, string>): Request {
  const h = new Headers(headers);
  if (token) h.set('authorization', `Bearer ${token}`);
  return new Request(`http://localhost${path}`, { method: 'GET', headers: h });
}

describe('Core 1 Read Feed Routes', () => {
  describe('Auth and family scoping across all 5 endpoints', () => {
    it('rejects missing or invalid bearer tokens with 401 and WWW-Authenticate', async () => {
      const { ports } = createFeedFixture();
      const mediaDeps = makeMediaDepsFixture();

      const checks = [
        () =>
          handleCore1FeedRoute(
            getReq('/api/core1/feed/voice'),
            (p, r) => getVoiceFeed(r, p),
            ports
          ),
        () =>
          handleCore1FeedRoute(
            getReq('/api/core1/feed/incidents', 'bad-token'),
            (p, r) => getIncidentsFeed(r, p),
            ports
          ),
        () =>
          handleCore1FeedRoute(
            getReq('/api/core1/feed/refills'),
            (p, r) => getRefillsFeed(r, p),
            ports
          ),
        () =>
          handleCore1FeedRoute(
            getReq('/api/core1/feed/checkins', 'bad-token'),
            (p, r) => getCheckInsFeed(r, p),
            ports
          ),
        () =>
          handleVoiceFeedMediaGet(
            getReq(`/api/core1/feed/voice/${SYNTHETIC_VOICE_POST}/media`),
            SYNTHETIC_VOICE_POST,
            mediaDeps
          ),
      ];

      for (const run of checks) {
        const res = await run();
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
    });

    it('denies cross-family access when user requests a foreign familyId', async () => {
      const { ports } = createFeedFixture();

      for (const [path, handler] of [
        [`/api/core1/feed/voice?familyId=${SYNTHETIC_FAMILY_B}`, getVoiceFeed],
        [`/api/core1/feed/incidents?familyId=${SYNTHETIC_FAMILY_B}`, getIncidentsFeed],
        [`/api/core1/feed/refills?familyId=${SYNTHETIC_FAMILY_B}`, getRefillsFeed],
        [`/api/core1/feed/checkins?familyId=${SYNTHETIC_FAMILY_B}`, getCheckInsFeed],
      ] as ReadonlyArray<readonly [string, (r: Request, p: Core1FeedPorts) => Promise<unknown>]>) {
        const res = await handleCore1FeedRoute(
          getReq(path, 'token-child'),
          (p, r) => handler(r, p),
          ports
        );
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'family_membership_not_found' });
      }
    });

    it('rejects multi-family ambiguity unless explicit familyId is provided, and rejects conflicting headers', async () => {
      const { ports } = createFeedFixture({
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
            personId: SYNTHETIC_PERSON_CHILD,
            role: 'child',
          },
        ],
      });

      const ambiguous = await handleCore1FeedRoute(
        getReq('/api/core1/feed/checkins', 'token-child'),
        (p, r) => getCheckInsFeed(r, p),
        ports
      );
      expect(ambiguous.status).toBe(400);
      expect(await ambiguous.json()).toEqual({
        error: 'ambiguous_family_membership_family_id_required',
      });

      const conflict = await handleCore1FeedRoute(
        getReq(`/api/core1/feed/checkins?familyId=${SYNTHETIC_FAMILY_A}`, 'token-child', {
          'x-sahaj-family-id': SYNTHETIC_FAMILY_B,
        }),
        (p, r) => getCheckInsFeed(r, p),
        ports
      );
      expect(conflict.status).toBe(400);
      expect(await conflict.json()).toEqual({ error: 'conflicting_family_id' });

      const explicit = await handleCore1FeedRoute(
        getReq(`/api/core1/feed/checkins?familyId=${SYNTHETIC_FAMILY_A}`, 'token-child'),
        (p, r) => getCheckInsFeed(r, p),
        ports
      );
      expect(explicit.status).toBe(200);
    });
  });

  describe('Role restrictions and fail-closed circle checks', () => {
    it('denies circle role on voice, refills, checkins, and voice media', async () => {
      const { ports } = createFeedFixture();
      const mediaDeps = makeMediaDepsFixture();

      for (const [path, handler] of [
        ['/api/core1/feed/voice', getVoiceFeed],
        ['/api/core1/feed/refills', getRefillsFeed],
        ['/api/core1/feed/checkins', getCheckInsFeed],
      ] as ReadonlyArray<readonly [string, (r: Request, p: Core1FeedPorts) => Promise<unknown>]>) {
        const res = await handleCore1FeedRoute(
          getReq(path, 'token-circle'),
          (p, r) => handler(r, p),
          ports
        );
        expect(res.status).toBe(403);
      }

      const mediaRes = await handleVoiceFeedMediaGet(
        getReq(`/api/core1/feed/voice/${SYNTHETIC_VOICE_POST}/media`, 'token-circle'),
        SYNTHETIC_VOICE_POST,
        mediaDeps
      );
      expect(mediaRes.status).toBe(403);
    });

    it('allows active consented circle member on incidents and fails closed when revoked', async () => {
      const activeFixture = createFeedFixture();
      const okRes = await handleCore1FeedRoute(
        getReq('/api/core1/feed/incidents', 'token-circle'),
        (p, r) => getIncidentsFeed(r, p),
        activeFixture.ports
      );
      expect(okRes.status).toBe(200);

      const revokedFixture = createFeedFixture({
        circles: [
          {
            familyId: SYNTHETIC_FAMILY_A,
            personId: SYNTHETIC_PERSON_CIRCLE,
            rank: 1,
            active: true,
            approvedAt: '2026-11-01T00:00:00.000Z',
            consentAt: '2026-11-01T00:00:00.000Z',
            revokedAt: '2026-11-10T00:00:00.000Z',
          },
        ],
      });
      const deniedRes = await handleCore1FeedRoute(
        getReq('/api/core1/feed/incidents', 'token-circle'),
        (p, r) => getIncidentsFeed(r, p),
        revokedFixture.ports
      );
      expect(deniedRes.status).toBe(403);
      expect(await deniedRes.json()).toEqual({ error: 'circle_member_revoked' });
    });

    it('scopes parent checkins to caller personId', async () => {
      const { ports, listCheckInsSpy } = createFeedFixture();
      const res = await handleCore1FeedRoute(
        getReq('/api/core1/feed/checkins', 'token-parent'),
        (p, r) => getCheckInsFeed(r, p),
        ports
      );
      expect(res.status).toBe(200);
      expect(listCheckInsSpy).toHaveBeenCalledWith(
        SYNTHETIC_FAMILY_A,
        SYNTHETIC_PERSON_PARENT,
        20
      );
    });
  });

  describe('Response shapes and voice media signing', () => {
    it('returns frozen JSON shapes for voice, incidents, refills, and checkins without PII', async () => {
      const { ports } = createFeedFixture();

      const voiceRes = await handleCore1FeedRoute(
        getReq('/api/core1/feed/voice', 'token-child'),
        (p, r) => getVoiceFeed(r, p),
        ports
      );
      expect(voiceRes.status).toBe(200);
      const voiceJson = await voiceRes.json();
      expect(voiceJson).toEqual({
        family_id: SYNTHETIC_FAMILY_A,
        caller_person_id: SYNTHETIC_PERSON_CHILD,
        items: [
          {
            id: SYNTHETIC_VOICE_POST,
            direction: 'inbound',
            from_person_id: SYNTHETIC_PERSON_PARENT,
            from_display_name: 'Meena',
            to_person_id: SYNTHETIC_PERSON_CHILD,
            to_display_name: 'Riya',
            state: 'delivered',
            created_at: '2026-11-15T04:30:00.000Z',
            duration_s: 12,
            played_at: null,
            reply_to: null,
          },
        ],
      });

      const incRes = await handleCore1FeedRoute(
        getReq('/api/core1/feed/incidents', 'token-child'),
        (p, r) => getIncidentsFeed(r, p),
        ports
      );
      expect(incRes.status).toBe(200);
      const incJson = await incRes.json();
      expect(incJson.items[0]).toMatchObject({
        id: SYNTHETIC_INCIDENT,
        subject_display_name: 'Meena',
        state: 'accepted',
        severity: 'urgent',
        responder: {
          display_name: 'Sharma uncle',
          state: 'accepted',
        },
      });

      const refillsRes = await handleCore1FeedRoute(
        getReq('/api/core1/feed/refills', 'token-child'),
        (p, r) => getRefillsFeed(r, p),
        ports
      );
      expect(refillsRes.status).toBe(200);
      const refillsJson = await refillsRes.json();
      expect(refillsJson.items[0]).toMatchObject({
        id: SYNTHETIC_REFILL_REQ,
        medicine: 'Amlodipine 5 mg',
        amount_minor: 18400,
        currency: 'INR',
        vendor: 'Gupta Medical',
        state: 'pending',
        who_approved: [],
      });

      const checkinsRes = await handleCore1FeedRoute(
        getReq('/api/core1/feed/checkins', 'token-child'),
        (p, r) => getCheckInsFeed(r, p),
        ports
      );
      expect(checkinsRes.status).toBe(200);
      const checkinsJson = await checkinsRes.json();
      expect(checkinsJson.next_checkin).toMatchObject({
        schedule_id: SYNTHETIC_SCHEDULE,
        person_display_name: 'Meena',
        timezone: 'Asia/Kolkata',
      });
      expect(checkinsJson.items[0]).toMatchObject({
        id: SYNTHETIC_CALL,
        state: 'completed',
        short_summary: 'Check-in call · all well',
      });
      expect(checkinsJson.missed_call_nudges[0]).toMatchObject({
        id: SYNTHETIC_NUDGE,
        kind: 'missed_call_single',
        status: 'pending',
      });
    });

    it('issues short-lived signed URL for consented voice media and denies cross-family or revoked consent', async () => {
      const okRes = await handleVoiceFeedMediaGet(
        getReq(`/api/core1/feed/voice/${SYNTHETIC_VOICE_POST}/media`, 'token-child'),
        SYNTHETIC_VOICE_POST,
        makeMediaDepsFixture()
      );
      expect(okRes.status).toBe(200);
      const okJson = await okRes.json();
      expect(okJson.expires_in).toBeLessThanOrEqual(60);
      expect(okJson.url).toContain('sahaj-voice');

      const crossFamilyRes = await handleVoiceFeedMediaGet(
        getReq(`/api/core1/feed/voice/${SYNTHETIC_VOICE_POST_B}/media`, 'token-child'),
        SYNTHETIC_VOICE_POST_B,
        makeMediaDepsFixture()
      );
      expect(crossFamilyRes.status).toBe(404);

      const revokedRes = await handleVoiceFeedMediaGet(
        getReq(`/api/core1/feed/voice/${SYNTHETIC_VOICE_POST}/media`, 'token-child'),
        SYNTHETIC_VOICE_POST,
        makeMediaDepsFixture({ consentRevoked: true })
      );
      expect(revokedRes.status).toBe(403);
      expect(await revokedRes.json()).toEqual({ error: 'consent_required' });
    });
  });

  describe('Supabase feed adapter family scoping & PII masking', () => {
    it('masks phone numbers and 4+ digit OTPs in summaries', () => {
      expect(sanitizeSummaryText('Call +91 98765 43210 with OTP 482910')).toBe(
        'Call <MOBILE_10> with OTP ******'
      );
    });

    it('applies family_id and participant filters on every Supabase query', async () => {
      const recordedFilters: Array<{ table: string; op: string; args: unknown[] }> = [];

      const createMockBuilder = (table: string) => {
        const rowsByTable: Record<string, unknown[]> = {
          voice_posts: [
            {
              id: SYNTHETIC_VOICE_POST,
              family_id: SYNTHETIC_FAMILY_A,
              sender_id: SYNTHETIC_PERSON_PARENT,
              recipient_id: SYNTHETIC_PERSON_CHILD,
              reply_to: null,
              state: 'heard',
              created_at: '2026-11-15T04:30:00.000Z',
            },
          ],
          people: [
            { id: SYNTHETIC_PERSON_PARENT, display_name: 'Meena' },
            { id: SYNTHETIC_PERSON_CHILD, display_name: 'Riya' },
          ],
          timeline_events: [
            {
              entity_id: SYNTHETIC_VOICE_POST,
              event_type: 'voice.heard',
              human_line: 'Heard',
              created_at: '2026-11-15T04:35:00.000Z',
            },
          ],
        };

        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (...args: unknown[]) => {
            recordedFilters.push({ table, op: 'eq', args });
            return chain;
          },
          or: (...args: unknown[]) => {
            recordedFilters.push({ table, op: 'or', args });
            return chain;
          },
          in: () => chain,
          like: () => chain,
          order: () => chain,
          limit: () => chain,
          then: (resolve: (val: { data: unknown[]; error: null }) => unknown) =>
            Promise.resolve({ data: rowsByTable[table] ?? [], error: null }).then(resolve),
        };
        return chain;
      };

      const fakeClient = {
        from: (table: string) => createMockBuilder(table),
      } as unknown as SupabaseClient;

      const repo = createSupabaseCore1FeedRepository(fakeClient);
      const voice = await repo.listVoicePosts(SYNTHETIC_FAMILY_A, SYNTHETIC_PERSON_CHILD, 10);

      expect(voice).toHaveLength(1);
      expect(voice[0]).toMatchObject({
        id: SYNTHETIC_VOICE_POST,
        direction: 'inbound',
        from_display_name: 'Meena',
        to_display_name: 'Riya',
        played_at: '2026-11-15T04:35:00.000Z',
      });
      expect(recordedFilters).toContainEqual({
        table: 'voice_posts',
        op: 'eq',
        args: ['family_id', SYNTHETIC_FAMILY_A],
      });
      expect(recordedFilters).toContainEqual({
        table: 'voice_posts',
        op: 'or',
        args: [`sender_id.eq.${SYNTHETIC_PERSON_CHILD},recipient_id.eq.${SYNTHETIC_PERSON_CHILD}`],
      });
    });
  });
});
