-- C-15: per-recipient care notices. Existing Phase 3 authorization and contact fences remain intact.
alter table public.authorized_send_context drop constraint authorized_send_context_kind_check;
alter table public.authorized_send_context add constraint authorized_send_context_kind_check check(kind in (
 'core1.voice_notify','core1.missed_call_push','core1.sarvam_message_push','core2.sos_alert',
 'core2.watch_escalation','core2.watch_checkin','core2.reassurance','core2.device_handover',
 'gentle_news.circle_offer','core1.refill_notice'));
create table public.care_send_context (
 request_id uuid primary key references public.authorized_send_context(request_id),
 details jsonb not null check(jsonb_typeof(details)='object')
);
alter table public.care_send_context enable row level security;
revoke all on public.care_send_context from public,anon,authenticated,service_role;
grant select on public.care_send_context to service_role;

-- SQL facts, never the old human-as-principal JSON snapshot. Called before enqueue and again at claim.
create function sahaj_private.care_send_problem(p_request_id uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare r public.action_requests;c public.authorized_send_context;d jsonb;tc public.core2_trusted_contacts;purpose text;
begin
 select * into r from public.action_requests where id=p_request_id;
 select * into c from public.authorized_send_context where request_id=r.id;
 select details into d from public.care_send_context where request_id=r.id;
 if d is null then return null; end if;
 if not sahaj_private.person_in_family(c.family_id,r.person_id) or not sahaj_private.person_in_family(c.family_id,r.target_id::uuid) then return 'person_inactive'; end if;
 if c.kind in ('core2.sos_alert','core2.watch_escalation','core2.device_handover') or (c.kind='core2.reassurance' and d->>'trustedContactId' is not null) then
   select * into tc from public.core2_trusted_contacts where id=(d->>'trustedContactId')::uuid and family_id=c.family_id
    and subject_person_id=r.person_id and contact_person_id=r.target_id::uuid;
   purpose:=case when c.kind='core2.reassurance' then 'reassurance' when d->>'sosId' is not null then 'sos' else 'watch_escalation' end;
   if tc.id is null or tc.state<>'active' or tc.approved_at is null or tc.consent_at is null or tc.revoked_at is not null
    or tc.effective_from>clock_timestamp() or tc.effective_until<=clock_timestamp() or not (purpose=any(tc.scopes))
    or not exists(select 1 from public.consents x where x.id=tc.consent_id and x.family_id=c.family_id
      and x.answer and x.created_at=sahaj_private.consent_current(c.family_id,x.person_id,x.purpose)) then return 'contact_consent_required'; end if;
 end if;
 if c.kind='core2.watch_checkin' and r.target_id<>r.person_id::text then return 'checkin_target_invalid'; end if;
 if c.kind in ('core2.sos_alert','core2.watch_escalation','core2.device_handover','core2.watch_checkin') then
   if d->>'watchId' is null and d->>'sosId' is null and d->>'assignmentId' is null then return 'care_source_required'; end if;
   if d->>'watchId' is not null and not exists(select 1 from public.core2_watches w where w.id=(d->>'watchId')::uuid
    and w.family_id=c.family_id and w.subject_person_id=r.person_id and w.state in ('active','checking_in','escalated')) then return 'watch_closed'; end if;
   if d->>'sosId' is not null and not exists(select 1 from public.core2_sos_events s where s.id=(d->>'sosId')::uuid
    and s.family_id=c.family_id and s.subject_person_id=r.person_id and s.status not in ('safe','cancelled','countdown','verified_accepted')) then return 'sos_closed'; end if;
 end if;
 if d->>'assignmentId' is not null and not exists(select 1 from public.assignments a where a.id=(d->>'assignmentId')::uuid
   and a.family_id=c.family_id and a.person_id=r.target_id::uuid and a.incident_id=(d->>'incidentId')::uuid
   and exists(select 1 from public.incidents i where i.id=a.incident_id and i.family_id=c.family_id and i.person_id=r.person_id and i.state in ('open','offered','escalated','reopened')) and a.status='offered' and a.expires_at>clock_timestamp()) then return 'offer_expired'; end if;
 if c.kind='core2.device_handover' and d->>'handoverId' is null then return 'handover_source_required'; end if;
 if d->>'handoverId' is not null and not exists(select 1 from public.core2_device_handovers h
   left join public.core2_device_status ds on ds.family_id=h.family_id and ds.person_id=h.person_id
   where h.id=(d->>'handoverId')::uuid and h.family_id=c.family_id and h.person_id=r.person_id
    and ((h.reason='low_battery' and ds.battery_level<=10) or (h.reason='stale_heartbeat' and (ds.heartbeat_at is null or ds.heartbeat_at<=h.last_seen_at)))
    and h.watch_id is not distinct from (d->>'watchId')::uuid and h.sos_id is not distinct from (d->>'sosId')::uuid
    and ((h.watch_id is not null and exists(select 1 from public.core2_watches w where w.id=h.watch_id and w.state in ('active','checking_in','escalated')))
      or (h.sos_id is not null and exists(select 1 from public.core2_sos_events s where s.id=h.sos_id and s.status not in ('safe','cancelled'))))) then return 'handover_source_closed'; end if;
 if c.kind='core2.reassurance' then
   if exists(select 1 from public.people p where p.id=r.target_id::uuid and p.role='parent')
    and exists(select 1 from public.core2_sharing_preferences p where p.family_id=c.family_id and p.subject_person_id=r.person_id
      and not p.share_status_with_parent) then return 'privacy_changed'; end if;
   if sahaj_private.request_consent(c.family_id,r.person_id,'share_data',r.target_id) is null then return 'consent_required'; end if;
   if d->>'voicePostId' is not null and not exists(select 1 from public.voice_posts v join public.consents x on x.id=v.consent_id
     where v.id=(d->>'voicePostId')::uuid and v.family_id=c.family_id and v.sender_id=r.person_id and v.recipient_id::text=r.target_id
       and v.state<>'failed' and x.family_id=c.family_id and x.person_id=r.person_id and x.answer
       and x.purpose='voice_share:'||r.target_id and x.created_at=sahaj_private.consent_current(c.family_id,r.person_id,x.purpose))
     then return 'voice_post_unusable'; end if;
 end if;
 if c.kind='gentle_news.circle_offer' and not exists(select 1 from public.core2_gentle_news n
   where n.family_id=c.family_id and n.incident_id=(d->>'incidentId')::uuid and n.marked_by_person_id=r.person_id
    and n.circle_person_id=r.target_id::uuid and n.circle_offer_status='offered' and n.status<>'closed') then return 'visitor_offer_closed'; end if;
 if c.kind='gentle_news.circle_offer' and not exists(select 1 from public.circle x where x.family_id=c.family_id and x.person_id=r.target_id::uuid and x.approved_at is not null and x.consent_at is not null and x.revoked_at is null)
   then return 'visitor_consent_required'; end if;
 if c.kind='core1.refill_notice' and not exists(select 1 from public.errands e join public.action_requests a on a.id=e.action_request_id
   where e.id=(d->>'errandId')::uuid and e.family_id=c.family_id and a.person_id=r.person_id
    and e.status in ('authorized','dispatched','completed') and a.consumed_at is not null and a.amount_minor=(d->>'amountMinor')::bigint
    and exists(select 1 from public.family_memberships m where m.family_id=c.family_id and m.person_id=r.target_id::uuid
      and m.role='child' and m.revoked_at is null)) then return 'refill_not_authorized'; end if;
 return null;
end$$;

create function public.prepare_care_send(p_family_id uuid,p_job_id uuid,p_request_id uuid,p_event_id uuid,
 p_subject_id uuid,p_recipient_id uuid,p_kind text,p_source_id uuid,p_fingerprint text,p_details jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.workflow_jobs;c public.authorized_send_context;act text;channel text;rid uuid;problem text;
begin
 if p_kind not in ('core2.sos_alert','core2.watch_escalation','core2.watch_checkin','core2.reassurance','core2.device_handover','gentle_news.circle_offer','core1.refill_notice')
  or p_details is null or jsonb_typeof(p_details)<>'object' then raise exception 'unsupported_care_send'; end if;
 if not sahaj_private.person_in_family(p_family_id,p_subject_id) or not sahaj_private.person_in_family(p_family_id,p_recipient_id)
  then raise exception 'send_person_inactive' using errcode='42501'; end if;
 if not exists(select 1 from public.timeline_events t where t.family_id=p_family_id and t.entity_id=p_source_id
   and t.event_type='care.send.requested' and t.payload_canonical::jsonb=jsonb_build_object('kind',p_kind,
     'subjectId',p_subject_id,'recipientId',p_recipient_id,'details',p_details)) then raise exception 'unsigned_care_source' using errcode='42501'; end if;
 act:=case when p_kind='core2.reassurance' then 'share_data' else 'send_alert' end;
 select case when p_kind='core1.refill_notice' or exists(select 1 from public.app_push_tokens t join public.family_memberships m
   on m.family_id=t.family_id and m.user_id=t.user_id and m.person_id=p_recipient_id and m.revoked_at is null where t.family_id=p_family_id)
   then 'expo' else 'twilio' end into channel;
 insert into public.raw_events(id,family_id,source,provider_event_id,event_type,status,metadata)
 values(p_event_id,p_family_id,'authorized_send',p_event_id::text,p_kind,'processed',jsonb_build_object('person_id',p_subject_id)) on conflict(id) do nothing;
 insert into public.workflow_jobs(id,family_id,raw_event_id,thread_id,workflow_kind,state,lease_token,lease_until)
 values(p_job_id,p_family_id,p_event_id,'authorized-send:'||p_job_id,p_kind,'processing',gen_random_uuid(),clock_timestamp()+interval '2 minutes') on conflict(id) do nothing;
 select * into strict j from public.workflow_jobs where id=p_job_id and family_id=p_family_id for update;
 perform sahaj_private.lock_family_authorization(p_family_id);
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('core2:dispatch:'||p_family_id,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('core2:device:'||p_family_id||':'||p_subject_id,0));
 if j.raw_event_id<>p_event_id or j.workflow_kind<>p_kind then raise exception 'send_job_conflict'; end if;
 if j.state<>'processing' or j.lease_until<=clock_timestamp() then
  update public.workflow_jobs set state='processing',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes' where id=j.id returning * into j; end if;
 rid:=public.ensure_action_request(p_family_id,p_job_id,j.lease_token,p_request_id,p_subject_id,act,p_recipient_id::text,p_fingerprint,
   case when act='share_data' then p_subject_id else null end);
 if rid is null then raise exception 'send_principal_missing' using errcode='42501'; end if;
 insert into public.authorized_send_context(request_id,family_id,kind,source_id,channel)
 values(rid,p_family_id,p_kind,p_source_id,channel) on conflict(request_id) do nothing;
 select * into strict c from public.authorized_send_context where request_id=rid;
 if c.family_id<>p_family_id or c.kind<>p_kind or c.source_id<>p_source_id then raise exception 'send_context_conflict'; end if;
 insert into public.care_send_context(request_id,details) values(rid,p_details) on conflict(request_id) do nothing;
 if (select details from public.care_send_context where request_id=rid)<>p_details then raise exception 'send_details_conflict'; end if;
 problem:=sahaj_private.care_send_problem(rid);
 if problem is not null then raise exception 'care_send_refused: %',problem using errcode='42501'; end if;
 return jsonb_build_object('lease',j.lease_token,'channel',c.channel);
end$$;

-- The outbox insert is still inside enqueue_authorized_command's atomic transaction.
create function sahaj_private.care_send_enqueue_fence() returns trigger language plpgsql security definer set search_path='' as $$
declare d jsonb;problem text;k text;
begin
 select details into d from public.care_send_context where request_id=new.action_request_id;
 if d is null then return new; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('core2:dispatch:'||new.family_id,0));
 problem:=sahaj_private.care_send_problem(new.action_request_id);
 if problem is not null then raise exception 'care_send_refused: %',problem using errcode='42501'; end if;
 select kind into k from public.authorized_send_context where request_id=new.action_request_id;
 if k in ('core2.sos_alert','core2.watch_escalation','core2.device_handover','core2.watch_checkin') then
  insert into public.core2_dispatch_fences(family_id,outbox_id,trusted_contact_id,watch_id,sos_id)
  values(new.family_id,new.id,(d->>'trustedContactId')::uuid,(d->>'watchId')::uuid,(d->>'sosId')::uuid);
 end if;
 return new;
end$$;
create trigger care_send_enqueue_fence after insert on public.outbox for each row execute function sahaj_private.care_send_enqueue_fence();
create function sahaj_private.care_send_claim_fence() returns trigger language plpgsql security definer set search_path='' as $$
declare rid uuid;problem text;
begin
 select action_request_id into rid from public.outbox where id=new.outbox_id and family_id=new.family_id;
 if not exists(select 1 from public.care_send_context where request_id=rid) then return new; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('core2:dispatch:'||new.family_id,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('core2:device:'||new.family_id||':'||
   (select person_id from public.action_requests where id=rid),0));
 if exists(select 1 from public.care_send_context c join public.core2_device_handovers h on h.id=(c.details->>'handoverId')::uuid
   where c.request_id=rid and h.completed_at is null) then raise exception 'handover_not_completed' using errcode='42501'; end if;
 problem:=sahaj_private.care_send_problem(rid);
 if problem is not null then raise exception 'care_send_refused: %',problem using errcode='42501'; end if;
 if exists(select 1 from public.core2_dispatch_fences where outbox_id=new.outbox_id)
  and not public.core2_claim_fenced_dispatch(new.outbox_id) then raise exception 'care_dispatch_fenced' using errcode='42501'; end if;
 return new;
end$$;
create trigger care_send_claim_fence before insert on public.dispatch_ledger for each row execute function sahaj_private.care_send_claim_fence();
create trigger care_send_claim_fence before insert on public.authorized_push_ledger for each row execute function sahaj_private.care_send_claim_fence();
revoke all on function public.prepare_care_send(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,text,jsonb),
 sahaj_private.care_send_problem(uuid),sahaj_private.care_send_enqueue_fence(),sahaj_private.care_send_claim_fence() from public,anon,authenticated;
grant execute on function public.prepare_care_send(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,text,jsonb) to service_role;

create function public.read_care_notice(p_outbox_id uuid,p_call_sid text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.authorized_send_context;d jsonb;r uuid;
begin
 select o.action_request_id into r from public.outbox o join public.dispatch_ledger l on l.outbox_id=o.id
  join public.calls cl on cl.id=l.call_id and cl.family_id=l.family_id
  where o.id=p_outbox_id and l.provider='twilio' and l.provider_ref=p_call_sid
    and l.status in ('dispatched','delivered','delivery_unknown') and cl.external_id=p_call_sid;
 if r is null or sahaj_private.dispatch_authorization_problem(p_outbox_id,clock_timestamp()) is not null
  or sahaj_private.care_send_problem(r) is not null then return null; end if;
 select * into c from public.authorized_send_context where request_id=r;
 select details into d from public.care_send_context where request_id=r;
 if d is null then return null; end if;
 return jsonb_build_object('kind',c.kind,'details',d);
end$$;
revoke all on function public.read_care_notice(uuid,text) from public,anon,authenticated;
grant execute on function public.read_care_notice(uuid,text) to service_role;


-- No bare outbox writes: notices must already have a guarded, source-bound request.
create or replace function public.core2_complete_device_handover(p_job_id uuid, p_event jsonb, p_payload_canonical text,
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
    oid := (n->>'authorizedOutboxId')::uuid;
    if not exists(select 1 from public.outbox o join public.action_requests r on r.id=o.action_request_id
      join public.authorized_send_context c on c.request_id=r.id join public.care_send_context cs on cs.request_id=r.id
      where o.id=oid and o.family_id=j.family_id and r.person_id=j.person_id and r.target_id=recipient::text
        and o.dedupe_key=cmd->>'dedupeKey' and r.consumed_at is not null and o.status='pending'
        and cs.details->>'handoverId'=j.id::text
        and c.kind=case when (n->>'parent')::boolean then 'core2.reassurance' else 'core2.device_handover' end)
      then raise exception 'handover_notice_not_authorized' using errcode='42501'; end if;
    if (n->>'parent')::boolean then
      insert into public.core2_reassurance_updates(family_id,subject_person_id,recipient_person_id,kind,watch_id,sos_id,
        outbox_id,status_label,delivery_status,location_shared,health_shared,narrative_shared)
      values(j.family_id,j.person_id,recipient,'truth_line',j.watch_id,j.sos_id,oid,left(n->>'statusLabel',80),'queued',false,false,false);
    end if;
  end loop;
  update public.core2_device_handovers set completed_at=now() where id=j.id;
end $$;
