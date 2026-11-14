-- Phase 3: atomic authorization/enqueue, fenced workflow jobs, verified delivery proof.
-- Every function is service_role only. No client role can reach any of them.
--
-- Authorization model (see apps/api/src/lib/atlas-runtime/CONTRACTS.md):
--   * The real Cedar policy (packages/gate) is evaluated in the application over a snapshot produced by
--     load_gate_snapshot, which carries a revision token.
--   * enqueue_authorized_command takes a per-family authorization lock, recomputes the revision token over the same
--     facts and rejects any change (40001), then rechecks the hard bounds with one database clock and commits usage
--     reservation, request consumption and the unique outbox row together. SQL here is a safety recheck of the same
--     bounds, never a substitute for the Cedar decision.

-- ---------------------------------------------------------------- server-owned principal (the acting AI actor)
create table public.atlas_principals (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  label text not null check(length(label) between 1 and 80),active boolean not null default true,
  revoked_at timestamptz,created_at timestamptz not null default now(),unique(family_id,id)
);
create unique index atlas_principals_one_active on public.atlas_principals(family_id) where active and revoked_at is null;
alter table public.atlas_principals enable row level security;
revoke all on public.atlas_principals from public,anon,authenticated;
grant all on public.atlas_principals to service_role;

-- ---------------------------------------------------------------- permission limits (fail closed defaults)
alter table public.permissions
  add column principal_id uuid,
  add column valid_from timestamptz not null default now(),
  add column period_start timestamptz not null default now(),
  add column period_end timestamptz not null default now(),
  add column max_uses integer not null default 0 check(max_uses>=0),
  add column used_count integer not null default 0 check(used_count>=0),
  add column max_amount_minor bigint not null default 0 check(max_amount_minor>=0),
  add column target_ids text[] not null default '{}',
  add column vendor_ids text[] not null default '{}',
  add column item_ids text[] not null default '{}',
  add constraint permissions_principal_fk foreign key(family_id,principal_id) references public.atlas_principals(family_id,id),
  add constraint permissions_usage_bound check(used_count<=max_uses),
  add constraint permissions_action_known check(action in ('check_in','urgent_responder','voice_message',
    'medicine_refill','missed_call_nudge','send_alert','family_report','record_audio','share_data',
    'payment','collect_otp','medical_diagnosis'));

alter table public.action_requests
  add column principal_id uuid,
  add column target_id text,
  add column amount_minor bigint not null default 0 check(amount_minor>=0),
  add column vendor_id text,
  add column item_ids text[] not null default '{}',
  add column consent_subject_id uuid,
  add column request_fingerprint text check(request_fingerprint ~ '^[0-9a-f]{64}$'),
  add column workflow_job_id uuid,
  add column consumed_at timestamptz,
  add constraint action_requests_principal_fk foreign key(family_id,principal_id) references public.atlas_principals(family_id,id),
  add constraint action_requests_job_fk foreign key(family_id,workflow_job_id) references public.workflow_jobs(family_id,id),
  add constraint action_requests_job_unique unique(workflow_job_id),
  add constraint action_requests_action_known check(action in ('check_in','urgent_responder','voice_message',
    'medicine_refill','missed_call_nudge','send_alert','family_report','record_audio','share_data',
    'payment','collect_otp','medical_diagnosis')),
  add constraint action_requests_consent_fk foreign key(family_id,consent_subject_id) references public.people(family_id,id);

alter table public.outbox
  add column action text,
  add column incident_id uuid,
  add column permission_id uuid,
  add column payload_hash text check(payload_hash ~ '^[0-9a-f]{64}$'),
  add constraint outbox_incident_fk foreign key(family_id,incident_id) references public.incidents(family_id,id),
  add constraint outbox_permission_fk foreign key(family_id,permission_id) references public.permissions(family_id,id);
create unique index outbox_one_per_action_request on public.outbox(action_request_id) where action_request_id is not null;

