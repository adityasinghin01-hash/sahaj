-- K-SARVAMCALL: urgent responder offer over Sarvam -> claim -> complete (attempt id) -> record_sarvam_responder_decision
-- -> accept_responder_assignment_verified. Refusals: foreign call id, call not yet dispatched, call of another assignment,
-- provider ref mismatch, expired assignment, a second different decision. Replay of the same decision is idempotent.
-- Also: keypad send channel 'sarvam' is accepted by the send context. Synthetic data only; rolls back.

begin;

insert into auth.users(id) values ('a9300000-0000-4000-8000-000000000001');
insert into public.families(id, name) values ('b9300000-0000-4000-8000-000000000001', 'Synthetic Sarvam Family');
insert into public.people(id, family_id, display_name, role) values
  ('c9300000-0000-4000-8000-000000000001', 'b9300000-0000-4000-8000-000000000001', 'Meena Maa', 'parent'),
  ('c9300000-0000-4000-8000-000000000002', 'b9300000-0000-4000-8000-000000000001', 'Riya', 'child'),
  ('c9300000-0000-4000-8000-000000000003', 'b9300000-0000-4000-8000-000000000001', 'Rohit', 'circle'),
  ('c9300000-0000-4000-8000-000000000004', 'b9300000-0000-4000-8000-000000000001', 'Sharma uncle', 'circle');
insert into public.family_memberships(family_id, user_id, person_id, role) values
  ('b9300000-0000-4000-8000-000000000001', 'a9300000-0000-4000-8000-000000000001', 'c9300000-0000-4000-8000-000000000002', 'child');
insert into public.circle(family_id, person_id, rank, approved_at, consent_at, revoked_at) values
  ('b9300000-0000-4000-8000-000000000001', 'c9300000-0000-4000-8000-000000000003', 1, now() - interval '3 days', now() - interval '1 day', null),
  ('b9300000-0000-4000-8000-000000000001', 'c9300000-0000-4000-8000-000000000004', 2, now() - interval '3 days', now() - interval '1 day', null);
insert into public.atlas_principals(id, family_id, label) values
  ('d9300000-0000-4000-8000-000000000001', 'b9300000-0000-4000-8000-000000000001', 'atlas-core1');
insert into public.consents(id, family_id, person_id, purpose, question, answer, version) values
  ('e9300000-0000-4000-8000-000000000001', 'b9300000-0000-4000-8000-000000000001', 'c9300000-0000-4000-8000-000000000001', 'permission_setup', 'Allow?', true, 'v1');
insert into public.permissions(id, family_id, person_id, principal_id, action, decision, expires_at, consent_id,
  two_person_required, valid_from, period_start, period_end, max_uses, target_ids) values
  ('f9300000-0000-4000-8000-000000000001', 'b9300000-0000-4000-8000-000000000001', 'c9300000-0000-4000-8000-000000000001',
   'd9300000-0000-4000-8000-000000000001', 'urgent_responder', 'allow', now() + interval '1 day', 'e9300000-0000-4000-8000-000000000001',
   false, now() - interval '1 hour', now() - interval '1 hour', now() + interval '1 day', 10, array['c9300000-0000-4000-8000-000000000001']);
insert into public.provider_identities(id, family_id, person_id, source, account_id, external_id_hash, binding_kind, contact_ciphertext) values
  ('a9400000-0000-4000-8000-000000000003', 'b9300000-0000-4000-8000-000000000001', 'c9300000-0000-4000-8000-000000000003', 'sarvam', 'agent-synth', repeat('3', 64), 'contact', 'enc-contact-rohit'),
  ('a9400000-0000-4000-8000-000000000004', 'b9300000-0000-4000-8000-000000000001', 'c9300000-0000-4000-8000-000000000004', 'sarvam', 'agent-synth', repeat('4', 64), 'contact', 'enc-contact-sharma');

-- Test fixture helpers (owner-run, like the seeds): offer + Sarvam prepare + claim + optional complete.
-- The decisions under test below run as service_role. Returns {incident, assignment, call, outbox}.
create function pg_temp.sarvam_offer(p_resp uuid, p_identity uuid, p_hash text, p_tag text, p_complete boolean) returns jsonb
language plpgsql security definer as $$
declare
  fam uuid := 'b9300000-0000-4000-8000-000000000001';
  maa uuid := 'c9300000-0000-4000-8000-000000000001';
  inc uuid := gen_random_uuid(); asg uuid := gen_random_uuid();
  prep jsonb; ob uuid; cl uuid; lease uuid := gen_random_uuid(); dk text; b public.dispatch_bindings; c public.calls;
