-- Phase 2: durable dispatch ledger, attempt/call identity bindings, verified responder acceptance and
-- recording metadata writer. Every function is service-role only. Clients never reach these tables.
-- Apply after 20261114141830_checkpoint_media_metadata.sql.

alter table public.outbox add constraint outbox_family_identity unique(family_id,id);

create table public.dispatch_ledger (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id),
  person_id uuid not null,
  idempotency_key text not null check(idempotency_key ~ '^[A-Za-z0-9:_.-]{8,128}$'),
  provider text not null check(provider in ('sarvam','twilio','whatsapp','telecmi')),
  action text not null check(action ~ '^[a-z0-9_.]{1,80}$'),
  outbox_id uuid,
  call_id uuid,
  status text not null default 'claimed'
    check(status in ('claimed','dispatched','failed','delivery_unknown','delivered','not_sent')),
  provider_ref text check(provider_ref is null or length(provider_ref) between 1 and 256),
  last_error_code text check(last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,80}$'),
  reconciliation_event_id uuid,
  claimed_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key(family_id,person_id) references public.people(family_id,id),
  foreign key(family_id,outbox_id) references public.outbox(family_id,id),
  foreign key(family_id,call_id) references public.calls(family_id,id),
  foreign key(family_id,reconciliation_event_id) references public.raw_events(family_id,id),
  unique(family_id,idempotency_key),
  unique(family_id,id)
);
-- One provider reference belongs to exactly one ledger row, across all families.
create unique index dispatch_ledger_provider_ref_idx on public.dispatch_ledger(provider,provider_ref) where provider_ref is not null;
-- One live (non-failed) dispatch per outbox row, whatever key was used.
create unique index dispatch_ledger_live_outbox_idx on public.dispatch_ledger(family_id,outbox_id)
  where outbox_id is not null and status not in ('failed','not_sent');
create index dispatch_ledger_claimed_idx on public.dispatch_ledger(claimed_at) where status='claimed';
alter table public.dispatch_ledger enable row level security;
revoke all on public.dispatch_ledger from public,anon,authenticated;
-- Writes go through the functions below only.
grant select on public.dispatch_ledger to service_role;

-- One provider event can verify at most one assignment.
create unique index assignments_verified_event_idx on public.assignments(verified_by_provider_event)
  where verified_by_provider_event is not null;

alter table sahaj_private.call_content add column recording_ref_hash text
  check(recording_ref_hash is null or recording_ref_hash ~ '^[0-9a-f]{64}$');

------------------------------------------------------------------ dispatch ledger
-- Atomic claim BEFORE any network call. Returns 'claimed' or 'duplicate'. A reused key for another
-- person/provider/action is an error, so keys cannot be substituted across identities.
create function public.claim_dispatch(
  p_family_id uuid,p_person_id uuid,p_key text,p_provider text,p_action text,
  p_outbox_id uuid default null,p_outbox_lease uuid default null,p_call_id uuid default null
) returns text language plpgsql security definer set search_path='' as $$
declare existing public.dispatch_ledger;o public.outbox;n integer;
begin
  if p_family_id is null or p_person_id is null or p_key is null or p_provider is null or p_action is null
    or p_key !~ '^[A-Za-z0-9:_.-]{8,128}$' or p_provider not in ('sarvam','twilio','whatsapp','telecmi')
    or p_action !~ '^[a-z0-9_.]{1,80}$' then
    raise exception 'invalid_dispatch_claim' using errcode='22023';
  end if;
  if p_outbox_id is not null then
    select * into o from public.outbox where id=p_outbox_id and family_id=p_family_id for update;
    if o.id is null or o.status<>'processing' or p_outbox_lease is null or o.lease_token is distinct from p_outbox_lease
      or o.lease_until<=now() then
      raise exception 'stale_outbox_lease' using errcode='40001';
    end if;
  end if;
  if p_call_id is not null and not exists(select 1 from public.calls c where c.id=p_call_id and c.family_id=p_family_id and c.person_id=p_person_id) then
    raise exception 'call_identity_mismatch' using errcode='42501';
  end if;
  select * into existing from public.dispatch_ledger where family_id=p_family_id and idempotency_key=p_key;
  if existing.id is not null then
    if existing.person_id<>p_person_id or existing.provider<>p_provider or existing.action<>p_action
      or existing.outbox_id is distinct from p_outbox_id or existing.call_id is distinct from p_call_id then
      raise exception 'dispatch_key_conflict' using errcode='23505';
    end if;
    return 'duplicate';
  end if;
  if p_outbox_id is not null and exists(select 1 from public.dispatch_ledger l where l.family_id=p_family_id
    and l.outbox_id=p_outbox_id and l.status not in ('failed','not_sent')) then
    return 'duplicate';
  end if;
  if p_call_id is not null and exists(select 1 from public.calls c where c.id=p_call_id and c.external_id is not null) then
    raise exception 'call_already_bound' using errcode='23505';
  end if;
  insert into public.dispatch_ledger(family_id,person_id,idempotency_key,provider,action,outbox_id,call_id)
    values(p_family_id,p_person_id,p_key,p_provider,p_action,p_outbox_id,p_call_id)
    on conflict(family_id,idempotency_key) do nothing;
  get diagnostics n=row_count;
  return case when n=1 then 'claimed' else 'duplicate' end;
