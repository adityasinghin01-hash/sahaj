-- C-12: device input, durable per-watch/SOS handover, and atomic signed outbox commit.
create table public.core2_device_status (
  family_id uuid not null references public.families(id),
  person_id uuid not null,
  battery_level integer check (battery_level between 0 and 100),
  is_charging boolean,
  sampled_at timestamptz not null,
  heartbeat_at timestamptz not null default now(),
  raw_event_id uuid,
  primary key (family_id, person_id),
  foreign key (family_id, person_id) references public.people(family_id, id),
  foreign key (family_id, raw_event_id) references public.raw_events(family_id, id)
);
alter table public.core2_device_status enable row level security;
revoke all on public.core2_device_status from anon, authenticated;
grant select (family_id, person_id, battery_level, is_charging, sampled_at, heartbeat_at),
  insert (family_id, person_id, battery_level, is_charging, sampled_at),
  update (battery_level, is_charging, sampled_at) on public.core2_device_status to authenticated;
grant all on public.core2_device_status to service_role;
create policy core2_device_read on public.core2_device_status for select to authenticated
  using (sahaj_private.is_person(family_id, person_id));
create policy core2_device_insert on public.core2_device_status for insert to authenticated
  with check (sahaj_private.is_person(family_id, person_id));
create policy core2_device_update on public.core2_device_status for update to authenticated
  using (sahaj_private.is_person(family_id, person_id)) with check (sahaj_private.is_person(family_id, person_id));

create table public.core2_device_handovers (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  person_id uuid not null,
  watch_id uuid,
  sos_id uuid,
  request_id uuid,
  reason text not null check (reason in ('low_battery', 'stale_heartbeat')),
  last_seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((watch_id is null) <> (sos_id is null)),
  foreign key (family_id, person_id) references public.people(family_id, id),
  foreign key (family_id, watch_id) references public.core2_watches(family_id, id),
  foreign key (family_id, sos_id) references public.core2_sos_events(family_id, id),
  unique (watch_id), unique (sos_id)
);
alter table public.core2_device_handovers enable row level security;
revoke all on public.core2_device_handovers from public, anon, authenticated;
grant all on public.core2_device_handovers to service_role;
create index core2_device_handovers_pending on public.core2_device_handovers(created_at) where completed_at is null;

-- Status + scoped idempotency are one transaction. Replays never refresh heartbeat.
create function public.core2_report_device_status(p_family_id uuid, p_person_id uuid, p_key_hash text,
  p_request_hash text, p_status jsonb, p_raw_event_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare prior public.core2_idempotency_records; saved public.core2_device_status; result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('core2:device:' || p_family_id || ':' || p_person_id, 0));
  select * into prior from public.core2_idempotency_records where family_id=p_family_id
    and actor_person_id=p_person_id and action='device_status' and key_hash=p_key_hash;
  if found then
    if prior.request_hash <> p_request_hash then raise exception 'idempotency_conflict' using errcode='23505'; end if;
    return prior.response_body || jsonb_build_object('idempotent_replay', true);
  end if;
  insert into public.core2_device_status(family_id,person_id,battery_level,is_charging,sampled_at,raw_event_id)
    values (p_family_id,p_person_id,(p_status->>'battery_level')::integer,(p_status->>'is_charging')::boolean,
      (p_status->>'sampled_at')::timestamptz,p_raw_event_id)
    on conflict (family_id,person_id) do update set battery_level=excluded.battery_level,
      is_charging=excluded.is_charging,sampled_at=excluded.sampled_at,heartbeat_at=now(),raw_event_id=excluded.raw_event_id
    where excluded.sampled_at > core2_device_status.sampled_at;
  select * into strict saved from public.core2_device_status where family_id=p_family_id and person_id=p_person_id;
  result := jsonb_build_object('device_status', to_jsonb(saved)-'raw_event_id', 'idempotent_replay',false);
  insert into public.core2_idempotency_records(family_id,actor_person_id,action,key_hash,request_hash,response_status,response_body)
    values (p_family_id,p_person_id,'device_status',p_key_hash,p_request_hash,200,result);
  return result;
end $$;

-- Called by the server worker, also after a report. No browser polling is needed for staleness.
create function public.core2_due_device_handovers(p_stale_ms double precision, p_family_id uuid default null,
  p_person_id uuid default null) returns setof public.core2_device_handovers
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_stale_ms <= 0 or p_stale_ms = 'NaN'::float8 then raise exception 'invalid stale interval'; end if;
  insert into public.core2_device_handovers(family_id,person_id,watch_id,request_id,reason,last_seen_at)
    select w.family_id,w.subject_person_id,w.id,w.request_id,
      case when d.battery_level <= 10 then 'low_battery' else 'stale_heartbeat' end,
      coalesce(d.heartbeat_at,w.created_at)
    from public.core2_watches w left join public.core2_device_status d
      on d.family_id=w.family_id and d.person_id=w.subject_person_id
    where w.state in ('active','checking_in','escalated')
      and (p_family_id is null or w.family_id=p_family_id) and (p_person_id is null or w.subject_person_id=p_person_id)
      and (d.battery_level <= 10 or now()-greatest(coalesce(d.heartbeat_at,w.created_at),w.created_at) > p_stale_ms * interval '1 millisecond')
    on conflict do nothing;
  insert into public.core2_device_handovers(family_id,person_id,sos_id,request_id,reason,last_seen_at)
    select s.family_id,s.subject_person_id,s.id,s.request_id,'low_battery',d.heartbeat_at
    from public.core2_sos_events s join public.core2_device_status d
      on d.family_id=s.family_id and d.person_id=s.subject_person_id
    where s.status not in ('safe','cancelled') and d.battery_level <= 10
      and (p_family_id is null or s.family_id=p_family_id) and (p_person_id is null or s.subject_person_id=p_person_id)
    on conflict do nothing;
  return query select j.* from public.core2_device_handovers j where j.completed_at is null
    and (p_family_id is null or j.family_id=p_family_id) and (p_person_id is null or j.person_id=p_person_id)
    order by j.created_at,j.id limit 25;