begin
  insert into public.incidents(id, family_id, person_id, state, severity) values (inc, fam, maa, 'offered', 'critical');
  insert into public.assignments(id, family_id, incident_id, person_id, status, offered_at, expires_at)
    values (asg, fam, inc, p_resp, 'offered', clock_timestamp(), clock_timestamp() + interval '3 minutes');
  prep := public.prepare_urgent_responder_dispatch(fam, inc, asg, maa, p_resp, 'urg:sarvam-sql:'||p_tag, 'ct', repeat('a', 64), 'sarvam');
  if prep->>'status' <> 'ready' then raise exception 'FAIL sarvam prepare: %', prep; end if;
  ob := (prep->>'outbox_id')::uuid; cl := (prep->>'call_id')::uuid;
  select * into c from public.calls where id = cl;
  select * into b from public.dispatch_bindings where outbox_id = ob;
  if c.provider <> 'sarvam' or b.provider <> 'sarvam' or b.action <> 'sarvam.outbound_call' or b.assignment_id <> asg or b.call_id <> cl then
    raise exception 'FAIL sarvam binding: call=% binding=%/%', c.provider, b.provider, b.action;
  end if;
  update public.outbox set status = 'processing', lease_token = lease, lease_until = now() + interval '2 minutes',
    worker_id = 'sql-test', attempt_count = 1 where id = ob;
  dk := 'dispatch:' || ob || ':a1';
  if public.claim_dispatch_contact(fam, p_resp, dk, 'sarvam', 'sarvam.outbound_call', ob, lease, cl, p_identity, 'agent-synth', p_hash) <> 'claimed' then
    raise exception 'FAIL sarvam claim_dispatch_contact';
  end if;
  if p_complete then
    if public.complete_dispatch(fam, dk, 'att-'||p_tag, 'agent-synth', md5(p_tag)||md5(p_tag), true) <> 'dispatched' then
      raise exception 'FAIL sarvam complete_dispatch';
    end if;
    perform public.finish_outbox(ob, lease, true, null);
  end if;
  return jsonb_build_object('incident', inc, 'assignment', asg, 'call', cl, 'outbox', ob);
end $$;
create function pg_temp.expire_assignment(p_id uuid) returns void language sql security definer as $$
  update public.assignments set expires_at = clock_timestamp() - interval '1 second' where id = p_id
$$;
grant execute on function pg_temp.sarvam_offer(uuid, uuid, text, text, boolean), pg_temp.expire_assignment(uuid) to service_role;

set local role service_role;

do $$
declare
  fam uuid := 'b9300000-0000-4000-8000-000000000001';
  rohit uuid := 'c9300000-0000-4000-8000-000000000003';
  sharma uuid := 'c9300000-0000-4000-8000-000000000004';
  a jsonb; b jsonb; pending jsonb; r jsonb; r2 jsonb; acc jsonb; inc_row public.incidents%rowtype; refused text;
