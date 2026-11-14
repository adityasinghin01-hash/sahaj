-- Adversarial checks for 20261114201500_phase3_atomic_orchestration.sql. Synthetic data only; rolls back.
-- Run as an administrative role against a disposable database after all migrations. NOT yet executed in this
-- worktree (no PostgreSQL available); treat results as pending until run.
begin;
insert into public.families(id,name) values
 ('b3000000-0000-4000-8000-000000000001','Synthetic Phase3 A'),
 ('b3000000-0000-4000-8000-000000000002','Synthetic Phase3 B');
insert into public.people(id,family_id,display_name,role) values
 ('c3000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','Subject','parent'),
 ('c3000000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000001','Child One','child'),
 ('c3000000-0000-4000-8000-000000000003','b3000000-0000-4000-8000-000000000001','Child Two','child'),
 ('c3000000-0000-4000-8000-000000000005','b3000000-0000-4000-8000-000000000001','Responder','circle'),
 ('c3000000-0000-4000-8000-000000000004','b3000000-0000-4000-8000-000000000002','Other Family','parent');
insert into auth.users(id) values ('a3000000-0000-4000-8000-000000000002'),('a3000000-0000-4000-8000-000000000003');
insert into public.family_memberships(family_id,user_id,person_id,role) values
 ('b3000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-000000000002','child'),
 ('b3000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000003','c3000000-0000-4000-8000-000000000003','child');
insert into public.atlas_principals(id,family_id,label) values('a7000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','synthetic atlas');
insert into public.consents(id,family_id,person_id,purpose,question,answer,version) values
 ('f3000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','permission_setup','Synthetic?',true,'t1');
insert into public.calls(id,family_id,person_id,provider) values
 ('ca000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','synthetic'),
 ('ca000000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','synthetic');
insert into public.incidents(id,family_id,person_id,severity) values
 ('e5000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','urgent');
-- Permissions: principal acts for the subject. check_in one use; urgent two-person; record_audio.
insert into public.permissions(id,family_id,person_id,principal_id,action,decision,expires_at,consent_id,two_person_required,valid_from,
  period_start,period_end,max_uses,target_ids)
select ('a4000000-0000-4000-8000-00000000000'||n)::uuid,'b3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001',
  'a7000000-0000-4000-8000-000000000001',act,'allow',now()+interval '1 day','f3000000-0000-4000-8000-000000000001',two,
  now()-interval '1 hour',now()-interval '1 hour',now()+interval '1 day',mu,
  array['c3000000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-000000000002']
from (values(1,'check_in',false,1),(2,'urgent_responder',true,5),(3,'record_audio',false,5)) v(n,act,two,mu);
insert into public.raw_events(id,family_id,source,provider_event_id,event_type,status,payload_hash)
select ('e3000000-0000-4000-8000-00000000000'||n)::uuid,'b3000000-0000-4000-8000-000000000001','whatsapp','p3-'||n,'whatsapp.text','processed',repeat(n::text,64)
  from generate_series(1,6) n;
insert into public.workflow_jobs(id,family_id,raw_event_id,thread_id,workflow_kind,state,lease_token,lease_until)
select ('d3000000-0000-4000-8000-00000000000'||n)::uuid,'b3000000-0000-4000-8000-000000000001',
  ('e3000000-0000-4000-8000-00000000000'||n)::uuid,'t'||n,'core1.atlas','processing',
  ('99000000-0000-4000-8000-00000000000'||n)::uuid,now()+interval '5 minutes' from generate_series(1,6) n;

set local role service_role;
do $$declare
  fam uuid:='b3000000-0000-4000-8000-000000000001';subject uuid:='c3000000-0000-4000-8000-000000000001';
  h text:=repeat('a',64);res jsonb;res2 jsonb;used integer;ob uuid;rev text;fp text:=repeat('f',64);
  rq uuid[]:=array['71000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000003',
    '71000000-0000-4000-8000-000000000004','71000000-0000-4000-8000-000000000005','71000000-0000-4000-8000-000000000006']::uuid[];
  jb uuid[]:=array['d3000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000002','d3000000-0000-4000-8000-000000000003',
    'd3000000-0000-4000-8000-000000000004','d3000000-0000-4000-8000-000000000005','d3000000-0000-4000-8000-000000000006']::uuid[];
  lt uuid[]:=array['99000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000002','99000000-0000-4000-8000-000000000003',
    '99000000-0000-4000-8000-000000000004','99000000-0000-4000-8000-000000000005','99000000-0000-4000-8000-000000000006']::uuid[];
