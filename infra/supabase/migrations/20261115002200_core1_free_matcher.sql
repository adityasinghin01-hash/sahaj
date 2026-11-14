-- Core 1 C3: Automatic both-free matcher windows and one-per-day nudge log.
-- Strictly family-scoped with composite tenant foreign keys and server-only writes.

create table if not exists public.core1_free_windows (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  person_id uuid not null,
  timezone text not null default 'Asia/Kolkata',
  start_minute integer not null check (start_minute between 0 and 1439),
  end_minute integer not null check (end_minute between 1 and 1440 and start_minute <> end_minute),
  kind text not null default 'recurring' check (kind in ('recurring', 'ad_hoc')),
  days_of_week integer[] check (
    days_of_week is null or (
      array_length(days_of_week, 1) between 1 and 7
      and days_of_week <@ array[0, 1, 2, 3, 4, 5, 6]
    )
  ),
  expires_at timestamptz,
  source text not null default 'app' check (source in ('app', 'sarvam_checkin', 'free_now')),
  label text not null default '',
  raw_said text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (family_id, person_id) references public.people(family_id, id) on delete cascade,
  check ((kind = 'ad_hoc' and expires_at is not null) or (kind = 'recurring'))
);

create index if not exists core1_free_windows_family_person_idx
  on public.core1_free_windows(family_id, person_id)
  where active = true;

create index if not exists core1_free_windows_active_idx
  on public.core1_free_windows(family_id, active, expires_at);

create table if not exists public.core1_matcher_nudge_log (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  parent_person_id uuid not null,
  child_person_id uuid not null,
  local_date date not null,
  nudge_id uuid,
  outbox_id uuid,
  child_alert_id uuid,
  status text not null default 'sent' check (status in ('sent', 'skipped', 'failed')),
  matched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (family_id, parent_person_id) references public.people(family_id, id) on delete cascade,
  foreign key (family_id, child_person_id) references public.people(family_id, id) on delete cascade,
  check (parent_person_id <> child_person_id),
  unique (family_id, parent_person_id, local_date)
);

create index if not exists core1_matcher_nudge_log_family_date_idx
  on public.core1_matcher_nudge_log(family_id, local_date desc);

alter table public.core1_free_windows enable row level security;
alter table public.core1_matcher_nudge_log enable row level security;

revoke all on public.core1_free_windows from public, anon, authenticated;
revoke all on public.core1_matcher_nudge_log from public, anon, authenticated;

grant all on public.core1_free_windows to service_role;
grant all on public.core1_matcher_nudge_log to service_role;

grant select on public.core1_free_windows to authenticated;
grant select on public.core1_matcher_nudge_log to authenticated;

create policy core1_free_windows_family_read on public.core1_free_windows
  for select to authenticated
  using (
    sahaj_private.has_role(family_id, array['child'])
    or sahaj_private.is_person(family_id, person_id)
  );

create policy core1_matcher_nudge_log_child_read on public.core1_matcher_nudge_log
  for select to authenticated
  using (sahaj_private.has_role(family_id, array['child']));
