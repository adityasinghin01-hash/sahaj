-- Run as database owner after 20261114201600_phase2_dispatch_recording.sql. All fixtures are synthetic and rolled back.
-- NOT YET EXECUTED in the authoring session (no Postgres was available there): run before relying on the migration.
begin;
insert into public.families(id,name) values
 ('b2000000-0000-4000-8000-000000000001','Synthetic Phase2 A'),('b2000000-0000-4000-8000-000000000002','Synthetic Phase2 B');
insert into public.people(id,family_id,display_name,role) values
 ('c2000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','Synthetic Parent A','parent'),
 ('c2000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000002','Synthetic Parent B','parent');
insert into public.calls(id,family_id,person_id,provider) values
 ('d2000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','sarvam'),
 ('d2000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','twilio'),
 ('d2000000-0000-4000-8000-000000000003','b2000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000002','sarvam');
insert into public.outbox(id,family_id,kind,dedupe_key,payload_ciphertext,status,attempt_count,lease_token,lease_until) values
 ('e2000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','call','k1','x','processing',1,'f2000000-0000-4000-8000-000000000001',now()+interval '1 minute'),
 ('e2000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000001','call','k2','x','processing',1,'f2000000-0000-4000-8000-000000000002',now()+interval '1 minute');

-- privileges: service role only, no client access, no direct writes to the ledger
do $$ begin
  if has_table_privilege('authenticated','public.dispatch_ledger','SELECT') or has_table_privilege('anon','public.dispatch_ledger','SELECT')
    or has_table_privilege('service_role','public.dispatch_ledger','INSERT') or has_table_privilege('service_role','public.dispatch_ledger','UPDATE') then
    raise exception 'FAIL ledger privileges';
  end if;
  if not exists(select 1 from pg_class where oid='public.dispatch_ledger'::regclass and relrowsecurity) then raise exception 'FAIL ledger rls'; end if;
  if has_function_privilege('authenticated','public.claim_dispatch(uuid,uuid,text,text,text,uuid,uuid,uuid)','EXECUTE')
    or has_function_privilege('anon','public.put_call_recording(uuid,uuid,uuid,text,timestamptz,text)','EXECUTE')
    or has_function_privilege('authenticated','public.accept_assignment_verified(uuid,uuid,uuid)','EXECUTE')
    or has_function_privilege('service_role','sahaj_private.bind_dispatch(public.dispatch_ledger,text,text,text,boolean)','EXECUTE') then
    raise exception 'FAIL function privileges';
  end if;
  if not has_function_privilege('service_role','public.put_call_recording(uuid,uuid,uuid,text,timestamptz,text)','EXECUTE') then raise exception 'FAIL service rpc'; end if;
end $$;

-- claim: first wins, replay is duplicate, a second key for the same outbox row is duplicate, wrong lease and foreign call/person are refused
do $$ declare r text; begin
  r := public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o1:a1','sarvam','sarvam.outbound_call',
    'e2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001');
  if r<>'claimed' then raise exception 'FAIL first claim %',r; end if;
  r := public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o1:a1','sarvam','sarvam.outbound_call',
    'e2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001');
  if r<>'duplicate' then raise exception 'FAIL replay %',r; end if;
  r := public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o1:a2','sarvam','sarvam.outbound_call',
    'e2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001');
  if r<>'duplicate' then raise exception 'FAIL second key %',r; end if;
  begin
    perform public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o2:a1','twilio','twilio.create_call',
      'e2000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-0000000000ff','d2000000-0000-4000-8000-000000000002');
    raise exception 'FAIL wrong lease accepted';
  exception when serialization_failure then null; end;
  begin
    perform public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o2:a1','twilio','twilio.create_call',
      'e2000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000003');
    raise exception 'FAIL foreign-family call accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000002','dispatch:o2:a1','twilio','twilio.create_call',
      'e2000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000002');
    raise exception 'FAIL foreign person accepted';
  exception when insufficient_privilege or foreign_key_violation then null; end;
end $$;