begin
  if has_function_privilege('anon','public.enqueue_authorized_command(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.enqueue_authorized_command(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.observe_delivery(uuid,uuid,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.wake_ready_interrupted_jobs(integer)','EXECUTE')
    or has_table_privilege('authenticated','public.atlas_principals','SELECT') then
    raise exception 'FAIL client can reach orchestration objects';
  end if;

  -- Request creation is idempotent and fixed to the verified subject; conflicting reuse is rejected.
  perform public.ensure_action_request(fam,jb[1],lt[1],rq[1],subject,'check_in',subject::text,fp);
  perform public.ensure_action_request(fam,jb[1],lt[1],rq[1],subject,'check_in',subject::text,fp);
  begin perform public.ensure_action_request(fam,jb[1],lt[1],rq[1],subject,'family_report',subject::text,fp);
    raise exception 'FAIL conflicting action request accepted'; exception when unique_violation then null; end;
  begin perform public.ensure_action_request(fam,jb[1],'99000000-0000-4000-8000-0000000000ff',rq[1],subject,'check_in',subject::text,fp);
    raise exception 'FAIL wrong lease created request'; exception when serialization_failure then null; end;
  rev:=sahaj_private.authorization_revision(fam,rq[1]);
  -- Stale or wrong lease, and another family's scope, cannot enqueue.
  begin perform public.enqueue_authorized_command(fam,jb[1],'99000000-0000-4000-8000-0000000000ff',rq[1],'check_in','k1','ct',h,rev);
    raise exception 'FAIL wrong lease accepted'; exception when serialization_failure then null; end;
  begin perform public.enqueue_authorized_command('b3000000-0000-4000-8000-000000000002',jb[1],lt[1],rq[1],'check_in','k1','ct',h,rev);
    raise exception 'FAIL cross-family job accepted'; exception when serialization_failure then null; end;
  res:=public.enqueue_authorized_command(fam,jb[1],lt[1],rq[1],'family_report','k0','ct',h,rev);
  if res->>'status'<>'denied' then raise exception 'FAIL action mismatch: %',res; end if;
  res:=public.enqueue_authorized_command(fam,jb[1],lt[1],rq[1],'payment','kp','ct',h,rev);
  if res->>'reason'<>'prohibited_action' then raise exception 'FAIL payment not blocked: %',res; end if;
  -- A stale snapshot revision is rejected without consuming anything.
  begin perform public.enqueue_authorized_command(fam,jb[1],lt[1],rq[1],'check_in','k1','ct',h,repeat('0',64));
    raise exception 'FAIL stale revision accepted'; exception when serialization_failure then null; end;
  -- Happy path.
  res:=public.enqueue_authorized_command(fam,jb[1],lt[1],rq[1],'check_in','k1','ct',h,rev);
  if res->>'status'<>'enqueued' then raise exception 'FAIL happy path: %',res; end if;
  ob:=(res->>'outbox_id')::uuid;
  -- Lost response recovery: same key and payload hash returns the same row without charging usage again.
  res2:=public.enqueue_authorized_command(fam,jb[1],lt[1],rq[1],'check_in','k1','ct2',h,'ignored-on-recovery');
  if res2->>'outbox_id'<>ob::text or res2->>'recovered'<>'true' then raise exception 'FAIL recovery: %',res2; end if;
  select used_count into used from public.permissions where id='a4000000-0000-4000-8000-000000000001';
  if used<>1 then raise exception 'FAIL usage charged % times',used; end if;
  begin perform public.enqueue_authorized_command(fam,jb[1],lt[1],rq[1],'check_in','k1','ct',repeat('b',64),rev);
    raise exception 'FAIL changed payload under same key accepted'; exception when unique_violation then null; end;
  res:=public.enqueue_authorized_command(fam,jb[1],lt[1],rq[1],'check_in','k1b','ct',h,sahaj_private.authorization_revision(fam,rq[1]));
  if res->>'status'<>'denied' then raise exception 'FAIL consumed request reused: %',res; end if;
  -- Usage cap: a second job cannot use the exhausted single-use permission.
  perform public.ensure_action_request(fam,jb[2],lt[2],rq[2],subject,'check_in',subject::text,fp);
  res:=public.enqueue_authorized_command(fam,jb[2],lt[2],rq[2],'check_in','k2','ct',h,sahaj_private.authorization_revision(fam,rq[2]));
  if res->>'reason'<>'limits_exceeded' then raise exception 'FAIL usage cap bypassed: %',res; end if;
  begin update public.action_requests set target_id='tampered' where id=rq[1];
    raise exception 'FAIL action request mutated'; exception when sqlstate '23000' then null; end;
  begin update public.action_requests set request_fingerprint=repeat('e',64) where id=rq[1];
    raise exception 'FAIL fingerprint mutated'; exception when sqlstate '23000' then null; end;

  -- Two-person urgent request: needs an incident, then two distinct active human approvers; the subject/principal never count.
  perform public.ensure_action_request(fam,jb[3],lt[3],rq[3],subject,'urgent_responder',subject::text,fp);
  res:=public.enqueue_authorized_command(fam,jb[3],lt[3],rq[3],'urgent_responder','k3','ct',h,sahaj_private.authorization_revision(fam,rq[3]));
  if res->>'reason'<>'incident_required' then raise exception 'FAIL urgent without incident: %',res; end if;
  res:=public.enqueue_authorized_command(fam,jb[3],lt[3],rq[3],'urgent_responder','k3','ct',h,sahaj_private.authorization_revision(fam,rq[3]),'e5000000-0000-4000-8000-000000000001');
  if res->>'reason'<>'approval_required' then raise exception 'FAIL no approvals: %',res; end if;
  insert into public.action_answers(family_id,action_request_id,approver_person_id,answer) values(fam,rq[3],'c3000000-0000-4000-8000-000000000002',true);
  res:=public.enqueue_authorized_command(fam,jb[3],lt[3],rq[3],'urgent_responder','k3','ct',h,sahaj_private.authorization_revision(fam,rq[3]),'e5000000-0000-4000-8000-000000000001');
  if res->>'reason'<>'approval_required' then raise exception 'FAIL one approval accepted: %',res; end if;
  update public.family_memberships set revoked_at=now() where person_id='c3000000-0000-4000-8000-000000000003';
  insert into public.action_answers(family_id,action_request_id,approver_person_id,answer) values(fam,rq[3],'c3000000-0000-4000-8000-000000000003',true);
  res:=public.enqueue_authorized_command(fam,jb[3],lt[3],rq[3],'urgent_responder','k3','ct',h,sahaj_private.authorization_revision(fam,rq[3]),'e5000000-0000-4000-8000-000000000001');
  if res->>'reason'<>'approval_required' then raise exception 'FAIL revoked approver counted: %',res; end if;
  update public.family_memberships set revoked_at=null where person_id='c3000000-0000-4000-8000-000000000003';
  -- A snapshot taken before a refusal appears is stale; once the refusal exists the request is denied outright.
  rev:=sahaj_private.authorization_revision(fam,rq[3]);
  insert into public.action_answers(family_id,action_request_id,approver_person_id,answer) values(fam,rq[3],subject,false);
  begin perform public.enqueue_authorized_command(fam,jb[3],lt[3],rq[3],'urgent_responder','k3','ct',h,rev,'e5000000-0000-4000-8000-000000000001');
    raise exception 'FAIL refusal inserted after snapshot ignored'; exception when serialization_failure then null; end;
  res:=public.enqueue_authorized_command(fam,jb[3],lt[3],rq[3],'urgent_responder','k3','ct',h,sahaj_private.authorization_revision(fam,rq[3]),'e5000000-0000-4000-8000-000000000001');
  if res->>'reason'<>'invalid_approval' then raise exception 'FAIL explicit refusal ignored: %',res; end if;
  delete from public.action_answers where action_request_id=rq[3] and approver_person_id=subject;
  res:=public.enqueue_authorized_command(fam,jb[3],lt[3],rq[3],'urgent_responder','k3','ct',h,sahaj_private.authorization_revision(fam,rq[3]),'e5000000-0000-4000-8000-000000000001');
  if res->>'status'<>'enqueued' then raise exception 'FAIL two approvals refused: %',res; end if;

  -- Consent: refusal wins; another call's grant never revives it; same-timestamp refusal wins.
  perform public.ensure_action_request(fam,jb[4],lt[4],rq[4],subject,'record_audio','ca000000-0000-4000-8000-000000000001',fp,subject);
  res:=public.enqueue_authorized_command(fam,jb[4],lt[4],rq[4],'record_audio','k4','ct',h,sahaj_private.authorization_revision(fam,rq[4]));
  if res->>'reason'<>'consent_required' then raise exception 'FAIL missing consent accepted: %',res; end if;
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at)
    values(fam,subject,'ca000000-0000-4000-8000-000000000002','call_recording','Synthetic?',true,'v1',now()-interval '1 minute');
  res:=public.enqueue_authorized_command(fam,jb[4],lt[4],rq[4],'record_audio','k4','ct',h,sahaj_private.authorization_revision(fam,rq[4]));
  if res->>'reason'<>'consent_required' then raise exception 'FAIL other-call consent accepted: %',res; end if;
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at)
    values(fam,subject,'ca000000-0000-4000-8000-000000000001','call_recording','Synthetic?',true,'v1',now()-interval '2 minutes'),
          (fam,subject,null,'call_recording','Synthetic?',false,'v1',now()-interval '1 minute');
  res:=public.enqueue_authorized_command(fam,jb[4],lt[4],rq[4],'record_audio','k4','ct',h,sahaj_private.authorization_revision(fam,rq[4]));
  if res->>'reason'<>'consent_required' then raise exception 'FAIL global refusal ignored: %',res; end if;
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at)
    values(fam,subject,'ca000000-0000-4000-8000-000000000001','call_recording','Synthetic?',true,'v1',now()-interval '30 seconds');
  res:=public.enqueue_authorized_command(fam,jb[4],lt[4],rq[4],'record_audio','k4','ct',h,sahaj_private.authorization_revision(fam,rq[4]));
  if res->>'status'<>'enqueued' then raise exception 'FAIL newer exact-call consent refused: %',res; end if;

  -- Overlapping deny row beats an allow row; foreign target is not permitted.
  perform public.ensure_action_request(fam,jb[5],lt[5],rq[5],subject,'check_in',subject::text,fp);
  insert into public.permissions(family_id,person_id,principal_id,action,decision,expires_at,consent_id,valid_from,period_start,period_end,max_uses)
    values(fam,subject,'a7000000-0000-4000-8000-000000000001','check_in','deny',now()+interval '1 day','f3000000-0000-4000-8000-000000000001',now()-interval '1 hour',now()-interval '1 hour',now()+interval '1 day',1);
  res:=public.enqueue_authorized_command(fam,jb[5],lt[5],rq[5],'check_in','k5','ct',h,sahaj_private.authorization_revision(fam,rq[5]));
  if res->>'reason'<>'permission_denied' then raise exception 'FAIL deny row lost to allow: %',res; end if;
  perform public.ensure_action_request(fam,jb[6],lt[6],rq[6],subject,'record_audio','ca000000-0000-4000-8000-0000000000ff',fp,subject);
  res:=public.enqueue_authorized_command(fam,jb[6],lt[6],rq[6],'record_audio','k6','ct',h,sahaj_private.authorization_revision(fam,rq[6]));
  if res->>'reason'<>'limits_exceeded' then raise exception 'FAIL foreign target accepted: %',res; end if;
