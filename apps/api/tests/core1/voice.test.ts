import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AI_DISCLOSURE } from '@sahaj/adapters';
import type { ActionAuthorization } from '@sahaj/adapters';
import type { User } from '@supabase/supabase-js';
import type { ConsentRow } from '../../src/lib/media/contracts';
import type { DispatchStore } from '../../src/lib/provider-dispatch/types';
import { handleVoiceCommandRoute } from '../../src/lib/core1/voice-command';
import {
  handleVoiceUpload,
  VOICE_UPLOAD_MAX_BYTES,
  type VoiceUploadDeps,
} from '../../src/lib/core1/voice-upload';
import {
  formatVoicePushBody,
  notifyVoicePost,
  type ExpoPushMessage,
  type VoiceNotifyDeps,
} from '../../src/lib/core1/voice-notify';
import {
  handleTwilioVoiceGather,
  handleTwilioVoiceRecording,
  handleTwilioVoiceTwiml,
  type VoicePostMetadata,
  type VoiceTwilioDeps,
} from '../../src/lib/core1/voice-twilio';
import { handleMarkVoicePlayed } from '../../src/lib/core1/voice-played';
import {
  createInMemoryRepository,
  createMockAuthPort,
  SYNTHETIC_CONSENT,
  SYNTHETIC_ENCRYPTION_KEY_HEX,
  SYNTHETIC_FAMILY_A,
  SYNTHETIC_FAMILY_B,
  SYNTHETIC_PERSON_CHILD,
  SYNTHETIC_PERSON_PARENT,
  SYNTHETIC_USER_CHILD,
  SYNTHETIC_USER_PARENT,
  type InMemoryDb,
} from './helpers';

const ACCOUNT_SID = 'AC11111111111111111111111111111111';
const CALL_SID = 'CA22222222222222222222222222222222';
const RECORDING_SID = 'RE33333333333333333333333333333333';
const AUTH_TOKEN = 'test-twilio-auth-token';
const PUBLIC_BASE_URL = 'https://api.sahaj.test';
const MEDIA_BASE_URL = 'https://media.sahaj.test';
const VOICE_POST_ID = 'f1000000-0000-4000-8000-000000000001';
const VOICE_POST_2_ID = 'f2000000-0000-4000-8000-000000000002';

function signTwilio(publicUrl: string, params: URLSearchParams): string {
  const keys = Array.from(new Set(params.keys())).sort();
  let data = publicUrl;
  for (const k of keys) {
    const vals = params.getAll(k);
    for (const v of vals) {
      data += k + v;
    }
  }
  return createHmac('sha1', AUTH_TOKEN).update(data, 'utf8').digest('base64');
}

function makeAuthForUser(tokenToPerson: Record<string, { userId: string; familyId: string; personId: string; role: string }>) {
  return {
    verifyBearer: async (token: string) => {
      const hit = tokenToPerson[token];
      return hit ? { userId: hit.userId } : null;
    },
    listMemberships: async (userId: string, familyId?: string) => {
      return Object.values(tokenToPerson).filter(
        (m) => m.userId === userId && (!familyId || m.familyId === familyId),
      );
    },
  };
}

