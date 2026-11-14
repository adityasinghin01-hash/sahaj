-- Combined Phase 2 + Phase 3 acceptance, driven ONLY through the real functions of both lanes (no copied predicates).
-- Order: 20261114201500 -> 20261114201600 (Phase 2) -> 20261114210000 -> 20261114213000. Synthetic data only; rolls back.
-- Run as an administrative role on a disposable joined-schema database, with both dispatch triggers active.
--
-- 1. check_in: Atlas enqueue (atomic binding) -> claim_outbox -> claim_dispatch (Phase 3 trigger authorizes) -> complete_dispatch
--    -> raw Sarvam no_answer callback -> Phase 2 record_delivery_proof -> Phase 3 observe_delivery = failed.
-- 2. urgent_responder: two approvals -> enqueue bound to the offered responder -> Twilio dispatch -> raw Gather press ->
--    Phase 2 record_responder_acceptance + accept_assignment_verified -> Phase 3 wake + observe_delivery = accepted.
-- 4. Permission scope narrowed/reassigned after enqueue (targets, principal, person, action, amount, vendor, items) -> refused at claim.
-- 3. Revocation between enqueue and claim: permission revoked, permission period ended, approver membership revoked ->
--    claim_dispatch refused atomically (no ledger row, so no provider call is possible).
begin;
insert into auth.users(id) values ('a5000000-0000-4000-8000-000000000001'),('a5000000-0000-4000-8000-000000000002');
insert into public.families(id,name) values('b5000000-0000-4000-8000-000000000001','Synthetic Combined');
insert into public.people(id,family_id,display_name,role) values
 ('c5000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000001','Subject','parent'),
 ('c5000000-0000-4000-8000-000000000002','b5000000-0000-4000-8000-000000000001','Approver One','child'),
 ('c5000000-0000-4000-8000-000000000003','b5000000-0000-4000-8000-000000000001','Approver Two','child'),
 ('c5000000-0000-4000-8000-000000000004','b5000000-0000-4000-8000-000000000001','Responder','circle');
insert into public.family_memberships(family_id,user_id,person_id,role) values
 ('b5000000-0000-4000-8000-000000000001','a5000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000002','child'),
 ('b5000000-0000-4000-8000-000000000001','a5000000-0000-4000-8000-000000000002','c5000000-0000-4000-8000-000000000003','child');
insert into public.atlas_principals(id,family_id,label) values('a7500000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000001','synthetic');
insert into public.consents(id,family_id,person_id,purpose,question,answer,version) values
 ('f5000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','permission_setup','q',true,'v1');
insert into public.provider_identities(id,family_id,person_id,source,account_id,external_id_hash,binding_kind,contact_ciphertext) values
 ('f6500000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','sarvam','app-1',repeat('1',64),'contact','synthetic-ct'),
 ('f6500000-0000-4000-8000-000000000002','b5000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000004','twilio','AC-synthetic',repeat('2',64),'contact','synthetic-ct');
insert into public.permissions(id,family_id,person_id,principal_id,action,decision,expires_at,consent_id,two_person_required,valid_from,period_start,period_end,max_uses,target_ids)
select ('a4500000-0000-4000-8000-00000000000'||n)::uuid,'b5000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','a7500000-0000-4000-8000-000000000001',
  act,'allow',now()+interval '1 day','f5000000-0000-4000-8000-000000000001',two,now()-interval '1 hour',now()-interval '1 hour',now()+interval '1 day',10,
  array['c5000000-0000-4000-8000-000000000001']
from (values(1,'check_in',false),(2,'urgent_responder',true)) v(n,act,two);
insert into public.incidents(id,family_id,person_id,severity) values('e7000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','urgent');
insert into public.assignments(id,family_id,incident_id,person_id,expires_at) values
 ('a9500000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000001','e7000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000004',now()+interval '1 hour'),
 ('a9500000-0000-4000-8000-000000000002','b5000000-0000-4000-8000-000000000001','e7000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000004',now()+interval '1 hour');
insert into public.raw_events(id,family_id,source,provider_event_id,event_type,status,payload_hash)
select ('e5500000-0000-4000-8000-00000000000'||n)::uuid,'b5000000-0000-4000-8000-000000000001','whatsapp','cmb-'||n,'whatsapp.text','processed',repeat(n::text,64)
  from generate_series(1,5) n;
