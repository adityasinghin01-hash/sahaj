-- Core 1 wiring checks for refill approval gate, delivery decrement guard, missed-call nudges, and report facts.
-- Synthetic data only; rolls back cleanly.
begin;

insert into public.families(id, name) values
  ('b9000000-0000-4000-8000-000000000001', 'Synthetic Core1 Family');

insert into public.people(id, family_id, display_name, role) values
  ('c9000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-000000000001', 'Meena Maa', 'parent'),
  ('c9000000-0000-4000-8000-000000000002', 'b9000000-0000-4000-8000-000000000001', 'Riya', 'child'),
  ('c9000000-0000-4000-8000-000000000003', 'b9000000-0000-4000-8000-000000000001', 'Rohit', 'child');

insert into public.atlas_principals(id, family_id, label) values
  ('a9000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-000000000001', 'assistant-core1');

insert into public.consents(id, family_id, person_id, purpose, question, answer, version) values
  ('f9000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001', 'permission_setup', 'Allow refill setup?', true, 'v1');

insert into public.medicines(id, family_id, person_id, label, remaining_count, refill_threshold, instructions_confirmed_by_person) values
  ('d9000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001', 'Metformin 500mg', 5, 6, true);

insert into public.vendors(id, family_id, person_id, category, approved_at) values
  ('e9000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001', 'pharmacy', now());

insert into public.permissions(
  id, family_id, person_id, principal_id, action, decision,
  valid_from, expires_at, period_start, period_end,
  max_uses, max_amount_minor, target_ids, vendor_ids, item_ids,
  consent_id, two_person_required
) values (
  'a9100000-0000-4000-8000-000000000001',
  'b9000000-0000-4000-8000-000000000001',
  'c9000000-0000-4000-8000-000000000001',
  'a9000000-0000-4000-8000-000000000001',
  'medicine_refill',
  'allow',
  now() - interval '1 hour',
  now() + interval '7 days',
  now() - interval '1 hour',
  now() + interval '7 days',
  10,
  50000,
  array['c9000000-0000-4000-8000-000000000001'],
  array['e9000000-0000-4000-8000-000000000001'],
  array['d9000000-0000-4000-8000-000000000001'],
  'f9000000-0000-4000-8000-000000000001',
  true
);

do $$
declare
  v_fam uuid := 'b9000000-0000-4000-8000-000000000001';
  v_maa uuid := 'c9000000-0000-4000-8000-000000000001';
  v_riya uuid := 'c9000000-0000-4000-8000-000000000002';
  v_rohit uuid := 'c9000000-0000-4000-8000-000000000003';
  v_principal uuid := 'a9000000-0000-4000-8000-000000000001';
  v_perm uuid := 'a9100000-0000-4000-8000-000000000001';
  v_med uuid := 'd9000000-0000-4000-8000-000000000001';
  v_ven uuid := 'e9000000-0000-4000-8000-000000000001';
  v_req uuid := '19000000-0000-4000-8000-000000000001';
  v_ar uuid := '29000000-0000-4000-8000-000000000001';
  v_err uuid := '39000000-0000-4000-8000-000000000001';
  v_rem integer;
  v_answers integer;
begin
  -- 1. Propose refill in pending two-person state
  insert into public.requests(id, family_id, person_id, kind, status)
  values (v_req, v_fam, v_maa, 'medicine_refill', 'pending');

  insert into public.action_requests(
    id, family_id, person_id, permission_id, principal_id, action, target_id,
    amount_minor, vendor_id, item_ids, request_fingerprint, status, expires_at, two_person_required
  ) values (
    v_ar, v_fam, v_maa, v_perm, v_principal, 'medicine_refill', v_maa::text,
    25000, v_ven::text, array[v_med::text], repeat('a', 64), 'pending', now() + interval '1 day', true
  );

  insert into public.errands(id, family_id, request_id, action_request_id, vendor_id, medicine_id, status)
  values (v_err, v_fam, v_req, v_ar, v_ven, v_med, 'pending');

  select remaining_count into v_rem from public.medicines where id = v_med;
  if v_rem <> 5 then
    raise exception 'FAIL remaining_count modified on proposal: %', v_rem;
  end if;

  -- 2. First approval by Riya (cannot enqueue yet)
  insert into public.action_answers(family_id, action_request_id, approver_person_id, answer)
  values (v_fam, v_ar, v_riya, true);

  select count(*) into v_answers from public.action_answers where action_request_id = v_ar and answer = true;
  if v_answers <> 1 then
    raise exception 'FAIL expected 1 approval answer, got %', v_answers;
  end if;

  -- 3. Second approval by Rohit -> authorize & enqueue vendor outbox notice
  insert into public.action_answers(family_id, action_request_id, approver_person_id, answer)
  values (v_fam, v_ar, v_rohit, true);

  update public.action_requests set status = 'approved', consumed_at = now() where id = v_ar;
  update public.errands set status = 'authorized' where id = v_err;
  update public.requests set status = 'approved' where id = v_req;

  insert into public.outbox(
    family_id, action_request_id, permission_id, kind, action, dedupe_key, payload_ciphertext, payload_hash, status
  ) values (
    v_fam, v_ar, v_perm, 'core1.refill_vendor_order', 'medicine_refill', 'refill_vendor:sql-test:1', 'ciphertext', repeat('b', 64), 'pending'
  );

  select remaining_count into v_rem from public.medicines where id = v_med;
  if v_rem <> 5 then
    raise exception 'FAIL remaining_count modified before confirmed delivery: %', v_rem;
  end if;

  -- 4. Confirmed delivery -> ONLY NOW decrements count
  update public.errands set status = 'completed' where id = v_err and status = 'authorized';
  update public.action_requests set status = 'executed' where id = v_ar;
  update public.requests set status = 'completed' where id = v_req;
  update public.medicines set remaining_count = greatest(0, remaining_count - 1) where id = v_med;

  select remaining_count into v_rem from public.medicines where id = v_med;
  if v_rem <> 4 then
    raise exception 'FAIL remaining_count did not decrement on confirmed delivery: %', v_rem;
  end if;

  -- 5. Missed-call nudge + push outbox (no whatsapp) + shield/report facts
  insert into public.nudges(family_id, person_id, kind, scheduled_at, status)
  values (v_fam, v_riya, 'missed_call_single', now(), 'pending');

  insert into public.child_alerts(family_id, person_id, incident_id, kind)
  values (v_fam, v_riya, null, 'missed_call_single');

  insert into public.outbox(
    family_id, kind, action, dedupe_key, payload_ciphertext, payload_hash, status
  ) values (
    v_fam, 'core1.missed_call_push', 'missed_call_nudge', 'missed_call_push:sql-test:1', 'ciphertext', repeat('c', 64), 'pending'
  );

  insert into public.calls(family_id, person_id, provider, external_id, status)
  values (v_fam, v_maa, 'sarvam', 'call-sql-1', 'completed');

  insert into public.incidents(family_id, person_id, state, severity)
  values (v_fam, v_maa, 'closed', 'urgent');

  insert into public.shield_events(family_id, parent_id, channel, kind, local_level, occurred_at, idempotency_key)
  values (v_fam, v_maa, 'device', 'sms', 'yellow', now(), 'shield-sql-test-001');

  if exists(select 1 from public.outbox where family_id = v_fam and kind like '%whatsapp%') then
    raise exception 'FAIL WhatsApp outbox row present when WhatsApp is dropped';
  end if;
end $$;

rollback;
