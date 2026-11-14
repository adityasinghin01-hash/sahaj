-- RLS proof for the Shield tables. Run by run-shield-test.sh as superuser with
-- ON_ERROR_STOP=1: every check raises an exception on failure, so psql exits non-zero.
\set QUIET on
\set ON_ERROR_STOP on
set client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Seed: two families, one member user each (superuser, bypasses RLS).
-- ---------------------------------------------------------------------------
insert into public.families (id,name) values
  ('a0000000-0000-0000-0000-000000000001','Synthetic family'),
  ('b0000000-0000-0000-0000-000000000001','Synthetic family');

insert into public.people (id, family_id,display_name,role) values
  ('a0000000-0000-0000-0000-0000000000f1', 'a0000000-0000-0000-0000-000000000001','Maa','parent'),  -- parent A
  ('b0000000-0000-0000-0000-0000000000f1', 'b0000000-0000-0000-0000-000000000001','Maa','parent');  -- parent B

insert into auth.users(id) values ('a0000000-0000-0000-0000-0000000000c1');
insert into public.people(id,family_id,display_name,role) values ('a0000000-0000-0000-0000-0000000000e1','a0000000-0000-0000-0000-000000000001','Riya','child');
insert into public.family_memberships(family_id,user_id,person_id,role) values ('a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-0000000000c1','a0000000-0000-0000-0000-0000000000e1','child');
insert into auth.users(id) values ('b0000000-0000-0000-0000-0000000000c1');
insert into public.people(id,family_id,display_name,role) values ('b0000000-0000-0000-0000-0000000000e1','b0000000-0000-0000-0000-000000000001','Riya','child');
insert into public.family_memberships(family_id,user_id,person_id,role) values ('b0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-0000000000c1','b0000000-0000-0000-0000-0000000000e1','child');


insert into public.shield_verdicts (id, family_id, parent_id, level, scam_type, confidence, actions) values
  ('a0000000-0000-0000-0000-0000000000d1', 'a0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-0000000000f1', 'red', 'digital_arrest', 0.92, '{alert_child}'),
  ('a0000000-0000-0000-0000-0000000000d2', 'a0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-0000000000f1', 'yellow', 'kyc_block', 0.60, '{}'),
  ('b0000000-0000-0000-0000-0000000000d1', 'b0000000-0000-0000-0000-000000000001',
   'b0000000-0000-0000-0000-0000000000f1', 'red', 'otp_theft', 0.88, '{alert_child}');

-- ---------------------------------------------------------------------------
-- 1. Family A member sees family A verdicts and 0 of family B's.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000c1', true) \g /dev/null
do $$
declare own int; other int;
begin
  select count(*) into own   from public.shield_verdicts where family_id = 'a0000000-0000-0000-0000-000000000001';
  select count(*) into other from public.shield_verdicts where family_id = 'b0000000-0000-0000-0000-000000000001';
  if own <> 2 then raise exception 'FAIL 1a: family A member saw % family A verdicts, expected 2', own; end if;
  if other <> 0 then raise exception 'FAIL 1b: family A member saw % family B verdicts, expected 0', other; end if;
  raise notice 'PASS 1: family A member sees 2 own verdicts, 0 of family B';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- 2. authenticated cannot insert into shield_events.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000c1', true) \g /dev/null
do $$
begin
  begin
    insert into public.shield_events (family_id, parent_id, channel, kind, occurred_at, idempotency_key)
    values ('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000f1',
            'device', 'sms', now(), 'auth-insert-0001');
    raise exception 'FAIL 2: authenticated inserted into shield_events';
  exception when insufficient_privilege then
    raise notice 'PASS 2: authenticated insert into shield_events rejected (%)', sqlerrm;
  end;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- 3. authenticated can update child_feedback on own family's verdict, cannot update level,