-- What an approver saw must be what is executed: request fields are immutable once written.
create function sahaj_private.guard_action_request() returns trigger language plpgsql set search_path='' as $$
begin
  if new.family_id<>old.family_id or new.person_id<>old.person_id or new.action<>old.action
    or new.principal_id is distinct from old.principal_id
    or new.target_id is distinct from old.target_id or new.amount_minor<>old.amount_minor
    or new.vendor_id is distinct from old.vendor_id or new.item_ids<>old.item_ids
    or new.consent_subject_id is distinct from old.consent_subject_id
    or new.request_fingerprint is distinct from old.request_fingerprint
    or new.two_person_required<>old.two_person_required
    or new.workflow_job_id is distinct from old.workflow_job_id or new.expires_at<>old.expires_at
    or (old.permission_id is not null and new.permission_id is distinct from old.permission_id)
    or (old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at) then
    raise exception 'action_request_immutable' using errcode='23000';
  end if;
  return new;
end$$;
revoke all on function sahaj_private.guard_action_request() from public,anon,authenticated;
create trigger action_requests_immutable before update on public.action_requests
  for each row execute function sahaj_private.guard_action_request();

-- ---------------------------------------------------------------- one authorization lock per family
-- Writers of every authorization fact (answers, consents, memberships, permissions, principals) and the enqueue
-- commit take this transaction-scoped lock, so a concurrent refusal/revocation cannot slip in after the check.
create function sahaj_private.lock_family_authorization(p_family_id uuid) returns void
language sql set search_path='' as $$ select pg_advisory_xact_lock(hashtextextended('sahaj.authz:'||p_family_id::text,0)) $$;
create function sahaj_private.authz_write_lock() returns trigger language plpgsql set search_path='' as $$
begin perform sahaj_private.lock_family_authorization(new.family_id); return new; end$$;
revoke all on function sahaj_private.lock_family_authorization(uuid),sahaj_private.authz_write_lock() from public,anon,authenticated;
grant execute on function sahaj_private.lock_family_authorization(uuid) to service_role;
create trigger authz_lock before insert or update on public.action_answers for each row execute function sahaj_private.authz_write_lock();
create trigger authz_lock before insert on public.consents for each row execute function sahaj_private.authz_write_lock();
create trigger authz_lock before insert or update on public.family_memberships for each row execute function sahaj_private.authz_write_lock();
create trigger authz_lock before insert or update on public.permissions for each row execute function sahaj_private.authz_write_lock();
create trigger authz_lock before insert or update on public.atlas_principals for each row execute function sahaj_private.authz_write_lock();

-- ---------------------------------------------------------------- shared helpers
create function sahaj_private.principal_active(p_family_id uuid,p_principal_id uuid) returns boolean
language sql stable set search_path='' as $$
  select exists(select 1 from public.atlas_principals p where p.id=p_principal_id and p.family_id=p_family_id
    and p.active and p.revoked_at is null)
$$;
create function sahaj_private.person_in_family(p_family_id uuid,p_person_id uuid) returns boolean
language sql stable set search_path='' as $$
  select exists(select 1 from public.people p where p.id=p_person_id and p.family_id=p_family_id)
    and not exists(select 1 from public.family_memberships m
      where m.family_id=p_family_id and m.person_id=p_person_id and m.revoked_at is not null)
$$;

-- Maximum age of an affirmative consent. The schema has no expiry column, so this one documented bound is the
-- only finite validity; load_gate_snapshot and the enqueue recheck both read it from here.
create function sahaj_private.consent_max_age() returns interval language sql immutable set search_path='' as $$ select interval '365 days' $$;

-- Newest relevant row wins; equal timestamps resolve to refusal. For a call, only that call's rows and global
-- refusals (call_id null, answer false) are relevant, so another call's grant can never revive a refusal.
create function sahaj_private.consent_current(p_family_id uuid,p_person_id uuid,p_purpose text,p_call_id uuid default null)
returns timestamptz language sql stable set search_path='' as $$
  select case when c.answer and c.version<>'' and c.created_at>now()-sahaj_private.consent_max_age() and c.created_at<=now() then c.created_at end
  from public.consents c where c.family_id=p_family_id and c.person_id=p_person_id and c.purpose=p_purpose
    and (p_call_id is null or c.call_id=p_call_id or (c.call_id is null and not c.answer))
  order by c.created_at desc,c.answer asc limit 1
