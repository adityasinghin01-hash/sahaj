import { createHash } from 'node:crypto';
import { getDbPools } from '../../../../../shield-api/src/lib/db';
import { serviceDatabase } from '../../database';
import { canonicalJson } from '../../timeline';
import { encryptWebhook, decryptWebhook } from '../../webhook-security';
import { getCore2Service } from '../../core2';
import { executeCore1Command } from '../service';
import { createSupabaseCore1Repository } from '../repository';
import { createProductionRefillDeps, executeRefillProposalCommand } from '../refill-service';
import { createSupabaseCore1TimelinePort, stableCore1Uuid } from '../wiring-common';
import { defaultSendExpoPush } from '../voice-notify';
import { enqueueAuthorizedSend, claimAuthorizedSend, claimAuthorizedPush } from '../authorized-send';
import { dispatchStore } from '../../provider-dispatch/supabase-store';
import type { Core1ServicePorts, FamilyMembership } from '../types';
import { createCommandPorts, type CommandDeps } from './commands';
import type { ToolContext, ToolName, ToolResult } from './handler';
import { maskDigits } from '../../../../../../packages/shield/src/tools/mask';

type Database = ReturnType<typeof serviceDatabase>;
type Sql = ReturnType<typeof getDbPools>['auxSql'];
// Each command holds one advisory-lock connection while the existing services
// use the same ten-connection pool. Leave room for those dependent queries.
let commandsInFlight = 0;
export interface ProductionOverrides { db?: Database; sql?: Sql; now?: () => Date }

/** A tool token is a server-to-server credential, never a Supabase user JWT.
 * Only call this after authenticating Sarvam and resolving the live parent.
 * The ordinary Core 1 command still performs ownership/capability validation. */
