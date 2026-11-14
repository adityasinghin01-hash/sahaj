-- Shield-only needs absent from the authoritative foundation. No plaintext routing columns.
alter table public.people add column aliases text[] not null default '{}';
revoke select(aliases),insert(aliases),update(aliases) on public.people from public,anon,authenticated;
create table public.shield_family_security (
  family_id uuid primary key references public.families(id) on delete cascade,
  code_word_hash text check(code_word_hash is null or code_word_hash ~ '^[0-9a-f]{64}$')
);
alter table public.shield_family_security enable row level security;
revoke all on public.shield_family_security from public,anon,authenticated;
grant all on public.shield_family_security to service_role;
