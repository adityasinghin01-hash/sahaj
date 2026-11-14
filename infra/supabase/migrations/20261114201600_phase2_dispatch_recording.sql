-- Phase 2: durable dispatch ledger with immutable authorized bindings, normalized verified proof, responder acceptance,
-- first-recording policy and bounded recording purge. Every function is service-role only. Clients never reach these tables.
-- Apply after 20261114141830_checkpoint_media_metadata.sql. NOT applied anywhere yet: run infra/supabase/tests/phase2_dispatch_recording.sql on a scratch database first.
--
-- Lock order used by every writer in this file (and required of other writers of the same data):
--   people (FOR NO KEY UPDATE) -> calls (FOR UPDATE) -> call_content / assignments / ledger rows.
-- The consents insert trigger takes the first lock, so a new refusal cannot slip between a consent read and a write.

alter table public.outbox add constraint outbox_family_identity unique(family_id,id);
alter table public.assignments add constraint assignments_family_identity unique(family_id,id);
-- One provider event can verify at most one assignment.
create unique index assignments_verified_event_idx on public.assignments(verified_by_provider_event)
  where verified_by_provider_event is not null;

------------------------------------------------------------------ consent writers
-- Future-dated consent is refused at the writer, not only by readers. The trigger also takes the person lock that
-- put_call_recording and the purge functions use, so consent history cannot gain a row mid-decision.
create function sahaj_private.consents_before_insert() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.created_at > now() then raise exception 'future_consent' using errcode='23514'; end if;
  perform 1 from public.people p where p.id=new.person_id and p.family_id=new.family_id for no key update;
  return new;
end$$;
revoke all on function sahaj_private.consents_before_insert() from public,anon,authenticated;
create trigger consents_serialize before insert on public.consents for each row execute function sahaj_private.consents_before_insert();

-- Effective call_recording consent for one call: the newest row among that call's rows and global refusals;
-- equal timestamps resolve to refusal; global yes rows never count. Returns the consent id, or null.
create function sahaj_private.call_recording_consent(p_family_id uuid,p_call_id uuid,p_person_id uuid)
returns uuid language sql stable security definer set search_path='' as $$
  select r.id from (
    select x.id,x.answer,x.version from public.consents x
    where x.family_id=p_family_id and x.person_id=p_person_id and x.purpose='call_recording' and x.created_at<=now()
      and (x.call_id=p_call_id or (x.call_id is null and x.answer=false))
    order by x.created_at desc,x.answer asc limit 1
  ) r where r.answer is true and length(r.version)>0
$$;
revoke all on function sahaj_private.call_recording_consent(uuid,uuid,uuid) from public,anon,authenticated;

------------------------------------------------------------------ proof marker on raw_events
-- Only the proof-writer functions below may create normalized proof. Provider callbacks stay raw.
alter table public.raw_events add column normalized_proof boolean not null default false;
create function sahaj_private.guard_normalized_proof() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' then
    if new.normalized_proof and coalesce(current_setting('sahaj.proof_writer',true),'')<>'1' then
      raise exception 'proof_writer_required' using errcode='42501';
    end if;
  elsif new.normalized_proof is distinct from old.normalized_proof then
    raise exception 'proof_flag_immutable' using errcode='42501';
  end if;
  return new;
end$$;
revoke all on function sahaj_private.guard_normalized_proof() from public,anon,authenticated;
create trigger raw_events_guard_proof before insert or update on public.raw_events for each row execute function sahaj_private.guard_normalized_proof();

------------------------------------------------------------------ ledger and immutable bindings
create table public.dispatch_bindings (
  outbox_id uuid primary key,
  family_id uuid not null references public.families(id),
  person_id uuid not null,
  provider text not null check(provider in ('sarvam','twilio','whatsapp','telecmi')),
  action text not null check(action ~ '^[a-z0-9_.]{1,80}$'),
  call_id uuid,
  incident_id uuid,
  assignment_id uuid,
  action_request_id uuid,
  created_at timestamptz not null default now(),
  check(split_part(action,'.',1)=provider),
  foreign key(family_id,outbox_id) references public.outbox(family_id,id),
  foreign key(family_id,person_id) references public.people(family_id,id),
  foreign key(family_id,call_id) references public.calls(family_id,id),
  foreign key(family_id,incident_id) references public.incidents(family_id,id),
  foreign key(family_id,assignment_id) references public.assignments(family_id,id),
  foreign key(family_id,action_request_id) references public.action_requests(family_id,id)
);
alter table public.dispatch_bindings add constraint dispatch_bindings_family_outbox unique(family_id,outbox_id);
create trigger dispatch_bindings_immutable before update or delete on public.dispatch_bindings
  for each row execute function sahaj_private.reject_audit_mutation();

