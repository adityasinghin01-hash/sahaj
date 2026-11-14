-- Phase 3 review fixes. Applies after 20261114201500_phase3_atomic_orchestration.sql.
-- Source only until the parent runs it on a scratch PostgreSQL database.

-- ---------------------------------------------------------------- 1. authorization lock covers every write path
-- INSERT locks NEW.family_id, DELETE locks OLD.family_id, UPDATE locks both (smaller uuid first) so a tenant
-- reassignment cannot deadlock against itself or slip past the fence.
create or replace function sahaj_private.authz_write_lock() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' then
    perform sahaj_private.lock_family_authorization(new.family_id);
    return new;
  elsif tg_op='DELETE' then
    perform sahaj_private.lock_family_authorization(old.family_id);
    return old;
  end if;
  perform sahaj_private.lock_family_authorization(least(old.family_id,new.family_id));
  if old.family_id<>new.family_id then perform sahaj_private.lock_family_authorization(greatest(old.family_id,new.family_id)); end if;
  return new;
end$$;
drop trigger authz_lock on public.action_answers;
drop trigger authz_lock on public.family_memberships;
drop trigger authz_lock on public.permissions;
drop trigger authz_lock on public.atlas_principals;
drop trigger authz_lock on public.consents;
create trigger authz_lock before insert or update or delete on public.action_answers for each row execute function sahaj_private.authz_write_lock();
create trigger authz_lock before insert or update or delete on public.family_memberships for each row execute function sahaj_private.authz_write_lock();
create trigger authz_lock before insert or update or delete on public.permissions for each row execute function sahaj_private.authz_write_lock();
create trigger authz_lock before insert or update or delete on public.atlas_principals for each row execute function sahaj_private.authz_write_lock();
create trigger authz_lock before insert or update or delete on public.consents for each row execute function sahaj_private.authz_write_lock();

-- Consent cannot be dated in the future by any writer, not only by readers. Taken after the lock above
-- (trigger names sort authz_lock < consents_future) so the check uses the post-lock clock.
create function sahaj_private.reject_future_consent() returns trigger language plpgsql set search_path='' as $$
begin
  if new.created_at>clock_timestamp() then raise exception 'future_consent_rejected' using errcode='22023'; end if;
  return new;
end$$;
revoke all on function sahaj_private.reject_future_consent() from public,anon,authenticated;
create trigger consents_future before insert on public.consents for each row execute function sahaj_private.reject_future_consent();

-- ---------------------------------------------------------------- 2. authoritative clock for consent
create or replace function sahaj_private.consent_current(p_family_id uuid,p_person_id uuid,p_purpose text,p_call_id uuid default null)
returns timestamptz language sql stable set search_path='' as $$
  select case when c.answer and c.version<>'' and c.created_at>clock_timestamp()-sahaj_private.consent_max_age() and c.created_at<=clock_timestamp() then c.created_at end
  from public.consents c where c.family_id=p_family_id and c.person_id=p_person_id and c.purpose=p_purpose
    and (p_call_id is null or c.call_id=p_call_id or (c.call_id is null and not c.answer))
  order by c.created_at desc,c.answer asc limit 1
$$;

-- ---------------------------------------------------------------- 3. fenced timeline append
-- One transaction: lock the job row, require the live lease against the post-lock clock, then append.
-- A worker that lost its lease (even mid-operation) cannot write. errcode SJ001 is distinct from head-CAS 40001.
create function public.append_timeline_event_fenced(p_job_id uuid,p_lease_token uuid,p_event jsonb,p_payload_canonical text,
  p_chain_hash text,p_signature text) returns public.timeline_events
language plpgsql security invoker set search_path='' as $$
declare j public.workflow_jobs;
begin
  if p_event is null or p_job_id is null or p_lease_token is null then raise exception 'invalid_timeline_envelope' using errcode='22023'; end if;
  select * into j from public.workflow_jobs where id=p_job_id for update;
  if j.id is null or j.state<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_until<=clock_timestamp()
    or j.family_id::text is distinct from p_event->>'familyId' then
    raise exception 'stale_job_lease' using errcode='SJ001';
  end if;
  return public.append_timeline_event(p_event,p_payload_canonical,p_chain_hash,p_signature);