begin
  -- Twilio stays the default provider for old callers (8 arguments).
  perform 1 from pg_proc where proname = 'prepare_urgent_responder_dispatch' and pronargs = 9;
  if not found then raise exception 'FAIL prepare_urgent_responder_dispatch(…, p_provider) missing'; end if;

  a := pg_temp.sarvam_offer(rohit, 'a9400000-0000-4000-8000-000000000003', repeat('3', 64), 'a', true);

  -- 1. Foreign call id.
  begin
    perform public.record_sarvam_responder_decision(fam, gen_random_uuid(), (a->>'incident')::uuid, (a->>'assignment')::uuid, rohit, 'accept');
    raise exception 'FAIL foreign call accepted';
  exception when insufficient_privilege then refused := sqlerrm; end;
  if refused <> 'call_not_ours' then raise exception 'FAIL foreign call refusal: %', refused; end if;

  -- 2. Provider reference mismatch (Sarvam echoes another attempt id).
  begin
    perform public.record_sarvam_responder_decision(fam, (a->>'call')::uuid, (a->>'incident')::uuid, (a->>'assignment')::uuid, rohit, 'accept', 'att-other');
    raise exception 'FAIL ref mismatch accepted';
  exception when insufficient_privilege then refused := sqlerrm; end;
  if refused <> 'call_ref_mismatch' then raise exception 'FAIL ref mismatch refusal: %', refused; end if;

  -- 3. A different responder named for this call.
  begin
    perform public.record_sarvam_responder_decision(fam, (a->>'call')::uuid, (a->>'incident')::uuid, (a->>'assignment')::uuid, sharma, 'accept');
    raise exception 'FAIL wrong responder accepted';
  exception when insufficient_privilege then refused := sqlerrm; end;
  if refused <> 'call_assignment_mismatch' then raise exception 'FAIL wrong responder refusal: %', refused; end if;

  -- 4. Claimed but never dispatched (no provider ref): not ours yet.
  pending := pg_temp.sarvam_offer(sharma, 'a9400000-0000-4000-8000-000000000004', repeat('4', 64), 'pending', false);
  begin
    perform public.record_sarvam_responder_decision(fam, (pending->>'call')::uuid, (pending->>'incident')::uuid, (pending->>'assignment')::uuid, sharma, 'accept');
    raise exception 'FAIL undispatched call accepted';
  exception when insufficient_privilege then refused := sqlerrm; end;
  if refused <> 'call_not_ours' then raise exception 'FAIL undispatched refusal: %', refused; end if;

  -- 5. Accept with OUR call -> normalized proof -> existing verified accept.
  r := public.record_sarvam_responder_decision(fam, (a->>'call')::uuid, (a->>'incident')::uuid, (a->>'assignment')::uuid, rohit, 'accept', 'att-a');
  if r->>'decision' <> 'accept' or (r->>'replayed')::boolean or r->>'proof_event_id' is null then raise exception 'FAIL accept result: %', r; end if;
  perform 1 from public.raw_events where id = (r->>'proof_event_id')::uuid and source = 'sarvam' and normalized_proof
    and event_type = 'responder.accepted' and metadata->>'verified_by' = 'sarvam_call_binding' and metadata->>'call_id' = a->>'call';
  if not found then raise exception 'FAIL proof row shape'; end if;
  acc := public.accept_responder_assignment_verified(fam, (a->>'incident')::uuid, (a->>'assignment')::uuid, rohit, (r->>'proof_event_id')::uuid, 7);
  select * into inc_row from public.incidents where id = (a->>'incident')::uuid;
  if inc_row.state <> 'accepted' or inc_row.owner_person_id <> rohit or inc_row.promised_at is null then
    raise exception 'FAIL incident not accepted: % %', inc_row.state, acc;
  end if;

  -- 6. Replay is idempotent per call id; the other decision is refused.
  r2 := public.record_sarvam_responder_decision(fam, (a->>'call')::uuid, (a->>'incident')::uuid, (a->>'assignment')::uuid, rohit, 'accept');
  if r2->>'proof_event_id' <> r->>'proof_event_id' or not (r2->>'replayed')::boolean then raise exception 'FAIL replay: %', r2; end if;
  if (select count(*) from public.raw_events where family_id = fam and source = 'sarvam' and event_type = 'responder.accepted') <> 1 then
    raise exception 'FAIL replay wrote a second proof';
  end if;
  begin
    perform public.record_sarvam_responder_decision(fam, (a->>'call')::uuid, (a->>'incident')::uuid, (a->>'assignment')::uuid, rohit, 'decline');
    raise exception 'FAIL second decision accepted';
  exception when insufficient_privilege then refused := sqlerrm; end;
  if refused <> 'decision_already_recorded' then raise exception 'FAIL second decision refusal: %', refused; end if;

  -- 7. A dispatched call for ANOTHER assignment cannot accept this one; an expired assignment cannot be accepted.
  b := pg_temp.sarvam_offer(sharma, 'a9400000-0000-4000-8000-000000000004', repeat('4', 64), 'b', true);
  begin
    perform public.record_sarvam_responder_decision(fam, (b->>'call')::uuid, (a->>'incident')::uuid, (a->>'assignment')::uuid, rohit, 'accept');
    raise exception 'FAIL cross-assignment call accepted';
  exception when insufficient_privilege then refused := sqlerrm; end;
  if refused <> 'call_assignment_mismatch' then raise exception 'FAIL cross-assignment refusal: %', refused; end if;
  perform pg_temp.expire_assignment((b->>'assignment')::uuid);
  begin
    perform public.record_sarvam_responder_decision(fam, (b->>'call')::uuid, (b->>'incident')::uuid, (b->>'assignment')::uuid, sharma, 'accept');
    raise exception 'FAIL expired assignment accepted';
  exception when insufficient_privilege then refused := sqlerrm; end;
  if refused <> 'assignment_not_offered' then raise exception 'FAIL expired refusal: %', refused; end if;
  if exists(select 1 from public.raw_events where family_id = fam and source = 'sarvam' and provider_event_id = 'sarvam:tool:responder_decision:'||(b->>'call')) then
    raise exception 'FAIL expired attempt left evidence';
  end if;
end $$;

-- 8. Decline on a live Sarvam offer records the decision (no proof) and is idempotent.
do $$
declare
  fam uuid := 'b9300000-0000-4000-8000-000000000001';
  sharma uuid := 'c9300000-0000-4000-8000-000000000004';
  c jsonb; r jsonb; r2 jsonb;
begin
  c := pg_temp.sarvam_offer(sharma, 'a9400000-0000-4000-8000-000000000004', repeat('4', 64), 'c', true);
  r := public.record_sarvam_responder_decision(fam, (c->>'call')::uuid, (c->>'incident')::uuid, (c->>'assignment')::uuid, sharma, 'decline');
  if r->>'decision' <> 'decline' or r ? 'proof_event_id' then raise exception 'FAIL decline result: %', r; end if;
  r2 := public.record_sarvam_responder_decision(fam, (c->>'call')::uuid, (c->>'incident')::uuid, (c->>'assignment')::uuid, sharma, 'decline');
  if r2->>'event_id' <> r->>'event_id' or not (r2->>'replayed')::boolean then raise exception 'FAIL decline replay: %', r2; end if;
end $$;

-- 9. Keypad send channel and kind accepted by the append-only send context.
do $$
begin
  perform 1 from pg_constraint where conname = 'authorized_send_context_channel_check' and pg_get_constraintdef(oid) like '%sarvam%';
  if not found then raise exception 'FAIL send context channel sarvam'; end if;
  perform 1 from pg_constraint where conname = 'authorized_send_context_kind_check' and pg_get_constraintdef(oid) like '%gentle_news.maa_call%';
  if not found then raise exception 'FAIL send context kind gentle_news.maa_call'; end if;
end $$;

rollback;