describe('Core 1 Two-Way Voice Upload', () => {
  const defaultTokens = {
    'child-token': {
      userId: SYNTHETIC_USER_CHILD,
      familyId: SYNTHETIC_FAMILY_A,
      personId: SYNTHETIC_PERSON_CHILD,
      role: 'child',
    },
  };

  function makeUploadHarness(initialConsents: ConsentRow[]) {
    const uploaded: Array<{ objectPath: string; contentType: string; size: number }> = [];
    const consents = [...initialConsents];

    const deps: VoiceUploadDeps = {
      auth: makeAuthForUser(defaultTokens),
      newId: () => '99999999-9999-4999-8999-999999999999',
      now: () => new Date('2026-11-15T10:00:00.000Z'),
      repo: {
        personExistsInFamily: async (familyId, personId) =>
          familyId === SYNTHETIC_FAMILY_A && personId === SYNTHETIC_PERSON_PARENT,
        listConsents: async (familyId, personId) =>
          consents.filter((c) => c.familyId === familyId && c.personId === personId),
        grantConsent: async (input) => {
          const created: ConsentRow = {
            id: 'c9999999-9999-4999-8999-999999999999',
            familyId: input.familyId,
            personId: input.personId,
            callId: null,
            purpose: input.purpose,
            answer: true,
            version: input.version,
            createdAt: '2026-11-15T10:00:00.000Z',
          };
          consents.unshift(created);
          return created;
        },
        uploadVoiceObject: async (objectPath, bytes, contentType) => {
          uploaded.push({ objectPath, contentType, size: bytes.byteLength });
        },
      },
    };
    return { deps, uploaded, consents };
  }

  const activeConsent: ConsentRow = {
    id: SYNTHETIC_CONSENT,
    familyId: SYNTHETIC_FAMILY_A,
    personId: SYNTHETIC_PERSON_CHILD,
    callId: null,
    purpose: `voice_share:${SYNTHETIC_PERSON_PARENT}`,
    answer: true,
    version: 'voice-v1',
    createdAt: '2026-11-15T09:00:00.000Z',
  };

  it('uploads consented m4a/aac/ogg clips privately without public URLs', async () => {
    const { deps, uploaded } = makeUploadHarness([activeConsent]);

    const form = new FormData();
    form.append('recipient_person_id', SYNTHETIC_PERSON_PARENT);
    form.append('duration_s', '14');
    form.append(
      'file',
      new File([new Uint8Array([1, 2, 3, 4])], 'riya-clip.aac', { type: 'audio/aac' }),
    );

    const req = new Request('https://api.sahaj.test/api/core1/voice-messages/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer child-token' },
      body: form,
    });

    const res = await handleVoiceUpload(req, deps);
    expect(res.status).toBe(201);
    expect(res.body.media_object_path).toBe(
      `${SYNTHETIC_FAMILY_A}/voice/99999999-9999-4999-8999-999999999999.m4a`,
    );
    expect(res.body.consent_id).toBe(SYNTHETIC_CONSENT);
    expect(res.body.content_type).toBe('audio/mp4');
    expect((res.body as unknown as Record<string, unknown>).url).toBeUndefined();
    expect((res.body as unknown as Record<string, unknown>).publicUrl).toBeUndefined();
    expect(uploaded).toEqual([
      {
        objectPath: `${SYNTHETIC_FAMILY_A}/voice/99999999-9999-4999-8999-999999999999.m4a`,
        contentType: 'audio/mp4',
        size: 4,
      },
    ]);
  });

  it('supports ogg with codecs param and explicit consent_granted opt-in', async () => {
    const { deps, uploaded, consents } = makeUploadHarness([]);

    const req = new Request('https://api.sahaj.test/api/core1/voice-messages/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer child-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient_person_id: SYNTHETIC_PERSON_PARENT,
        audio_base64: Buffer.from('ogg-bytes').toString('base64'),
        content_type: 'audio/ogg;codecs=opus',
        filename: 'riya.ogg',
        duration_s: 8,
        consent_granted: true,
      }),
    });

    const res = await handleVoiceUpload(req, deps);
    expect(res.status).toBe(201);
    expect(res.body.media_object_path).toBe(
      `${SYNTHETIC_FAMILY_A}/voice/99999999-9999-4999-8999-999999999999.ogg`,
    );
    expect(res.body.content_type).toBe('audio/ogg');
    expect(consents).toHaveLength(1);
    expect(uploaded[0]?.objectPath).toMatch(/\.ogg$/);
  });

  it('fails closed when voice_share consent is missing or revoked', async () => {
    const revokedConsent: ConsentRow = {
      ...activeConsent,
      id: 'c0000000-0000-4000-8000-000000000099',
      answer: false,
      createdAt: '2026-11-15T09:30:00.000Z',
    };
    const { deps, uploaded } = makeUploadHarness([revokedConsent, activeConsent]);

    const req = new Request('https://api.sahaj.test/api/core1/voice-messages/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer child-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient_person_id: SYNTHETIC_PERSON_PARENT,
        audio_base64: Buffer.from('audio-bytes').toString('base64'),
        content_type: 'audio/mp4',
        duration_s: 5,
      }),
    });

    await expect(handleVoiceUpload(req, deps)).rejects.toMatchObject({
      code: 'consent_required',
      status: 403,
    });
    expect(uploaded).toHaveLength(0);
  });

  it('rejects oversized (>5 MB), >60s, wrong MIME, and cross-family recipients', async () => {
    const { deps } = makeUploadHarness([activeConsent]);

    const bigBytes = new Uint8Array(VOICE_UPLOAD_MAX_BYTES + 1);
    await expect(
      handleVoiceUpload(
        new Request('https://api.sahaj.test/api/core1/voice-messages/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer child-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient_person_id: SYNTHETIC_PERSON_PARENT,
            audio_base64: Buffer.from(bigBytes).toString('base64'),
            content_type: 'audio/mp4',
            duration_s: 10,
          }),
        }),
        deps,
      ),
    ).rejects.toMatchObject({ code: 'payload_too_large', status: 413 });

    await expect(
      handleVoiceUpload(
        new Request('https://api.sahaj.test/api/core1/voice-messages/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer child-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient_person_id: SYNTHETIC_PERSON_PARENT,
            audio_base64: Buffer.from('123').toString('base64'),
            content_type: 'audio/mp4',
            duration_s: 61,
          }),
        }),
        deps,
      ),
    ).rejects.toMatchObject({ code: 'audio_too_long', status: 400 });

    await expect(
      handleVoiceUpload(
        new Request('https://api.sahaj.test/api/core1/voice-messages/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer child-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient_person_id: SYNTHETIC_PERSON_PARENT,
            audio_base64: Buffer.from('123').toString('base64'),
            content_type: 'video/mp4',
            duration_s: 10,
          }),
        }),
        deps,
      ),
    ).rejects.toMatchObject({ code: 'unsupported_media_type', status: 415 });

    await expect(
      handleVoiceUpload(
        new Request('https://api.sahaj.test/api/core1/voice-messages/upload', {
          method: 'POST',
          headers: { Authorization: 'Bearer child-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient_person_id: SYNTHETIC_FAMILY_B,
            audio_base64: Buffer.from('123').toString('base64'),
            content_type: 'audio/mp4',
            duration_s: 10,
          }),
        }),
        deps,
      ),
    ).rejects.toMatchObject({ code: 'recipient_not_in_family', status: 403 });
  });
});

