import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { SHIELD_HEADERS } from '@sahaj/shared';
import type { ConsentRow, MediaBucket, VoiceContentRow } from '@/lib/media/contracts';
import {
  deriveDeviceSecret,
  sha256Hex,
  signShieldBody,
} from '../../../../../packages/shield/src/server/crypto';
import { createMemoryReplayGuard } from '../../../src/app/api/core1/maa/_lib/device-auth';
import type {
  MaaCommandIdempotencyRecord,
  MaaDeviceRecord,
  MaaIncidentAssignmentRecord,
  MaaPersonRecord,
  MaaRepo,
  MaaUrgentIncidentRecord,
  MaaVoicePostRecord,
} from '../../../src/app/api/core1/maa/_lib/repo';
import {
  handleMaaUrgentCreate,
  handleMaaUrgentStatus,
  handleMaaVoiceList,
  handleMaaVoicePlayed,
  handleMaaVoiceReply,
  type MaaServiceDeps,
} from '../../../src/app/api/core1/maa/_lib/service';

const PAIRING_SECRET = 'test-pairing-secret-32-bytes-hex-demo';
const ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const FAMILY_A = '11111111-1111-4111-8111-111111111111';
const FAMILY_B = '22222222-2222-4222-8222-222222222222';
const MAA_A = 'aaaaaaa1-1111-4111-8111-111111111111';
const RIYA_A = 'aaaaaaa2-1111-4111-8111-111111111111';
const SHARMA_A = 'aaaaaaa3-1111-4111-8111-111111111111';
const MAA_B = 'bbbbbbb1-2222-4222-8222-222222222222';
const DEVICE_MAA = 'dev-maa-001';
const DEVICE_RIYA = 'dev-riya-001';

const CONSENT_RIYA_TO_MAA = 'cccccccc-1111-4111-8111-111111111111';
const VOICE_POST_1 = 'ddddddd1-1111-4111-8111-111111111111';
const VOICE_POST_2 = 'ddddddd2-1111-4111-8111-111111111111';
const FOREIGN_VOICE_POST = 'ddddddd9-2222-4222-8222-222222222222';
const FOREIGN_INCIDENT = 'eeeeeee9-2222-4222-8222-222222222222';

interface FakeStore {
  devices: MaaDeviceRecord[];
  people: MaaPersonRecord[];
  voicePosts: MaaVoicePostRecord[];
  voiceContents: VoiceContentRow[];
  consents: ConsentRow[];
  uploads: Array<{ path: string; bytes: Uint8Array; contentType: string }>;
  rawEvents: Array<{
    id: string;
    familyId: string;
    scopedIdempotencyKey: string;
    payloadHash: string;
    payloadCiphertext: string;
    commandType: string;
    actorPersonId: string;
    entityId?: string | null;
  }>;
  incidents: MaaUrgentIncidentRecord[];
  assignments: MaaIncidentAssignmentRecord[];
  cedarDecision: 'allow' | 'deny';
}

