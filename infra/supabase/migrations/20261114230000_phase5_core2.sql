-- Phase 5 Core 2: SOS, going-home watch, I'm safe, trusted contacts lifecycle, and reassurance.
-- Additive migration owned by Phase 5; preserves existing foundation and Shield schemas.

create table public.core2_trusted_contacts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  subject_person_id uuid not null,
  contact_person_id uuid not null,
  rank integer not null check (rank between 1 and 20),
  scopes text[] not null check (
    cardinality(scopes) >= 1
    and scopes <@ array['sos', 'watch_escalation', 'reassurance']::text[]
  ),
  state text not null default 'invited' check (state in ('invited', 'approved', 'active', 'revoked')),
  approved_at timestamptz,
  consent_id uuid,
  consent_at timestamptz,
  effective_from timestamptz not null default now(),
  effective_until timestamptz,
  revoked_at timestamptz,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (subject_person_id <> contact_person_id),
  check (effective_until is null or effective_until > effective_from),
  check (
    state <> 'active'
    or (approved_at is not null and consent_at is not null and consent_id is not null and revoked_at is null)
  ),
  check (state <> 'revoked' or revoked_at is not null),
  foreign key (family_id, subject_person_id) references public.people(family_id, id),
  foreign key (family_id, contact_person_id) references public.people(family_id, id),
  foreign key (family_id, consent_id) references public.consents(family_id, id),
  unique (family_id, id)
);

create unique index core2_trusted_contacts_live_unique
  on public.core2_trusted_contacts (family_id, subject_person_id, contact_person_id)
  where state <> 'revoked';

create index core2_trusted_contacts_lookup_idx
  on public.core2_trusted_contacts (family_id, subject_person_id, rank, id)
  where state = 'active' and revoked_at is null;

create table public.core2_watches (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  subject_person_id uuid not null,
  incident_id uuid,
  request_id uuid,
  raw_event_id uuid not null,
  timezone text not null,
  state text not null default 'active' check (state in ('active', 'checking_in', 'escalated', 'safe', 'cancelled')),
  version integer not null default 1 check (version >= 1),
  grace_minutes integer not null default 10 check (grace_minutes between 1 and 60),
  deadline_at timestamptz not null,
  grace_until timestamptz not null,
  next_tick_at timestamptz,
  checked_in_at timestamptz,
  escalated_at timestamptz,
  safe_at timestamptz,
  cancelled_at timestamptz,
  safe_idempotency_key_hash text,
  safe_voice_post_id uuid,
  route_ciphertext text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (grace_until > deadline_at),
  check (state <> 'safe' or safe_at is not null),
  check (state <> 'cancelled' or cancelled_at is not null),
  check (state not in ('safe', 'cancelled') or next_tick_at is null),
  foreign key (family_id, subject_person_id) references public.people(family_id, id),
  foreign key (family_id, incident_id) references public.incidents(family_id, id),
  foreign key (family_id, request_id) references public.requests(family_id, id),
  foreign key (family_id, raw_event_id) references public.raw_events(family_id, id),
  foreign key (family_id, safe_voice_post_id) references public.voice_posts(family_id, id),
  unique (family_id, id)
);

create index core2_watches_due_idx
  on public.core2_watches (next_tick_at)
  where state in ('active', 'checking_in') and next_tick_at is not null;

create index core2_watches_subject_idx
  on public.core2_watches (family_id, subject_person_id, created_at desc);

