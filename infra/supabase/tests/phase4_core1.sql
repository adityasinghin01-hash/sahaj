-- Phase 4 Core 1: SQL acceptance for 20261114220000_phase4_core1.sql, driven through the real Phase 2/3 functions.
-- Synthetic data only; everything rolls back. Run as an administrative role on a disposable joined-schema database.
--
-- K-INT2 rewrite (first execution on the joined schema). The original suite inserted `circle.active` (no such column),
-- used non-hex uuids (`m4000000-…`), hand-forged a `responder.accepted` raw event with a `verified_by` column that does
-- not exist, and wrapped every negative check in `exception when others then null`, which also swallowed its own
-- `raise exception 'FAIL …'` (so no negative check could ever fail). Every negative check below names the exact errcode.
begin;

insert into auth.users(id) values
 ('a4000000-0000-4000-8000-000000000001'),('a4000000-0000-4000-8000-000000000002'),('a4000000-0000-4000-8000-000000000003');
insert into public.families(id,name) values
 ('b4000000-0000-4000-8000-000000000001','Phase4 Synthetic Family A'),
 ('b4000000-0000-4000-8000-000000000002','Phase4 Synthetic Family B');
insert into public.people(id,family_id,display_name,role) values
 ('c4000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001','Maa Meena','parent'),
 ('c4000000-0000-4000-8000-000000000002','b4000000-0000-4000-8000-000000000001','Riya','child'),
 ('c4000000-0000-4000-8000-000000000003','b4000000-0000-4000-8000-000000000001','Sharma Uncle','circle'),
 ('c4000000-0000-4000-8000-000000000004','b4000000-0000-4000-8000-000000000002','Foreign Person B','child'),
 ('c4000000-0000-4000-8000-000000000005','b4000000-0000-4000-8000-000000000001','Rohit','child'),
 ('c4000000-0000-4000-8000-000000000006','b4000000-0000-4000-8000-000000000001','Revoked Neighbour','circle'),
 ('c4000000-0000-4000-8000-000000000007','b4000000-0000-4000-8000-000000000001','Unconsented Neighbour','circle'),
 ('c4000000-0000-4000-8000-000000000008','b4000000-0000-4000-8000-000000000001','Unapproved Neighbour','circle');
insert into public.family_memberships(family_id,user_id,person_id,role) values
 ('b4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','parent'),
 ('b4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000002','c4000000-0000-4000-8000-000000000002','child'),
 ('b4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000003','c4000000-0000-4000-8000-000000000005','child');

-- Circle: the three ineligible rows rank ABOVE Riya, so a wrong eligibility rule would pick one of them.
insert into public.circle(family_id,person_id,rank,approved_at,consent_at,revoked_at) values
 ('b4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000006',1,now(),now(),now()),
 ('b4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000007',1,now(),null,null),
 ('b4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000008',1,null,now(),null),
 ('b4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000002',2,now(),now(),null),
 ('b4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000003',3,now(),now(),null);

insert into public.consents(id,family_id,person_id,purpose,question,answer,version,created_at) values
 ('f4000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001',
  'voice_share:c4000000-0000-4000-8000-000000000002','Share voice with Riya?',true,'v1',now()-interval '1 minute'),
 ('f4000000-0000-4000-8000-000000000002','b4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001',
  'voice_share:c4000000-0000-4000-8000-000000000003','Share voice with Sharma uncle?',true,'v1',now()-interval '2 minutes'),
 ('f4000000-0000-4000-8000-000000000004','b4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001',
  'permission_setup','q',true,'v1',now()-interval '1 minute');
-- Maa later withdrew sharing with Sharma uncle: the newest row wins.
insert into public.consents(id,family_id,person_id,purpose,question,answer,version,created_at) values
 ('f4000000-0000-4000-8000-000000000003','b4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001',
  'voice_share:c4000000-0000-4000-8000-000000000003','Share voice with Sharma uncle?',false,'v1',now()-interval '1 minute');

insert into public.medicines(id,family_id,person_id,label,remaining_count,refill_threshold,instructions_confirmed_by_person) values
 ('d4000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','Amlodipine 5mg',10,3,true),
 ('d4000000-0000-4000-8000-000000000002','b4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','Unknown stock',null,3,true);