end$$;

-- Shared by complete/bind: link the provider reference to the call and, for Sarvam, bind the attempt identity
-- that the webhook gateway matches. Everything is checked against the claimed family and person.
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
    -- A pre-existing row must be this exact family/person/attempt, otherwise another tenant owns the identifier.
    if not exists(select 1 from public.provider_identities i where i.source='sarvam' and i.account_id=p_account_id
      and i.external_id_hash=p_identity_hash and i.binding_kind='attempt' and i.family_id=p_l.family_id
      and i.person_id=p_l.person_id and i.attempt_id=p_provider_ref and i.agent_id=p_account_id
      and i.enabled and i.revoked_at is null) then
      raise exception 'identity_conflict' using errcode='23505';
    end if;
  end if;
end$$;

-- Provider accepted the request: link call and identity, then mark dispatched, in one transaction.
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

-- Repair path when the provider answered but bookkeeping failed: the row is delivery_unknown with a recorded ref.
-- Binding the identity lets the webhook gateway recognise callbacks. It does NOT change delivery status.
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

-- Definite provider refusal before any action. Only a claimed row can fail; an unknown outcome never becomes failed.
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

-- A worker that died after claiming may have reached the provider. Never resend: mark unknown.
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

-- Only verified provider evidence resolves an unknown dispatch. The evidence event must be same family, same provider,
-- carry this dispatch key (and provider ref, when one is recorded) and an outcome that matches its type.
create function public.reconcile_dispatch(p_family_id uuid,p_key text,p_provider_event_id uuid,p_outcome text)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  if p_outcome is null or p_outcome not in ('delivered','confirmed_not_sent') then
    raise exception 'invalid_reconciliation_outcome' using errcode='22023';
  end if;
  update public.dispatch_ledger l set status=case when p_outcome='delivered' then 'delivered' else 'not_sent' end,
    reconciliation_event_id=p_provider_event_id,resolved_at=now()
    where l.family_id=p_family_id and l.idempotency_key=p_key and l.status='delivery_unknown' and exists(
      select 1 from public.raw_events e where e.id=p_provider_event_id and e.family_id=l.family_id and e.status='processed'
        and e.source=l.provider and e.metadata->>'dispatch_key'=l.idempotency_key and e.metadata->>'outcome'=p_outcome
        and (l.provider_ref is null or e.metadata->>'provider_ref'=l.provider_ref)
        and ((p_outcome='delivered' and e.event_type='delivery.confirmed')
          or (p_outcome='confirmed_not_sent' and e.event_type='delivery.not_sent')));
  get diagnostics n=row_count;
  return n=1;
end$$;