describe('Core 1 Two-Way Voice Notify (Smartphone Push vs Keypad Twilio)', () => {
  it('pushes "Riya ka sandesh aaya hai" for smartphone recipients', async () => {
    const outboxStatuses: Array<{ id: string; status: string }> = [];
    const pushes: ExpoPushMessage[] = [];
    const timelineEvents: string[] = [];

    const deps: VoiceNotifyDeps = {
      encryptionKeyHex: SYNTHETIC_ENCRYPTION_KEY_HEX,
      newId: () => '11111111-1111-4111-8111-000000000001',
      repo: {
        getPerson: async (_f, id) =>
          id === SYNTHETIC_PERSON_PARENT
            ? {
                id: SYNTHETIC_PERSON_PARENT,
                familyId: SYNTHETIC_FAMILY_A,
                displayName: 'Meena (Maa)',
                device: 'smartphone',
                language: 'Hindi',
              }
            : {
                id: SYNTHETIC_PERSON_CHILD,
                familyId: SYNTHETIC_FAMILY_A,
                displayName: 'Riya',
                device: 'smartphone',
                language: 'English',
              },
        enqueueAuthorized: async () => ({ id: '11111111-1111-4111-8111-000000000001', duplicate: false }),
        claim: async () => ({ lease: '11111111-1111-4111-8111-000000000001', attempt: 1, callId: null, personId: SYNTHETIC_PERSON_PARENT }),
        claimPush: async () => ['ExponentPushToken[maa-phone-1]'],
        updateOutboxStatus: async (id, _lease, status) => {
          outboxStatuses.push({ id, status });
        },
      },
      sendPush: async (msgs) => {
        pushes.push(...msgs);
        return { sent: msgs.length, failed: 0 };
      },
      timeline: {
        append: async (ev) => {
          timelineEvents.push(ev.eventType);
          return { written: true };
        },
      },
    };

    const result = await notifyVoicePost(deps, {
      familyId: SYNTHETIC_FAMILY_A,
      voicePostId: VOICE_POST_ID,
      senderId: SYNTHETIC_PERSON_CHILD,
      recipientId: SYNTHETIC_PERSON_PARENT,
    });

    expect(result).toEqual({
      channel: 'smartphone_push',
      outboxId: '11111111-1111-4111-8111-000000000001',
      dispatched: true,
      pushCount: 1,
    });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.body).toBe('Riya ka sandesh aaya hai');
    expect(formatVoicePushBody('Meena', true)).toBe('Meena ka jawab aaya hai');
    expect(outboxStatuses.at(-1)?.status).toBe('completed');
    expect(timelineEvents).toContain('voice_post.notified');
  });

  it('dispatches Phase 2 Twilio call pointing to consented TwiML for keypad recipients', async () => {
    const twilioRequests: Array<{ url: string; body: string }> = [];
    const boundCalls: string[] = [];

    const store: DispatchStore = {
      claimOutbox: async () => [],
      getBinding: async () => null,
      bindOutbox: async (input) => {
        boundCalls.push(`${input.provider}:${input.action}:${input.callId}`);
        return true;
      },
      finishOutbox: async () => true,
      claim: async () => 'claimed',
      complete: async () => {},
      bindIdentity: async () => true,
      fail: async () => true,
      unknown: async () => true,
      sweepStale: async () => 0,
      reconcile: async () => true,
      recordDeliveryProof: async () => null,
      reconcileOutbox: async () => true,
      acceptAssignment: async () => true,
    };

    const deps: VoiceNotifyDeps = {
      encryptionKeyHex: SYNTHETIC_ENCRYPTION_KEY_HEX,
      keypadBaseUrl: PUBLIC_BASE_URL,
      newId: () => '22222222-2222-4222-8222-000000000002',
      repo: {
        getPerson: async (_f, id) =>
          id === SYNTHETIC_PERSON_PARENT
            ? {
                id: SYNTHETIC_PERSON_PARENT,
                familyId: SYNTHETIC_FAMILY_A,
                displayName: 'Meena (Maa)',
                device: 'keypad',
                language: 'Hindi',
              }
            : {
                id: SYNTHETIC_PERSON_CHILD,
                familyId: SYNTHETIC_FAMILY_A,
                displayName: 'Riya',
                device: 'smartphone',
                language: 'English',
              },
        enqueueAuthorized: async () => ({ id: '22222222-2222-4222-8222-000000000002', duplicate: false }),
        claim: async () => ({ lease: '22222222-2222-4222-8222-000000000002', attempt: 1, callId: '33333333-3333-4333-8333-000000000003', personId: SYNTHETIC_PERSON_PARENT }),
        claimPush: async () => null,
        updateOutboxStatus: async () => {},
      },
      dispatch: {
        store,
        deps: {
          identitySecret: SYNTHETIC_ENCRYPTION_KEY_HEX,
          providers: {
            twilio: {
              accountSid: ACCOUNT_SID,
              authToken: AUTH_TOKEN,
              fromNumber: '+15550000001',
              statusCallbackUrl: `${PUBLIC_BASE_URL}/api/providers/twilio/status`,
              allowedWebhookHosts: ['api.sahaj.test'],
            },
          },
          authorize: async (cmd, key): Promise<ActionAuthorization> => ({
            decision: 'allow',
            consent: true,
            personId: cmd.personId,
            action: 'twilio.create_call',
            idempotencyKey: key,
            expiresAt: Date.now() + 60_000,
          }),
          // Shaped like Phase 2's createContactResolver: the dispatcher only dispatches through resolveIdentity.
          resolveDestination: Object.assign(async () => '+919000000001', {
            resolveIdentity: async () => ({
              e164: '+919000000001',
              identityId: '44444444-4444-4444-8444-000000000004',
              accountId: ACCOUNT_SID,
              identityHash: 'a'.repeat(64),
            }),
          }),
          transport: async (url, init) => {
            twilioRequests.push({ url, body: String(init.body ?? '') });
            return new Response(JSON.stringify({ sid: CALL_SID }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            });
          },
        },
      },
    };

    const result = await notifyVoicePost(deps, {
      familyId: SYNTHETIC_FAMILY_A,
      voicePostId: VOICE_POST_ID,
      senderId: SYNTHETIC_PERSON_CHILD,
      recipientId: SYNTHETIC_PERSON_PARENT,
    });

    expect(result).toEqual({
      channel: 'keypad_call',
      outboxId: '22222222-2222-4222-8222-000000000002',
      dispatched: true,
      providerRef: CALL_SID,
    });
    expect(boundCalls).toEqual([]); // enqueue already bound the call atomically
    expect(twilioRequests).toHaveLength(1);
    const postedParams = new URLSearchParams(twilioRequests[0]!.body);
    expect(postedParams.get('Url')).toBe(
      `${PUBLIC_BASE_URL}/api/core1/voice-messages/twilio/twiml?postId=${VOICE_POST_ID}`,
    );
  });
});

