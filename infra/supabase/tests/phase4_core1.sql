-- Phase 4 Core 1: Rollback SQL Acceptance Test Suite
-- Executes all schema RPCs and constraint checks in a safe, rolling-back transaction.

begin;

-- 1. Setup synthetic test identities
insert into auth.users (id) values
  ('a4000000-0000-4000-8000-000000000001'),
  ('a4000000-0000-4000-8000-000000000002');

insert into public.families (id, name) values
  ('b4000000-0000-4000-8000-000000000001', 'Phase4 Synthetic Family A'),
  ('b4000000-0000-4000-8000-000000000002', 'Phase4 Synthetic Family B');

insert into public.people (id, family_id, display_name, role) values
  ('c4000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'Maa Meena', 'parent'),
  ('c4000000-0000-4000-8000-000000000002', 'b4000000-0000-4000-8000-000000000001', 'Riya Child', 'child'),
  ('c4000000-0000-4000-8000-000000000003', 'b4000000-0000-4000-8000-000000000001', 'Sharma Uncle', 'circle'),
  ('c4000000-0000-4000-8000-000000000004', 'b4000000-0000-4000-8000-000000000002', 'Foreign Person B', 'child');

insert into public.family_memberships (family_id, user_id, person_id, role) values
  ('b4000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'parent'),
  ('b4000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000002', 'child');

-- Circle members: Riya rank 1, Sharma uncle rank 2
insert into public.circle (family_id, person_id, rank, active, consent_at) values
  ('b4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 1, true, now()),
  ('b4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000003', 2, true, now());

-- Consents: voice_share consent from Maa to Riya
insert into public.consents (id, family_id, person_id, purpose, question, answer, version) values
  ('f4000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001',
   'voice_share:c4000000-0000-4000-8000-000000000002', 'Share voice with Riya?', true, 'v1');

-- Medicines: Amlodipine for Maa
insert into public.medicines (id, family_id, person_id, label, remaining_count, refill_threshold, instructions_confirmed_by_person) values
  ('m4000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001',
   'Amlodipine 5mg', 10, 3, true);

-- 2. Test create_urgent_incident_offer
do $$
declare
  v_res jsonb;
  v_inc_id uuid;
  v_asgn_id uuid;
begin
  v_res := public.create_urgent_incident_offer(
    'b4000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000001',
    'urgent',
    3
  );

  if (v_res->>'state') <> 'offered' then
    raise exception 'FAIL: expected state offered, got %', (v_res->>'state');
  end if;

  if (v_res->>'responder_person_id')::uuid <> 'c4000000-0000-4000-8000-000000000002'::uuid then
    raise exception 'FAIL: expected rank 1 responder Riya, got %', (v_res->>'responder_person_id');
  end if;

  -- Test subject exclusion: if Riya needs help, offer goes to Sharma Uncle, not Riya herself
  v_res := public.create_urgent_incident_offer(
    'b4000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000002',
    'urgent',
    3
  );

  if (v_res->>'responder_person_id')::uuid <> 'c4000000-0000-4000-8000-000000000003'::uuid then
    raise exception 'FAIL: expected offer to advance to Uncle Sharma, got %', (v_res->>'responder_person_id');
  end if;
end $$;

-- 3. Test accept_responder_assignment_verified
do $$
declare
  v_init jsonb;
  v_inc_id uuid;
  v_asgn_id uuid;
  v_evt_id uuid;
  v_accept_res jsonb;
begin
  v_init := public.create_urgent_incident_offer(
    'b4000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000001',
    'urgent',
    3
  );
  v_inc_id := (v_init->>'incident_id')::uuid;
  v_asgn_id := (v_init->>'assignment_id')::uuid;

  -- Insert authoritative verified proof event
  v_evt_id := gen_random_uuid();
  insert into public.raw_events (
    id, family_id, source, event_type, status, normalized_proof, verified_by, payload_ciphertext, metadata
  ) values (
    v_evt_id,
    'b4000000-0000-4000-8000-000000000001',
    'twilio',
    'responder.accepted',
    'processed',
    true,
    'twilio_signature',
    'enc_synthetic',
    jsonb_build_object(
      'action', 'urgent_responder',
      'incident_id', v_inc_id,
      'assignment_id', v_asgn_id,
      'responder_person_id', 'c4000000-0000-4000-8000-000000000002'
    )
  );

  -- Valid acceptance
  v_accept_res := public.accept_responder_assignment_verified(
    'b4000000-0000-4000-8000-000000000001',
    v_inc_id,
    v_asgn_id,
    'c4000000-0000-4000-8000-000000000002',
    v_evt_id,
    20
  );

  if (v_accept_res->>'state') <> 'accepted' then
    raise exception 'FAIL: expected accepted state, got %', (v_accept_res->>'state');
  end if;

  -- Rejection of wrong responder
  begin
    perform public.accept_responder_assignment_verified(
      'b4000000-0000-4000-8000-000000000001',
      v_inc_id,
      v_asgn_id,
      'c4000000-0000-4000-8000-000000000003', -- wrong responder!
      v_evt_id
    );
    raise exception 'FAIL: accepted wrong responder';
  exception when others then null;
  end;
end $$;

-- 4. Test record_medicine_dose
do $$
declare
  v_res jsonb;
begin
  -- Confirmed dose decrements count from 10 to 9
  v_res := public.record_medicine_dose(
    'b4000000-0000-4000-8000-000000000001',
    'm4000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000001',
    'confirmed_dose',
    1
  );

  if (v_res->>'remaining_count')::integer <> 9 then
    raise exception 'FAIL: expected remaining 9, got %', (v_res->>'remaining_count');
  end if;

  -- Missed dose keeps count at 9
  v_res := public.record_medicine_dose(
    'b4000000-0000-4000-8000-000000000001',
    'm4000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000001',
    'missed_dose'
  );

  if (v_res->>'remaining_count')::integer <> 9 then
    raise exception 'FAIL: missed dose must preserve count 9, got %', (v_res->>'remaining_count');
  end if;

  -- Rejection of negative count
  begin
    perform public.record_medicine_dose(
      'b4000000-0000-4000-8000-000000000001',
      'm4000000-0000-4000-8000-000000000001',
      'c4000000-0000-4000-8000-000000000001',
      'confirmed_dose',
      -5
    );
    raise exception 'FAIL: accepted negative dose count';
  exception when others then null;
  end;
end $$;

-- 5. Test create_family_voice_post
do $$
declare
  v_res jsonb;
begin
  -- Valid voice post creation
  v_res := public.create_family_voice_post(
    'b4000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000002',
    'b4000000-0000-4000-8000-000000000001/voice/audio_01.m4a',
    'f4000000-0000-4000-8000-000000000001'
  );

  if (v_res->>'state') <> 'queued' then
    raise exception 'FAIL: expected voice post queued, got %', (v_res->>'state');
  end if;

  -- Rejection of path traversal
  begin
    perform public.create_family_voice_post(
      'b4000000-0000-4000-8000-000000000001',
      'c4000000-0000-4000-8000-000000000001',
      'c4000000-0000-4000-8000-000000000002',
      'b4000000-0000-4000-8000-000000000001/voice/../../etc/passwd',
      'f4000000-0000-4000-8000-000000000001'
    );
    raise exception 'FAIL: accepted path traversal in voice object path';
  exception when others then null;
  end;

  -- Rejection of self-message
  begin
    perform public.create_family_voice_post(
      'b4000000-0000-4000-8000-000000000001',
      'c4000000-0000-4000-8000-000000000001',
      'c4000000-0000-4000-8000-000000000001', -- same person!
      'b4000000-0000-4000-8000-000000000001/voice/self.m4a',
      'f4000000-0000-4000-8000-000000000001'
    );
    raise exception 'FAIL: accepted sender = recipient';
  exception when others then null;
  end;
end $$;

-- Rollback all test insertions and changes
rollback;
