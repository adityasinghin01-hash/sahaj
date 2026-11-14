-- Phase 5 Core 2 Escalation Extension Postgres suite (transactional, rolled back).
-- Run after bootstrap.sql and all active migrations through 20261114231000_core2_escalation.sql.
begin;

insert into auth.users (id) values
  ('a3000000-0000-4000-8000-000000000001'), -- Family A child (Riya)
  ('a3000000-0000-4000-8000-000000000002'), -- Family A parent (Meena / Maa)
  ('a3000000-0000-4000-8000-000000000003'), -- Family A circle contact #1 (Priya)
  ('a3000000-0000-4000-8000-000000000004'); -- Family A circle contact #2 (Neha)

insert into public.families (id, name) values
  ('b3000000-0000-4000-8000-000000000001', 'Synthetic Core2 Escalation Family');

insert into public.people (id, family_id, display_name, role) values
  ('c3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'Riya', 'child'),
  ('c3000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000001', 'Meena', 'parent'),
  ('c3000000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-000000000001', 'Priya', 'circle'),
  ('c3000000-0000-4000-8000-000000000004', 'b3000000-0000-4000-8000-000000000001', 'Neha', 'circle');

insert into public.family_memberships (family_id, user_id, person_id, role) values
  ('b3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'child'),
  ('b3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002', 'parent'),
  ('b3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000003', 'circle'),
  ('b3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000004', 'c3000000-0000-4000-8000-000000000004', 'circle');

insert into public.consents (id, family_id, person_id, purpose, question, answer, version) values
  ('f3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000003', 'trusted_contact', 'Accept emergency contact role?', true, 'v1'),
  ('f3000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000004', 'trusted_contact', 'Accept emergency contact role?', true, 'v1');

insert into public.core2_trusted_contacts (
  id, family_id, subject_person_id, contact_person_id, rank, scopes, state, approved_at, consent_id, consent_at
) values
  (
    'e3000000-0000-4000-8000-000000000011', 'b3000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000003',
    1, array['watch_escalation', 'sos'], 'active', now(), 'f3000000-0000-4000-8000-000000000001', now()
  ),
  (
    'e3000000-0000-4000-8000-000000000012', 'b3000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000004',
    2, array['watch_escalation', 'sos'], 'active', now(), 'f3000000-0000-4000-8000-000000000002', now()
  );

insert into public.raw_events (id, family_id, source, provider_event_id, event_type, metadata, status, payload_hash) values
  ('d3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'core2', 'watch-esc-1', 'core2.watch.started', '{}'::jsonb, 'processed', repeat('a', 64)),
  ('d3000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000001', 'core2', 'accept-ev-1', 'core2.assignment.accepted', '{}'::jsonb, 'processed', repeat('b', 64)),
  ('d3000000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-000000000001', 'core2', 'accept-ev-2', 'core2.assignment.accepted', '{}'::jsonb, 'processed', repeat('c', 64)),
  ('d3000000-0000-4000-8000-000000000004', 'b3000000-0000-4000-8000-000000000001', 'core2', 'watch-esc-2', 'core2.watch.started', '{}'::jsonb, 'processed', repeat('d', 64));

insert into public.requests (id, family_id, person_id, kind) values
  ('e3000000-0000-4000-8000-000000000021', 'b3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'going_home_watch'),
  ('e3000000-0000-4000-8000-000000000022', 'b3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'going_home_watch');

insert into public.core2_watches (
  id, family_id, subject_person_id, request_id, raw_event_id, timezone,
  state, grace_minutes, deadline_at, grace_until, next_tick_at
) values (
  'e3000000-0000-4000-8000-000000000031', 'b3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000021',
  'd3000000-0000-4000-8000-000000000001', 'Asia/Kolkata',
  'active', 10, now() - interval '20 minutes', now() - interval '10 minutes', now() - interval '20 minutes'
);

-- 1. Overdue tick + sequential offer -> idempotent replay -> timeout rotation -> accept idempotency -> single owner.
do $$
declare
  w public.core2_watches;
  off1 record;
  off1_replay record;
  off2 record;
  acc1 record;
  acc1_replay record;
  t0 timestamptz := pg_catalog.clock_timestamp();
begin
  select * into w from public.core2_tick_due_watches(t0, 10);
  if w.state <> 'escalated' or w.incident_id is null then
    raise exception 'FAIL expected escalated watch after overdue grace';
  end if;

  -- First offer goes to rank #1 Priya
  select * into off1 from public.core2_offer_next_trusted_contact(
    'b3000000-0000-4000-8000-000000000001', w.incident_id, 'watch_escalation', t0 + interval '2 minutes', t0
  );
  if not off1.newly_created or off1.contact_person_id <> 'c3000000-0000-4000-8000-000000000003' then
    raise exception 'FAIL expected rank 1 Priya offered first';
  end if;

  -- Re-running cron before expiry is strictly idempotent (no new offer)
  select * into off1_replay from public.core2_offer_next_trusted_contact(
    'b3000000-0000-4000-8000-000000000001', w.incident_id, 'watch_escalation', t0 + interval '3 minutes', t0 + interval '30 seconds'
  );
  if off1_replay.newly_created or off1_replay.assignment_id <> off1.assignment_id then
    raise exception 'FAIL cron replay before expiry created duplicate offer';
  end if;

  -- Advancing past expiry rotates offer cleanly to rank #2 Neha
  select * into off2 from public.core2_offer_next_trusted_contact(
    'b3000000-0000-4000-8000-000000000001', w.incident_id, 'watch_escalation', t0 + interval '5 minutes', t0 + interval '3 minutes'
  );
  if not off2.newly_created or off2.contact_person_id <> 'c3000000-0000-4000-8000-000000000004' then
    raise exception 'FAIL expected rotation to rank 2 Neha after expiry';
  end if;

  -- Neha accepts once
  select * into acc1 from public.core2_accept_incident_assignment(
    'b3000000-0000-4000-8000-000000000001', w.incident_id,
    'c3000000-0000-4000-8000-000000000004', 'd3000000-0000-4000-8000-000000000002', t0 + interval '3 minutes 10 seconds'
  );
  if acc1.already_accepted or acc1.responder_person_id <> 'c3000000-0000-4000-8000-000000000004' then
    raise exception 'FAIL expected Neha first accept';
  end if;

  -- Idempotent replay of accept returns existing accepted_at without touching state
  select * into acc1_replay from public.core2_accept_incident_assignment(
    'b3000000-0000-4000-8000-000000000001', w.incident_id,
    'c3000000-0000-4000-8000-000000000004', 'd3000000-0000-4000-8000-000000000003', t0 + interval '3 minutes 20 seconds'
  );
  if not acc1_replay.already_accepted or acc1_replay.accepted_at <> acc1.accepted_at then
    raise exception 'FAIL accept replay altered accepted_at';
  end if;

  -- Second responder Priya cannot hijack already-owned incident
  begin
    perform * from public.core2_accept_incident_assignment(
      'b3000000-0000-4000-8000-000000000001', w.incident_id,
      'c3000000-0000-4000-8000-000000000003', 'd3000000-0000-4000-8000-000000000003', t0 + interval '3 minutes 30 seconds'
    );
    raise exception 'FAIL second responder hijacked owned incident';
  exception when sqlstate '40903' then null; end;
end $$;

-- 2. Decline immediately rotates to next contact; revoked contact CANNOT accept.
do $$
declare
  inc_id uuid := 'e3000000-0000-4000-8000-000000000099';
  off1 record;
  dec1 record;
  off2 record;
  exh record;
  t0 timestamptz := pg_catalog.clock_timestamp();
begin
  insert into public.incidents (id, family_id, person_id, request_id, severity, state)
  values (inc_id, 'b3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000022', 'urgent', 'open');

  select * into off1 from public.core2_offer_next_trusted_contact(
    'b3000000-0000-4000-8000-000000000001', inc_id, 'watch_escalation', t0 + interval '2 minutes', t0
  );
  select * into dec1 from public.core2_decline_incident_assignment(
    'b3000000-0000-4000-8000-000000000001', inc_id, 'c3000000-0000-4000-8000-000000000003', t0 + interval '10 seconds'
  );
  if dec1.already_declined then raise exception 'FAIL expected fresh decline'; end if;

  select * into off2 from public.core2_offer_next_trusted_contact(
    'b3000000-0000-4000-8000-000000000001', inc_id, 'watch_escalation', t0 + interval '3 minutes', t0 + interval '10 seconds'
  );
  if off2.contact_person_id <> 'c3000000-0000-4000-8000-000000000004' then
    raise exception 'FAIL expected immediate rotation to Neha on Priya decline';
  end if;

  -- Revoke Neha before she accepts -> accept must fail closed with 42501
  perform * from public.core2_revoke_trusted_contact(
    'b3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000012'
  );
  begin
    perform * from public.core2_accept_incident_assignment(
      'b3000000-0000-4000-8000-000000000001', inc_id,
      'c3000000-0000-4000-8000-000000000004', 'd3000000-0000-4000-8000-000000000004', t0 + interval '20 seconds'
    );
    raise exception 'FAIL revoked contact accepted incident';
  exception when sqlstate '42501' then null; end;

  -- No contacts left -> marked exhausted
  select * into exh from public.core2_offer_next_trusted_contact(
    'b3000000-0000-4000-8000-000000000001', inc_id, 'watch_escalation', t0 + interval '5 minutes', t0 + interval '30 seconds'
  );
  if not exh.exhausted then
    raise exception 'FAIL expected escalation exhaustion';
  end if;
end $$;

-- 3. Authenticated cannot mutate core2_incident_escalations or call RPCs.
set local role authenticated;
do $$ begin
  begin
    delete from public.core2_incident_escalations;
    raise exception 'FAIL authenticated mutated core2_incident_escalations';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.core2_offer_next_trusted_contact(
      'b3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000099'
    );
    raise exception 'FAIL authenticated invoked core2_offer_next_trusted_contact';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

rollback;