------------------------------------------------------------------ responder acceptance
-- Acceptance needs a provider event that a verified Twilio Gather callback created for THIS assignment, from a call
-- this system placed to THIS person. Outbound-call status ("connected"), gateway success flags and model output are
-- different event types and never qualify.
create function public.accept_assignment_verified(p_family_id uuid,p_assignment_id uuid,p_provider_event_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare a public.assignments;e public.raw_events;c public.calls;call_uuid uuid;n integer;
begin
  select * into a from public.assignments where id=p_assignment_id and family_id=p_family_id for update;
  if a.id is null or a.status<>'offered' or a.expires_at<=now() then return false; end if;
  select * into e from public.raw_events where id=p_provider_event_id and family_id=p_family_id;
  if e.id is null or e.source<>'twilio' or e.event_type<>'twilio.gather.accepted' or e.status='dead'
    or e.metadata->>'assignment_id' is distinct from a.id::text or e.metadata->>'person_id' is distinct from a.person_id::text
    or coalesce(e.metadata->>'call_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or e.received_at<a.offered_at or e.received_at>a.expires_at then
    return false;
  end if;
  call_uuid := (e.metadata->>'call_id')::uuid;
  select * into c from public.calls where id=call_uuid and family_id=p_family_id and person_id=a.person_id and provider='twilio';
  if c.id is null or c.external_id is null then return false; end if;
  if not exists(select 1 from public.dispatch_ledger l where l.family_id=p_family_id and l.call_id=c.id and l.person_id=a.person_id
    and l.provider='twilio' and l.action='twilio.create_call' and l.provider_ref=c.external_id and l.status in ('dispatched','delivered')) then
    return false;
  end if;
  update public.assignments set status='accepted',accepted_at=now(),verified_by_provider_event=e.id where id=a.id and status='offered';
  get diagnostics n=row_count;
  return n=1;
end$$;

------------------------------------------------------------------ recording metadata
-- Pre-fetch probe: 'none' (free), 'same' (this recording already stored) or 'other' (slot taken by a different recording).
create function public.get_call_recording_slot(p_family_id uuid,p_call_id uuid,p_recording_ref_hash text)
returns text language sql stable security definer set search_path='' as $$
  select coalesce((select case when c.recording_object_path is null then 'none'
    when c.recording_ref_hash=p_recording_ref_hash then 'same' else 'other' end
    from sahaj_private.call_content c where c.family_id=p_family_id and c.call_id=p_call_id),'none')
$$;

-- Atomic metadata writer. The consent is re-validated here, at write time, with the same rule as the gateway:
-- exact call, affirmative, versioned, newest wins, ties go to refusal, global refusals count and global yes never does.
-- Multiple recordings per call: the FIRST stored recording keeps the slot. The same recording replayed is idempotent
-- ('already_stored'); a different one returns 'ignored_additional' and the caller must delete its object.
create function public.put_call_recording(p_family_id uuid,p_call_id uuid,p_consent_id uuid,p_object_path text,
  p_expires_at timestamptz,p_recording_ref_hash text)
returns text language plpgsql security definer set search_path='' as $$
declare c public.calls;k public.consents;latest public.consents;existing sahaj_private.call_content;
begin
  if p_recording_ref_hash is null or p_recording_ref_hash !~ '^[0-9a-f]{64}$' or p_expires_at is null
    or p_expires_at<=now() or p_expires_at>now()+interval '400 days' or p_object_path is null
    or p_object_path !~ ('^'||p_family_id::text||'/calls/'||p_call_id::text||'/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(mp3|wav|ogg|m4a|mp4)$') then
    raise exception 'invalid_recording_metadata' using errcode='22023';
  end if;
  select * into c from public.calls where id=p_call_id and family_id=p_family_id;
  if c.id is null then raise exception 'call_not_found' using errcode='42501'; end if;
  select * into k from public.consents where id=p_consent_id and family_id=p_family_id;
  if k.id is null or k.person_id<>c.person_id or k.call_id is distinct from p_call_id or k.purpose<>'call_recording'
    or k.answer is not true or length(k.version)=0 or k.created_at>now() then
    raise exception 'consent_not_effective' using errcode='42501';
  end if;
  select * into latest from public.consents x where x.family_id=p_family_id and x.person_id=c.person_id and x.purpose='call_recording'
    and (x.call_id=p_call_id or (x.call_id is null and x.answer=false))
    order by x.created_at desc,x.answer asc limit 1;
  if latest.id is null or latest.answer is not true or length(latest.version)=0 then
    raise exception 'consent_not_effective' using errcode='42501';
  end if;
  select * into existing from sahaj_private.call_content where family_id=p_family_id and call_id=p_call_id for update;
  if existing.call_id is null then
    insert into sahaj_private.call_content(family_id,call_id,consent_id,recording_object_path,expires_at,recording_ref_hash)
      values(p_family_id,p_call_id,latest.id,p_object_path,p_expires_at,p_recording_ref_hash);
    return 'stored';
  end if;
  if existing.recording_object_path is not null then
    if existing.recording_ref_hash=p_recording_ref_hash and existing.recording_object_path=p_object_path then return 'already_stored'; end if;
    return 'ignored_additional';
  end if;
  if existing.consent_id<>latest.id then
    -- The row holds other content under another consent; do not silently re-link it.
    raise exception 'consent_row_mismatch' using errcode='42501';
  end if;
  update sahaj_private.call_content set recording_object_path=p_object_path,recording_ref_hash=p_recording_ref_hash,
    expires_at=least(expires_at,p_expires_at) where family_id=p_family_id and call_id=p_call_id;
  return 'stored';
end$$;

revoke all on function public.claim_dispatch(uuid,uuid,text,text,text,uuid,uuid,uuid),
  sahaj_private.bind_dispatch(public.dispatch_ledger,text,text,text,boolean),
  public.complete_dispatch(uuid,text,text,text,text,boolean),public.bind_dispatch_identity(uuid,text,text,text,boolean),
  public.mark_dispatch_failed(uuid,text,text),public.mark_dispatch_unknown(uuid,text,text,text),
  public.sweep_stale_dispatch_claims(integer),public.reconcile_dispatch(uuid,text,uuid,text),
  public.accept_assignment_verified(uuid,uuid,uuid),public.get_call_recording_slot(uuid,uuid,text),
  public.put_call_recording(uuid,uuid,uuid,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.claim_dispatch(uuid,uuid,text,text,text,uuid,uuid,uuid),
  public.complete_dispatch(uuid,text,text,text,text,boolean),public.bind_dispatch_identity(uuid,text,text,text,boolean),
  public.mark_dispatch_failed(uuid,text,text),public.mark_dispatch_unknown(uuid,text,text,text),
  public.sweep_stale_dispatch_claims(integer),public.reconcile_dispatch(uuid,text,uuid,text),
  public.accept_assignment_verified(uuid,uuid,uuid),public.get_call_recording_slot(uuid,uuid,text),
  public.put_call_recording(uuid,uuid,uuid,text,timestamptz,text) to service_role;
-- bind_dispatch is internal: callable only by the owner-run definer functions above.
