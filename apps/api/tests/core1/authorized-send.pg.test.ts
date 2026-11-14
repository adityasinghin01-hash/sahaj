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
    for (const action of ['voice_message', 'missed_call_nudge', 'send_alert', 'share_data']) {
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
  // C-15 runs in this same all-migrations disposable runner, under service_role.
  const careKinds = ['core2.sos_alert','core2.watch_escalation','core2.reassurance',
    'core2.device_handover','gentle_news.circle_offer','core1.refill_notice'] as const;
  async function careInput(kind: typeof careKinds[number], callOnly = false, completed = true): Promise<AuthorizedSendInput> {
    const [raw, req, incident, watch, sos, tc, cc, errand, refillRequest, parent] = Array.from({ length: 10 }, () => randomUUID());
    if (callOnly) await sql`delete from public.app_push_tokens where family_id=${family}`;
    await sql`insert into public.raw_events(id,family_id,source,provider_event_id,event_type,status)
      values(${raw},${family},'core2',${raw},'synthetic.care','processed')`;
    await sql`insert into public.requests(id,family_id,person_id,kind) values(${req},${family},${subject},'synthetic_care')`;
    await sql`insert into public.incidents(id,family_id,person_id,request_id,state,severity)
      values(${incident},${family},${subject},${req},'offered','urgent')`;
    await sql`insert into public.core2_watches(id,family_id,subject_person_id,incident_id,request_id,raw_event_id,timezone,deadline_at,grace_until)
      values(${watch},${family},${subject},${incident},${req},${raw},'Asia/Kolkata',now()+interval '10 minutes',now()+interval '20 minutes')`;
    await sql`insert into public.core2_sos_events(id,family_id,subject_person_id,incident_id,request_id,raw_event_id)
      values(${sos},${family},${subject},${incident},${req},${raw})`;
    await sql`insert into public.consents(id,family_id,person_id,purpose,question,answer,version,created_at)
      values(${cc},${family},${recipient},'trusted_contact','Serve as contact?',true,'v1',now()-interval '1 second')`;
    await sql`insert into public.core2_trusted_contacts(id,family_id,subject_person_id,contact_person_id,rank,scopes,state,approved_at,consent_id,consent_at)
      values(${tc},${family},${subject},${recipient},1,ARRAY['sos','watch_escalation','reassurance'],'active',now(),${cc},now())`;
    if (kind === 'gentle_news.circle_offer') {
      await sql`insert into public.people(id,family_id,display_name,role,device) values(${parent},${family},'Synthetic parent','parent','keypad')`;
      await sql`insert into public.circle(family_id,person_id,rank,approved_at,consent_at) values(${family},${recipient},1,now(),now())`;
      await sql`insert into public.core2_gentle_news(family_id,incident_id,subject_person_id,parent_person_id,marked_by_person_id,
        calm_summary,circle_person_id,maa_call_due_at,raw_event_id)
        values(${family},${incident},${subject},${parent},${subject},'Calm synthetic update',${recipient},now()+interval '5 minutes',${raw})`;
    }
    if (kind === 'core1.refill_notice') {
      await sql`update public.family_memberships set role='child' where family_id=${family} and person_id=${recipient}`;
      await sql`insert into public.action_requests(id,family_id,person_id,action,status,expires_at,consumed_at,amount_minor)
        values(${refillRequest},${family},${subject},'medicine_refill','approved',now()+interval '1 hour',now(),54000)`;
      await sql`insert into public.errands(id,family_id,request_id,action_request_id,status)
        values(${errand},${family},${req},${refillRequest},'authorized')`;
    }
    const handover = kind === 'core2.device_handover' ? randomUUID() : null;
    if (handover) {
      await sql`insert into public.core2_device_status(family_id,person_id,battery_level,is_charging,sampled_at,raw_event_id)
        values(${family},${subject},3,false,now(),${raw})`;
      await sql`insert into public.core2_device_handovers(id,family_id,person_id,watch_id,request_id,reason,last_seen_at,completed_at)
        values(${handover},${family},${subject},${watch},${req},'low_battery',now(),${completed ? new Date() : null})`;
    }
    const details = { handoverId: handover, trustedContactId: tc, watchId: kind==='core2.sos_alert' ? null : watch,
      sosId: kind==='core2.sos_alert' ? sos : null, incidentId: incident, assignmentId: null,
      errandId: kind==='core1.refill_notice' ? errand : null, statusLabel: 'Main safe hoon', amountMinor: kind==='core1.refill_notice' ? 54000 : null };
    const { generateKeyPairSync } = await import('node:crypto');
    const { signTimelineEvent, canonicalJson } = await import('@/lib/timeline');
    const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const payload = { kind, subjectId: subject, recipientId: recipient, details };
    const event = signTimelineEvent({ familyId: family, eventId: randomUUID(), sequence: 1, previousHash: null,
      dedupeKey: `care-source:${source}`, eventType: 'care.send.requested', entityId: source,
      humanLine: 'Synthetic care source', occurredAt: new Date().toISOString(), keyId: 'synthetic-c15', payload }, key);
    const appended = await db.rpc('append_timeline_event', { p_event: event.envelope, p_payload_canonical: canonicalJson(payload),
      p_chain_hash: event.chainHash, p_signature: event.signature });
    expect(appended.error).toBeNull();
    return { familyId: family, subjectId: subject, recipientId: recipient, sourceId: source, kind, details, dedupeKey: `c15:${kind}:${source}` };
  }
  for (const kind of careKinds) {
    it(`C-15 ${kind}: authorizes server principal and reaches the guarded app claim`, async () => {
      const i = await careInput(kind), result = await enqueueAuthorizedSend(db, KEY, i);
      expect(result.channel).toBe('expo');
      const [row] = await sql`select r.principal_id,r.person_id,r.target_id from public.outbox o join public.action_requests r on r.id=o.action_request_id where o.id=${result.id}`;
      expect(row.principal_id).toBe(principal); expect(row.person_id).toBe(subject); expect(row.target_id).toBe(recipient);
      const lease = await claimAuthorizedSend(db, family, result.id);
      expect(await claimAuthorizedPush(db, family, result.id, lease!.lease)).toEqual(['ExponentPushToken[synthetic-c14]']);
    });
    it(`C-15 ${kind}: revocation between enqueue and ledger claim refuses delivery`, async () => {
      const i = await careInput(kind), result = await enqueueAuthorizedSend(db, KEY, i);
      const lease = await claimAuthorizedSend(db, family, result.id);
      await sql`update public.permissions set revoked_at=now() where family_id=${family}`;
      await expect(claimAuthorizedPush(db, family, result.id, lease!.lease)).rejects.toThrow('push_claim_failed');
      expect((await sql`select count(*)::int as n from public.authorized_push_ledger where outbox_id=${result.id}`)[0].n).toBe(0);
    });
  }
  it('C-15 call recipient without an app reaches the original Phase 2 contact fence', async () => {
    const i = await careInput('core2.sos_alert',true), result = await enqueueAuthorizedSend(db,KEY,i);
    expect(result.channel).toBe('twilio');
    const lease = await claimAuthorizedSend(db,family,result.id);
    expect(await dispatchStore(db).claim({ familyId: family, personId: recipient, outboxId: result.id, outboxLease: lease!.lease,
      key: `dispatch:${result.id}:a1`, provider: 'twilio', action: 'twilio.create_call', callId: lease!.callId!,
      contact: { identityId: identity, accountId: ACCOUNT, identityHash: HASH } })).toBe('claimed');
  });
  it('C-15 trusted-contact revocation refuses an already queued send', async () => {
    const i = await careInput('core2.sos_alert'), result = await enqueueAuthorizedSend(db,KEY,i);
    const lease = await claimAuthorizedSend(db,family,result.id);
    await sql`update public.core2_trusted_contacts set state='revoked',revoked_at=now() where id=${i.details!.trustedContactId as string}`;
    await expect(claimAuthorizedPush(db,family,result.id,lease!.lease)).rejects.toThrow('push_claim_failed');
  });
  it('C-15 safe resolution fences a queued watch offer', async () => {
    const i = await careInput('core2.watch_escalation'), result = await enqueueAuthorizedSend(db,KEY,i);
    const lease = await claimAuthorizedSend(db,family,result.id);
    await sql`update public.core2_watches set state='safe',safe_at=now(),next_tick_at=null where id=${i.details!.watchId as string}`;
    await expect(claimAuthorizedPush(db,family,result.id,lease!.lease)).rejects.toThrow('push_claim_failed');
  });
  it('C-15 altered recipient/source details cannot reuse a signed intent', async () => {
    const i = await careInput('core2.sos_alert'); i.details = { ...i.details, statusLabel: 'tampered' };
    await expect(enqueueAuthorizedSend(db,KEY,i)).rejects.toThrow('send_prepare_failed');
    expect((await sql`select count(*)::int as n from public.outbox where family_id=${family}`)[0].n).toBe(0);
  });

  it('C-15 phone-dying notices cannot claim before signed handover completion', async () => {
    const i = await careInput('core2.device_handover',false,false), result = await enqueueAuthorizedSend(db,KEY,i);
    const lease = await claimAuthorizedSend(db,family,result.id);
    await expect(claimAuthorizedPush(db,family,result.id,lease!.lease)).rejects.toThrow('push_claim_failed');
    expect((await sql`select count(*)::int as n from public.authorized_push_ledger where outbox_id=${result.id}`)[0].n).toBe(0);
    await sql`update public.core2_device_handovers set completed_at=now() where id=${i.details!.handoverId as string}`;
    expect(await claimAuthorizedPush(db,family,result.id,lease!.lease)).toEqual(['ExponentPushToken[synthetic-c14]']);
  });
  it('C-15 the replacement handover RPC refuses a bare notice and accepts only its authorized outbox', async () => {
    const i = await careInput('core2.device_handover',false,false);
    const { generateKeyPairSync } = await import('node:crypto');
    const { signTimelineEvent, canonicalJson } = await import('@/lib/timeline');
    const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const [head] = await sql`select * from public.timeline_stream_heads where family_id=${family}`;
    const handoverId = i.details!.handoverId as string;
    const payload = { notices_queued: 1 };
    const event = signTimelineEvent({ familyId: family, eventId: handoverId, sequence: Number(head.last_sequence)+1,
      previousHash: head.last_chain_hash, dedupeKey: `core2:device:${handoverId}`, eventType: 'core2.device.handover',
      entityId: i.details!.watchId as string, humanLine: 'Synthetic phone handover', occurredAt: new Date().toISOString(), keyId: 'synthetic-c15', payload }, key);
    const notice = { recipient, statusLabel: 'Phone update pending', parent: false,
      command: { familyId: family, kind: i.kind, dedupeKey: i.dedupeKey, trustedContactId: i.details!.trustedContactId } };
    const args = { p_job_id: handoverId, p_event: event.envelope, p_payload_canonical: canonicalJson(payload),
      p_chain_hash: event.chainHash, p_signature: event.signature };
    const bare = await db.rpc('core2_complete_device_handover', { ...args, p_notices: JSON.stringify([notice]) });
    expect(bare.error?.code).toBe('42501');
    const result = await enqueueAuthorizedSend(db,KEY,i);
    const completed = await db.rpc('core2_complete_device_handover', { ...args,
      p_notices: JSON.stringify([{ ...notice, authorizedOutboxId: result.id }]) });
    expect(completed.error).toBeNull();
    expect((await sql`select completed_at from public.core2_device_handovers where id=${handoverId}`)[0].completed_at).toBeTruthy();
    const lease = await claimAuthorizedSend(db,family,result.id);
    expect(await claimAuthorizedPush(db,family,result.id,lease!.lease)).toEqual(['ExponentPushToken[synthetic-c14]']);
  });

});
