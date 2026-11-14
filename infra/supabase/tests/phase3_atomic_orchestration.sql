-- Adversarial checks for 20261114201500_phase3_atomic_orchestration.sql. Synthetic data only; rolls back.
-- Run as an administrative role against a disposable database after all migrations.
begin;
insert into public.families(id,name) values
 ('b3000000-0000-4000-8000-000000000001','Synthetic Phase3 A'),
 ('b3000000-0000-4000-8000-000000000002','Synthetic Phase3 B');
insert into public.people(id,family_id,display_name,role) values
 ('c3000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','Actor','parent'),
 ('c3000000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000001','Child One','child'),
 ('c3000000-0000-4000-8000-000000000003','b3000000-0000-4000-8000-000000000001','Child Two','child'),
 ('c3000000-0000-4000-8000-000000000004','b3000000-0000-4000-8000-000000000002','Other Family','parent');
insert into auth.users(id) values ('a3000000-0000-4000-8000-000000000002'),('a3000000-0000-4000-8000-000000000003');
insert into public.family_memberships(family_id,user_id,person_id,role) values
 ('b3000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-000000000002','child'),
 ('b3000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000003','c3000000-0000-4000-8000-000000000003','child');
insert into public.consents(id,family_id,person_id,purpose,question,answer,version) values
 ('f3000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','permission_setup','Synthetic?',true,'t1');
-- Permissions: A check_in one use; B urgent_responder two-person; C record_audio.
insert into public.permissions(id,family_id,person_id,action,decision,expires_at,consent_id,two_person_required,valid_from,
  period_start,period_end,max_uses,target_ids) values
 ('a4000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','check_in','allow',now()+interval '1 day','f3000000-0000-4000-8000-000000000001',false,now()-interval '1 hour',now()-interval '1 hour',now()+interval '1 day',1,array['c3000000-0000-4000-8000-000000000001']),
 ('a4000000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','urgent_responder','allow',now()+interval '1 day','f3000000-0000-4000-8000-000000000001',true,now()-interval '1 hour',now()-interval '1 hour',now()+interval '1 day',5,array['c3000000-0000-4000-8000-000000000001']),
 ('a4000000-0000-4000-8000-000000000003','b3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','record_audio','allow',now()+interval '1 day','f3000000-0000-4000-8000-000000000001',false,now()-interval '1 hour',now()-interval '1 hour',now()+interval '1 day',5,array['c3000000-0000-4000-8000-000000000001']);
-- Jobs (raw event -> job), then leases.
insert into public.raw_events(id,family_id,source,provider_event_id,event_type,status,payload_hash) values
 ('e3000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','whatsapp','p3-1','whatsapp.text','processed',repeat('a',64)),
 ('e3000000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000001','whatsapp','p3-2','whatsapp.text','processed',repeat('b',64)),
 ('e3000000-0000-4000-8000-000000000003','b3000000-0000-4000-8000-000000000001','whatsapp','p3-3','whatsapp.text','processed',repeat('c',64)),
 ('e3000000-0000-4000-8000-000000000004','b3000000-0000-4000-8000-000000000001','whatsapp','p3-4','whatsapp.text','processed',repeat('d',64));
insert into public.workflow_jobs(id,family_id,raw_event_id,thread_id,workflow_kind,state,lease_token,lease_until)
select ('d3000000-0000-4000-8000-00000000000'||n)::uuid,'b3000000-0000-4000-8000-000000000001',
  ('e3000000-0000-4000-8000-00000000000'||n)::uuid,'t'||n,'core1.atlas','processing',
  ('99000000-0000-4000-8000-00000000000'||n)::uuid,now()+interval '5 minutes' from generate_series(1,4) n;

set local role service_role;
do $$declare
  fam uuid:='b3000000-0000-4000-8000-000000000001';actor uuid:='c3000000-0000-4000-8000-000000000001';
  res jsonb;res2 jsonb;used integer;ob uuid;
  r1 uuid:='71000000-0000-4000-8000-000000000001';r2 uuid:='71000000-0000-4000-8000-000000000002';
  r3 uuid:='71000000-0000-4000-8000-000000000003';r4 uuid:='71000000-0000-4000-8000-000000000004';