insert into public.workflow_jobs(id,family_id,raw_event_id,thread_id,workflow_kind,state,lease_token,lease_until)
select ('d5000000-0000-4000-8000-00000000000'||n)::uuid,'b5000000-0000-4000-8000-000000000001',('e5500000-0000-4000-8000-00000000000'||n)::uuid,
  'c'||n,'core1.atlas','processing',('95000000-0000-4000-8000-00000000000'||n)::uuid,now()+interval '10 minutes' from generate_series(1,5) n;
create temporary table t_ctx(k text primary key,v text) on commit drop;
grant all on t_ctx to service_role;

set local role service_role;
-- ---------------------------------------------------------------- 1. check_in -> Sarvam no_answer -> failed
do $$declare fam uuid:='b5000000-0000-4000-8000-000000000001';s uuid:='c5000000-0000-4000-8000-000000000001';
  rq uuid:='75000000-0000-4000-8000-000000000001';j uuid:='d5000000-0000-4000-8000-000000000001';jl uuid:='95000000-0000-4000-8000-000000000001';
  res jsonb;ob uuid;cl uuid;lease uuid;k text;st text;raw public.raw_events;proof jsonb;obs jsonb;
begin
  perform public.ensure_action_request(fam,j,jl,rq,s,'check_in',s::text,repeat('a',64));
  res:=public.enqueue_authorized_command(fam,j,jl,rq,'check_in','cmb-k1','ct',repeat('b',64),sahaj_private.authorization_revision(fam,rq));
  if res->>'status'<>'enqueued' then raise exception 'FAIL enqueue: %',res; end if;
  ob:=(res->>'outbox_id')::uuid;
  select call_id into cl from public.dispatch_bindings where outbox_id=ob;
  if cl is null then raise exception 'FAIL no bound call'; end if;
  select o.lease_token into lease from public.claim_outbox('cmb-worker',100,120) o where o.id=ob;
  if lease is null then raise exception 'FAIL outbox not claimable'; end if;
  k:='dispatch:'||ob||':a1';
  st:=public.claim_dispatch_contact(fam,s,k,'sarvam','sarvam.outbound_call',ob,lease,cl,'f6500000-0000-4000-8000-000000000001','app-1',repeat('1',64));
  if st<>'claimed' then raise exception 'FAIL claim_dispatch: %',st; end if;
  if public.complete_dispatch(fam,k,'att-cmb-1','app-1',repeat('d',64),true)<>'dispatched' then raise exception 'FAIL complete_dispatch'; end if;
  if not public.finish_outbox(ob,lease,true,null) then raise exception 'FAIL finish_outbox'; end if;
  obs:=public.observe_delivery(fam,j,ob);
  if (obs->>'verified')::boolean then raise exception 'FAIL dispatched treated as delivered: %',obs; end if;
  raw:=public.ingest_raw_event('sarvam','app-1:outbound:att-cmb-1:no_answer','sarvam.outbound',fam,
    jsonb_build_object('person_id',s,'status','no_answer','call_id',cl),repeat('c',64),null);
  insert into t_ctx values('raw1',raw.id::text),('ob1',ob::text);
end$$;
reset role;
update public.raw_events set status='processed',processed_at=now() where id=(select v::uuid from t_ctx where k='raw1');
set local role service_role;
do $$declare fam uuid:='b5000000-0000-4000-8000-000000000001';ob uuid:=(select v::uuid from t_ctx where k='ob1');proof jsonb;obs jsonb;
begin
  proof:=public.record_delivery_proof(fam,(select v::uuid from t_ctx where k='raw1'),'confirmed_not_sent');
  if proof->>'outbox_id'<>ob::text then raise exception 'FAIL Phase 2 proof not produced: %',proof; end if;
  obs:=public.observe_delivery(fam,'d5000000-0000-4000-8000-000000000001',ob);
  if obs->>'status'<>'failed' or not (obs->>'verified')::boolean then raise exception 'FAIL Phase 3 did not consume Phase 2 proof: %',obs; end if;
  if sahaj_private.outbox_proof(ob)<>'not_sent' then raise exception 'FAIL outbox_proof'; end if;
end$$;

-- ---------------------------------------------------------------- 2. urgent -> Gather acceptance -> accepted
do $$declare fam uuid:='b5000000-0000-4000-8000-000000000001';s uuid:='c5000000-0000-4000-8000-000000000001';resp uuid:='c5000000-0000-4000-8000-000000000004';
  rq uuid:='75000000-0000-4000-8000-000000000002';j uuid:='d5000000-0000-4000-8000-000000000002';jl uuid:='95000000-0000-4000-8000-000000000002';
  res jsonb;ob uuid;cl uuid;lease uuid;k text;raw public.raw_events;
