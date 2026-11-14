-- Phase 5 Core 2 Extension: Sequential Late-Watch Escalation, Single-Owner Incident Accept/Decline, and Truth Line Support.
-- Additive migration extending 20261114230000_phase5_core2.sql; preserves existing tables and RPCs.

create table public.core2_incident_escalations (
  incident_id uuid primary key,
  family_id uuid not null references public.families(id) on delete cascade,
  subject_person_id uuid not null,
  watch_id uuid,
  sos_id uuid,
  current_assignment_id uuid,
  current_contact_id uuid,
  offer_expires_at timestamptz,
  exhausted_at timestamptz,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (family_id, incident_id) references public.incidents(family_id, id) on delete cascade,
  foreign key (family_id, subject_person_id) references public.people(family_id, id),
  foreign key (family_id, watch_id) references public.core2_watches(family_id, id),
  foreign key (family_id, sos_id) references public.core2_sos_events(family_id, id),
  foreign key (family_id, current_assignment_id) references public.assignments(family_id, id),
  foreign key (family_id, current_contact_id) references public.core2_trusted_contacts(family_id, id)
);

create index core2_incident_escalations_due_idx
  on public.core2_incident_escalations (offer_expires_at)
  where offer_expires_at is not null and exhausted_at is null;

alter table public.core2_incident_escalations enable row level security;

revoke all on public.core2_incident_escalations from public, anon, authenticated;
grant all on public.core2_incident_escalations to service_role;
grant select (
  incident_id, family_id, subject_person_id, watch_id, sos_id,
  offer_expires_at, exhausted_at, version, updated_at
) on public.core2_incident_escalations to authenticated;

create policy core2_incident_escalations_read on public.core2_incident_escalations
  for select to authenticated
  using (sahaj_private.is_person(family_id, subject_person_id));

