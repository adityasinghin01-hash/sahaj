-- DEV ONLY: minimal core tables for a fresh local/dev Postgres database when Singhal's
-- core migrations are not present. Do NOT apply to an environment that already has core tables.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role login bypassrls;
  end if;
end
$$;

create schema if not exists auth;

do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $fn$
      create function auth.uid() returns uuid language sql stable as $body$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $body$;
    $fn$;
  end if;
end
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table if not exists public.families (
  id             uuid primary key default gen_random_uuid(),
  name           text,
  code_word_hash text,
  created_at     timestamptz not null default now()
);

create table if not exists public.people (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families(id) on delete cascade,
  name       text not null,
  aliases    text[] not null default '{}',
  role       text,
  phone      text,
  created_at timestamptz not null default now()
);

create index if not exists people_family_idx on public.people (family_id);

create table if not exists public.family_members (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families(id) on delete cascade,
  user_id    uuid not null,
  person_id  uuid references public.people(id) on delete set null,
  role       text not null,
  created_at timestamptz not null default now()
);

create index if not exists family_members_family_idx on public.family_members (family_id);
create index if not exists family_members_user_idx   on public.family_members (user_id);

grant select on public.families, public.people, public.family_members to authenticated;
grant all on public.families, public.people, public.family_members to service_role;