end$$;

-- Delivery proof: outbox completion alone is never delivery; proof must name the exact outbox/request/action/target.
do $$declare ob uuid;obs jsonb;begin
  select id into ob from public.outbox where action_request_id='71000000-0000-4000-8000-000000000001';
  obs:=public.observe_delivery('b3000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001',ob);
  if (obs->>'verified')::boolean then raise exception 'FAIL delivery inferred without proof'; end if;
end$$;
reset role;
update public.outbox set status='completed',attempt_count=1 where action_request_id='71000000-0000-4000-8000-000000000001';
set local role service_role;
do $$declare ob uuid;obs jsonb;begin
  select id into ob from public.outbox where action_request_id='71000000-0000-4000-8000-000000000001';
  obs:=public.observe_delivery('b3000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001',ob);
  if (obs->>'verified')::boolean then raise exception 'FAIL completed outbox treated as delivered'; end if;
end$$;
reset role;
insert into public.raw_events(family_id,source,provider_event_id,event_type,status,payload_hash,metadata)
select family_id,'twilio','proof-wrong-target','delivery.confirmed','processed',repeat('1',64),
  jsonb_build_object('outbox_id',id,'action_request_id',action_request_id,'action','check_in','outcome','delivered','target_id','someone-else')
  from public.outbox where action_request_id='71000000-0000-4000-8000-000000000001';