$$;
-- Same purposes the media service uses: exact-call recording consent, recipient-specific sharing consent.
create function sahaj_private.request_consent(p_family_id uuid,p_subject uuid,p_action text,p_target text) returns timestamptz
language plpgsql stable set search_path='' as $$
begin
  if p_subject is null or p_target is null then return null; end if;
  if p_action='record_audio' then
    if p_target !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
    return sahaj_private.consent_current(p_family_id,p_subject,'call_recording',p_target::uuid);
  elsif p_action='share_data' then
    return sahaj_private.consent_current(p_family_id,p_subject,'voice_share:'||p_target);
  end if;
  return null;
end$$;

-- Live permission rows that are not plain allows. Overlapping deny/ask never lose to an allow.
create function sahaj_private.permission_block(p_family_id uuid,p_principal_id uuid,p_person_id uuid,p_action text) returns text
language sql stable set search_path='' as $$
  select case when bool_or(q.decision='deny') then 'deny' when bool_or(q.decision='ask') then 'ask' end
  from public.permissions q where q.family_id=p_family_id and q.principal_id is not distinct from p_principal_id
    and q.person_id=p_person_id and q.action=p_action and q.decision in ('deny','ask')
    and q.revoked_at is null and q.expires_at>now()
$$;

-- Digest of every fact the authorization decision depends on, including deny/false rows and revocations.
create function sahaj_private.authorization_revision(p_family_id uuid,p_request_id uuid) returns text
language plpgsql stable set search_path='' as $$
declare r public.action_requests;digest text;
begin
  select * into r from public.action_requests where id=p_request_id and family_id=p_family_id;
  if r.id is null then return null; end if;
  select encode(sha256(convert_to(coalesce(string_agg(x,'|' order by x),''),'UTF8')),'hex') into digest from (
    select 'r:'||concat_ws(',',r.status,coalesce(extract(epoch from r.consumed_at)::text,''),coalesce(r.permission_id::text,''),
      extract(epoch from r.expires_at)::text,r.two_person_required::text,coalesce(r.request_fingerprint,''),coalesce(r.principal_id::text,'')) x
    union all
    select 'p:'||concat_ws(',',q.id,q.decision,coalesce(extract(epoch from q.revoked_at)::text,''),extract(epoch from q.expires_at)::text,
      extract(epoch from q.valid_from)::text,extract(epoch from q.period_start)::text,extract(epoch from q.period_end)::text,
      q.used_count,q.max_uses,q.max_amount_minor,q.two_person_required,array_to_string(q.target_ids,';'),
      array_to_string(q.vendor_ids,';'),array_to_string(q.item_ids,';'))
      from public.permissions q where q.family_id=p_family_id and q.person_id=r.person_id and q.action=r.action
        and q.principal_id is not distinct from r.principal_id
    union all
    select 'a:'||concat_ws(',',a.approver_person_id,a.answer::text,extract(epoch from a.answered_at)::text,
        coalesce((select m.role||':'||coalesce(extract(epoch from m.revoked_at)::text,'') from public.family_memberships m
          where m.family_id=a.family_id and m.person_id=a.approver_person_id),'none'))
      from public.action_answers a where a.family_id=p_family_id and a.action_request_id=r.id
    union all
    select 'k:'||(select count(*)||','||coalesce(max(extract(epoch from c.created_at))::text,'') from public.consents c
      where c.family_id=p_family_id and c.person_id=r.consent_subject_id)
      where r.consent_subject_id is not null
    union all
    select 'x:'||concat_ws(',',pr.active::text,coalesce(extract(epoch from pr.revoked_at)::text,''))
      from public.atlas_principals pr where pr.id=r.principal_id and pr.family_id=p_family_id
    union all
    select 's:'||(sahaj_private.person_in_family(p_family_id,r.person_id))::text
  ) t;
  return digest;
