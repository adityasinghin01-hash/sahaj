-- K-SARVAMCALL: urgent responder offers, keypad voice notes, keypad care notices and the gentle-news call to Maa can be
-- placed through Sarvam outbound (apps/api CALL_PROVIDER=sarvam, the default). The free Twilio trial cannot run our TwiML.
-- Every Twilio route is unchanged when the server passes 'twilio' (the default of each new parameter).
--
-- Responder acceptance over Sarvam: the spoken "haan" is never proof on its own. The tool call must name a calls row that
-- WE created and dispatched through Sarvam (dispatch_ledger provider_ref = the attempt id Sarvam returned), whose immutable
-- outbox binding names exactly the incident, assignment and responder in the tool call, while that assignment is still
-- offered. Only then does SQL write the normalized `responder.accepted` proof (verified_by = 'sarvam_call_binding') that the
-- existing accept_responder_assignment_verified -> accept_assignment_verified path consumes. One decision per call id.

-- 1. Urgent responder dispatch: the trusted server picks the call provider. 'twilio' stays the default, so old callers
--    and the Twilio path are unchanged.
drop function if exists public.prepare_urgent_responder_dispatch(uuid, uuid, uuid, uuid, uuid, text, text, text);
create function public.prepare_urgent_responder_dispatch(
  p_family_id uuid,
  p_incident_id uuid,
  p_assignment_id uuid,
  p_subject_person_id uuid,
  p_responder_person_id uuid,
  p_dedupe_key text,
  p_payload_ciphertext text,
  p_payload_hash text,
  p_provider text default 'twilio'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.outbox%rowtype;
  v_binding public.dispatch_bindings%rowtype;
  v_perm public.permissions%rowtype;
  v_asg public.assignments%rowtype;
  v_inc public.incidents%rowtype;
  v_req_id uuid;
  v_outbox_id uuid;
  v_call_id uuid;
  v_t timestamptz := clock_timestamp();
begin
  if p_provider is null or p_provider not in ('twilio','sarvam') then
    raise exception 'invalid_call_provider' using errcode = '22023';
  end if;
  if p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_payload_hash' using errcode = '22023';
  end if;

  select * into v_existing
  from public.outbox
  where family_id = p_family_id and dedupe_key = p_dedupe_key;

  if v_existing.id is not null then
    select * into v_binding from public.dispatch_bindings where outbox_id = v_existing.id and family_id = p_family_id;
    return jsonb_build_object(
      'status', 'existing',
      'outbox_id', v_existing.id,
      'call_id', v_binding.call_id,
      'action_request_id', v_existing.action_request_id
    );
  end if;

  perform 1 from public.incidents where id = p_incident_id and family_id = p_family_id and person_id = p_subject_person_id;
  if not found then
    return jsonb_build_object('status', 'denied', 'reason', 'incident_not_found');
  end if;

  select * into v_inc from public.incidents where id = p_incident_id and family_id = p_family_id;
  select * into v_asg from public.assignments
  where id = p_assignment_id and family_id = p_family_id and incident_id = p_incident_id
    and person_id = p_responder_person_id and status = 'offered' and expires_at > v_t;
  if v_asg.id is null or v_asg.person_id = v_inc.person_id then
    return jsonb_build_object('status', 'denied', 'reason', 'assignment_not_offered');
  end if;

  select * into v_perm
  from public.permissions q
  where q.family_id = p_family_id
    and q.person_id = p_subject_person_id
    and q.principal_id is not null
    and q.action = 'urgent_responder'
    and q.decision = 'allow'
    and q.revoked_at is null
    and q.two_person_required = false
    and v_t >= q.valid_from and v_t < q.expires_at
    and v_t >= q.period_start and v_t < q.period_end
    and q.used_count < q.max_uses
    and p_subject_person_id::text = any(q.target_ids)
    and exists (
      select 1 from public.atlas_principals ap
      where ap.family_id = p_family_id and ap.id = q.principal_id and ap.revoked_at is null
    )
  order by q.created_at asc, q.id asc
  limit 1
  for update;

  if v_perm.id is null then
    return jsonb_build_object('status', 'denied', 'reason', 'no_permission');
  end if;

  if exists (
    select 1 from public.permissions q
    where q.family_id = p_family_id
      and q.principal_id is not distinct from v_perm.principal_id
      and q.person_id = p_subject_person_id
      and q.action = 'urgent_responder'
      and q.decision = 'deny'
      and q.revoked_at is null
      and v_t >= q.valid_from and v_t < q.expires_at
  ) then
    return jsonb_build_object('status', 'denied', 'reason', 'permission_denied');
  end if;

  update public.permissions
  set used_count = used_count + 1
  where id = v_perm.id and used_count < max_uses;
  if not found then
    return jsonb_build_object('status', 'denied', 'reason', 'limits_exceeded');
  end if;

  insert into public.action_requests (
    family_id, person_id, permission_id, principal_id, action, target_id,
    amount_minor, item_ids, request_fingerprint, status, expires_at,
    two_person_required, consumed_at
  ) values (
    p_family_id, p_subject_person_id, v_perm.id, v_perm.principal_id, 'urgent_responder', p_subject_person_id::text,
    0, '{}', p_payload_hash, 'executed', greatest(v_asg.expires_at, v_t + interval '5 minutes'),
    false, v_t
  ) returning id into v_req_id;

  insert into public.outbox (
    family_id, action_request_id, permission_id, kind, action, incident_id,
    dedupe_key, payload_ciphertext, payload_hash, status
  ) values (
    p_family_id, v_req_id, v_perm.id, 'urgent_responder', 'urgent_responder', p_incident_id,
    p_dedupe_key, p_payload_ciphertext, p_payload_hash, 'pending'
  ) returning id into v_outbox_id;

  insert into public.calls (family_id, person_id, provider, status)
  values (p_family_id, p_responder_person_id, p_provider, 'scheduled')
  returning id into v_call_id;

  perform public.bind_outbox_dispatch(
    p_family_id, v_outbox_id, p_responder_person_id, p_provider,
    case p_provider when 'sarvam' then 'sarvam.outbound_call' else 'twilio.create_call' end,
    v_call_id, p_incident_id, p_assignment_id
  );

  return jsonb_build_object(
    'status', 'ready',
    'outbox_id', v_outbox_id,
    'call_id', v_call_id,
    'action_request_id', v_req_id
  );
end;
$$;

revoke all on function public.prepare_urgent_responder_dispatch(uuid, uuid, uuid, uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.prepare_urgent_responder_dispatch(uuid, uuid, uuid, uuid, uuid, text, text, text, text) to service_role;

-- 2. The responder binding is derived the same way for a Sarvam call: our calls row, our dispatched ledger row with the
--    provider reference Sarvam returned, the immutable outbox binding (incident, assignment, responder) and the request.
create or replace function sahaj_private.derive_responder_binding(p_family_id uuid,p_call_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.calls;l public.dispatch_ledger;b public.dispatch_bindings;a public.assignments;i public.incidents;
  o public.outbox;ar public.action_requests;acct text;
begin
  select * into c from public.calls where id=p_call_id and family_id=p_family_id and provider in ('twilio','sarvam');
  if c.id is null or c.external_id is null then return null; end if;
  select * into l from public.dispatch_ledger where family_id=p_family_id and call_id=c.id and provider=c.provider
    and action=case c.provider when 'sarvam' then 'sarvam.outbound_call' else 'twilio.create_call' end and provider_ref=c.external_id and status in ('dispatched','delivered') and person_id=c.person_id;
  if l.id is null then return null; end if;
  select * into b from public.dispatch_bindings where outbox_id=l.outbox_id and family_id=p_family_id;
  if b.outbox_id is null or b.assignment_id is null or b.incident_id is null or b.action_request_id is null or b.call_id is distinct from c.id
    or b.person_id<>c.person_id then return null; end if;
  select * into a from public.assignments where id=b.assignment_id and family_id=p_family_id;
  select * into i from public.incidents where id=b.incident_id and family_id=p_family_id;
  select * into o from public.outbox where id=b.outbox_id and family_id=p_family_id;
  select * into ar from public.action_requests where id=b.action_request_id and family_id=p_family_id;
  if a.id is null or i.id is null or o.id is null or ar.id is null or a.incident_id<>i.id or a.person_id<>c.person_id
    or o.action_request_id is distinct from ar.id or ar.action<>'urgent_responder'
    or sahaj_private.outbox_action(o.id) is distinct from 'urgent_responder' or a.person_id=i.person_id then return null; end if;
  acct := sahaj_private.dispatch_account(p_family_id,a.person_id,c.provider,c.external_id);
  if acct is null then return null; end if;
  -- person_id is the OFFERED RESPONDER (the person who pressed 1); the incident's subject is carried separately.
  return jsonb_build_object('incident_id',i.id,'assignment_id',a.id,'responder_person_id',a.person_id,'person_id',a.person_id,
    'subject_person_id',i.person_id,'call_id',c.id,'outbox_id',o.id,'action_request_id',ar.id,'action','urgent_responder',
    'provider_action',l.action,'account_id',acct,'dispatch_key',l.idempotency_key);
end$$;
revoke all on function sahaj_private.derive_responder_binding(uuid,uuid) from public,anon,authenticated,service_role;

-- 3. Consume normalized proof from either a signed Twilio Gather press or a bound Sarvam tool decision. Everything else is
--    unchanged from 20261114201600: the binding is re-derived from stored rows and must equal the proof exactly.
create or replace function public.accept_assignment_verified(p_family_id uuid,p_assignment_id uuid,p_provider_event_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare a public.assignments;e public.raw_events;d jsonb;n integer;pers uuid;
begin
  select person_id into pers from public.assignments where id=p_assignment_id and family_id=p_family_id;
  if pers is null then return false; end if;
  perform 1 from public.people p where p.id=pers and p.family_id=p_family_id for no key update;
  select * into a from public.assignments where id=p_assignment_id and family_id=p_family_id for update;
  if a.id is null then return false; end if;
  if a.status='accepted' then return a.verified_by_provider_event=p_provider_event_id; end if;
  if a.status<>'offered' or a.expires_at<=now() then return false; end if;
  select * into e from public.raw_events where id=p_provider_event_id and family_id=p_family_id;
  if e.id is null or not e.normalized_proof or e.event_type<>'responder.accepted' or e.status<>'processed'
    or e.metadata->>'assignment_id' is distinct from a.id::text
    or not ((e.source='twilio' and e.metadata->>'verified_by'='twilio_signature' and e.metadata->>'provider_action'='twilio.create_call')
         or (e.source='sarvam' and e.metadata->>'verified_by'='sarvam_call_binding' and e.metadata->>'provider_action'='sarvam.outbound_call'))
    or coalesce(e.metadata->>'call_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  d := sahaj_private.derive_responder_binding(p_family_id,(e.metadata->>'call_id')::uuid);
  if d is null or (e.metadata-'normalized'-'verified_by'-'source_event_id')<>d or d->>'assignment_id'<>a.id::text then return false; end if;
  update public.assignments set status='accepted',accepted_at=now(),verified_by_provider_event=e.id where id=a.id and status='offered';
  get diagnostics n=row_count;
  return n=1;
end$$;

-- 4. Record a responder's accept/decline from the Sarvam responder agent's tool call. Nothing is trusted from the request
--    except the call it names: the call must be ours (provider sarvam, dispatched, provider_ref recorded), and the binding
--    derived from stored rows must name exactly this incident, assignment and responder. Optional p_provider_call_ref (the
--    Sarvam attempt id) must equal the stored provider_ref. The assignment must still be offered and unexpired.
--    Idempotent per call id: a replay of the same decision returns the same events; the other decision is refused.
create function public.record_sarvam_responder_decision(p_family_id uuid,p_call_id uuid,p_incident_id uuid,
  p_assignment_id uuid,p_responder_person_id uuid,p_decision text,p_provider_call_ref text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.calls;d jsonb;a public.assignments;ev public.raw_events;pid uuid;pevent text;evid text;meta jsonb;
begin
  if p_family_id is null or p_call_id is null or p_incident_id is null or p_assignment_id is null or p_responder_person_id is null
    or p_decision is null or p_decision not in ('accept','decline')
    or (p_provider_call_ref is not null and p_provider_call_ref !~ '^[A-Za-z0-9_.:-]{1,128}$') then
    raise exception 'invalid_decision' using errcode='22023';
  end if;
  select * into c from public.calls where id=p_call_id and family_id=p_family_id and provider='sarvam';
  if c.id is null or c.external_id is null then raise exception 'call_not_ours' using errcode='42501'; end if;
  if p_provider_call_ref is not null and p_provider_call_ref<>c.external_id then raise exception 'call_ref_mismatch' using errcode='42501'; end if;
  perform 1 from public.people p where p.id=c.person_id and p.family_id=p_family_id for no key update;
  d := sahaj_private.derive_responder_binding(p_family_id,c.id);
  if d is null or d->>'provider_action' is distinct from 'sarvam.outbound_call' then raise exception 'call_not_ours' using errcode='42501'; end if;
  if d->>'assignment_id' is distinct from p_assignment_id::text or d->>'incident_id' is distinct from p_incident_id::text
    or d->>'responder_person_id' is distinct from p_responder_person_id::text then
    raise exception 'call_assignment_mismatch' using errcode='42501';
  end if;
  select * into a from public.assignments where id=p_assignment_id and family_id=p_family_id for update;
  evid := 'sarvam:tool:responder_decision:'||c.id;
  pevent := 'responder.accepted:'||a.id;
  select * into ev from public.raw_events where source='sarvam' and provider_event_id=evid and family_id=p_family_id;
  if ev.id is not null then
    if ev.metadata->>'decision' is distinct from p_decision then raise exception 'decision_already_recorded' using errcode='42501'; end if;
    if p_decision='decline' then
      return jsonb_build_object('event_id',ev.id,'assignment_id',a.id,'decision','decline','replayed',true);
    end if;
    select id into pid from public.raw_events where source='sarvam' and provider_event_id=pevent and family_id=p_family_id and normalized_proof;
    if pid is null then raise exception 'proof_missing' using errcode='42501'; end if;
    return jsonb_build_object('proof_event_id',pid,'event_id',ev.id,'assignment_id',a.id,'decision','accept','replayed',true);
  end if;
  if a.status<>'offered' or a.expires_at<=now() then raise exception 'assignment_not_offered' using errcode='42501'; end if;
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status,payload_hash,processed_at)
    values(p_family_id,'sarvam',evid,'sarvam.tool.responder_decision',
      jsonb_build_object('call_id',c.id,'person_id',c.person_id,'decision',p_decision,'incident_id',a.incident_id,'assignment_id',a.id),
      'processed',encode(sha256(convert_to(evid||':'||p_decision,'UTF8')),'hex'),now())
    on conflict(source,provider_event_id) do nothing;
  select * into ev from public.raw_events where source='sarvam' and provider_event_id=evid and family_id=p_family_id;
  if ev.id is null or ev.metadata->>'decision' is distinct from p_decision then raise exception 'decision_conflict' using errcode='23505'; end if;
  if p_decision='decline' then
    return jsonb_build_object('event_id',ev.id,'assignment_id',a.id,'decision','decline','replayed',false);
  end if;
  meta := d||jsonb_build_object('normalized',true,'verified_by','sarvam_call_binding','source_event_id',ev.id);
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status,payload_hash,processed_at,normalized_proof)
    values(p_family_id,'sarvam',pevent,'responder.accepted',meta,'processed',encode(sha256(convert_to(meta::text,'UTF8')),'hex'),now(),true)
    on conflict(source,provider_event_id) do nothing;
  select id into pid from public.raw_events where source='sarvam' and provider_event_id=pevent and family_id=p_family_id and normalized_proof;
  if pid is null then raise exception 'proof_conflict' using errcode='23505'; end if;
  return jsonb_build_object('proof_event_id',pid,'event_id',ev.id,'assignment_id',a.id,'decision','accept','replayed',false);
end$$;
revoke all on function public.record_sarvam_responder_decision(uuid,uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.record_sarvam_responder_decision(uuid,uuid,uuid,uuid,uuid,text,text) to service_role;

-- 5. Keypad voice notes and care notices may be phone calls through Sarvam. The channel is chosen by the trusted
--    server (CALL_PROVIDER) and stored once in the append-only send context, so a replay cannot switch provider.
alter table public.authorized_send_context drop constraint authorized_send_context_channel_check;
alter table public.authorized_send_context add constraint authorized_send_context_channel_check check(channel in ('expo','twilio','sarvam'));
alter table public.authorized_send_context drop constraint authorized_send_context_kind_check;
alter table public.authorized_send_context add constraint authorized_send_context_kind_check check(kind in (
 'core1.voice_notify','core1.missed_call_push','core1.sarvam_message_push','core2.sos_alert',
 'core2.watch_escalation','core2.watch_checkin','core2.reassurance','core2.device_handover',
 'gentle_news.circle_offer','core1.refill_notice','gentle_news.maa_call'));

drop function if exists public.prepare_authorized_send(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,text);
create function public.prepare_authorized_send(p_family_id uuid,p_job_id uuid,p_request_id uuid,p_event_id uuid,
  p_subject_id uuid,p_recipient_id uuid,p_kind text,p_source_id uuid,p_fingerprint text,p_call_provider text default 'twilio') returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.workflow_jobs;c public.authorized_send_context;act text;channel text;rid uuid;
begin
  if p_call_provider is null or p_call_provider not in ('twilio','sarvam') then
    raise exception 'invalid_call_provider' using errcode='22023';
  end if;
  if not sahaj_private.person_in_family(p_family_id,p_subject_id)
    or not sahaj_private.person_in_family(p_family_id,p_recipient_id) then
    raise exception 'send_person_inactive' using errcode='42501';
  end if;
  if p_kind='core1.voice_notify' then
    if not exists(select 1 from public.voice_posts where id=p_source_id and family_id=p_family_id
      and sender_id=p_subject_id and recipient_id=p_recipient_id) then
      raise exception 'voice_post_binding_invalid' using errcode='42501';
    end if;
    select case when device='smartphone' then 'expo' else p_call_provider end into channel from public.people where id=p_recipient_id;
    act:='voice_message';
  elsif p_kind='core1.missed_call_push' then
    if not exists(select 1 from public.timeline_events where entity_id=p_source_id and family_id=p_family_id
      and event_type='core1.missed_call_nudge.requested') then
      raise exception 'nudge_source_binding_invalid' using errcode='42501';
    end if;
    act:='missed_call_nudge'; channel:='expo';
  elsif p_kind='core1.sarvam_message_push' then
    if not exists(select 1 from public.timeline_events where entity_id=p_source_id and family_id=p_family_id
      and event_type='core1.message.transcript') then
      raise exception 'transcript_binding_invalid' using errcode='42501';
    end if;
    act:='voice_message'; channel:='expo';
  else raise exception 'unsupported_send_route' using errcode='22023'; end if;
  insert into public.raw_events(id,family_id,source,provider_event_id,event_type,status,metadata)
    values(p_event_id,p_family_id,'authorized_send',p_event_id::text,p_kind,'processed',jsonb_build_object('person_id',p_subject_id))
    on conflict(id) do nothing;
  insert into public.workflow_jobs(id,family_id,raw_event_id,thread_id,workflow_kind,state,lease_token,lease_until)
    values(p_job_id,p_family_id,p_event_id,'authorized-send:'||p_job_id,p_kind,'processing',gen_random_uuid(),clock_timestamp()+interval '2 minutes')
    on conflict(id) do nothing;
  select * into strict j from public.workflow_jobs where id=p_job_id and family_id=p_family_id for update;
  perform sahaj_private.lock_family_authorization(p_family_id);
  if j.raw_event_id<>p_event_id or j.workflow_kind<>p_kind then raise exception 'send_job_conflict' using errcode='23505'; end if;
  if j.state<>'processing' or j.lease_until<=clock_timestamp() then
    update public.workflow_jobs set state='processing',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes'
      where id=j.id returning * into j;
  end if;
  rid:=public.ensure_action_request(p_family_id,p_job_id,j.lease_token,p_request_id,p_subject_id,act,p_recipient_id::text,p_fingerprint,
    case when act='voice_message' then p_subject_id else null end);
  if rid is null then raise exception 'send_principal_missing' using errcode='42501'; end if;
  insert into public.authorized_send_context(request_id,family_id,kind,source_id,channel)
    values(rid,p_family_id,p_kind,p_source_id,channel) on conflict(request_id) do nothing;
  select * into strict c from public.authorized_send_context where request_id=rid;
  if c.family_id<>p_family_id or c.kind<>p_kind or c.source_id<>p_source_id or c.channel<>channel then
    raise exception 'send_context_conflict' using errcode='23505'; end if;
  return jsonb_build_object('lease',j.lease_token,'channel',channel);
end$$;

drop function if exists public.prepare_care_send(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,text,jsonb);
create function public.prepare_care_send(p_family_id uuid,p_job_id uuid,p_request_id uuid,p_event_id uuid,
 p_subject_id uuid,p_recipient_id uuid,p_kind text,p_source_id uuid,p_fingerprint text,p_details jsonb,p_call_provider text default 'twilio') returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.workflow_jobs;c public.authorized_send_context;act text;channel text;rid uuid;problem text;
begin
 if p_call_provider is null or p_call_provider not in ('twilio','sarvam') then raise exception 'invalid_call_provider' using errcode='22023'; end if;
 if p_kind not in ('core2.sos_alert','core2.watch_escalation','core2.watch_checkin','core2.reassurance','core2.device_handover','gentle_news.circle_offer','core1.refill_notice','gentle_news.maa_call')
  or p_details is null or jsonb_typeof(p_details)<>'object' then raise exception 'unsupported_care_send'; end if;
 if not sahaj_private.person_in_family(p_family_id,p_subject_id) or not sahaj_private.person_in_family(p_family_id,p_recipient_id)
  then raise exception 'send_person_inactive' using errcode='42501'; end if;
 if not exists(select 1 from public.timeline_events t where t.family_id=p_family_id and t.entity_id=p_source_id
   and t.event_type='care.send.requested' and t.payload_canonical::jsonb=jsonb_build_object('kind',p_kind,
     'subjectId',p_subject_id,'recipientId',p_recipient_id,'details',p_details)) then raise exception 'unsigned_care_source' using errcode='42501'; end if;
 act:=case when p_kind='core2.reassurance' then 'share_data' else 'send_alert' end;
 select case when p_kind='gentle_news.maa_call' then p_call_provider when p_kind='core1.refill_notice' or exists(select 1 from public.app_push_tokens t join public.family_memberships m
   on m.family_id=t.family_id and m.user_id=t.user_id and m.person_id=p_recipient_id and m.revoked_at is null where t.family_id=p_family_id)
   then 'expo' else p_call_provider end into channel;
 insert into public.raw_events(id,family_id,source,provider_event_id,event_type,status,metadata)
 values(p_event_id,p_family_id,'authorized_send',p_event_id::text,p_kind,'processed',jsonb_build_object('person_id',p_subject_id)) on conflict(id) do nothing;
 insert into public.workflow_jobs(id,family_id,raw_event_id,thread_id,workflow_kind,state,lease_token,lease_until)
 values(p_job_id,p_family_id,p_event_id,'authorized-send:'||p_job_id,p_kind,'processing',gen_random_uuid(),clock_timestamp()+interval '2 minutes') on conflict(id) do nothing;
 select * into strict j from public.workflow_jobs where id=p_job_id and family_id=p_family_id for update;
 perform sahaj_private.lock_family_authorization(p_family_id);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('core2:dispatch:'||p_family_id,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('core2:device:'||p_family_id||':'||p_subject_id,0));
 if j.raw_event_id<>p_event_id or j.workflow_kind<>p_kind then raise exception 'send_job_conflict'; end if;
 if j.state<>'processing' or j.lease_until<=clock_timestamp() then
  update public.workflow_jobs set state='processing',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes' where id=j.id returning * into j; end if;
 rid:=public.ensure_action_request(p_family_id,p_job_id,j.lease_token,p_request_id,p_subject_id,act,p_recipient_id::text,p_fingerprint,
   case when act='share_data' then p_subject_id else null end);
 if rid is null then raise exception 'send_principal_missing' using errcode='42501'; end if;
 insert into public.authorized_send_context(request_id,family_id,kind,source_id,channel)
 values(rid,p_family_id,p_kind,p_source_id,channel) on conflict(request_id) do nothing;
 select * into strict c from public.authorized_send_context where request_id=rid;
 if c.family_id<>p_family_id or c.kind<>p_kind or c.source_id<>p_source_id then raise exception 'send_context_conflict'; end if;
 insert into public.care_send_context(request_id,details) values(rid,p_details) on conflict(request_id) do nothing;
 if (select details from public.care_send_context where request_id=rid)<>p_details then raise exception 'send_details_conflict'; end if;
 problem:=sahaj_private.care_send_problem(rid);
 if problem is not null then raise exception 'care_send_refused: %',problem using errcode='42501'; end if;
 return jsonb_build_object('lease',j.lease_token,'channel',c.channel);
end$$;

-- Gentle news call to Maa: allowed only while the news row is open and names this sender and Maa.
create or replace function sahaj_private.care_send_problem(p_request_id uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare r public.action_requests;c public.authorized_send_context;d jsonb;tc public.core2_trusted_contacts;purpose text;
begin
 select * into r from public.action_requests where id=p_request_id;
 select * into c from public.authorized_send_context where request_id=r.id;
 select details into d from public.care_send_context where request_id=r.id;
 if d is null then return null; end if;
 if not sahaj_private.person_in_family(c.family_id,r.person_id) or not sahaj_private.person_in_family(c.family_id,r.target_id::uuid) then return 'person_inactive'; end if;
 if c.kind in ('core2.sos_alert','core2.watch_escalation','core2.device_handover') or (c.kind='core2.reassurance' and d->>'trustedContactId' is not null) then
   select * into tc from public.core2_trusted_contacts where id=(d->>'trustedContactId')::uuid and family_id=c.family_id
    and subject_person_id=r.person_id and contact_person_id=r.target_id::uuid;
   purpose:=case when c.kind='core2.reassurance' then 'reassurance' when d->>'sosId' is not null then 'sos' else 'watch_escalation' end;
   if tc.id is null or tc.state<>'active' or tc.approved_at is null or tc.consent_at is null or tc.revoked_at is not null
    or tc.effective_from>clock_timestamp() or tc.effective_until<=clock_timestamp() or not (purpose=any(tc.scopes))
    or not exists(select 1 from public.consents x where x.id=tc.consent_id and x.family_id=c.family_id
      and x.answer and x.created_at=sahaj_private.consent_current(c.family_id,x.person_id,x.purpose)) then return 'contact_consent_required'; end if;
 end if;
 if c.kind='core2.watch_checkin' and r.target_id<>r.person_id::text then return 'checkin_target_invalid'; end if;
 if c.kind in ('core2.sos_alert','core2.watch_escalation','core2.device_handover','core2.watch_checkin') then
   if d->>'watchId' is null and d->>'sosId' is null and d->>'assignmentId' is null then return 'care_source_required'; end if;
   if d->>'watchId' is not null and not exists(select 1 from public.core2_watches w where w.id=(d->>'watchId')::uuid
    and w.family_id=c.family_id and w.subject_person_id=r.person_id and w.state in ('active','checking_in','escalated')) then return 'watch_closed'; end if;
   if d->>'sosId' is not null and not exists(select 1 from public.core2_sos_events s where s.id=(d->>'sosId')::uuid
    and s.family_id=c.family_id and s.subject_person_id=r.person_id and s.status not in ('safe','cancelled','countdown','verified_accepted')) then return 'sos_closed'; end if;
 end if;
 if d->>'assignmentId' is not null and not exists(select 1 from public.assignments a where a.id=(d->>'assignmentId')::uuid
   and a.family_id=c.family_id and a.person_id=r.target_id::uuid and a.incident_id=(d->>'incidentId')::uuid
   and exists(select 1 from public.incidents i where i.id=a.incident_id and i.family_id=c.family_id and i.person_id=r.person_id and i.state in ('open','offered','escalated','reopened')) and a.status='offered' and a.expires_at>clock_timestamp()) then return 'offer_expired'; end if;
 if c.kind='core2.device_handover' and d->>'handoverId' is null then return 'handover_source_required'; end if;
 if d->>'handoverId' is not null and not exists(select 1 from public.core2_device_handovers h
   left join public.core2_device_status ds on ds.family_id=h.family_id and ds.person_id=h.person_id
   where h.id=(d->>'handoverId')::uuid and h.family_id=c.family_id and h.person_id=r.person_id
    and ((h.reason='low_battery' and ds.battery_level<=10) or (h.reason='stale_heartbeat' and (ds.heartbeat_at is null or ds.heartbeat_at<=h.last_seen_at)))
    and h.watch_id is not distinct from (d->>'watchId')::uuid and h.sos_id is not distinct from (d->>'sosId')::uuid
    and ((h.watch_id is not null and exists(select 1 from public.core2_watches w where w.id=h.watch_id and w.state in ('active','checking_in','escalated')))
      or (h.sos_id is not null and exists(select 1 from public.core2_sos_events s where s.id=h.sos_id and s.status not in ('safe','cancelled'))))) then return 'handover_source_closed'; end if;
 if c.kind='core2.reassurance' then
   if exists(select 1 from public.people p where p.id=r.target_id::uuid and p.role='parent')
    and exists(select 1 from public.core2_sharing_preferences p where p.family_id=c.family_id and p.subject_person_id=r.person_id
      and not p.share_status_with_parent) then return 'privacy_changed'; end if;
   if sahaj_private.request_consent(c.family_id,r.person_id,'share_data',r.target_id) is null then return 'consent_required'; end if;
   if d->>'voicePostId' is not null and not exists(select 1 from public.voice_posts v join public.consents x on x.id=v.consent_id
     where v.id=(d->>'voicePostId')::uuid and v.family_id=c.family_id and v.sender_id=r.person_id and v.recipient_id::text=r.target_id
       and v.state<>'failed' and x.family_id=c.family_id and x.person_id=r.person_id and x.answer
       and x.purpose='voice_share:'||r.target_id and x.created_at=sahaj_private.consent_current(c.family_id,r.person_id,x.purpose))
     then return 'voice_post_unusable'; end if;
 end if;
 if c.kind='gentle_news.circle_offer' and not exists(select 1 from public.core2_gentle_news n
   where n.family_id=c.family_id and n.incident_id=(d->>'incidentId')::uuid and n.marked_by_person_id=r.person_id
    and n.circle_person_id=r.target_id::uuid and n.circle_offer_status='offered' and n.status<>'closed') then return 'visitor_offer_closed'; end if;
 if c.kind='gentle_news.circle_offer' and not exists(select 1 from public.circle x where x.family_id=c.family_id and x.person_id=r.target_id::uuid and x.approved_at is not null and x.consent_at is not null and x.revoked_at is null)
   then return 'visitor_consent_required'; end if;
 if c.kind='core1.refill_notice' and not exists(select 1 from public.errands e join public.action_requests a on a.id=e.action_request_id
   where e.id=(d->>'errandId')::uuid and e.family_id=c.family_id and a.person_id=r.person_id
    and e.status in ('authorized','dispatched','completed') and a.consumed_at is not null and a.amount_minor=(d->>'amountMinor')::bigint
    and exists(select 1 from public.family_memberships m where m.family_id=c.family_id and m.person_id=r.target_id::uuid
      and m.role='child' and m.revoked_at is null)) then return 'refill_not_authorized'; end if;
 if c.kind='gentle_news.maa_call' and not exists(select 1 from public.core2_gentle_news n
   where n.family_id=c.family_id and n.incident_id=(d->>'incidentId')::uuid and n.marked_by_person_id=r.person_id
    and n.parent_person_id=r.target_id::uuid and n.status<>'closed') then return 'news_closed'; end if;
 return null;
end$$;

-- The send route for a 'sarvam' channel. Everything else in this function is unchanged from 20261115003000.
create or replace function public.enqueue_authorized_command(p_family_id uuid,p_job_id uuid,p_lease_token uuid,p_action_request_id uuid,
  p_action text,p_dedupe_key text,p_payload_ciphertext text,p_payload_hash text,p_revision text,p_incident_id uuid default null,p_assignment_id uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j public.workflow_jobs;r public.action_requests;p public.permissions;o public.outbox;
  t timestamptz;any_allow boolean;granted integer;block text;route text[];recipient uuid;prov text;pact text;bound_call uuid;asg public.assignments;ctx public.authorized_send_context;
begin
  if p_family_id is null or p_job_id is null or p_lease_token is null or p_action_request_id is null or p_action is null
    or p_dedupe_key is null or length(p_dedupe_key) not between 1 and 256
    or p_payload_ciphertext is null or length(p_payload_ciphertext) not between 1 and 8192
    or p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$' or p_revision is null
    or p_action not in ('check_in','urgent_responder','voice_message','medicine_refill','missed_call_nudge',
      'send_alert','family_report','record_audio','share_data','payment','collect_otp','medical_diagnosis') then
    raise exception 'invalid_enqueue_envelope' using errcode='22023';
  end if;
  select * into j from public.workflow_jobs where id=p_job_id and family_id=p_family_id for update;
  t:=clock_timestamp();
  if j.id is null or j.state<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_until<=t then
    raise exception 'stale_job_lease' using errcode='SJ001';
  end if;
  select * into o from public.outbox where family_id=p_family_id and dedupe_key=p_dedupe_key;
  if o.id is not null then
    if o.workflow_job_id is distinct from p_job_id or o.action is distinct from p_action
      or o.action_request_id is distinct from p_action_request_id or o.payload_hash is distinct from p_payload_hash then
      raise exception 'outbox_conflict' using errcode='23505';
    end if;
    return jsonb_build_object('status','enqueued','outbox_id',o.id,'recovered',true);
  end if;
  if p_action in ('payment','collect_otp','medical_diagnosis') then
    return jsonb_build_object('status','denied','reason','prohibited_action');
  end if;
  -- Blocking acquisitions, in a fixed order: family lock, request row, then permission rows by id.
  perform sahaj_private.lock_family_authorization(p_family_id);
  select * into r from public.action_requests where id=p_action_request_id and family_id=p_family_id
    and workflow_job_id=p_job_id for update;
  if r.id is null or r.action<>p_action then return jsonb_build_object('status','denied','reason','unknown_request'); end if;
  perform 1 from public.permissions q where q.family_id=p_family_id and q.principal_id is not distinct from r.principal_id
    and q.person_id=r.person_id and q.action=p_action order by q.id for update;
  -- All locks held: read the authoritative clock now and reverify the lease.
  t:=clock_timestamp();
  if j.lease_until<=t then raise exception 'stale_job_lease' using errcode='SJ001'; end if;
  if sahaj_private.authorization_revision(p_family_id,r.id) is distinct from p_revision then
    raise exception 'stale_authorization_snapshot' using errcode='40001';
  end if;
  if r.consumed_at is not null or r.status in ('executed','denied','expired','failed') then
    return jsonb_build_object('status','denied','reason','request_not_usable');
  end if;
  if r.expires_at<=t then
    update public.action_requests set status='expired' where id=r.id and status in ('pending','approved');
    return jsonb_build_object('status','denied','reason','request_expired');
  end if;
  if r.target_id is null or r.principal_id is null or not sahaj_private.principal_active(p_family_id,r.principal_id)
    or not sahaj_private.person_in_family(p_family_id,r.person_id) then
    return jsonb_build_object('status','denied','reason','wrong_family');
  end if;
  if r.request_fingerprint is null then return jsonb_build_object('status','denied','reason','invalid_input'); end if;
  if p_action='medicine_refill' and (r.vendor_id is null or coalesce(array_length(r.item_ids,1),0)=0) then
    return jsonb_build_object('status','denied','reason','invalid_input');
  end if;
  if p_action='urgent_responder' and (p_incident_id is null or not exists(select 1 from public.incidents i
      where i.id=p_incident_id and i.family_id=p_family_id and i.person_id=r.person_id)) then
    return jsonb_build_object('status','denied','reason','incident_required');
  end if;
  block:=sahaj_private.permission_block(p_family_id,r.principal_id,r.person_id,p_action);
  if block='deny' then return jsonb_build_object('status','denied','reason','permission_denied'); end if;
  if block='ask' then return jsonb_build_object('status','review','reason','no_permission'); end if;
  select exists(select 1 from public.permissions q where q.family_id=p_family_id and q.principal_id=r.principal_id
    and q.person_id=r.person_id and q.action=p_action and q.decision='allow') into any_allow;
  if not any_allow then return jsonb_build_object('status','review','reason','no_permission'); end if;
  select * into p from public.permissions q
    where q.family_id=p_family_id and q.principal_id=r.principal_id and q.person_id=r.person_id and q.action=p_action
      and q.decision='allow' and q.revoked_at is null and t>=q.valid_from and t<q.expires_at
      and t>=q.period_start and t<q.period_end and q.used_count<q.max_uses and r.target_id=any(q.target_ids)
      and r.amount_minor<=q.max_amount_minor and (r.vendor_id is null or r.vendor_id=any(q.vendor_ids))
      and r.item_ids<@q.item_ids and (r.permission_id is null or q.id=r.permission_id)
    order by q.created_at,q.id limit 1;
  if p.id is null then return jsonb_build_object('status','denied','reason','limits_exceeded'); end if;
  if p_action in ('record_audio','share_data') and (r.consent_subject_id is null
    or sahaj_private.request_consent(p_family_id,r.consent_subject_id,p_action,r.target_id) is null) then
    return jsonb_build_object('status','review','reason','consent_required');
  end if;
  if p.two_person_required or r.two_person_required then
    if exists(select 1 from public.action_answers a where a.family_id=p_family_id and a.action_request_id=r.id and not a.answer) then
      return jsonb_build_object('status','denied','reason','invalid_approval');
    end if;
    select count(distinct a.approver_person_id) into granted from public.action_answers a
      join public.family_memberships m on m.family_id=a.family_id and m.person_id=a.approver_person_id
        and m.revoked_at is null and m.role in ('parent','child')
      where a.family_id=p_family_id and a.action_request_id=r.id and a.answer
        and a.answered_at>=r.created_at and a.answered_at<r.expires_at and a.answered_at<=t;
    if granted<2 then return jsonb_build_object('status','review','reason','approval_required'); end if;
  end if;
  -- Authoritative dispatch route, recipient and provider identity, all from stored rows (never from the caller).
  select * into ctx from public.authorized_send_context where request_id=r.id and family_id=p_family_id;
  if ctx.request_id is not null then
    route:=case when ctx.channel='twilio' then array['twilio','twilio.create_call','true']
      when ctx.channel='sarvam' then array['sarvam','sarvam.outbound_call','true']
      else array['expo','expo.send_push','false'] end;
    if p_action='voice_message' and sahaj_private.consent_current(p_family_id,r.person_id,'voice_share:'||r.target_id) is null then
      return jsonb_build_object('status','review','reason','consent_required'); end if;
  else route:=sahaj_private.dispatch_route(p_action); end if;
  if route is null then return jsonb_build_object('status','denied','reason','no_dispatch_route'); end if;
  prov:=route[1]; pact:=route[2]; recipient:=r.person_id;
  if ctx.request_id is not null then recipient:=r.target_id::uuid; end if;
  if p_action='urgent_responder' then
    select * into asg from public.assignments a where a.id=p_assignment_id and a.family_id=p_family_id
      and a.incident_id=p_incident_id and a.status='offered' and a.expires_at>t and a.person_id<>r.person_id;
    if asg.id is null then return jsonb_build_object('status','denied','reason','assignment_required'); end if;
    recipient:=asg.person_id;
  end if;
  if not sahaj_private.person_in_family(p_family_id,recipient) or (prov<>'expo' and not exists(select 1 from public.provider_identities pi
      where pi.family_id=p_family_id and pi.person_id=recipient and pi.source=prov and pi.binding_kind='contact'
        and pi.enabled and pi.revoked_at is null and pi.contact_ciphertext is not null)) then
    return jsonb_build_object('status','denied','reason','no_provider_identity');
  end if;  -- Final recheck immediately before the atomic mutation, with a fresh clock reading.
  t:=clock_timestamp();
  if j.lease_until<=t then raise exception 'stale_job_lease' using errcode='SJ001'; end if;
  if r.expires_at<=t or p.revoked_at is not null or not (t>=p.valid_from and t<p.expires_at and t>=p.period_start and t<p.period_end) then
    return jsonb_build_object('status','denied','reason','expired_during_authorization');
  end if;
  if p_action in ('record_audio','share_data') and sahaj_private.request_consent(p_family_id,r.consent_subject_id,p_action,r.target_id) is null then
    return jsonb_build_object('status','review','reason','consent_required');
  end if;
  update public.permissions set used_count=used_count+1 where id=p.id and used_count<max_uses;
  if not found then return jsonb_build_object('status','denied','reason','limits_exceeded'); end if;
  update public.action_requests set status='executed',consumed_at=t,permission_id=p.id where id=r.id;
  insert into public.outbox(family_id,workflow_job_id,action_request_id,kind,dedupe_key,payload_ciphertext,payload_hash,action,incident_id,permission_id)
    values(p_family_id,p_job_id,r.id,p_action,p_dedupe_key,p_payload_ciphertext,p_payload_hash,p_action,p_incident_id,p.id) returning * into o;
  -- Same transaction: the call row (if the provider action places a call) and the immutable dispatch binding. A failure
  -- here rolls back the usage reservation, the consumed request and the outbox row together.
  if route[3]='true' then
    insert into public.calls(family_id,person_id,provider,status) values(p_family_id,recipient,prov,'scheduled') returning id into bound_call;
  end if;
  if prov='expo' then
    perform sahaj_private.bind_authorized_push(o.id);
  else
    perform public.bind_outbox_dispatch(p_family_id,o.id,recipient,prov,pact,bound_call,p_incident_id,asg.id);
  end if;
  return jsonb_build_object('status','enqueued','outbox_id',o.id,'recovered',false);
end$$;

revoke all on function public.prepare_authorized_send(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,text,text),
 public.prepare_care_send(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.prepare_authorized_send(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,text,text),
 public.prepare_care_send(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,text,jsonb,text) to service_role;
