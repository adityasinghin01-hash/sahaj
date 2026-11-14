-- Dev-only stopgap tables for apps/shield-api (card AGY-05).
-- Removed once Singhal's production API, Atlas job runner, and Ed25519 timeline replace this app.
-- Service role only: RLS is enabled on every table with no anon/authenticated grants or policies.

-- ---------------------------------------------------------------------------
-- dev_outbox: local visibility for alerts/calls/Atlas actions before Singhal wires real providers.
-- ---------------------------------------------------------------------------
create table public.dev_outbox (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  channel    text not null check (channel in ('whatsapp', 'push', 'calls', 'atlas')),
  kind       text not null,
  family_id  uuid,
  parent_id  uuid,
  dedupe_key text unique,
  payload    jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object')
);

create index dev_outbox_created_idx on public.dev_outbox (created_at desc, id desc);
create index dev_outbox_family_idx  on public.dev_outbox (family_id, created_at desc);

-- ---------------------------------------------------------------------------
-- shield_jobs: durable delayed jobs + run-once claim ledger for Shield runtime.
-- ---------------------------------------------------------------------------
create table public.shield_jobs (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name       text not null,
  payload    jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  run_at     timestamptz not null,
  status     text not null default 'pending' check (status in ('pending', 'done', 'failed', 'claimed')),
  claim_key  text unique,
  attempts   integer not null default 0 check (attempts >= 0),
  last_error text,
  done_at    timestamptz
);

create index shield_jobs_due_idx on public.shield_jobs (run_at, id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- dev_timeline: SHA-256 hash-chained audit timeline (Singhal's Ed25519 signing replaces this later).
-- ---------------------------------------------------------------------------
create table public.dev_timeline (
  seq        bigserial primary key,
  id         uuid not null default gen_random_uuid() unique,
  created_at timestamptz not null default now(),
  family_id  uuid not null,
  parent_id  uuid,
  event_key  text,
  verdict_id uuid,
  kind       text not null check (kind in ('brain', 'voice')),
  step       text not null,
  status     text,
  entry      jsonb not null check (jsonb_typeof(entry) = 'object'),
  prev_hash  text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash       text not null check (hash ~ '^[0-9a-f]{64}$')
);

create index dev_timeline_family_seq_idx on public.dev_timeline (family_id, seq desc);

-- ---------------------------------------------------------------------------
-- dev_cache: Link-check result cache with TTL (expires_at).
-- ---------------------------------------------------------------------------
create table public.dev_cache (
  key        text primary key,
  value      jsonb not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index dev_cache_expires_idx on public.dev_cache (expires_at);

-- ---------------------------------------------------------------------------
-- Privileges + RLS: service role only.
-- ---------------------------------------------------------------------------
revoke all on public.dev_outbox, public.shield_jobs, public.dev_timeline, public.dev_cache
  from public, anon, authenticated;

grant all on public.dev_outbox, public.shield_jobs, public.dev_timeline, public.dev_cache
  to service_role;

grant usage, select on sequence public.dev_timeline_seq_seq to service_role;

alter table public.dev_outbox   enable row level security;
alter table public.shield_jobs  enable row level security;
alter table public.dev_timeline enable row level security;
alter table public.dev_cache    enable row level security;

