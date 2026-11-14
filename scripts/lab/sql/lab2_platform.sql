-- LAB ONLY (scripts/lab/lab-reset2.sh). Never apply to a hosted Supabase project: it already has these.
-- Stands in for the parts of the hosted Supabase platform that apps/api's supabase-js client needs, on plain Postgres 16:
--   * `authenticator`: the login role PostgREST connects as and switches from (SET ROLE) to the JWT's role.
--   * hosted default privileges for service_role on objects later created in schema public. Applied BEFORE the
--     migrations, exactly like hosted Supabase, so every explicit REVOKE in a migration still wins.
-- anon/authenticated get no default grants here: apps/api only ever sends the service-role key to PostgREST.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end $$;
grant anon, authenticated, service_role to authenticator;

alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
alter default privileges for role postgres in schema public grant execute on functions to service_role;