insert into storage.buckets(id,name,public) values('sahaj-voice','sahaj-voice',false) on conflict (id) do nothing;
insert into storage.objects(bucket_id,name) values
 ('sahaj-voice','b4000000-0000-4000-8000-000000000001/voice/audio_01.m4a'),
 ('sahaj-voice','b4000000-0000-4000-8000-000000000001/voice/reply_01.m4a'),
 ('sahaj-voice','b4000000-0000-4000-8000-000000000001/voice/uncle_01.m4a'),
 ('sahaj-voice','b4000000-0000-4000-8000-000000000001/voice/bad_reply.m4a');

-- Phase 2/3 dispatch chain for one urgent responder call to Riya.
insert into public.atlas_principals(id,family_id,label) values('a7400000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001','synthetic');
insert into public.provider_identities(id,family_id,person_id,source,account_id,external_id_hash,binding_kind,contact_ciphertext) values
 ('f6400000-0000-4000-8000-000000000002','b4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000002','twilio','AC-synthetic',repeat('2',64),'contact','synthetic-ct');
insert into public.permissions(id,family_id,person_id,principal_id,action,decision,expires_at,consent_id,two_person_required,valid_from,period_start,period_end,max_uses,target_ids)
 values('a4400000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','a7400000-0000-4000-8000-000000000001',
  'urgent_responder','allow',now()+interval '1 day','f4000000-0000-4000-8000-000000000004',true,now()-interval '1 hour',now()-interval '1 hour',now()+interval '1 day',10,
  array['c4000000-0000-4000-8000-000000000001']::uuid[]);
insert into public.raw_events(id,family_id,source,provider_event_id,event_type,status,payload_hash) values
 ('e4400000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001','whatsapp','p4-1','whatsapp.text','processed',repeat('1',64));
insert into public.workflow_jobs(id,family_id,raw_event_id,thread_id,workflow_kind,state,lease_token,lease_until) values
 ('d4400000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001','e4400000-0000-4000-8000-000000000001','p4c1','core1.atlas','processing',
  '94000000-0000-4000-8000-000000000001',now()+interval '10 minutes');

create temporary table t_ctx(k text primary key,val text) on commit drop;
grant all on t_ctx to service_role;

-- ---------------------------------------------------------------- 0. privileges: service role only
do $$
declare f text;
begin
  foreach f in array array[
    'public.create_urgent_incident_offer(uuid,uuid,text,integer)',
    'public.advance_urgent_offer(uuid,uuid,uuid,text,integer)',
    'public.list_expired_urgent_offers(integer)',
    'public.accept_responder_assignment_verified(uuid,uuid,uuid,uuid,uuid,integer)',
    'public.record_medicine_dose(uuid,uuid,uuid,text,integer)',
    'public.create_family_voice_post(uuid,uuid,uuid,text,uuid,uuid,integer)'] loop
    if has_function_privilege('anon',f,'EXECUTE') or has_function_privilege('authenticated',f,'EXECUTE') then
      raise exception 'FAIL % executable by a client role',f;
    end if;
    if not has_function_privilege('service_role',f,'EXECUTE') then raise exception 'FAIL % not executable by service_role',f; end if;
  end loop;
  if has_function_privilege('service_role','sahaj_private.next_circle_responder(uuid,uuid,uuid)','EXECUTE')
     or has_function_privilege('service_role','sahaj_private.offer_next_responder(uuid,uuid,uuid,integer)','EXECUTE') then
    raise exception 'FAIL private offer helpers directly executable';
  end if;
end $$;

set local role service_role;

-- ---------------------------------------------------------------- 1. offer: eligibility, subject exclusion, input checks
do $$
declare fam uuid:='b4000000-0000-4000-8000-000000000001'; maa uuid:='c4000000-0000-4000-8000-000000000001';
  riya uuid:='c4000000-0000-4000-8000-000000000002'; sharma uuid:='c4000000-0000-4000-8000-000000000003'; v jsonb;