describe('Core 1 Twilio Keypad TwiML, Gather & Reply Recording', () => {
  const sampleMeta: VoicePostMetadata = {
    id: VOICE_POST_ID,
    familyId: SYNTHETIC_FAMILY_A,
    senderId: SYNTHETIC_PERSON_CHILD,
    recipientId: SYNTHETIC_PERSON_PARENT,
    consentId: SYNTHETIC_CONSENT,
    objectPath: `${SYNTHETIC_FAMILY_A}/voice/riya-1.m4a`,
    consentGrantedAt: '2026-11-15T09:00:00.000Z',
    consentVersion: 'voice-v1',
  };

  function makeTwilioDeps() {
    const heardIds: string[] = [];
    const uploadedReplies: Array<{ objectPath: string; contentType: string; size: number }> = [];
    const createdReplies: Array<{ senderId: string; recipientId: string; replyToId: string }> = [];
    const replyPushBodies: string[] = [];

    const deps: VoiceTwilioDeps = {
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      allowedRecordingHosts: ['media.sahaj.test'],
      now: () => new Date('2026-11-15T10:00:00.000Z'),
      newId: () => VOICE_POST_2_ID,
      transport: async () =>
        new Response(new Uint8Array([82, 73, 70, 70]), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        }),
      repo: {
        getVoicePostMeta: async (id) => (id === VOICE_POST_ID ? sampleMeta : null),
        createSignedVoiceUrl: async (path, ttl) => {
          expect(ttl).toBeLessThanOrEqual(60);
          return `${MEDIA_BASE_URL}/storage/v1/object/sign/sahaj-voice/${path}?token=abc`;
        },
        markVoicePostHeard: async (_f, id) => {
          heardIds.push(id);
        },
        findCallIdByExternalSid: async () => '33333333-3333-4333-8333-000000000003',
        recordReplyConsent: async () => ({
          id: 'c8888888-8888-4888-8888-888888888888',
          grantedAt: '2026-11-15T10:01:00.000Z',
          version: 'twilio-voice-v1',
        }),
        verifyReplyConsent: async (_f, cid) => cid === 'c8888888-8888-4888-8888-888888888888',
        uploadReplyAudio: async (objectPath, bytes, contentType) => {
          uploadedReplies.push({ objectPath, contentType, size: bytes.byteLength });
        },
        createReplyVoicePost: async (input) => {
          createdReplies.push({
            senderId: input.senderId,
            recipientId: input.recipientId,
            replyToId: input.replyToId,
          });
          return { voicePostId: VOICE_POST_2_ID };
        },
      },
      notifyDeps: {
        repo: {
          getPerson: async (_f, id) =>
            id === SYNTHETIC_PERSON_CHILD
              ? {
                  id: SYNTHETIC_PERSON_CHILD,
                  familyId: SYNTHETIC_FAMILY_A,
                  displayName: 'Riya',
                  device: 'smartphone',
                  language: 'English',
                }
              : {
                  id: SYNTHETIC_PERSON_PARENT,
                  familyId: SYNTHETIC_FAMILY_A,
                  displayName: 'Meena',
                  device: 'keypad',
                  language: 'Hindi',
                },
          enqueueAuthorized: async () => ({ id: VOICE_POST_2_ID, duplicate: false }),
          claim: async () => ({ lease: VOICE_POST_2_ID, attempt: 1, callId: null, personId: SYNTHETIC_PERSON_CHILD }),
          claimPush: async () => ['ExponentPushToken[riya-phone-1]'],
          updateOutboxStatus: async () => {},
        },
        sendPush: async (msgs) => {
          replyPushBodies.push(...msgs.map((m) => m.body));
          return { sent: msgs.length, failed: 0 };
        },
      },
    };

    return { deps, heardIds, uploadedReplies, createdReplies, replyPushBodies };
  }

  it('rejects unsigned Twilio webhook requests with 401', async () => {
    const { deps } = makeTwilioDeps();
    const url = `${PUBLIC_BASE_URL}/api/core1/voice-messages/twilio/twiml?postId=${VOICE_POST_ID}`;
    await expect(
      handleTwilioVoiceTwiml(
        new Request(url, {
          method: 'POST',
          body: 'CallSid=CA22222222222222222222222222222222',
        }),
        deps,
      ),
    ).rejects.toMatchObject({ code: 'invalid_twilio_signature', status: 401 });
  });

  it('plays signed recording with AI disclosure and handles 1=replay, 2=consent->record->reply', async () => {
    const { deps, heardIds, uploadedReplies, createdReplies, replyPushBodies } = makeTwilioDeps();

    // 1. Initial TwiML play + prompt
    const twimlUrl = `${PUBLIC_BASE_URL}/api/core1/voice-messages/twilio/twiml?postId=${VOICE_POST_ID}`;
    const twimlParams = new URLSearchParams({ CallSid: CALL_SID, AccountSid: ACCOUNT_SID });
    const twimlRes = await handleTwilioVoiceTwiml(
      new Request(twimlUrl, {
        method: 'POST',
        headers: { 'x-twilio-signature': signTwilio(twimlUrl, twimlParams) },
        body: twimlParams.toString(),
      }),
      deps,
    );
    expect(twimlRes.status).toBe(200);
    expect(twimlRes.xml).toContain(AI_DISCLOSURE.Hindi);
    expect(twimlRes.xml).toContain('<Play>');
    expect(twimlRes.xml).toContain('सुनने के लिए 1 दबाएँ, जवाब देने के लिए 2 दबाएँ।');

    // 2. Gather digit 1 replays and marks heard
    const menuUrl = `${PUBLIC_BASE_URL}/api/core1/voice-messages/twilio/gather?postId=${VOICE_POST_ID}&step=menu`;
    const menu1Params = new URLSearchParams({ CallSid: CALL_SID, Digits: '1' });
    const menu1Res = await handleTwilioVoiceGather(
      new Request(menuUrl, {
        method: 'POST',
        headers: { 'x-twilio-signature': signTwilio(menuUrl, menu1Params) },
        body: menu1Params.toString(),
      }),
      deps,
    );
    expect(heardIds).toEqual([VOICE_POST_ID]);
    expect(menu1Res.xml).toContain('<Play>');

    // 3. Gather digit 2 asks recording consent first
    const menu2Params = new URLSearchParams({ CallSid: CALL_SID, Digits: '2' });
    const menu2Res = await handleTwilioVoiceGather(
      new Request(menuUrl, {
        method: 'POST',
        headers: { 'x-twilio-signature': signTwilio(menuUrl, menu2Params) },
        body: menu2Params.toString(),
      }),
      deps,
    );
    expect(menu2Res.xml).toContain('अनुमति');
    expect(menu2Res.xml).toContain('step=consent');

    // 4. Consent digit 1 returns <Record recordingStatusCallback=...>
    const consentUrl = `${PUBLIC_BASE_URL}/api/core1/voice-messages/twilio/gather?postId=${VOICE_POST_ID}&step=consent`;
    const consentParams = new URLSearchParams({ CallSid: CALL_SID, Digits: '1' });
    const consentRes = await handleTwilioVoiceGather(
      new Request(consentUrl, {
        method: 'POST',
        headers: { 'x-twilio-signature': signTwilio(consentUrl, consentParams) },
        body: consentParams.toString(),
      }),
      deps,
    );
    expect(consentRes.xml).toContain('<Record');
    expect(consentRes.xml).toContain('consentId=c8888888-8888-4888-8888-888888888888');

    // 5. Recording callback fetches WAV via adapter, saves privately, creates reply post, notifies Riya
    const recUrl = `${PUBLIC_BASE_URL}/api/core1/voice-messages/twilio/recording?postId=${VOICE_POST_ID}&consentId=c8888888-8888-4888-8888-888888888888`;
    const recParams = new URLSearchParams({
      AccountSid: ACCOUNT_SID,
      CallSid: CALL_SID,
      RecordingSid: RECORDING_SID,
      RecordingStatus: 'completed',
    });
    const recRes = await handleTwilioVoiceRecording(
      new Request(recUrl, {
        method: 'POST',
        headers: { 'x-twilio-signature': signTwilio(recUrl, recParams) },
        body: recParams.toString(),
      }),
      deps,
    );
    expect(recRes.status).toBe(200);
    expect(recRes.body).toEqual({
      ok: true,
      reply_voice_post_id: VOICE_POST_2_ID,
      reply_to: VOICE_POST_ID,
    });
    expect(uploadedReplies).toEqual([
      {
        objectPath: `${SYNTHETIC_FAMILY_A}/voice/${VOICE_POST_2_ID}.wav`,
        contentType: 'audio/wav',
        size: 4,
      },
    ]);
    expect(createdReplies).toEqual([
      {
        senderId: SYNTHETIC_PERSON_PARENT,
        recipientId: SYNTHETIC_PERSON_CHILD,
        replyToId: VOICE_POST_ID,
      },
    ]);
    expect(replyPushBodies).toEqual(['Meena ka jawab aaya hai']);
  });
});