begin
  perform public.ensure_action_request(fam,j,jl,rq,s,'urgent_responder',s::text,repeat('a',64));
  insert into public.action_answers(family_id,action_request_id,approver_person_id,answer) values
    (fam,rq,'c5000000-0000-4000-8000-000000000002',true),(fam,rq,'c5000000-0000-4000-8000-000000000003',true);
  res:=public.enqueue_authorized_command(fam,j,jl,rq,'urgent_responder','cmb-k2','ct',repeat('b',64),sahaj_private.authorization_revision(fam,rq),
    'e7000000-0000-4000-8000-000000000001','a9500000-0000-4000-8000-000000000001');
  if res->>'status'<>'enqueued' then raise exception 'FAIL urgent enqueue: %',res; end if;
  ob:=(res->>'outbox_id')::uuid;
  select call_id into cl from public.dispatch_bindings where outbox_id=ob and person_id=resp and assignment_id='a9500000-0000-4000-8000-000000000001';
  if cl is null then raise exception 'FAIL urgent binding'; end if;
  select o.lease_token into lease from public.claim_outbox('cmb-worker',100,120) o where o.id=ob;
  k:='dispatch:'||ob||':a1';
  if public.claim_dispatch_contact(fam,resp,k,'twilio','twilio.create_call',ob,lease,cl,'f6500000-0000-4000-8000-000000000002','AC-synthetic',repeat('2',64))<>'claimed' then raise exception 'FAIL urgent claim'; end if;
  if public.complete_dispatch(fam,k,'CA'||repeat('b',32),'AC-synthetic',repeat('e',64),true)<>'dispatched' then raise exception 'FAIL urgent complete'; end if;
  perform public.finish_outbox(ob,lease,true,null);
  raw:=public.ingest_raw_event('twilio','AC-synthetic:gather:CA'||repeat('b',32),'twilio.gather.response',fam,
    jsonb_build_object('digit','1','call_id',cl,'person_id',resp),repeat('f',64),null);
  insert into t_ctx values('ob2',ob::text),('gather',raw.provider_event_id);
end$$;
reset role;
update public.workflow_jobs set state='interrupted',lease_token=null,lease_until=null,interrupt_ref='delivery_pending:cmb'
  where id='d5000000-0000-4000-8000-000000000002';
set local role service_role;
do $$declare fam uuid:='b5000000-0000-4000-8000-000000000001';ob uuid:=(select v::uuid from t_ctx where k='ob2');obs jsonb;acc jsonb;
begin
  obs:=public.observe_delivery(fam,'d5000000-0000-4000-8000-000000000002',ob);
  if (obs->>'verified')::boolean then raise exception 'FAIL urgent observed before acceptance: %',obs; end if;
  if public.wake_ready_interrupted_jobs(20)<>0 then raise exception 'FAIL urgent woke before acceptance'; end if;
  acc:=public.record_responder_acceptance(fam,(select v from t_ctx where k='gather'));
  if not public.accept_assignment_verified(fam,'a9500000-0000-4000-8000-000000000001',(acc->>'proof_event_id')::uuid) then
    raise exception 'FAIL Phase 2 acceptance not recorded: %',acc;
  end if;
  obs:=public.observe_delivery(fam,'d5000000-0000-4000-8000-000000000002',ob);
  if obs->>'status'<>'delivered' or not (obs->>'responderAccepted')::boolean or not (obs->>'verified')::boolean then
    raise exception 'FAIL Phase 3 did not consume Phase 2 acceptance: %',obs;
  end if;
  if public.wake_ready_interrupted_jobs(20)<>1 then raise exception 'FAIL accepted urgent job not woken'; end if;
end$$;

-- ---------------------------------------------------------------- 3. revocation races resolve at the claim
do $$declare fam uuid:='b5000000-0000-4000-8000-000000000001';s uuid:='c5000000-0000-4000-8000-000000000001';resp uuid:='c5000000-0000-4000-8000-000000000004';
  res jsonb;ob uuid;cl uuid;lease uuid;n integer;