-- complete: binds the call and the Sarvam attempt identity atomically; a second completion with another ref is refused
do $$ declare h text := repeat('a',64); begin
  if public.complete_dispatch('b2000000-0000-4000-8000-000000000001','dispatch:o1:a1','att-1','app-1',h,true)<>'dispatched' then raise exception 'FAIL complete'; end if;
  if not exists(select 1 from public.calls where id='d2000000-0000-4000-8000-000000000001' and external_id='att-1' and ai_disclosed_at is not null) then raise exception 'FAIL call link'; end if;
  if not exists(select 1 from public.provider_identities where source='sarvam' and account_id='app-1' and external_id_hash=h and binding_kind='attempt'
    and family_id='b2000000-0000-4000-8000-000000000001' and person_id='c2000000-0000-4000-8000-000000000001' and attempt_id='att-1' and agent_id='app-1') then raise exception 'FAIL identity'; end if;
  if public.complete_dispatch('b2000000-0000-4000-8000-000000000001','dispatch:o1:a1','att-1','app-1',h,true)<>'dispatched' then raise exception 'FAIL idempotent complete'; end if;
  begin
    perform public.complete_dispatch('b2000000-0000-4000-8000-000000000001','dispatch:o1:a1','att-OTHER','app-1',h,true);
    raise exception 'FAIL complete with different ref';
  exception when serialization_failure then null; end;
  if public.mark_dispatch_failed('b2000000-0000-4000-8000-000000000001','dispatch:o1:a1','provider_rejected') then raise exception 'FAIL failed after dispatched'; end if;
  if public.mark_dispatch_unknown('b2000000-0000-4000-8000-000000000001','dispatch:o1:a1') then raise exception 'FAIL unknown after dispatched'; end if;
end $$;

-- another family cannot take over the same attempt reference; a recorded reference survives bookkeeping failure
do $$ declare h text := repeat('a',64); begin
  insert into public.outbox(id,family_id,kind,dedupe_key,payload_ciphertext,status,attempt_count,lease_token,lease_until) values
   ('e2000000-0000-4000-8000-000000000003','b2000000-0000-4000-8000-000000000002','call','k3','x','processing',1,'f2000000-0000-4000-8000-000000000003',now()+interval '1 minute');
  perform public.claim_dispatch('b2000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000002','dispatch:o3:a1','sarvam','sarvam.outbound_call',
    'e2000000-0000-4000-8000-000000000003','f2000000-0000-4000-8000-000000000003','d2000000-0000-4000-8000-000000000003');
  begin
    perform public.complete_dispatch('b2000000-0000-4000-8000-000000000002','dispatch:o3:a1','att-1','app-1',h,true);
    raise exception 'FAIL identity takeover';
  exception when unique_violation then null; end;
  if not public.mark_dispatch_unknown('b2000000-0000-4000-8000-000000000002','dispatch:o3:a1','bookkeeping_failed','att-9') then raise exception 'FAIL mark unknown'; end if;
  if (select status from public.dispatch_ledger where idempotency_key='dispatch:o3:a1')<>'delivery_unknown' then raise exception 'FAIL status'; end if;
  if public.bind_dispatch_identity('b2000000-0000-4000-8000-000000000002','dispatch:o3:a1','app-1',repeat('b',64),true)<>true then raise exception 'FAIL repair'; end if;
  if (select status from public.dispatch_ledger where idempotency_key='dispatch:o3:a1')<>'delivery_unknown' then raise exception 'FAIL repair changed status'; end if;
end $$;

-- sweep turns abandoned claims into delivery_unknown, never back to a retryable state
do $$ begin
  perform public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o2:a1','twilio','twilio.create_call',
    'e2000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000002');
  update public.dispatch_ledger set claimed_at=now()-interval '1 hour' where idempotency_key='dispatch:o2:a1';
  if public.sweep_stale_dispatch_claims(120)<1 then raise exception 'FAIL sweep'; end if;
  if (select status from public.dispatch_ledger where idempotency_key='dispatch:o2:a1')<>'delivery_unknown' then raise exception 'FAIL swept status'; end if;
end $$;

