-- Phase 3 bridge fixes. Applies after 20261114201600_phase2_dispatch_recording.sql (dispatch_ledger, dispatch_bindings,
-- raw_events.normalized_proof, bind_outbox_dispatch, call_recording_consent) and 20261114210000_phase3_review_fixes.sql.
-- Source only: never executed. The parent integrates the Phase 2 migration first.

-- ---------------------------------------------------------------- authoritative dispatch route (fail closed)
-- Only actions with a defined provider route can be enqueued. Anything else is refused, not guessed.
-- Returns {provider, provider_action, needs_call} or null.
create function sahaj_private.dispatch_route(p_action text) returns text[]
language sql immutable set search_path='' as $$
  select case p_action
    when 'check_in' then array['sarvam','sarvam.outbound_call','true']
    when 'urgent_responder' then array['twilio','twilio.create_call','true']
    when 'family_report' then array['whatsapp','whatsapp.send_text','false']
  end
$$;
revoke all on function sahaj_private.dispatch_route(text) from public,anon,authenticated;
grant execute on function sahaj_private.dispatch_route(text) to service_role;

-- ---------------------------------------------------------------- shared recording consent policy
-- record_audio uses Phase 2's effective call_recording consent function so the enqueue and the recording worker share one
-- policy: exact-call rows plus global refusals, newest wins, ties refuse, no age bound. voice_share keeps the documented
-- max age. Definer, because the Phase 2 function is not executable by service_role.
create or replace function sahaj_private.request_consent(p_family_id uuid,p_subject uuid,p_action text,p_target text) returns timestamptz
language plpgsql stable security definer set search_path='' as $$
declare cid uuid;
begin
  if p_subject is null or p_target is null then return null; end if;
  if p_action='record_audio' then
    if p_target !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
    cid:=sahaj_private.call_recording_consent(p_family_id,p_target::uuid,p_subject);
    if cid is null then return null; end if;
    return (select c.created_at from public.consents c where c.id=cid and c.family_id=p_family_id);
  elsif p_action='share_data' then
    return sahaj_private.consent_current(p_family_id,p_subject,'voice_share:'||p_target);
  end if;
  return null;
end$$;

-- ---------------------------------------------------------------- normalized proof joined to ledger and binding
-- metadata.action is the DOMAIN outbox action; metadata.provider_action is the ledger/binding provider action. The event
-- must be normalized proof (written only by the Phase 2 proof writers) and must join a real same-family ledger row and
-- immutable binding agreeing on key, provider reference, call, outbox, action and recipient, with a verified account.
create or replace function sahaj_private.outbox_proof(p_outbox_id uuid) returns text
language plpgsql stable set search_path='' as $$
declare o public.outbox;kinds text[];
begin
  select * into o from public.outbox where id=p_outbox_id;
  if o.id is null or o.status='pending' or o.attempt_count<1 or o.action_request_id is null then return null; end if;
  select array_agg(distinct case e.event_type when 'delivery.confirmed' then 'delivered' else 'not_sent' end) into kinds
  from public.raw_events e
  join public.dispatch_ledger l on l.family_id=o.family_id and l.outbox_id=o.id and l.idempotency_key=e.metadata->>'dispatch_key'
    and l.provider_ref=e.metadata->>'provider_ref' and l.provider=e.source
  join public.dispatch_bindings b on b.family_id=o.family_id and b.outbox_id=o.id and b.action=l.action and b.provider=l.provider
    and b.person_id=l.person_id and b.call_id is not distinct from l.call_id and b.action_request_id=o.action_request_id
  where e.family_id=o.family_id and e.normalized_proof and e.status='processed' and e.source in ('twilio','sarvam','telecmi','whatsapp')
    and e.event_type in ('delivery.confirmed','delivery.not_sent')
    and e.metadata->>'outbox_id'=o.id::text and e.metadata->>'action_request_id'=o.action_request_id::text
    and e.metadata->>'action'=o.action and e.metadata->>'provider_action'=l.action
    and (e.metadata->>'person_id' is null or e.metadata->>'person_id'=b.person_id::text)
    and (e.metadata->>'call_id' is null or e.metadata->>'call_id'=l.call_id::text)
    and e.metadata->>'outcome'=case e.event_type when 'delivery.confirmed' then 'delivered' else 'confirmed_not_sent' end
    and e.metadata->>'account_id' is not null
    and e.metadata->>'account_id'=sahaj_private.dispatch_account(o.family_id,b.person_id,l.provider,l.provider_ref);
  if kinds is null then return null; end if;
  if array_length(kinds,1)>1 then return 'conflict'; end if;
  return kinds[1];
