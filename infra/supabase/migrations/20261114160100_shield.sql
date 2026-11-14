-- Shield tables + row-level security (Core 3 Step 1.2, card K-A1).
-- Field names and enum values mirror packages/shared/src/shield.ts.
--
-- DEPENDS ON (Singhal's migration):
--   public.families(id uuid primary key)
--   public.family_memberships(family_id uuid references families, user_id uuid, person_id uuid, role text)
--   public.people(id uuid primary key, family_id uuid)
--   auth.uid()  (provided by Supabase)
-- The SELECT policies below read public.family_memberships as the calling user, so
-- an authenticated user must be able to read their own family_memberships rows.
--
-- Access model:
--   * Family members (authenticated) may SELECT rows of their own families only.
--   * Only service_role (bypasses RLS) writes. anon/authenticated have no
--     INSERT/UPDATE/DELETE grants or policies.
--   * Exception: authenticated family members may UPDATE shield_verdicts.child_feedback
--     and shield_verdicts.feedback_at (column grant + policy).

-- ---------------------------------------------------------------------------
-- shield_devices: a paired parent phone running the Shield app.
-- ---------------------------------------------------------------------------
create table public.shield_devices (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  family_id          uuid not null references public.families(id) on delete cascade,
  person_id          uuid not null references public.people(id) on delete cascade,
  label              text,
  platform           text not null default 'android',
  android_version    text,
  paired_at          timestamptz not null default now(),
  device_secret_hash text not null,  -- hash only; the device secret itself is never stored
  protections        jsonb not null default
    '{"sms":false,"screening":false,"redirection":false,"usage":false,"notifications":false,"overlay":false}'::jsonb
    check (jsonb_typeof(protections) = 'object'),
  last_heartbeat_at  timestamptz
);

create index shield_devices_family_idx on public.shield_devices (family_id);

-- ---------------------------------------------------------------------------
-- shield_events: masked signals from a device / keypad tool (ShieldEvent).
-- ---------------------------------------------------------------------------
create table public.shield_events (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  family_id       uuid not null references public.families(id) on delete cascade,
  parent_id       uuid not null references public.people(id) on delete cascade,
  device_id       uuid references public.shield_devices(id) on delete set null,
  channel         text not null
    check (channel in ('device', 'keypad_voice', 'gateway_sms', 'busy_watch')),
  kind            text not null
    check (kind in ('sms', 'call_in', 'call_out', 'call_state', 'app_open',
                    'notification', 'install', 'voice_report')),
  masked_text     text check (char_length(masked_text) <= 2000),
  sender_type     text
    check (sender_type in ('business_header', 'mobile_10', 'international',
                           'short_code', 'saved_contact', 'unknown')),
  caller_type     text
    check (caller_type in ('series_1600', 'series_140', 'mobile_10',
                           'international', 'saved_contact', 'unknown')),
  link_domains    text[] not null default '{}',
  matched_rules   text[] not null default '{}',
  local_level     text check (local_level in ('green', 'yellow', 'red')),
  context         jsonb not null default '{}'::jsonb
    check (jsonb_typeof(context) = 'object'),
  occurred_at     timestamptz not null,
  idempotency_key text not null unique
    check (char_length(idempotency_key) >= 8)
);

create index shield_events_family_created_idx
  on public.shield_events (family_id, created_at desc);

-- ---------------------------------------------------------------------------
-- shield_verdicts: server decision over one or more events (Verdict).
-- ---------------------------------------------------------------------------
create table public.shield_verdicts (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  family_id      uuid not null references public.families(id) on delete cascade,
  parent_id      uuid not null references public.people(id) on delete cascade,
  event_ids      uuid[] not null default '{}',
  level          text not null check (level in ('green', 'yellow', 'red')),
  scam_type      text not null
    check (scam_type in ('digital_arrest', 'kyc_block', 'electricity_cut', 'parcel_customs',
                         'lottery_prize', 'job_task', 'family_in_trouble', 'wedding_invite_apk',
                         'refund_cashback', 'sextortion_threat', 'otp_theft', 'remote_access',
                         'unknown')),
  reasons        jsonb not null default '[]'::jsonb
    check (jsonb_typeof(reasons) = 'array'),  -- [{rule_id, hi, en}]
  checks_fired   text[] not null default '{}',
  ai_used        boolean not null default false,
  models_agreed  text[] not null default '{}',
  confidence     numeric not null check (confidence >= 0 and confidence <= 1),
  actions        text[] not null default '{}'
    check (actions <@ array['speak_clip', 'show_red_screen', 'alert_child', 'bridge_child',
                            'circle_chain', 'pause_call', 'watch_numbers_24h', 'offer_1930']::text[]),
  child_feedback text check (child_feedback in ('safe', 'fraud')),
  feedback_at    timestamptz
);

create index shield_verdicts_family_created_idx
  on public.shield_verdicts (family_id, created_at desc);

-- ---------------------------------------------------------------------------
-- family_checks: "is this really your son?" checks sent to a family member.
-- ---------------------------------------------------------------------------
create table public.family_checks (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  family_id       uuid not null references public.families(id) on delete cascade,
  parent_id       uuid not null references public.people(id) on delete cascade,
  claimed_name    text,
  asked_person_id uuid references public.people(id) on delete set null,
  channel         text not null check (channel in ('whatsapp', 'call')),
  state           text not null default 'asked'
    check (state in ('asked', 'confirmed', 'denied', 'no_answer')),
  asked_at        timestamptz not null default now(),
  answered_at     timestamptz
);

create index family_checks_family_idx on public.family_checks (family_id);

-- ---------------------------------------------------------------------------
-- Privileges. Supabase grants ALL on new public tables to anon/authenticated by
-- default, so revoke first and grant back only what is intended.
-- ---------------------------------------------------------------------------
revoke all on public.shield_devices, public.shield_events,
              public.shield_verdicts, public.family_checks
  from public, anon, authenticated;

grant select on public.shield_devices, public.shield_events,
                public.shield_verdicts, public.family_checks
  to authenticated;

grant update (child_feedback, feedback_at) on public.shield_verdicts to authenticated;

grant all on public.shield_devices, public.shield_events,
             public.shield_verdicts, public.family_checks
  to service_role;

-- ---------------------------------------------------------------------------
-- Row-level security. service_role has BYPASSRLS, so no write policies are needed.
-- ---------------------------------------------------------------------------
alter table public.shield_devices  enable row level security;
alter table public.shield_events   enable row level security;
alter table public.shield_verdicts enable row level security;
alter table public.family_checks   enable row level security;

create policy shield_devices_select_family on public.shield_devices
  for select to authenticated
  using (exists (select 1 from public.family_memberships m
                 where m.revoked_at is null and m.family_id = shield_devices.family_id
                   and m.user_id = (select auth.uid())));

create policy shield_events_select_family on public.shield_events
  for select to authenticated
  using (exists (select 1 from public.family_memberships m
                 where m.revoked_at is null and m.family_id = shield_events.family_id
                   and m.user_id = (select auth.uid())));

create policy shield_verdicts_select_family on public.shield_verdicts
  for select to authenticated
  using (exists (select 1 from public.family_memberships m
                 where m.revoked_at is null and m.family_id = shield_verdicts.family_id
                   and m.user_id = (select auth.uid())));

-- Column grant above limits which columns; this policy limits which rows.
create policy shield_verdicts_feedback_family on public.shield_verdicts
  for update to authenticated
  using (exists (select 1 from public.family_memberships m
                 where m.revoked_at is null and m.family_id = shield_verdicts.family_id
                   and m.user_id = (select auth.uid())))
  with check (exists (select 1 from public.family_memberships m
                      where m.revoked_at is null and m.family_id = shield_verdicts.family_id
                        and m.user_id = (select auth.uid())));

create policy family_checks_select_family on public.family_checks
  for select to authenticated
  using (exists (select 1 from public.family_memberships m
                 where m.revoked_at is null and m.family_id = family_checks.family_id
                   and m.user_id = (select auth.uid())));

-- ---------------------------------------------------------------------------
-- Realtime: the app subscribes to new verdicts. Skipped if the publication is
-- absent (plain Postgres test DB) or the table is already in it.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime'
                       and schemaname = 'public' and tablename = 'shield_verdicts') then
    execute 'alter publication supabase_realtime add table public.shield_verdicts';
  end if;
end
$$;