begin
  -- Privileges: clients cannot reach any function.
  if has_function_privilege('anon','public.enqueue_authorized_command(uuid,uuid,uuid,uuid,text,text,text,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.enqueue_authorized_command(uuid,uuid,uuid,uuid,text,text,text,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.observe_delivery(uuid,uuid,uuid)','EXECUTE') then
    raise exception 'FAIL client can execute orchestration RPC';
  end if;

  -- Happy path with one-use permission.
  perform public.ensure_action_request(fam,'d3000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000001',r1,actor,'check_in',actor::text);
  perform public.ensure_action_request(fam,'d3000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000001',r1,actor,'check_in',actor::text);
  begin
    perform public.ensure_action_request(fam,'d3000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000001',r1,actor,'family_report',actor::text);
    raise exception 'FAIL conflicting action request accepted';
  exception when unique_violation then null; end;
  -- Stale or wrong lease cannot enqueue.
  begin
    perform public.enqueue_authorized_command(fam,'d3000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-0000000000ff',r1,'check_in','k1','ct');
    raise exception 'FAIL wrong lease accepted';
  exception when serialization_failure then null; end;
  -- Cross-family job/request cannot be used.
  begin
    perform public.enqueue_authorized_command('b3000000-0000-4000-8000-000000000002','d3000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000001',r1,'check_in','k1','ct');
    raise exception 'FAIL cross-family job accepted';
  exception when serialization_failure then null; end;
  -- Action mismatch (model could not smuggle another action onto an approved request).
  res:=public.enqueue_authorized_command(fam,'d3000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000001',r1,'family_report','k0','ct');
  if res->>'status'<>'denied' then raise exception 'FAIL action mismatch: %',res; end if;
  -- Prohibited actions are always denied and write nothing.
  res:=public.enqueue_authorized_command(fam,'d3000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000001',r1,'payment','kp','ct');
  if res->>'reason'<>'prohibited_action' then raise exception 'FAIL payment not blocked: %',res; end if;
  res:=public.enqueue_authorized_command(fam,'d3000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000001',r1,'check_in','k1','ct');
  if res->>'status'<>'enqueued' then raise exception 'FAIL happy path: %',res; end if;
  ob:=(res->>'outbox_id')::uuid;
  -- Lost response recovery: same key returns same row and does not spend the permission again.
  res2:=public.enqueue_authorized_command(fam,'d3000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000001',r1,'check_in','k1','ct');
  if res2->>'outbox_id'<>ob::text or res2->>'recovered'<>'true' then raise exception 'FAIL recovery: %',res2; end if;
  select used_count into used from public.permissions where id='a4000000-0000-4000-8000-000000000001';
  if used<>1 then raise exception 'FAIL usage charged % times',used; end if;
  -- Different key for the consumed request is refused.
  res:=public.enqueue_authorized_command(fam,'d3000000-0000-4000-8000-000000000001','99000000-0000-4000-8000-000000000001',r1,'check_in','k1b','ct');
  if res->>'status'<>'denied' then raise exception 'FAIL consumed request reused: %',res; end if;
  -- Usage cap: second job cannot use the exhausted one-use permission.
  perform public.ensure_action_request(fam,'d3000000-0000-4000-8000-000000000002','99000000-0000-4000-8000-000000000002',r2,actor,'check_in',actor::text);
  res:=public.enqueue_authorized_command(fam,'d3000000-0000-4000-8000-000000000002','99000000-0000-4000-8000-000000000002',r2,'check_in','k2','ct');
  if res->>'reason'<>'limits_exceeded' then raise exception 'FAIL usage cap bypassed: %',res; end if;
  -- Immutable approved request fields.
  begin
    update public.action_requests set target_id='tampered' where id=r1;
    raise exception 'FAIL action request mutated';
  exception when sqlstate '23000' then null; end;

  -- Two-person: none, one, then two distinct active non-actor approvers.
  perform public.ensure_action_request(fam,'d3000000-0000-4000-8000-000000000003','99000000-0000-4000-8000-000000000003',r3,actor,'urgent_responder',actor::text);
  res:=public.enqueue_authorized_command(fam,'d3000000-0000-4000-8000-000000000003','99000000-0000-4000-8000-000000000003',r3,'urgent_responder','k3','ct');
  if res->>'reason'<>'approval_required' then raise exception 'FAIL no approvals: %',res; end if;
  insert into public.action_answers(family_id,action_request_id,approver_person_id,answer) values(fam,r3,'c3000000-0000-4000-8000-000000000002',true);
  res:=public.enqueue_authorized_command(fam,'d3000000-0000-4000-8000-000000000003','99000000-0000-4000-8000-000000000003',r3,'urgent_responder','k3','ct');
  if res->>'reason'<>'approval_required' then raise exception 'FAIL one approval accepted: %',res; end if;
  -- Actor self-approval does not count.
  insert into public.action_answers(family_id,action_request_id,approver_person_id,answer) values(fam,r3,actor,true);
  res:=public.enqueue_authorized_command(fam,'d3000000-0000-4000-8000-000000000003','99000000-0000-4000-8000-000000000003',r3,'urgent_responder','k3','ct');
  if res->>'reason'<>'approval_required' then raise exception 'FAIL self approval counted: %',res; end if;
  -- A revoked approver does not count.
  update public.family_memberships set revoked_at=now() where person_id='c3000000-0000-4000-8000-000000000003';
  insert into public.action_answers(family_id,action_request_id,approver_person_id,answer) values(fam,r3,'c3000000-0000-4000-8000-000000000003',true);
  res:=public.enqueue_authorized_command(fam,'d3000000-0000-4000-8000-000000000003','99000000-0000-4000-8000-000000000003',r3,'urgent_responder','k3','ct');
  if res->>'reason'<>'approval_required' then raise exception 'FAIL revoked approver counted: %',res; end if;
  update public.family_memberships set revoked_at=null where person_id='c3000000-0000-4000-8000-000000000003';
  res:=public.enqueue_authorized_command(fam,'d3000000-0000-4000-8000-000000000003','99000000-0000-4000-8000-000000000003',r3,'urgent_responder','k3','ct');
  if res->>'status'<>'enqueued' then raise exception 'FAIL two approvals refused: %',res; end if;
  -- Target outside permission target list.
  perform public.ensure_action_request(fam,'d3000000-0000-4000-8000-000000000004','99000000-0000-4000-8000-000000000004',r4,actor,'record_audio','c3000000-0000-4000-8000-000000000004');
  res:=public.enqueue_authorized_command(fam,'d3000000-0000-4000-8000-000000000004','99000000-0000-4000-8000-000000000004',r4,'record_audio','k4','ct');
  if res->>'reason'<>'limits_exceeded' then raise exception 'FAIL foreign target accepted: %',res; end if;