set local role service_role;
do $$declare ob uuid;obs jsonb;begin
  select id into ob from public.outbox where action_request_id='71000000-0000-4000-8000-000000000001';
  obs:=public.observe_delivery('b3000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001',ob);
  if (obs->>'verified')::boolean then raise exception 'FAIL wrong-target proof accepted'; end if;
end$$;
reset role;
insert into public.raw_events(family_id,source,provider_event_id,event_type,status,payload_hash,metadata)
select family_id,'twilio','proof-good','delivery.confirmed','processed',repeat('2',64),
  jsonb_build_object('outbox_id',id,'action_request_id',action_request_id,'action','check_in','outcome','delivered','target_id','c3000000-0000-4000-8000-000000000001')
  from public.outbox where action_request_id='71000000-0000-4000-8000-000000000001';
set local role service_role;
do $$declare ob uuid;obs jsonb;begin
  select id into ob from public.outbox where action_request_id='71000000-0000-4000-8000-000000000001';
  obs:=public.observe_delivery('b3000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001',ob);
  if obs->>'status'<>'delivered' or not (obs->>'verified')::boolean then raise exception 'FAIL bound proof refused: %',obs; end if;
  obs:=public.observe_delivery('b3000000-0000-4000-8000-000000000002','d3000000-0000-4000-8000-000000000001',ob);
  if (obs->>'verified')::boolean then raise exception 'FAIL cross-family observe'; end if;