begin
  -- 3a permission revoked after commit
  perform public.ensure_action_request(fam,'d5000000-0000-4000-8000-000000000003','95000000-0000-4000-8000-000000000003','75000000-0000-4000-8000-000000000003',s,'check_in',s::text,repeat('a',64));
  res:=public.enqueue_authorized_command(fam,'d5000000-0000-4000-8000-000000000003','95000000-0000-4000-8000-000000000003','75000000-0000-4000-8000-000000000003',
    'check_in','cmb-k3','ct',repeat('b',64),sahaj_private.authorization_revision(fam,'75000000-0000-4000-8000-000000000003'));
  ob:=(res->>'outbox_id')::uuid; select call_id into cl from public.dispatch_bindings where outbox_id=ob;
  select o.lease_token into lease from public.claim_outbox('cmb-worker',100,120) o where o.id=ob;
  update public.permissions set revoked_at=now() where id='a4500000-0000-4000-8000-000000000001';
  if (public.recheck_dispatch_authorization(ob,lease))->>'reason'<>'permission_not_live' then raise exception 'FAIL recheck missed revocation'; end if;
  begin
    perform public.claim_dispatch_contact(fam,s,'dispatch:'||ob||':a1','sarvam','sarvam.outbound_call',ob,lease,cl,'f6500000-0000-4000-8000-000000000001','app-1',repeat('1',64));
    raise exception 'FAIL claim after revocation';
  exception when sqlstate '42501' then if sqlerrm not like 'dispatch_not_authorized:permission_not_live%' then raise; end if; end;
  select count(*) into n from public.dispatch_ledger where outbox_id=ob;
  if n<>0 then raise exception 'FAIL ledger row written after revocation'; end if;
  update public.permissions set revoked_at=null,period_end=now()-interval '1 second' where id='a4500000-0000-4000-8000-000000000001';
  begin
    perform public.claim_dispatch_contact(fam,s,'dispatch:'||ob||':a1','sarvam','sarvam.outbound_call',ob,lease,cl,'f6500000-0000-4000-8000-000000000001','app-1',repeat('1',64));
    raise exception 'FAIL claim after period end';
  exception when sqlstate '42501' then if sqlerrm not like 'dispatch_not_authorized:permission_not_live%' then raise; end if; end;
  -- 3b approver membership revoked after an urgent commit
  perform public.ensure_action_request(fam,'d5000000-0000-4000-8000-000000000004','95000000-0000-4000-8000-000000000004','75000000-0000-4000-8000-000000000004',s,'urgent_responder',s::text,repeat('a',64));
  insert into public.action_answers(family_id,action_request_id,approver_person_id,answer) values
    (fam,'75000000-0000-4000-8000-000000000004','c5000000-0000-4000-8000-000000000002',true),(fam,'75000000-0000-4000-8000-000000000004','c5000000-0000-4000-8000-000000000003',true);
  res:=public.enqueue_authorized_command(fam,'d5000000-0000-4000-8000-000000000004','95000000-0000-4000-8000-000000000004','75000000-0000-4000-8000-000000000004',
    'urgent_responder','cmb-k4','ct',repeat('b',64),sahaj_private.authorization_revision(fam,'75000000-0000-4000-8000-000000000004'),
    'e7000000-0000-4000-8000-000000000001','a9500000-0000-4000-8000-000000000002');
  if res->>'status'<>'enqueued' then raise exception 'FAIL second urgent enqueue: %',res; end if;
  ob:=(res->>'outbox_id')::uuid; select call_id into cl from public.dispatch_bindings where outbox_id=ob;
  select o.lease_token into lease from public.claim_outbox('cmb-worker',100,120) o where o.id=ob;
  update public.family_memberships set revoked_at=now() where person_id='c5000000-0000-4000-8000-000000000003';
  begin
    perform public.claim_dispatch_contact(fam,resp,'dispatch:'||ob||':a1','twilio','twilio.create_call',ob,lease,cl,'f6500000-0000-4000-8000-000000000002','AC-synthetic',repeat('2',64));
    raise exception 'FAIL claim after approver revoked';
  exception when sqlstate '42501' then if sqlerrm not like 'dispatch_not_authorized:approval_no_longer_valid%' then raise; end if; end;
  select count(*) into n from public.dispatch_ledger where outbox_id=ob;
  if n<>0 then raise exception 'FAIL ledger row written after approver revocation'; end if;
end$$;
-- ---------------------------------------------------------------- 4. permission scope narrowed or reassigned after enqueue
-- Each mutation is applied under the shared family lock (authz trigger) and must make claim_dispatch refuse with
-- permission_scope_changed, inserting nothing. Restoring the scope lets the claim through, and the claim never charges usage.
reset role;
insert into public.atlas_principals(id,family_id,label,active) values('a7500000-0000-4000-8000-000000000002','b5000000-0000-4000-8000-000000000001','synthetic other',false);
update public.permissions set revoked_at=null,period_end=now()+interval '1 day',max_amount_minor=1000,vendor_ids=array['v1'],item_ids=array['i1','i2']
  where id='a4500000-0000-4000-8000-000000000001';
