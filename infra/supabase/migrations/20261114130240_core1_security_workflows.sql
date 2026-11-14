-- Core 1 tenant boundaries and durable work. Apply after foundation.
-- No clients may mutate care state: all commands pass through the server permission gate.
create schema if not exists sahaj_private;
revoke all on schema sahaj_private from public, anon, authenticated;
grant usage on schema sahaj_private to authenticated, service_role;

alter table public.people add constraint people_family_identity unique(family_id,id);
alter table public.people add column address_form text;
alter table public.people add column language text not null default 'hi';
alter table public.people add column hearing_notes text;
alter table public.people add column quiet_windows jsonb not null default '[]';
alter table public.people add column free_windows jsonb not null default '[]';
alter table public.families add column category text not null default 'demo';

create table public.family_memberships (
  family_id uuid not null references public.families(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid not null,
  role text not null check(role in ('parent','child','circle')),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(family_id,user_id),
  foreign key(family_id,person_id) references public.people(family_id,id),
  unique(family_id,person_id)
);
alter table public.family_memberships enable row level security;
revoke all on public.family_memberships from anon, authenticated;
grant select on public.family_memberships to authenticated;
create policy membership_self on public.family_memberships for select to authenticated
  using(user_id = (select auth.uid()) and revoked_at is null);

-- Only this private helper bypasses membership RLS; it uses the live, server-managed row.
create function sahaj_private.has_role(p_family_id uuid,p_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.family_memberships m
    where m.family_id=p_family_id and m.user_id=(select auth.uid())
      and m.revoked_at is null and m.role=any(p_roles))
$$;
create function sahaj_private.is_person(p_family_id uuid,p_person_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.family_memberships m
    where m.family_id=p_family_id and m.person_id=p_person_id
      and m.user_id=(select auth.uid()) and m.revoked_at is null)
$$;
revoke all on function sahaj_private.has_role(uuid,text[]),sahaj_private.is_person(uuid,uuid) from public,anon;
grant execute on function sahaj_private.has_role(uuid,text[]),sahaj_private.is_person(uuid,uuid) to authenticated,service_role;

create table public.circle (
  id uuid primary key default gen_random_uuid(), family_id uuid not null references public.families(id),
  person_id uuid not null, rank integer not null check(rank>0), duty_windows jsonb not null default '[]',
  access text not null default 'incident_only' check(access in ('incident_only','family')),
  approved_at timestamptz, consent_at timestamptz, revoked_at timestamptz,
  foreign key(family_id,person_id) references public.people(family_id,id), unique(family_id,person_id)
);
create table public.calls (
  id uuid primary key default gen_random_uuid(), family_id uuid not null references public.families(id),
  person_id uuid not null, provider text not null, external_id text,
  status text not null default 'scheduled' check(status in ('scheduled','ringing','connected','completed','failed','cancelled')),
  ai_disclosed_at timestamptz, recording_consent_at timestamptz,
  started_at timestamptz, ended_at timestamptz, created_at timestamptz not null default now(),
  foreign key(family_id,person_id) references public.people(family_id,id),
  unique(family_id,id),unique(provider,external_id)
);
create table public.consents (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  person_id uuid not null,call_id uuid,turn_id text,
  purpose text not null,question text not null,answer boolean not null,version text not null,
  created_at timestamptz not null default now(),
  foreign key(family_id,person_id) references public.people(family_id,id),
  foreign key(family_id,call_id) references public.calls(family_id,id),unique(family_id,id)
);
create table sahaj_private.call_content (
  family_id uuid not null,call_id uuid not null,consent_id uuid not null,
  transcript_ciphertext text,recording_object_path text,summary_ciphertext text,
  expires_at timestamptz not null,primary key(family_id,call_id),
  foreign key(family_id,call_id) references public.calls(family_id,id),
  foreign key(family_id,consent_id) references public.consents(family_id,id)
);
create table sahaj_private.private_items (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  person_id uuid not null,said_in_call uuid,content_ciphertext text not null,until_at timestamptz not null,
  foreign key(family_id,person_id) references public.people(family_id,id),
  foreign key(family_id,said_in_call) references public.calls(family_id,id)
);
create table public.schedules (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  person_id uuid not null,kind text not null,next_at timestamptz not null,
  timezone text not null default 'Asia/Kolkata',enabled boolean not null default true,
  foreign key(family_id,person_id) references public.people(family_id,id),unique(family_id,id)
);
create table public.requests (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  person_id uuid not null,call_id uuid,kind text not null,
  status text not null default 'pending' check(status in ('pending','approved','denied','running','completed','failed','cancelled')),
  created_at timestamptz not null default now(),
  foreign key(family_id,person_id) references public.people(family_id,id),
  foreign key(family_id,call_id) references public.calls(family_id,id),unique(family_id,id)
);
create table public.incidents (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  person_id uuid not null,request_id uuid,owner_person_id uuid,promised_at timestamptz,
  state text not null default 'open' check(state in ('open','offered','accepted','heard','done','reopened','escalated','closed')),
  severity text not null check(severity in ('routine','urgent','critical')),
  created_at timestamptz not null default now(),
  foreign key(family_id,person_id) references public.people(family_id,id),
  foreign key(family_id,owner_person_id) references public.people(family_id,id),
  foreign key(family_id,request_id) references public.requests(family_id,id),unique(family_id,id)
);
create table public.assignments (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  incident_id uuid not null,person_id uuid not null,
  status text not null default 'offered' check(status in ('offered','accepted','declined','expired','completed')),
  offered_at timestamptz not null default now(),expires_at timestamptz not null,
  accepted_at timestamptz,verified_by_provider_event uuid references public.raw_events(id),
  -- Deliberately no incident narrative, address, transcript or contact data here.
  foreign key(family_id,incident_id) references public.incidents(family_id,id),
  foreign key(family_id,person_id) references public.people(family_id,id),
  check(status <> 'accepted' or (accepted_at is not null and verified_by_provider_event is not null))
);
create table public.voice_posts (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  sender_id uuid not null,recipient_id uuid not null,reply_to uuid,
  state text not null default 'queued' check(state in ('queued','sent','delivered','heard','failed')),
  consent_id uuid not null,created_at timestamptz not null default now(),
  foreign key(family_id,sender_id) references public.people(family_id,id),
  foreign key(family_id,recipient_id) references public.people(family_id,id),
  foreign key(family_id,consent_id) references public.consents(family_id,id),
  unique(family_id,id),foreign key(family_id,reply_to) references public.voice_posts(family_id,id)
);
create table sahaj_private.voice_content (
  family_id uuid not null,voice_post_id uuid not null,object_path text not null,
  expires_at timestamptz not null,primary key(family_id,voice_post_id),
  foreign key(family_id,voice_post_id) references public.voice_posts(family_id,id)
);
create table public.medicines (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  person_id uuid not null,label text not null,remaining_count integer check(remaining_count>=0),
  refill_threshold integer not null default 3 check(refill_threshold>=0),
  instructions_confirmed_by_person boolean not null default false,
  foreign key(family_id,person_id) references public.people(family_id,id),unique(family_id,id)
);
create table public.vendors (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  person_id uuid not null,category text not null,approved_at timestamptz,revoked_at timestamptz,
  foreign key(family_id,person_id) references public.people(family_id,id),unique(family_id,id)
);
create table public.permissions (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  person_id uuid not null,action text not null,decision text not null check(decision in ('allow','deny','ask')),
  limits jsonb not null default '{}',expires_at timestamptz not null,revoked_at timestamptz,
  consent_id uuid not null,two_person_required boolean not null default false,
  foreign key(family_id,person_id) references public.people(family_id,id),
  foreign key(family_id,consent_id) references public.consents(family_id,id),unique(family_id,id)
);
create table public.action_requests (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  person_id uuid not null,permission_id uuid,action text not null,
  status text not null default 'pending' check(status in ('pending','approved','denied','expired','executed','failed')),
  expires_at timestamptz not null,two_person_required boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key(family_id,person_id) references public.people(family_id,id),
  foreign key(family_id,permission_id) references public.permissions(family_id,id),unique(family_id,id)
);
create table public.action_answers (
  family_id uuid not null,action_request_id uuid not null,approver_person_id uuid not null,
  answer boolean not null,answered_at timestamptz not null default now(),
  primary key(family_id,action_request_id,approver_person_id),
  foreign key(family_id,action_request_id) references public.action_requests(family_id,id),
  foreign key(family_id,approver_person_id) references public.people(family_id,id)
);
create table public.errands (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  request_id uuid not null,action_request_id uuid not null,vendor_id uuid,medicine_id uuid,
  status text not null default 'pending' check(status in ('pending','authorized','dispatched','completed','failed','cancelled')),
  foreign key(family_id,request_id) references public.requests(family_id,id),
  foreign key(family_id,action_request_id) references public.action_requests(family_id,id),
  foreign key(family_id,vendor_id) references public.vendors(family_id,id),
  foreign key(family_id,medicine_id) references public.medicines(family_id,id)
);
create table public.nudges (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  person_id uuid not null,kind text not null,scheduled_at timestamptz not null,
  status text not null default 'pending' check(status in ('pending','sent','cancelled','failed')),
  foreign key(family_id,person_id) references public.people(family_id,id)
);
create table public.child_alerts (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  person_id uuid not null,incident_id uuid,kind text not null,acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key(family_id,person_id) references public.people(family_id,id),
  foreign key(family_id,incident_id) references public.incidents(family_id,id)
);

-- Provider identifiers are hashes/opaque provider IDs; plaintext contacts stay encrypted.
create table public.provider_identities (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  person_id uuid not null,source text not null,account_id text not null,external_id_hash text not null,
  binding_kind text not null default 'contact',agent_id text,deployment_id text,attempt_id text,
  contact_ciphertext text,enabled boolean not null default true,revoked_at timestamptz,
  foreign key(family_id,person_id) references public.people(family_id,id),
  unique(source,account_id,external_id_hash,binding_kind)
);

-- Family children see safe operational rows; parent access is limited to their own status/voice.
grant select on public.families to authenticated;
create policy family_child_read on public.families for select to authenticated
  using(sahaj_private.has_role(id,array['child']));
grant select(id,family_id,display_name,role,device,timezone,created_at,language) on public.people to authenticated;
create policy people_family_or_self on public.people for select to authenticated
  using(sahaj_private.has_role(family_id,array['child']) or sahaj_private.is_person(family_id,id));

do $$
declare t text;
begin
  foreach t in array array['circle','calls','consents','schedules','requests','incidents','assignments',
    'voice_posts','medicines','vendors','permissions','action_requests','action_answers','errands','nudges','child_alerts','provider_identities'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
    if t <> 'provider_identities' then
      execute format('grant select on public.%I to authenticated',t);
      execute format('create policy child_family_read on public.%I for select to authenticated using(sahaj_private.has_role(family_id,array[''child'']))',t);
    end if;
    execute format('create index on public.%I(family_id)',t);
  end loop;
end $$;
create policy call_own_status on public.calls for select to authenticated
  using(sahaj_private.has_role(family_id,array['parent']) and sahaj_private.is_person(family_id,person_id));
create policy voice_participant on public.voice_posts for select to authenticated
  using(sahaj_private.is_person(family_id,sender_id) or sahaj_private.is_person(family_id,recipient_id));
create policy assignment_own on public.assignments for select to authenticated
  using(sahaj_private.is_person(family_id,person_id));
-- Shared timeline human_line is private until explicitly redacted server-side. No direct grant.
grant all on public.families,public.people,public.family_memberships,public.raw_events,
  public.idempotency_keys,public.timeline_events to service_role;
alter table sahaj_private.call_content enable row level security;
alter table sahaj_private.private_items enable row level security;
alter table sahaj_private.voice_content enable row level security;
revoke all on all tables in schema sahaj_private from public,anon,authenticated;
grant all on all tables in schema sahaj_private to service_role;

create function sahaj_private.reject_audit_mutation() returns trigger
language plpgsql set search_path='' as $$begin
  raise exception 'append_only_audit' using errcode='23000';
end$$;
revoke all on function sahaj_private.reject_audit_mutation() from public,anon,authenticated;
create trigger consents_append_only before update or delete on public.consents
  for each row execute function sahaj_private.reject_audit_mutation();
create trigger timeline_append_only before update or delete on public.timeline_events
  for each row execute function sahaj_private.reject_audit_mutation();

-- All media is private. Only the authorized backend issues short-lived signed URLs.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('sahaj-voice','sahaj-voice',false,15728640,array['audio/mpeg','audio/wav','audio/ogg','audio/mp4']),
 ('sahaj-recordings','sahaj-recordings',false,52428800,array['audio/mpeg','audio/wav','audio/ogg','audio/mp4']),
 ('sahaj-lines','sahaj-lines',false,5242880,array['audio/mpeg','audio/wav','audio/ogg','audio/mp4'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
-- Restrictive policies prevent a pre-existing broad storage policy from exposing care media.
create policy sahaj_media_server_only on storage.objects as restrictive for all to anon,authenticated
  using(bucket_id not in ('sahaj-voice','sahaj-recordings','sahaj-lines'))
  with check(bucket_id not in ('sahaj-voice','sahaj-recordings','sahaj-lines'));

-- Unknown families never enter the accepted queue. Existing unidentified rows need operator review.
do $$ begin
  if exists(select 1 from public.raw_events where family_id is null) then
    raise exception 'resolve_unidentified_events_before_migration';
  end if;
end $$;
alter table public.raw_events alter column family_id set not null;
alter table public.raw_events drop constraint raw_events_status_check;
alter table public.raw_events add constraint raw_events_status_check
  check(status in ('pending','processing','processed','failed','dead'));
alter table public.raw_events add column payload_hash text;
alter table public.raw_events add column payload_ciphertext text;
alter table public.raw_events add column attempt_count integer not null default 0 check(attempt_count>=0);
alter table public.raw_events add column max_attempts integer not null default 5 check(max_attempts between 1 and 20);
alter table public.raw_events add column retry_at timestamptz not null default now();
alter table public.raw_events add column lease_token uuid;
alter table public.raw_events add column lease_until timestamptz;
alter table public.raw_events add column worker_id text;
alter table public.raw_events add column last_error_code text;
alter table public.raw_events add column processed_at timestamptz;
alter table public.raw_events add constraint raw_events_family_identity unique(family_id,id);
-- Make verification evidence tenant-safe too.
alter table public.assignments drop constraint assignments_verified_by_provider_event_fkey;
alter table public.assignments add foreign key(family_id,verified_by_provider_event)
  references public.raw_events(family_id,id);
create index raw_events_ready_idx on public.raw_events(retry_at,received_at)
  where status in ('pending','failed','processing');

create function public.ingest_raw_event(
  p_source text,p_provider_event_id text,p_event_type text,p_family_id uuid,
  p_metadata jsonb,p_payload_hash text,p_payload_ciphertext text default null
) returns public.raw_events language plpgsql security invoker set search_path='' as $$
declare result public.raw_events;
begin
  if p_family_id is null or p_payload_hash is null or p_source is null or p_provider_event_id is null
    or p_event_type is null or p_metadata is null or p_payload_hash !~ '^[0-9a-f]{64}$'
    or length(p_source) not between 1 and 80 or length(p_provider_event_id) not between 1 and 256
    or length(p_event_type) not between 1 and 120 or jsonb_typeof(p_metadata)<>'object' then
    raise exception 'invalid_ingest_envelope' using errcode='22023';
  end if;
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,payload_hash,payload_ciphertext)
    values(p_family_id,p_source,p_provider_event_id,p_event_type,p_metadata,p_payload_hash,p_payload_ciphertext)
    on conflict(source,provider_event_id) do nothing returning * into result;
  if result.id is null then
    select * into strict result from public.raw_events where source=p_source and provider_event_id=p_provider_event_id;
    if result.family_id<>p_family_id or result.payload_hash is distinct from p_payload_hash
      or result.event_type<>p_event_type then
      raise exception 'provider_event_conflict' using errcode='23505';
    end if;
  end if;
  return result;
end $$;

create function public.claim_raw_events(p_worker_id text,p_limit integer default 10,p_lease_seconds integer default 60)
returns setof public.raw_events language plpgsql security invoker set search_path='' as $$
begin
  if p_worker_id is null or length(p_worker_id) not between 1 and 120
    or p_limit is null or p_lease_seconds is null or p_limit not between 1 and 100 or p_lease_seconds not between 10 and 900 then
    raise exception 'invalid_claim_options' using errcode='22023';
  end if;
  update public.raw_events set status='dead',lease_token=null,lease_until=null,worker_id=null,
    last_error_code='attempt_limit'
    where attempt_count>=max_attempts and status in ('pending','failed','processing')
      and (lease_until is null or lease_until<now());
  return query with ready as (
    select id from public.raw_events
    where attempt_count<max_attempts and (
      (status in ('pending','failed') and retry_at<=now())
      or (status='processing' and lease_until<now()))
    order by retry_at,received_at for update skip locked limit p_limit
  ) update public.raw_events e set status='processing',attempt_count=e.attempt_count+1,
    worker_id=p_worker_id,lease_token=gen_random_uuid(),lease_until=now()+make_interval(secs=>p_lease_seconds)
    from ready where e.id=ready.id returning e.*;
end $$;

create function public.finish_raw_event(p_event_id uuid,p_lease_token uuid,p_success boolean,p_error_code text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  if p_success is null or (p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,80}$') then
    raise exception 'invalid_finish_options' using errcode='22023';
  end if;
  update public.raw_events set
    status=case when p_success then 'processed' when attempt_count>=max_attempts then 'dead' else 'failed' end,
    processed_at=case when p_success then now() else null end,
    retry_at=now()+make_interval(secs=>least(3600,(power(2,attempt_count)*5)::integer)),
    last_error_code=case when p_success then null else coalesce(p_error_code,'processing_failed') end,
    lease_token=null,lease_until=null,worker_id=null
    where id=p_event_id and status='processing' and lease_token=p_lease_token and lease_until>now();
  get diagnostics changed=row_count;
  return changed=1;
end $$;

create table public.workflow_jobs (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  raw_event_id uuid not null,thread_id text not null,workflow_kind text not null,
  state text not null default 'pending' check(state in ('pending','processing','interrupted','completed','failed','dead')),
  checkpoint_ref text,interrupt_ref text,created_at timestamptz not null default now(),
  foreign key(family_id,raw_event_id) references public.raw_events(family_id,id),
  unique(raw_event_id,workflow_kind),unique(family_id,id)
);
create table public.outbox (
  id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),
  workflow_job_id uuid,action_request_id uuid,kind text not null,dedupe_key text not null,
  payload_ciphertext text not null,
  status text not null default 'pending' check(status in ('pending','processing','completed','failed','dead','delivery_unknown')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  max_attempts integer not null default 5 check(max_attempts between 1 and 20),
  retry_at timestamptz not null default now(),lease_token uuid,lease_until timestamptz,worker_id text,
  last_error_code text,created_at timestamptz not null default now(),completed_at timestamptz,
  reconciliation_event_id uuid,
  foreign key(family_id,workflow_job_id) references public.workflow_jobs(family_id,id),
  foreign key(family_id,action_request_id) references public.action_requests(family_id,id),
  foreign key(family_id,reconciliation_event_id) references public.raw_events(family_id,id),
  unique(family_id,dedupe_key)
);
create index outbox_ready_idx on public.outbox(retry_at,created_at) where status in ('pending','failed','processing');
alter table public.workflow_jobs enable row level security;
alter table public.outbox enable row level security;
revoke all on public.workflow_jobs,public.outbox from public,anon,authenticated;
grant all on public.workflow_jobs,public.outbox to service_role;

-- Complete ingestion by creating a durable workflow job and acknowledging the event atomically.
create function public.dispatch_raw_event(p_event_id uuid,p_lease_token uuid,p_workflow_kind text,p_thread_id text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare e public.raw_events;job_id uuid;
begin
  select * into e from public.raw_events where id=p_event_id and status='processing'
    and lease_token=p_lease_token and lease_until>now() for update;
  if e.id is null then raise exception 'stale_event_lease' using errcode='40001'; end if;
  if p_workflow_kind is null or length(p_workflow_kind) not between 1 and 80
    or p_thread_id is null or length(p_thread_id) not between 1 and 256 then
    raise exception 'invalid_workflow_envelope' using errcode='22023';
  end if;
  insert into public.workflow_jobs(family_id,raw_event_id,thread_id,workflow_kind)
    values(e.family_id,e.id,p_thread_id,p_workflow_kind)
    on conflict(raw_event_id,workflow_kind) do update set raw_event_id=excluded.raw_event_id
    returning id into job_id;
  perform public.finish_raw_event(e.id,p_lease_token,true,null);
  return job_id;
end $$;

create function public.claim_outbox(p_worker_id text,p_limit integer default 10,p_lease_seconds integer default 60)
returns setof public.outbox language plpgsql security invoker set search_path='' as $$
begin
  if p_worker_id is null or length(p_worker_id) not between 1 and 120
    or p_limit is null or p_lease_seconds is null or p_limit not between 1 and 100 or p_lease_seconds not between 10 and 900 then
    raise exception 'invalid_claim_options' using errcode='22023';
  end if;
  -- An expired delivery may already have reached the provider. Never automatically resend it.
  update public.outbox set status='delivery_unknown',lease_token=null,lease_until=null,worker_id=null,last_error_code='lease_expired'
    where status='processing' and lease_until<now();
  update public.outbox set status='dead',last_error_code='attempt_limit'
    where attempt_count>=max_attempts and status in ('pending','failed');
  return query with ready as (
    select id from public.outbox where attempt_count<max_attempts and (
      (status in ('pending','failed') and retry_at<=now()))
    order by retry_at,created_at for update skip locked limit p_limit
  ) update public.outbox o set status='processing',attempt_count=o.attempt_count+1,
    worker_id=p_worker_id,lease_token=gen_random_uuid(),lease_until=now()+make_interval(secs=>p_lease_seconds)
    from ready where o.id=ready.id returning o.*;
end $$;
create function public.finish_outbox(p_outbox_id uuid,p_lease_token uuid,p_success boolean,p_error_code text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  if p_success is null or (p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,80}$') then
    raise exception 'invalid_finish_options' using errcode='22023';
  end if;
  update public.outbox set
    status=case when p_success then 'completed' when p_error_code='delivery_unknown' then 'delivery_unknown'
      when attempt_count>=max_attempts then 'dead' else 'failed' end,
    completed_at=case when p_success then now() else null end,
    retry_at=now()+make_interval(secs=>least(3600,(power(2,attempt_count)*5)::integer)),
    last_error_code=case when p_success then null else coalesce(p_error_code,'delivery_failed') end,
    lease_token=null,lease_until=null,worker_id=null
    where id=p_outbox_id and status='processing' and lease_token=p_lease_token and lease_until>now();
  get diagnostics changed=row_count;
  return changed=1;
end $$;

revoke all on function public.ingest_raw_event(text,text,text,uuid,jsonb,text,text),
  public.claim_raw_events(text,integer,integer),public.finish_raw_event(uuid,uuid,boolean,text),
  public.dispatch_raw_event(uuid,uuid,text,text),public.claim_outbox(text,integer,integer),
  public.finish_outbox(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.ingest_raw_event(text,text,text,uuid,jsonb,text,text),
  public.claim_raw_events(text,integer,integer),public.finish_raw_event(uuid,uuid,boolean,text),
  public.dispatch_raw_event(uuid,uuid,text,text),public.claim_outbox(text,integer,integer),
  public.finish_outbox(uuid,uuid,boolean,text) to service_role;

-- Only verified provider evidence may resolve an uncertain outbound delivery.
create function public.reconcile_outbox(p_outbox_id uuid,p_provider_event_id uuid,p_outcome text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  if p_outcome is null or p_outcome not in ('delivered','confirmed_not_sent') then
    raise exception 'invalid_reconciliation_outcome' using errcode='22023';
  end if;
  update public.outbox o set
    status=case when p_outcome='delivered' then 'completed'
      when o.attempt_count>=o.max_attempts then 'dead' else 'failed' end,
    reconciliation_event_id=p_provider_event_id,
    completed_at=case when p_outcome='delivered' then now() else null end,
    last_error_code=null,retry_at=now()
    where o.id=p_outbox_id and o.status='delivery_unknown' and exists(
      select 1 from public.raw_events e where e.id=p_provider_event_id
        and e.family_id=o.family_id and e.status='processed'
        and e.metadata->>'outbox_id'=o.id::text and e.metadata->>'outcome'=p_outcome
        and ((p_outcome='delivered' and e.event_type='delivery.confirmed')
          or (p_outcome='confirmed_not_sent' and e.event_type='delivery.not_sent')));
  get diagnostics changed=row_count;
  return changed=1;
end$$;

alter table public.workflow_jobs add column attempt_count integer not null default 0 check(attempt_count>=0);
alter table public.workflow_jobs add column max_attempts integer not null default 20 check(max_attempts between 1 and 100);
alter table public.workflow_jobs add column retry_at timestamptz not null default now();
alter table public.workflow_jobs add column lease_token uuid;
alter table public.workflow_jobs add column lease_until timestamptz;
alter table public.workflow_jobs add column worker_id text;
alter table public.workflow_jobs add column last_error_code text;
alter table public.workflow_jobs add column resume_payload_ciphertext text;
create index workflow_jobs_ready_idx on public.workflow_jobs(retry_at,created_at) where state in ('pending','failed','processing');
create function public.claim_workflow_jobs(p_worker_id text,p_limit integer default 10,p_lease_seconds integer default 120)
returns setof public.workflow_jobs language plpgsql security invoker set search_path='' as $$
begin
  if p_worker_id is null or length(p_worker_id) not between 1 and 120 or p_limit is null
    or p_lease_seconds is null or p_limit not between 1 and 100 or p_lease_seconds not between 10 and 900 then
    raise exception 'invalid_claim_options' using errcode='22023';
  end if;
  update public.workflow_jobs set state='dead',lease_token=null,lease_until=null,worker_id=null,last_error_code='attempt_limit'
    where attempt_count>=max_attempts and state in ('pending','failed','processing') and (lease_until is null or lease_until<now());
  return query with ready as (
    select id from public.workflow_jobs where attempt_count<max_attempts and (
      (state in ('pending','failed') and retry_at<=now()) or (state='processing' and lease_until<now()))
    order by retry_at,created_at for update skip locked limit p_limit
  ) update public.workflow_jobs j set state='processing',attempt_count=j.attempt_count+1,
    lease_token=gen_random_uuid(),lease_until=now()+make_interval(secs=>p_lease_seconds),worker_id=p_worker_id
    from ready where j.id=ready.id returning j.*;
end$$;
create function public.finish_workflow_job(p_job_id uuid,p_lease_token uuid,p_state text,
  p_checkpoint_ref text default null,p_interrupt_ref text default null,p_error_code text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  if p_state is null or p_state not in ('completed','interrupted','failed')
    or (p_state='interrupted' and (p_checkpoint_ref is null or p_interrupt_ref is null))
    or (p_state<>'interrupted' and p_interrupt_ref is not null)
    or (p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,80}$') then
    raise exception 'invalid_workflow_finish' using errcode='22023';
  end if;
  update public.workflow_jobs set
    state=case when p_state='failed' and attempt_count>=max_attempts then 'dead' else p_state end,
    checkpoint_ref=p_checkpoint_ref,interrupt_ref=p_interrupt_ref,last_error_code=p_error_code,resume_payload_ciphertext=null,
    retry_at=now()+make_interval(secs=>least(3600,(power(2,least(attempt_count,9))*5)::integer)),
    lease_token=null,lease_until=null,worker_id=null
    where id=p_job_id and state='processing' and lease_token=p_lease_token and lease_until>now();
  get diagnostics changed=row_count;
  return changed=1;
end$$;
create function public.resume_workflow_job(p_job_id uuid,p_family_id uuid,p_expected_interrupt_ref text,p_resume_payload_ciphertext text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  -- The server verifies responder identity, Cedar, and input before this compare-and-swap.
  update public.workflow_jobs set state='pending',interrupt_ref=null,retry_at=now(),attempt_count=0,
    resume_payload_ciphertext=p_resume_payload_ciphertext
    where id=p_job_id and family_id=p_family_id and state='interrupted' and interrupt_ref=p_expected_interrupt_ref;
  get diagnostics changed=row_count;
  return changed=1;
end$$;
revoke all on function public.reconcile_outbox(uuid,uuid,text),public.claim_workflow_jobs(text,integer,integer),
  public.finish_workflow_job(uuid,uuid,text,text,text,text),public.resume_workflow_job(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.reconcile_outbox(uuid,uuid,text),public.claim_workflow_jobs(text,integer,integer),
  public.finish_workflow_job(uuid,uuid,text,text,text,text),public.resume_workflow_job(uuid,uuid,text,text) to service_role;

-- Supabase Realtime evaluates subscriber RLS; only safe client-readable tables join publication.
do $$declare t text;begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach t in array array['calls','incidents','voice_posts','child_alerts','action_requests'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
        execute format('alter publication supabase_realtime add table public.%I',t);
      end if;
    end loop;
  end if;
end$$;

do $$declare t text;begin
  foreach t in array array['circle','schedules','assignments','medicines','vendors','permissions',
    'action_answers','errands','nudges','provider_identities'] loop
    execute format('alter table public.%I add column created_at timestamptz not null default now()',t);
  end loop;
end$$;