end$$;

-- Verified provider facts bound to the exact outbox/request/action/target. Never derived from call status.
create function sahaj_private.outbox_proof(p_outbox_id uuid) returns text
language plpgsql stable set search_path='' as $$
declare o public.outbox;r public.action_requests;kinds text[];
begin
  select * into o from public.outbox where id=p_outbox_id;
  if o.id is null or o.status='pending' or o.attempt_count<1 or o.action_request_id is null then return null; end if;
  select * into r from public.action_requests where id=o.action_request_id and family_id=o.family_id;
  if r.id is null then return null; end if;
  select array_agg(distinct case e.event_type when 'delivery.confirmed' then 'delivered' else 'not_sent' end) into kinds
  from public.raw_events e
  where e.family_id=o.family_id and e.status='processed' and e.source in ('twilio','sarvam','telecmi','whatsapp')
    and e.event_type in ('delivery.confirmed','delivery.not_sent')
    and e.metadata->>'outbox_id'=o.id::text and e.metadata->>'action_request_id'=o.action_request_id::text
    and e.metadata->>'action'=o.action and e.metadata->>'target_id'=r.target_id
    and e.metadata->>'outcome'=case e.event_type when 'delivery.confirmed' then 'delivered' else 'confirmed_not_sent' end;
  if kinds is null then return null; end if;
  if array_length(kinds,1)>1 then return 'conflict'; end if;
  return kinds[1];
end$$;
revoke all on function sahaj_private.principal_active(uuid,uuid),sahaj_private.person_in_family(uuid,uuid),
  sahaj_private.consent_max_age(),sahaj_private.consent_current(uuid,uuid,text,uuid),
  sahaj_private.request_consent(uuid,uuid,text,text),sahaj_private.permission_block(uuid,uuid,uuid,text),
  sahaj_private.authorization_revision(uuid,uuid),sahaj_private.outbox_proof(uuid) from public,anon,authenticated;
grant execute on function sahaj_private.principal_active(uuid,uuid),sahaj_private.person_in_family(uuid,uuid),
  sahaj_private.consent_max_age(),sahaj_private.consent_current(uuid,uuid,text,uuid),
  sahaj_private.request_consent(uuid,uuid,text,text),sahaj_private.permission_block(uuid,uuid,uuid,text),
  sahaj_private.authorization_revision(uuid,uuid),sahaj_private.outbox_proof(uuid) to service_role;

-- ---------------------------------------------------------------- job lease (fencing)
create function public.claim_workflow_jobs_for_kinds(p_worker_id text,p_kinds text[],p_limit integer default 10,p_lease_seconds integer default 120)
returns setof public.workflow_jobs language plpgsql security invoker set search_path='' as $$
begin
  if p_worker_id is null or length(p_worker_id) not between 1 and 120 or p_kinds is null
    or coalesce(array_length(p_kinds,1),0) not between 1 and 20 or p_limit is null or p_lease_seconds is null
    or p_limit not between 1 and 100 or p_lease_seconds not between 10 and 900 then
    raise exception 'invalid_claim_options' using errcode='22023';
  end if;
  update public.workflow_jobs set state='dead',lease_token=null,lease_until=null,worker_id=null,last_error_code='attempt_limit'
    where workflow_kind=any(p_kinds) and attempt_count>=max_attempts and state in ('pending','failed','processing')
      and (lease_until is null or lease_until<now());
  return query with ready as (
    select id from public.workflow_jobs where workflow_kind=any(p_kinds) and attempt_count<max_attempts and (
      (state in ('pending','failed') and retry_at<=now()) or (state='processing' and lease_until<now()))
    order by retry_at,created_at for update skip locked limit p_limit
  ) update public.workflow_jobs j set state='processing',attempt_count=j.attempt_count+1,
    lease_token=gen_random_uuid(),lease_until=now()+make_interval(secs=>p_lease_seconds),worker_id=p_worker_id
    from ready where j.id=ready.id returning j.*;
