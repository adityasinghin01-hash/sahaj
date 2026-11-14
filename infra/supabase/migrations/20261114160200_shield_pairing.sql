-- Shield phone pairing (Core 3 Step 1.3, card K-B2).
-- DEPENDS ON: 20261114160100_shield.sql (shield_devices) and Singhal's public.families.
--
-- Service role only: RLS is on, there are no policies, and anon/authenticated have no grants.
-- Codes are stored as hex(SHA-256(code)); the 6-digit code itself is never stored.

-- ---------------------------------------------------------------------------
-- shield_pairing_codes: one-time 6-digit codes, valid 10 minutes, max 5 active per family.
-- ---------------------------------------------------------------------------
create table public.shield_pairing_codes (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  family_id          uuid not null references public.families(id) on delete cascade,
  created_by_user_id uuid not null,
  code_hash          text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at         timestamptz not null,
  used_at            timestamptz
);

-- Lookup used by the claim:
--   update shield_pairing_codes set used_at = now()
--   where family_id = $1 and code_hash = $2 and used_at is null and expires_at > now()
--   returning id;
-- The single conditional UPDATE makes the code single-use under concurrent requests.
create index shield_pairing_codes_active_idx
  on public.shield_pairing_codes (family_id, code_hash)
  where used_at is null;

-- ---------------------------------------------------------------------------
-- shield_pairing_failures: wrong-code attempts, counted per family over 10 minutes.
-- ---------------------------------------------------------------------------
create table public.shield_pairing_failures (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  attempted_at timestamptz not null default now()
);

create index shield_pairing_failures_family_idx
  on public.shield_pairing_failures (family_id, attempted_at desc);

-- ---------------------------------------------------------------------------
-- shield_pairing_locks: set after 5 wrong codes in 10 minutes; pairing refused until locked_until.
-- ---------------------------------------------------------------------------
create table public.shield_pairing_locks (
  family_id    uuid primary key references public.families(id) on delete cascade,
  locked_until timestamptz not null
);

-- ---------------------------------------------------------------------------
-- Privileges + RLS: service role only.
-- ---------------------------------------------------------------------------
revoke all on public.shield_pairing_codes, public.shield_pairing_failures, public.shield_pairing_locks
  from public, anon, authenticated;

grant all on public.shield_pairing_codes, public.shield_pairing_failures, public.shield_pairing_locks
  to service_role;

alter table public.shield_pairing_codes    enable row level security;
alter table public.shield_pairing_failures enable row level security;
alter table public.shield_pairing_locks    enable row level security;