-- A request with a non-zero amount, a vendor and items (inserted directly; the immutability trigger only guards updates).
insert into public.action_requests(id,family_id,person_id,action,expires_at,target_id,workflow_job_id,principal_id,request_fingerprint,amount_minor,vendor_id,item_ids)
  values('75000000-0000-4000-8000-000000000005','b5000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','check_in',now()+interval '1 day',
    'c5000000-0000-4000-8000-000000000001','d5000000-0000-4000-8000-000000000005','a7500000-0000-4000-8000-000000000001',repeat('a',64),500,'v1',array['i1']);
set local role service_role;
do $$declare fam uuid:='b5000000-0000-4000-8000-000000000001';s uuid:='c5000000-0000-4000-8000-000000000001';
  rq uuid:='75000000-0000-4000-8000-000000000005';pid uuid:='a4500000-0000-4000-8000-000000000001';
  res jsonb;ob uuid;cl uuid;lease uuid;n integer;used_before integer;used_after integer;
  mutations text[]:=array[
    'target_ids=''{}''',
    'principal_id=''a7500000-0000-4000-8000-000000000002''',
    'person_id=''c5000000-0000-4000-8000-000000000002''',
    'action=''send_alert''',
    'max_amount_minor=100',
    'vendor_ids=array[''v2'']',
    'item_ids=array[''i2'']'];
  restore text:='target_ids=array[''c5000000-0000-4000-8000-000000000001''],principal_id=''a7500000-0000-4000-8000-000000000001'','
    ||'person_id=''c5000000-0000-4000-8000-000000000001'',action=''check_in'',max_amount_minor=1000,vendor_ids=array[''v1''],item_ids=array[''i1'',''i2'']';
  m text;
begin
  res:=public.enqueue_authorized_command(fam,'d5000000-0000-4000-8000-000000000005','95000000-0000-4000-8000-000000000005',rq,
    'check_in','cmb-k5','ct',repeat('b',64),sahaj_private.authorization_revision(fam,rq));
  if res->>'status'<>'enqueued' then raise exception 'FAIL scoped enqueue: %',res; end if;
  ob:=(res->>'outbox_id')::uuid; select call_id into cl from public.dispatch_bindings where outbox_id=ob;
  select o.lease_token into lease from public.claim_outbox('cmb-worker',100,120) o where o.id=ob;
  if lease is null then raise exception 'FAIL scoped outbox not claimable'; end if;
  select used_count into used_before from public.permissions where id=pid;
  foreach m in array mutations loop
    execute format('update public.permissions set %s where id=%L',m,pid);
    begin
      perform public.claim_dispatch_contact(fam,s,'dispatch:'||ob||':a1','sarvam','sarvam.outbound_call',ob,lease,cl,'f6500000-0000-4000-8000-000000000001','app-1',repeat('1',64));
      raise exception 'FAIL claim allowed after scope change: %',m;
    exception when sqlstate '42501' then
      if sqlerrm not like 'dispatch_not_authorized:permission_scope_changed%' then raise exception 'FAIL wrong refusal for %: %',m,sqlerrm; end if;
    end;
    if (public.recheck_dispatch_authorization(ob,lease))->>'reason'<>'permission_scope_changed' then raise exception 'FAIL recheck missed %',m; end if;
    select count(*) into n from public.dispatch_ledger where outbox_id=ob;
    if n<>0 then raise exception 'FAIL ledger row after scope change %',m; end if;
    execute format('update public.permissions set %s where id=%L',restore,pid);
  end loop;
  -- Original scope restored: the queued send is authorized again, and the claim does not charge usage a second time.
  if public.claim_dispatch_contact(fam,s,'dispatch:'||ob||':a1','sarvam','sarvam.outbound_call',ob,lease,cl,'f6500000-0000-4000-8000-000000000001','app-1',repeat('1',64))<>'claimed' then raise exception 'FAIL claim with restored scope'; end if;
  select used_count into used_after from public.permissions where id=pid;
  if used_after<>used_before then raise exception 'FAIL claim charged usage again (% -> %)',used_before,used_after; end if;
end$$;
reset role;
rollback;