end$$;
revoke all on function public.append_timeline_event_fenced(uuid,uuid,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.append_timeline_event_fenced(uuid,uuid,jsonb,text,text,text) to service_role;

-- ---------------------------------------------------------------- 4. interrupt time and evidence binding
alter table public.workflow_jobs add column interrupted_at timestamptz;
create function sahaj_private.stamp_interrupt() returns trigger language plpgsql set search_path='' as $$
begin
  if new.state='interrupted' and old.state is distinct from 'interrupted' then new.interrupted_at:=clock_timestamp(); end if;
  return new;
end$$;
revoke all on function sahaj_private.stamp_interrupt() from public,anon,authenticated;
create trigger workflow_jobs_interrupt_time before update on public.workflow_jobs for each row execute function sahaj_private.stamp_interrupt();

-- The provider account on the proof event must be an enabled, unrevoked identity binding of the exact person.
create function sahaj_private.account_bound(p_family_id uuid,p_person_id uuid,p_source text,p_account text) returns boolean
language sql stable set search_path='' as $$
  select p_account is not null and length(p_account)>0 and exists(select 1 from public.provider_identities pi
    where pi.family_id=p_family_id and pi.person_id=p_person_id and pi.source=p_source and pi.account_id=p_account
      and pi.enabled and pi.revoked_at is null)
$$;
revoke all on function sahaj_private.account_bound(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function sahaj_private.account_bound(uuid,uuid,text,text) to service_role;

-- Delivery proof: normalized event bound to outbox, immutable request, action, ledger dispatch key and the
-- recipient's provider account. Linkage comes from stored rows; callback fields only have to agree with them.
create or replace function sahaj_private.outbox_proof(p_outbox_id uuid) returns text
language plpgsql stable set search_path='' as $$
declare o public.outbox;r public.action_requests;kinds text[];
begin
  select * into o from public.outbox where id=p_outbox_id;
  if o.id is null or o.status='pending' or o.attempt_count<1 or o.action_request_id is null then return null; end if;
  select * into r from public.action_requests where id=o.action_request_id and family_id=o.family_id;
  if r.id is null or r.target_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  select array_agg(distinct case e.event_type when 'delivery.confirmed' then 'delivered' else 'not_sent' end) into kinds
  from public.raw_events e
  where e.family_id=o.family_id and e.status='processed' and e.source in ('twilio','sarvam','telecmi','whatsapp')
    and e.event_type in ('delivery.confirmed','delivery.not_sent')
    and e.metadata->>'outbox_id'=o.id::text and e.metadata->>'action_request_id'=o.action_request_id::text
    and e.metadata->>'action'=o.action and coalesce(e.metadata->>'dispatch_key','')<>''
    and e.metadata->>'outcome'=case e.event_type when 'delivery.confirmed' then 'delivered' else 'confirmed_not_sent' end
    and sahaj_private.account_bound(o.family_id,r.target_id::uuid,e.source,e.metadata->>'account_id');
  if kinds is null then return null; end if;
  if array_length(kinds,1)>1 then return 'conflict'; end if;
  return kinds[1];
end$$;

-- Responder acceptance: exact assignment, incident, responder, call, outbox, request and provider account.
create function sahaj_private.outbox_acceptance(p_outbox_id uuid) returns boolean
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
    join public.calls c on c.family_id=a.family_id and c.id::text=e.metadata->>'call_id' and c.person_id=a.person_id and c.provider=e.source
    where a.family_id=o.family_id and a.incident_id=o.incident_id and a.status='accepted' and a.person_id<>r.person_id
      and e.status='processed' and e.event_type='responder.accepted' and e.source in ('twilio','sarvam','telecmi','whatsapp')
      and e.metadata->>'outbox_id'=o.id::text and e.metadata->>'action_request_id'=r.id::text
      and e.metadata->>'action'='urgent_responder' and e.metadata->>'incident_id'=o.incident_id::text
      and e.metadata->>'assignment_id'=a.id::text and e.metadata->>'responder_person_id'=a.person_id::text
      and e.metadata->>'person_id'=a.person_id::text and c.external_id is not null
      and sahaj_private.account_bound(o.family_id,a.person_id,e.source,e.metadata->>'account_id'));
end$$;
revoke all on function sahaj_private.outbox_acceptance(uuid) from public,anon,authenticated;
grant execute on function sahaj_private.outbox_acceptance(uuid) to service_role;

create or replace function public.observe_delivery(p_family_id uuid,p_job_id uuid,p_outbox_id uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare o public.outbox;proof text;
begin
  select * into o from public.outbox where id=p_outbox_id and family_id=p_family_id and workflow_job_id=p_job_id;
  if o.id is null then return jsonb_build_object('verified',false,'status','pending','responderAccepted',false); end if;
  proof:=sahaj_private.outbox_proof(o.id);
  if proof='delivered' then
    return jsonb_build_object('verified',true,'status','delivered','responderAccepted',sahaj_private.outbox_acceptance(o.id));
  elsif proof='not_sent' or o.status='dead' then
    return jsonb_build_object('verified',true,'status','failed','responderAccepted',false);
  end if;
  return jsonb_build_object('verified',false,'status','pending','responderAccepted',false);
end$$;

-- Wake only on NEW relevant evidence. An urgent job that already saw delivery proof but no acceptance stays
-- interrupted until acceptance, a not-sent proof, a dead outbox, or a relevant event received after the interrupt.
create or replace function public.wake_ready_interrupted_jobs(p_limit integer default 20) returns integer
language plpgsql security invoker set search_path='' as $$
declare woken integer;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_wake_options' using errcode='22023'; end if;
  with cand as (
    select j.id,j.interrupt_ref from public.workflow_jobs j
    where j.state='interrupted' and j.interrupt_ref is not null and j.workflow_kind='core1.atlas' and (
      (j.interrupt_ref like 'delivery_pending:%' and exists(select 1 from public.outbox o
        where o.workflow_job_id=j.id and o.family_id=j.family_id and (
          o.status='dead' or sahaj_private.outbox_proof(o.id)='not_sent'
          or (o.action<>'urgent_responder' and sahaj_private.outbox_proof(o.id)='delivered')
          or (o.action='urgent_responder' and (sahaj_private.outbox_acceptance(o.id)
            or exists(select 1 from public.raw_events e where e.family_id=o.family_id and e.status='processed'
              and e.event_type in ('delivery.confirmed','delivery.not_sent','responder.accepted')
              and e.metadata->>'outbox_id'=o.id::text and j.interrupted_at is not null and e.received_at>j.interrupted_at))))))
      or (j.interrupt_ref like 'review_required:%' and exists(select 1 from public.action_requests r
        where r.workflow_job_id=j.id and r.family_id=j.family_id and r.consumed_at is null and r.expires_at>now()
          and (r.status='approved' or (select count(distinct a.approver_person_id) from public.action_answers a
            where a.family_id=r.family_id and a.action_request_id=r.id and a.answer)>=2))))
    order by j.created_at for update skip locked limit p_limit)
  update public.workflow_jobs j set state='pending',interrupt_ref=null,retry_at=now(),attempt_count=0
    from cand where j.id=cand.id and j.state='interrupted' and j.interrupt_ref=cand.interrupt_ref;
  get diagnostics woken=row_count;
  return woken;
end$$;

-- ---------------------------------------------------------------- 5. enqueue with post-lock clock and final recheck
-- Every statement that can block on a lock (job row, family authorization lock, request row, permission rows in id
-- order) runs BEFORE the authoritative clock is read. Expiries are then rechecked immediately before mutation.
create or replace function public.enqueue_authorized_command(p_family_id uuid,p_job_id uuid,p_lease_token uuid,p_action_request_id uuid,
  p_action text,p_dedupe_key text,p_payload_ciphertext text,p_payload_hash text,p_revision text,p_incident_id uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j public.workflow_jobs;r public.action_requests;p public.permissions;o public.outbox;
  t timestamptz;any_allow boolean;granted integer;block text;
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
  -- Final recheck immediately before the atomic mutation, with a fresh clock reading.
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
  return jsonb_build_object('status','enqueued','outbox_id',o.id,'recovered',false);
end$$;

-- ensure_action_request also reads the clock only after its blocking row lock.
create or replace function public.ensure_action_request(p_family_id uuid,p_job_id uuid,p_lease_token uuid,p_request_id uuid,
  p_person_id uuid,p_action text,p_target_id text,p_request_fingerprint text,p_consent_subject_id uuid default null) returns uuid
language plpgsql security invoker set search_path='' as $$
declare j public.workflow_jobs;r public.action_requests;pid uuid;t timestamptz;
begin
  if p_request_id is null or p_person_id is null or p_action is null or p_target_id is null or length(p_target_id) not between 1 and 256
    or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_action not in ('check_in','urgent_responder','voice_message','medicine_refill','missed_call_nudge',
      'send_alert','family_report','record_audio','share_data') then
    raise exception 'invalid_action_request' using errcode='22023';
  end if;
  select * into j from public.workflow_jobs where id=p_job_id and family_id=p_family_id for update;
  t:=clock_timestamp();
  if j.id is null or j.state<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_until<=t then
    raise exception 'stale_job_lease' using errcode='SJ001';
  end if;
  if not sahaj_private.person_in_family(p_family_id,p_person_id) then
    raise exception 'subject_inactive' using errcode='42501';
  end if;
  select id into pid from public.atlas_principals where family_id=p_family_id and active and revoked_at is null;
  if pid is null then return null; end if;
  insert into public.action_requests(id,family_id,person_id,action,expires_at,target_id,workflow_job_id,principal_id,request_fingerprint,consent_subject_id)
    values(p_request_id,p_family_id,p_person_id,p_action,t+interval '24 hours',p_target_id,p_job_id,pid,p_request_fingerprint,p_consent_subject_id)
    on conflict do nothing;
  select * into r from public.action_requests where workflow_job_id=p_job_id and family_id=p_family_id;
  if r.id is distinct from p_request_id or r.person_id<>p_person_id or r.action<>p_action or r.target_id is distinct from p_target_id
    or r.request_fingerprint is distinct from p_request_fingerprint or r.consent_subject_id is distinct from p_consent_subject_id then
    raise exception 'action_request_conflict' using errcode='23505';
  end if;
  return r.id;
end$$;

-- Lease failure uses the same distinct errcode everywhere so callers never confuse it with a head/snapshot conflict.
create or replace function public.load_atlas_job(p_family_id uuid,p_job_id uuid,p_lease_token uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare j public.workflow_jobs;e public.raw_events;pid uuid;
begin
  select * into j from public.workflow_jobs where id=p_job_id and family_id=p_family_id;
  if j.id is null or j.state<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_until<=clock_timestamp()
    or j.workflow_kind<>'core1.atlas' then
    raise exception 'stale_job_lease' using errcode='SJ001';
  end if;
  select * into e from public.raw_events where id=j.raw_event_id and family_id=p_family_id;
  if e.id is null then raise exception 'job_event_missing' using errcode='P0002'; end if;
  select id into pid from public.atlas_principals where family_id=p_family_id and active and revoked_at is null;
  return jsonb_build_object('eventId',e.id,'source',e.source,'providerEventId',e.provider_event_id,
    'eventType',e.event_type,'metadataPersonId',e.metadata->>'person_id','ciphertext',e.payload_ciphertext,
    'principalId',pid,'personActive',sahaj_private.person_in_family(p_family_id,(e.metadata->>'person_id')::uuid));
end$$;