create table public.core2_sos_events (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  subject_person_id uuid not null,
  incident_id uuid not null,
  request_id uuid not null,
  raw_event_id uuid not null,
  status text not null default 'queued' check (
    status in (
      'countdown',
      'queued',
      'pending_contacts',
      'awaiting_approval',
      'denied',
      'verified_accepted',
      'safe',
      'cancelled'
    )
  ),
  delivery_status text not null default 'none' check (
    delivery_status in ('none', 'queued', 'delivery_unknown', 'delivered', 'failed')
  ),
  responder_accepted boolean not null default false,
  accepted_assignment_id uuid,
  accepted_raw_event_id uuid,
  version integer not null default 1 check (version >= 1),
  countdown_until timestamptz,
  cancelled_at timestamptz,
  safe_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not responder_accepted or (accepted_assignment_id is not null and accepted_raw_event_id is not null)),
  check (status <> 'verified_accepted' or responder_accepted),
  foreign key (family_id, subject_person_id) references public.people(family_id, id),
  foreign key (family_id, incident_id) references public.incidents(family_id, id),
  foreign key (family_id, request_id) references public.requests(family_id, id),
  foreign key (family_id, raw_event_id) references public.raw_events(family_id, id),
  foreign key (family_id, accepted_raw_event_id) references public.raw_events(family_id, id),
  unique (family_id, id)
);

create index core2_sos_events_subject_idx
  on public.core2_sos_events (family_id, subject_person_id, created_at desc);

create table public.core2_sharing_preferences (
  family_id uuid not null references public.families(id) on delete cascade,
  subject_person_id uuid not null,
  share_status_with_parent boolean not null default true,
  allow_location_share boolean not null default false,
  allow_health_share boolean not null default false,
  allow_narrative_share boolean not null default false,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (family_id, subject_person_id),
  foreign key (family_id, subject_person_id) references public.people(family_id, id)
);

create table public.core2_reassurance_updates (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  subject_person_id uuid not null,
  recipient_person_id uuid not null,
  kind text not null check (kind in ('im_safe', 'reached_home', 'truth_line')),
  watch_id uuid,
  sos_id uuid,
  voice_post_id uuid,
  outbox_id uuid references public.outbox(id),
  status_label text not null check (length(status_label) between 1 and 80),
  delivery_status text not null default 'queued' check (
    delivery_status in ('queued', 'delivery_unknown', 'delivered', 'failed', 'denied')
  ),
  delivery_verified boolean not null default false,
  heard_verified boolean not null default false,
  verified_raw_event_id uuid,
  location_shared boolean not null default false,
  health_shared boolean not null default false,
  narrative_shared boolean not null default false,
  created_at timestamptz not null default now(),
  check (not delivery_verified or verified_raw_event_id is not null),
  check (not heard_verified or verified_raw_event_id is not null),
  foreign key (family_id, subject_person_id) references public.people(family_id, id),
  foreign key (family_id, recipient_person_id) references public.people(family_id, id),
  foreign key (family_id, watch_id) references public.core2_watches(family_id, id),
  foreign key (family_id, sos_id) references public.core2_sos_events(family_id, id),
  foreign key (family_id, voice_post_id) references public.voice_posts(family_id, id),
  foreign key (family_id, verified_raw_event_id) references public.raw_events(family_id, id)
);

create index core2_reassurance_subject_idx
  on public.core2_reassurance_updates (family_id, subject_person_id, created_at desc);

create table public.core2_dispatch_fences (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  outbox_id uuid not null unique references public.outbox(id) on delete cascade,
  trusted_contact_id uuid,
  watch_id uuid,
  sos_id uuid,
  state text not null default 'armed' check (state in ('armed', 'dispatched', 'fenced_revoked', 'fenced_resolved')),
  fenced_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (family_id, trusted_contact_id) references public.core2_trusted_contacts(family_id, id),
  foreign key (family_id, watch_id) references public.core2_watches(family_id, id),
  foreign key (family_id, sos_id) references public.core2_sos_events(family_id, id)
);

create table public.core2_idempotency_records (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  actor_person_id uuid not null,
  action text not null check (length(action) between 1 and 80),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response_status integer not null check (response_status between 200 and 599),
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (family_id, actor_person_id) references public.people(family_id, id),
  unique (family_id, actor_person_id, action, key_hash)
);