end$$;

create function public.renew_workflow_lease(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 120)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  if p_lease_seconds is null or p_lease_seconds not between 10 and 900 then
    raise exception 'invalid_lease_options' using errcode='22023';
  end if;
  update public.workflow_jobs set lease_until=now()+make_interval(secs=>p_lease_seconds)
    where id=p_job_id and state='processing' and lease_token=p_lease_token and lease_until>now();
  get diagnostics changed=row_count;
  return changed=1;
end$$;

create function public.dead_letter_raw_event(p_event_id uuid,p_lease_token uuid,p_error_code text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  if p_error_code is null or p_error_code !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'invalid_dead_letter' using errcode='22023';
  end if;
  update public.raw_events set status='dead',last_error_code=p_error_code,lease_token=null,lease_until=null,worker_id=null
    where id=p_event_id and status='processing' and lease_token=p_lease_token and lease_until>now();
  get diagnostics changed=row_count;
  return changed=1;
end$$;

-- ---------------------------------------------------------------- trusted reads
create function public.load_atlas_job(p_family_id uuid,p_job_id uuid,p_lease_token uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare j public.workflow_jobs;e public.raw_events;pid uuid;
begin
  select * into j from public.workflow_jobs where id=p_job_id and family_id=p_family_id;
  if j.id is null or j.state<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_until<=now()
    or j.workflow_kind<>'core1.atlas' then
    raise exception 'stale_job_lease' using errcode='40001';
  end if;
  select * into e from public.raw_events where id=j.raw_event_id and family_id=p_family_id;
  if e.id is null then raise exception 'job_event_missing' using errcode='P0002'; end if;
  select id into pid from public.atlas_principals where family_id=p_family_id and active and revoked_at is null;
  return jsonb_build_object('eventId',e.id,'source',e.source,'providerEventId',e.provider_event_id,
    'eventType',e.event_type,'metadataPersonId',e.metadata->>'person_id','ciphertext',e.payload_ciphertext,
    'principalId',pid,'personActive',sahaj_private.person_in_family(p_family_id,(e.metadata->>'person_id')::uuid));
end$$;

create function public.load_gate_snapshot(p_family_id uuid,p_job_id uuid,p_request_id uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare r public.action_requests;perms jsonb;apps jsonb;cons jsonb:='[]'::jsonb;granted timestamptz;
begin
  select * into r from public.action_requests where id=p_request_id and family_id=p_family_id and workflow_job_id=p_job_id;
  if r.id is null then return jsonb_build_object('found',false); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'familyId',p.family_id,'actorId',p.principal_id,'action',p.action,
      'validFrom',p.valid_from,'expiresAt',p.expires_at,'revokedAt',p.revoked_at,'maxAmountMinor',p.max_amount_minor,
      'vendorIds',p.vendor_ids,'itemIds',p.item_ids,'targetIds',p.target_ids,'periodStart',p.period_start,
      'periodEnd',p.period_end,'maxUses',p.max_uses,'usedCount',p.used_count,
      'approvalMode',case when p.two_person_required or r.two_person_required then 'two_person' else 'setup' end)
      order by p.created_at,p.id),'[]'::jsonb)
    into perms from public.permissions p
    where p.family_id=p_family_id and p.principal_id is not distinct from r.principal_id and p.person_id=r.person_id
      and p.action=r.action and p.decision='allow' and (r.permission_id is null or p.id=r.permission_id);
  select coalesce(jsonb_agg(jsonb_build_object('id',a.approver_person_id::text||':'||a.action_request_id::text,
      'approverId',a.approver_person_id,
      'approverActive',exists(select 1 from public.family_memberships m where m.family_id=p_family_id
        and m.person_id=a.approver_person_id and m.revoked_at is null),
      'approverCanApprove',exists(select 1 from public.family_memberships m where m.family_id=p_family_id
        and m.person_id=a.approver_person_id and m.revoked_at is null and m.role in ('parent','child')),
      'createdAt',a.answered_at,'expiresAt',r.expires_at) order by a.approver_person_id),'[]'::jsonb)
    into apps from public.action_answers a
    where a.family_id=p_family_id and a.action_request_id=r.id and a.answer
      and a.answered_at>=r.created_at and a.answered_at<r.expires_at;
  granted:=sahaj_private.request_consent(p_family_id,r.consent_subject_id,r.action,r.target_id);
  if granted is not null then
    cons:=jsonb_build_array(jsonb_build_object('familyId',p_family_id,'subjectId',r.consent_subject_id,
      'targetId',r.target_id,'scope',r.action,'grantedAt',granted,'expiresAt',granted+sahaj_private.consent_max_age()));
  end if;
  return jsonb_build_object('found',true,'now',now(),'revision',sahaj_private.authorization_revision(p_family_id,r.id),
    'request',jsonb_build_object('id',r.id,'familyId',r.family_id,'action',r.action,'actorId',r.principal_id,'personId',r.person_id,
      'amountMinor',r.amount_minor,'vendorId',r.vendor_id,'itemIds',r.item_ids,'consentSubjectId',r.consent_subject_id,
      'targetId',r.target_id,'status',r.status,'consumed',r.consumed_at is not null,'expired',r.expires_at<=now(),
      'fingerprint',r.request_fingerprint,
      'hasDenial',exists(select 1 from public.action_answers a where a.family_id=p_family_id and a.action_request_id=r.id and not a.answer)),
    'actorActive',r.principal_id is not null and sahaj_private.principal_active(p_family_id,r.principal_id)
      and sahaj_private.person_in_family(p_family_id,r.person_id),
    'block',sahaj_private.permission_block(p_family_id,r.principal_id,r.person_id,r.action),
    'permissions',perms,'approvals',apps,'consents',cons);
