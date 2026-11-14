-- Phase 4 Core 1: incident offer and escalation chain, verified responder acceptance, dose recording, family voice posts.
-- Applies after the Phase 2/3 migrations (201500, 201600, 210000, 213000). Not deployed anywhere yet.
--
-- K-INT1 corrections (first execution on the joined schema):
--   * public.circle has no `active` column. An eligible responder is a circle row with approved_at, consent_at set and
--     revoked_at null.
--   * public.raw_events has no `verified_by` column; acceptance now delegates to Phase 2's public.accept_assignment_verified,
--     which re-derives the full call/ledger/binding/account chain, instead of trusting hand-written metadata.
--   * public.consents has no `revoked_at`: consent is append-only, newest row wins (sahaj_private.consent_current).
--     The `voice_share:*` wildcard is gone; sharing consent is per recipient.
--   * Every function is SECURITY DEFINER with an empty search_path and is executable by service_role only. They take
--     family/person ids from the caller, so exposing them to `authenticated` (as before) let any signed-in user act on any
--     family. Server routes verify the user and membership first, then call these with the service role.
--   * Decline / timeout move the offer to the next eligible circle member; with none left the incident escalates.

-- 1. Role helper (unused by the RPCs below; kept for RLS policies). Revoked memberships no longer count.
create or replace function sahaj_private.is_family_member_with_role(p_family_id uuid, p_allowed_roles text[])
returns boolean language sql security definer stable set search_path='' as $$
  select exists (
    select 1 from public.family_memberships m
    where m.family_id = p_family_id and m.user_id = auth.uid() and m.revoked_at is null and m.role = any(p_allowed_roles)
  );
$$;

-- 2. Next eligible responder for an incident: approved, consenting, unrevoked circle member, not the subject, and not
-- already offered on this incident. Lowest rank first, then person id for a stable order.
create or replace function sahaj_private.next_circle_responder(p_family_id uuid, p_incident_id uuid, p_subject_person_id uuid)
returns uuid language sql stable security definer set search_path='' as $$
  select c.person_id
  from public.circle c
  join public.people p on p.family_id = c.family_id and p.id = c.person_id
  where c.family_id = p_family_id
    and c.person_id <> p_subject_person_id
    and c.approved_at is not null and c.consent_at is not null and c.revoked_at is null
    and not exists (select 1 from public.assignments a
      where a.family_id = p_family_id and a.incident_id = p_incident_id and a.person_id = c.person_id)
  order by c.rank asc, c.person_id asc
  limit 1;
$$;