describe('Core 1 Voice Command Orchestrator & Mark Played', () => {
  it('keeps POST /api/core1/voice-message response shape unchanged and notifies once', async () => {
    process.env.WEBHOOK_ENCRYPTION_KEY = SYNTHETIC_ENCRYPTION_KEY_HEX;

    const db: InMemoryDb = {
      memberships: [
        {
          userId: SYNTHETIC_USER_CHILD,
          familyId: SYNTHETIC_FAMILY_A,
          personId: SYNTHETIC_PERSON_CHILD,
          role: 'child',
        },
      ],
      circles: [],
      entities: {
        [`person:${SYNTHETIC_FAMILY_A}`]: new Set([SYNTHETIC_PERSON_PARENT]),
        [`consent:${SYNTHETIC_FAMILY_A}`]: new Set([SYNTHETIC_CONSENT]),
      },
      rawEvents: [],
    };
    const ports = {
      auth: createMockAuthPort({
        'child-token': { id: SYNTHETIC_USER_CHILD } as User,
      }),
      repo: createInMemoryRepository(db),
      encryptionKeyHex: SYNTHETIC_ENCRYPTION_KEY_HEX,
    };

    const createdPosts: string[] = [];
    const notifiedPosts: string[] = [];
    const finalizeDeps = {
      auth: makeAuthForUser({
        'child-token': {
          userId: SYNTHETIC_USER_CHILD,
          familyId: SYNTHETIC_FAMILY_A,
          personId: SYNTHETIC_PERSON_CHILD,
          role: 'child',
        },
      }),
      createVoicePost: async () => {
        createdPosts.push(VOICE_POST_ID);
        return { voicePostId: VOICE_POST_ID };
      },
      notify: async (input: { voicePostId: string }) => {
        notifiedPosts.push(input.voicePostId);
        return {
          channel: 'smartphone_push' as const,
          outboxId: 'out-1',
          dispatched: true,
        };
      },
    };

    const body = JSON.stringify({
      recipientPersonId: SYNTHETIC_PERSON_PARENT,
      mediaObjectPath: `${SYNTHETIC_FAMILY_A}/voice/clip-1.m4a`,
      consentId: SYNTHETIC_CONSENT,
    });

    const res1 = await handleVoiceCommandRoute(
      new Request('https://api.sahaj.test/api/core1/voice-message', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer child-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'voice-cmd-1',
        },
        body,
      }),
      ports,
      finalizeDeps,
    );
    expect(res1.status).toBe(202);
    const json1 = await res1.json();
    expect(json1).toMatchObject({
      commandType: 'voice_message',
      status: 'queued',
      deduped: false,
    });
    expect(createdPosts).toEqual([VOICE_POST_ID]);
    expect(notifiedPosts).toEqual([VOICE_POST_ID]);

    // Idempotent replay: exact 202 deduped=true, no second voice_post/notify
    const res2 = await handleVoiceCommandRoute(
      new Request('https://api.sahaj.test/api/core1/voice-message', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer child-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'voice-cmd-1',
        },
        body,
      }),
      ports,
      finalizeDeps,
    );
    expect(res2.status).toBe(202);
    expect(await res2.json()).toMatchObject({ deduped: true });
    expect(createdPosts).toHaveLength(1);
    expect(notifiedPosts).toHaveLength(1);
  });

  it('marks voice post heard only for the recipient and logs timeline event', async () => {
    const marked: string[] = [];
    const events: string[] = [];
    const deps = {
      auth: makeAuthForUser({
        'child-token': {
          userId: SYNTHETIC_USER_CHILD,
          familyId: SYNTHETIC_FAMILY_A,
          personId: SYNTHETIC_PERSON_CHILD,
          role: 'child',
        },
        'parent-token': {
          userId: SYNTHETIC_USER_PARENT,
          familyId: SYNTHETIC_FAMILY_A,
          personId: SYNTHETIC_PERSON_PARENT,
          role: 'parent',
        },
      }),
      now: () => new Date('2026-11-15T11:00:00.000Z'),
      repo: {
        getVoicePost: async () => ({
          id: VOICE_POST_2_ID,
          familyId: SYNTHETIC_FAMILY_A,
          senderId: SYNTHETIC_PERSON_PARENT,
          recipientId: SYNTHETIC_PERSON_CHILD,
          state: 'delivered',
        }),
        markHeard: async (_f: string, id: string) => {
          marked.push(id);
        },
      },
      timeline: {
        append: async (ev: { eventType: string }) => {
          events.push(ev.eventType);
          return { written: true };
        },
      },
    };

    // Sender cannot mark recipient's post played
    await expect(
      handleMarkVoicePlayed(
        new Request(`https://api.sahaj.test/api/core1/voice-messages/${VOICE_POST_2_ID}/played`, {
          method: 'POST',
          headers: { Authorization: 'Bearer parent-token' },
        }),
        VOICE_POST_2_ID,
        deps,
      ),
    ).rejects.toMatchObject({ code: 'forbidden_not_recipient', status: 403 });

    // Recipient marks played
    const res = await handleMarkVoicePlayed(
      new Request(`https://api.sahaj.test/api/core1/voice-messages/${VOICE_POST_2_ID}/played`, {
        method: 'POST',
        headers: { Authorization: 'Bearer child-token' },
      }),
      VOICE_POST_2_ID,
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      id: VOICE_POST_2_ID,
      state: 'heard',
      played_at: '2026-11-15T11:00:00.000Z',
    });
    expect(marked).toEqual([VOICE_POST_2_ID]);
    expect(events).toEqual(['voice_post.heard']);
  });
});