-- RLS & column-level least privilege: service_role mutates all tables; authenticated sees only safe redacted slices.
alter table public.core2_trusted_contacts enable row level security;
alter table public.core2_watches enable row level security;
alter table public.core2_sos_events enable row level security;
alter table public.core2_sharing_preferences enable row level security;
alter table public.core2_reassurance_updates enable row level security;
alter table public.core2_dispatch_fences enable row level security;
alter table public.core2_idempotency_records enable row level security;

revoke all on
  public.core2_trusted_contacts,
  public.core2_watches,
  public.core2_sos_events,
  public.core2_sharing_preferences,
  public.core2_reassurance_updates,
  public.core2_dispatch_fences,
  public.core2_idempotency_records
from public, anon, authenticated;

grant all on
  public.core2_trusted_contacts,
  public.core2_watches,
  public.core2_sos_events,
  public.core2_sharing_preferences,
  public.core2_reassurance_updates,
  public.core2_dispatch_fences,
  public.core2_idempotency_records
to service_role;

grant select (
  id, family_id, subject_person_id, contact_person_id, rank, scopes, state,
  effective_from, effective_until, revoked_at, version, created_at
) on public.core2_trusted_contacts to authenticated;

create policy core2_trusted_contacts_read on public.core2_trusted_contacts
  for select to authenticated
  using (
    sahaj_private.has_role(family_id, array['child'])
    or sahaj_private.is_person(family_id, subject_person_id)
    or sahaj_private.is_person(family_id, contact_person_id)
  );

grant select (
  id, family_id, subject_person_id, incident_id, request_id, timezone, state,
  version, grace_minutes, deadline_at, grace_until, checked_in_at,
  escalated_at, safe_at, cancelled_at, created_at, updated_at
) on public.core2_watches to authenticated;

create policy core2_watches_read on public.core2_watches
  for select to authenticated
  using (
    sahaj_private.has_role(family_id, array['child'])
    or sahaj_private.is_person(family_id, subject_person_id)
  );

grant select (
  id, family_id, subject_person_id, incident_id, request_id, status,
  delivery_status, responder_accepted, version, countdown_until,
  cancelled_at, safe_at, created_at, updated_at
) on public.core2_sos_events to authenticated;

create policy core2_sos_read on public.core2_sos_events
  for select to authenticated
  using (
    sahaj_private.has_role(family_id, array['child'])
    or sahaj_private.is_person(family_id, subject_person_id)
  );

grant select (
  family_id, subject_person_id, share_status_with_parent,
  allow_location_share, allow_health_share, allow_narrative_share, version, updated_at
) on public.core2_sharing_preferences to authenticated;

create policy core2_sharing_preferences_read on public.core2_sharing_preferences
  for select to authenticated
  using (
    sahaj_private.has_role(family_id, array['child'])
    or sahaj_private.is_person(family_id, subject_person_id)
  );

grant select (
  id, family_id, subject_person_id, recipient_person_id, kind, watch_id, sos_id,
  status_label, delivery_status, delivery_verified, heard_verified,
  location_shared, health_shared, narrative_shared, created_at
) on public.core2_reassurance_updates to authenticated;

create policy core2_reassurance_read on public.core2_reassurance_updates
  for select to authenticated
  using (
    sahaj_private.has_role(family_id, array['child'])
    or sahaj_private.is_person(family_id, subject_person_id)
    or sahaj_private.is_person(family_id, recipient_person_id)
  );