-- 3. Offer the incident to the next eligible member, or escalate when none is left. Caller holds the incident row lock.
create or replace function sahaj_private.offer_next_responder(p_family_id uuid, p_incident_id uuid, p_subject_person_id uuid,
  p_offer_timeout_minutes integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_responder uuid; v_assignment uuid; v_expires timestamptz;
begin
  v_responder := sahaj_private.next_circle_responder(p_family_id, p_incident_id, p_subject_person_id);
  if v_responder is null then
    update public.incidents set state = 'escalated' where id = p_incident_id and family_id = p_family_id;
    return jsonb_build_object('incident_id', p_incident_id, 'state', 'escalated', 'reason', 'no_available_circle_members');
  end if;
  v_expires := clock_timestamp() + (p_offer_timeout_minutes * interval '1 minute');
  insert into public.assignments (family_id, incident_id, person_id, status, expires_at)
    values (p_family_id, p_incident_id, v_responder, 'offered', v_expires)
    returning id into v_assignment;
  update public.incidents set state = 'offered' where id = p_incident_id and family_id = p_family_id;
  return jsonb_build_object('incident_id', p_incident_id, 'assignment_id', v_assignment, 'responder_person_id', v_responder,
    'state', 'offered', 'expires_at', v_expires);
end;
$$;

-- 4. Urgent incident initiation and first responder offer.
create or replace function public.create_urgent_incident_offer(
  p_family_id uuid,
  p_subject_person_id uuid,
  p_severity text,
  p_offer_timeout_minutes integer default 3
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_incident_id uuid; v_timeout integer;
begin
  if p_family_id is null or p_subject_person_id is null
     or not exists (select 1 from public.people where family_id = p_family_id and id = p_subject_person_id) then
    raise exception 'invalid_subject_person' using errcode = '42501';
  end if;
  if p_severity is null or p_severity not in ('routine', 'urgent', 'critical') then
    raise exception 'invalid_severity' using errcode = '22023';
  end if;
  v_timeout := coalesce(p_offer_timeout_minutes, 3);
  if v_timeout not between 1 and 60 then v_timeout := 3; end if;

  insert into public.incidents (family_id, person_id, severity, state)
    values (p_family_id, p_subject_person_id, p_severity, 'open')
    returning id into v_incident_id;
  return sahaj_private.offer_next_responder(p_family_id, v_incident_id, p_subject_person_id, v_timeout);
end;
$$;

-- 5. Decline or timeout of the current offer: mark it, then offer the next member (or escalate).
-- 'expired' is refused before the offer's own expiry, so a worker clock cannot cut an offer short.
-- Replays on an assignment that is no longer offered change nothing and report the incident's current state.
create or replace function public.advance_urgent_offer(
  p_family_id uuid,
  p_incident_id uuid,
  p_assignment_id uuid,
  p_reason text,
  p_offer_timeout_minutes integer default 3
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_incident public.incidents%rowtype; v_assignment public.assignments%rowtype; v_timeout integer; v_open uuid;
begin
  if p_reason is null or p_reason not in ('declined', 'expired') then
    raise exception 'invalid_advance_reason' using errcode = '22023';
  end if;
  select * into v_incident from public.incidents where family_id = p_family_id and id = p_incident_id for update;
  if not found then raise exception 'incident_not_found' using errcode = 'P0002'; end if;
  select * into v_assignment from public.assignments
    where family_id = p_family_id and id = p_assignment_id and incident_id = p_incident_id for update;
  if not found then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;

  if v_assignment.status <> 'offered' or v_incident.state not in ('offered', 'reopened') then
    select a.id into v_open from public.assignments a
      where a.family_id = p_family_id and a.incident_id = p_incident_id and a.status = 'offered'
      order by a.offered_at desc limit 1;
    return jsonb_build_object('incident_id', p_incident_id, 'state', v_incident.state, 'assignment_id', v_open, 'noop', true);
  end if;
  if p_reason = 'expired' and v_assignment.expires_at > clock_timestamp() then
    raise exception 'offer_not_expired' using errcode = '55000';
  end if;

  update public.assignments set status = p_reason where id = v_assignment.id;
  v_timeout := coalesce(p_offer_timeout_minutes, 3);
  if v_timeout not between 1 and 60 then v_timeout := 3; end if;
  return sahaj_private.offer_next_responder(p_family_id, p_incident_id, v_incident.person_id, v_timeout)
    || jsonb_build_object('previous_assignment_id', v_assignment.id, 'previous_status', p_reason);
end;
$$;

-- 6. Offers past their expiry on still-offered incidents, for the timeout sweep. Read-only; the sweep calls
-- advance_urgent_offer(..., 'expired') per row, which re-checks everything under the row locks.
create or replace function public.list_expired_urgent_offers(p_limit integer default 25)
returns table(family_id uuid, incident_id uuid, assignment_id uuid)
language sql stable security definer set search_path='' as $$
  select a.family_id, a.incident_id, a.id
  from public.assignments a join public.incidents i on i.family_id = a.family_id and i.id = a.incident_id
  where a.status = 'offered' and a.expires_at <= clock_timestamp() and i.state in ('offered', 'reopened')
  order by a.expires_at
  limit least(greatest(coalesce(p_limit, 25), 1), 100);
$$;

-- 7. Verified responder acceptance. Acceptance only comes from Phase 2's normalized `responder.accepted` proof (built by
-- record_responder_acceptance from a signature-verified Twilio Gather press), consumed by accept_assignment_verified,
-- which re-derives call, ledger, binding, request and account from stored rows. This function adds the incident
-- transition and refuses proof that names another incident, assignment or responder.
create or replace function public.accept_responder_assignment_verified(
  p_family_id uuid,
  p_incident_id uuid,
  p_assignment_id uuid,
  p_responder_person_id uuid,
  p_raw_event_id uuid,
  p_promise_minutes integer default 15
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_incident public.incidents%rowtype;
  v_assignment public.assignments%rowtype;
  v_event public.raw_events%rowtype;
  v_promised_at timestamptz;
  v_promise_min integer;
begin
  select * into v_incident from public.incidents where family_id = p_family_id and id = p_incident_id for update;
  if not found then raise exception 'incident_not_found' using errcode = 'P0002'; end if;

  select * into v_assignment from public.assignments
    where family_id = p_family_id and id = p_assignment_id and incident_id = p_incident_id;
  if not found then raise exception 'assignment_not_found' using errcode = 'P0002'; end if;
  if v_assignment.person_id <> p_responder_person_id then raise exception 'wrong_responder' using errcode = '42501'; end if;
  if v_assignment.person_id = v_incident.person_id then raise exception 'subject_cannot_be_responder' using errcode = '42501'; end if;

  -- Idempotent replay: the same proof already accepted this assignment and the incident is owned by this responder.
  if v_assignment.status = 'accepted' and v_assignment.verified_by_provider_event = p_raw_event_id
     and v_incident.state = 'accepted' and v_incident.owner_person_id = p_responder_person_id then
    return jsonb_build_object('incident_id', p_incident_id, 'assignment_id', p_assignment_id,
      'responder_person_id', p_responder_person_id, 'state', 'accepted', 'promised_at', v_incident.promised_at, 'replayed', true);
  end if;

  if v_incident.state not in ('offered', 'reopened') then raise exception 'incident_not_offered' using errcode = '42501'; end if;
  if v_assignment.status <> 'offered' then raise exception 'assignment_not_offered' using errcode = '42501'; end if;

  select * into v_event from public.raw_events where id = p_raw_event_id and family_id = p_family_id;
  if not found then raise exception 'unverified_event_missing' using errcode = 'P0002'; end if;
  if v_event.event_type <> 'responder.accepted' or not v_event.normalized_proof
     or v_event.metadata->>'incident_id' is distinct from p_incident_id::text
     or v_event.metadata->>'assignment_id' is distinct from p_assignment_id::text
     or v_event.metadata->>'responder_person_id' is distinct from p_responder_person_id::text then
    raise exception 'invalid_acceptance_proof' using errcode = '42501';
  end if;
  if not public.accept_assignment_verified(p_family_id, p_assignment_id, p_raw_event_id) then
    raise exception 'invalid_acceptance_proof' using errcode = '42501';
  end if;

  v_promise_min := coalesce(p_promise_minutes, 15);
  if v_promise_min not between 1 and 240 then v_promise_min := 15; end if;
  v_promised_at := clock_timestamp() + (v_promise_min * interval '1 minute');
  update public.incidents set state = 'accepted', owner_person_id = p_responder_person_id, promised_at = v_promised_at
    where id = p_incident_id and family_id = p_family_id;
  return jsonb_build_object('incident_id', p_incident_id, 'assignment_id', p_assignment_id,
    'responder_person_id', p_responder_person_id, 'state', 'accepted', 'promised_at', v_promised_at);
end;
$$;

-- 8. Medicine dose recording. Unknown inventory (null) stays unknown except for an explicit count reconciliation.
create or replace function public.record_medicine_dose(
  p_family_id uuid,
  p_medicine_id uuid,
  p_person_id uuid,
  p_action_type text,
  p_count integer default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_med public.medicines%rowtype; v_count_taken integer; v_new_remaining integer;
begin
  select * into v_med from public.medicines
    where family_id = p_family_id and id = p_medicine_id and person_id = p_person_id for update;
  if not found then raise exception 'medicine_not_found' using errcode = 'P0002'; end if;

  if p_action_type = 'confirmed_dose' then
    v_count_taken := coalesce(p_count, 1);
    if v_count_taken <= 0 or v_count_taken > 100 then raise exception 'invalid_dose_count' using errcode = '22023'; end if;
    v_new_remaining := case when v_med.remaining_count is null then null else greatest(0, v_med.remaining_count - v_count_taken) end;
  elsif p_action_type = 'missed_dose' then
    if p_count is not null then raise exception 'invalid_dose_count' using errcode = '22023'; end if;
    v_new_remaining := v_med.remaining_count;
  elsif p_action_type = 'double_dose_reported' then
    v_count_taken := coalesce(p_count, 2);
    if v_count_taken < 2 or v_count_taken > 100 then raise exception 'invalid_dose_count' using errcode = '22023'; end if;
    v_new_remaining := case when v_med.remaining_count is null then null else greatest(0, v_med.remaining_count - v_count_taken) end;
  elsif p_action_type = 'count_reconciliation' then
    if p_count is null or p_count < 0 or p_count > 10000 then
      raise exception 'invalid_reconciliation_count' using errcode = '22023';
    end if;
    v_new_remaining := p_count;
  else
    raise exception 'unsupported_dose_action' using errcode = '22023';
  end if;

  update public.medicines set remaining_count = v_new_remaining where id = p_medicine_id and family_id = p_family_id;
  return jsonb_build_object(
    'medicine_id', p_medicine_id,
    'action_type', p_action_type,
    'remaining_count', v_new_remaining,
    'refill_threshold', v_med.refill_threshold,
    'is_low_stock', coalesce(v_new_remaining <= v_med.refill_threshold, false),
    'instructions_confirmed_by_person', v_med.instructions_confirmed_by_person
  );
end;
$$;

-- 9. Two-way family voice post. The recording must be a real uploaded object in the private sahaj-voice bucket under
-- `<family>/voice/<segment>.<audio ext>`, and the sender's NEWEST consent for `voice_share:<recipient>` must be the given
-- affirmative row (a later refusal revokes it). A reply must answer a post sent by the current recipient to the sender.
create or replace function public.create_family_voice_post(
  p_family_id uuid,
  p_sender_id uuid,
  p_recipient_id uuid,
  p_object_path text,
  p_consent_id uuid,
  p_reply_to uuid default null,
  p_retention_days integer default 30
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_voice_post_id uuid; v_consent public.consents%rowtype; v_current timestamptz; v_expires_at timestamptz;
  v_retention integer; v_parent public.voice_posts%rowtype;
begin
  if p_sender_id is null or p_recipient_id is null or p_sender_id = p_recipient_id then
    raise exception 'sender_equals_recipient' using errcode = '42501';
  end if;
  if not sahaj_private.person_in_family(p_family_id, p_sender_id) or not sahaj_private.person_in_family(p_family_id, p_recipient_id) then
    raise exception 'person_not_in_family' using errcode = '42501';
  end if;
  -- Same rule as apps/api/src/lib/media/paths.ts: fixed prefix, strict segment charset, audio extension. No `..`, `%`, `:`.
  if p_object_path is null or length(p_object_path) > 512
     or p_object_path !~ ('^' || p_family_id::text || '/voice/([A-Za-z0-9][A-Za-z0-9._-]{0,127}/){0,3}[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(mp3|wav|ogg|m4a|mp4)$')
     or p_object_path like '%..%' then
    raise exception 'invalid_voice_object_path' using errcode = '42501';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'sahaj-voice' and o.name = p_object_path) then
    raise exception 'voice_object_missing' using errcode = '42501';
  end if;
  if exists (select 1 from sahaj_private.voice_content v where v.family_id = p_family_id and v.object_path = p_object_path) then
    raise exception 'voice_object_already_posted' using errcode = '23505';
  end if;

  perform sahaj_private.lock_family_authorization(p_family_id);
  select * into v_consent from public.consents
    where family_id = p_family_id and id = p_consent_id and person_id = p_sender_id;
  if not found then raise exception 'consent_not_found' using errcode = 'P0002'; end if;
  if v_consent.purpose <> ('voice_share:' || p_recipient_id::text) then
    raise exception 'consent_purpose_mismatch' using errcode = '42501';
  end if;
  v_current := sahaj_private.consent_current(p_family_id, p_sender_id, v_consent.purpose);
  if v_consent.answer is not true or v_current is null or v_current <> v_consent.created_at then
    raise exception 'consent_not_effective' using errcode = '42501';
  end if;

  if p_reply_to is not null then
    select * into v_parent from public.voice_posts where family_id = p_family_id and id = p_reply_to;
    if not found or v_parent.sender_id <> p_recipient_id or v_parent.recipient_id <> p_sender_id then
      raise exception 'invalid_reply_target' using errcode = '42501';
    end if;
  end if;

  v_retention := coalesce(p_retention_days, 30);
  if v_retention not between 1 and 365 then v_retention := 30; end if;
  v_expires_at := clock_timestamp() + (v_retention * interval '1 day');

  insert into public.voice_posts (family_id, sender_id, recipient_id, reply_to, consent_id, state)
    values (p_family_id, p_sender_id, p_recipient_id, p_reply_to, p_consent_id, 'queued')
    returning id into v_voice_post_id;
  insert into sahaj_private.voice_content (family_id, voice_post_id, object_path, expires_at)
    values (p_family_id, v_voice_post_id, p_object_path, v_expires_at);

  return jsonb_build_object('voice_post_id', v_voice_post_id, 'sender_id', p_sender_id, 'recipient_id', p_recipient_id,
    'state', 'queued', 'expires_at', v_expires_at);
end;
$$;

-- Privileges: service role only. Functions are executable by PUBLIC by default, so revoke first.
revoke all on function sahaj_private.is_family_member_with_role(uuid, text[]) from public, anon;
grant execute on function sahaj_private.is_family_member_with_role(uuid, text[]) to authenticated, service_role;
revoke all on function sahaj_private.next_circle_responder(uuid, uuid, uuid),
  sahaj_private.offer_next_responder(uuid, uuid, uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.create_urgent_incident_offer(uuid, uuid, text, integer),
  public.advance_urgent_offer(uuid, uuid, uuid, text, integer),
  public.list_expired_urgent_offers(integer),
  public.accept_responder_assignment_verified(uuid, uuid, uuid, uuid, uuid, integer),
  public.record_medicine_dose(uuid, uuid, uuid, text, integer),
  public.create_family_voice_post(uuid, uuid, uuid, text, uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.create_urgent_incident_offer(uuid, uuid, text, integer),
  public.advance_urgent_offer(uuid, uuid, uuid, text, integer),
  public.list_expired_urgent_offers(integer),
  public.accept_responder_assignment_verified(uuid, uuid, uuid, uuid, uuid, integer),
  public.record_medicine_dose(uuid, uuid, uuid, text, integer),
  public.create_family_voice_post(uuid, uuid, uuid, text, uuid, uuid, integer)
  to service_role;