-- reconcile needs verified, same-family, same-provider evidence carrying the dispatch key and a matching outcome
do $$ declare ev uuid; bad uuid; begin
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status) values
   ('b2000000-0000-4000-8000-000000000001','twilio','ev-good','delivery.not_sent','{"dispatch_key":"dispatch:o2:a1","outcome":"confirmed_not_sent"}','processed') returning id into ev;
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status) values
   ('b2000000-0000-4000-8000-000000000001','twilio','ev-wrongkey','delivery.not_sent','{"dispatch_key":"dispatch:other:a1","outcome":"confirmed_not_sent"}','processed') returning id into bad;
  if public.reconcile_dispatch('b2000000-0000-4000-8000-000000000001','dispatch:o2:a1',bad,'confirmed_not_sent') then raise exception 'FAIL wrong evidence key'; end if;
  if public.reconcile_dispatch('b2000000-0000-4000-8000-000000000001','dispatch:o2:a1',ev,'delivered') then raise exception 'FAIL outcome mismatch'; end if;
  if public.reconcile_dispatch('b2000000-0000-4000-8000-000000000002','dispatch:o2:a1',ev,'confirmed_not_sent') then raise exception 'FAIL wrong family'; end if;
  if not public.reconcile_dispatch('b2000000-0000-4000-8000-000000000001','dispatch:o2:a1',ev,'confirmed_not_sent') then raise exception 'FAIL good evidence'; end if;
  if (select status from public.dispatch_ledger where idempotency_key='dispatch:o2:a1')<>'not_sent' then raise exception 'FAIL not_sent'; end if;
  if public.reconcile_dispatch('b2000000-0000-4000-8000-000000000001','dispatch:o1:a1',ev,'confirmed_not_sent') then raise exception 'FAIL reconciled a dispatched row'; end if;
end $$;

-- responder acceptance: only a Twilio Gather event for this assignment, from a call this system placed to this person
do $$ declare inc uuid; asg uuid; ev uuid; wrong uuid; tw uuid := 'd2000000-0000-4000-8000-000000000002'; begin
  insert into public.incidents(family_id,person_id,severity) values('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','urgent') returning id into inc;
  insert into public.assignments(family_id,incident_id,person_id,expires_at) values('b2000000-0000-4000-8000-000000000001',inc,'c2000000-0000-4000-8000-000000000001',now()+interval '1 hour') returning id into asg;
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status) values
   ('b2000000-0000-4000-8000-000000000001','sarvam','ev-conn','sarvam.outbound',jsonb_build_object('assignment_id',asg,'person_id','c2000000-0000-4000-8000-000000000001','call_id',tw),'processed') returning id into wrong;
  if public.accept_assignment_verified('b2000000-0000-4000-8000-000000000001',asg,wrong) then raise exception 'FAIL gateway success accepted'; end if;
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status) values
   ('b2000000-0000-4000-8000-000000000001','twilio','ev-gather','twilio.gather.accepted',jsonb_build_object('assignment_id',asg,'person_id','c2000000-0000-4000-8000-000000000001','call_id',tw),'processed') returning id into ev;
  if public.accept_assignment_verified('b2000000-0000-4000-8000-000000000001',asg,ev) then raise exception 'FAIL accepted without a placed call'; end if;
  update public.calls set external_id='CA'||repeat('b',32) where id=tw;
  insert into public.dispatch_ledger(family_id,person_id,idempotency_key,provider,action,call_id,status,provider_ref)
    values('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:acc:a1','twilio','twilio.create_call',tw,'dispatched','CA'||repeat('b',32));
  if public.accept_assignment_verified('b2000000-0000-4000-8000-000000000002',asg,ev) then raise exception 'FAIL cross-family accept'; end if;
  if not public.accept_assignment_verified('b2000000-0000-4000-8000-000000000001',asg,ev) then raise exception 'FAIL valid accept'; end if;
  if (select status from public.assignments where id=asg)<>'accepted' then raise exception 'FAIL assignment status'; end if;
  if public.accept_assignment_verified('b2000000-0000-4000-8000-000000000001',asg,ev) then raise exception 'FAIL replay accept'; end if;
  begin
    insert into public.assignments(family_id,incident_id,person_id,expires_at,status,accepted_at,verified_by_provider_event)
      values('b2000000-0000-4000-8000-000000000001',inc,'c2000000-0000-4000-8000-000000000001',now()+interval '1 hour','accepted',now(),ev);
    raise exception 'FAIL one event verified two assignments';
  exception when unique_violation then null; end;