end $$;

-- Gate-approved commands only. Recheck resolution, live contact and privacy under the same
-- dispatch lock used by contact revocation. Timeline + all outbox/fence/truth rows commit together.
create function public.core2_complete_device_handover(p_job_id uuid, p_event jsonb, p_payload_canonical text,
  p_chain_hash text, p_signature text, p_notices jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.core2_device_handovers; d public.core2_device_status; n jsonb; cmd jsonb; oid uuid; recipient uuid; contact uuid;
begin
  select * into strict j from public.core2_device_handovers where id=p_job_id for update;
  if j.completed_at is not null then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('core2:dispatch:' || j.family_id,0));
  if j.watch_id is not null then
    perform 1 from public.core2_watches where id=j.watch_id and family_id=j.family_id
      and state in ('active','checking_in','escalated') for update;
  else
    perform 1 from public.core2_sos_events where id=j.sos_id and family_id=j.family_id
      and status not in ('safe','cancelled') for update;
  end if;
  if not found then
    update public.core2_device_handovers set completed_at=now() where id=j.id; return;
  end if;
  select * into d from public.core2_device_status where family_id=j.family_id and person_id=j.person_id for update;
  if (j.reason='low_battery' and (d.battery_level is null or d.battery_level>10))
    or (j.reason='stale_heartbeat' and d.heartbeat_at>j.last_seen_at) then
    -- A recovered phone invalidates unfinished work; a later drop can create a new job.
    delete from public.core2_device_handovers where id=j.id; return;
  end if;
  if p_event->>'familyId' <> j.family_id::text or p_event->>'eventId' <> j.id::text
    or p_event->>'dedupeKey' <> 'core2:device:' || j.id then raise exception 'invalid handover timeline'; end if;
  -- A changed contact/preference invalidates prepared work. Roll back for a fresh gate evaluation.
  for n in select value from jsonb_array_elements(p_notices) loop
    cmd := n->'command'; recipient := (n->>'recipient')::uuid; contact := (cmd->>'trustedContactId')::uuid;
    if cmd->>'familyId' <> j.family_id::text then raise exception 'foreign notice'; end if;
    if (n->>'parent')::boolean then
      if exists(select 1 from public.core2_sharing_preferences where family_id=j.family_id
        and subject_person_id=j.person_id and not share_status_with_parent)
        or not exists(select 1 from public.people where id=recipient and family_id=j.family_id and role='parent')
        then raise exception 'privacy changed' using errcode='40001'; end if;
    else
      if not exists(select 1 from public.core2_trusted_contacts c where c.id=contact and c.family_id=j.family_id
        and c.subject_person_id=j.person_id and c.contact_person_id=recipient and c.state='active'
        and c.approved_at is not null and c.consent_at is not null and c.consent_id is not null
        and c.revoked_at is null and c.effective_from<=now() and (c.effective_until is null or c.effective_until>now())
        and (case when j.sos_id is null then 'watch_escalation' else 'sos' end)=any(c.scopes))
        then raise exception 'contact changed' using errcode='40001'; end if;
    end if;
  end loop;
  perform public.append_timeline_event(p_event,p_payload_canonical,p_chain_hash,p_signature);
  for n in select value from jsonb_array_elements(p_notices) loop
    cmd := n->'command'; recipient := (n->>'recipient')::uuid;
    insert into public.outbox(family_id,action_request_id,kind,dedupe_key,payload_ciphertext,status)
      values(j.family_id,null,cmd->>'kind',cmd->>'dedupeKey',cmd->>'payloadCiphertext','pending') returning id into oid;
    insert into public.core2_dispatch_fences(family_id,outbox_id,trusted_contact_id,watch_id,sos_id,state)
      values(j.family_id,oid,(cmd->>'trustedContactId')::uuid,j.watch_id,j.sos_id,'armed');
    if (n->>'parent')::boolean then
      insert into public.core2_reassurance_updates(family_id,subject_person_id,recipient_person_id,kind,watch_id,sos_id,
        outbox_id,status_label,delivery_status,location_shared,health_shared,narrative_shared)
      values(j.family_id,j.person_id,recipient,'truth_line',j.watch_id,j.sos_id,oid,n->>'statusLabel','queued',false,false,false);
    end if;
  end loop;
  update public.core2_device_handovers set completed_at=now() where id=j.id;
end $$;

revoke all on function public.core2_report_device_status(uuid,uuid,text,text,jsonb,uuid),
  public.core2_due_device_handovers(double precision,uuid,uuid),
  public.core2_complete_device_handover(uuid,jsonb,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.core2_report_device_status(uuid,uuid,text,text,jsonb,uuid),
  public.core2_due_device_handovers(double precision,uuid,uuid),
  public.core2_complete_device_handover(uuid,jsonb,text,text,text,jsonb) to service_role;
