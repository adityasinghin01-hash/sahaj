-- Phase 5 Core 2 Extension: I2 Fresh Proof of Life + G10/I3 Any-Phone Line (code word = identity).
-- Additive migration extending Core 2 + Shield security; never stores plain-text caller numbers.

create table public.core2_proof_challenges (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  requester_person_id uuid not null,
  subject_person_id uuid not null,
  word_token text not null,
  word_aliases text[] not null default '{}',
  status text not null default 'pending' check (
    status in ('pending', 'verified', 'word_mismatch', 'expired', 'escalated')
  ),
  ttl_seconds integer not null default 60 check (ttl_seconds between 1 and 300),
  expires_at timestamptz not null,
  answered_at timestamptz,
  verified_at timestamptz,
  escalated_at timestamptz,
  voice_media_id uuid,
  voice_post_id uuid,
  voice_object_path text,
  stt_transcript text,
  stt_matched boolean not null default false,
  incident_id uuid,
  request_id uuid,
  offered_contact_person_id uuid,
  offered_contact_name text,
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'verified' or verified_at is not null),
  check (status <> 'escalated' or escalated_at is not null),
  foreign key (family_id, requester_person_id) references public.people(family_id, id),
  foreign key (family_id, subject_person_id) references public.people(family_id, id),
  foreign key (family_id, incident_id) references public.incidents(family_id, id),
  foreign key (family_id, request_id) references public.requests(family_id, id),
  foreign key (family_id, voice_post_id) references public.voice_posts(family_id, id),
  unique (family_id, id)
);

create index core2_proof_challenges_family_subject_idx
  on public.core2_proof_challenges (family_id, subject_person_id, created_at desc);

create index core2_proof_challenges_due_idx
  on public.core2_proof_challenges (expires_at)
  where status in ('pending', 'word_mismatch');

alter table public.core2_proof_challenges enable row level security;

revoke all on public.core2_proof_challenges from public, anon, authenticated;
grant all on public.core2_proof_challenges to service_role;
grant select (
  id, family_id, requester_person_id, subject_person_id, word_token, status,
  ttl_seconds, expires_at, answered_at, verified_at, escalated_at,
  voice_media_id, voice_post_id, stt_matched, incident_id, offered_contact_name,
  attempts, created_at, updated_at
) on public.core2_proof_challenges to authenticated;

create policy core2_proof_challenges_family_read on public.core2_proof_challenges
  for select to authenticated
  using (
    sahaj_private.is_person(family_id, subject_person_id)
    or sahaj_private.is_person(family_id, requester_person_id)
    or sahaj_private.has_role(family_id, array['parent', 'child'])
  );

-- Per-family any-phone code-word attempt counter and 15-minute lockout guard.
create table public.core2_any_phone_guards (
  family_id uuid primary key references public.families(id) on delete cascade,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  last_failed_at timestamptz,
  last_verified_at timestamptz,
  last_rotated_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.core2_any_phone_guards enable row level security;

revoke all on public.core2_any_phone_guards from public, anon, authenticated;
grant all on public.core2_any_phone_guards to service_role;

-- Verified any-phone caller sessions (limited powers; caller phone number never stored in plain text).
create table public.core2_any_phone_sessions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  subject_person_id uuid not null,
  incident_id uuid not null,
  request_id uuid not null,
  call_ref_hash text check (call_ref_hash is null or call_ref_hash ~ '^[0-9a-f]{64}$'),
  caller_channel text not null default 'any_phone',
  granted_powers text[] not null default array['reassure_parent', 'request_local_circle_help']::text[],
  denied_powers text[] not null default array['change_settings', 'view_location', 'approve_money']::text[],
  code_word_rotated boolean not null default true,
  voice_post_id uuid,
  voice_object_path text,
  status_message_hi text not null,
  status_message_en text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not ('change_settings' = any(granted_powers))),
  check (not ('view_location' = any(granted_powers))),
  check (not ('approve_money' = any(granted_powers))),
  foreign key (family_id, subject_person_id) references public.people(family_id, id),
  foreign key (family_id, incident_id) references public.incidents(family_id, id),
  foreign key (family_id, request_id) references public.requests(family_id, id),
  foreign key (family_id, voice_post_id) references public.voice_posts(family_id, id),
  unique (family_id, id)
);

create index core2_any_phone_sessions_family_idx
  on public.core2_any_phone_sessions (family_id, created_at desc);

alter table public.core2_any_phone_sessions enable row level security;

revoke all on public.core2_any_phone_sessions from public, anon, authenticated;
grant all on public.core2_any_phone_sessions to service_role;
grant select (
  id, family_id, subject_person_id, incident_id, request_id, caller_channel,
  granted_powers, denied_powers, code_word_rotated, voice_post_id,
  status_message_hi, status_message_en, created_at, updated_at
) on public.core2_any_phone_sessions to authenticated;