-- Atomic safe-vs-timeout resolution RPC.
-- Locks the watch row, verifies actor & optional version, transitions monotonically to 'safe',
-- clears next_tick_at, and fences any still-armed pending dispatches without modifying sent rows.
create function public.core2_resolve_watch_safe(
  p_family_id uuid,
  p_watch_id uuid,
  p_subject_person_id uuid,
  p_expected_version integer default null,
  p_idempotency_key_hash text default null,
  p_voice_post_id uuid default null
) returns public.core2_watches
language plpgsql
security invoker
set search_path = ''
as $$
declare
  w public.core2_watches;
  now_ts timestamptz := pg_catalog.clock_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('core2:watch:' || p_watch_id::text, 0)
  );

  select * into w
  from public.core2_watches
  where id = p_watch_id and family_id = p_family_id
  for update;

  if w.id is null then
    raise exception 'watch_not_found' using errcode = 'P0002';
  end if;

  if w.subject_person_id <> p_subject_person_id then
    raise exception 'forbidden_watch_subject' using errcode = '42501';
  end if;

  if w.state = 'cancelled' then
    raise exception 'watch_cancelled' using errcode = '40901';
  end if;

  if w.state = 'safe' then
    if p_idempotency_key_hash is not null and w.safe_idempotency_key_hash = p_idempotency_key_hash then
      return w;
    end if;
    if p_expected_version is not null and w.version <> p_expected_version then
      raise exception 'stale_version' using errcode = '40001';
    end if;
    return w;
  end if;

  if p_expected_version is not null and w.version <> p_expected_version then
    raise exception 'stale_version' using errcode = '40001';
  end if;

  update public.core2_watches set
    state = 'safe',
    version = w.version + 1,
    next_tick_at = null,
    safe_at = now_ts,
    safe_idempotency_key_hash = coalesce(p_idempotency_key_hash, safe_idempotency_key_hash),
    safe_voice_post_id = coalesce(p_voice_post_id, safe_voice_post_id),
    updated_at = now_ts
  where id = w.id and family_id = p_family_id and version = w.version
  returning * into strict w;

  if w.incident_id is not null then
    update public.incidents set state = 'done'
    where id = w.incident_id and family_id = p_family_id and state not in ('done', 'closed');

    update public.assignments set status = 'expired'
    where incident_id = w.incident_id and family_id = p_family_id and status = 'offered';
  end if;

  update public.core2_dispatch_fences set
    state = 'fenced_resolved',
    fenced_at = now_ts
  where watch_id = w.id and family_id = p_family_id and state = 'armed';

  update public.outbox o set
    status = 'failed',
    last_error_code = 'watch_resolved_safe'
  from public.core2_dispatch_fences f
  where f.outbox_id = o.id
    and f.watch_id = w.id
    and f.family_id = p_family_id
    and f.state = 'fenced_resolved'
    and o.status = 'pending'
    and o.lease_token is null;

  return w;
end
$$;

-- Single-writer fenced overdue watch tick with SKIP LOCKED and monotonic version bump.
-- Cannot touch 'safe' or 'cancelled' watches even if invoked concurrently with /safe.
create function public.core2_tick_due_watches(
  p_now timestamptz default null,
  p_limit integer default 25
) returns setof public.core2_watches
language plpgsql
security invoker
set search_path = ''
as $$
declare
  now_ts timestamptz := coalesce(p_now, pg_catalog.clock_timestamp());
  w public.core2_watches;
  new_incident_id uuid;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid_tick_limit' using errcode = '22023';
  end if;

  for w in
    select *
    from public.core2_watches
    where state in ('active', 'checking_in')
      and next_tick_at is not null
      and next_tick_at <= now_ts
    order by next_tick_at asc, id asc
    for update skip locked
    limit p_limit
  loop
    if w.state = 'active' and now_ts < w.grace_until then
      update public.core2_watches set
        state = 'checking_in',
        checked_in_at = now_ts,
        next_tick_at = w.grace_until,
        version = w.version + 1,
        updated_at = now_ts
      where id = w.id and state = 'active' and version = w.version
      returning * into strict w;
      return next w;
    elsif now_ts >= w.grace_until then
      new_incident_id := w.incident_id;
      if new_incident_id is null then
        insert into public.incidents (family_id, person_id, request_id, severity, state)
        values (w.family_id, w.subject_person_id, w.request_id, 'urgent', 'open')
        returning id into new_incident_id;
      end if;

      update public.core2_watches set
        state = 'escalated',
        incident_id = new_incident_id,
        checked_in_at = coalesce(w.checked_in_at, now_ts),
        escalated_at = now_ts,
        next_tick_at = null,
        version = w.version + 1,
        updated_at = now_ts
      where id = w.id and state in ('active', 'checking_in') and version = w.version
      returning * into strict w;
      return next w;
    end if;
  end loop;
