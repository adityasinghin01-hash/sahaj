-- Shield SMS gateway: registered keypad parents (Core 3 Step 3.4, card K-B6).
-- DEPENDS ON: 20261114160100_shield.sql and Singhal's public.families / public.people.
--
-- A spare Android phone in "gateway mode" forwards each SMS a keypad parent sends to
-- "1 Sahaj SMS". The server accepts a forward only if the sender's phone is registered here.
--
-- Only the hash is stored: phone_hash = hex(SHA-256(last 10 digits of the number)), the same
-- rule as numberFingerprint() in packages/shield/src/warnings/fingerprint.ts. The number itself
-- is never stored.
--
-- Service role only: RLS is on, there are no policies, and anon/authenticated have no grants.
-- (A bare SHA-256 of a 10-digit number can be reversed by brute force, so the hashes are not
-- shown to app users either.)

create table public.shield_gateway_parents (
  phone_hash text primary key check (phone_hash ~ '^[0-9a-f]{64}$'),
  family_id  uuid not null references public.families(id) on delete cascade,
  parent_id  uuid not null references public.people(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index shield_gateway_parents_family_idx on public.shield_gateway_parents (family_id);

revoke all on public.shield_gateway_parents from public, anon, authenticated;
grant all on public.shield_gateway_parents to service_role;

alter table public.shield_gateway_parents enable row level security;
