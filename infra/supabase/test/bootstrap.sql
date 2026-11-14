-- Disposable local/test Supabase platform surface only; care tables come from foundation.
-- Never apply this to a hosted project or the existing lab database.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role login bypassrls; end if;
end $$;
grant anon,authenticated to service_role;
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key);
grant all on auth.users to service_role;
-- Same lookup order as hosted Supabase auth.uid(): legacy request.jwt.claim.sub, then request.jwt.claims->>'sub'.
create or replace function auth.uid() returns uuid language sql stable as $$
 select coalesce(
   nullif(current_setting('request.jwt.claim.sub',true),''),
   nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'
 )::uuid
$$;
grant usage on schema auth,public to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;
create schema if not exists storage;
create table if not exists storage.buckets(id text primary key,name text,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);
create table if not exists storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
alter table storage.objects enable row level security;