begin
  v := public.create_urgent_incident_offer(fam,maa,'urgent',3);
  if v->>'state'<>'offered' then raise exception 'FAIL expected offered, got %',v; end if;
  if (v->>'responder_person_id')::uuid<>riya then raise exception 'FAIL expected first eligible responder Riya (revoked/unconsented/unapproved skipped), got %',v; end if;
  if (select state from public.incidents where id=(v->>'incident_id')::uuid)<>'offered' then raise exception 'FAIL incident row not offered'; end if;

  v := public.create_urgent_incident_offer(fam,riya,'urgent',3);
  if (v->>'responder_person_id')::uuid<>sharma then raise exception 'FAIL subject Riya must not be offered her own incident, got %',v; end if;

  begin perform public.create_urgent_incident_offer(fam,'c4000000-0000-4000-8000-000000000004','urgent',3);
    raise exception 'FAIL cross-family subject accepted';
  exception when insufficient_privilege then null; end;
  begin perform public.create_urgent_incident_offer(fam,maa,'catastrophic',3);
    raise exception 'FAIL invalid severity accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.create_urgent_incident_offer(fam,maa,null,3);
    raise exception 'FAIL null severity accepted';
  exception when invalid_parameter_value then null; end;
end $$;

-- ---------------------------------------------------------------- 2. decline -> next member; timeout -> escalate; replay no-op
do $$
declare fam uuid:='b4000000-0000-4000-8000-000000000001'; maa uuid:='c4000000-0000-4000-8000-000000000001';
  sharma uuid:='c4000000-0000-4000-8000-000000000003'; v jsonb; inc uuid; a1 uuid; a2 uuid;
begin
  v := public.create_urgent_incident_offer(fam,maa,'critical',3);
  inc := (v->>'incident_id')::uuid; a1 := (v->>'assignment_id')::uuid;
  begin perform public.advance_urgent_offer(fam,inc,a1,'expired',3);
    raise exception 'FAIL unexpired offer timed out';
  exception when object_not_in_prerequisite_state then null; end;
  begin perform public.advance_urgent_offer(fam,inc,a1,'accepted',3);
    raise exception 'FAIL advance with reason accepted';
  exception when invalid_parameter_value then null; end;

  v := public.advance_urgent_offer(fam,inc,a1,'declined',3);
  if (v->>'responder_person_id')::uuid<>sharma or v->>'previous_status'<>'declined' then raise exception 'FAIL decline did not move to Sharma: %',v; end if;
  a2 := (v->>'assignment_id')::uuid;
  if (select status from public.assignments where id=a1)<>'declined' then raise exception 'FAIL declined offer not marked'; end if;

  -- replay of the decline is a no-op that points at the live offer
  v := public.advance_urgent_offer(fam,inc,a1,'declined',3);
  if not coalesce((v->>'noop')::boolean,false) or (v->>'assignment_id')::uuid<>a2 then raise exception 'FAIL decline replay not a no-op: %',v; end if;
  insert into t_ctx values('inc2',inc::text),('a2',a2::text);
end $$;
reset role;
update public.assignments set expires_at=now()-interval '1 second' where id=(select val::uuid from t_ctx where k='a2');
set local role service_role;
do $$
declare fam uuid:='b4000000-0000-4000-8000-000000000001'; inc uuid:=(select val::uuid from t_ctx where k='inc2');
  a2 uuid:=(select val::uuid from t_ctx where k='a2'); v jsonb;
begin
  if not exists (select 1 from public.list_expired_urgent_offers(100) x where x.assignment_id=a2) then raise exception 'FAIL expired offer not listed'; end if;
  v := public.advance_urgent_offer(fam,inc,a2,'expired',3);
  if v->>'state'<>'escalated' or v->>'reason'<>'no_available_circle_members' then raise exception 'FAIL exhausted circle not escalated: %',v; end if;
  if (select state from public.incidents where id=inc)<>'escalated' then raise exception 'FAIL incident row not escalated'; end if;
  if exists (select 1 from public.list_expired_urgent_offers(100) x where x.incident_id=inc) then raise exception 'FAIL escalated incident still listed'; end if;
  begin perform public.advance_urgent_offer('b4000000-0000-4000-8000-000000000002',inc,a2,'declined',3);
    raise exception 'FAIL cross-family advance';
  exception when no_data_found then null; end;
end $$;