-- Sequentially offer an incident to the next highest-ranked approved trusted contact.
-- Re-running before offer_expires_at returns the existing valid offer idempotently (no duplicate outbox).
create function public.core2_offer_next_trusted_contact(
  p_family_id uuid,
  p_incident_id uuid,
  p_scope text default 'watch_escalation',
  p_offer_expires_at timestamptz default null,
  p_now timestamptz default null
) returns table (
  assignment_id uuid,
  trusted_contact_id uuid,
  contact_person_id uuid,
  rank integer,
  offered_at timestamptz,
  expires_at timestamptz,
  newly_created boolean,
  exhausted boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  now_ts timestamptz := coalesce(p_now, pg_catalog.clock_timestamp());
  exp_ts timestamptz := coalesce(p_offer_expires_at, now_ts + interval '2 minutes');
  inc public.incidents;
  existing_asg public.assignments;
  existing_tc public.core2_trusted_contacts;
  next_tc public.core2_trusted_contacts;
  new_asg public.assignments;
  linked_watch public.core2_watches;
  linked_sos public.core2_sos_events;
begin
  if p_scope not in ('sos', 'watch_escalation') then
    raise exception 'invalid_scope' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('core2:incident:' || p_incident_id::text, 0)
  );

  select * into inc
  from public.incidents i
  where i.id = p_incident_id and i.family_id = p_family_id
  for update;

  if inc.id is null then
    raise exception 'incident_not_found' using errcode = 'P0002';
  end if;

  if inc.state in ('accepted', 'done', 'closed', 'heard') or inc.owner_person_id is not null then
    return;
  end if;

  select * into linked_watch
  from public.core2_watches w
  where w.family_id = p_family_id and w.incident_id = p_incident_id
  limit 1;

  if linked_watch.id is not null and linked_watch.state in ('safe', 'cancelled') then
    return;
  end if;

  select * into linked_sos
  from public.core2_sos_events s
  where s.family_id = p_family_id and s.incident_id = p_incident_id
  limit 1;

  -- Check if there is already a live, non-expired offered assignment for an active non-revoked contact.
  select * into existing_asg
  from public.assignments a
  where a.family_id = p_family_id
    and a.incident_id = p_incident_id
    and a.status = 'offered'
  order by a.offered_at desc
  limit 1
  for update;

  if existing_asg.id is not null then
    select * into existing_tc
    from public.core2_trusted_contacts c
    where c.family_id = p_family_id
      and c.subject_person_id = inc.person_id
      and c.contact_person_id = existing_asg.person_id
      and c.state = 'active'
      and c.revoked_at is null
      and p_scope = any(c.scopes)
      and c.effective_from <= now_ts
      and (c.effective_until is null or c.effective_until > now_ts)
    limit 1;

    if existing_tc.id is not null and existing_asg.expires_at > now_ts then
      assignment_id := existing_asg.id;
      trusted_contact_id := existing_tc.id;
      contact_person_id := existing_asg.person_id;
      rank := existing_tc.rank;
      offered_at := existing_asg.offered_at;
      expires_at := existing_asg.expires_at;
      newly_created := false;
      exhausted := false;
      return next;
      return;
    end if;

    -- Previous offer expired or contact was revoked/expired -> close stale offer & rotate.
    update public.assignments set status = 'expired'
    where id = existing_asg.id and family_id = p_family_id and status = 'offered';
  end if;

  -- Pick highest-ranked active, in-date contact not yet tried for this incident.
  select c.* into next_tc
  from public.core2_trusted_contacts c
  where c.family_id = p_family_id
    and c.subject_person_id = inc.person_id
    and c.state = 'active'
    and c.revoked_at is null
    and p_scope = any(c.scopes)
    and c.effective_from <= now_ts
    and (c.effective_until is null or c.effective_until > now_ts)
    and not exists (
      select 1
      from public.assignments prev
      where prev.family_id = p_family_id
        and prev.incident_id = p_incident_id
        and prev.person_id = c.contact_person_id
    )
  order by c.rank asc, c.id asc
  limit 1;

  if next_tc.id is null then
    update public.core2_incident_escalations esc set
      current_assignment_id = null,
      current_contact_id = null,
      offer_expires_at = null,
      exhausted_at = coalesce(esc.exhausted_at, now_ts),
      version = esc.version + 1,
      updated_at = now_ts
    where esc.incident_id = p_incident_id and esc.family_id = p_family_id;

    insert into public.core2_incident_escalations (
      incident_id, family_id, subject_person_id, watch_id, sos_id,
      exhausted_at, created_at, updated_at
    ) values (
      p_incident_id, p_family_id, inc.person_id, linked_watch.id, linked_sos.id,
      now_ts, now_ts, now_ts
    )
    on conflict (incident_id) do nothing;

    update public.incidents i set state = 'escalated'
    where i.id = p_incident_id and i.family_id = p_family_id and i.state in ('open', 'offered');

    assignment_id := null;
    trusted_contact_id := null;
    contact_person_id := null;
    rank := null;
    offered_at := null;
    expires_at := null;
    newly_created := false;
    exhausted := true;
    return next;
    return;
  end if;

  insert into public.assignments (
    family_id, incident_id, person_id, status, offered_at, expires_at
  ) values (
    p_family_id, p_incident_id, next_tc.contact_person_id, 'offered', now_ts, exp_ts
  )
  returning * into new_asg;

  update public.incidents set state = 'offered'
  where id = p_incident_id and family_id = p_family_id and state in ('open', 'escalated', 'offered');

  insert into public.core2_incident_escalations (
    incident_id, family_id, subject_person_id, watch_id, sos_id,
    current_assignment_id, current_contact_id, offer_expires_at, exhausted_at,
    created_at, updated_at
  ) values (
    p_incident_id, p_family_id, inc.person_id, linked_watch.id, linked_sos.id,
    new_asg.id, next_tc.id, exp_ts, null, now_ts, now_ts
  )
  on conflict (incident_id) do update set
    current_assignment_id = excluded.current_assignment_id,
    current_contact_id = excluded.current_contact_id,
    offer_expires_at = excluded.offer_expires_at,
    exhausted_at = null,
    version = public.core2_incident_escalations.version + 1,
    updated_at = now_ts;

  assignment_id := new_asg.id;
  trusted_contact_id := next_tc.id;
  contact_person_id := next_tc.contact_person_id;
  rank := next_tc.rank;
  offered_at := new_asg.offered_at;
  expires_at := new_asg.expires_at;
  newly_created := true;
  exhausted := false;
  return next;
end
$$;

