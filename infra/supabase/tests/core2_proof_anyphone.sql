-- Phase 5 Core 2 Proof of Life + Any-Phone Line Postgres suite (transactional, rolled back).
-- Run after bootstrap.sql and all active migrations through 20261115002000_core2_proof_anyphone.sql.
begin;

insert into auth.users (id) values
  ('a7000000-0000-4000-8000-000000000001'), -- Family A child (Riya)
  ('a7000000-0000-4000-8000-000000000002'), -- Family A parent (Meena)
  ('a7000000-0000-4000-8000-000000000003'); -- Family B outsider

insert into public.families (id, name) values
  ('b7000000-0000-4000-8000-000000000001', 'Synthetic Proof Family A'),
  ('b7000000-0000-4000-8000-000000000002', 'Synthetic Proof Family B');

insert into public.people (id, family_id, display_name, role) values
  ('c7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000001', 'Riya', 'child'),
  ('c7000000-0000-4000-8000-000000000002', 'b7000000-0000-4000-8000-000000000001', 'Meena', 'parent'),
  ('c7000000-0000-4000-8000-000000000003', 'b7000000-0000-4000-8000-000000000002', 'Other', 'child');

insert into public.family_memberships (family_id, user_id, person_id, role) values
  ('b7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 'child'),
  ('b7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000002', 'parent'),
  ('b7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000003', 'c7000000-0000-4000-8000-000000000003', 'child');

insert into public.shield_family_security (family_id, code_word_hash) values
  ('b7000000-0000-4000-8000-000000000001', repeat('1', 64));

insert into public.requests (id, family_id, person_id, kind) values
  ('e7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 'any_phone_checkin');

insert into public.incidents (id, family_id, person_id, request_id, state, severity) values
  ('e7000000-0000-4000-8000-000000000002', 'b7000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001', 'offered', 'urgent');

insert into public.core2_proof_challenges (
  id, family_id, requester_person_id, subject_person_id, word_token, word_aliases,
  status, ttl_seconds, expires_at
) values (
  'e7000000-0000-4000-8000-000000000011',
  'b7000000-0000-4000-8000-000000000001',
  'c7000000-0000-4000-8000-000000000002',
  'c7000000-0000-4000-8000-000000000001',
  'gulab',
  array['gulab', 'गुलाब'],
  'pending',
  60,
  now() - interval '5 seconds'
);

insert into public.core2_any_phone_sessions (
  id, family_id, subject_person_id, incident_id, request_id,
  call_ref_hash, status_message_hi, status_message_en
) values (
  'e7000000-0000-4000-8000-000000000021',
  'b7000000-0000-4000-8000-000000000001',
  'c7000000-0000-4000-8000-000000000001',
  'e7000000-0000-4000-8000-000000000002',
  'e7000000-0000-4000-8000-000000000001',
  repeat('a', 64),
  'Riya ne kisi aur ke phone se call kiya — madad bheji ja rahi hai',
  'Riya called from another phone — help is being sent'
);

-- 1. Attempt lockout (3 wrong tries = 15 min lock), expiry reset, rotation, and due challenge claim.
do $$
declare
  t0 timestamptz := pg_catalog.clock_timestamp();
  r1 record;
  r2 record;
  r3 record;
  r4 record;
  r5 record;
  claimed public.core2_proof_challenges;
  stored_hash text;
begin
  select * into r1 from public.core2_record_any_phone_attempt('b7000000-0000-4000-8000-000000000001', false, 3, 900, t0);
  if r1.locked or r1.failed_attempts <> 1 or r1.remaining_attempts <> 2 then
    raise exception 'FAIL expected 1st failed attempt (2 remaining)';
  end if;

  select * into r2 from public.core2_record_any_phone_attempt('b7000000-0000-4000-8000-000000000001', false, 3, 900, t0 + interval '5 seconds');
  if r2.locked or r2.failed_attempts <> 2 or r2.remaining_attempts <> 1 then
    raise exception 'FAIL expected 2nd failed attempt (1 remaining)';
  end if;

  select * into r3 from public.core2_record_any_phone_attempt('b7000000-0000-4000-8000-000000000001', false, 3, 900, t0 + interval '10 seconds');
  if not r3.locked or r3.failed_attempts <> 3 or r3.remaining_attempts <> 0 or r3.locked_until is null then
    raise exception 'FAIL expected 3rd failed attempt to lock for 15 min';
  end if;

  -- Even a right attempt during lock stays locked
  select * into r4 from public.core2_record_any_phone_attempt('b7000000-0000-4000-8000-000000000001', true, 3, 900, t0 + interval '2 minutes');
  if not r4.locked or r4.remaining_attempts <> 0 then
    raise exception 'FAIL expected lock to hold at 2 minutes';
  end if;

  -- After 15 minutes, a valid attempt clears lock and resets counter
  select * into r5 from public.core2_record_any_phone_attempt('b7000000-0000-4000-8000-000000000001', true, 3, 900, t0 + interval '16 minutes');
  if r5.locked or r5.failed_attempts <> 0 or r5.remaining_attempts <> 3 then
    raise exception 'FAIL expected lock expiry + reset on success';
  end if;

  -- Code-word rotation updates public.shield_family_security
  perform public.core2_rotate_shield_code_word('b7000000-0000-4000-8000-000000000001', repeat('2', 64));
  select code_word_hash into stored_hash from public.shield_family_security where family_id = 'b7000000-0000-4000-8000-000000000001';
  if stored_hash <> repeat('2', 64) then
    raise exception 'FAIL expected rotated code_word_hash';
  end if;

  -- Claim due expired proof challenge
  select * into claimed from public.core2_claim_due_proof_challenges(t0, 10);
  if claimed.id <> 'e7000000-0000-4000-8000-000000000011' or claimed.status <> 'expired' then
    raise exception 'FAIL expected due proof challenge claim';
  end if;
end $$;

-- 2. RLS family scoping: Family B outsider sees 0 rows in Family A; Family A member sees Family A rows.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a7000000-0000-4000-8000-000000000003","role":"authenticated"}', true);

do $$
declare
  c_count integer;
  s_count integer;
begin
  select count(*) into c_count from public.core2_proof_challenges;
  select count(*) into s_count from public.core2_any_phone_sessions;
  if c_count <> 0 or s_count <> 0 then
    raise exception 'FAIL Family B saw Family A rows (challenges=%, sessions=%)', c_count, s_count;
  end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"a7000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

do $$
declare
  c_count integer;
  s_count integer;
begin
  select count(*) into c_count from public.core2_proof_challenges;
  select count(*) into s_count from public.core2_any_phone_sessions;
  if c_count <> 1 or s_count <> 1 then
    raise exception 'FAIL Family A did not see its own rows (challenges=%, sessions=%)', c_count, s_count;
  end if;
end $$;

rollback;