function createFakeRepo(store: FakeStore): MaaRepo {
  return {
    storage: {
      async stat(_bucket: MediaBucket, objectPath: string) {
        const hit = store.voiceContents.find((v) => v.objectPath === objectPath);
        if (!hit) return null;
        return { size: 12000, contentType: 'audio/mp4' };
      },
      async createSignedUrl(_bucket: MediaBucket, objectPath: string, ttl: number) {
        return `https://media.sahaj.test/signed/${encodeURIComponent(objectPath)}?ttl=${ttl}`;
      },
    },

    async authorizeMedia() {
      return store.cedarDecision;
    },

    async getDevice(deviceId) {
      return store.devices.find((d) => d.deviceId === deviceId) ?? null;
    },

    async touchDeviceHeartbeat() {},

    async getPersonInFamily(familyId, personId) {
      return store.people.find((p) => p.familyId === familyId && p.id === personId) ?? null;
    },

    async listPeopleInFamily(familyId) {
      return store.people.filter((p) => p.familyId === familyId);
    },

    async listVoicePostsForRecipient(familyId, recipientId, limit) {
      return store.voicePosts
        .filter((v) => v.familyId === familyId && v.recipientId === recipientId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },

    async getVoicePostById(postId) {
      return store.voicePosts.find((v) => v.id === postId) ?? null;
    },

    async markVoicePostHeard(familyId, postId, recipientId, heardAt) {
      const post = store.voicePosts.find(
        (v) => v.familyId === familyId && v.id === postId && v.recipientId === recipientId,
      );
      if (!post) throw new Error('not_found');
      post.state = 'heard';
      post.playedAt = post.playedAt ?? heardAt;
      return { playedAt: post.playedAt };
    },

    async getVoiceContent(familyId, postId) {
      return store.voiceContents.find((v) => v.familyId === familyId && v.voicePostId === postId) ?? null;
    },

    async getConsent(familyId, consentId) {
      return store.consents.find((c) => c.familyId === familyId && c.id === consentId) ?? null;
    },

    async listConsentHistory(familyId, personId, purpose) {
      return store.consents.filter(
        (c) => c.familyId === familyId && c.personId === personId && c.purpose === purpose,
      );
    },

    async createVoiceShareConsent(familyId, personId, recipientId, version, nowIso) {
      const row: ConsentRow = {
        id: randomUUID(),
        familyId,
        personId,
        callId: null,
        purpose: `voice_share:${recipientId}`,
        answer: true,
        version,
        createdAt: nowIso,
      };
      store.consents.push(row);
      return row;
    },

    async uploadVoiceObject(objectPath, bytes, contentType) {
      store.uploads.push({ path: objectPath, bytes, contentType });
    },

    async createFamilyVoicePost(params) {
      const post: MaaVoicePostRecord = {
        id: randomUUID(),
        familyId: params.familyId,
        senderId: params.senderId,
        recipientId: params.recipientId,
        replyTo: params.replyTo,
        state: 'sent',
        consentId: params.consentId,
        createdAt: '2026-11-15T10:05:00.000Z',
        durationS: null,
        playedAt: null,
      };
      store.voicePosts.push(post);
      store.voiceContents.push({
        familyId: params.familyId,
        voicePostId: post.id,
        objectPath: params.objectPath,
        expiresAt: '2026-12-15T10:05:00.000Z',
      });
      return post;
    },

    async findCommandIdempotency(scopedIdempotencyKey): Promise<MaaCommandIdempotencyRecord | null> {
      const hit = store.rawEvents.find((e) => e.scopedIdempotencyKey === scopedIdempotencyKey);
      return hit ? { id: hit.id, payloadHash: hit.payloadHash, entityId: hit.entityId } : null;
    },

    async persistCommandEvent(params) {
      store.rawEvents.push({ ...params, id: params.eventId });
    },

    async createUrgentIncidentOffer(params) {
      const incidentId = randomUUID();
      const assignmentId = randomUUID();
      const incident: MaaUrgentIncidentRecord = {
        id: incidentId,
        familyId: params.familyId,
        subjectPersonId: params.subjectPersonId,
        state: 'offered',
        severity: params.severity,
        responderId: null,
        promisedAt: null,
        createdAt: '2026-11-15T10:00:00.000Z',
      };
      store.incidents.push(incident);
      store.assignments.push({
        id: assignmentId,
        incidentId,
        familyId: params.familyId,
        assigneePersonId: SHARMA_A,
        state: 'offered',
        offeredAt: '2026-11-15T10:00:00.000Z',
        respondedAt: null,
        promisedAt: null,
      });
      return { incidentId, assignmentId, state: 'offered' };
    },

    async getUrgentIncidentById(incidentId) {
      return store.incidents.find((i) => i.id === incidentId) ?? null;
    },

    async listIncidentAssignments(familyId, incidentId) {
      return store.assignments.filter((a) => a.familyId === familyId && a.incidentId === incidentId);
    },
  };
}

async function signedRequest(
  url: string,
  method: 'GET' | 'POST',
  body: string,
  deviceId = DEVICE_MAA,
  tsMs = Date.parse('2026-11-15T10:00:00.000Z'),
  extraHeaders: Record<string, string> = {},
): Promise<Request> {
  const secret = await deriveDeviceSecret(PAIRING_SECRET, deviceId);
  const ts = String(tsMs);
  const sig = await signShieldBody(secret, ts, body);
  return new Request(url, {
    method,
    headers: {
      [SHIELD_HEADERS.device]: deviceId,
      [SHIELD_HEADERS.ts]: ts,
      [SHIELD_HEADERS.sig]: sig,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...(method === 'POST' ? { body } : {}),
  });
}

describe('Core 1 Maa device routes', () => {
  let store: FakeStore;
  let deps: MaaServiceDeps;
  const fixedNow = new Date('2026-11-15T10:00:00.000Z');

  beforeEach(async () => {
    const maaSecret = await deriveDeviceSecret(PAIRING_SECRET, DEVICE_MAA);
    const riyaSecret = await deriveDeviceSecret(PAIRING_SECRET, DEVICE_RIYA);

    store = {
      cedarDecision: 'allow',
      devices: [
        {
          deviceId: DEVICE_MAA,
          familyId: FAMILY_A,
          personId: MAA_A,
          platform: 'android',
          revoked: false,
          deviceSecretHash: await sha256Hex(maaSecret),
        },
        {
          deviceId: DEVICE_RIYA,
          familyId: FAMILY_A,
          personId: RIYA_A,
          platform: 'android',
          revoked: false,
          deviceSecretHash: await sha256Hex(riyaSecret),
        },
      ],
      people: [
        { id: MAA_A, familyId: FAMILY_A, displayName: 'Meena', role: 'parent' },
        { id: RIYA_A, familyId: FAMILY_A, displayName: 'Riya', role: 'child' },
        { id: SHARMA_A, familyId: FAMILY_A, displayName: 'Sharma uncle', role: 'circle' },
        { id: MAA_B, familyId: FAMILY_B, displayName: 'Other Maa', role: 'parent' },
      ],
      consents: [
        {
          id: CONSENT_RIYA_TO_MAA,
          familyId: FAMILY_A,
          personId: RIYA_A,
          callId: null,
          purpose: `voice_share:${MAA_A}`,
          answer: true,
          version: 'v1',
          createdAt: '2026-11-14T10:00:00.000Z',
        },
      ],
      voicePosts: [
        {
          id: VOICE_POST_1,
          familyId: FAMILY_A,
          senderId: RIYA_A,
          recipientId: MAA_A,
          replyTo: null,
          state: 'delivered',
          consentId: CONSENT_RIYA_TO_MAA,
          createdAt: '2026-11-15T08:00:00.000Z',
          durationS: 8,
          playedAt: null,
        },
        {
          id: VOICE_POST_2,
          familyId: FAMILY_A,
          senderId: RIYA_A,
          recipientId: MAA_A,
          replyTo: null,
          state: 'sent',
          consentId: CONSENT_RIYA_TO_MAA,
          createdAt: '2026-11-15T09:30:00.000Z',
          durationS: 11,
          playedAt: null,
        },
        {
          id: FOREIGN_VOICE_POST,
          familyId: FAMILY_B,
          senderId: RIYA_A,
          recipientId: MAA_B,
          replyTo: null,
          state: 'sent',
          consentId: CONSENT_RIYA_TO_MAA,
          createdAt: '2026-11-15T09:45:00.000Z',
          durationS: 7,
          playedAt: null,
        },
      ],
      voiceContents: [
        {
          familyId: FAMILY_A,
          voicePostId: VOICE_POST_1,
          objectPath: `${FAMILY_A}/voice/${VOICE_POST_1}.m4a`,
          expiresAt: '2026-11-20T00:00:00.000Z',
        },
        {
          familyId: FAMILY_A,
          voicePostId: VOICE_POST_2,
          objectPath: `${FAMILY_A}/voice/${VOICE_POST_2}.m4a`,
          expiresAt: '2026-11-20T00:00:00.000Z',
        },
      ],
      uploads: [],
      rawEvents: [],
      incidents: [
        {
          id: FOREIGN_INCIDENT,
          familyId: FAMILY_B,
          subjectPersonId: MAA_B,
          state: 'offered',
          severity: 'urgent',
          responderId: null,
          promisedAt: null,
          createdAt: '2026-11-15T09:50:00.000Z',
        },
      ],
      assignments: [],
    };

    deps = {
      repo: createFakeRepo(store),
      pairingSecret: PAIRING_SECRET,
      encryptionKeyHex: ENCRYPTION_KEY,
      now: () => fixedNow,
      replayGuard: createMemoryReplayGuard(),
    };
  });

  it('requires paired device signatures and rejects invalid or skewed requests', async () => {
    const missing = new Request('https://api.sahaj.test/api/core1/maa/voice', { method: 'GET' });
    expect((await handleMaaVoiceList(missing, deps)).status).toBe(401);

    const reqBadSig = await signedRequest('https://api.sahaj.test/api/core1/maa/voice', 'GET', '');
    reqBadSig.headers.set(SHIELD_HEADERS.sig, '0'.repeat(64));
    expect((await handleMaaVoiceList(reqBadSig, deps)).status).toBe(401);

    const staleTs = fixedNow.getTime() - 10 * 60 * 1000;
    const reqStale = await signedRequest(
      'https://api.sahaj.test/api/core1/maa/voice',
      'GET',
      '',
      DEVICE_MAA,
      staleTs,
    );
    expect((await handleMaaVoiceList(reqStale, deps)).status).toBe(401);

    const childReq = await signedRequest(
      'https://api.sahaj.test/api/core1/maa/voice',
      'GET',
      '',
      DEVICE_RIYA,
      fixedNow.getTime(),
    );
    expect((await handleMaaVoiceList(childReq, deps)).status).toBe(403);
  });

  it('rejects replayed signed requests', async () => {
    const req1 = await signedRequest(
      'https://api.sahaj.test/api/core1/maa/voice',
      'GET',
      '',
      DEVICE_MAA,
      fixedNow.getTime(),
    );
    const req2 = req1.clone();

    expect((await handleMaaVoiceList(req1, deps)).status).toBe(200);
    const replayRes = await handleMaaVoiceList(req2, deps);
    expect(replayRes.status).toBe(401);
    expect(await replayRes.json()).toEqual({ error: 'replay_detected' });
  });

  it('denies wrong-family access across voice and urgent endpoints', async () => {
    const crossQuery = await signedRequest(
      `https://api.sahaj.test/api/core1/maa/voice?family_id=${FAMILY_B}`,
      'GET',
      '',
    );
    expect((await handleMaaVoiceList(crossQuery, deps)).status).toBe(403);

    const foreignPlayed = await signedRequest(
      `https://api.sahaj.test/api/core1/maa/voice/${FOREIGN_VOICE_POST}/played`,
      'POST',
      '{}',
      DEVICE_MAA,
      fixedNow.getTime() + 1,
    );
    expect((await handleMaaVoicePlayed(foreignPlayed, FOREIGN_VOICE_POST, deps)).status).toBe(403);

    const foreignReply = await signedRequest(
      'https://api.sahaj.test/api/core1/maa/voice/reply',
      'POST',
      JSON.stringify({
        reply_to: FOREIGN_VOICE_POST,
        audio_base64: Buffer.from('hello').toString('base64'),
        content_type: 'audio/mp4',
        consent_granted: true,
      }),
      DEVICE_MAA,
      fixedNow.getTime() + 2,
    );
    expect((await handleMaaVoiceReply(foreignReply, deps)).status).toBe(403);

    const foreignIncident = await signedRequest(
      `https://api.sahaj.test/api/core1/maa/urgent/${FOREIGN_INCIDENT}`,
      'GET',
      '',
      DEVICE_MAA,
      fixedNow.getTime() + 3,
    );
    expect((await handleMaaUrgentStatus(foreignIncident, FOREIGN_INCIDENT, deps)).status).toBe(403);
  });

  it('lists newest-first voice messages with short-lived URLs and marks played', async () => {
    const listReq = await signedRequest('https://api.sahaj.test/api/core1/maa/voice', 'GET', '');
    const listRes = await handleMaaVoiceList(listReq, deps);
    expect(listRes.status).toBe(200);
    expect(listRes.headers.get('cache-control')).toBe('no-store');
    expect(listRes.headers.get('referrer-policy')).toBe('no-referrer');
    expect(listRes.headers.get('x-content-type-options')).toBe('nosniff');

    const payload = await listRes.json();
    expect(payload.family_id).toBe(FAMILY_A);
    expect(payload.person_id).toBe(MAA_A);
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0].id).toBe(VOICE_POST_2);
    expect(payload.items[1].id).toBe(VOICE_POST_1);
    expect(payload.items[0].from_display_name).toBe('Riya');
    expect(payload.items[0].media_expires_in).toBeLessThanOrEqual(60);
    expect(payload.items[0].media_url).toContain('https://media.sahaj.test/signed/');
    expect(JSON.stringify(payload)).not.toContain('object_path');

    const playedReq = await signedRequest(
      `https://api.sahaj.test/api/core1/maa/voice/${VOICE_POST_2}/played`,
      'POST',
      '{}',
      DEVICE_MAA,
      fixedNow.getTime() + 5,
    );
    const playedRes = await handleMaaVoicePlayed(playedReq, VOICE_POST_2, deps);
    expect(playedRes.status).toBe(200);
    const playedJson = await playedRes.json();
    expect(playedJson).toEqual({
      ok: true,
      id: VOICE_POST_2,
      state: 'heard',
      played_at: fixedNow.toISOString(),
    });
  });

  it('validates consent, duration, idempotency, and uploads Maa voice reply', async () => {
    const noConsentReq = await signedRequest(
      'https://api.sahaj.test/api/core1/maa/voice/reply',
      'POST',
      JSON.stringify({
        reply_to: VOICE_POST_2,
        audio_base64: Buffer.from('audio-bytes').toString('base64'),
        content_type: 'audio/mp4',
        duration_s: 6,
      }),
      DEVICE_MAA,
      fixedNow.getTime() + 10,
    );
    expect((await handleMaaVoiceReply(noConsentReq, deps)).status).toBe(403);

    const tooLongReq = await signedRequest(
      'https://api.sahaj.test/api/core1/maa/voice/reply',
      'POST',
      JSON.stringify({
        reply_to: VOICE_POST_2,
        audio_base64: Buffer.from('audio-bytes').toString('base64'),
        content_type: 'audio/mp4',
        duration_s: 31,
        consent_granted: true,
      }),
      DEVICE_MAA,
      fixedNow.getTime() + 11,
    );
    expect((await handleMaaVoiceReply(tooLongReq, deps)).status).toBe(400);

    const replyBody = JSON.stringify({
      reply_to: VOICE_POST_2,
      audio_base64: Buffer.from('maa-voice-reply-bytes').toString('base64'),
      content_type: 'audio/m4a',
      duration_s: 5,
      consent_granted: true,
      idempotency_key: 'reply-key-1',
    });

    const okReq = await signedRequest(
      'https://api.sahaj.test/api/core1/maa/voice/reply',
      'POST',
      replyBody,
      DEVICE_MAA,
      fixedNow.getTime() + 12,
    );
    const okRes = await handleMaaVoiceReply(okReq, deps);
    expect(okRes.status).toBe(201);
    const okJson = await okRes.json();
    expect(okJson.ok).toBe(true);
    expect(okJson.sender_id).toBe(MAA_A);
    expect(okJson.recipient_id).toBe(RIYA_A);
    expect(okJson.reply_to).toBe(VOICE_POST_2);
    expect(okJson.deduped).toBe(false);
    expect(store.uploads).toHaveLength(1);
    expect(store.uploads[0].path).toMatch(new RegExp(`^${FAMILY_A}/voice/.*\\.m4a$`));
    expect(store.rawEvents).toHaveLength(1);
    expect(store.rawEvents[0].commandType).toBe('voice_message');

    // Fresh signature with identical idempotency key -> deduped 200
    const dedupReq = await signedRequest(
      'https://api.sahaj.test/api/core1/maa/voice/reply',
      'POST',
      replyBody,
      DEVICE_MAA,
      fixedNow.getTime() + 13,
    );
    const dedupRes = await handleMaaVoiceReply(dedupReq, deps);
    expect(dedupRes.status).toBe(200);
    const dedupJson = await dedupRes.json();
    expect(dedupJson.deduped).toBe(true);
    expect(dedupJson.id).toBe(okJson.id);

    // Same idempotency key with different body -> 409 conflict
    const conflictReq = await signedRequest(
      'https://api.sahaj.test/api/core1/maa/voice/reply',
      'POST',
      JSON.stringify({
        reply_to: VOICE_POST_2,
        audio_base64: Buffer.from('different-audio').toString('base64'),
        content_type: 'audio/m4a',
        duration_s: 5,
        consent_granted: true,
        idempotency_key: 'reply-key-1',
      }),
      DEVICE_MAA,
      fixedNow.getTime() + 14,
    );
    expect((await handleMaaVoiceReply(conflictReq, deps)).status).toBe(409);
  });

  it('starts urgent help chain and returns calm responder status when accepted', async () => {
    const sosReq = await signedRequest(
      'https://api.sahaj.test/api/core1/maa/urgent',
      'POST',
      JSON.stringify({ severity: 'urgent', idempotency_key: 'sos-1' }),
      DEVICE_MAA,
      fixedNow.getTime() + 20,
    );
    const sosRes = await handleMaaUrgentCreate(sosReq, deps);
    expect(sosRes.status).toBe(201);
    const created = await sosRes.json();
    expect(created.ok).toBe(true);
    expect(created.state).toBe('offered');
    expect(created.status_line_hi).toContain('मदद');

    // Simulate Sharma uncle accepting with a 4-minute promise
    const incident = store.incidents.find((i) => i.id === created.id)!;
    incident.state = 'accepted';
    incident.responderId = SHARMA_A;
    incident.promisedAt = '2026-11-15T10:04:00.000Z';
    const assignment = store.assignments.find((a) => a.incidentId === created.id)!;
    assignment.state = 'accepted';
    assignment.respondedAt = '2026-11-15T10:00:30.000Z';
    assignment.promisedAt = '2026-11-15T10:04:00.000Z';

    const pollReq = await signedRequest(
      `https://api.sahaj.test/api/core1/maa/urgent/${created.id}`,
      'GET',
      '',
      DEVICE_MAA,
      fixedNow.getTime() + 21,
    );
    const pollRes = await handleMaaUrgentStatus(pollReq, created.id, deps);
    expect(pollRes.status).toBe(200);
    const pollJson = await pollRes.json();
    expect(pollJson.state).toBe('accepted');
    expect(pollJson.responder.display_name).toBe('Sharma uncle');
    expect(pollJson.eta_minutes).toBe(4);
    expect(pollJson.status_line_hi).toBe('Sharma uncle aa rahe hain · 4 minute');
    expect(pollJson.status_line_en).toBe('Sharma uncle is coming · 4 min');
  });
});
