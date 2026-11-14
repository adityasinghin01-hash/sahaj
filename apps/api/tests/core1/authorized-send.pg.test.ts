import postgres, { type Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueAuthorizedSend, claimAuthorizedSend, claimAuthorizedPush, type AuthorizedSendInput } from '@/lib/core1/authorized-send';
import { createSupabaseCore1OutboxPort } from '@/lib/core1/wiring-common';
import { notifyVoicePost, type VoiceNotifyDeps } from '@/lib/core1/voice-notify';
import { dispatchStore } from '@/lib/provider-dispatch/supabase-store';
import { createDispatchAuthorizer } from '@/lib/atlas-runtime/bridge';
import { decryptWebhook, identityHash } from '@/lib/webhook-security';
import type { RpcDb } from '@/lib/atlas-runtime/db';

// Only the dedicated disposable runner sets this variable. Never use DATABASE_URL/the lab DB.
const url = process.env.C14_TEST_DATABASE_URL;
const KEY = '17'.repeat(32), SECRET = 'synthetic-c14-identity-secret-at-least-32-chars', ACCOUNT = `AC${'a'.repeat(32)}`;
const PHONE = '+919000000001', HASH = identityHash('twilio', ACCOUNT, PHONE.slice(1), SECRET);
const CASES = [
  ['keypad voice', 'core1.voice_notify', 'keypad'],
  ['smartphone voice', 'core1.voice_notify', 'smartphone'],
  ['missed-call push', 'core1.missed_call_push', 'smartphone'],
  ['Sarvam leave_message push', 'core1.sarvam_message_push', 'smartphone'],
] as const;

