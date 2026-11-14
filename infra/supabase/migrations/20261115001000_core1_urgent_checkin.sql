-- AGY-W3: Core 1 Urgent Help Escalation & Daily Check-in Wiring
-- Preserves 20261114220000_phase4_core1.sql untouched (fixing create_urgent_incident_offer via create or replace
-- because public.circle has consent_at / revoked_at and does NOT have an "active" column).

-- 1. create_urgent_incident_offer: no override. 20261114220000_phase4_core1.sql (K-INT2) already has the
--    runnable version, and it picks responders via sahaj_private.next_circle_responder (approved + consenting +
--    unrevoked, not the subject, not already offered). K-GATE: the override here dropped the approved_at check.

-- 2. Scaled urgent offer initiator (seconds precision for DEMO_TIMER_SCALE)
create or replace function public.create_urgent_incident_offer_scaled(
  p_family_id uuid,
  p_subject_person_id uuid,
  p_severity text,
  p_offer_timeout_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_incident_id uuid;
  v_assignment_id uuid;
  v_responder_person_id uuid;
  v_expires_at timestamptz;
  v_seconds integer;
begin
  if not exists (select 1 from public.people where family_id = p_family_id and id = p_subject_person_id) then
    raise exception 'invalid_subject_person' using errcode = '42501';
  end if;

  if p_severity is null or p_severity not in ('routine', 'urgent', 'critical') then
    raise exception 'invalid_severity' using errcode = '22023';
  end if;

  v_seconds := greatest(1, least(coalesce(p_offer_timeout_seconds, 180), 86400));

  insert into public.incidents (family_id, person_id, severity, state)
  values (p_family_id, p_subject_person_id, p_severity, 'open')
  returning id into v_incident_id;

  -- Same eligibility as the minute-based offer (approved, consenting, unrevoked, not the subject).
  v_responder_person_id := sahaj_private.next_circle_responder(p_family_id, v_incident_id, p_subject_person_id);

  if v_responder_person_id is null then
    update public.incidents set state = 'escalated' where id = v_incident_id;
    return jsonb_build_object(
      'incident_id', v_incident_id,
      'state', 'escalated',
      'reason', 'no_available_circle_members'
    );
  end if;

  v_expires_at := clock_timestamp() + make_interval(secs => v_seconds);

  insert into public.assignments (family_id, incident_id, person_id, status, expires_at)
  values (p_family_id, v_incident_id, v_responder_person_id, 'offered', v_expires_at)
  returning id into v_assignment_id;

  update public.incidents set state = 'offered' where id = v_incident_id;

  return jsonb_build_object(
    'incident_id', v_incident_id,
    'assignment_id', v_assignment_id,
    'responder_person_id', v_responder_person_id,
    'state', 'offered',
    'expires_at', v_expires_at
  );
end;
$$;

revoke all on function public.create_urgent_incident_offer_scaled(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.create_urgent_incident_offer_scaled(uuid, uuid, text, integer) to service_role;

-- 3. Advance urgent offer on decline or timeout to next ranked circle member, or escalate when exhausted
create or replace function public.advance_urgent_incident_offer(
  p_family_id uuid,
  p_incident_id uuid,
  p_assignment_id uuid,
  p_reason text,
  p_offer_timeout_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_incident public.incidents%rowtype;
  v_assignment public.assignments%rowtype;
  v_next_responder uuid;
  v_next_assignment_id uuid;
  v_expires_at timestamptz;
  v_seconds integer;
  v_new_status text;
begin
  if p_reason not in ('declined', 'expired') then
    raise exception 'invalid_advance_reason' using errcode = '22023';
  end if;

  select * into v_incident
  from public.incidents
  where family_id = p_family_id and id = p_incident_id
  for update;

  if not found then
    return jsonb_build_object('status', 'incident_not_found');
  end if;

  if v_incident.state in ('accepted', 'escalated', 'closed', 'done') then
    return jsonb_build_object('status', 'already_terminal', 'state', v_incident.state);
  end if;

  select * into v_assignment
  from public.assignments
  where family_id = p_family_id and incident_id = p_incident_id and id = p_assignment_id
  for update;

  if not found or v_assignment.status <> 'offered' then
    return jsonb_build_object(
      'status', 'assignment_not_offered',
      'assignment_status', coalesce(v_assignment.status, 'missing')
    );
  end if;

  if p_reason = 'expired' and v_assignment.expires_at > clock_timestamp() then
    return jsonb_build_object('status', 'not_yet_expired', 'expires_at', v_assignment.expires_at);
  end if;

  v_new_status := case when p_reason = 'declined' then 'declined' else 'expired' end;

  update public.assignments
  set status = v_new_status
  where id = v_assignment.id;

  -- Same eligibility as the first offer; members already offered on this incident are skipped.
  v_next_responder := sahaj_private.next_circle_responder(p_family_id, p_incident_id, v_incident.person_id);

  if v_next_responder is null then
    update public.incidents
    set state = 'escalated'
    where id = v_incident.id;

    return jsonb_build_object(
      'status', 'escalated',
      'incident_id', v_incident.id,
      'previous_assignment_id', v_assignment.id,
      'previous_responder_id', v_assignment.person_id,
      'state', 'escalated'
    );
  end if;

  v_seconds := greatest(1, least(coalesce(p_offer_timeout_seconds, 180), 86400));
  v_expires_at := clock_timestamp() + make_interval(secs => v_seconds);

  insert into public.assignments (family_id, incident_id, person_id, status, expires_at)
  values (p_family_id, p_incident_id, v_next_responder, 'offered', v_expires_at)
  returning id into v_next_assignment_id;

  update public.incidents
  set state = 'offered'
  where id = v_incident.id;

  return jsonb_build_object(
    'status', 'offered',
    'incident_id', v_incident.id,
    'previous_assignment_id', v_assignment.id,
    'previous_responder_id', v_assignment.person_id,
    'assignment_id', v_next_assignment_id,
    'responder_person_id', v_next_responder,
    'expires_at', v_expires_at,
    'state', 'offered'
  );
end;
$$;

revoke all on function public.advance_urgent_incident_offer(uuid, uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.advance_urgent_incident_offer(uuid, uuid, uuid, text, integer) to service_role;

-- 4. Synchronize parent incident when Phase 2 accept_assignment_verified accepts an assignment
create or replace function sahaj_private.sync_incident_on_assignment_accepted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'accepted'
     and old.status = 'offered'
     and new.verified_by_provider_event is not null then
    update public.incidents
    set state = 'accepted',
        owner_person_id = coalesce(owner_person_id, new.person_id),
        promised_at = coalesce(promised_at, clock_timestamp() + interval '4 minutes')
    where id = new.incident_id
      and family_id = new.family_id
      and state in ('open', 'offered');
  end if;
  return new;
end;
$$;

revoke all on function sahaj_private.sync_incident_on_assignment_accepted() from public, anon, authenticated, service_role;

drop trigger if exists trg_assignments_sync_incident on public.assignments;
create trigger trg_assignments_sync_incident
  after update of status on public.assignments
  for each row
  execute function sahaj_private.sync_incident_on_assignment_accepted();

-- 5. Atomic Phase 2/3 dispatch preparation for Core 1 urgent_responder & check_in
create or replace function public.prepare_urgent_responder_dispatch(
  p_family_id uuid,
  p_incident_id uuid,
  p_assignment_id uuid,
  p_subject_person_id uuid,
  p_responder_person_id uuid,
  p_dedupe_key text,
  p_payload_ciphertext text,
  p_payload_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.outbox%rowtype;
  v_binding public.dispatch_bindings%rowtype;
  v_perm public.permissions%rowtype;
  v_asg public.assignments%rowtype;
  v_inc public.incidents%rowtype;
  v_req_id uuid;
  v_outbox_id uuid;
  v_call_id uuid;
  v_t timestamptz := clock_timestamp();
begin
  if p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_payload_hash' using errcode = '22023';
  end if;

  select * into v_existing
  from public.outbox
  where family_id = p_family_id and dedupe_key = p_dedupe_key;

  if v_existing.id is not null then
    select * into v_binding from public.dispatch_bindings where outbox_id = v_existing.id and family_id = p_family_id;
    return jsonb_build_object(
      'status', 'existing',
      'outbox_id', v_existing.id,
      'call_id', v_binding.call_id,
      'action_request_id', v_existing.action_request_id
    );
  end if;

  perform 1 from public.incidents where id = p_incident_id and family_id = p_family_id and person_id = p_subject_person_id;
  if not found then
    return jsonb_build_object('status', 'denied', 'reason', 'incident_not_found');
  end if;

  select * into v_inc from public.incidents where id = p_incident_id and family_id = p_family_id;
  select * into v_asg from public.assignments
  where id = p_assignment_id and family_id = p_family_id and incident_id = p_incident_id
    and person_id = p_responder_person_id and status = 'offered' and expires_at > v_t;
  if v_asg.id is null or v_asg.person_id = v_inc.person_id then
    return jsonb_build_object('status', 'denied', 'reason', 'assignment_not_offered');
  end if;

  select * into v_perm
  from public.permissions q
  where q.family_id = p_family_id
    and q.person_id = p_subject_person_id
    and q.principal_id is not null
    and q.action = 'urgent_responder'
    and q.decision = 'allow'
    and q.revoked_at is null
    and q.two_person_required = false
    and v_t >= q.valid_from and v_t < q.expires_at
    and v_t >= q.period_start and v_t < q.period_end
    and q.used_count < q.max_uses
    and p_subject_person_id::text = any(q.target_ids)
    and exists (
      select 1 from public.atlas_principals ap
      where ap.family_id = p_family_id and ap.id = q.principal_id and ap.revoked_at is null
    )
  order by q.created_at asc, q.id asc
  limit 1
  for update;

  if v_perm.id is null then
    return jsonb_build_object('status', 'denied', 'reason', 'no_permission');
  end if;

  if exists (
    select 1 from public.permissions q
    where q.family_id = p_family_id
      and q.principal_id is not distinct from v_perm.principal_id
      and q.person_id = p_subject_person_id
      and q.action = 'urgent_responder'
      and q.decision = 'deny'
      and q.revoked_at is null
      and v_t >= q.valid_from and v_t < q.expires_at
  ) then
    return jsonb_build_object('status', 'denied', 'reason', 'permission_denied');
  end if;

  update public.permissions
  set used_count = used_count + 1
  where id = v_perm.id and used_count < max_uses;
  if not found then
    return jsonb_build_object('status', 'denied', 'reason', 'limits_exceeded');
  end if;

  insert into public.action_requests (
    family_id, person_id, permission_id, principal_id, action, target_id,
    amount_minor, item_ids, request_fingerprint, status, expires_at,
    two_person_required, consumed_at
  ) values (
    p_family_id, p_subject_person_id, v_perm.id, v_perm.principal_id, 'urgent_responder', p_subject_person_id::text,
    0, '{}', p_payload_hash, 'executed', greatest(v_asg.expires_at, v_t + interval '5 minutes'),
    false, v_t
  ) returning id into v_req_id;

  insert into public.outbox (
    family_id, action_request_id, permission_id, kind, action, incident_id,
    dedupe_key, payload_ciphertext, payload_hash, status
  ) values (
    p_family_id, v_req_id, v_perm.id, 'urgent_responder', 'urgent_responder', p_incident_id,
    p_dedupe_key, p_payload_ciphertext, p_payload_hash, 'pending'
  ) returning id into v_outbox_id;

  insert into public.calls (family_id, person_id, provider, status)
  values (p_family_id, p_responder_person_id, 'twilio', 'scheduled')
  returning id into v_call_id;

  perform public.bind_outbox_dispatch(
    p_family_id, v_outbox_id, p_responder_person_id, 'twilio', 'twilio.create_call',
    v_call_id, p_incident_id, p_assignment_id
  );

  return jsonb_build_object(
    'status', 'ready',
    'outbox_id', v_outbox_id,
    'call_id', v_call_id,
    'action_request_id', v_req_id
  );
end;
$$;

revoke all on function public.prepare_urgent_responder_dispatch(uuid, uuid, uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.prepare_urgent_responder_dispatch(uuid, uuid, uuid, uuid, uuid, text, text, text) to service_role;

create or replace function public.prepare_checkin_dispatch(
  p_family_id uuid,
  p_person_id uuid,
  p_dedupe_key text,
  p_payload_ciphertext text,
  p_payload_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.outbox%rowtype;
  v_binding public.dispatch_bindings%rowtype;
  v_perm public.permissions%rowtype;
  v_req_id uuid;
  v_outbox_id uuid;
  v_call_id uuid;
  v_t timestamptz := clock_timestamp();
begin
  if p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_payload_hash' using errcode = '22023';
  end if;

  select * into v_existing
  from public.outbox
  where family_id = p_family_id and dedupe_key = p_dedupe_key;

  if v_existing.id is not null then
    select * into v_binding from public.dispatch_bindings where outbox_id = v_existing.id and family_id = p_family_id;
    return jsonb_build_object(
      'status', 'existing',
      'outbox_id', v_existing.id,
      'call_id', v_binding.call_id,
      'action_request_id', v_existing.action_request_id
    );
  end if;

  select * into v_perm
  from public.permissions q
  where q.family_id = p_family_id
    and q.person_id = p_person_id
    and q.principal_id is not null
    and q.action = 'check_in'
    and q.decision = 'allow'
    and q.revoked_at is null
    and q.two_person_required = false
    and v_t >= q.valid_from and v_t < q.expires_at
    and v_t >= q.period_start and v_t < q.period_end
    and q.used_count < q.max_uses
    and p_person_id::text = any(q.target_ids)
    and exists (
      select 1 from public.atlas_principals ap
      where ap.family_id = p_family_id and ap.id = q.principal_id and ap.revoked_at is null
    )
  order by q.created_at asc, q.id asc
  limit 1
  for update;

  if v_perm.id is null then
    return jsonb_build_object('status', 'denied', 'reason', 'no_permission');
  end if;

  if exists (
    select 1 from public.permissions q
    where q.family_id = p_family_id
      and q.principal_id is not distinct from v_perm.principal_id
      and q.person_id = p_person_id
      and q.action = 'check_in'
      and q.decision = 'deny'
      and q.revoked_at is null
      and v_t >= q.valid_from and v_t < q.expires_at
  ) then
    return jsonb_build_object('status', 'denied', 'reason', 'permission_denied');
  end if;

  update public.permissions
  set used_count = used_count + 1
  where id = v_perm.id and used_count < max_uses;
  if not found then
    return jsonb_build_object('status', 'denied', 'reason', 'limits_exceeded');
  end if;

  insert into public.action_requests (
    family_id, person_id, permission_id, principal_id, action, target_id,
    amount_minor, item_ids, request_fingerprint, status, expires_at,
    two_person_required, consumed_at
  ) values (
    p_family_id, p_person_id, v_perm.id, v_perm.principal_id, 'check_in', p_person_id::text,
    0, '{}', p_payload_hash, 'executed', v_t + interval '30 minutes',
    false, v_t
  ) returning id into v_req_id;

  insert into public.outbox (
    family_id, action_request_id, permission_id, kind, action,
    dedupe_key, payload_ciphertext, payload_hash, status
  ) values (
    p_family_id, v_req_id, v_perm.id, 'check_in', 'check_in',
    p_dedupe_key, p_payload_ciphertext, p_payload_hash, 'pending'
  ) returning id into v_outbox_id;

  insert into public.calls (family_id, person_id, provider, status)
  values (p_family_id, p_person_id, 'sarvam', 'scheduled')
  returning id into v_call_id;

  perform public.bind_outbox_dispatch(
    p_family_id, v_outbox_id, p_person_id, 'sarvam', 'sarvam.outbound_call',
    v_call_id, null, null
  );

  return jsonb_build_object(
    'status', 'ready',
    'outbox_id', v_outbox_id,
    'call_id', v_call_id,
    'action_request_id', v_req_id
  );
end;
$$;

revoke all on function public.prepare_checkin_dispatch(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.prepare_checkin_dispatch(uuid, uuid, text, text, text) to service_role;

-- 6. Check-in summary rows for "Maa's day" (strictly redacted: no 4+ digit runs)
create table if not exists public.check_in_summaries (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  person_id uuid not null,
  call_id uuid unique,
  schedule_id uuid,
  raw_event_id uuid references public.raw_events(id),
  local_date date not null,
  attempt_number integer not null default 1 check (attempt_number between 1 and 5),
  outcome text not null check (outcome in ('answered', 'no_answer', 'busy', 'failed', 'escalated')),
  short_summary text not null check (char_length(short_summary) between 1 and 300 and short_summary !~ '[0-9]{4,}'),
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  foreign key (family_id, person_id) references public.people(family_id, id),
  foreign key (family_id, call_id) references public.calls(family_id, id),
  foreign key (family_id, schedule_id) references public.schedules(family_id, id),
  unique (family_id, dedupe_key)
);

create index if not exists check_in_summaries_family_date_idx
  on public.check_in_summaries (family_id, person_id, local_date desc, created_at desc);

alter table public.check_in_summaries enable row level security;
revoke all on public.check_in_summaries from public, anon;
grant select on public.check_in_summaries to authenticated;
grant all on public.check_in_summaries to service_role;

drop policy if exists check_in_summaries_family_select on public.check_in_summaries;
create policy check_in_summaries_family_select
  on public.check_in_summaries
  for select
  to authenticated
  using (
    sahaj_private.is_family_member_with_role(family_id, array['parent', 'child'])
  );

