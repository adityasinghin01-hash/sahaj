-- Bridge checks for 20261114213000_phase3_bridge.sql. Needs the Phase 2 migration applied first. Synthetic data; rolls back.
-- SOURCE ONLY: not executed by its author (no PostgreSQL available).
begin;
insert into public.families(id,name) values('b8000000-0000-4000-8000-000000000001','Synthetic Bridge A');
insert into public.people(id,family_id,display_name,role) values
 ('c8000000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000001','Subject','parent'),
 ('c8000000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000001','Other','child');
insert into public.atlas_principals(id,family_id,label) values('a8000000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000001','synthetic');
insert into public.consents(id,family_id,person_id,purpose,question,answer,version) values
 ('f8000000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000001','c8000000-0000-4000-8000-000000000001','permission_setup','q',true,'v1');
insert into public.permissions(id,family_id,person_id,principal_id,action,decision,expires_at,consent_id,valid_from,period_start,period_end,max_uses,target_ids)
values('a4800000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000001','c8000000-0000-4000-8000-000000000001','a8000000-0000-4000-8000-000000000001',
 'check_in','allow',now()+interval '1 day','f8000000-0000-4000-8000-000000000001',now()-interval '1 hour',now()-interval '1 hour',now()+interval '1 day',5,array['c8000000-0000-4000-8000-000000000001']);
insert into public.raw_events(id,family_id,source,provider_event_id,event_type,status,payload_hash) values
 ('e8000000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000001','whatsapp','b-1','whatsapp.text','processed',repeat('a',64)),
 ('e8000000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000001','whatsapp','b-2','whatsapp.text','processed',repeat('b',64));
insert into public.workflow_jobs(id,family_id,raw_event_id,thread_id,workflow_kind,state,lease_token,lease_until) values
 ('d8000000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000001','e8000000-0000-4000-8000-000000000001','t1','core1.atlas','processing','98000000-0000-4000-8000-000000000001',now()+interval '5 minutes'),
 ('d8000000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000001','e8000000-0000-4000-8000-000000000002','t2','core1.atlas','processing','98000000-0000-4000-8000-000000000002',now()+interval '5 minutes');
set local role service_role;
do $$declare fam uuid:='b8000000-0000-4000-8000-000000000001';subject uuid:='c8000000-0000-4000-8000-000000000001';
  res jsonb;ob uuid;n integer;b public.dispatch_bindings;
  rq1 uuid:='71800000-0000-4000-8000-000000000001';rq2 uuid:='71800000-0000-4000-8000-000000000002';
  j1 uuid:='d8000000-0000-4000-8000-000000000001';j2 uuid:='d8000000-0000-4000-8000-000000000002';
  l1 uuid:='98000000-0000-4000-8000-000000000001';l2 uuid:='98000000-0000-4000-8000-000000000002';
begin
  -- Without a provider contact binding the command is denied and NOTHING is written.
  perform public.ensure_action_request(fam,j1,l1,rq1,subject,'check_in',subject::text,repeat('f',64));
  res:=public.enqueue_authorized_command(fam,j1,l1,rq1,'check_in','kb1','ct',repeat('a',64),sahaj_private.authorization_revision(fam,rq1));
  if res->>'reason'<>'no_provider_identity' then raise exception 'FAIL missing identity accepted: %',res; end if;
  if exists(select 1 from public.outbox where family_id=fam) or exists(select 1 from public.dispatch_bindings where family_id=fam)
    or (select used_count from public.permissions where id='a4800000-0000-4000-8000-000000000001')<>0 then
    raise exception 'FAIL denied enqueue left rows or consumed usage';
  end if;
  reset role;
  insert into public.provider_identities(family_id,person_id,source,account_id,external_id_hash,binding_kind,contact_ciphertext)
    values(fam,subject,'sarvam','app-1',repeat('c',64),'contact','synthetic-ciphertext');
  set local role service_role;
  res:=public.enqueue_authorized_command(fam,j1,l1,rq1,'check_in','kb1','ct',repeat('a',64),sahaj_private.authorization_revision(fam,rq1));
  if res->>'status'<>'enqueued' then raise exception 'FAIL enqueue with identity refused: %',res; end if;
  ob:=(res->>'outbox_id')::uuid;
  select * into b from public.dispatch_bindings where outbox_id=ob;
  if b.outbox_id is null or b.person_id<>subject or b.provider<>'sarvam' or b.action<>'sarvam.outbound_call' or b.call_id is null
    or b.action_request_id<>rq1 then raise exception 'FAIL binding missing or wrong: %',b; end if;
  if (select action from public.outbox where id=ob)<>'check_in' then raise exception 'FAIL outbox action is not the domain action'; end if;
  -- Recovery returns the same row and does not create a second binding or call.
  res:=public.enqueue_authorized_command(fam,j1,l1,rq1,'check_in','kb1','ct',repeat('a',64),'ignored');
  select count(*) into n from public.dispatch_bindings where family_id=fam;
  if res->>'recovered'<>'true' or n<>1 or (select count(*) from public.calls where family_id=fam)<>1 then raise exception 'FAIL recovery duplicated binding or call'; end if;
  -- Bindings are immutable.
  begin update public.dispatch_bindings set person_id='c8000000-0000-4000-8000-000000000002' where outbox_id=ob;
    raise exception 'FAIL binding mutated'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- Actions without a defined route are refused, not guessed.
  perform public.ensure_action_request(fam,j2,l2,rq2,subject,'send_alert',subject::text,repeat('e',64));
  res:=public.enqueue_authorized_command(fam,j2,l2,rq2,'send_alert','kb2','ct',repeat('a',64),sahaj_private.authorization_revision(fam,rq2));
  if res->>'status' in ('enqueued') then raise exception 'FAIL unrouted action enqueued'; end if;
end$$;
-- A raw (non-normalized) callback with perfect-looking metadata is not delivery proof.
reset role;
update public.outbox set status='completed',attempt_count=1 where family_id='b8000000-0000-4000-8000-000000000001';
insert into public.raw_events(family_id,source,provider_event_id,event_type,status,payload_hash,metadata)
select family_id,'sarvam','forged-1','delivery.not_sent','processed',repeat('1',64),jsonb_build_object('outbox_id',id,'action_request_id',action_request_id,'action','check_in',
  'provider_action','sarvam.outbound_call','dispatch_key','x','provider_ref','y','account_id','app-1','outcome','confirmed_not_sent')
  from public.outbox where family_id='b8000000-0000-4000-8000-000000000001';
set local role service_role;
do $$declare ob uuid;begin
  select id into ob from public.outbox where family_id='b8000000-0000-4000-8000-000000000001';
  if sahaj_private.outbox_proof(ob) is not null then raise exception 'FAIL forged raw proof accepted'; end if;
  begin
    perform set_config('sahaj.proof_writer','',true);
    insert into public.raw_events(family_id,source,provider_event_id,event_type,status,payload_hash,normalized_proof)
      values('b8000000-0000-4000-8000-000000000001','sarvam','forged-2','delivery.not_sent','processed',repeat('2',64),true);
    raise exception 'FAIL normalized flag written outside proof writers';
  exception when sqlstate '42501' then null; end;
end$$;
reset role;
rollback;