--    and cannot touch another family's verdict.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000c1', true) \g /dev/null
do $$
declare n int;
begin
  update public.shield_verdicts set child_feedback = 'fraud', feedback_at = now()
   where id = 'a0000000-0000-0000-0000-0000000000d1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 3a: own-family feedback update touched % rows, expected 1', n; end if;
  raise notice 'PASS 3a: family A member set child_feedback on own verdict';

  begin
    update public.shield_verdicts set level = 'green' where id = 'a0000000-0000-0000-0000-0000000000d1';
    raise exception 'FAIL 3b: authenticated updated level';
  exception when insufficient_privilege then
    raise notice 'PASS 3b: authenticated update of level rejected (%)', sqlerrm;
  end;

  update public.shield_verdicts set child_feedback = 'safe', feedback_at = now()
   where id = 'b0000000-0000-0000-0000-0000000000d1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 3c: family A member updated % family B verdicts', n; end if;
  raise notice 'PASS 3c: family A member cannot update family B verdict feedback (0 rows)';

  begin
    update public.shield_verdicts set child_feedback = 'maybe' where id = 'a0000000-0000-0000-0000-0000000000d1';
    raise exception 'FAIL 3d: child_feedback accepted an invalid value';
  exception when check_violation then
    raise notice 'PASS 3d: child_feedback rejects values other than safe/fraud';
  end;
end $$;
rollback;

-- Confirm the 3a update really wrote the row (re-read as superuser after reset role).
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000c1', true) \g /dev/null
update public.shield_verdicts set child_feedback = 'fraud', feedback_at = now()
 where id = 'a0000000-0000-0000-0000-0000000000d1';
reset role;
do $$
begin
  if not exists (select 1 from public.shield_verdicts
                  where id = 'a0000000-0000-0000-0000-0000000000d1'
                    and child_feedback = 'fraud' and feedback_at is not null and level = 'red') then
    raise exception 'FAIL 3e: feedback not stored or level changed';
  end if;
  raise notice 'PASS 3e: stored child_feedback=fraud, level unchanged';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- 4. Duplicate idempotency_key insert fails (as service_role, the only writer).
-- ---------------------------------------------------------------------------
begin;
set local role service_role;
do $$
begin
  insert into public.shield_events (family_id, parent_id, channel, kind, occurred_at, idempotency_key)
  values ('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000f1',
          'device', 'sms', now(), 'dup-key-00000001');
  raise notice 'PASS 4a: service_role can insert into shield_events';
  begin
    insert into public.shield_events (family_id, parent_id, channel, kind, occurred_at, idempotency_key)
    values ('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000f1',
            'device', 'call_in', now(), 'dup-key-00000001');
    raise exception 'FAIL 4b: duplicate idempotency_key accepted';
  exception when unique_violation then
    raise notice 'PASS 4b: duplicate idempotency_key rejected (%)', sqlerrm;
  end;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- 5. Extra lockdown checks.
-- ---------------------------------------------------------------------------
begin;
set local role anon;
do $$
begin
  begin
    perform 1 from public.shield_verdicts;
    raise exception 'FAIL 5a: anon can read shield_verdicts';
  exception when insufficient_privilege then
    raise notice 'PASS 5a: anon cannot read shield_verdicts';
  end;
end $$;
rollback;

do $$
declare t text; missing text := '';
begin
  foreach t in array array['shield_devices', 'shield_events', 'shield_verdicts', 'family_checks'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      missing := missing || ' ' || t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE')
       or has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception 'FAIL 5b: unexpected anon/authenticated privilege on %', t;
    end if;
  end loop;
  if missing <> '' then raise exception 'FAIL 5c: RLS not enabled on%', missing; end if;
  raise notice 'PASS 5b/5c: RLS enabled and no insert/delete for authenticated, no anon access, on all 4 tables';
end $$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = 'shield_verdicts') then
      raise exception 'FAIL 6: shield_verdicts not in supabase_realtime publication';
    end if;
    raise notice 'PASS 6: shield_verdicts is in supabase_realtime publication';
  else
    raise notice 'SKIP 6: no supabase_realtime publication in this DB';
  end if;
end $$;

\echo 'ALL SHIELD RLS CHECKS PASSED'