end$$;

-- Delivery proof: outbox completion alone is never delivery.
do $$declare
  fam uuid:='b3000000-0000-4000-8000-000000000001';ob uuid;obs jsonb;rid uuid:='71000000-0000-4000-8000-000000000001';
begin
  select id into ob from public.outbox where action_request_id=rid;
  obs:=public.observe_delivery(fam,'d3000000-0000-4000-8000-000000000001',ob);
  if (obs->>'verified')::boolean then raise exception 'FAIL delivery inferred without proof'; end if;
end$$;
reset role;
update public.outbox set status='completed',attempt_count=1 where action_request_id='71000000-0000-4000-8000-000000000001';
set local role service_role;
do $$declare
  fam uuid:='b3000000-0000-4000-8000-000000000001';ob uuid;obs jsonb;rid uuid:='71000000-0000-4000-8000-000000000001';
begin
  select id into ob from public.outbox where action_request_id=rid;
  obs:=public.observe_delivery(fam,'d3000000-0000-4000-8000-000000000001',ob);
  if (obs->>'verified')::boolean then raise exception 'FAIL completed outbox treated as delivered'; end if;
end$$;
reset role;
-- Proof for a different action must not count.
insert into public.raw_events(family_id,source,provider_event_id,event_type,status,payload_hash,metadata)
select family_id,'twilio','proof-wrong','delivery.confirmed','processed',repeat('1',64),
  jsonb_build_object('outbox_id',id,'action_request_id',action_request_id,'action','urgent_responder','outcome','delivered')
  from public.outbox where action_request_id='71000000-0000-4000-8000-000000000001';
set local role service_role;
do $$declare ob uuid;obs jsonb;begin
  select id into ob from public.outbox where action_request_id='71000000-0000-4000-8000-000000000001';
  obs:=public.observe_delivery('b3000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001',ob);
  if (obs->>'verified')::boolean then raise exception 'FAIL mismatched-action proof accepted'; end if;
end$$;
reset role;
insert into public.raw_events(family_id,source,provider_event_id,event_type,status,payload_hash,metadata)
select family_id,'twilio','proof-good','delivery.confirmed','processed',repeat('2',64),
  jsonb_build_object('outbox_id',id,'action_request_id',action_request_id,'action','check_in','outcome','delivered')
  from public.outbox where action_request_id='71000000-0000-4000-8000-000000000001';
set local role service_role;
do $$declare ob uuid;obs jsonb;begin
  select id into ob from public.outbox where action_request_id='71000000-0000-4000-8000-000000000001';
  obs:=public.observe_delivery('b3000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001',ob);
  if obs->>'status'<>'delivered' or not (obs->>'verified')::boolean then raise exception 'FAIL bound proof refused: %',obs; end if;
  -- Another family's job id cannot observe it.
  obs:=public.observe_delivery('b3000000-0000-4000-8000-000000000002','d3000000-0000-4000-8000-000000000001',ob);
  if (obs->>'verified')::boolean then raise exception 'FAIL cross-family observe'; end if;
end$$;
reset role;
rollback;