describe.skipIf(!url)('C-14 authorized sends on all-migrations disposable PostgreSQL', () => {
  let sql: Sql, db: RpcDb;
  let family: string, subject: string, recipient: string, principal: string, consent: string, source: string, user: string, identity: string;
  let sent: number;
  beforeAll(async () => { sql = postgres(url!, { max: 1, prepare: false, onnotice: () => undefined }); });
  afterAll(async () => { await sql?.end({ timeout: 5 }); });
  beforeEach(async () => {
    await sql.unsafe('begin');
    [family, subject, recipient, principal, consent, source, user, identity] = Array.from({ length: 8 }, () => randomUUID());
    sent = 0;
    db = { async rpc(name, args = {}) {
      if (!/^[a-z_]+$/.test(name) || Object.keys(args).some(k => !/^p_[a-z_]+$/.test(k))) throw new Error('bad_test_rpc');
      await sql.unsafe('savepoint rpc_call');
      try {
        const named = Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(',');
        const rows = await sql.unsafe(`select public.${name}(${named}) as data`, Object.values(args) as string[]);
        await sql.unsafe('release savepoint rpc_call');
        return { data: rows[0]?.data ?? null, error: null };
      } catch (error) {
        await sql.unsafe('rollback to savepoint rpc_call');
        await sql.unsafe('release savepoint rpc_call');
        return { data: null, error: { code: (error as { code: string }).code, message: (error as Error).message } };
      }
    } };
    await sql`insert into public.families(id,name) values(${family},'Synthetic C14')`;
    await sql`insert into public.people(id,family_id,display_name,role,device) values
      (${subject},${family},'Riya','child','smartphone'),(${recipient},${family},'Maa','parent','keypad')`;
    await sql`insert into auth.users(id) values(${user})`;
    await sql`insert into public.family_memberships(family_id,user_id,person_id,role) values(${family},${user},${recipient},'parent')`;
    await sql`insert into public.app_push_tokens(family_id,user_id,expo_token) values(${family},${user},'ExponentPushToken[synthetic-c14]')`;
    await sql`insert into public.atlas_principals(id,family_id,label) values(${principal},${family},'Synthetic AI')`;
    await sql`insert into public.consents(id,family_id,person_id,purpose,question,answer,version,created_at)
      values(${consent},${family},${subject},${'voice_share:' + recipient},'Share with Maa?',true,'v1',now()-interval '1 second')`;
    for (const action of ['voice_message', 'missed_call_nudge']) {
      await sql`insert into public.permissions(family_id,person_id,action,decision,expires_at,consent_id,principal_id,
        valid_from,period_start,period_end,max_uses,target_ids) values(${family},${subject},${action},'allow',
        now()+interval '1 hour',${consent},${principal},now()-interval '1 hour',now()-interval '1 hour',now()+interval '1 hour',5,${[recipient]})`;
    }
    await sql`insert into public.provider_identities(id,family_id,person_id,source,account_id,external_id_hash,binding_kind,contact_ciphertext)
      values(${identity},${family},${recipient},'twilio',${ACCOUNT},${HASH},'contact','synthetic-encrypted-contact')`;
    // Exercise service-role grants/RLS, rather than running the send as the cluster owner.
    await sql.unsafe('set local role service_role');
  });
  afterEach(async () => { await sql.unsafe('rollback'); });

  async function input(kind: AuthorizedSendInput['kind'], device = 'smartphone'): Promise<AuthorizedSendInput> {
    await sql`update public.people set device=${device} where id=${recipient}`;
    if (kind === 'core1.voice_notify') {
      await sql`insert into public.voice_posts(id,family_id,sender_id,recipient_id,consent_id) values(${source},${family},${subject},${recipient},${consent})`;
    } else {
      // Append a real signed timeline event with the same source binding as sendTranscript.
      const { generateKeyPairSync } = await import('node:crypto');
      const { signTimelineEvent, canonicalJson } = await import('@/lib/timeline');
      const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const payload = { sender_id: subject, recipient_id: recipient, media_kind: 'ai_transcript' };
      const event = signTimelineEvent({ familyId: family, eventId: randomUUID(), sequence: 1, previousHash: null,
        dedupeKey: `sarvam-message:${source}`, eventType: kind === 'core1.missed_call_push' ? 'core1.missed_call_nudge.requested' : 'core1.message.transcript', entityId: source,
        humanLine: 'Synthetic transcript', occurredAt: new Date().toISOString(), keyId: 'synthetic-c14', payload }, key);
      const r = await db.rpc('append_timeline_event', { p_event: event.envelope, p_payload_canonical: canonicalJson(payload),
        p_chain_hash: event.chainHash, p_signature: event.signature });
      expect(r.error).toBeNull();
    }
    return { familyId: family, subjectId: subject, recipientId: recipient, kind, sourceId: source, dedupeKey: `${kind}:${source}` };
  }
  async function enqueue(i: AuthorizedSendInput) {
    if (i.kind !== 'core1.missed_call_push') return enqueueAuthorizedSend(db, KEY, i);
    // Test the actual production seam used by both nudge paths, not just its helper.
    const port = createSupabaseCore1OutboxPort(db as Parameters<typeof createSupabaseCore1OutboxPort>[0], KEY);
    const out = await port.enqueue({ familyId: family, kind: i.kind, action: 'missed_call_nudge', dedupeKey: i.dedupeKey,
      payload: { callerPersonId: subject, recipientPersonId: recipient, nudgeId: source } });
    return { id: out.outboxId, duplicate: out.deduped, channel: 'expo' as const };
  }
  async function claim(i: AuthorizedSendInput, id: string) {
    const lease = await claimAuthorizedSend(db, family, id);
    expect(lease).not.toBeNull();
    if (i.kind === 'core1.voice_notify' && lease!.callId) {
      expect(await dispatchStore(db).claim({ familyId: family, personId: recipient, outboxId: id, outboxLease: lease!.lease,
        key: `dispatch:${id}:a1`, provider: 'twilio', action: 'twilio.create_call', callId: lease!.callId,
        contact: { identityId: identity, accountId: ACCOUNT, identityHash: HASH } })).toBe('claimed');
      expect((await sql`select * from public.dispatch_ledger where outbox_id=${id}`).length).toBe(1);
    } else {
      expect(await claimAuthorizedPush(db, family, id, lease!.lease)).toEqual(['ExponentPushToken[synthetic-c14]']);
      expect((await sql`select * from public.authorized_push_ledger where outbox_id=${id}`).length).toBe(1);
    }
  }
  for (const [label, kind, device] of CASES) {
    it(`${label}: atomic enqueue reaches a real trigger-accepted dispatch claim`, async () => {
      const i = await input(kind, device), result = await enqueue(i);
      const rows = await sql`select * from public.outbox where id=${result.id}`;
      expect(rows[0].status).toBe('pending');
      expect(rows[0].permission_id).toBeTruthy(); expect(rows[0].action_request_id).toBeTruthy();
      expect(rows[0].workflow_job_id).toBeTruthy();
      const plain = JSON.parse(decryptWebhook(rows[0].payload_ciphertext, KEY, `outbox:${family}:${i.dedupeKey}`).toString());
      expect(Object.keys(plain).sort()).toEqual(['action','eventId','requestId','v']);
      await claim(i, result.id);
    });
    it(`${label}: an unauthorized enqueue is still refused by SQL`, async () => {
      const i = await input(kind, device), realDb = db;
      let captured: Record<string, unknown> | undefined;
      // Stop before the mutation to obtain a genuine pending request and the Cedar-approved envelope.
      db = { rpc: (name, args) => {
        if (name === 'enqueue_authorized_command') { captured = args; return Promise.resolve({ data: { status: 'denied' }, error: null }); }
        return realDb.rpc(name, args);
      } };
      try { await expect(enqueue(i)).rejects.toThrow('send_not_authorized'); }
      finally { db = realDb; }
      expect(captured).toBeTruthy();
      await sql`update public.permissions set revoked_at=now() where family_id=${family}`;
      const fresh = await db.rpc('load_gate_snapshot', { p_family_id: family,
        p_job_id: captured!.p_job_id, p_request_id: captured!.p_action_request_id });
      const refused = await db.rpc('enqueue_authorized_command', { ...captured!, p_revision: (fresh.data as { revision: string }).revision });
      expect(refused.error).toBeNull();
      expect(['denied','review']).toContain((refused.data as { status: string }).status);
      expect((await sql`select count(*)::int as n from public.outbox where family_id=${family}`)[0].n).toBe(0);
    });
    it(`${label}: revoked authority also blocks a queued dispatch`, async () => {
      const i = await input(kind, device), result = await enqueue(i);
      await sql`update public.permissions set revoked_at=now() where family_id=${family}`;
      await expect(claimAuthorizedSend(db, family, result.id)).rejects.toThrow('send_claim_failed');
      expect((await sql`select count(*)::int as n from public.dispatch_ledger where outbox_id=${result.id}`)[0].n).toBe(0);
      expect((await sql`select count(*)::int as n from public.authorized_push_ledger where outbox_id=${result.id}`)[0].n).toBe(0);
    });
  }
  it('bare outbox dispatch is refused by the original ledger trigger', async () => {
    const oid = randomUUID(), lease = randomUUID(), call = randomUUID();
    await sql`insert into public.calls(id,family_id,person_id,provider,status) values(${call},${family},${recipient},'twilio','scheduled')`;
    await sql`insert into public.outbox(id,family_id,kind,dedupe_key,payload_ciphertext,status,lease_token,lease_until)
      values(${oid},${family},'core1.voice_notify','bare','x','processing',${lease},now()+interval '1 minute')`;
    expect((await db.rpc('bind_outbox_dispatch', { p_family_id: family, p_outbox_id: oid, p_person_id: recipient,
      p_provider: 'twilio', p_action: 'twilio.create_call', p_call_id: call })).error).toBeNull();
    const result = await db.rpc('claim_dispatch_contact', { p_family_id: family, p_person_id: recipient, p_key: 'bare-test',
      p_provider: 'twilio', p_action: 'twilio.create_call', p_outbox_id: oid, p_outbox_lease: lease, p_call_id: call,
      p_contact_identity_id: identity, p_contact_account_id: ACCOUNT, p_contact_identity_hash: HASH });
    expect(result.error?.code).toBe('42501');
    expect(result.error?.message).toContain('dispatch_not_authorized');
  });
  it('requires actual recipient consent and blocks revocation between enqueue and push claim', async () => {
    const i = await input('core1.voice_notify'), out = await enqueue(i), lease = await claimAuthorizedSend(db, family, out.id);
    await sql`insert into public.consents(family_id,person_id,purpose,question,answer,version)
      values(${family},${subject},${'voice_share:' + recipient},'Refuse?',false,'v1')`;
    await expect(claimAuthorizedPush(db, family, out.id, lease!.lease)).rejects.toThrow('push_claim_failed');
  });
  it('deduplicates atomic enqueue and never charges usage twice', async () => {
    const i = await input('core1.voice_notify');
    const first = await enqueue(i), second = await enqueue(i);
    expect(second.id).toBe(first.id); expect(second.duplicate).toBe(true);
    expect((await sql`select used_count from public.permissions where family_id=${family} and action='voice_message'`)[0].used_count).toBe(1);
    await claim(i, first.id);
    expect(await claimAuthorizedSend(db, family, first.id)).toBeNull();
  });
  it('notifyVoicePost uses real authorization, lease, contact fence and Phase 2 dispatch with a fake transport', async () => {
    const i = await input('core1.voice_notify','keypad');
    const deps: VoiceNotifyDeps = {
      repo: { getPerson: async (_f,id) => ({ id, familyId: family, displayName: id===subject?'Riya':'Maa',
        device: id===recipient?'keypad':'smartphone', language: 'Hindi' }),
        enqueueAuthorized: () => enqueue(i), claim: (f,o) => claimAuthorizedSend(db,f,o),
        claimPush: (f,o,l) => claimAuthorizedPush(db,f,o,l), updateOutboxStatus: async () => {} },
      keypadBaseUrl: 'https://api.sahaj.test',
      dispatch: { store: dispatchStore(db), deps: { authorize: createDispatchAuthorizer(db), identitySecret: SECRET,
        resolveDestination: Object.assign(async () => PHONE, { resolveIdentity: async () => ({ e164: PHONE,
          identityId: identity, accountId: ACCOUNT, identityHash: HASH }) }),
        providers: { twilio: { accountSid: ACCOUNT, authToken: 'synthetic-c14', fromNumber: '+15550000001',
          statusCallbackUrl: 'https://api.sahaj.test/api/providers/twilio/status', allowedWebhookHosts: ['api.sahaj.test'] } },
        transport: async () => { sent++; return Response.json({ sid: `CA${'b'.repeat(32)}` }, { status: 201 }); } } },
    };
    expect((await notifyVoicePost(deps, { familyId: family, voicePostId: source, senderId: subject, recipientId: recipient })).dispatched).toBe(true);
    expect(sent).toBe(1);
    expect((await sql`select status from public.outbox where family_id=${family}`)[0].status).toBe('completed');
  });
});