create table public.dispatch_ledger (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id),
  person_id uuid not null,
  idempotency_key text not null check(idempotency_key ~ '^[A-Za-z0-9:_.-]{8,128}$'),
  provider text not null check(provider in ('sarvam','twilio','whatsapp','telecmi')),
  action text not null check(action ~ '^[a-z0-9_.]{1,80}$'),
  outbox_id uuid not null,
  call_id uuid,
  status text not null default 'claimed'
    check(status in ('claimed','dispatched','failed','delivery_unknown','delivered','not_sent')),
  provider_ref text check(provider_ref is null or length(provider_ref) between 1 and 256),
  last_error_code text check(last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,80}$'),
  reconciliation_event_id uuid,
  claimed_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key(family_id,person_id) references public.people(family_id,id),
  foreign key(family_id,outbox_id) references public.dispatch_bindings(family_id,outbox_id),
  foreign key(family_id,call_id) references public.calls(family_id,id),
  foreign key(family_id,reconciliation_event_id) references public.raw_events(family_id,id),
  unique(family_id,idempotency_key),
  unique(family_id,id)
);
create unique index dispatch_ledger_provider_ref_idx on public.dispatch_ledger(provider,provider_ref) where provider_ref is not null;
-- One live (non-failed) dispatch per outbox row, whatever key was used.
create unique index dispatch_ledger_live_outbox_idx on public.dispatch_ledger(family_id,outbox_id) where status not in ('failed','not_sent');
create index dispatch_ledger_claimed_idx on public.dispatch_ledger(claimed_at) where status='claimed';
alter table public.dispatch_ledger enable row level security;
alter table public.dispatch_bindings enable row level security;
-- Supabase default privileges may already grant ALL to service_role: revoke explicitly, then grant SELECT only.
revoke all on public.dispatch_ledger,public.dispatch_bindings from public,anon,authenticated,service_role;
grant select on public.dispatch_ledger,public.dispatch_bindings to service_role;

