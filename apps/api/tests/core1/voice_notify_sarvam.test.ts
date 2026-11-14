import { describe, expect, it } from 'vitest';
import type { DispatchStore } from '../../src/lib/provider-dispatch';
import { notifyVoicePost, type VoiceNotifyDeps } from '../../src/lib/core1/voice-notify';
import { VOICE_NOTE_FALLBACK_LINE } from '../../src/lib/core1/sarvam-calls';
import { handleSarvam } from '../../src/lib/provider-ingestion/gateway';
import { dispatchCareDelivery } from '../../src/lib/core2/authorized-delivery';
import { fakeStore, outbound } from '../provider-ingestion/helpers';

const FAM = '11111111-1111-4111-8111-111111111111';
const MAA = '22222222-2222-4222-8222-222222222221';
const RIYA = '22222222-2222-4222-8222-222222222222';
const POST = '55555555-5555-4555-8555-555555555555';
const OUTBOX = '66666666-6666-4666-8666-666666666666';
const CALL = '77777777-7777-4777-8777-777777777777';

const store: DispatchStore = {
  claimOutbox: async () => [], getBinding: async () => null, bindOutbox: async () => true, claim: async () => 'claimed',
  complete: async () => {}, bindIdentity: async () => true, fail: async () => true, unknown: async () => true,
  sweepStale: async () => 0, reconcile: async () => true, recordDeliveryProof: async () => null,
  reconcileOutbox: async () => true, acceptAssignment: async () => true, finishOutbox: async () => true,
};

function deps(over: Partial<VoiceNotifyDeps> = {}) {
  const enqueued: Array<string | undefined> = [];
  const bodies: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const d: VoiceNotifyDeps = {
    repo: {
      getPerson: async (_f, id) => (id === MAA
        ? { id: MAA, familyId: FAM, displayName: 'Meena Maa', device: 'keypad', language: 'Hindi' }
        : { id: RIYA, familyId: FAM, displayName: 'Riya', device: 'smartphone', language: 'English' }),
      enqueueAuthorized: async (_input, provider) => { enqueued.push(provider); return { id: OUTBOX, duplicate: false }; },
      claim: async () => ({ lease: OUTBOX, attempt: 1, callId: CALL, personId: MAA }),
      claimPush: async () => null,
      updateOutboxStatus: async () => {},
    },
    callProvider: 'sarvam',
    sarvam: {
      provider: 'sarvam',
      agentId: 'agent-callback',
      deps: {
        store,
        authorize: async (cmd, key) => ({ decision: 'allow', consent: true, personId: cmd.personId, action: cmd.payload.action, idempotencyKey: key, expiresAt: Date.now() + 60_000 }),
        resolveDestination: Object.assign(async () => '+919000000001', {
          resolveIdentity: async () => ({ e164: '+919000000001', identityId: CALL, accountId: 'agent-checkin', identityHash: 'a'.repeat(64) }),
        }),
        identitySecret: 's'.repeat(40),
        transport: async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ attempt_id: 'att-voice-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
        providers: { sarvam: { apiKey: 'k', orgId: 'o', workspaceId: 'w', appId: 'agent-checkin', appVersion: 1, connectionId: 'c',
          agentPhoneNumber: '+918000000000', webhookUrl: 'https://api.sahaj.example/api/sarvam/post-call/s' } },
      },
    },
    ...over,
  };
  return { d, enqueued, bodies };
}