create policy core2_any_phone_sessions_family_read on public.core2_any_phone_sessions
  for select to authenticated
  using (
    sahaj_private.is_person(family_id, subject_person_id)
    or sahaj_private.has_role(family_id, array['parent', 'child'])
  );

-- Atomic lockout + attempt counter for G10 any-phone code-word verification.
create function public.core2_record_any_phone_attempt(
  p_family_id uuid,
  p_ok boolean,
  p_max_attempts integer default 3,
  p_lock_seconds integer default 900,
  p_now timestamptz default null
) returns table (
  locked boolean,
  locked_until timestamptz,
  failed_attempts integer,
  remaining_attempts integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  now_ts timestamptz := coalesce(p_now, pg_catalog.clock_timestamp());
  g public.core2_any_phone_guards;
  next_attempts integer;
  next_lock timestamptz;
begin
  if p_max_attempts < 1 or p_max_attempts > 10 then
    raise exception 'invalid_max_attempts' using errcode = '22023';
  end if;
  if p_lock_seconds < 1 or p_lock_seconds > 86400 then
    raise exception 'invalid_lock_seconds' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('core2:anyphone:' || p_family_id::text, 0)
  );

  insert into public.core2_any_phone_guards (family_id)
  values (p_family_id)
  on conflict (family_id) do nothing;

  select * into g
  from public.core2_any_phone_guards
  where family_id = p_family_id
  for update;

  if g.locked_until is not null and g.locked_until > now_ts then
    locked := true;
    locked_until := g.locked_until;
    failed_attempts := g.failed_attempts;
    remaining_attempts := 0;
    return next;
    return;
  end if;

  -- Previous lock expired: reset failure window before evaluating this attempt.
  if g.locked_until is not null and g.locked_until <= now_ts then
    g.failed_attempts := 0;
  end if;

  if p_ok then
    update public.core2_any_phone_guards set
      failed_attempts = 0,
      locked_until = null,
      last_verified_at = now_ts,
      last_rotated_at = now_ts,
      updated_at = now_ts
    where family_id = p_family_id;

    locked := false;
    locked_until := null;
    failed_attempts := 0;
    remaining_attempts := p_max_attempts;
    return next;
    return;
  end if;

  next_attempts := g.failed_attempts + 1;
  if next_attempts >= p_max_attempts then
    next_lock := now_ts + pg_catalog.make_interval(secs => p_lock_seconds);
  else
    next_lock := null;
  end if;

  update public.core2_any_phone_guards set
    failed_attempts = next_attempts,
    locked_until = next_lock,
    last_failed_at = now_ts,
    updated_at = now_ts
  where family_id = p_family_id;

  locked := next_lock is not null;
  locked_until := next_lock;
  failed_attempts := next_attempts;
  remaining_attempts := greatest(0, p_max_attempts - next_attempts);
  return next;
end
$$;

-- Rotate the shared Shield family code-word hash after a successful any-phone verification.
create function public.core2_rotate_shield_code_word(
  p_family_id uuid,
  p_new_hash text
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_new_hash is null or p_new_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_code_word_hash' using errcode = '22023';
  end if;

  insert into public.shield_family_security (family_id, code_word_hash)
  values (p_family_id, p_new_hash)
  on conflict (family_id) do update
    set code_word_hash = excluded.code_word_hash;
end
$$;

-- Claim due proof-of-life challenges whose TTL elapsed without a verified answer.
create function public.core2_claim_due_proof_challenges(
  p_now timestamptz default null,
  p_limit integer default 25
) returns setof public.core2_proof_challenges
language plpgsql
security invoker
set search_path = ''
as $$
declare
  now_ts timestamptz := coalesce(p_now, pg_catalog.clock_timestamp());
begin
  return query
  with due as (
    select c.id
    from public.core2_proof_challenges c
    where c.status in ('pending', 'word_mismatch')
      and c.expires_at <= now_ts
    order by c.expires_at asc
    limit greatest(1, least(p_limit, 100))
    for update skip locked
  )
  update public.core2_proof_challenges c set
    status = 'expired',
    updated_at = now_ts
  from due
  where c.id = due.id
  returning c.*;
end
$$;

revoke all on function
  public.core2_record_any_phone_attempt(uuid, boolean, integer, integer, timestamptz),
  public.core2_rotate_shield_code_word(uuid, text),
  public.core2_claim_due_proof_challenges(timestamptz, integer)
from public, anon, authenticated;

grant execute on function
  public.core2_record_any_phone_attempt(uuid, boolean, integer, integer, timestamptz),
  public.core2_rotate_shield_code_word(uuid, text),
  public.core2_claim_due_proof_challenges(timestamptz, integer)
to service_role;