end$$;

-- Acceptance: metadata.person_id is the RESPONDER (the incident subject is read from the incident, never from the event).
create or replace function sahaj_private.outbox_acceptance(p_outbox_id uuid) returns boolean
language plpgsql stable set search_path='' as $$
declare o public.outbox;r public.action_requests;
begin
  select * into o from public.outbox where id=p_outbox_id;
  if o.id is null or o.action<>'urgent_responder' or o.incident_id is null or o.action_request_id is null then return false; end if;
  select * into r from public.action_requests where id=o.action_request_id and family_id=o.family_id;
  if r.id is null then return false; end if;
  return exists(select 1 from public.assignments a
    join public.incidents i on i.id=a.incident_id and i.family_id=a.family_id and i.person_id=r.person_id
    join public.raw_events e on e.id=a.verified_by_provider_event and e.family_id=a.family_id
    join public.calls c on c.family_id=a.family_id and c.id::text=e.metadata->>'call_id' and c.person_id=a.person_id
      and c.provider='twilio' and c.external_id is not null
    join public.dispatch_ledger l on l.family_id=a.family_id and l.outbox_id=o.id and l.call_id=c.id and l.provider='twilio'
      and l.action='twilio.create_call' and l.provider_ref=c.external_id and l.status in ('dispatched','delivered') and l.person_id=a.person_id
    join public.dispatch_bindings b on b.family_id=a.family_id and b.outbox_id=o.id and b.assignment_id=a.id and b.incident_id=o.incident_id
      and b.person_id=a.person_id and b.call_id=c.id and b.action=l.action and b.action_request_id=r.id
    where a.family_id=o.family_id and a.incident_id=o.incident_id and a.status='accepted' and a.person_id<>r.person_id
      and e.normalized_proof and e.status='processed' and e.event_type='responder.accepted' and e.source='twilio'
      and e.metadata->>'outbox_id'=o.id::text and e.metadata->>'action_request_id'=r.id::text
      and e.metadata->>'action'='urgent_responder' and e.metadata->>'incident_id'=o.incident_id::text
      and e.metadata->>'assignment_id'=a.id::text and e.metadata->>'responder_person_id'=a.person_id::text
      and e.metadata->>'person_id'=a.person_id::text and e.metadata->>'call_id'=c.id::text
      and e.metadata->>'subject_person_id'=i.person_id::text and e.metadata->>'provider_action'=l.action
      and e.metadata->>'dispatch_key'=l.idempotency_key and e.metadata->>'account_id' is not null
      and e.metadata->>'account_id'=sahaj_private.dispatch_account(o.family_id,a.person_id,'twilio',c.external_id));
end$$;

