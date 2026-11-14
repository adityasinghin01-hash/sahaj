-- Shield busy-line watch + shared scam warnings (Core 3 Steps 2.4 + 2.5, card K-B5).
-- DEPENDS ON: 20261114160100_shield.sql (shield_verdicts) and Singhal's public.families / public.people /
-- public.family_memberships (same as the earlier Shield migrations).
--
-- Access model (same as the other Shield tables):
--   * busy_streaks: family members (authenticated) may SELECT their own family's rows. Only service_role writes.
--   * scam_indicators, scam_indicator_sightings: service role only (RLS on, no policies, no grants to
--     anon/authenticated). The check-in agent reads tips through the server.
--   * shield_record_scam_indicator(): execute for service_role only.
--
-- Privacy: scam_indicators never stores a raw number, domain or message. `fingerprint` is
-- hex(SHA-256(normalised value)), computed in packages/shield/src/warnings/fingerprint.ts.

-- ---------------------------------------------------------------------------
-- busy_streaks: a run of "busy" results when Sahaj calls a keypad parent in a check-in window.
-- A streak is open while ended_at is null; at most one open streak per parent.
-- ---------------------------------------------------------------------------
create table public.busy_streaks (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  family_id        uuid not null references public.families(id) on delete cascade,
  parent_id        uuid not null references public.people(id) on delete cascade,
  started_at       timestamptz not null,               -- first busy result
  last_busy_at     timestamptz not null,               -- latest busy result
  busy_count       integer not null default 1 check (busy_count >= 1),
  ended_at         timestamptz,                        -- connected: time of the connected call; stale: last_busy_at
  end_reason       text check (end_reason in ('connected', 'stale')),
  alerted_at       timestamptz,                        -- child alerted (once per streak)
  alert_minutes    integer check (alert_minutes >= 0),
  child_replied_at timestamptz,                        -- child answered the busy alert
  circled_at       timestamptz,                        -- circle chain started (once per streak)
  check (last_busy_at >= started_at),
  check ((ended_at is null) = (end_reason is null)),
  check (ended_at is null or ended_at >= started_at)
);

create unique index busy_streaks_one_open_idx
  on public.busy_streaks (parent_id) where ended_at is null;
create index busy_streaks_parent_started_idx
  on public.busy_streaks (parent_id, started_at desc);
create index busy_streaks_family_idx on public.busy_streaks (family_id);

-- ---------------------------------------------------------------------------
-- scam_indicators: shared, cross-family scam fingerprints. No family id, no raw values.
-- ---------------------------------------------------------------------------
create table public.scam_indicators (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  kind              text not null check (kind in ('number', 'domain', 'template')),
  fingerprint       text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  scam_type         text not null
    check (scam_type in ('digital_arrest', 'kyc_block', 'electricity_cut', 'parcel_customs',
                         'lottery_prize', 'job_task', 'family_in_trouble', 'wedding_invite_apk',
                         'refund_cashback', 'sextortion_threat', 'otp_theft', 'remote_access',
                         'unknown')),
  summary_hi        text not null check (char_length(summary_hi) between 1 and 300),
  summary_en        text not null check (char_length(summary_en) between 1 and 300),
  times_seen        integer not null default 0 check (times_seen >= 0),
  families_affected integer not null default 0 check (families_affected >= 0),
  confirmed         boolean not null default false,
  first_seen_at     timestamptz not null,
  last_seen_at      timestamptz not null,
  unique (kind, fingerprint)
);

-- One row per (indicator, verdict): the same verdict marked "fraud" twice counts once.
-- families_affected = count(distinct family_id) over these rows.
create table public.scam_indicator_sightings (
  indicator_id uuid not null references public.scam_indicators(id) on delete cascade,
  verdict_id   uuid not null references public.shield_verdicts(id) on delete cascade,
  family_id    uuid not null references public.families(id) on delete cascade,
  seen_at      timestamptz not null,
  primary key (indicator_id, verdict_id)
);

create index scam_indicator_sightings_seen_idx on public.scam_indicator_sightings (seen_at desc);

-- ---------------------------------------------------------------------------
-- shield_record_scam_indicator: upsert one indicator and count one sighting, atomically.
-- The indicator row is locked (FOR UPDATE) before the sighting insert, so concurrent reports
-- of the same scam from two families serialise and families_affected is always exact.
-- The first report's scam_type and summaries are kept.
-- An indicator becomes confirmed (and stays confirmed) once p_confirm_min_families families saw it.
-- ---------------------------------------------------------------------------
create function public.shield_record_scam_indicator(
  p_kind                 text,
  p_fingerprint          text,
  p_scam_type            text,
  p_summary_hi           text,
  p_summary_en           text,
  p_family_id            uuid,
  p_verdict_id           uuid,
  p_seen_at              timestamptz,
  p_confirm_min_families integer
)
returns table (r_id uuid, r_times_seen integer, r_families_affected integer, r_confirmed boolean, r_counted boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid;
  v_n  integer;
begin
  insert into public.scam_indicators
    (kind, fingerprint, scam_type, summary_hi, summary_en, first_seen_at, last_seen_at)
  values
    (p_kind, p_fingerprint, p_scam_type, p_summary_hi, p_summary_en, p_seen_at, p_seen_at)
  on conflict (kind, fingerprint) do nothing;

  select i.id into v_id
  from public.scam_indicators i
  where i.kind = p_kind and i.fingerprint = p_fingerprint
  for update;

  insert into public.scam_indicator_sightings (indicator_id, verdict_id, family_id, seen_at)
  values (v_id, p_verdict_id, p_family_id, p_seen_at)
  on conflict (indicator_id, verdict_id) do nothing;
  get diagnostics v_n = row_count;

  if v_n > 0 then
    update public.scam_indicators i
    set times_seen        = i.times_seen + 1,
        families_affected = c.n,
        last_seen_at      = greatest(i.last_seen_at, p_seen_at),
        confirmed         = i.confirmed or c.n >= p_confirm_min_families
    from (select count(distinct s.family_id)::integer as n
          from public.scam_indicator_sightings s
          where s.indicator_id = v_id) c
    where i.id = v_id;
  end if;

  return query
    select i.id, i.times_seen, i.families_affected, i.confirmed, v_n > 0
    from public.scam_indicators i
    where i.id = v_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Privileges. Supabase grants ALL on new public tables (and EXECUTE on new functions) to
-- anon/authenticated by default, so revoke first and grant back only what is intended.
-- ---------------------------------------------------------------------------
revoke all on public.busy_streaks, public.scam_indicators, public.scam_indicator_sightings
  from public, anon, authenticated;

grant select on public.busy_streaks to authenticated;

grant all on public.busy_streaks, public.scam_indicators, public.scam_indicator_sightings
  to service_role;

revoke all on function public.shield_record_scam_indicator(text, text, text, text, text, uuid, uuid, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.shield_record_scam_indicator(text, text, text, text, text, uuid, uuid, timestamptz, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Row-level security. service_role has BYPASSRLS, so no write policies are needed.
-- ---------------------------------------------------------------------------
alter table public.busy_streaks             enable row level security;
alter table public.scam_indicators          enable row level security;
alter table public.scam_indicator_sightings enable row level security;

create policy busy_streaks_select_family on public.busy_streaks
  for select to authenticated
  using (exists (select 1 from public.family_memberships m
                 where m.revoked_at is null and m.family_id = busy_streaks.family_id
                   and m.user_id = (select auth.uid())));
