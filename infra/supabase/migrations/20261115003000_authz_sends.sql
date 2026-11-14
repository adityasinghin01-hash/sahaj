-- C-14: authorized voice/app notifications. Existing Phase 3 ledger trigger is unchanged.
-- App push has no phone contact identity. Its separate ledger uses the SAME authorization
-- trigger, plus current token/membership checks; phone dispatch retains the contact fence.
create table public.authorized_send_context (
  request_id uuid primary key references public.action_requests(id),
  family_id uuid not null references public.families(id),
  kind text not null check(kind in ('core1.voice_notify','core1.missed_call_push','core1.sarvam_message_push')),
  source_id uuid not null,
  channel text not null check(channel in ('expo','twilio')),
  unique(family_id,request_id)
);
alter table public.authorized_send_context enable row level security;
revoke all on public.authorized_send_context from public,anon,authenticated,service_role;
grant select on public.authorized_send_context to service_role;
-- Append-only context, including for the service role: written only by the preparation RPC.
create function public.prepare_authorized_send(p_family_id uuid,p_job_id uuid,p_request_id uuid,p_event_id uuid,
  p_subject_id uuid,p_recipient_id uuid,p_kind text,p_source_id uuid,p_fingerprint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.workflow_jobs;c public.authorized_send_context;act text;channel text;rid uuid;
begin
  if not sahaj_private.person_in_family(p_family_id,p_subject_id)
    or not sahaj_private.person_in_family(p_family_id,p_recipient_id) then
    raise exception 'send_person_inactive' using errcode='42501';
  end if;
  if p_kind='core1.voice_notify' then
    if not exists(select 1 from public.voice_posts where id=p_source_id and family_id=p_family_id
      and sender_id=p_subject_id and recipient_id=p_recipient_id) then
      raise exception 'voice_post_binding_invalid' using errcode='42501';
    end if;
    select case when device='smartphone' then 'expo' else 'twilio' end into channel from public.people where id=p_recipient_id;
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

-- Only the binding table gains an app transport. The phone ledger and contact fence are unchanged.
alter table public.dispatch_bindings drop constraint dispatch_bindings_provider_check;
alter table public.dispatch_bindings add constraint dispatch_bindings_provider_check
  check(provider in ('sarvam','twilio','whatsapp','telecmi','expo'));
-- Service role cannot insert dispatch_bindings directly. Keep the same definer boundary as
-- Phase 2 bind_outbox_dispatch, but derive the app recipient only from a consumed stored request.
create function sahaj_private.bind_authorized_push(p_outbox_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare o public.outbox;r public.action_requests;
begin
  select * into strict o from public.outbox where id=p_outbox_id;
  select * into strict r from public.action_requests where id=o.action_request_id and family_id=o.family_id;
  if o.status<>'pending' or r.status<>'executed' or r.consumed_at is null or o.action<>r.action
    or o.permission_id is distinct from r.permission_id or o.workflow_job_id is distinct from r.workflow_job_id
    or not exists(select 1 from public.authorized_send_context c where c.request_id=r.id and c.family_id=o.family_id and c.channel='expo') then
    raise exception 'push_binding_not_authorized' using errcode='42501';
  end if;
  insert into public.dispatch_bindings(outbox_id,family_id,person_id,provider,action,action_request_id)
    values(o.id,o.family_id,r.target_id::uuid,'expo','expo.send_push',r.id);
end$$;
revoke all on function sahaj_private.bind_authorized_push(uuid) from public,anon,authenticated;
grant execute on function sahaj_private.bind_authorized_push(uuid) to service_role;

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


create or replace function sahaj_private.dispatch_authorization_problem(p_outbox_id uuid,p_at timestamptz) returns text
language plpgsql stable security definer set search_path='' as $$
declare o public.outbox;r public.action_requests;b public.dispatch_bindings;q public.permissions;granted integer;
begin
  select * into o from public.outbox where id=p_outbox_id;
  if o.id is null then return 'unknown_outbox'; end if;
  select * into r from public.action_requests where id=o.action_request_id and family_id=o.family_id;
  select * into b from public.dispatch_bindings where outbox_id=o.id and family_id=o.family_id;
  if r.id is null or b.outbox_id is null or r.status<>'executed' or r.consumed_at is null or r.action<>o.action then return 'request_or_binding_invalid'; end if;
  if r.expires_at<=p_at then return 'request_expired'; end if;
  if not sahaj_private.principal_active(o.family_id,r.principal_id) or not sahaj_private.person_in_family(o.family_id,b.person_id)
    or not sahaj_private.person_in_family(o.family_id,r.person_id) then return 'principal_or_person_inactive'; end if;
  select * into q from public.permissions p where p.id=o.permission_id and p.family_id=o.family_id;
  if q.id is null or q.decision<>'allow' or q.revoked_at is not null or not (p_at>=q.valid_from and p_at<q.expires_at
    and p_at>=q.period_start and p_at<q.period_end) then return 'permission_not_live'; end if;
  -- The permission's CURRENT scope must still cover the immutable stored request. A permission narrowed or reassigned after
  -- enqueue (other principal/person/action, target, vendor or item lists, amount cap) denies the queued send. Usage is NOT
  -- rechecked: it was reserved once at enqueue (used_count already includes this command) and is never charged again here.
  if q.principal_id is distinct from r.principal_id or q.person_id<>r.person_id or q.action<>r.action
    or r.target_id is null or not (r.target_id=any(q.target_ids))
    or r.amount_minor>q.max_amount_minor
    or (r.vendor_id is not null and not (r.vendor_id=any(q.vendor_ids)))
    or not (r.item_ids<@q.item_ids) then
    return 'permission_scope_changed';
  end if;
  if sahaj_private.permission_block(o.family_id,r.principal_id,r.person_id,r.action) is not null then return 'permission_blocked'; end if;
  if q.two_person_required or r.two_person_required then
    if exists(select 1 from public.action_answers a where a.family_id=o.family_id and a.action_request_id=r.id and not a.answer) then
      return 'approval_refused';
    end if;
    -- Approvals count only while each approver's membership is still current and eligible.
    select count(distinct a.approver_person_id) into granted from public.action_answers a
      join public.family_memberships m on m.family_id=a.family_id and m.person_id=a.approver_person_id
        and m.revoked_at is null and m.role in ('parent','child')
      where a.family_id=o.family_id and a.action_request_id=r.id and a.answer
        and a.answered_at>=r.created_at and a.answered_at<r.expires_at and a.answered_at<=p_at;
    if granted<2 then return 'approval_no_longer_valid'; end if;
  end if;
  if r.action in ('record_audio','share_data') and sahaj_private.request_consent(o.family_id,r.consent_subject_id,r.action,r.target_id) is null then
    return 'consent_required';
  end if;
  if o.action='urgent_responder' and (b.assignment_id is null or not exists(select 1 from public.assignments a
      where a.id=b.assignment_id and a.family_id=o.family_id and a.status='offered' and a.expires_at>p_at)) then
    return 'assignment_not_offered';
  end if;
  if exists(select 1 from public.authorized_send_context c where c.request_id=r.id) and r.action='voice_message'
    and sahaj_private.consent_current(o.family_id,r.person_id,'voice_share:'||r.target_id) is null then
    return 'consent_required';
  end if;
  return null;
end$$;
revoke all on function sahaj_private.dispatch_authorization_problem(uuid,timestamptz) from public,anon,authenticated;
grant execute on function sahaj_private.dispatch_authorization_problem(uuid,timestamptz) to service_role;


-- Additional consent check for notifications, at BOTH phone and push claims. No existing check is removed.
create function sahaj_private.authorized_send_consent() returns trigger language plpgsql security definer set search_path='' as $$
declare r public.action_requests;c public.authorized_send_context;
begin
  perform sahaj_private.lock_family_authorization(new.family_id);
  select r0.* into r from public.outbox o join public.action_requests r0 on r0.id=o.action_request_id where o.id=new.outbox_id;
  select * into c from public.authorized_send_context where request_id=r.id;
  if c.request_id is not null and r.action='voice_message' then
    if sahaj_private.consent_current(new.family_id,r.person_id,'voice_share:'||r.target_id) is null then
      raise exception 'send_consent_required' using errcode='42501'; end if;
    if c.kind='core1.voice_notify' and not exists(select 1 from public.voice_posts v
      where v.id=c.source_id and v.family_id=new.family_id and v.sender_id=r.person_id and v.recipient_id::text=r.target_id
        and v.state<>'failed' and exists(select 1 from public.consents vc where vc.id=v.consent_id and vc.family_id=v.family_id
          and vc.person_id=v.sender_id and vc.answer and vc.purpose='voice_share:'||r.target_id
          and vc.created_at=sahaj_private.consent_current(new.family_id,r.person_id,'voice_share:'||r.target_id))) then raise exception 'voice_post_unusable' using errcode='42501'; end if;
  end if;
  return new;
end$$;
create trigger dispatch_send_consent before insert on public.dispatch_ledger for each row execute function sahaj_private.authorized_send_consent();

create table public.authorized_push_ledger (
  outbox_id uuid primary key references public.outbox(id),family_id uuid not null references public.families(id),
  claimed_at timestamptz not null default clock_timestamp()
);
alter table public.authorized_push_ledger enable row level security;
revoke all on public.authorized_push_ledger from public,anon,authenticated,service_role;
grant select on public.authorized_push_ledger to service_role;
create trigger dispatch_ledger_authorize before insert on public.authorized_push_ledger
  for each row execute function sahaj_private.dispatch_ledger_authorize();
create trigger dispatch_send_consent before insert on public.authorized_push_ledger
  for each row execute function sahaj_private.authorized_send_consent();

-- Scoped outbox claim. A lease is generated by SQL, never by an HTTP handler.
create function public.claim_authorized_send(p_family_id uuid,p_outbox_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.outbox;b public.dispatch_bindings;
begin
  select * into o from public.outbox where id=p_outbox_id and family_id=p_family_id for update;
  perform sahaj_private.lock_family_authorization(p_family_id);
  if o.id is null or not exists(select 1 from public.authorized_send_context where request_id=o.action_request_id) then
    raise exception 'unknown_authorized_send' using errcode='42501'; end if;
  if o.status='processing' and o.lease_until<=clock_timestamp() then
    update public.outbox set status='delivery_unknown',last_error_code='lease_expired' where id=o.id;
    return null;
  end if;
  -- Uncertain sends and failed attempts require explicit reconciliation, never an automatic resend.
  if o.status<>'pending' or o.attempt_count>=o.max_attempts or o.retry_at>clock_timestamp() then return null; end if;
  if sahaj_private.dispatch_authorization_problem(o.id,clock_timestamp()) is not null then
    raise exception 'send_not_authorized' using errcode='42501'; end if;
  select * into strict b from public.dispatch_bindings where outbox_id=o.id;
  update public.outbox set status='processing',attempt_count=attempt_count+1,lease_token=gen_random_uuid(),
    lease_until=clock_timestamp()+interval '2 minutes',worker_id='authorized-send' where id=o.id returning * into o;
  return jsonb_build_object('lease',o.lease_token,'attempt',o.attempt_count,'callId',b.call_id,'personId',b.person_id);
end$$;

-- Token lookup and the durable push claim are one transaction; tokens never enter an outbox payload.
create function public.claim_authorized_push(p_family_id uuid,p_outbox_id uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.outbox;b public.dispatch_bindings;tokens jsonb;
begin
  select * into strict o from public.outbox where id=p_outbox_id and family_id=p_family_id for update;
  perform sahaj_private.lock_family_authorization(p_family_id);
  if o.status<>'processing' or o.lease_token is distinct from p_lease or o.lease_until<=clock_timestamp() then
    raise exception 'stale_outbox_lease' using errcode='42501'; end if;
  select * into strict b from public.dispatch_bindings where outbox_id=o.id and provider='expo' and action='expo.send_push';
  if exists(select 1 from public.authorized_push_ledger where outbox_id=o.id) then return null; end if;
  select coalesce(jsonb_agg(t.expo_token),'[]'::jsonb) into tokens from public.app_push_tokens t
    where t.family_id=p_family_id and exists(select 1 from public.family_memberships m
      where m.family_id=t.family_id and m.user_id=t.user_id and m.person_id=b.person_id and m.revoked_at is null);
  if jsonb_array_length(tokens)=0 then
    update public.outbox set status='pending',attempt_count=greatest(0,attempt_count-1),lease_token=null,lease_until=null,last_error_code='no_push_tokens' where id=o.id;
    return null;
  end if;
  insert into public.authorized_push_ledger(outbox_id,family_id) values(o.id,p_family_id);
  return tokens;
end$$;
revoke all on function public.prepare_authorized_send(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,text),
 public.claim_authorized_send(uuid,uuid),public.claim_authorized_push(uuid,uuid,uuid),
 sahaj_private.authorized_send_consent() from public,anon,authenticated;
grant execute on function public.prepare_authorized_send(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,text),
 public.claim_authorized_send(uuid,uuid),public.claim_authorized_push(uuid,uuid,uuid) to service_role;