-- Atomically claim single-owner incident responsibility for an offered, non-revoked trusted contact.
create function public.core2_accept_incident_assignment(
  p_family_id uuid,
  p_incident_id uuid,
  p_actor_person_id uuid,
  p_raw_event_id uuid,
  p_now timestamptz default null
) returns table (
  assignment_id uuid,
  incident_id uuid,
  subject_person_id uuid,
  responder_person_id uuid,
  offered_at timestamptz,
  accepted_at timestamptz,
  already_accepted boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  now_ts timestamptz := coalesce(p_now, pg_catalog.clock_timestamp());
  inc public.incidents;
  linked_watch public.core2_watches;
  tc public.core2_trusted_contacts;
  asg public.assignments;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('core2:incident:' || p_incident_id::text, 0)
  );

  select * into inc
  from public.incidents i
  where i.id = p_incident_id and i.family_id = p_family_id
  for update;

  if inc.id is null then
    raise exception 'incident_not_found' using errcode = 'P0002';
  end if;

  if inc.state in ('done', 'closed') then
    raise exception 'incident_closed' using errcode = '40902';
  end if;

  select * into linked_watch
  from public.core2_watches w
  where w.family_id = p_family_id and w.incident_id = p_incident_id
  for update;

  if linked_watch.id is not null and linked_watch.state in ('safe', 'cancelled') then
    raise exception 'incident_closed' using errcode = '40902';
  end if;

  -- Idempotent replay by the existing owner ONLY if still not revoked? Check contact revocation regardless,
  -- or allow already-accepted idempotent check after contact check:
  select c.* into tc
  from public.core2_trusted_contacts c
  where c.family_id = p_family_id
    and c.subject_person_id = inc.person_id
    and c.contact_person_id = p_actor_person_id
    and c.state = 'active'
    and c.revoked_at is null
    and c.effective_from <= now_ts
    and (c.effective_until is null or c.effective_until > now_ts)
    and (c.scopes && array['sos', 'watch_escalation']::text[])
  limit 1;

  if tc.id is null then
    update public.assignments a set status = 'expired'
    where a.family_id = p_family_id
      and a.incident_id = p_incident_id
      and a.person_id = p_actor_person_id
      and a.status = 'offered';
    raise exception 'contact_revoked_or_unauthorized' using errcode = '42501';
  end if;

  if inc.owner_person_id is not null and inc.owner_person_id <> p_actor_person_id then
    raise exception 'incident_already_accepted' using errcode = '40903';
  end if;

  select a.* into asg
  from public.assignments a
  where a.family_id = p_family_id
    and a.incident_id = p_incident_id
    and a.person_id = p_actor_person_id
    and a.status = 'accepted'
  order by a.accepted_at desc
  limit 1;

  if asg.id is not null and inc.owner_person_id = p_actor_person_id then
    assignment_id := asg.id;
    incident_id := p_incident_id;
    subject_person_id := inc.person_id;
    responder_person_id := p_actor_person_id;
    offered_at := asg.offered_at;
    accepted_at := asg.accepted_at;
    already_accepted := true;
    return next;
    return;
  end if;

  select a.* into asg
  from public.assignments a
  where a.family_id = p_family_id
    and a.incident_id = p_incident_id
    and a.person_id = p_actor_person_id
    and a.status = 'offered'
  order by a.offered_at desc
  limit 1
  for update;

  if asg.id is null then
    raise exception 'assignment_not_offered' using errcode = '42501';
  end if;

  if asg.expires_at <= now_ts then
    update public.assignments set status = 'expired'
    where id = asg.id and family_id = p_family_id and status = 'offered';
    raise exception 'assignment_expired' using errcode = '40904';
  end if;

  update public.assignments set
    status = 'accepted',
    accepted_at = now_ts,
    verified_by_provider_event = p_raw_event_id
  where id = asg.id and family_id = p_family_id and status = 'offered'
  returning * into strict asg;

  -- Strictly one owner: expire any other offered assignments on this incident.
  update public.assignments a set status = 'expired'
  where a.family_id = p_family_id
    and a.incident_id = p_incident_id
    and a.id <> asg.id
    and a.status = 'offered';

  update public.incidents i set
    state = 'accepted',
    owner_person_id = p_actor_person_id
  where i.id = p_incident_id and i.family_id = p_family_id;

  update public.core2_sos_events s set
    status = 'verified_accepted',
    responder_accepted = true,
    accepted_assignment_id = asg.id,
    accepted_raw_event_id = p_raw_event_id,
    version = s.version + 1,
    updated_at = now_ts
  where s.family_id = p_family_id
    and s.incident_id = p_incident_id
    and s.status not in ('safe', 'cancelled');

  update public.core2_incident_escalations esc set
    offer_expires_at = null,
    version = esc.version + 1,
    updated_at = now_ts
  where esc.incident_id = p_incident_id and esc.family_id = p_family_id;

  -- Fence still-armed dispatches for any other contacts on this watch/SOS.
  update public.core2_dispatch_fences f set
    state = 'fenced_resolved',
    fenced_at = now_ts
  from public.core2_watches w
  where f.family_id = p_family_id
    and f.watch_id = w.id
    and w.incident_id = p_incident_id
    and f.trusted_contact_id is distinct from tc.id
    and f.state = 'armed';

  update public.outbox o set
    status = 'failed',
    last_error_code = 'incident_accepted_by_other'
  from public.core2_dispatch_fences f
  where f.outbox_id = o.id
    and f.family_id = p_family_id
    and f.state = 'fenced_resolved'
    and o.status = 'pending'
    and o.lease_token is null;

  assignment_id := asg.id;
  incident_id := p_incident_id;
  subject_person_id := inc.person_id;
  responder_person_id := p_actor_person_id;
  offered_at := asg.offered_at;
  accepted_at := asg.accepted_at;
  already_accepted := false;
  return next;