-- ---------------------------------------------------------------- lease-fenced job event read (status and recording jobs)
create function public.load_job_event(p_family_id uuid,p_job_id uuid,p_lease_token uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare j public.workflow_jobs;e public.raw_events;
begin
  select * into j from public.workflow_jobs where id=p_job_id and family_id=p_family_id;
  if j.id is null or j.state<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_until<=clock_timestamp() then
    raise exception 'stale_job_lease' using errcode='SJ001';
  end if;
  select * into e from public.raw_events where id=j.raw_event_id and family_id=p_family_id;
  if e.id is null then raise exception 'job_event_missing' using errcode='P0002'; end if;
  return jsonb_build_object('eventId',e.id,'source',e.source,'providerEventId',e.provider_event_id,'eventType',e.event_type,
    'status',e.metadata->>'status','metadata',e.metadata,'payloadCiphertext',e.payload_ciphertext);
end$$;

-- ---------------------------------------------------------------- dispatch-time authorization recheck (worker tick boundary)
-- Read-only recheck of current facts for a claimed outbox row. The dispatch worker maps `ok` to an ActionAuthorization.
create function public.recheck_dispatch_authorization(p_outbox_id uuid,p_lease_token uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare o public.outbox;r public.action_requests;b public.dispatch_bindings;t timestamptz:=clock_timestamp();
begin
  select * into o from public.outbox where id=p_outbox_id;
  if o.id is null or o.status<>'processing' or o.lease_token is distinct from p_lease_token or o.lease_until<=t then
    return jsonb_build_object('ok',false,'reason','stale_outbox_lease');
  end if;
  select * into r from public.action_requests where id=o.action_request_id and family_id=o.family_id;
  select * into b from public.dispatch_bindings where outbox_id=o.id and family_id=o.family_id;
  if r.id is null or b.outbox_id is null or r.status<>'executed' or r.consumed_at is null or r.action<>o.action
    or not sahaj_private.principal_active(o.family_id,r.principal_id)
    or not sahaj_private.person_in_family(o.family_id,b.person_id) or not sahaj_private.person_in_family(o.family_id,r.person_id) then
    return jsonb_build_object('ok',false,'reason','request_or_binding_invalid');
  end if;
  -- The permission that authorized this command must still be live and unrevoked (a revocation after commit stops fresh attempts).
  if not exists(select 1 from public.permissions q where q.id=o.permission_id and q.family_id=o.family_id and q.decision='allow'
      and q.revoked_at is null and t>=q.valid_from and t<q.expires_at) then
    return jsonb_build_object('ok',false,'reason','permission_not_live');
  end if;
  if sahaj_private.permission_block(o.family_id,r.principal_id,r.person_id,r.action) is not null then
    return jsonb_build_object('ok',false,'reason','permission_blocked');
  end if;
  if r.action in ('record_audio','share_data') and sahaj_private.request_consent(o.family_id,r.consent_subject_id,r.action,r.target_id) is null then
    return jsonb_build_object('ok',false,'reason','consent_required');
  end if;
  return jsonb_build_object('ok',true,'personId',b.person_id,'provider',b.provider,'providerAction',b.action,'callId',b.call_id,
    'domainAction',o.action,'incidentId',b.incident_id,'assignmentId',b.assignment_id);
end$$;
create function public.enqueue_authorized_command(p_family_id uuid,p_job_id uuid,p_lease_token uuid,p_action_request_id uuid,
  p_action text,p_dedupe_key text,p_payload_ciphertext text,p_payload_hash text,p_revision text,p_incident_id uuid default null,p_assignment_id uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j public.workflow_jobs;r public.action_requests;p public.permissions;o public.outbox;
  t timestamptz;any_allow boolean;granted integer;block text;route text[];recipient uuid;prov text;pact text;bound_call uuid;asg public.assignments;
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
  route:=sahaj_private.dispatch_route(p_action);
  if route is null then return jsonb_build_object('status','denied','reason','no_dispatch_route'); end if;
  prov:=route[1]; pact:=route[2]; recipient:=r.person_id;
  if p_action='urgent_responder' then
    select * into asg from public.assignments a where a.id=p_assignment_id and a.family_id=p_family_id
      and a.incident_id=p_incident_id and a.status='offered' and a.expires_at>t and a.person_id<>r.person_id;
    if asg.id is null then return jsonb_build_object('status','denied','reason','assignment_required'); end if;
    recipient:=asg.person_id;
  end if;
  if not sahaj_private.person_in_family(p_family_id,recipient) or not exists(select 1 from public.provider_identities pi
      where pi.family_id=p_family_id and pi.person_id=recipient and pi.source=prov and pi.binding_kind='contact'
        and pi.enabled and pi.revoked_at is null and pi.contact_ciphertext is not null) then
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
  perform public.bind_outbox_dispatch(p_family_id,o.id,recipient,prov,pact,bound_call,p_incident_id,asg.id);
  return jsonb_build_object('status','enqueued','outbox_id',o.id,'recovered',false);
end$$;

-- ---------------------------------------------------------------- privileges
drop function public.enqueue_authorized_command(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid);
revoke all on function public.load_job_event(uuid,uuid,uuid),public.recheck_dispatch_authorization(uuid,uuid),
  public.enqueue_authorized_command(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.load_job_event(uuid,uuid,uuid),public.recheck_dispatch_authorization(uuid,uuid),
  public.enqueue_authorized_command(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid,uuid) to service_role;