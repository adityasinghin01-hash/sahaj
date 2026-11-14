-- RLS / privilege proof for the K-B5 tables (busy_streaks, scam_indicators, scam_indicator_sightings,
-- shield_record_scam_indicator). Run by run-shield-db-test.sh as superuser with ON_ERROR_STOP=1, before
-- the vitest suites. Everything happens inside one transaction that is rolled back.
\set QUIET on
\set ON_ERROR_STOP on
set client_min_messages = notice;

begin;

insert into public.families (id,name) values
  ('a0000000-0000-0000-0000-00000000b501','Synthetic family'),
  ('b0000000-0000-0000-0000-00000000b501','Synthetic family');
insert into public.people (id, family_id, display_name,role) values
  ('a0000000-0000-0000-0000-00000000b5f1', 'a0000000-0000-0000-0000-00000000b501', 'Maa','parent'),
  ('b0000000-0000-0000-0000-00000000b5f1', 'b0000000-0000-0000-0000-00000000b501', 'Maa','parent');
insert into auth.users(id) values ('a0000000-0000-0000-0000-00000000b5c1');
insert into public.people(id,family_id,display_name,role) values ('a0000000-0000-0000-0000-00000000b5e1','a0000000-0000-0000-0000-00000000b501','Riya','child');
insert into public.family_memberships(family_id,user_id,person_id,role) values ('a0000000-0000-0000-0000-00000000b501','a0000000-0000-0000-0000-00000000b5c1','a0000000-0000-0000-0000-00000000b5e1','child');
insert into auth.users(id) values ('b0000000-0000-0000-0000-00000000b5c1');
insert into public.people(id,family_id,display_name,role) values ('b0000000-0000-0000-0000-00000000b5e1','b0000000-0000-0000-0000-00000000b501','Riya','child');
insert into public.family_memberships(family_id,user_id,person_id,role) values ('b0000000-0000-0000-0000-00000000b501','b0000000-0000-0000-0000-00000000b5c1','b0000000-0000-0000-0000-00000000b5e1','child');

insert into public.busy_streaks (family_id, parent_id, started_at, last_busy_at) values
  ('a0000000-0000-0000-0000-00000000b501', 'a0000000-0000-0000-0000-00000000b5f1', now(), now()),
  ('b0000000-0000-0000-0000-00000000b501', 'b0000000-0000-0000-0000-00000000b5f1', now(), now());
insert into public.scam_indicators (kind, fingerprint, scam_type, summary_hi, summary_en, first_seen_at, last_seen_at)
values ('domain', repeat('c', 64), 'unknown', 'hi', 'en', now(), now());

-- 1. A family member sees their own busy streak and not the other family's; cannot write.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000b5c1', true) \g /dev/null
do $$
declare own int; other int;
begin
  select count(*) into own   from public.busy_streaks where family_id = 'a0000000-0000-0000-0000-00000000b501';
  select count(*) into other from public.busy_streaks where family_id = 'b0000000-0000-0000-0000-00000000b501';
  if own <> 1 or other <> 0 then
    raise exception 'FAIL B1: family A member saw % own / % other busy streaks, expected 1 / 0', own, other;
  end if;
  begin
    update public.busy_streaks set alerted_at = now() where family_id = 'a0000000-0000-0000-0000-00000000b501';
    raise exception 'FAIL B1b: authenticated updated busy_streaks';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS B1: busy_streaks readable by own family only, not writable by authenticated';
end $$;

-- 2. Shared indicators and sightings are service-role only, and so is the record function.
do $$
begin
  begin
    perform 1 from public.scam_indicators;
    raise exception 'FAIL B2a: authenticated can read scam_indicators';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.scam_indicator_sightings;
    raise exception 'FAIL B2b: authenticated can read scam_indicator_sightings';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.shield_record_scam_indicator('domain', repeat('d', 64), 'unknown', 'hi', 'en',
      'a0000000-0000-0000-0000-00000000b501', gen_random_uuid(), now(), 2);
    raise exception 'FAIL B2c: authenticated can execute shield_record_scam_indicator';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS B2: scam_indicators / sightings / record function closed to authenticated';
end $$;
reset role;

-- 3. anon gets nothing; RLS is on for all three tables; service_role can execute the function.
do $$
declare t text;
begin
  foreach t in array array['busy_streaks', 'scam_indicators', 'scam_indicator_sightings'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'FAIL B3a: RLS not enabled on %', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE') then
      raise exception 'FAIL B3b: unexpected anon/authenticated privilege on %', t;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.shield_record_scam_indicator(text, text, text, text, text, uuid, uuid, timestamptz, integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.shield_record_scam_indicator(text, text, text, text, text, uuid, uuid, timestamptz, integer)', 'EXECUTE') then
    raise exception 'FAIL B3c: wrong EXECUTE grants on shield_record_scam_indicator';
  end if;
  raise notice 'PASS B3: RLS on, no anon access, function execute for service_role only';
end $$;

rollback;
\echo 'ALL BUSY/WARNINGS RLS CHECKS PASSED'