end
$$;

-- Atomically decline an offered assignment so the caller can immediately rotate to the next contact.
create function public.core2_decline_incident_assignment(
  p_family_id uuid,
  p_incident_id uuid,
  p_actor_person_id uuid,
  p_now timestamptz default null
) returns table (
  assignment_id uuid,
  incident_id uuid,
  subject_person_id uuid,
  already_declined boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  now_ts timestamptz := coalesce(p_now, pg_catalog.clock_timestamp());
  inc public.incidents;
  asg public.assignments;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('core2:incident:' || p_incident_id::text, 0)
  );

  select * into inc
  from public.incidents i
  where i.id = p_incident_id and i.family_id = p_family_id
  for update;

  if inc.id is null then
    raise exception 'incident_not_found' using errcode = 'P0002';
  end if;

  if inc.state in ('done', 'closed') then
    raise exception 'incident_closed' using errcode = '40902';
  end if;

  if inc.owner_person_id is not null then
    raise exception 'incident_already_accepted' using errcode = '40903';
  end if;

  select a.* into asg
  from public.assignments a
  where a.family_id = p_family_id
    and a.incident_id = p_incident_id
    and a.person_id = p_actor_person_id
    and a.status = 'declined'
  order by a.offered_at desc
  limit 1;

  if asg.id is not null then
    assignment_id := asg.id;
    incident_id := p_incident_id;
    subject_person_id := inc.person_id;
    already_declined := true;
    return next;
    return;
  end if;

  select a.* into asg
  from public.assignments a
  where a.family_id = p_family_id
    and a.incident_id = p_incident_id
    and a.person_id = p_actor_person_id
    and a.status = 'offered'
  order by a.offered_at desc
  limit 1
  for update;

  if asg.id is null then
    raise exception 'assignment_not_offered' using errcode = '42501';
  end if;

  update public.assignments a set status = 'declined'
  where a.id = asg.id and a.family_id = p_family_id and a.status = 'offered';

  update public.core2_incident_escalations esc set
    offer_expires_at = now_ts,
    version = esc.version + 1,
    updated_at = now_ts
  where esc.incident_id = p_incident_id and esc.family_id = p_family_id and esc.current_assignment_id = asg.id;

  assignment_id := asg.id;
  incident_id := p_incident_id;
  subject_person_id := inc.person_id;
  already_declined := false;
  return next;
end
$$;

revoke all on function
  public.core2_offer_next_trusted_contact(uuid, uuid, text, timestamptz, timestamptz),
  public.core2_accept_incident_assignment(uuid, uuid, uuid, uuid, timestamptz),
  public.core2_decline_incident_assignment(uuid, uuid, uuid, timestamptz)
from public, anon, authenticated;

grant execute on function
  public.core2_offer_next_trusted_contact(uuid, uuid, text, timestamptz, timestamptz),
  public.core2_accept_incident_assignment(uuid, uuid, uuid, uuid, timestamptz),
  public.core2_decline_incident_assignment(uuid, uuid, uuid, timestamptz)
to service_role;
