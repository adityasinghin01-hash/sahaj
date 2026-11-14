import { describe, expect, it } from 'vitest';
import { encryptWebhook, identityHash } from '../../src/lib/webhook-security';
import { contactAad } from '../../src/lib/provider-dispatch/contacts';
import {
  VOICE_NOTE_FALLBACK_LINE,
  buildSarvamAgentVariables,
  callProvider,
  createSarvamCallRuntime,
  createSarvamContactResolver,
  sarvamAgentAliases,
  sarvamBridgeLabel,
  sarvamCallHeard,
  sarvamContactAccount,
  voiceNoteLine,
  withSarvamAgentTransport,
} from '../../src/lib/core1/sarvam-calls';
import { recordSarvamVoiceHeard, type SarvamHeardPort } from '../../src/lib/core1/sarvam-heard';

const FAM = '11111111-1111-4111-8111-111111111111';
const MAA = '22222222-2222-4222-8222-222222222221';
const ROW = '33333333-3333-4333-8333-333333333333';
const CALL = '44444444-4444-4444-8444-444444444444';
const POST = '55555555-5555-4555-8555-555555555555';
const KEY = '19'.repeat(32);
const SECRET = 's'.repeat(40);
const PHONE = '+919000000001';

describe('CALL_PROVIDER switch', () => {
  it('defaults to sarvam; only an explicit twilio keeps Twilio', () => {
    expect(callProvider({})).toBe('sarvam');
    expect(callProvider({ CALL_PROVIDER: 'sarvam' })).toBe('sarvam');
    expect(callProvider({ CALL_PROVIDER: ' Twilio ' })).toBe('twilio');
    expect(callProvider({ CALL_PROVIDER: 'other' })).toBe('sarvam');
  });
  it('contact account, agent aliases and bridge label follow the documented env names', () => {
    expect(sarvamContactAccount({ SARVAM_AGENT_ID_CHECKIN: 'agent-checkin' })).toBe('agent-checkin');
    expect(sarvamContactAccount({ SARVAM_APP_ID: 'app-1', SARVAM_AGENT_ID_CHECKIN: 'agent-checkin' })).toBe('app-1');
    expect(sarvamAgentAliases({ SARVAM_AGENT_ID_RESPONDER: 'r1', SARVAM_AGENT_ID_CALLBACK: 'c1' })).toEqual(['r1', 'c1']);
    expect(sarvamBridgeLabel({ SARVAM_BRIDGE_TO: 'riya-transfer' })).toBe('riya-transfer');
    expect(sarvamBridgeLabel({ SARVAM_BRIDGE_TO: '+919000000002' })).toBe('');
  });
  it('a runtime is not built with outbound switched off or keys missing (lab providers off)', () => {
    const env = {
      SARVAM_API_KEY: 'k', SARVAM_ORG_ID: 'o', SARVAM_WORKSPACE_ID: 'w', SARVAM_AGENT_ID_CHECKIN: 'chk', SARVAM_AGENT_ID_RESPONDER: 'resp',
      SARVAM_CONNECTION_ID: 'conn', SARVAM_AGENT_NUMBER: '+918000000000', SARVAM_OUTBOUND_WEBHOOK_URL: 'https://x.example/api/sarvam/post-call/s',
      IDENTITY_HASH_SECRET: SECRET, WEBHOOK_ENCRYPTION_KEY: KEY,
    };
    const db = { from: () => ({}), rpc: async () => ({ data: null, error: null }) };
    const rt = createSarvamCallRuntime(db as never, env, 'RESPONDER');
    expect(rt?.agentId).toBe('resp');
    expect(rt?.deps.providers.sarvam?.appId).toBe('chk'); // ledger/contact account stays the registered account
    expect(createSarvamCallRuntime(db as never, { ...env, SARVAM_OUTBOUND_ENABLED: '0' }, 'RESPONDER')).toBeNull();
    expect(createSarvamCallRuntime(db as never, { ...env, SARVAM_API_KEY: undefined }, 'RESPONDER')).toBeNull();
  });
});

describe('agent variables and transport', () => {
  it('keeps UUID ids, drops non-UUID ids and masks digit runs in text', () => {
    const v = buildSarvamAgentVariables({
      purpose: 'urgent_help', responder_name: 'Rohit 9876543210', incident_id: ROW, assignment_id: 'not-a-uuid', bridge_to: '', missing: undefined,
    });
    expect(v).toEqual({ purpose: 'urgent_help', responder_name: 'Rohit <redacted>', incident_id: ROW, bridge_to: '' });
  });
  it('swaps app_id to the role agent and merges variables only on the Sarvam outbounds POST', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const base = async (url: string, init?: RequestInit) => { seen.push({ url, body: String(init?.body ?? '') }); return new Response('{}'); };
    const t = withSarvamAgentTransport(base, { agentId: 'agent-responder', variables: { purpose: 'urgent_help', call_id: CALL } });
    await t('https://apps.sarvam.ai/api/outbounds/v1/orgs/o/workspaces/w/outbounds', { method: 'POST', body: JSON.stringify({ app_config: { app_id: 'chk', agent_variables: { a: '1' } } }) });
    await t('https://example.test/other', { method: 'POST', body: '{"app_config":{"app_id":"chk"}}' });
    expect(JSON.parse(seen[0].body).app_config).toEqual({ app_id: 'agent-responder', agent_variables: { a: '1', purpose: 'urgent_help', call_id: CALL } });
    expect(seen[1].body).toBe('{"app_config":{"app_id":"chk"}}');
  });
  it('voice-note line: masked AI transcript said to be AI-read, else the fixed fallback', () => {
    expect(voiceNoteLine('Riya', null)).toBe(VOICE_NOTE_FALLBACK_LINE);
    const line = voiceNoteLine('Riya', 'Maa OTP 123456 mat batana');
    expect(line.startsWith('Riya ka sandesh: ')).toBe(true);
    expect(line).toContain('AI ka likha transcript');
    expect(line).not.toMatch(/\d{4,}/);
  });
});

