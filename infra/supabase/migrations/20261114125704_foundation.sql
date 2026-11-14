-- Sahaj Core 1 Milestone 1: starter schema only. Run in a DEDICATED Sahaj project.
-- No browser/mobile role is granted direct access in this migration.
create extension if not exists pgcrypto;

create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  language text not null default 'hi',
  demo boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  display_name text not null,
  role text not null check (role in ('parent','child','circle','vendor')),
  device text check (device in ('keypad','smartphone') or device is null),
  timezone text not null default 'Asia/Kolkata',
  created_at timestamptz not null default now()
);

create table if not exists public.raw_events (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references public.families(id) on delete cascade,
  source text not null,
  provider_event_id text not null,
  event_type text not null,
  -- Metadata only until consent, encryption, retention, and field masking are implemented.
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','processing','processed','failed')),
  received_at timestamptz not null default now(),
  unique(source, provider_event_id)
);

create table if not exists public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references public.families(id) on delete cascade,
  key_hash text not null unique,
  action text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.timeline_events (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  event_type text not null,
  entity_id uuid,
  human_line text not null,
  payload_hash text not null,
  prev_chain_hash text,
  chain_hash text not null,
  signature text not null,
  signing_key_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists people_family_id_idx on public.people(family_id);
create index if not exists raw_events_family_received_idx on public.raw_events(family_id, received_at desc);
create index if not exists timeline_events_family_created_idx on public.timeline_events(family_id, created_at desc);

alter table public.families enable row level security;
alter table public.people enable row level security;
alter table public.raw_events enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.timeline_events enable row level security;

-- Default deny for anon/authenticated until explicit family membership policies are tested.
revoke all on public.families, public.people, public.raw_events, public.idempotency_keys, public.timeline_events from anon, authenticated;