end$$;

-- ---------------------------------------------------------------- request creation (idempotent, fenced)
-- Returns null when the family has no active principal: the caller must route to review, not authorize.
create function public.ensure_action_request(p_family_id uuid,p_job_id uuid,p_lease_token uuid,p_request_id uuid,
  p_person_id uuid,p_action text,p_target_id text,p_request_fingerprint text,p_consent_subject_id uuid default null) returns uuid
language plpgsql security invoker set search_path='' as $$
declare j public.workflow_jobs;r public.action_requests;pid uuid;
begin
  if p_request_id is null or p_person_id is null or p_action is null or p_target_id is null or length(p_target_id) not between 1 and 256
    or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_action not in ('check_in','urgent_responder','voice_message','medicine_refill','missed_call_nudge',
      'send_alert','family_report','record_audio','share_data') then
    raise exception 'invalid_action_request' using errcode='22023';
  end if;
  select * into j from public.workflow_jobs where id=p_job_id and family_id=p_family_id for update;
  if j.id is null or j.state<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_until<=now() then
    raise exception 'stale_job_lease' using errcode='40001';
  end if;
  if not sahaj_private.person_in_family(p_family_id,p_person_id) then
    raise exception 'subject_inactive' using errcode='42501';
  end if;
  select id into pid from public.atlas_principals where family_id=p_family_id and active and revoked_at is null;
  if pid is null then return null; end if;
  insert into public.action_requests(id,family_id,person_id,action,expires_at,target_id,workflow_job_id,principal_id,request_fingerprint,consent_subject_id)
    values(p_request_id,p_family_id,p_person_id,p_action,now()+interval '24 hours',p_target_id,p_job_id,pid,p_request_fingerprint,p_consent_subject_id)
    on conflict do nothing;
  select * into r from public.action_requests where workflow_job_id=p_job_id and family_id=p_family_id;
  if r.id is distinct from p_request_id or r.person_id<>p_person_id or r.action<>p_action or r.target_id is distinct from p_target_id
    or r.request_fingerprint is distinct from p_request_fingerprint or r.consent_subject_id is distinct from p_consent_subject_id then
    raise exception 'action_request_conflict' using errcode='23505';
  end if;
  return r.id;
