-- AGY-W3: Core 1 Urgent Help & Daily Check-In PG Integration Tests
-- Verifies create_urgent_incident_offer (no invalid c.active ref),
-- create_urgent_incident_offer_scaled, advance_urgent_incident_offer (decline/timeout/escalate),
-- prepare_urgent_responder_dispatch -> Phase 2 claim_dispatch_contact -> complete_dispatch ->
-- record_responder_acceptance -> accept_assignment_verified -> trg_assignments_sync_incident,
-- prepare_checkin_dispatch -> Sarvam dispatch, and check_in_summaries PII digit constraint + RLS.
-- Synthetic data only; rolls back cleanly.

begin;

insert into auth.users(id) values
  ('a9100000-0000-4000-8000-000000000001'),
  ('a9100000-0000-4000-8000-000000000002');

insert into public.families(id, name) values
  ('b9100000-0000-4000-8000-000000000001', 'Sharma Synthetic Family'),
  ('b9100000-0000-4000-8000-000000000002', 'Other Synthetic Family');

insert into public.people(id, family_id, display_name, role) values
  ('c9100000-0000-4000-8000-000000000001', 'b9100000-0000-4000-8000-000000000001', 'Meena Maa', 'parent'),
  ('c9100000-0000-4000-8000-000000000002', 'b9100000-0000-4000-8000-000000000001', 'Riya', 'child'),
  ('c9100000-0000-4000-8000-000000000003', 'b9100000-0000-4000-8000-000000000001', 'Unconsented Circle', 'circle'),
  ('c9100000-0000-4000-8000-000000000004', 'b9100000-0000-4000-8000-000000000001', 'Revoked Circle', 'circle'),
  ('c9100000-0000-4000-8000-000000000005', 'b9100000-0000-4000-8000-000000000001', 'Sharma uncle', 'circle'),
  ('c9100000-0000-4000-8000-000000000006', 'b9100000-0000-4000-8000-000000000001', 'Verma aunty', 'circle'),
  ('c9100000-0000-4000-8000-000000000099', 'b9100000-0000-4000-8000-000000000002', 'Other Parent', 'parent');

insert into public.family_memberships(family_id, user_id, person_id, role) values
  ('b9100000-0000-4000-8000-000000000001', 'a9100000-0000-4000-8000-000000000002', 'c9100000-0000-4000-8000-000000000002', 'child');