export async function trustedCommandPorts(db: Database, ctx: ToolContext, personId = ctx.parentId): Promise<Core1ServicePorts> {
  const { data, error } = await db.from('family_memberships').select('family_id,user_id,person_id,role')
    .eq('family_id', ctx.familyId).eq('person_id', personId).is('revoked_at', null).single();
  if (error || !data) throw new Error('membership_unavailable');
  const membership: FamilyMembership = { familyId: data.family_id, userId: data.user_id, personId: data.person_id, role: data.role };
  const repo = createSupabaseCore1Repository(db);
  return {
    auth: { async getUser() { return { id: membership.userId, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' }; } },
    repo: {
      getMembership: async (_user, familyId) => {
        if (familyId !== ctx.familyId) throw new Error('family_mismatch');
        return membership;
      },
      getCircleRecord: repo.getCircleRecord.bind(repo),
      validateEntityOwnership: repo.validateEntityOwnership.bind(repo),
      findEventByIdempotency: repo.findEventByIdempotency.bind(repo),
      persistCommandEvent: repo.persistCommandEvent.bind(repo),
    },
    encryptionKeyHex: process.env.WEBHOOK_ENCRYPTION_KEY,
  };
}
function commandRequest(ctx: ToolContext, payload: Record<string, unknown>, key: string): Request {
  return new Request('http://core1.internal/command', { method: 'POST', headers: {
    authorization: 'Bearer verified-sarvam-context', 'content-type': 'application/json', 'idempotency-key': key,
  }, body: JSON.stringify({ familyId: ctx.familyId, payload }) });
}
function requireRow<T>(rows: T[]): T {
  if (!rows[0]) throw new Error('scoped_entity_not_found');
  return rows[0];
}

export function createProductionSarvamDeps(env: Record<string, string | undefined> = process.env, overrides: ProductionOverrides = {}): CommandDeps {
  const db = overrides.db ?? serviceDatabase();
  if (!overrides.sql && !env.DATABASE_URL) throw new Error('database_not_configured');
  const sql = overrides.sql ?? getDbPools(env.DATABASE_URL!).auxSql;
  const now = overrides.now ?? (() => new Date());
  const signingKey = env.TIMELINE_SIGNING_PRIVATE_KEY ?? env.SIGNING_PRIVATE_KEY;
  if (!signingKey) throw new Error('timeline_signing_not_configured');
  const timeline = createSupabaseCore1TimelinePort(db, signingKey,
    env.TIMELINE_SIGNING_KEY_ID ?? env.SIGNING_KEY_ID ?? 'core1-default', now);
  const keyHex = env.WEBHOOK_ENCRYPTION_KEY ?? '';
  const idFor = (ctx: ToolContext, kind: string, key: string) => stableCore1Uuid(['sarvam', ctx.familyId, ctx.parentId, kind, key]);
  const checkCall = async (ctx: ToolContext, callId: string) => {
    requireRow(await sql`select id from public.calls where family_id=${ctx.familyId} and person_id=${ctx.parentId} and id=${callId} and provider='sarvam'`);
  };
  const child = async (ctx: ToolContext) => requireRow(await sql<{ id: string }[]>`
    select p.id from public.people p join public.family_memberships m on m.family_id=p.family_id and m.person_id=p.id
    where p.family_id=${ctx.familyId} and p.role='child' and m.revoked_at is null
    order by m.created_at limit 1`).id;

  return {
    now,
    async assertParent(ctx) {
      requireRow(await sql`select id from public.people where family_id=${ctx.familyId} and id=${ctx.parentId} and role='parent'`);
    },
    async runOnce(tool, ctx, input, key, work) {
      if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error('encryption_not_configured');
      if (commandsInFlight >= 4) throw new Error('tool_busy');
      const scope = idFor(ctx, tool, key), hash = createHash('sha256').update(canonicalJson(input)).digest('hex');
      commandsInFlight++;
      let conn: Awaited<ReturnType<Sql['reserve']>> | undefined;
      let locked = false;
      try {
        conn = await sql.reserve();
        locked = Boolean((await conn`select pg_try_advisory_lock(hashtextextended(${scope},0)) as locked`)[0]?.locked);
        if (!locked) throw new Error('tool_in_progress');
        const previous = (await conn`select payload_hash,payload_ciphertext,metadata->>'tool_state' as tool_state from public.raw_events where source='core1_sarvam_tool' and provider_event_id=${scope}`)[0];
        if (previous) {
          if (previous.payload_hash !== hash) throw new Error('idempotency_conflict');
          if (previous.tool_state !== 'done') throw new Error('tool_previous_attempt_incomplete');
          return JSON.parse(decryptWebhook(previous.payload_ciphertext, keyHex, `sarvam:${scope}`).toString('utf8')).result as ToolResult;
        }
        // Bind the body before any effects. A failed/uncertain attempt remains
        // started and transfers on retry, never repeats a partial call or push.
        const started = encryptWebhook(Buffer.from(canonicalJson({ input })), keyHex, `sarvam:${scope}`);
        await conn`insert into public.raw_events (id,family_id,source,provider_event_id,event_type,status,payload_hash,payload_ciphertext,metadata)
          values (${scope},${ctx.familyId},'core1_sarvam_tool',${scope},${`core1.sarvam.${tool}`},'processed',${hash},${started},'{"tool_state":"started"}'::jsonb)`;
        // Prove signing availability before any care-state mutation or send.
        await timeline.append({ familyId: ctx.familyId, eventType: `core1.sarvam.${tool}.started`, entityId: ctx.parentId,
          humanLine: `Parent requested ${tool.replaceAll('_', ' ')} by phone.`, payload: { tool, channel: 'keypad' }, dedupeKey: `sarvam-started:${scope}` });
        const result = await work();
        const ciphertext = encryptWebhook(Buffer.from(canonicalJson({ input, result })), keyHex, `sarvam:${scope}`);
        await conn`update public.raw_events set payload_ciphertext=${ciphertext},metadata='{"tool_state":"done"}'::jsonb
          where family_id=${ctx.familyId} and source='core1_sarvam_tool' and provider_event_id=${scope}`;
        return result;
      } finally {
        try { if (locked && conn) await conn`select pg_advisory_unlock(hashtextextended(${scope},0))`; }
        finally { conn?.release(); commandsInFlight--; }
      }
    },
    async urgentCommand(ctx, input, key) {
      const ports = await trustedCommandPorts(db, ctx);
      const result = await executeCore1Command(commandRequest(ctx, { subjectPersonId: ctx.parentId, severity: input.severity, action: 'initiate' }, `sarvam-urgent:${key}`), ports, 'urgent_help');
      return { status: result.status };
    },
    async openIncident(ctx) {
      const incident = (await sql`select i.state,i.promised_at,p.display_name from public.incidents i
        left join public.people p on p.family_id=i.family_id and p.id=i.owner_person_id
        where i.family_id=${ctx.familyId} and i.person_id=${ctx.parentId} and i.state not in ('done','closed')
        order by i.created_at desc limit 1`)[0];
      if (!incident) return { status: 'none' };
      const promise = incident.promised_at ? new Date(incident.promised_at).getTime() : NaN;
      return { status: String(incident.state), responder_name: incident.display_name ? String(incident.display_name) : undefined,
        eta_minutes: Number.isFinite(promise) && promise > now().getTime() ? Math.ceil((promise - now().getTime()) / 60000) : undefined };
    },
    async sendTranscript(ctx, transcript, label, key) {
      transcript = maskDigits(transcript);
      const recipient = await child(ctx);
      const messageId = idFor(ctx, 'message', key);
      // This is text explicitly dictated for Riya, not a voice_post or synthesized
      // imitation of Maa. The signed timeline is the durable text message.
      await timeline.append({ familyId: ctx.familyId, eventType: 'core1.message.transcript', entityId: messageId,
        humanLine: `${label}: ${transcript}`, payload: { sender_id: ctx.parentId, recipient_id: recipient, label, transcript, media_kind: 'ai_transcript' },
        dedupeKey: `sarvam-message:${messageId}` });
      const queued = await enqueueAuthorizedSend(db, keyHex, { familyId: ctx.familyId,
        subjectId: ctx.parentId, recipientId: recipient, kind: 'core1.sarvam_message_push',
        sourceId: messageId, dedupeKey: `sarvam-message-push:${messageId}` });
      if (env.EXPO_PUSH_ENABLED !== 'true' && env.EXPO_PUSH_ENABLED !== '1') throw new Error('push_disabled');
      const claim = await claimAuthorizedSend(db, ctx.familyId, queued.id);
      if (!claim) throw new Error('push_already_claimed');
      const tokens = await claimAuthorizedPush(db, ctx.familyId, queued.id, claim.lease);
      if (!tokens?.length) throw new Error('push_registration_missing');
      const store = dispatchStore(db);
      try {
        const push = await defaultSendExpoPush(tokens.map(to => ({ to, title: "AI transcript of Maa's words",
          body: transcript.slice(0, 500), sound: 'default', data: { message_id: messageId, kind: 'ai_transcript' } })));
        await store.finishOutbox(queued.id, claim.lease, push.sent > 0, push.sent > 0 ? undefined : 'push_unavailable');
        if (push.sent === 0 || push.failed > 0) throw new Error('push_unavailable');
      } catch {
        // The durable claim prevents a webhook replay from repeating an ambiguous provider request.
        await db.from('outbox').update({ status: 'delivery_unknown', last_error_code: 'push_delivery_unknown' })
          .eq('id', queued.id).eq('lease_token', claim.lease).eq('status', 'processing');
        throw new Error('push_delivery_unknown');
      }
    },
    async truthLine(ctx, input) {
      const result = await getCore2Service().querySarvamTruthLine(env.SARVAM_TOOL_TOKEN ?? null, {
        family_id: ctx.familyId, parent_id: ctx.parentId, ...(input.subject_person_id ? { subject_person_id: input.subject_person_id } : {}),
      });
      // Return status only. The boundary uses a fixed, location-free Hindi line.
      return { status: result.body.status };
    },
    async familyCheck(ctx, input) {
      // Use exactly the runtime/ports behind Shield's Sarvam tool route. An
      // internal HTTP hop would fail its Sarvam-only ingress IP allowlist.
      const [{ createShieldRuntime }, { createShieldPorts }] = await Promise.all([
        import('../../../../../../packages/shield/src/runtime'),
        import('../../../../../shield-api/src/ports'),
      ]);
      const pools = overrides.sql ? { shieldSql: sql, auxSql: sql } : getDbPools(env.DATABASE_URL!);
      const runtime = createShieldRuntime(createShieldPorts({ ...pools, env, clock: { now } }));
      const body = await runtime.shieldTools.run('family_check', ctx, { claimed_name: 'Riya', asked_for: maskDigits(input.asked_for) });
      if (body.status !== 'checking' || typeof body.check_id !== 'string') throw new Error('shield_family_check_unavailable');
      return { status: 'checking', check_id: body.check_id };
    },
    async recordConsent(ctx, input, key) {
      await checkCall(ctx, String(input.call_id));
      const purpose = input.purpose === 'record' ? 'call_recording' : input.purpose === 'call' ? 'check_in' : 'call_transcript';
      const version = env.CALL_CONSENT_VERSION;
      if (!version) throw new Error('consent_version_missing');
      await sql`insert into public.consents(id,family_id,person_id,call_id,turn_id,purpose,question,answer,version)
        values (${idFor(ctx, 'consent', key)},${ctx.familyId},${ctx.parentId},${String(input.call_id)},${String(input.turn_id)},${purpose},
        ${input.purpose === 'call' ? 'Kya main roz phone kar sakti hoon?' : input.purpose === 'record' ? 'Kya main baat record kar sakti hoon?' : 'Kya main Riya ko bata sakti hoon?'},${input.answer === true},${version})
        on conflict (id) do nothing`;
    },
    async reschedule(ctx, input) {
      const next = new Date(now().getTime() + Number(input.hours) * 3600000).toISOString();
      requireRow(await sql`update public.schedules set next_at=${next} where family_id=${ctx.familyId} and person_id=${ctx.parentId}
        and id=${String(input.schedule_id)} and kind='check_in' and enabled returning id`);
    },
    async markPrivate(ctx, input, key) {
      await checkCall(ctx, String(input.call_id));
      if (!env.CALL_CONSENT_VERSION) throw new Error('consent_version_missing');
      // Append-only refusal + encrypted private marker. Never write the private
      // summary or Maa's private words into the shared timeline/report.
      await sql.begin(async tx => {
        await tx`insert into public.consents(id,family_id,person_id,call_id,purpose,question,answer,version)
          values (${idFor(ctx, 'private-consent', key)},${ctx.familyId},${ctx.parentId},${String(input.call_id)},'call_transcript',
          'Is call ki baat Riya ko batana?',false,${env.CALL_CONSENT_VERSION!}) on conflict(id) do nothing`;
        const cipher = encryptWebhook(Buffer.from('{"summary_private":true}'), keyHex, `private:${ctx.familyId}:${String(input.call_id)}`);
        await tx`insert into sahaj_private.private_items(id,family_id,person_id,said_in_call,content_ciphertext,until_at)
          values (${idFor(ctx, 'private-marker', key)},${ctx.familyId},${ctx.parentId},${String(input.call_id)},${cipher},${new Date(now().getTime() + 365 * 86400000).toISOString()})
          on conflict(id) do nothing`;
      });
    },
    async cancelPermission(ctx, input) {
      requireRow(await sql`update public.permissions set revoked_at=coalesce(revoked_at,now())
        where family_id=${ctx.familyId} and person_id=${ctx.parentId} and id=${String(input.permission_id)} returning id`);
    },
    async getMedicine(ctx, medicineId) {
      const deps = createProductionRefillDeps(env);
      return deps.store.getMedicine(ctx.familyId, medicineId);
    },
    async setMedicineCount(ctx, medicineId, count) {
      requireRow(await sql`update public.medicines set remaining_count=${count} where family_id=${ctx.familyId} and person_id=${ctx.parentId} and id=${medicineId} returning id`);
    },
    async proposeRefill(ctx, medicineId, vendorId, key) {
      // No vendor is guessed from an arbitrary pharmacy. Ask the saved family-
      // approved medicine vendor, or transfer if setup is ambiguous/missing.
      if (!vendorId) {
        const vendors = await sql<{ id: string }[]>`select id from public.vendors where family_id=${ctx.familyId} and category='pharmacy' and approved_at is not null and revoked_at is null limit 2`;
        if (vendors.length !== 1) throw new Error('medicine_vendor_required');
        vendorId = vendors[0].id;
      }
      const deps = createProductionRefillDeps(env);
      deps.auth = { authenticate: async () => ({ familyId: ctx.familyId, personId: ctx.parentId, userId: ctx.parentId, role: 'parent' }) };
      const request = new Request('http://core1.internal/refill', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `sarvam-refill:${key}` },
        body: JSON.stringify({ familyId: ctx.familyId, personId: ctx.parentId, medicineId, vendorId }) });
      const result = await executeRefillProposalCommand(request, deps);
      if (!result.ok) throw new Error('refill_not_proposed');
    },
    async responderCommand(tool, ctx, input, key) {
      // A bearer token plus "haan" must never fabricate acceptance evidence.
      // Require the existing normalized provider proof and its exact call binding.
      const accepted = tool === 'accept_incident';
      requireRow(await sql`select e.id from public.raw_events e
        join public.assignments a on a.family_id=e.family_id and a.id=${String(input.assignment_id)}
        join public.incidents i on i.family_id=a.family_id and i.id=a.incident_id
        join public.calls c on c.family_id=a.family_id and c.id=${String(input.call_id)} and c.person_id=a.person_id
        where e.family_id=${ctx.familyId} and e.id=${String(input.raw_event_id)} and e.normalized_proof and e.status='processed'
        and e.event_type=${accepted ? 'responder.accepted' : 'responder.declined'}
        and e.metadata->>'call_id'=${String(input.call_id)} and e.metadata->>'assignment_id'=a.id::text
        and a.person_id=${String(input.responder_person_id)} and a.incident_id=${String(input.incident_id)} and i.person_id=${ctx.parentId}`);
      const ports = await trustedCommandPorts(db, ctx, String(input.responder_person_id));
      await executeCore1Command(commandRequest(ctx, { subjectPersonId: ctx.parentId, severity: 'urgent',
        incidentId: input.incident_id, assignmentId: input.assignment_id, rawEventId: input.raw_event_id,
        action: accepted ? 'accept' : 'decline', ...(accepted ? { promiseMinutes: input.promise_minutes } : {}) }, `sarvam-responder:${key}`), ports, 'urgent_help');
    },
    async audit(tool: ToolName, ctx, key) {
      await timeline.append({ familyId: ctx.familyId, eventType: `core1.sarvam.${tool}`, entityId: ctx.parentId,
        humanLine: tool === 'mark_private' ? 'Parent kept this call private.' : `Parent used ${tool.replaceAll('_', ' ')} by phone.`,
        payload: { tool, channel: 'keypad', parent_id: ctx.parentId }, dedupeKey: `sarvam:${idFor(ctx, tool, key)}` });
    },
  };
}

export function createProductionSarvamPorts() { return createCommandPorts(createProductionSarvamDeps()); }
