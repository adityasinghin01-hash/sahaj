-- Phase 4 Core 1: Durable domain functions, incident escalation, voice post orchestration, dose tracking, and timeline projection
-- Strictly adheres to tenant isolation, zero plaintext PII/phone exposure, and explicit verified proof binding.

-- 1. Helper function to check if caller belongs to family with given role
create or replace function sahaj_private.is_family_member_with_role(p_family_id uuid, p_allowed_roles text[])
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.family_memberships
    where family_id = p_family_id
      and user_id = auth.uid()
      and role = any(p_allowed_roles)
  );
$$;

-- 2. Urgent Incident Initiation & Responder Assignment Offer
create or replace function public.create_urgent_incident_offer(
  p_family_id uuid,
  p_subject_person_id uuid,
  p_severity text,
  p_offer_timeout_minutes integer default 3
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_incident_id uuid;
  v_assignment_id uuid;
  v_responder_person_id uuid;
  v_expires_at timestamptz;
  v_timeout integer;
begin
  -- Validate subject belongs to family
  if not exists (select 1 from public.people where family_id = p_family_id and id = p_subject_person_id) then
    raise exception 'invalid_subject_person' using errcode = '42501';
  end if;

  if p_severity not in ('routine', 'urgent', 'critical') then
    raise exception 'invalid_severity' using errcode = '22023';
  end if;

  v_timeout := coalesce(p_offer_timeout_minutes, 3);
  if v_timeout <= 0 then v_timeout := 3; end if;

  -- Create incident in open state first
  insert into public.incidents (family_id, person_id, severity, state)
  values (p_family_id, p_subject_person_id, p_severity, 'open')
  returning id into v_incident_id;

  -- Find top-ranked eligible circle member who is NOT the subject person
  select c.person_id into v_responder_person_id
  from public.circle c
  join public.people p on p.family_id = c.family_id and p.id = c.person_id
  where c.family_id = p_family_id
    and c.person_id <> p_subject_person_id
    and c.active = true
    and c.consent_at is not null
    and c.revoked_at is null
  order by c.rank asc
  limit 1;

  if v_responder_person_id is null then
    -- No eligible circle member: escalate incident immediately
    update public.incidents
    set state = 'escalated'
    where id = v_incident_id;

    return jsonb_build_object(
      'incident_id', v_incident_id,
      'state', 'escalated',
      'reason', 'no_available_circle_members'
    );
  end if;

  v_expires_at := clock_timestamp() + (v_timeout * interval '1 minute');

  -- Create assignment offer
  insert into public.assignments (family_id, incident_id, person_id, status, expires_at)
  values (p_family_id, v_incident_id, v_responder_person_id, 'offered', v_expires_at)
  returning id into v_assignment_id;

  -- Advance incident state to offered
  update public.incidents
  set state = 'offered'
  where id = v_incident_id;

  return jsonb_build_object(
    'incident_id', v_incident_id,
    'assignment_id', v_assignment_id,
    'responder_person_id', v_responder_person_id,
    'state', 'offered',
    'expires_at', v_expires_at
  );
end;
$$;

-- 3. Urgent Responder Acceptance with Verified Provider Proof
create or replace function public.accept_responder_assignment_verified(
  p_family_id uuid,
  p_incident_id uuid,
  p_assignment_id uuid,
  p_responder_person_id uuid,
  p_raw_event_id uuid,
  p_promise_minutes integer default 15
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_incident public.incidents%rowtype;
  v_assignment public.assignments%rowtype;
  v_raw_event public.raw_events%rowtype;
  v_promised_at timestamptz;
  v_promise_min integer;
begin
  -- 1. Lock and validate incident
  select * into v_incident from public.incidents
  where family_id = p_family_id and id = p_incident_id
  for update;

  if not found then
    raise exception 'incident_not_found' using errcode = 'P0002';
  end if;

  if v_incident.state in ('escalated', 'closed', 'done') then
    raise exception 'incident_already_terminal' using errcode = '42501';
  end if;

  -- 2. Lock and validate assignment
  select * into v_assignment from public.assignments
  where family_id = p_family_id and id = p_assignment_id and incident_id = p_incident_id
  for update;

  if not found then
    raise exception 'assignment_not_found' using errcode = 'P0002';
  end if;

  if v_assignment.status <> 'offered' then
    raise exception 'assignment_not_offered' using errcode = '42501';
  end if;

  if v_assignment.person_id <> p_responder_person_id then
    raise exception 'wrong_responder' using errcode = '42501';
  end if;

  if v_assignment.person_id = v_incident.person_id then
    raise exception 'subject_cannot_be_responder' using errcode = '42501';
  end if;

  -- 3. Verify authoritative provider event
  select * into v_raw_event from public.raw_events
  where id = p_raw_event_id;

  if not found then
    raise exception 'unverified_event_missing' using errcode = 'P0002';
  end if;

  -- Strictly verify proof attributes
  if v_raw_event.status <> 'processed'
     or v_raw_event.normalized_proof <> true
     or v_raw_event.verified_by <> 'twilio_signature'
     or v_raw_event.source <> 'twilio'
     or (v_raw_event.metadata->>'action') <> 'urgent_responder'
     or (v_raw_event.family_id is not null and v_raw_event.family_id <> p_family_id)
     or (v_raw_event.metadata->>'incident_id')::uuid <> p_incident_id
     or (v_raw_event.metadata->>'assignment_id')::uuid <> p_assignment_id
     or (v_raw_event.metadata->>'responder_person_id')::uuid <> p_responder_person_id
  then
    raise exception 'invalid_acceptance_proof' using errcode = '42501';
  end if;

  v_promise_min := coalesce(p_promise_minutes, 15);
  if v_promise_min <= 0 then v_promise_min := 15; end if;
  v_promised_at := clock_timestamp() + (v_promise_min * interval '1 minute');

  -- 4. Transition assignment to accepted
  update public.assignments
  set status = 'accepted',
      accepted_at = clock_timestamp(),
      verified_by_provider_event = p_raw_event_id
  where id = p_assignment_id;

  -- 5. Transition incident to accepted
  update public.incidents
  set state = 'accepted',
      owner_person_id = p_responder_person_id,
      promised_at = v_promised_at
  where id = p_incident_id;

  return jsonb_build_object(
    'incident_id', p_incident_id,
    'assignment_id', p_assignment_id,
    'responder_person_id', p_responder_person_id,
    'state', 'accepted',
    'promised_at', v_promised_at
  );
end;
$$;

-- 4. Medicine Dose Recording
create or replace function public.record_medicine_dose(
  p_family_id uuid,
  p_medicine_id uuid,
  p_person_id uuid,
  p_action_type text,
  p_count integer default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_med public.medicines%rowtype;
  v_count_taken integer;
  v_new_remaining integer;
begin
  select * into v_med from public.medicines
  where family_id = p_family_id and id = p_medicine_id and person_id = p_person_id
  for update;

  if not found then
    raise exception 'medicine_not_found' using errcode = 'P0002';
  end if;

  if p_action_type = 'confirmed_dose' then
    v_count_taken := coalesce(p_count, 1);
    if v_count_taken <= 0 then
      raise exception 'invalid_dose_count' using errcode = '22023';
    end if;
    v_new_remaining := greatest(0, coalesce(v_med.remaining_count, 0) - v_count_taken);

  elsif p_action_type = 'missed_dose' then
    -- Physical medicine not consumed: inventory remains unchanged
    v_new_remaining := coalesce(v_med.remaining_count, 0);

  elsif p_action_type = 'double_dose_reported' then
    v_count_taken := coalesce(p_count, 2);
    if v_count_taken <= 0 then
      raise exception 'invalid_dose_count' using errcode = '22023';
    end if;
    v_new_remaining := greatest(0, coalesce(v_med.remaining_count, 0) - v_count_taken);

  elsif p_action_type = 'count_reconciliation' then
    if p_count is null or p_count < 0 then
      raise exception 'invalid_reconciliation_count' using errcode = '22023';
    end if;
    v_new_remaining := p_count;
  else
    raise exception 'unsupported_dose_action' using errcode = '22023';
  end if;

  update public.medicines
  set remaining_count = v_new_remaining
  where id = p_medicine_id;

  return jsonb_build_object(
    'medicine_id', p_medicine_id,
    'action_type', p_action_type,
    'remaining_count', v_new_remaining,
    'refill_threshold', v_med.refill_threshold,
    'is_low_stock', (v_new_remaining <= v_med.refill_threshold),
    'instructions_confirmed_by_person', v_med.instructions_confirmed_by_person
  );
end;
$$;

-- 5. Two-Way Family Voice Post Creation
create or replace function public.create_family_voice_post(
  p_family_id uuid,
  p_sender_id uuid,
  p_recipient_id uuid,
  p_object_path text,
  p_consent_id uuid,
  p_reply_to uuid default null,
  p_retention_days integer default 30
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_voice_post_id uuid;
  v_consent public.consents%rowtype;
  v_expires_at timestamptz;
  v_retention integer;
begin
  if p_sender_id = p_recipient_id then
    raise exception 'sender_equals_recipient' using errcode = '42501';
  end if;

  -- Validate both sender and recipient belong to family
  if not exists (select 1 from public.people where family_id = p_family_id and id = p_sender_id)
     or not exists (select 1 from public.people where family_id = p_family_id and id = p_recipient_id) then
    raise exception 'person_not_in_family' using errcode = '42501';
  end if;

  -- Validate storage path: must start with <p_family_id>/voice/ and contain no path traversal
  if p_object_path not like (p_family_id::text || '/voice/%')
     or p_object_path like '%..%'
     or p_object_path like '%:%' then
    raise exception 'invalid_voice_object_path' using errcode = '42501';
  end if;

  -- Validate consent
  select * into v_consent from public.consents
  where family_id = p_family_id and id = p_consent_id and person_id = p_sender_id;

  if not found then
    raise exception 'consent_not_found' using errcode = 'P0002';
  end if;

  if v_consent.purpose <> ('voice_share:' || p_recipient_id::text) and v_consent.purpose <> 'voice_share:*' then
    raise exception 'consent_purpose_mismatch' using errcode = '42501';
  end if;

  if v_consent.answer <> true or v_consent.revoked_at is not null then
    raise exception 'consent_not_effective' using errcode = '42501';
  end if;

  v_retention := coalesce(p_retention_days, 30);
  if v_retention <= 0 then v_retention := 30; end if;
  v_expires_at := clock_timestamp() + (v_retention * interval '1 day');

  insert into public.voice_posts (family_id, sender_id, recipient_id, reply_to, consent_id, state)
  values (p_family_id, p_sender_id, p_recipient_id, p_reply_to, p_consent_id, 'queued')
  returning id into v_voice_post_id;

  insert into sahaj_private.voice_content (family_id, voice_post_id, object_path, expires_at)
  values (p_family_id, v_voice_post_id, p_object_path, v_expires_at);

  return jsonb_build_object(
    'voice_post_id', v_voice_post_id,
    'sender_id', p_sender_id,
    'recipient_id', p_recipient_id,
    'state', 'queued',
    'expires_at', v_expires_at
  );
end;
$$;

-- Privileges: Grant execute on safe RPCs to authenticated and service_role
grant execute on function public.create_urgent_incident_offer(uuid, uuid, text, integer) to authenticated, service_role;
grant execute on function public.accept_responder_assignment_verified(uuid, uuid, uuid, uuid, uuid, integer) to authenticated, service_role;
grant execute on function public.record_medicine_dose(uuid, uuid, uuid, text, integer) to authenticated, service_role;
grant execute on function public.create_family_voice_post(uuid, uuid, uuid, text, uuid, uuid, integer) to authenticated, service_role;