describe('keypad voice note over Sarvam (K-SARVAMCALL)', () => {
  it('places a CALLBACK-agent call with purpose voice_message and the fallback line when no transcript exists', async () => {
    const { d, enqueued, bodies } = deps();
    const r = await notifyVoicePost(d, { familyId: FAM, voicePostId: POST, senderId: RIYA, recipientId: MAA });
    expect(r).toEqual({ channel: 'keypad_call', outboxId: OUTBOX, dispatched: true, providerRef: 'att-voice-1', provider: 'sarvam' });
    expect(enqueued).toEqual(['sarvam']);
    expect(bodies[0].app_config.app_id).toBe('agent-callback');
    expect(bodies[0].app_config.agent_variables).toMatchObject({
      purpose: 'voice_message', line: VOICE_NOTE_FALLBACK_LINE, callback_line: VOICE_NOTE_FALLBACK_LINE,
      family_id: FAM, parent_id: MAA, call_id: CALL, voice_post_id: POST,
    });
  });
  it('reads a masked AI transcript and says so', async () => {
    const { d, bodies } = deps();
    await notifyVoicePost(d, { familyId: FAM, voicePostId: POST, senderId: RIYA, recipientId: MAA, transcript: 'Maa main 8 baje aaungi, code 4321' });
    const line = bodies[0].app_config.agent_variables.line as string;
    expect(line.startsWith('Riya ka sandesh: ')).toBe(true);
    expect(line).toContain('AI ka likha transcript');
    expect(line).not.toContain('4321');
  });
  it('keeps the authorized row pending when Sarvam is not configured; Twilio path untouched with CALL_PROVIDER=twilio', async () => {
    const off = deps({ sarvam: null });
    expect(await notifyVoicePost(off.d, { familyId: FAM, voicePostId: POST, senderId: RIYA, recipientId: MAA }))
      .toEqual({ channel: 'keypad_call', outboxId: OUTBOX, dispatched: false, reason: 'sarvam_not_configured', provider: 'sarvam' });
    const twilio = deps({ callProvider: 'twilio' });
    expect(await notifyVoicePost(twilio.d, { familyId: FAM, voicePostId: POST, senderId: RIYA, recipientId: MAA }))
      .toEqual({ channel: 'keypad_call', outboxId: OUTBOX, dispatched: false, reason: 'twilio_not_configured' });
    expect(twilio.enqueued).toEqual([undefined]);
  });
});

describe('Sarvam post-call from a role agent (K-SARVAMCALL)', () => {
  const cfg = { appId: 'app-1', agentDigits: '918000000000', deploymentId: 'dep-1', consentVersion: 'v1' };
  it('accepts an outbound event from a configured agent alias and looks the attempt up under the contact account', async () => {
    const s = fakeStore();
    const r = await handleSarvam(Buffer.from(JSON.stringify(outbound({ app_id: 'agent-callback' }))), { ...cfg, outboundAgentIds: ['agent-callback'] }, () => s);
    expect(r.status).toBe(200);
    expect(s.findSarvamAttempt).toHaveBeenCalledWith('app-1', 'att-1');
  });
  it('still refuses an unknown agent id', async () => {
    const s = fakeStore();
    await expect(handleSarvam(Buffer.from(JSON.stringify(outbound({ app_id: 'agent-other' }))), { ...cfg, outboundAgentIds: ['agent-callback'] }, () => s))
      .rejects.toMatchObject({ status: 403, code: 'wrong_provider_account' });
  });
});

describe('gentle news / care notice call to Maa over Sarvam (K-SARVAMCALL)', () => {
  it('reads the calm line through the CALLBACK agent with purpose gentle_news', async () => {
    const { d, bodies } = deps();
    const calm = 'Namaste Maa, main Sahaj AI sahayak Aasha Didi bol rahi hoon. Riya theek hai, thodi der mein baat karegi.';
    await dispatchCareDelivery(d, { familyId: FAM, subjectId: RIYA, recipientId: MAA, kind: 'gentle_news.maa_call', sourceId: POST,
      dedupeKey: 'gentle_news:maa_call:x', details: { statusLabel: calm, incidentId: POST } }, OUTBOX, 'sarvam');
    expect(bodies).toHaveLength(1);
    expect(bodies[0].app_config.app_id).toBe('agent-callback');
    expect(bodies[0].app_config.agent_variables).toMatchObject({ purpose: 'gentle_news', line: calm, callback_line: calm,
      callback_reason: 'gentle_news_maa_call', parent_id: MAA, call_id: CALL, incident_id: POST });
  });
  it('does nothing (row stays pending) when Sarvam is not configured', async () => {
    const { d, bodies } = deps({ sarvam: null });
    await dispatchCareDelivery(d, { familyId: FAM, subjectId: RIYA, recipientId: MAA, kind: 'gentle_news.maa_call', sourceId: POST,
      dedupeKey: 'gentle_news:maa_call:y', details: { statusLabel: 'x' } }, OUTBOX, 'sarvam');
    expect(bodies).toHaveLength(0);
  });
});