end$$;

-- ---------------------------------------------------------------- atomic authorize+reserve+consume+enqueue
create function public.enqueue_authorized_command(p_family_id uuid,p_job_id uuid,p_lease_token uuid,p_action_request_id uuid,
  p_action text,p_dedupe_key text,p_payload_ciphertext text,p_payload_hash text,p_revision text,p_incident_id uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j public.workflow_jobs;r public.action_requests;p public.permissions;o public.outbox;
  t timestamptz:=now();any_allow boolean;granted integer;block text;
begin
  if p_family_id is null or p_job_id is null or p_lease_token is null or p_action_request_id is null or p_action is null
    or p_dedupe_key is null or length(p_dedupe_key) not between 1 and 256
    or p_payload_ciphertext is null or length(p_payload_ciphertext) not between 1 and 8192
    or p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$' or p_revision is null
    or p_action not in ('check_in','urgent_responder','voice_message','medicine_refill','missed_call_nudge',
      'send_alert','family_report','record_audio','share_data','payment','collect_otp','medical_diagnosis') then
    raise exception 'invalid_enqueue_envelope' using errcode='22023';
  end if;
  -- Fence: only the live lease holder may proceed. The row lock also serializes recovery for this job.
  select * into j from public.workflow_jobs where id=p_job_id and family_id=p_family_id for update;
  if j.id is null or j.state<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_until<=t then
    raise exception 'stale_job_lease' using errcode='40001';
  end if;
  -- Recovery: a previous attempt may have committed but lost its response. Do not charge usage again.
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
  -- Serialize with every writer of authorization facts, then require the facts Cedar saw to be unchanged.
  perform sahaj_private.lock_family_authorization(p_family_id);
  select * into r from public.action_requests where id=p_action_request_id and family_id=p_family_id
    and workflow_job_id=p_job_id for update;
  if r.id is null or r.action<>p_action then return jsonb_build_object('status','denied','reason','unknown_request'); end if;
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
  -- An urgent request needs an existing incident for this subject so acceptance can be proven against it.
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
  -- Lock the permission row before testing the usage counter so concurrent jobs cannot overspend it.
  select * into p from public.permissions q
    where q.family_id=p_family_id and q.principal_id=r.principal_id and q.person_id=r.person_id and q.action=p_action
      and q.decision='allow' and q.revoked_at is null and t>=q.valid_from and t<q.expires_at
      and t>=q.period_start and t<q.period_end and q.used_count<q.max_uses and r.target_id=any(q.target_ids)
      and r.amount_minor<=q.max_amount_minor and (r.vendor_id is null or r.vendor_id=any(q.vendor_ids))
      and r.item_ids<@q.item_ids and (r.permission_id is null or q.id=r.permission_id)
    order by q.created_at,q.id limit 1 for update;
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
        and a.answered_at>=r.created_at and a.answered_at<r.expires_at;
    if granted<2 then return jsonb_build_object('status','review','reason','approval_required'); end if;
  end if;
  -- All guards passed under lock: reserve usage, consume the request/approvals, insert the unique outbox row.
  update public.permissions set used_count=used_count+1 where id=p.id and used_count<max_uses;
  if not found then return jsonb_build_object('status','denied','reason','limits_exceeded'); end if;
  update public.action_requests set status='executed',consumed_at=t,permission_id=p.id where id=r.id;
  insert into public.outbox(family_id,workflow_job_id,action_request_id,kind,dedupe_key,payload_ciphertext,payload_hash,action,incident_id,permission_id)
    values(p_family_id,p_job_id,r.id,p_action,p_dedupe_key,p_payload_ciphertext,p_payload_hash,p_action,p_incident_id,p.id) returning * into o;
  return jsonb_build_object('status','enqueued','outbox_id',o.id,'recovered',false);
end$$;

-- ---------------------------------------------------------------- delivery observation and wake-up
create function public.observe_delivery(p_family_id uuid,p_job_id uuid,p_outbox_id uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare o public.outbox;r public.action_requests;proof text;accepted boolean:=false;
begin
  select * into o from public.outbox where id=p_outbox_id and family_id=p_family_id and workflow_job_id=p_job_id;
  if o.id is null then return jsonb_build_object('verified',false,'status','pending','responderAccepted',false); end if;
  proof:=sahaj_private.outbox_proof(o.id);
  if proof='delivered' then
    select * into r from public.action_requests where id=o.action_request_id and family_id=p_family_id;
    if o.action='urgent_responder' and o.incident_id is not null then
      -- Acceptance: a responder assignment on this request's incident (for this subject) whose verified provider
      -- event names that exact responder, outbox, request and incident. Call completion is never enough.
      accepted:=exists(select 1 from public.assignments a
        join public.incidents i on i.id=a.incident_id and i.family_id=a.family_id and i.person_id=r.person_id
        join public.raw_events e on e.id=a.verified_by_provider_event and e.family_id=a.family_id
        where a.family_id=p_family_id and a.incident_id=o.incident_id and a.status='accepted'
          and a.person_id<>r.person_id and e.status='processed' and e.event_type='responder.accepted'
          and e.source in ('twilio','sarvam','telecmi','whatsapp')
          and e.metadata->>'outbox_id'=o.id::text and e.metadata->>'action_request_id'=r.id::text
          and e.metadata->>'incident_id'=o.incident_id::text and e.metadata->>'responder_person_id'=a.person_id::text);
    end if;
    return jsonb_build_object('verified',true,'status','delivered','responderAccepted',accepted);
  elsif proof='not_sent' or o.status='dead' then
    return jsonb_build_object('verified',true,'status','failed','responderAccepted',false);
  end if;
  -- 'conflict', unknown, or no proof: stay pending. Never infer delivery from outbox completion.
  return jsonb_build_object('verified',false,'status','pending','responderAccepted',false);
end$$;

-- Compare-and-swap wake-up for interrupted jobs whose awaited persisted fact now exists.
-- The workflow still reloads and rechecks every fact; this only schedules it.
create function public.wake_ready_interrupted_jobs(p_limit integer default 20) returns integer
language plpgsql security invoker set search_path='' as $$
declare woken integer;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_wake_options' using errcode='22023'; end if;
  with cand as (
    select j.id,j.interrupt_ref from public.workflow_jobs j
    where j.state='interrupted' and j.interrupt_ref is not null and j.workflow_kind='core1.atlas' and (
      (j.interrupt_ref like 'delivery_pending:%' and exists(select 1 from public.outbox o
        where o.workflow_job_id=j.id and o.family_id=j.family_id
          and (o.status='dead' or sahaj_private.outbox_proof(o.id) in ('delivered','not_sent'))))
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

-- ---------------------------------------------------------------- privileges
revoke all on function public.claim_workflow_jobs_for_kinds(text,text[],integer,integer),
  public.renew_workflow_lease(uuid,uuid,integer),public.dead_letter_raw_event(uuid,uuid,text),
  public.load_atlas_job(uuid,uuid,uuid),public.load_gate_snapshot(uuid,uuid,uuid),
  public.ensure_action_request(uuid,uuid,uuid,uuid,uuid,text,text,text,uuid),
  public.enqueue_authorized_command(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid),
  public.observe_delivery(uuid,uuid,uuid),public.wake_ready_interrupted_jobs(integer) from public,anon,authenticated;
grant execute on function public.claim_workflow_jobs_for_kinds(text,text[],integer,integer),
  public.renew_workflow_lease(uuid,uuid,integer),public.dead_letter_raw_event(uuid,uuid,text),
  public.load_atlas_job(uuid,uuid,uuid),public.load_gate_snapshot(uuid,uuid,uuid),
  public.ensure_action_request(uuid,uuid,uuid,uuid,uuid,text,text,text,uuid),
  public.enqueue_authorized_command(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid),
  public.observe_delivery(uuid,uuid,uuid),public.wake_ready_interrupted_jobs(integer) to service_role;