-- ---------------------------------------------------------------- 3. verified acceptance through the Phase 2 proof chain
do $$
declare fam uuid:='b4000000-0000-4000-8000-000000000001'; maa uuid:='c4000000-0000-4000-8000-000000000001';
  riya uuid:='c4000000-0000-4000-8000-000000000002';
  rq uuid:='74000000-0000-4000-8000-000000000001'; j uuid:='d4400000-0000-4000-8000-000000000001'; jl uuid:='94000000-0000-4000-8000-000000000001';
  v jsonb; inc uuid; asg uuid; res jsonb; ob uuid; cl uuid; lease uuid; k text; raw public.raw_events;
begin
  v := public.create_urgent_incident_offer(fam,maa,'urgent',5);
  inc := (v->>'incident_id')::uuid; asg := (v->>'assignment_id')::uuid;
  perform public.ensure_action_request(fam,j,jl,rq,maa,'urgent_responder',maa::text,repeat('a',64));
  insert into public.action_answers(family_id,action_request_id,approver_person_id,answer) values
    (fam,rq,riya,true),(fam,rq,'c4000000-0000-4000-8000-000000000005',true);
  res := public.enqueue_authorized_command(fam,j,jl,rq,'urgent_responder','p4-k1','ct',repeat('b',64),sahaj_private.authorization_revision(fam,rq),inc,asg);
  if res->>'status'<>'enqueued' then raise exception 'FAIL urgent enqueue: %',res; end if;
  ob := (res->>'outbox_id')::uuid;
  select call_id into cl from public.dispatch_bindings where outbox_id=ob and person_id=riya and assignment_id=asg;
  if cl is null then raise exception 'FAIL dispatch not bound to the offered responder'; end if;
  select o.lease_token into lease from public.claim_outbox('p4-worker',100,120) o where o.id=ob;
  k := 'dispatch:'||ob||':a1';
  if public.claim_dispatch_contact(fam,riya,k,'twilio','twilio.create_call',ob,lease,cl,'f6400000-0000-4000-8000-000000000002','AC-synthetic',repeat('2',64))<>'claimed' then
    raise exception 'FAIL urgent claim';
  end if;
  if public.complete_dispatch(fam,k,'CA'||repeat('c',32),'AC-synthetic',repeat('e',64),true)<>'dispatched' then raise exception 'FAIL urgent complete'; end if;
  perform public.finish_outbox(ob,lease,true,null);
  raw := public.ingest_raw_event('twilio','AC-synthetic:gather:CA'||repeat('c',32),'twilio.gather.response',fam,
    jsonb_build_object('digit','1','call_id',cl,'person_id',riya),repeat('f',64),null);

  -- The un-normalized Gather event itself is not acceptance proof.
  begin perform public.accept_responder_assignment_verified(fam,inc,asg,riya,raw.id,20);
    raise exception 'FAIL raw gather event accepted as proof';
  exception when insufficient_privilege then null; end;

  insert into t_ctx values('inc3',inc::text),('a3',asg::text),('gather3',raw.provider_event_id),('other_inc',
    (select (public.create_urgent_incident_offer(fam,'c4000000-0000-4000-8000-000000000003','urgent',3))->>'incident_id'));
end $$;
do $$
declare fam uuid:='b4000000-0000-4000-8000-000000000001'; riya uuid:='c4000000-0000-4000-8000-000000000002';
  sharma uuid:='c4000000-0000-4000-8000-000000000003';
  inc uuid:=(select val::uuid from t_ctx where k='inc3'); asg uuid:=(select val::uuid from t_ctx where k='a3');
  other_inc uuid:=(select val::uuid from t_ctx where k='other_inc'); acc jsonb; pid uuid; v jsonb;