describe('Sarvam contact resolver', () => {
  function db(row: Record<string, unknown>) {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is']) chain[m] = () => chain;
    chain.limit = async () => ({ data: [row], error: null });
    return { from: () => chain, rpc: async () => ({ data: null, error: null }) };
  }
  const hash = identityHash('sarvam', 'chk', PHONE.slice(1), SECRET);
  const base = { id: ROW, family_id: FAM, person_id: MAA, source: 'sarvam', account_id: 'chk', external_id_hash: hash, binding_kind: 'contact', enabled: true, revoked_at: null };
  it('opens the Shield-writer envelope used by the lab phone loader', async () => {
    const ct = encryptWebhook(Buffer.from(PHONE), KEY, JSON.stringify(['contact', FAM, MAA, 'sarvam', 'chk', hash]));
    const r = createSarvamContactResolver(db({ ...base, contact_ciphertext: ct }) as never, { account: 'chk', identitySecret: SECRET, webhookKeyHex: KEY });
    expect(await r.resolveIdentity(FAM, MAA, 'sarvam')).toEqual({ e164: PHONE, identityId: ROW, accountId: 'chk', identityHash: hash });
  });
  it('opens the Phase 2 envelope and refuses a ciphertext moved to another person', async () => {
    const ct = encryptWebhook(Buffer.from(PHONE), KEY, contactAad(FAM, MAA, 'sarvam', 'chk', hash));
    const ok = createSarvamContactResolver(db({ ...base, contact_ciphertext: ct }) as never, { account: 'chk', identitySecret: SECRET, contactKeyHex: KEY });
    expect((await ok.resolveIdentity(FAM, MAA, 'sarvam'))?.e164).toBe(PHONE);
    const moved = createSarvamContactResolver(db({ ...base, person_id: ROW, contact_ciphertext: ct }) as never, { account: 'chk', identitySecret: SECRET, contactKeyHex: KEY });
    expect(await moved.resolveIdentity(FAM, ROW, 'sarvam')).toBeNull();
    expect(await ok.resolveIdentity(FAM, MAA, 'twilio')).toBeNull();
  });
});

describe('voice-note heard proof (Sarvam post-call)', () => {
  function port(over: Partial<SarvamHeardPort> = {}) {
    const marked: string[] = [];
    const lines: string[] = [];
    const p: SarvamHeardPort = {
      findCall: async (a) => (a === 'att-1' ? { callId: CALL, familyId: FAM, personId: MAA } : null),
      voicePostForCall: async () => ({ voicePostId: POST, recipientId: MAA, state: 'sent' }),
      markHeard: async (_f, id) => { marked.push(id); },
      timeline: { append: async (e) => { lines.push(e.eventType); return { written: true }; } },
      ...over,
    };
    return { p, marked, lines };
  }
  it('connected >= 10 s for THAT call marks heard', async () => {
    const { p, marked, lines } = port();
    expect(await recordSarvamVoiceHeard(p, { attemptId: 'att-1', status: 'connected', durationSeconds: 12 })).toBe('heard');
    expect(marked).toEqual([POST]);
    expect(lines).toEqual(['voice_post.heard']);
  });
  it('short, unanswered, unknown or non-voice calls are not heard', async () => {
    const { p, marked } = port();
    expect(await recordSarvamVoiceHeard(p, { attemptId: 'att-1', status: 'connected', durationSeconds: 9 })).toBe('not_heard');
    expect(await recordSarvamVoiceHeard(p, { attemptId: 'att-1', status: 'no_answer', durationSeconds: 30 })).toBe('not_heard');
    expect(await recordSarvamVoiceHeard(p, { attemptId: 'att-2', status: 'connected', durationSeconds: 30 })).toBe('unknown_call');
    const other = port({ voicePostForCall: async () => null });
    expect(await recordSarvamVoiceHeard(other.p, { attemptId: 'att-1', status: 'connected', durationSeconds: 30 })).toBe('not_voice_note');
    const wrongPerson = port({ voicePostForCall: async () => ({ voicePostId: POST, recipientId: ROW, state: 'sent' }) });
    expect(await recordSarvamVoiceHeard(wrongPerson.p, { attemptId: 'att-1', status: 'connected', durationSeconds: 30 })).toBe('not_voice_note');
    expect(marked).toEqual([]);
    expect(sarvamCallHeard('connected', null)).toBe(false);
  });
});