------------------------------------------------------------------ binding writer (called by the enqueue transaction)
-- The trusted enqueue path (Phase 3 atomic enqueue) records WHO may be contacted, by WHICH provider action, for WHICH call,
-- once, when the outbox row is created. A valid outbox lease alone never authorizes another target.
create function public.bind_outbox_dispatch(p_family_id uuid,p_outbox_id uuid,p_person_id uuid,p_provider text,p_action text,
  p_call_id uuid default null,p_incident_id uuid default null,p_assignment_id uuid default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare o public.outbox;b public.dispatch_bindings;a public.assignments;n integer;inc uuid := p_incident_id;
begin
  if p_family_id is null or p_outbox_id is null or p_person_id is null or p_provider is null or p_action is null
    or p_provider not in ('sarvam','twilio','whatsapp','telecmi') or split_part(p_action,'.',1)<>p_provider then
    raise exception 'invalid_binding' using errcode='22023';
  end if;
  select * into o from public.outbox where id=p_outbox_id and family_id=p_family_id;
  if o.id is null then raise exception 'unknown_outbox' using errcode='42501'; end if;
  if p_assignment_id is not null then
    select * into a from public.assignments where id=p_assignment_id and family_id=p_family_id;
    if a.id is null or a.person_id<>p_person_id or (p_incident_id is not null and a.incident_id<>p_incident_id) then
      raise exception 'assignment_mismatch' using errcode='42501';
    end if;
    inc := a.incident_id;
  end if;
  insert into public.dispatch_bindings(outbox_id,family_id,person_id,provider,action,call_id,incident_id,assignment_id,action_request_id)
    values(p_outbox_id,p_family_id,p_person_id,p_provider,p_action,p_call_id,inc,p_assignment_id,o.action_request_id)
    on conflict(outbox_id) do nothing;
  get diagnostics n=row_count;
  if n=1 then return true; end if;
  select * into b from public.dispatch_bindings where outbox_id=p_outbox_id;
  if b.family_id<>p_family_id or b.person_id<>p_person_id or b.provider<>p_provider or b.action<>p_action
    or b.call_id is distinct from p_call_id or b.assignment_id is distinct from p_assignment_id
    or b.incident_id is distinct from inc then
    raise exception 'binding_conflict' using errcode='23505';
  end if;
  return true;
end$$;

------------------------------------------------------------------ dispatch ledger
-- Atomic claim BEFORE any network call. The target, provider, action and call must equal the immutable binding of the
-- outbox row. Returns 'claimed' or 'duplicate'.
create function public.claim_dispatch(
  p_family_id uuid,p_person_id uuid,p_key text,p_provider text,p_action text,
  p_outbox_id uuid,p_outbox_lease uuid,p_call_id uuid default null
) returns text language plpgsql security definer set search_path='' as $$
declare existing public.dispatch_ledger;o public.outbox;b public.dispatch_bindings;n integer;
begin
  if p_family_id is null or p_person_id is null or p_key is null or p_provider is null or p_action is null or p_outbox_id is null
    or p_key !~ '^[A-Za-z0-9:_.-]{8,128}$' or p_provider not in ('sarvam','twilio','whatsapp','telecmi')
    or p_action !~ '^[a-z0-9_.]{1,80}$' then
    raise exception 'invalid_dispatch_claim' using errcode='22023';
  end if;
  select * into o from public.outbox where id=p_outbox_id and family_id=p_family_id for update;
  if o.id is null or o.status<>'processing' or p_outbox_lease is null or o.lease_token is distinct from p_outbox_lease
    or o.lease_until<=now() then
    raise exception 'stale_outbox_lease' using errcode='40001';
  end if;
  select * into b from public.dispatch_bindings where outbox_id=p_outbox_id and family_id=p_family_id;
  if b.outbox_id is null or b.person_id<>p_person_id or b.provider<>p_provider or b.action<>p_action
    or b.call_id is distinct from p_call_id then
    raise exception 'dispatch_binding_mismatch' using errcode='42501';
  end if;
  select * into existing from public.dispatch_ledger where family_id=p_family_id and idempotency_key=p_key;
  if existing.id is not null then
    if existing.outbox_id<>p_outbox_id then raise exception 'dispatch_key_conflict' using errcode='23505'; end if;
    return 'duplicate';
  end if;
  if exists(select 1 from public.dispatch_ledger l where l.family_id=p_family_id and l.outbox_id=p_outbox_id
    and l.status not in ('failed','not_sent')) then
    return 'duplicate';
  end if;
  if p_call_id is not null and exists(select 1 from public.calls c where c.id=p_call_id and c.external_id is not null) then
    raise exception 'call_already_bound' using errcode='23505';
  end if;
  insert into public.dispatch_ledger(family_id,person_id,idempotency_key,provider,action,outbox_id,call_id)
    values(p_family_id,b.person_id,p_key,b.provider,b.action,p_outbox_id,b.call_id)
    on conflict(family_id,idempotency_key) do nothing;
  get diagnostics n=row_count;
  return case when n=1 then 'claimed' else 'duplicate' end;
end$$;

-- Link the provider reference to the call and, for Sarvam, bind the attempt identity that the webhook gateway matches.
create function sahaj_private.bind_dispatch(p_l public.dispatch_ledger,p_provider_ref text,p_account_id text,
  p_identity_hash text,p_ai_disclosed boolean) returns void language plpgsql security definer set search_path='' as $$
declare c public.calls;
begin
  if p_l.call_id is null then
    if p_l.action in ('sarvam.outbound_call','twilio.create_call') then raise exception 'call_required' using errcode='22023'; end if;
    return;
  end if;
  select * into c from public.calls where id=p_l.call_id and family_id=p_l.family_id and person_id=p_l.person_id for update;
  if c.id is null then raise exception 'call_identity_mismatch' using errcode='42501'; end if;
  if c.external_id is not null and (c.external_id<>p_provider_ref or c.provider<>p_l.provider) then
    raise exception 'call_already_bound' using errcode='23505';
  end if;
  update public.calls set provider=p_l.provider,external_id=p_provider_ref,
    ai_disclosed_at=case when p_ai_disclosed then coalesce(ai_disclosed_at,now()) else ai_disclosed_at end
    where id=c.id;
  if p_l.action='sarvam.outbound_call' then
    if p_account_id is null or p_identity_hash is null or p_identity_hash !~ '^[0-9a-f]{64}$' or p_account_id !~ '^[A-Za-z0-9_.-]{1,128}$' then
      raise exception 'identity_binding_required' using errcode='22023';
    end if;
    insert into public.provider_identities(family_id,person_id,source,account_id,external_id_hash,binding_kind,agent_id,attempt_id)
      values(p_l.family_id,p_l.person_id,'sarvam',p_account_id,p_identity_hash,'attempt',p_account_id,p_provider_ref)
      on conflict(source,account_id,external_id_hash,binding_kind) do nothing;
    if not exists(select 1 from public.provider_identities i where i.source='sarvam' and i.account_id=p_account_id
      and i.external_id_hash=p_identity_hash and i.binding_kind='attempt' and i.family_id=p_l.family_id
      and i.person_id=p_l.person_id and i.attempt_id=p_provider_ref and i.agent_id=p_account_id
      and i.enabled and i.revoked_at is null) then
      raise exception 'identity_conflict' using errcode='23505';
    end if;
  end if;
end$$;

create function public.complete_dispatch(p_family_id uuid,p_key text,p_provider_ref text,p_account_id text default null,
  p_identity_hash text default null,p_ai_disclosed boolean default false)
returns text language plpgsql security definer set search_path='' as $$
declare l public.dispatch_ledger;
begin
  if p_provider_ref is null or length(p_provider_ref) not between 1 and 256 then
    raise exception 'invalid_provider_ref' using errcode='22023';
  end if;
  select * into l from public.dispatch_ledger where family_id=p_family_id and idempotency_key=p_key for update;
  if l.id is null then raise exception 'unknown_dispatch' using errcode='42501'; end if;
  if l.status='dispatched' and l.provider_ref=p_provider_ref then return 'dispatched'; end if;
  if l.status<>'claimed' then raise exception 'dispatch_not_claimed' using errcode='40001'; end if;
  perform sahaj_private.bind_dispatch(l,p_provider_ref,p_account_id,p_identity_hash,p_ai_disclosed);
  update public.dispatch_ledger set status='dispatched',provider_ref=p_provider_ref,resolved_at=now(),last_error_code=null where id=l.id;
  return 'dispatched';
end$$;

-- Repair path when the provider answered but bookkeeping failed. Binds identity only; delivery status is unchanged.
create function public.bind_dispatch_identity(p_family_id uuid,p_key text,p_account_id text default null,
  p_identity_hash text default null,p_ai_disclosed boolean default false)
returns boolean language plpgsql security definer set search_path='' as $$
declare l public.dispatch_ledger;
begin
  select * into l from public.dispatch_ledger where family_id=p_family_id and idempotency_key=p_key for update;
  if l.id is null or l.provider_ref is null or l.status not in ('delivery_unknown','dispatched','delivered') then return false; end if;
  perform sahaj_private.bind_dispatch(l,l.provider_ref,p_account_id,p_identity_hash,p_ai_disclosed);
  return true;
end$$;

create function public.mark_dispatch_failed(p_family_id uuid,p_key text,p_error_code text default 'provider_rejected')
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  if p_error_code is null or p_error_code !~ '^[a-z0-9_]{1,80}$' then raise exception 'invalid_error_code' using errcode='22023'; end if;
  update public.dispatch_ledger set status='failed',last_error_code=p_error_code,resolved_at=now()
    where family_id=p_family_id and idempotency_key=p_key and status='claimed';
  get diagnostics n=row_count;
  return n=1;
end$$;

create function public.mark_dispatch_unknown(p_family_id uuid,p_key text,p_error_code text default 'delivery_unknown',
  p_provider_ref text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  if p_error_code is null or p_error_code !~ '^[a-z0-9_]{1,80}$' then raise exception 'invalid_error_code' using errcode='22023'; end if;
  update public.dispatch_ledger set status='delivery_unknown',last_error_code=p_error_code,resolved_at=now(),
    provider_ref=coalesce(provider_ref,p_provider_ref)
    where family_id=p_family_id and idempotency_key=p_key and status='claimed';
  get diagnostics n=row_count;
  return n=1;
end$$;

create function public.sweep_stale_dispatch_claims(p_older_than_seconds integer default 120)
returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  if p_older_than_seconds is null or p_older_than_seconds not between 10 and 86400 then
    raise exception 'invalid_sweep_options' using errcode='22023';
  end if;
  update public.dispatch_ledger set status='delivery_unknown',last_error_code='claim_expired',resolved_at=now()
    where status='claimed' and claimed_at<now()-make_interval(secs=>p_older_than_seconds);
  get diagnostics n=row_count;
  return n;
end$$;

------------------------------------------------------------------ normalized delivery proof
-- Raw provider callbacks stay raw. This function derives a normalized proof event ONLY from stored records:
-- the raw callback (same family, already durably processed), the call row, the ledger row and its immutable binding.
-- Nothing in the callback body names the outbox, request or dispatch key.
-- 'delivered' is accepted only for a provider status that states delivery to the recipient (WhatsApp delivered/read).
-- A connected or completed call is never delivery proof. Returns the proof event id.
create function public.record_delivery_proof(p_family_id uuid,p_source_event_id uuid,p_outcome text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.raw_events;l public.dispatch_ledger;b public.dispatch_bindings;c public.calls;ref text;st text;
  meta jsonb;pid uuid;pevent text;other text;
begin
  if p_outcome is null or p_outcome not in ('delivered','confirmed_not_sent') then raise exception 'invalid_outcome' using errcode='22023'; end if;
  select * into e from public.raw_events where id=p_source_event_id and family_id=p_family_id;
  if e.id is null or e.status<>'processed' or e.normalized_proof
    or (e.source,e.event_type) not in (('twilio','twilio.call_status'),('sarvam','sarvam.outbound'),('whatsapp','whatsapp.status')) then
    raise exception 'unsupported_source_event' using errcode='42501';
  end if;
  st := e.metadata->>'status';
  if not ((p_outcome='confirmed_not_sent' and ((e.source='twilio' and st in ('busy','no-answer','failed','canceled'))
      or (e.source='sarvam' and st in ('no_answer','busy','failed')) or (e.source='whatsapp' and st='failed')))
    or (p_outcome='delivered' and e.source='whatsapp' and st in ('delivered','read'))) then
    raise exception 'status_not_proof' using errcode='42501';
  end if;
  ref := e.metadata->>'provider_ref';
  if ref is null and e.metadata->>'call_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into c from public.calls where id=(e.metadata->>'call_id')::uuid and family_id=p_family_id;
    if c.id is null or c.provider<>e.source then raise exception 'call_mismatch' using errcode='42501'; end if;
    ref := c.external_id;
  end if;
  if ref is null then raise exception 'no_provider_ref' using errcode='42501'; end if;
  select * into l from public.dispatch_ledger where family_id=p_family_id and provider=e.source and provider_ref=ref for update;
  if l.id is null or l.status not in ('dispatched','delivery_unknown') then raise exception 'ledger_mismatch' using errcode='42501'; end if;
  select * into b from public.dispatch_bindings where outbox_id=l.outbox_id and family_id=p_family_id;
  if b.outbox_id is null or b.person_id<>l.person_id or (e.metadata->>'person_id' is not null and e.metadata->>'person_id'<>l.person_id::text) then
    raise exception 'binding_mismatch' using errcode='42501';
  end if;
  other := case when p_outcome='delivered' then 'confirmed_not_sent' else 'delivered' end;
  if exists(select 1 from public.raw_events x where x.source=e.source and x.provider_event_id='delivery:'||l.idempotency_key||':'||other) then
    raise exception 'contradictory_proof' using errcode='23505';
  end if;
  meta := jsonb_build_object('normalized',true,'outcome',p_outcome,'outbox_id',l.outbox_id,'action_request_id',b.action_request_id,
    'action',l.action,'dispatch_key',l.idempotency_key,'provider_ref',l.provider_ref,'person_id',l.person_id,'source_event_id',e.id);
  pevent := 'delivery:'||l.idempotency_key||':'||p_outcome;
  perform set_config('sahaj.proof_writer','1',true);
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status,payload_hash,processed_at,normalized_proof)
    values(p_family_id,e.source,pevent,case when p_outcome='delivered' then 'delivery.confirmed' else 'delivery.not_sent' end,meta,
      'processed',encode(sha256(convert_to(meta::text,'UTF8')),'hex'),now(),true)
    on conflict(source,provider_event_id) do nothing;
  perform set_config('sahaj.proof_writer','',true);
  select id into pid from public.raw_events where source=e.source and provider_event_id=pevent and family_id=p_family_id and normalized_proof;
  if pid is null then raise exception 'proof_conflict' using errcode='23505'; end if;
  return jsonb_build_object('proof_event_id',pid,'dispatch_key',l.idempotency_key,'outbox_id',l.outbox_id,'outcome',p_outcome);
end$$;

-- Resolve an unknown dispatch from normalized proof whose every binding equals the stored ledger and binding.
create function public.reconcile_dispatch(p_family_id uuid,p_key text,p_provider_event_id uuid,p_outcome text)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  if p_outcome is null or p_outcome not in ('delivered','confirmed_not_sent') then
    raise exception 'invalid_reconciliation_outcome' using errcode='22023';
  end if;
  update public.dispatch_ledger l set status=case when p_outcome='delivered' then 'delivered' else 'not_sent' end,
    reconciliation_event_id=p_provider_event_id,resolved_at=now()
    from public.dispatch_bindings b
    where l.family_id=p_family_id and l.idempotency_key=p_key and l.status='delivery_unknown'
      and b.outbox_id=l.outbox_id and b.family_id=l.family_id and l.provider_ref is not null
      and exists(select 1 from public.raw_events e where e.id=p_provider_event_id and e.family_id=l.family_id and e.status='processed'
        and e.normalized_proof and e.source=l.provider and e.metadata->>'dispatch_key'=l.idempotency_key
        and e.metadata->>'outcome'=p_outcome and e.metadata->>'outbox_id'=l.outbox_id::text
        and e.metadata->>'provider_ref'=l.provider_ref and e.metadata->>'action'=l.action
        and e.metadata->>'action_request_id' is not distinct from b.action_request_id::text
        and ((p_outcome='delivered' and e.event_type='delivery.confirmed') or (p_outcome='confirmed_not_sent' and e.event_type='delivery.not_sent')));
  get diagnostics n=row_count;
  return n=1;
end$$;

-- Replaces the Phase 1 outbox reconciler with the common proof contract: normalized proof, matching outbox, request and
-- action, and a ledger row for this outbox that was already reconciled with this exact event.
create or replace function public.reconcile_outbox(p_outbox_id uuid,p_provider_event_id uuid,p_outcome text)
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
      select 1 from public.raw_events e join public.dispatch_ledger l on l.family_id=e.family_id and l.outbox_id=o.id
        and l.reconciliation_event_id=e.id and l.idempotency_key=e.metadata->>'dispatch_key'
      where e.id=p_provider_event_id and e.family_id=o.family_id and e.status='processed' and e.normalized_proof
        and e.metadata->>'outbox_id'=o.id::text and e.metadata->>'outcome'=p_outcome
        and e.metadata->>'action_request_id' is not distinct from o.action_request_id::text
        and ((p_outcome='delivered' and e.event_type='delivery.confirmed' and l.status='delivered')
          or (p_outcome='confirmed_not_sent' and e.event_type='delivery.not_sent' and l.status='not_sent')));
  get diagnostics changed=row_count;
  return changed=1;
end$$;

------------------------------------------------------------------ responder acceptance
-- Derive the full common `responder.accepted` binding from stored records for one Twilio call. Returns null when any link
-- is missing: the call, the dispatched Twilio ledger row for it, the immutable outbox binding (assignment, incident,
-- responder), the outbox action request. Nothing comes from provider form fields except the call it is about.
create function sahaj_private.derive_responder_binding(p_family_id uuid,p_call_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.calls;l public.dispatch_ledger;b public.dispatch_bindings;a public.assignments;i public.incidents;
  o public.outbox;ar public.action_requests;
begin
  select * into c from public.calls where id=p_call_id and family_id=p_family_id and provider='twilio';
  if c.id is null or c.external_id is null then return null; end if;
  select * into l from public.dispatch_ledger where family_id=p_family_id and call_id=c.id and provider='twilio'
    and action='twilio.create_call' and provider_ref=c.external_id and status in ('dispatched','delivered') and person_id=c.person_id;
  if l.id is null then return null; end if;
  select * into b from public.dispatch_bindings where outbox_id=l.outbox_id and family_id=p_family_id;
  if b.outbox_id is null or b.assignment_id is null or b.incident_id is null or b.action_request_id is null or b.call_id is distinct from c.id
    or b.person_id<>c.person_id then return null; end if;
  select * into a from public.assignments where id=b.assignment_id and family_id=p_family_id;
  select * into i from public.incidents where id=b.incident_id and family_id=p_family_id;
  select * into o from public.outbox where id=b.outbox_id and family_id=p_family_id;
  select * into ar from public.action_requests where id=b.action_request_id and family_id=p_family_id;
  if a.id is null or i.id is null or o.id is null or ar.id is null or a.incident_id<>i.id or a.person_id<>c.person_id
    or o.action_request_id is distinct from ar.id or ar.action<>'urgent_responder' then return null; end if;
  return jsonb_build_object('incident_id',i.id,'assignment_id',a.id,'responder_person_id',a.person_id,'person_id',i.person_id,
    'call_id',c.id,'outbox_id',o.id,'action_request_id',ar.id,'action','urgent_responder');
end$$;
revoke all on function sahaj_private.derive_responder_binding(uuid,uuid) from public,anon,authenticated;

-- Turn one verified Twilio Gather callback (raw event 'twilio.gather.response', digit 1, ingested after signature
-- verification) into the normalized `responder.accepted` proof. Idempotent: replays return the same proof.
create function public.record_responder_acceptance(p_family_id uuid,p_gather_provider_event_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.raw_events;d jsonb;a public.assignments;meta jsonb;pid uuid;pevent text;c public.calls;
begin
  select * into e from public.raw_events where family_id=p_family_id and source='twilio' and provider_event_id=p_gather_provider_event_id
    and event_type='twilio.gather.response' and not normalized_proof;
  if e.id is null or e.metadata->>'digit' is distinct from '1' or coalesce(e.metadata->>'call_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'not_a_gather_acceptance' using errcode='42501';
  end if;
  select * into c from public.calls where id=(e.metadata->>'call_id')::uuid and family_id=p_family_id;
  if c.id is null then raise exception 'call_mismatch' using errcode='42501'; end if;
  perform 1 from public.people p where p.id=c.person_id and p.family_id=p_family_id for no key update;
  d := sahaj_private.derive_responder_binding(p_family_id,c.id);
  if d is null then raise exception 'binding_not_provable' using errcode='42501'; end if;
  if e.metadata->>'person_id' is distinct from d->>'responder_person_id' then raise exception 'responder_mismatch' using errcode='42501'; end if;
  select * into a from public.assignments where id=(d->>'assignment_id')::uuid and family_id=p_family_id for update;
  if a.status='accepted' then
    pevent := 'responder.accepted:'||a.id;
    select id into pid from public.raw_events where source='twilio' and provider_event_id=pevent and family_id=p_family_id and normalized_proof;
    if pid is not null and a.verified_by_provider_event=pid then
      return jsonb_build_object('proof_event_id',pid,'assignment_id',a.id);
    end if;
    raise exception 'assignment_not_offered' using errcode='42501';
  end if;
  if a.status<>'offered' or a.expires_at<=now() or e.received_at<a.offered_at or e.received_at>a.expires_at then
    raise exception 'assignment_not_offered' using errcode='42501';
  end if;
  meta := d||jsonb_build_object('normalized',true,'verified_by','twilio_signature','source_event_id',e.id);
  pevent := 'responder.accepted:'||a.id;
  perform set_config('sahaj.proof_writer','1',true);
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status,payload_hash,processed_at,normalized_proof)
    values(p_family_id,'twilio',pevent,'responder.accepted',meta,'processed',encode(sha256(convert_to(meta::text,'UTF8')),'hex'),now(),true)
    on conflict(source,provider_event_id) do nothing;
  perform set_config('sahaj.proof_writer','',true);
  select id into pid from public.raw_events where source='twilio' and provider_event_id=pevent and family_id=p_family_id and normalized_proof;
  if pid is null then raise exception 'proof_conflict' using errcode='23505'; end if;
  return jsonb_build_object('proof_event_id',pid,'assignment_id',a.id);
end$$;

-- Consume the normalized proof. Re-derives every binding from stored records and requires exact equality with the proof.
create function public.accept_assignment_verified(p_family_id uuid,p_assignment_id uuid,p_provider_event_id uuid)
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
  if e.id is null or not e.normalized_proof or e.source<>'twilio' or e.event_type<>'responder.accepted' or e.status<>'processed'
    or e.metadata->>'assignment_id' is distinct from a.id::text or e.metadata->>'verified_by' is distinct from 'twilio_signature'
    or coalesce(e.metadata->>'call_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  d := sahaj_private.derive_responder_binding(p_family_id,(e.metadata->>'call_id')::uuid);
  if d is null or (e.metadata-'normalized'-'verified_by'-'source_event_id')<>d or d->>'assignment_id'<>a.id::text then return false; end if;
  update public.assignments set status='accepted',accepted_at=now(),verified_by_provider_event=e.id where id=a.id and status='offered';
  get diagnostics n=row_count;
  return n=1;
end$$;

------------------------------------------------------------------ recording metadata and purge
alter table sahaj_private.call_content add column recording_ref_hash text
  check(recording_ref_hash is null or recording_ref_hash ~ '^[0-9a-f]{64}$');
alter table sahaj_private.call_content add column purged_at timestamptz;

-- 'none' (free), 'same' (this recording already stored), 'other' (slot taken by a different recording) or 'purged'
-- (a stored recording was removed by retention or revocation; it is never silently stored again).
create function public.get_call_recording_slot(p_family_id uuid,p_call_id uuid,p_recording_ref_hash text)
returns text language sql stable security definer set search_path='' as $$
  select coalesce((select case when c.purged_at is not null then 'purged' when c.recording_object_path is null then 'none'
    when c.recording_ref_hash=p_recording_ref_hash then 'same' else 'other' end
    from sahaj_private.call_content c where c.family_id=p_family_id and c.call_id=p_call_id),'none')
$$;

-- Atomic metadata writer. Lock order person -> call, taken BEFORE reading consent or call_content, so two simultaneous
-- first recordings serialize: one 'stored', the other 'ignored_additional', never a unique violation. Consent is
-- evaluated under that fence; a refusal inserted concurrently waits on the person lock in the consents trigger.
create function public.put_call_recording(p_family_id uuid,p_call_id uuid,p_consent_id uuid,p_object_path text,
  p_expires_at timestamptz,p_recording_ref_hash text)
returns text language plpgsql security definer set search_path='' as $$
declare c public.calls;k public.consents;eff uuid;existing sahaj_private.call_content;n integer;
begin
  if p_family_id is null or p_call_id is null or p_consent_id is null or p_recording_ref_hash is null
    or p_recording_ref_hash !~ '^[0-9a-f]{64}$' or p_expires_at is null
    or p_expires_at<=now() or p_expires_at>now()+interval '400 days' or p_object_path is null
    or p_object_path !~ ('^'||p_family_id::text||'/calls/'||p_call_id::text||'/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(mp3|wav|ogg|m4a|mp4)$') then
    raise exception 'invalid_recording_metadata' using errcode='22023';
  end if;
  select * into c from public.calls where id=p_call_id and family_id=p_family_id;
  if c.id is null then raise exception 'call_not_found' using errcode='42501'; end if;
  perform 1 from public.people p where p.id=c.person_id and p.family_id=p_family_id for no key update;
  select * into c from public.calls where id=p_call_id and family_id=p_family_id for update;
  select * into k from public.consents where id=p_consent_id and family_id=p_family_id;
  if k.id is null or k.person_id<>c.person_id or k.call_id is distinct from p_call_id or k.purpose<>'call_recording'
    or k.answer is not true or length(k.version)=0 or k.created_at>now() then
    raise exception 'consent_not_effective' using errcode='42501';
  end if;
  eff := sahaj_private.call_recording_consent(p_family_id,p_call_id,c.person_id);
  if eff is null then raise exception 'consent_not_effective' using errcode='42501'; end if;
  select * into existing from sahaj_private.call_content where family_id=p_family_id and call_id=p_call_id for update;
  if existing.call_id is null then
    insert into sahaj_private.call_content(family_id,call_id,consent_id,recording_object_path,expires_at,recording_ref_hash)
      values(p_family_id,p_call_id,eff,p_object_path,p_expires_at,p_recording_ref_hash)
      on conflict(family_id,call_id) do nothing;
    get diagnostics n=row_count;
    if n=1 then return 'stored'; end if;
    select * into existing from sahaj_private.call_content where family_id=p_family_id and call_id=p_call_id for update;
  end if;
  if existing.purged_at is not null then return 'purged'; end if;
  if existing.recording_object_path is not null then
    if existing.recording_ref_hash=p_recording_ref_hash and existing.recording_object_path=p_object_path then return 'already_stored'; end if;
    return 'ignored_additional';
  end if;
  if existing.consent_id<>eff then
    raise exception 'consent_row_mismatch' using errcode='42501';
  end if;
  update sahaj_private.call_content set recording_object_path=p_object_path,recording_ref_hash=p_recording_ref_hash,
    expires_at=least(expires_at,p_expires_at) where family_id=p_family_id and call_id=p_call_id;
  return 'stored';
end$$;

-- Recordings that must be deleted: past retention, or whose consent is no longer effective (revoked/refused).
-- p_as_of can only make the check EARLIER than the database clock, never later, so a wrong caller clock cannot over-purge.
create function public.list_recording_purge_candidates(p_limit integer default 25,p_as_of timestamptz default null)
returns table(family_id uuid,call_id uuid,object_path text,reason text)
language plpgsql stable security definer set search_path='' as $$
declare t timestamptz;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_limit' using errcode='22023'; end if;
  t := least(coalesce(p_as_of,now()),now());
  return query select c.family_id,c.call_id,c.recording_object_path,
      case when c.expires_at<=t then 'retention' else 'consent' end
    from sahaj_private.call_content c join public.calls k on k.family_id=c.family_id and k.id=c.call_id
    where c.recording_object_path is not null and c.purged_at is null
      and (c.expires_at<=t or sahaj_private.call_recording_consent(c.family_id,c.call_id,k.person_id) is null)
    order by c.expires_at limit p_limit;
end$$;

-- Called only after the exact stored object was deleted. Compare-and-set on family, call and path; eligibility is
-- re-checked under the same locks, so a concurrently re-stored or re-consented recording is left alone.
create function public.finish_recording_purge(p_family_id uuid,p_call_id uuid,p_object_path text,p_as_of timestamptz default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare k public.calls;t timestamptz;n integer;
begin
  t := least(coalesce(p_as_of,now()),now());
  select * into k from public.calls where id=p_call_id and family_id=p_family_id;
  if k.id is null then return false; end if;
  perform 1 from public.people p where p.id=k.person_id and p.family_id=p_family_id for no key update;
  perform 1 from public.calls where id=p_call_id and family_id=p_family_id for update;
  update sahaj_private.call_content c set recording_object_path=null,purged_at=now()
    where c.family_id=p_family_id and c.call_id=p_call_id and c.recording_object_path=p_object_path and c.purged_at is null
      and (c.expires_at<=t or sahaj_private.call_recording_consent(p_family_id,p_call_id,k.person_id) is null);
  get diagnostics n=row_count;
  return n=1;
end$$;

------------------------------------------------------------------ grants
revoke all on function public.bind_outbox_dispatch(uuid,uuid,uuid,text,text,uuid,uuid,uuid),
  public.claim_dispatch(uuid,uuid,text,text,text,uuid,uuid,uuid),
  sahaj_private.bind_dispatch(public.dispatch_ledger,text,text,text,boolean),
  public.complete_dispatch(uuid,text,text,text,text,boolean),public.bind_dispatch_identity(uuid,text,text,text,boolean),
  public.mark_dispatch_failed(uuid,text,text),public.mark_dispatch_unknown(uuid,text,text,text),
  public.sweep_stale_dispatch_claims(integer),public.record_delivery_proof(uuid,uuid,text),
  public.reconcile_dispatch(uuid,text,uuid,text),public.reconcile_outbox(uuid,uuid,text),
  public.record_responder_acceptance(uuid,text),public.accept_assignment_verified(uuid,uuid,uuid),
  public.get_call_recording_slot(uuid,uuid,text),public.put_call_recording(uuid,uuid,uuid,text,timestamptz,text),
  public.list_recording_purge_candidates(integer,timestamptz),public.finish_recording_purge(uuid,uuid,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.bind_outbox_dispatch(uuid,uuid,uuid,text,text,uuid,uuid,uuid),
  public.claim_dispatch(uuid,uuid,text,text,text,uuid,uuid,uuid),
  public.complete_dispatch(uuid,text,text,text,text,boolean),public.bind_dispatch_identity(uuid,text,text,text,boolean),
  public.mark_dispatch_failed(uuid,text,text),public.mark_dispatch_unknown(uuid,text,text,text),
  public.sweep_stale_dispatch_claims(integer),public.record_delivery_proof(uuid,uuid,text),
  public.reconcile_dispatch(uuid,text,uuid,text),public.reconcile_outbox(uuid,uuid,text),
  public.record_responder_acceptance(uuid,text),public.accept_assignment_verified(uuid,uuid,uuid),
  public.get_call_recording_slot(uuid,uuid,text),public.put_call_recording(uuid,uuid,uuid,text,timestamptz,text),
  public.list_recording_purge_candidates(integer,timestamptz),public.finish_recording_purge(uuid,uuid,text,timestamptz)
  to service_role;