begin
  -- A forged normalized proof cannot be written by the service role.
  begin
    insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status,payload_hash,normalized_proof)
      values(fam,'twilio','forged:'||asg,'responder.accepted',jsonb_build_object('incident_id',inc,'assignment_id',asg,'responder_person_id',riya),
        'processed',repeat('9',64),true);
    raise exception 'FAIL forged normalized proof inserted';
  exception when insufficient_privilege then null; end;

  acc := public.record_responder_acceptance(fam,(select val from t_ctx where k='gather3'));
  pid := (acc->>'proof_event_id')::uuid;
  begin perform public.accept_responder_assignment_verified(fam,inc,asg,sharma,pid,20);
    raise exception 'FAIL accepted wrong responder';
  exception when insufficient_privilege then null; end;
  begin perform public.accept_responder_assignment_verified(fam,other_inc,asg,riya,pid,20);
    raise exception 'FAIL proof accepted for another incident';
  exception when no_data_found then null; end;
  begin perform public.accept_responder_assignment_verified('b4000000-0000-4000-8000-000000000002',inc,asg,riya,pid,20);
    raise exception 'FAIL cross-family acceptance';
  exception when no_data_found then null; end;
  if (select state from public.incidents where id=inc)<>'offered' then raise exception 'FAIL refused attempts changed the incident'; end if;

  v := public.accept_responder_assignment_verified(fam,inc,asg,riya,pid,20);
  if v->>'state'<>'accepted' then raise exception 'FAIL valid acceptance: %',v; end if;
  if (select owner_person_id from public.incidents where id=inc and state='accepted')<>riya then raise exception 'FAIL incident not owned by Riya'; end if;
  if (select verified_by_provider_event from public.assignments where id=asg and status='accepted')<>pid then raise exception 'FAIL assignment not bound to proof'; end if;

  v := public.accept_responder_assignment_verified(fam,inc,asg,riya,pid,20);
  if not coalesce((v->>'replayed')::boolean,false) then raise exception 'FAIL acceptance replay not idempotent: %',v; end if;

  -- Once accepted, a late decline is a no-op and does not reopen the chain.
  v := public.advance_urgent_offer(fam,inc,asg,'declined',3);
  if not coalesce((v->>'noop')::boolean,false) or (select state from public.incidents where id=inc)<>'accepted' then
    raise exception 'FAIL late decline changed an accepted incident: %',v;
  end if;
end $$;

-- ---------------------------------------------------------------- 4. record_medicine_dose
do $$
declare fam uuid:='b4000000-0000-4000-8000-000000000001'; maa uuid:='c4000000-0000-4000-8000-000000000001';
  med uuid:='d4000000-0000-4000-8000-000000000001'; unk uuid:='d4000000-0000-4000-8000-000000000002'; v jsonb;
begin
  v := public.record_medicine_dose(fam,med,maa,'confirmed_dose',1);
  if (v->>'remaining_count')::integer<>9 then raise exception 'FAIL expected remaining 9, got %',v; end if;
  v := public.record_medicine_dose(fam,med,maa,'missed_dose');
  if (v->>'remaining_count')::integer<>9 then raise exception 'FAIL missed dose changed count: %',v; end if;
  v := public.record_medicine_dose(fam,med,maa,'double_dose_reported');
  if (v->>'remaining_count')::integer<>7 then raise exception 'FAIL double dose: %',v; end if;
  v := public.record_medicine_dose(fam,med,maa,'count_reconciliation',2);
  if (v->>'remaining_count')::integer<>2 or not (v->>'is_low_stock')::boolean then raise exception 'FAIL reconciliation/low stock: %',v; end if;

  v := public.record_medicine_dose(fam,unk,maa,'confirmed_dose',1);
  if v->'remaining_count'<>'null'::jsonb or (v->>'is_low_stock')::boolean then raise exception 'FAIL unknown stock invented a count: %',v; end if;

  begin perform public.record_medicine_dose(fam,med,maa,'confirmed_dose',-5); raise exception 'FAIL negative dose accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.record_medicine_dose(fam,med,maa,'missed_dose',3); raise exception 'FAIL missed dose with a count accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.record_medicine_dose(fam,med,maa,'count_reconciliation',null); raise exception 'FAIL null reconciliation accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.record_medicine_dose(fam,med,maa,'skip_all',1); raise exception 'FAIL unsupported action accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.record_medicine_dose('b4000000-0000-4000-8000-000000000002',med,maa,'confirmed_dose',1); raise exception 'FAIL cross-family dose';
  exception when no_data_found then null; end;
end $$;

-- ---------------------------------------------------------------- 5. create_family_voice_post
do $$
declare fam uuid:='b4000000-0000-4000-8000-000000000001'; maa uuid:='c4000000-0000-4000-8000-000000000001';
  riya uuid:='c4000000-0000-4000-8000-000000000002'; sharma uuid:='c4000000-0000-4000-8000-000000000003';
  ok_consent uuid:='f4000000-0000-4000-8000-000000000001'; v jsonb; post uuid;