-- Rank 1 is the subject herself (must NEVER be offered); Rank 2 is unconsented; Rank 3 is revoked;
-- Rank 4 is Sharma uncle (eligible #1); Rank 5 is Verma aunty (eligible #2).
-- All rows are family-approved (approved_at), so only consent/revocation/subject decide eligibility here.
insert into public.circle(family_id, person_id, rank, approved_at, consent_at, revoked_at) values
  ('b9100000-0000-4000-8000-000000000001', 'c9100000-0000-4000-8000-000000000001', 1, now() - interval '3 days', now(), null),
  ('b9100000-0000-4000-8000-000000000001', 'c9100000-0000-4000-8000-000000000003', 2, now() - interval '3 days', null, null),
  ('b9100000-0000-4000-8000-000000000001', 'c9100000-0000-4000-8000-000000000004', 3, now() - interval '3 days', now() - interval '2 days', now() - interval '1 hour'),
  ('b9100000-0000-4000-8000-000000000001', 'c9100000-0000-4000-8000-000000000005', 4, now() - interval '3 days', now() - interval '1 day', null),
  ('b9100000-0000-4000-8000-000000000001', 'c9100000-0000-4000-8000-000000000006', 5, now() - interval '3 days', now() - interval '1 day', null);

insert into public.atlas_principals(id, family_id, label) values
  ('d9100000-0000-4000-8000-000000000001', 'b9100000-0000-4000-8000-000000000001', 'atlas-core1');

insert into public.consents(id, family_id, person_id, purpose, question, answer, version) values
  ('e9100000-0000-4000-8000-000000000001', 'b9100000-0000-4000-8000-000000000001', 'c9100000-0000-4000-8000-000000000001', 'permission_setup', 'Allow?', true, 'v1');

insert into public.permissions(
  id, family_id, person_id, principal_id, action, decision, expires_at, consent_id,
  two_person_required, valid_from, period_start, period_end, max_uses, target_ids
) values
  (
    'f9100000-0000-4000-8000-000000000001',
    'b9100000-0000-4000-8000-000000000001',
    'c9100000-0000-4000-8000-000000000001',
    'd9100000-0000-4000-8000-000000000001',
    'urgent_responder',
    'allow',
    now() + interval '1 day',
    'e9100000-0000-4000-8000-000000000001',
    false,
    now() - interval '1 hour',
    now() - interval '1 hour',
    now() + interval '1 day',
    10,
    array['c9100000-0000-4000-8000-000000000001']
  ),
  (
    'f9100000-0000-4000-8000-000000000002',
    'b9100000-0000-4000-8000-000000000001',
    'c9100000-0000-4000-8000-000000000001',
    'd9100000-0000-4000-8000-000000000001',
    'check_in',
    'allow',
    now() + interval '1 day',
    'e9100000-0000-4000-8000-000000000001',
    false,
    now() - interval '1 hour',
    now() - interval '1 hour',
    now() + interval '1 day',
    10,
    array['c9100000-0000-4000-8000-000000000001']
  );

insert into public.provider_identities(
  id, family_id, person_id, source, account_id, external_id_hash, binding_kind, contact_ciphertext
) values
  (
    'a9200000-0000-4000-8000-000000000001',
    'b9100000-0000-4000-8000-000000000001',
    'c9100000-0000-4000-8000-000000000005',
    'twilio',
    'AC-synth',
    repeat('1', 64),
    'contact',
    'enc-contact-sharma'
  ),
  (
    'a9200000-0000-4000-8000-000000000002',
    'b9100000-0000-4000-8000-000000000001',
    'c9100000-0000-4000-8000-000000000001',
    'sarvam',
    'app-synth',
    repeat('2', 64),
    'contact',
    'enc-contact-maa'
  );

insert into public.schedules(id, family_id, person_id, kind, next_at, timezone, enabled) values
  (
    'b9200000-0000-4000-8000-000000000001',
    'b9100000-0000-4000-8000-000000000001',
    'c9100000-0000-4000-8000-000000000001',
    'check_in',
    now() - interval '5 minutes',
    'Asia/Kolkata',
    true
  );

set local role service_role;

-- 1. create_urgent_incident_offer skips subject/unconsented/revoked, offers Sharma uncle -> decline -> Verma aunty -> timeout -> escalated
do $$
declare
  fam uuid := 'b9100000-0000-4000-8000-000000000001';
  maa uuid := 'c9100000-0000-4000-8000-000000000001';
  sharma uuid := 'c9100000-0000-4000-8000-000000000005';
  verma uuid := 'c9100000-0000-4000-8000-000000000006';
  res jsonb;
  adv1 jsonb;
  adv2 jsonb;
  inc_id uuid;
  asg1 uuid;
  asg2 uuid;
  inc_state text;
begin
  res := public.create_urgent_incident_offer(fam, maa, 'urgent', 3);
  if res->>'state' <> 'offered' or (res->>'responder_person_id')::uuid <> sharma then
    raise exception 'FAIL create_urgent_incident_offer picked wrong responder: %', res;
  end if;

  inc_id := (res->>'incident_id')::uuid;
  asg1 := (res->>'assignment_id')::uuid;

  adv1 := public.advance_urgent_incident_offer(fam, inc_id, asg1, 'declined', 120);
  if adv1->>'status' <> 'offered' or (adv1->>'responder_person_id')::uuid <> verma then
    raise exception 'FAIL decline did not advance to Verma aunty: %', adv1;
  end if;

  asg2 := (adv1->>'assignment_id')::uuid;

  -- Not yet expired must refuse expiry advance
  if (public.advance_urgent_incident_offer(fam, inc_id, asg2, 'expired', 120))->>'status' <> 'not_yet_expired' then
    raise exception 'FAIL premature expiry advanced';
  end if;

  -- Expire assignment and advance -> should escalate when circle exhausted
  update public.assignments set expires_at = clock_timestamp() - interval '1 second' where id = asg2;
  adv2 := public.advance_urgent_incident_offer(fam, inc_id, asg2, 'expired', 120);
  if adv2->>'status' <> 'escalated' then
    raise exception 'FAIL exhausted circle did not escalate: %', adv2;
  end if;

  select state into inc_state from public.incidents where id = inc_id;
  if inc_state <> 'escalated' then
    raise exception 'FAIL incident state expected escalated, got %', inc_state;
  end if;
end $$;

-- 2. Full urgent dispatch + Gather digit '1' -> record_responder_acceptance -> accept_assignment_verified -> trg_assignments_sync_incident
do $$
declare
  fam uuid := 'b9100000-0000-4000-8000-000000000001';
  maa uuid := 'c9100000-0000-4000-8000-000000000001';
  sharma uuid := 'c9100000-0000-4000-8000-000000000005';
  offered jsonb;
  prep jsonb;
  recheck jsonb;
  inc_id uuid;
  asg_id uuid;
  ob_id uuid;
  cl_id uuid;
  lease uuid := gen_random_uuid();
  dk text;
  raw_ev public.raw_events;
  acc jsonb;
  inc_row public.incidents%rowtype;
begin
  offered := public.create_urgent_incident_offer_scaled(fam, maa, 'critical', 90);
  inc_id := (offered->>'incident_id')::uuid;
  asg_id := (offered->>'assignment_id')::uuid;

  prep := public.prepare_urgent_responder_dispatch(
    fam, inc_id, asg_id, maa, sharma, 'urg:sql-test:1', 'ct-urg', repeat('a', 64)
  );
  if prep->>'status' <> 'ready' then
    raise exception 'FAIL prepare_urgent_responder_dispatch: %', prep;
  end if;

  ob_id := (prep->>'outbox_id')::uuid;
  cl_id := (prep->>'call_id')::uuid;

  update public.outbox
  set status = 'processing', lease_token = lease, lease_until = now() + interval '2 minutes',
      worker_id = 'sql-test', attempt_count = 1
  where id = ob_id;

  recheck := public.recheck_dispatch_authorization(ob_id, lease);
  if coalesce((recheck->>'ok')::boolean, false) is not true then
    raise exception 'FAIL recheck_dispatch_authorization failed: %', recheck;
  end if;

  dk := 'dispatch:' || ob_id || ':a1';
  if public.claim_dispatch_contact(
    fam, sharma, dk, 'twilio', 'twilio.create_call', ob_id, lease, cl_id,
    'a9200000-0000-4000-8000-000000000001', 'AC-synth', repeat('1', 64)
  ) <> 'claimed' then
    raise exception 'FAIL urgent claim_dispatch_contact';
  end if;

  if public.complete_dispatch(fam, dk, 'CA' || repeat('c', 32), 'AC-synth', repeat('d', 64), true) <> 'dispatched' then
    raise exception 'FAIL urgent complete_dispatch';
  end if;
  perform public.finish_outbox(ob_id, lease, true, null);

  raw_ev := public.ingest_raw_event(
    'twilio',
    'AC-synth:gather:CA' || repeat('c', 32),
    'twilio.gather.response',
    fam,
    jsonb_build_object('digit', '1', 'call_id', cl_id, 'person_id', sharma),
    repeat('e', 64),
    null
  );

  acc := public.record_responder_acceptance(fam, raw_ev.provider_event_id);
  if not public.accept_assignment_verified(fam, asg_id, (acc->>'proof_event_id')::uuid) then
    raise exception 'FAIL accept_assignment_verified returned false';
  end if;

  select * into inc_row from public.incidents where id = inc_id;
  if inc_row.state <> 'accepted' or inc_row.owner_person_id <> sharma or inc_row.promised_at is null then
    raise exception 'FAIL trg_assignments_sync_incident did not update incident: state=%, owner=%, promised=%',
      inc_row.state, inc_row.owner_person_id, inc_row.promised_at;
  end if;
end $$;

-- 3. Daily check-in prepare_checkin_dispatch -> Sarvam dispatch -> check_in_summaries + PII digit constraint
do $$
declare
  fam uuid := 'b9100000-0000-4000-8000-000000000001';
  maa uuid := 'c9100000-0000-4000-8000-000000000001';
  sched uuid := 'b9200000-0000-4000-8000-000000000001';
  prep jsonb;
  ob_id uuid;
  cl_id uuid;
  lease uuid := gen_random_uuid();
  dk text;
  digit_rejected boolean := false;
begin
  prep := public.prepare_checkin_dispatch(fam, maa, 'chk:sql-test:1', 'ct-chk', repeat('b', 64));
  if prep->>'status' <> 'ready' then
    raise exception 'FAIL prepare_checkin_dispatch: %', prep;
  end if;
  ob_id := (prep->>'outbox_id')::uuid;
  cl_id := (prep->>'call_id')::uuid;

  update public.outbox
  set status = 'processing', lease_token = lease, lease_until = now() + interval '2 minutes',
      worker_id = 'sql-test', attempt_count = 1
  where id = ob_id;

  dk := 'dispatch:' || ob_id || ':a1';
  if public.claim_dispatch_contact(
    fam, maa, dk, 'sarvam', 'sarvam.outbound_call', ob_id, lease, cl_id,
    'a9200000-0000-4000-8000-000000000002', 'app-synth', repeat('2', 64)
  ) <> 'claimed' then
    raise exception 'FAIL checkin claim_dispatch_contact';
  end if;

  if public.complete_dispatch(fam, dk, 'att-sql-chk-1', 'app-synth', repeat('f', 64), true) <> 'dispatched' then
    raise exception 'FAIL checkin complete_dispatch';
  end if;
  perform public.finish_outbox(ob_id, lease, true, null);

  insert into public.check_in_summaries(
    family_id, person_id, call_id, schedule_id, local_date, attempt_number, outcome, short_summary, dedupe_key
  ) values (
    fam, maa, cl_id, sched, current_date, 1, 'answered',
    'Morning check-in call completed; Meena ji said she feels well.', 'sum:sql:1'
  );

  begin
    insert into public.check_in_summaries(
      family_id, person_id, local_date, attempt_number, outcome, short_summary, dedupe_key
    ) values (
      fam, maa, current_date, 1, 'answered', 'Call me on 9876543210', 'sum:sql:pii'
    );
  exception when check_violation then
    digit_rejected := true;
  end;

  if not digit_rejected then
    raise exception 'FAIL check_in_summaries allowed 4+ digit run';
  end if;
end $$;

-- 4. Verify RLS blocks cross-family read on check_in_summaries for Riya (family b910...001 vs b910...002)
do $$
declare
  cnt integer;
begin
  perform set_config('request.jwt.claim.sub', 'a9100000-0000-4000-8000-000000000002', true);
  set local role authenticated;
  select count(*) into cnt from public.check_in_summaries where family_id = 'b9100000-0000-4000-8000-000000000002';
  if cnt <> 0 then
    raise exception 'FAIL RLS leaked other family summary';
  end if;
  select count(*) into cnt from public.check_in_summaries where family_id = 'b9100000-0000-4000-8000-000000000001';
  if cnt <> 1 then
    raise exception 'FAIL RLS blocked Riya from reading her family summary (cnt=%)', cnt;
  end if;
end $$;

rollback;