end$$;
-- Urgent: delivered proof without a verified responder acceptance stays unaccepted.
reset role;
update public.outbox set status='completed',attempt_count=1 where action_request_id='71000000-0000-4000-8000-000000000003';
insert into public.raw_events(id,family_id,source,provider_event_id,event_type,status,payload_hash,metadata)
select 'e6000000-0000-4000-8000-000000000001',family_id,'twilio','proof-urgent','delivery.confirmed','processed',repeat('3',64),
  jsonb_build_object('outbox_id',id,'action_request_id',action_request_id,'action','urgent_responder','outcome','delivered','target_id','c3000000-0000-4000-8000-000000000001')
  from public.outbox where action_request_id='71000000-0000-4000-8000-000000000003';
set local role service_role;
do $$declare ob uuid;obs jsonb;begin
  select id into ob from public.outbox where action_request_id='71000000-0000-4000-8000-000000000003';
  obs:=public.observe_delivery('b3000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000003',ob);
  if obs->>'status'<>'delivered' or (obs->>'responderAccepted')::boolean then raise exception 'FAIL urgent accepted without responder proof: %',obs; end if;
end$$;
reset role;
-- Accepted assignment with a provider event naming a different outbox must not count.
insert into public.raw_events(id,family_id,source,provider_event_id,event_type,status,payload_hash,metadata)
select 'e6000000-0000-4000-8000-000000000002',family_id,'twilio','accept-wrong','responder.accepted','processed',repeat('4',64),
  jsonb_build_object('outbox_id','00000000-0000-4000-8000-000000000000','action_request_id',action_request_id,'incident_id','e5000000-0000-4000-8000-000000000001','responder_person_id','c3000000-0000-4000-8000-000000000005')
  from public.outbox where action_request_id='71000000-0000-4000-8000-000000000003';
insert into public.assignments(family_id,incident_id,person_id,expires_at,status,accepted_at,verified_by_provider_event)
  values('b3000000-0000-4000-8000-000000000001','e5000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000005',now()+interval '1 hour','accepted',now(),'e6000000-0000-4000-8000-000000000002');
set local role service_role;
do $$declare ob uuid;obs jsonb;begin
  select id into ob from public.outbox where action_request_id='71000000-0000-4000-8000-000000000003';
  obs:=public.observe_delivery('b3000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000003',ob);
  if (obs->>'responderAccepted')::boolean then raise exception 'FAIL foreign acceptance proof counted: %',obs; end if;
end$$;
reset role;
rollback;