begin
  v := public.create_family_voice_post(fam,maa,riya,fam::text||'/voice/audio_01.m4a',ok_consent);
  if v->>'state'<>'queued' then raise exception 'FAIL expected queued, got %',v; end if;
  post := (v->>'voice_post_id')::uuid;
  if not exists (select 1 from sahaj_private.voice_content where voice_post_id=post and object_path=fam::text||'/voice/audio_01.m4a') then
    raise exception 'FAIL private voice content row missing';
  end if;

  begin perform public.create_family_voice_post(fam,maa,riya,fam::text||'/voice/audio_01.m4a',ok_consent); raise exception 'FAIL object posted twice';
  exception when unique_violation then null; end;
  begin perform public.create_family_voice_post(fam,maa,riya,fam::text||'/voice/../../etc/passwd',ok_consent); raise exception 'FAIL path traversal accepted';
  exception when insufficient_privilege then null; end;
  begin perform public.create_family_voice_post(fam,maa,riya,'b4000000-0000-4000-8000-000000000002/voice/audio_01.m4a',ok_consent); raise exception 'FAIL other family prefix accepted';
  exception when insufficient_privilege then null; end;
  begin perform public.create_family_voice_post(fam,maa,riya,fam::text||'/voice/never_uploaded.m4a',ok_consent); raise exception 'FAIL missing object accepted';
  exception when insufficient_privilege then null; end;
  begin perform public.create_family_voice_post(fam,maa,maa,fam::text||'/voice/reply_01.m4a',ok_consent); raise exception 'FAIL sender = recipient accepted';
  exception when insufficient_privilege then null; end;
  begin perform public.create_family_voice_post(fam,maa,'c4000000-0000-4000-8000-000000000004',fam::text||'/voice/reply_01.m4a',ok_consent); raise exception 'FAIL foreign recipient accepted';
  exception when insufficient_privilege then null; end;
  -- consent for Riya does not cover Sharma uncle
  begin perform public.create_family_voice_post(fam,maa,sharma,fam::text||'/voice/uncle_01.m4a',ok_consent); raise exception 'FAIL consent purpose mismatch accepted';
  exception when insufficient_privilege then null; end;
  -- Sharma uncle's yes was superseded by a later no
  begin perform public.create_family_voice_post(fam,maa,sharma,fam::text||'/voice/uncle_01.m4a','f4000000-0000-4000-8000-000000000002'); raise exception 'FAIL withdrawn consent accepted';
  exception when insufficient_privilege then null; end;
  -- Riya cannot pass off Maa's consent row as her own
  begin perform public.create_family_voice_post(fam,riya,maa,fam::text||'/voice/reply_01.m4a',ok_consent); raise exception 'FAIL another person''s consent accepted';
  exception when no_data_found then null; end;
  -- a reply must answer a post the recipient sent to the sender
  begin perform public.create_family_voice_post(fam,maa,riya,fam::text||'/voice/bad_reply.m4a',ok_consent,post); raise exception 'FAIL reply to own post accepted';
  exception when insufficient_privilege then null; end;
  insert into t_ctx values('post',post::text);
end $$;
reset role;
insert into public.consents(id,family_id,person_id,purpose,question,answer,version,created_at) values
 ('f4000000-0000-4000-8000-000000000005','b4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000002',
  'voice_share:c4000000-0000-4000-8000-000000000001','Share voice with Maa?',true,'v1',now()-interval '1 minute');
set local role service_role;
do $$
declare fam uuid:='b4000000-0000-4000-8000-000000000001'; maa uuid:='c4000000-0000-4000-8000-000000000001';
  riya uuid:='c4000000-0000-4000-8000-000000000002'; v jsonb;
begin
  v := public.create_family_voice_post(fam,riya,maa,fam::text||'/voice/reply_01.m4a','f4000000-0000-4000-8000-000000000005',(select val::uuid from t_ctx where k='post'));
  if v->>'state'<>'queued' then raise exception 'FAIL valid reply refused: %',v; end if;
end $$;
reset role;

select 'phase4_core1: PASS' as result;
rollback;
