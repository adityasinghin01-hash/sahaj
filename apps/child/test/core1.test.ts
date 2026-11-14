import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
}));
vi.mock('expo-secure-store', () => ({
  isAvailableAsync: async () => false,
}));

import { ApiError } from '../lib/api';
import {
  CORE1_STRINGS,
  createCore1Api,
  getCore1Lang,
  setCore1Lang,
} from '../lib/core1';

const SESSION = {
  url: 'https://sahaj.example.test',
  token: 'header.payload.signature',
};

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const PERSON_PARENT = 'c2000000-0000-4000-8000-000000000002';
const PERSON_CHILD = 'c1000000-0000-4000-8000-000000000001';
const MEDICINE_ID = 'a0000000-0000-4000-8000-000000000001';
const VENDOR_ID = 'b0000000-0000-4000-8000-000000000001';
const CONSENT_ID = 'c0000000-0000-4000-8000-000000000001';

describe('apps/child Core 1 client module (lib/core1.ts)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    setCore1Lang('en');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('defaults to English strings and supports switching to Hindi', () => {
    expect(getCore1Lang()).toBe('en');
    expect(CORE1_STRINGS.en.missedCallTitle).toContain('missed call');
    setCore1Lang('hi');
    expect(getCore1Lang()).toBe('hi');
    expect(CORE1_STRINGS.hi.missedCallTitle).toContain('मिस्ड कॉल');
  });

  it('fetches and validates all 5 Core 1 feed routes with Bearer auth and familyId', async () => {
    const api = createCore1Api(SESSION, FAMILY_ID);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          family_id: FAMILY_ID,
          caller_person_id: PERSON_CHILD,
          items: [
            {
              id: 'v1',
              direction: 'inbound',
              from_person_id: PERSON_PARENT,
              from_display_name: 'Meena',
              to_person_id: PERSON_CHILD,
              to_display_name: 'Riya',
              state: 'delivered',
              created_at: '2026-11-15T04:30:00.000Z',
              duration_s: 12,
              played_at: null,
              reply_to: null,
            },
          ],
        }),
        { status: 200 }
      )
    );
    const voice = await api.voiceFeed();
    expect(voice.items[0].from_display_name).toBe('Meena');
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://sahaj.example.test/api/core1/feed/voice?familyId=${FAMILY_ID}`
    );
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${SESSION.token}`,
      'x-sahaj-family-id': FAMILY_ID,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          url: 'https://storage.example.test/signed',
          expires_in: 60,
        }),
        { status: 200 }
      )
    );
    const media = await api.voiceMediaUrl('v1');
    expect(media.expires_in).toBe(60);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          family_id: FAMILY_ID,
          items: [
            {
              id: 'inc1',
              subject_person_id: PERSON_PARENT,
              subject_display_name: 'Meena',
              state: 'accepted',
              severity: 'urgent',
              responder: {
                assignment_id: 'a1',
                person_id: 'c3',
                display_name: 'Sharma uncle',
                state: 'accepted',
                offered_at: '2026-11-15T16:11:00.000Z',
                expires_at: '2026-11-15T16:14:00.000Z',
                accepted_at: '2026-11-15T16:12:00.000Z',
              },
              assignments: [],
              promised_at: null,
              created_at: '2026-11-15T16:11:00.000Z',
            },
          ],
        }),
        { status: 200 }
      )
    );
    const incidents = await api.incidentsFeed();
    expect(incidents.items[0].responder?.display_name).toBe('Sharma uncle');

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          family_id: FAMILY_ID,
          items: [
            {
              id: 'ref1',
              person_id: PERSON_PARENT,
              person_display_name: 'Meena',
              medicine_id: MEDICINE_ID,
              medicine: 'Amlodipine 5 mg',
              amount_minor: 18400,
              currency: 'INR',
              vendor_id: VENDOR_ID,
              vendor: 'Gupta Medical',
              state: 'pending',
              two_person_required: false,
              who_approved: [],
              approvals: [],
              created_at: '2026-11-15T08:30:00.000Z',
              expires_at: '2026-11-15T20:30:00.000Z',
            },
          ],
        }),
        { status: 200 }
      )
    );
    const refills = await api.refillsFeed();
    expect(refills.items[0].amount_minor).toBe(18400);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          family_id: FAMILY_ID,
          next_checkin: null,
          items: [],
          missed_call_nudges: [
            {
              id: 'n1',
              person_id: PERSON_PARENT,
              person_display_name: 'Meena',
              kind: 'missed_call_single',
              status: 'pending',
              scheduled_at: '2026-11-15T12:10:00.000Z',
            },
          ],
        }),
        { status: 200 }
      )
    );
    const checkins = await api.checkInsFeed();
    expect(checkins.missed_call_nudges).toHaveLength(1);
  });

  it('sends strict command payloads for family-report, voice-message, and refill approve/decline', async () => {
    const api = createCore1Api(SESSION);
    const accepted = () =>
      new Response(
        JSON.stringify({
          eventId: 'evt-1',
          commandType: 'refill_proposal',
          status: 'queued',
          deduped: false,
        }),
        { status: 202 }
      );

    fetchMock.mockResolvedValueOnce(accepted());
    await api.requestFamilyReport(
      { periodStart: '2026-11-08T00:00:00.000Z', periodEnd: '2026-11-15T00:00:00.000Z' },
      'idemp-report'
    );
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      periodStart: '2026-11-08T00:00:00.000Z',
      periodEnd: '2026-11-15T00:00:00.000Z',
    });

    fetchMock.mockResolvedValueOnce(accepted());
    await api.sendVoiceMessage(
      {
        recipientPersonId: PERSON_PARENT,
        mediaObjectPath: `${FAMILY_ID}/voice/clip.m4a`,
        consentId: CONSENT_ID,
      },
      'idemp-voice'
    );
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      recipientPersonId: PERSON_PARENT,
      mediaObjectPath: `${FAMILY_ID}/voice/clip.m4a`,
      consentId: CONSENT_ID,
    });

    fetchMock.mockResolvedValueOnce(accepted());
    await api.respondToRefill({
      medicineId: MEDICINE_ID,
      personId: PERSON_PARENT,
      vendorId: VENDOR_ID,
      decision: 'approve',
    });
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toEqual({
      medicineId: MEDICINE_ID,
      personId: PERSON_PARENT,
      vendorId: VENDOR_ID,
      reorderPacks: 1,
    });

    fetchMock.mockResolvedValueOnce(accepted());
    await api.respondToRefill({
      medicineId: MEDICINE_ID,
      personId: PERSON_PARENT,
      vendorId: VENDOR_ID,
      decision: 'decline',
    });
    expect(JSON.parse((fetchMock.mock.calls[3][1] as RequestInit).body as string)).toEqual({
      medicineId: MEDICINE_ID,
      personId: PERSON_PARENT,
      vendorId: VENDOR_ID,
    });
  });

  it('uploads voice clips, marks replies played, and sends Core 2 im_safe with voice_post_id', async () => {
    const api = createCore1Api(SESSION, FAMILY_ID);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          media_id: 'm1',
          media_object_path: `${FAMILY_ID}/voice/clip-1.m4a`,
          consent_id: CONSENT_ID,
          content_type: 'audio/mp4',
          size_bytes: 512,
          duration_s: 4,
        }),
        { status: 201 }
      )
    );
    const uploaded = await api.uploadVoiceMessage({
      recipientPersonId: PERSON_PARENT,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' }),
      contentType: 'audio/mp4',
      filename: 'clip.m4a',
      durationS: 4,
      consentGranted: true,
    });
    expect(uploaded.media_object_path).toBe(`${FAMILY_ID}/voice/clip-1.m4a`);
    expect(fetchMock.mock.calls[0][0]).toBe(`${SESSION.url}/api/core1/voice-messages/upload`);
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBeInstanceOf(FormData);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          id: 'v2',
          state: 'heard',
          played_at: '2026-11-15T16:15:00.000Z',
        }),
        { status: 200 }
      )
    );
    const played = await api.markVoicePlayed('v2');
    expect(played.state).toBe('heard');
    expect(fetchMock.mock.calls[1][0]).toBe(`${SESSION.url}/api/core1/voice-messages/v2/played`);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          reassurance: {
            id: 'r1',
            kind: 'im_safe',
            voice_post_id: 'vp-safe-1',
            delivery_status: 'queued',
          },
          updates: [],
        }),
        { status: 202 }
      )
    );
    const safeRes = await api.sendCore2Reassurance({
      kind: 'im_safe',
      voicePostId: 'vp-safe-1',
      recipientPersonIds: [PERSON_PARENT],
    });
    expect(safeRes.reassurance?.id).toBe('r1');
    expect(fetchMock.mock.calls[2][0]).toBe(`${SESSION.url}/api/core2/reassurance`);
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toEqual({
      kind: 'im_safe',
      voice_post_id: 'vp-safe-1',
      recipient_person_ids: [PERSON_PARENT],
    });
  });

  it('throws ApiError on server failures instead of silent fake success', async () => {
    const api = createCore1Api(SESSION);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'consent_required' }), { status: 403 })
    );

    await expect(api.voiceMediaUrl('v1')).rejects.toMatchObject({
      status: 403,
      message: 'consent_required',
    });
  });
});