end
$$;

-- Shared revocation + pre-dispatch fence under per-family advisory lock.
create function public.core2_revoke_trusted_contact(
  p_family_id uuid,
  p_contact_id uuid,
  p_expected_version integer default null
) returns public.core2_trusted_contacts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c public.core2_trusted_contacts;
  now_ts timestamptz := pg_catalog.clock_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('core2:dispatch:' || p_family_id::text, 0)
  );

  select * into c
  from public.core2_trusted_contacts
  where id = p_contact_id and family_id = p_family_id
  for update;

  if c.id is null then
    raise exception 'trusted_contact_not_found' using errcode = 'P0002';
  end if;

  if c.state = 'revoked' then
    return c;
  end if;

  if p_expected_version is not null and c.version <> p_expected_version then
    raise exception 'stale_version' using errcode = '40001';
  end if;

  update public.core2_trusted_contacts set
    state = 'revoked',
    revoked_at = now_ts,
    version = c.version + 1,
    updated_at = now_ts
  where id = c.id and family_id = p_family_id and version = c.version
  returning * into strict c;

  update public.core2_dispatch_fences set
    state = 'fenced_revoked',
    fenced_at = now_ts
  where trusted_contact_id = c.id and family_id = p_family_id and state = 'armed';

  update public.outbox o set
    status = 'failed',
    last_error_code = 'contact_revoked'
  from public.core2_dispatch_fences f
  where f.outbox_id = o.id
    and f.trusted_contact_id = c.id
    and f.family_id = p_family_id
    and f.state = 'fenced_revoked'
    and o.status = 'pending'
    and o.lease_token is null;

  return c;
end
$$;

-- Pre-send claim gate under the same family advisory lock as revocation and /safe.
create function public.core2_claim_fenced_dispatch(
  p_outbox_id uuid
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  f public.core2_dispatch_fences;
  c public.core2_trusted_contacts;
  w public.core2_watches;
  now_ts timestamptz := pg_catalog.clock_timestamp();
begin
  select * into f from public.core2_dispatch_fences where outbox_id = p_outbox_id for update;
  if f.id is null then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('core2:dispatch:' || f.family_id::text, 0)
  );

  if f.state <> 'armed' then
    return false;
  end if;

  if f.trusted_contact_id is not null then
    select * into c
    from public.core2_trusted_contacts
    where id = f.trusted_contact_id and family_id = f.family_id;

    if c.id is null or c.state <> 'active' or c.revoked_at is not null
       or now_ts < c.effective_from
       or (c.effective_until is not null and now_ts >= c.effective_until) then
      update public.core2_dispatch_fences set state = 'fenced_revoked', fenced_at = now_ts where id = f.id;
      return false;
    end if;
  end if;

  if f.watch_id is not null then
    select * into w
    from public.core2_watches
    where id = f.watch_id and family_id = f.family_id;

    if w.id is null or w.state in ('safe', 'cancelled') then
      update public.core2_dispatch_fences set state = 'fenced_resolved', fenced_at = now_ts where id = f.id;
      return false;
    end if;
  end if;

  update public.core2_dispatch_fences set state = 'dispatched' where id = f.id;
  return true;
end
$$;

revoke all on function
  public.core2_resolve_watch_safe(uuid, uuid, uuid, integer, text, uuid),
  public.core2_tick_due_watches(timestamptz, integer),
  public.core2_revoke_trusted_contact(uuid, uuid, integer),
  public.core2_claim_fenced_dispatch(uuid)
from public, anon, authenticated;

grant execute on function
  public.core2_resolve_watch_safe(uuid, uuid, uuid, integer, text, uuid),
  public.core2_tick_due_watches(timestamptz, integer),
  public.core2_revoke_trusted_contact(uuid, uuid, integer),
  public.core2_claim_fenced_dispatch(uuid)
to service_role;