end $$;

-- recording metadata: consent rechecked in SQL at write time, multiple recordings keep the first
do $$ declare fam uuid := 'b2000000-0000-4000-8000-000000000001'; cid uuid := 'd2000000-0000-4000-8000-000000000002';
  pid uuid := 'c2000000-0000-4000-8000-000000000001'; yes uuid; gyes uuid; p1 text; p2 text; h1 text := repeat('1',64); h2 text := repeat('2',64); begin
  p1 := fam||'/calls/'||cid||'/'||repeat('1',32)||'.wav'; p2 := fam||'/calls/'||cid||'/'||repeat('2',32)||'.wav';
  begin perform public.put_call_recording(fam,cid,gen_random_uuid(),p1,now()+interval '30 days',h1); raise exception 'FAIL no consent';
  exception when insufficient_privilege then null; end;
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at) values
   (fam,pid,null,'call_recording','Synthetic?',true,'v1',now()-interval '3 hours') returning id into gyes;
  begin perform public.put_call_recording(fam,cid,gyes,p1,now()+interval '30 days',h1); raise exception 'FAIL global yes granted';
  exception when insufficient_privilege then null; end;
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at) values
   (fam,pid,cid,'call_recording','Synthetic?',true,'v1',now()-interval '2 hours') returning id into yes;
  begin perform public.put_call_recording(fam,cid,yes,'../'||p1,now()+interval '30 days',h1); raise exception 'FAIL bad path';
  exception when invalid_parameter_value then null; end;
  begin perform public.put_call_recording(fam,cid,yes,p1,now()+interval '900 days',h1); raise exception 'FAIL retention cap';
  exception when invalid_parameter_value then null; end;
  begin perform public.put_call_recording('b2000000-0000-4000-8000-000000000002',cid,yes,p1,now()+interval '30 days',h1); raise exception 'FAIL cross-family';
  exception when insufficient_privilege or invalid_parameter_value then null; end;
  if public.get_call_recording_slot(fam,cid,h1)<>'none' then raise exception 'FAIL slot none'; end if;
  if public.put_call_recording(fam,cid,yes,p1,now()+interval '30 days',h1)<>'stored' then raise exception 'FAIL stored'; end if;
  if public.put_call_recording(fam,cid,yes,p1,now()+interval '30 days',h1)<>'already_stored' then raise exception 'FAIL idempotent'; end if;
  if public.put_call_recording(fam,cid,yes,p2,now()+interval '30 days',h2)<>'ignored_additional' then raise exception 'FAIL additional'; end if;
  if public.get_call_recording_slot(fam,cid,h1)<>'same' or public.get_call_recording_slot(fam,cid,h2)<>'other' then raise exception 'FAIL slot'; end if;
  if (select c.recording_object_path from sahaj_private.call_content c where c.family_id=fam and c.call_id=cid)<>p1 then raise exception 'FAIL first kept'; end if;
  if (public.get_call_media_metadata(fam,cid)->>'consent_id')::uuid<>yes then raise exception 'FAIL media metadata link'; end if;
end $$;
do $$ declare fam uuid := 'b2000000-0000-4000-8000-000000000001'; cid uuid := 'd2000000-0000-4000-8000-000000000001';
  pid uuid := 'c2000000-0000-4000-8000-000000000001'; yes uuid; p text := 'b2000000-0000-4000-8000-000000000001/calls/d2000000-0000-4000-8000-000000000001/'||repeat('3',32)||'.wav'; begin
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at) values
   (fam,pid,cid,'call_recording','Synthetic?',true,'v1',now()-interval '2 hours') returning id into yes;
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at) values
   (fam,pid,null,'call_recording','Synthetic withdrawal',false,'v1',now()-interval '1 hour');
  begin perform public.put_call_recording(fam,cid,yes,p,now()+interval '30 days',repeat('3',64)); raise exception 'FAIL refusal ignored';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
