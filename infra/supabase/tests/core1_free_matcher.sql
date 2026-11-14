-- Core 1 C3: Rollback SQL Acceptance Test Suite for Both-Free Matcher
-- Verifies composite tenant FKs, one-per-day nudge uniqueness, and family-scoped RLS.

begin;

insert into auth.users (id) values
  ('a3000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000002'),
  ('a3000000-0000-4000-8000-000000000003');

insert into public.families (id, name) values
  ('b3000000-0000-4000-8000-000000000001', 'Matcher Synthetic Family A'),
  ('b3000000-0000-4000-8000-000000000002', 'Matcher Synthetic Family B');

insert into public.people (id, family_id, display_name, role, timezone) values
  ('c3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'Maa Meena', 'parent', 'Asia/Kolkata'),
  ('c3000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000001', 'Riya Child', 'child', 'Asia/Kolkata'),
  ('c3000000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-000000000002', 'Other Child B', 'child', 'Asia/Kolkata');

insert into public.family_memberships (family_id, user_id, person_id, role) values
  ('b3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'parent'),
  ('b3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002', 'child'),
  ('b3000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000003', 'child');

-- 1. Valid windows with timezone
insert into public.core1_free_windows (
  id, family_id, person_id, timezone, start_minute, end_minute, kind, source, label
) values (
  'd3000000-0000-4000-8000-000000000001',
  'b3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000001',
  'Asia/Kolkata',
  1080,
  1200,
  'recurring',
  'sarvam_checkin',
  'Shaam 6 se 8 baje tak'
), (
  'd3000000-0000-4000-8000-000000000002',
  'b3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000002',
  'America/New_York',
  450,
  570,
  'recurring',
  'app',
  'Morning window'
);

-- 2. Cross-family person reference must fail FK check
do $$
begin
  insert into public.core1_free_windows (
    family_id, person_id, timezone, start_minute, end_minute, kind, source
  ) values (
    'b3000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000003',
    'Asia/Kolkata',
    600,
    720,
    'recurring',
    'app'
  );
  raise exception 'FAIL: cross-family person_id allowed';
exception when foreign_key_violation then
  null;
end $$;

-- 3. One-per-day nudge log constraint
insert into public.core1_matcher_nudge_log (
  family_id, parent_person_id, child_person_id, local_date, status
) values (
  'b3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000002',
  date '2026-11-15',
  'sent'
);

do $$
begin
  insert into public.core1_matcher_nudge_log (
    family_id, parent_person_id, child_person_id, local_date, status
  ) values (
    'b3000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000002',
    date '2026-11-15',
    'sent'
  );
  raise exception 'FAIL: duplicate same-day nudge log allowed';
exception when unique_violation then
  null;
end $$;

-- Next day succeeds
insert into public.core1_matcher_nudge_log (
  family_id, parent_person_id, child_person_id, local_date, status
) values (
  'b3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000002',
  date '2026-11-16',
  'sent'
);

-- 4. RLS checks as authenticated users (Family A child vs Family A parent vs Family B child)
set local role authenticated;

-- Family A child (Riya) sees Family A windows + nudge log, zero writes
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
do $$
declare
  v_win_count integer;
  v_log_count integer;
begin
  select count(*) into v_win_count from public.core1_free_windows;
  select count(*) into v_log_count from public.core1_matcher_nudge_log;
  if v_win_count <> 2 then
    raise exception 'FAIL: expected 2 family A windows visible to Riya, got %', v_win_count;
  end if;
  if v_log_count <> 2 then
    raise exception 'FAIL: expected 2 family A nudge logs visible to Riya, got %', v_log_count;
  end if;
end $$;

-- Family A parent (Maa) sees only her own window, not Riya's, and 0 nudge logs
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$
declare
  v_win_count integer;
  v_log_count integer;
begin
  select count(*) into v_win_count from public.core1_free_windows;
  select count(*) into v_log_count from public.core1_matcher_nudge_log;
  if v_win_count <> 1 then
    raise exception 'FAIL: expected 1 own window visible to Maa, got %', v_win_count;
  end if;
  if v_log_count <> 0 then
    raise exception 'FAIL: expected 0 nudge logs visible to Maa, got %', v_log_count;
  end if;
end $$;

-- Family B child sees 0 rows from Family A
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
do $$
declare
  v_win_count integer;
  v_log_count integer;
begin
  select count(*) into v_win_count from public.core1_free_windows;
  select count(*) into v_log_count from public.core1_matcher_nudge_log;
  if v_win_count <> 0 or v_log_count <> 0 then
    raise exception 'FAIL: cross-tenant RLS leak detected (win=%, log=%)', v_win_count, v_log_count;
  end if;
end $$;

-- Direct client insert must fail with insufficient_privilege
do $$
begin
  insert into public.core1_free_windows (
    family_id, person_id, timezone, start_minute, end_minute
  ) values (
    'b3000000-0000-4000-8000-000000000002',
    'c3000000-0000-4000-8000-000000000003',
    'Asia/Kolkata',
    600,
    720
  );
  raise exception 'FAIL: direct authenticated insert should be rejected';
exception when insufficient_privilege then
  null;
end $$;

rollback;
