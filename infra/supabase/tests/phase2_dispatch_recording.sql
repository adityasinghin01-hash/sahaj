-- Run as database owner after 20261114201600_phase2_dispatch_recording.sql on a SCRATCH database. All fixtures are synthetic and rolled back.
-- NOT YET EXECUTED by its author (no Postgres was available): the parent runs it after review. Never run against the real project.
-- Concurrency (two sessions) is covered separately by phase2_concurrency.ps1.
begin;
alter table public.outbox add column if not exists action text;
alter table public.outbox add column if not exists incident_id uuid;
insert into public.families(id,name) values
 ('b2000000-0000-4000-8000-000000000001','Synthetic Phase2 A'),('b2000000-0000-4000-8000-000000000002','Synthetic Phase2 B');
insert into public.people(id,family_id,display_name,role) values
 ('c2000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','Synthetic Parent A','parent'),
 ('c2000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000002','Synthetic Parent B','parent'),
 ('c2000000-0000-4000-8000-000000000003','b2000000-0000-4000-8000-000000000001','Synthetic Circle A','circle');
insert into public.calls(id,family_id,person_id,provider) values
 ('d2000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','sarvam'),
 ('d2000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000003','twilio'),
 ('d2000000-0000-4000-8000-000000000003','b2000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000002','sarvam'),
 ('d2000000-0000-4000-8000-000000000004','b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','twilio'),
 ('d2000000-0000-4000-8000-000000000005','b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','twilio'),
 ('d2000000-0000-4000-8000-000000000006','b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','twilio');
insert into public.incidents(id,family_id,person_id,severity) values
 ('a2000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','urgent');
insert into public.action_requests(id,family_id,person_id,action,expires_at) values
 ('a3000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','urgent_responder',now()+interval '1 hour'),
 ('a3000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','other_action',now()+interval '1 hour');
insert into public.assignments(id,family_id,incident_id,person_id,expires_at) values
 ('a4000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000003',now()+interval '1 hour');
insert into public.outbox(id,family_id,kind,dedupe_key,payload_ciphertext,status,attempt_count,lease_token,lease_until,action_request_id) values
 ('e2000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','call','k1','x','processing',1,'f2000000-0000-4000-8000-000000000001',now()+interval '1 minute',null),
 ('e2000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000001','call','k2','x','processing',1,'f2000000-0000-4000-8000-000000000002',now()+interval '1 minute','a3000000-0000-4000-8000-000000000001'),
 ('e2000000-0000-4000-8000-000000000003','b2000000-0000-4000-8000-000000000002','call','k3','x','processing',1,'f2000000-0000-4000-8000-000000000003',now()+interval '1 minute',null),
 ('e2000000-0000-4000-8000-000000000004','b2000000-0000-4000-8000-000000000001','call','k4','x','processing',1,'f2000000-0000-4000-8000-000000000004',now()+interval '1 minute',null),
 ('e2000000-0000-4000-8000-000000000005','b2000000-0000-4000-8000-000000000001','call','k5','x','processing',1,'f2000000-0000-4000-8000-000000000005',now()+interval '1 minute','a3000000-0000-4000-8000-000000000002');

-- care/domain actions (Phase 3 outbox.action) differ from provider operations (ledger.action)
update public.outbox set action='check_in' where id in ('e2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000004','e2000000-0000-4000-8000-000000000005');
update public.outbox set action='urgent_responder',incident_id='a2000000-0000-4000-8000-000000000001' where id='e2000000-0000-4000-8000-000000000002';
update public.outbox set action_request_id='a3000000-0000-4000-8000-000000000002' where id='e2000000-0000-4000-8000-000000000004';

-- Phase 3 predicates (c614a32 outbox_proof / outbox_acceptance), mirrored here without Phase 3's target_id column, plus the
-- strict form the bridge requires: normalized_proof AND the stored ledger and binding rows. Both must hold for real proof.
create function pg_temp.p3_delivery(p_outbox uuid,p_person uuid,p_strict boolean) returns text language plpgsql as $$
declare o public.outbox;kinds text[];
begin
  select * into o from public.outbox where id=p_outbox;
  if o.id is null or o.action_request_id is null then return null; end if;
  select array_agg(distinct case e.event_type when 'delivery.confirmed' then 'delivered' else 'not_sent' end) into kinds
  from public.raw_events e where e.family_id=o.family_id and e.status='processed' and e.source in ('twilio','sarvam','telecmi','whatsapp')
    and e.event_type in ('delivery.confirmed','delivery.not_sent') and e.metadata->>'outbox_id'=o.id::text
    and e.metadata->>'action_request_id'=o.action_request_id::text and e.metadata->>'action'=o.action and coalesce(e.metadata->>'dispatch_key','')<>''
    and e.metadata->>'outcome'=case e.event_type when 'delivery.confirmed' then 'delivered' else 'confirmed_not_sent' end
    and exists(select 1 from public.provider_identities pi where pi.family_id=o.family_id and pi.person_id=p_person and pi.source=e.source
      and pi.account_id=e.metadata->>'account_id' and pi.enabled and pi.revoked_at is null)
    and (not p_strict or (e.normalized_proof and exists(select 1 from public.dispatch_ledger l join public.dispatch_bindings b on b.outbox_id=l.outbox_id
      where l.family_id=e.family_id and l.idempotency_key=e.metadata->>'dispatch_key' and l.outbox_id=o.id and l.provider=e.source
        and l.provider_ref=e.metadata->>'provider_ref' and l.action=e.metadata->>'provider_action' and b.person_id=p_person)));
  if kinds is null then return null; end if;
  return kinds[1];
end$$;
create function pg_temp.p3_accept(p_outbox uuid,p_strict boolean) returns boolean language plpgsql as $$
declare o public.outbox;r public.action_requests;
begin
  select * into o from public.outbox where id=p_outbox;
  if o.id is null or o.action<>'urgent_responder' or o.incident_id is null or o.action_request_id is null then return false; end if;
  select * into r from public.action_requests where id=o.action_request_id and family_id=o.family_id;
  return exists(select 1 from public.assignments a
    join public.incidents i on i.id=a.incident_id and i.family_id=a.family_id and i.person_id=r.person_id
    join public.raw_events e on e.id=a.verified_by_provider_event and e.family_id=a.family_id
    join public.calls c on c.family_id=a.family_id and c.id::text=e.metadata->>'call_id' and c.person_id=a.person_id and c.provider=e.source
    where a.family_id=o.family_id and a.incident_id=o.incident_id and a.status='accepted' and a.person_id<>r.person_id
      and e.status='processed' and e.event_type='responder.accepted' and e.source in ('twilio','sarvam','telecmi','whatsapp')
      and e.metadata->>'outbox_id'=o.id::text and e.metadata->>'action_request_id'=r.id::text and e.metadata->>'action'='urgent_responder'
      and e.metadata->>'incident_id'=o.incident_id::text and e.metadata->>'assignment_id'=a.id::text
      and e.metadata->>'responder_person_id'=a.person_id::text and e.metadata->>'person_id'=a.person_id::text and c.external_id is not null
      and e.metadata->>'subject_person_id'=i.person_id::text
      and exists(select 1 from public.provider_identities pi where pi.family_id=o.family_id and pi.person_id=a.person_id and pi.source=e.source
        and pi.account_id=e.metadata->>'account_id' and pi.enabled and pi.revoked_at is null)
      and (not p_strict or (e.normalized_proof and exists(select 1 from public.dispatch_ledger l where l.family_id=e.family_id and l.outbox_id=o.id
        and l.idempotency_key=e.metadata->>'dispatch_key' and l.provider_ref=c.external_id and l.status in ('dispatched','delivered')))));
end$$;

-- ---------------------------------------------------------------- privileges
do $$ declare t text; begin
  foreach t in array array['public.dispatch_ledger','public.dispatch_bindings'] loop
    if has_table_privilege('authenticated',t,'SELECT') or has_table_privilege('anon',t,'SELECT')
      or has_table_privilege('service_role',t,'INSERT') or has_table_privilege('service_role',t,'UPDATE')
      or has_table_privilege('service_role',t,'DELETE') or has_table_privilege('service_role',t,'TRUNCATE') then
      raise exception 'FAIL % privileges (service_role must have SELECT only)',t;
    end if;
    if not has_table_privilege('service_role',t,'SELECT') then raise exception 'FAIL % select missing',t; end if;
    if not exists(select 1 from pg_class where oid=t::regclass and relrowsecurity) then raise exception 'FAIL % rls',t; end if;
  end loop;
  if has_function_privilege('authenticated','public.claim_dispatch(uuid,uuid,text,text,text,uuid,uuid,uuid)','EXECUTE')
    or has_function_privilege('anon','public.put_call_recording(uuid,uuid,uuid,text,timestamptz,text)','EXECUTE')
    or has_function_privilege('authenticated','public.accept_assignment_verified(uuid,uuid,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.record_responder_acceptance(uuid,text)','EXECUTE')
    or has_function_privilege('authenticated','public.record_delivery_proof(uuid,uuid,text)','EXECUTE')
    or has_function_privilege('authenticated','public.finish_recording_purge(uuid,uuid,text,timestamptz)','EXECUTE')
    or has_function_privilege('anon','public.bind_outbox_dispatch(uuid,uuid,uuid,text,text,uuid,uuid,uuid)','EXECUTE')
    or has_function_privilege('service_role','sahaj_private.bind_dispatch(public.dispatch_ledger,text,text,text,boolean)','EXECUTE')
    or has_function_privilege('service_role','sahaj_private.derive_responder_binding(uuid,uuid)','EXECUTE') then
    raise exception 'FAIL function privileges';
  end if;
  if not has_function_privilege('service_role','public.put_call_recording(uuid,uuid,uuid,text,timestamptz,text)','EXECUTE')
    or not has_function_privilege('service_role','public.list_recording_purge_candidates(integer,timestamptz)','EXECUTE') then raise exception 'FAIL service rpc'; end if;
end $$;

-- ---------------------------------------------------------------- consent writers: future rows refused
do $$ begin
  begin
    insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at)
      values('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001',null,'call_recording','Synthetic?',true,'v1',now()+interval '1 day');
    raise exception 'FAIL future consent accepted';
  exception when check_violation then null; end;
end $$;

-- ---------------------------------------------------------------- proof flag cannot be forged
do $$ begin
  begin
    insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status,normalized_proof)
      values('b2000000-0000-4000-8000-000000000001','twilio','forged-proof','delivery.not_sent','{}','processed',true);
    raise exception 'FAIL forged normalized_proof insert';
  exception when insufficient_privilege then null; end;
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status)
    values('b2000000-0000-4000-8000-000000000001','twilio','plain-raw','delivery.not_sent','{}','processed');
  begin
    update public.raw_events set normalized_proof=true where provider_event_id='plain-raw';
    raise exception 'FAIL normalized_proof flip';
  exception when insufficient_privilege then null; end;
end $$;

-- ---------------------------------------------------------------- bindings are immutable and gate every claim
do $$ declare r text; begin
  if public.bind_outbox_dispatch('b2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001',
    'sarvam','sarvam.outbound_call','d2000000-0000-4000-8000-000000000001')<>true then raise exception 'FAIL bind'; end if;
  if public.bind_outbox_dispatch('b2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001',
    'sarvam','sarvam.outbound_call','d2000000-0000-4000-8000-000000000001')<>true then raise exception 'FAIL idempotent bind'; end if;
  begin
    perform public.bind_outbox_dispatch('b2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000003','sarvam','sarvam.outbound_call','d2000000-0000-4000-8000-000000000001');
    raise exception 'FAIL conflicting rebind';
  exception when unique_violation then null; end;
  begin update public.dispatch_bindings set person_id='c2000000-0000-4000-8000-000000000003' where outbox_id='e2000000-0000-4000-8000-000000000001'; raise exception 'FAIL binding update';
  exception when integrity_constraint_violation then null; end;
  begin delete from public.dispatch_bindings where outbox_id='e2000000-0000-4000-8000-000000000001'; raise exception 'FAIL binding delete';
  exception when integrity_constraint_violation then null; end;
  begin perform public.bind_outbox_dispatch('b2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000003','c2000000-0000-4000-8000-000000000001','sarvam','sarvam.outbound_call');
    raise exception 'FAIL cross-family outbox bound'; exception when insufficient_privilege then null; end;
  begin perform public.bind_outbox_dispatch('b2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000004','c2000000-0000-4000-8000-000000000001','twilio','sarvam.outbound_call');
    raise exception 'FAIL provider/action mismatch'; exception when invalid_parameter_value then null; end;
  -- same family, valid lease, but another person / provider / action / call than the binding
  begin perform public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000003','dispatch:o1:a1','sarvam','sarvam.outbound_call','e2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001');
    raise exception 'FAIL other person claimed'; exception when insufficient_privilege then null; end;
  begin perform public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o1:a1','twilio','twilio.create_call','e2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001');
    raise exception 'FAIL other provider claimed'; exception when insufficient_privilege then null; end;
  begin perform public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o1:a1','sarvam','sarvam.outbound_call','e2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000004');
    raise exception 'FAIL other call claimed'; exception when insufficient_privilege then null; end;
  begin perform public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o1:a1','sarvam','sarvam.outbound_call','e2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001',null);
    raise exception 'FAIL call dropped'; exception when insufficient_privilege then null; end;
  begin perform public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o4:a1','twilio','twilio.create_call','e2000000-0000-4000-8000-000000000004','f2000000-0000-4000-8000-000000000004','d2000000-0000-4000-8000-000000000004');
    raise exception 'FAIL unbound outbox claimed'; exception when insufficient_privilege then null; end;
  begin perform public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o1:a1','sarvam','sarvam.outbound_call','e2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-0000000000ff','d2000000-0000-4000-8000-000000000001');
    raise exception 'FAIL wrong lease'; exception when serialization_failure then null; end;
  if (select count(*) from public.dispatch_ledger)<>0 then raise exception 'FAIL ledger written by refused claims'; end if;
  r := public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o1:a1','sarvam','sarvam.outbound_call','e2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001');
  if r<>'claimed' then raise exception 'FAIL first claim %',r; end if;
  if public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o1:a1','sarvam','sarvam.outbound_call','e2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001')<>'duplicate' then raise exception 'FAIL replay'; end if;
  if public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o1:a2','sarvam','sarvam.outbound_call','e2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001')<>'duplicate' then raise exception 'FAIL second key'; end if;
end $$;

-- ---------------------------------------------------------------- complete binds call and attempt identity atomically
do $$ declare h text := repeat('a',64); begin
  if public.complete_dispatch('b2000000-0000-4000-8000-000000000001','dispatch:o1:a1','att-1','app-1',h,true)<>'dispatched' then raise exception 'FAIL complete'; end if;
  if not exists(select 1 from public.calls where id='d2000000-0000-4000-8000-000000000001' and external_id='att-1' and ai_disclosed_at is not null) then raise exception 'FAIL call link'; end if;
  if not exists(select 1 from public.provider_identities where source='sarvam' and account_id='app-1' and external_id_hash=h and binding_kind='attempt'
    and family_id='b2000000-0000-4000-8000-000000000001' and person_id='c2000000-0000-4000-8000-000000000001' and attempt_id='att-1' and agent_id='app-1') then raise exception 'FAIL identity'; end if;
  if public.complete_dispatch('b2000000-0000-4000-8000-000000000001','dispatch:o1:a1','att-1','app-1',h,true)<>'dispatched' then raise exception 'FAIL idempotent complete'; end if;
  begin perform public.complete_dispatch('b2000000-0000-4000-8000-000000000001','dispatch:o1:a1','att-OTHER','app-1',h,true); raise exception 'FAIL other ref';
  exception when serialization_failure then null; end;
  if public.mark_dispatch_failed('b2000000-0000-4000-8000-000000000001','dispatch:o1:a1') or public.mark_dispatch_unknown('b2000000-0000-4000-8000-000000000001','dispatch:o1:a1') then raise exception 'FAIL status moved after dispatch'; end if;
end $$;

-- ---------------------------------------------------------------- normalized delivery proof and reconciliation
do $$ declare fam uuid := 'b2000000-0000-4000-8000-000000000001'; tw uuid := 'd2000000-0000-4000-8000-000000000004'; o uuid := 'e2000000-0000-4000-8000-000000000004';
  src uuid; src_done uuid; forged uuid; proof jsonb; m jsonb; ref text := 'CA'||repeat('b',32); k text := 'dispatch:o4:a1'; begin
  perform public.bind_outbox_dispatch(fam,o,'c2000000-0000-4000-8000-000000000001','twilio','twilio.create_call',tw);
  perform public.claim_dispatch(fam,'c2000000-0000-4000-8000-000000000001',k,'twilio','twilio.create_call',o,'f2000000-0000-4000-8000-000000000004',tw);
  -- provider answered but bookkeeping failed: unknown WITH a reference, then identity repair links the call
  if not public.mark_dispatch_unknown(fam,k,'bookkeeping_failed',ref) then raise exception 'FAIL unknown'; end if;
  begin perform public.bind_dispatch_identity(fam,k,null,null,false); raise exception 'FAIL repair without account'; exception when invalid_parameter_value then null; end;
  if not public.bind_dispatch_identity(fam,k,'AC'||repeat('a',32),repeat('d',64),false) then raise exception 'FAIL repair'; end if;
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status) values
   (fam,'twilio','st-noanswer','twilio.call_status',jsonb_build_object('status','no-answer','call_id',tw,'person_id','c2000000-0000-4000-8000-000000000001'),'processed') returning id into src;
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status) values
   (fam,'twilio','st-completed','twilio.call_status',jsonb_build_object('status','completed','call_id',tw),'processed') returning id into src_done;
  -- a generic (non-normalized) event with perfect-looking metadata is not proof
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status) values
   (fam,'twilio','forged-delivery','delivery.not_sent',jsonb_build_object('dispatch_key',k,'outcome','confirmed_not_sent','outbox_id',o,'provider_ref',ref,'action','check_in','provider_action','twilio.create_call','action_request_id','a3000000-0000-4000-8000-000000000002','account_id','AC'||repeat('a',32),'person_id','c2000000-0000-4000-8000-000000000001'),'processed') returning id into forged;
  -- Phase 3's non-strict predicate would accept the forged row; the strict one (normalized flag + ledger/binding join) must not
  if pg_temp.p3_delivery(o,'c2000000-0000-4000-8000-000000000001',false) is distinct from 'not_sent' then raise exception 'FAIL forged row should fool only the non-strict predicate'; end if;
  if pg_temp.p3_delivery(o,'c2000000-0000-4000-8000-000000000001',true) is not null then raise exception 'FAIL strict predicate accepted forged row'; end if;
  if public.reconcile_dispatch(fam,k,forged,'confirmed_not_sent') then raise exception 'FAIL forged event reconciled'; end if;
  begin perform public.record_delivery_proof(fam,src_done,'confirmed_not_sent'); raise exception 'FAIL completed call is proof'; exception when insufficient_privilege then null; end;
  begin perform public.record_delivery_proof(fam,src,'delivered'); raise exception 'FAIL call proves delivered'; exception when insufficient_privilege then null; end;
  begin perform public.record_delivery_proof('b2000000-0000-4000-8000-000000000002',src,'confirmed_not_sent'); raise exception 'FAIL cross-family proof'; exception when insufficient_privilege then null; end;
  proof := public.record_delivery_proof(fam,src,'confirmed_not_sent');
  if proof->>'dispatch_key'<>k or (proof->>'outbox_id')::uuid<>o then raise exception 'FAIL proof derivation'; end if;
  select metadata into m from public.raw_events where id=(proof->>'proof_event_id')::uuid;
  if m->>'action'<>'check_in' or m->>'provider_action'<>'twilio.create_call' or m->>'account_id'<>'AC'||repeat('a',32) or m->>'dispatch_key'<>k
    or m->>'action_request_id'<>'a3000000-0000-4000-8000-000000000002' or m->>'provider_ref'<>ref or m->>'outcome'<>'confirmed_not_sent' then
    raise exception 'FAIL common delivery metadata %',m;
  end if;
  if not (select normalized_proof from public.raw_events where id=(proof->>'proof_event_id')::uuid) then raise exception 'FAIL normalized flag'; end if;
  -- the real proof satisfies the Phase 3 predicate in BOTH its current and its strict form (and the forged row is still ignored there)
  if pg_temp.p3_delivery(o,'c2000000-0000-4000-8000-000000000001',false) is distinct from 'not_sent'
    or pg_temp.p3_delivery(o,'c2000000-0000-4000-8000-000000000001',true) is distinct from 'not_sent' then raise exception 'FAIL real proof vs Phase 3 predicate'; end if;
  if pg_temp.p3_delivery(o,'c2000000-0000-4000-8000-000000000002',true) is not null then raise exception 'FAIL proof matched another person'; end if;
  if public.record_delivery_proof(fam,src,'confirmed_not_sent')->>'proof_event_id'<>proof->>'proof_event_id' then raise exception 'FAIL proof replay'; end if;
  if public.reconcile_dispatch(fam,'dispatch:other:a1',(proof->>'proof_event_id')::uuid,'confirmed_not_sent') then raise exception 'FAIL other key'; end if;
  if public.reconcile_dispatch(fam,k,(proof->>'proof_event_id')::uuid,'delivered') then raise exception 'FAIL other outcome'; end if;
  if public.reconcile_outbox(o,(proof->>'proof_event_id')::uuid,'confirmed_not_sent') then raise exception 'FAIL outbox before ledger'; end if;
  if not public.reconcile_dispatch(fam,k,(proof->>'proof_event_id')::uuid,'confirmed_not_sent') then raise exception 'FAIL reconcile'; end if;
  if (select status from public.dispatch_ledger where idempotency_key=k)<>'not_sent' then raise exception 'FAIL not_sent'; end if;
  update public.outbox set status='delivery_unknown' where id=o;
  if public.reconcile_outbox(o,forged,'confirmed_not_sent') then raise exception 'FAIL outbox forged'; end if;
  if not public.reconcile_outbox(o,(proof->>'proof_event_id')::uuid,'confirmed_not_sent') then raise exception 'FAIL outbox reconcile'; end if;
  -- a not_sent row is retryable only under a NEW key: the live-outbox index allows exactly that
  if public.claim_dispatch(fam,'c2000000-0000-4000-8000-000000000001','dispatch:o4:a2','twilio','twilio.create_call',o,'f2000000-0000-4000-8000-000000000004',tw)<>'duplicate' then
    null; -- outbox no longer 'processing' after reconcile: stale_outbox_lease is also acceptable; both stop a double send
  end if;
exception when serialization_failure then null; end $$;

-- sweep: abandoned claims become delivery_unknown, never a retryable state
do $$ begin
  perform public.bind_outbox_dispatch('b2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000005','c2000000-0000-4000-8000-000000000001','twilio','twilio.create_call','d2000000-0000-4000-8000-000000000005');
  perform public.claim_dispatch('b2000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','dispatch:o5:a1','twilio','twilio.create_call','e2000000-0000-4000-8000-000000000005','f2000000-0000-4000-8000-000000000005','d2000000-0000-4000-8000-000000000005');
  update public.dispatch_ledger set claimed_at=now()-interval '1 hour' where idempotency_key='dispatch:o5:a1';
  if public.sweep_stale_dispatch_claims(120)<1 then raise exception 'FAIL sweep'; end if;
  if (select status from public.dispatch_ledger where idempotency_key='dispatch:o5:a1')<>'delivery_unknown' then raise exception 'FAIL swept status'; end if;
end $$;

-- ---------------------------------------------------------------- responder acceptance: common responder.accepted proof
do $$ declare fam uuid := 'b2000000-0000-4000-8000-000000000001'; tw uuid := 'd2000000-0000-4000-8000-000000000002'; o uuid := 'e2000000-0000-4000-8000-000000000002';
  resp uuid := 'c2000000-0000-4000-8000-000000000003'; asg uuid := 'a4000000-0000-4000-8000-000000000001'; ref text := 'CA'||repeat('d',32);
  proof jsonb; sarvam_ev uuid; completed_ev uuid; p2 jsonb; m jsonb; begin
  begin perform public.bind_outbox_dispatch(fam,o,resp,'twilio','twilio.create_call',tw,'a2000000-0000-4000-8000-0000000000ff',asg); raise exception 'FAIL other incident bound';
  exception when insufficient_privilege or foreign_key_violation then null; end;
  perform public.bind_outbox_dispatch(fam,o,resp,'twilio','twilio.create_call',tw,null,asg); -- incident comes from the outbox row
  -- connected/completed events and a Sarvam event are never acceptance, whatever their metadata says
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status) values
   (fam,'sarvam','ev-conn','sarvam.outbound',jsonb_build_object('assignment_id',asg,'person_id',resp,'call_id',tw,'digit','1'),'processed') returning id into sarvam_ev;
  begin perform public.record_responder_acceptance(fam,'ev-conn'); raise exception 'FAIL sarvam status accepted'; exception when insufficient_privilege then null; end;
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status) values
   (fam,'twilio','ev-completed','twilio.call_status',jsonb_build_object('status','completed','call_id',tw,'person_id',resp),'processed') returning id into completed_ev;
  begin perform public.record_responder_acceptance(fam,'ev-completed'); raise exception 'FAIL completed accepted'; exception when insufficient_privilege then null; end;
  -- gather press before the call was placed/bound: not provable
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status) values
   (fam,'twilio','AC:gather:CA1','twilio.gather.response',jsonb_build_object('call_id',tw,'person_id',resp,'digit','1'),'processed');
  begin perform public.record_responder_acceptance(fam,'AC:gather:CA1'); raise exception 'FAIL accepted before dispatch'; exception when insufficient_privilege then null; end;
  perform public.claim_dispatch(fam,resp,'dispatch:o2:a1','twilio','twilio.create_call',o,'f2000000-0000-4000-8000-000000000002',tw);
  perform public.complete_dispatch(fam,'dispatch:o2:a1',ref,'AC'||repeat('a',32),repeat('c',64),true);
  -- wrong digit event
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status) values
   (fam,'twilio','AC:gather:digit2','twilio.gather.response',jsonb_build_object('call_id',tw,'person_id',resp,'digit','2'),'processed');
  begin perform public.record_responder_acceptance(fam,'AC:gather:digit2'); raise exception 'FAIL digit 2 accepted'; exception when insufficient_privilege then null; end;
  -- gather event naming another person than the call's responder
  insert into public.raw_events(family_id,source,provider_event_id,event_type,metadata,status) values
   (fam,'twilio','AC:gather:other','twilio.gather.response',jsonb_build_object('call_id',tw,'person_id','c2000000-0000-4000-8000-000000000001','digit','1'),'processed');
  begin perform public.record_responder_acceptance(fam,'AC:gather:other'); raise exception 'FAIL other responder accepted'; exception when insufficient_privilege then null; end;
  begin perform public.record_responder_acceptance('b2000000-0000-4000-8000-000000000002','AC:gather:CA1'); raise exception 'FAIL cross-family'; exception when insufficient_privilege then null; end;
  update public.raw_events set received_at=now() where provider_event_id='AC:gather:CA1';
  proof := public.record_responder_acceptance(fam,'AC:gather:CA1');
  select metadata into m from public.raw_events where id=(proof->>'proof_event_id')::uuid;
  if m->>'incident_id'<>'a2000000-0000-4000-8000-000000000001' or m->>'assignment_id'<>asg::text or m->>'responder_person_id'<>resp::text
    or m->>'person_id'<>resp::text or m->>'subject_person_id'<>'c2000000-0000-4000-8000-000000000001' or m->>'call_id'<>tw::text
    or m->>'account_id'<>'AC'||repeat('a',32) or m->>'dispatch_key'<>'dispatch:o2:a1' or m->>'provider_action'<>'twilio.create_call' or m->>'outbox_id'<>o::text
    or m->>'action_request_id'<>'a3000000-0000-4000-8000-000000000001' or m->>'action'<>'urgent_responder' or m->>'verified_by'<>'twilio_signature' then
    raise exception 'FAIL common metadata contract %',m;
  end if;
  if (select status from public.assignments where id=asg)<>'offered' then raise exception 'FAIL recording proof must not accept'; end if;
  if public.accept_assignment_verified(fam,asg,sarvam_ev) or public.accept_assignment_verified(fam,asg,completed_ev) then raise exception 'FAIL non-proof accepted'; end if;
  if public.accept_assignment_verified('b2000000-0000-4000-8000-000000000002',asg,(proof->>'proof_event_id')::uuid) then raise exception 'FAIL cross-family accept'; end if;
  if pg_temp.p3_accept(o,false) then raise exception 'FAIL Phase 3 saw acceptance before the assignment was accepted'; end if;
  if not public.accept_assignment_verified(fam,asg,(proof->>'proof_event_id')::uuid) then raise exception 'FAIL valid accept'; end if;
  if not pg_temp.p3_accept(o,false) or not pg_temp.p3_accept(o,true) then raise exception 'FAIL real responder.accepted vs Phase 3 predicate'; end if;
  if (select status from public.assignments where id=asg)<>'accepted' then raise exception 'FAIL status'; end if;
  if not public.accept_assignment_verified(fam,asg,(proof->>'proof_event_id')::uuid) then raise exception 'FAIL idempotent accept'; end if;
  p2 := public.record_responder_acceptance(fam,'AC:gather:CA1');
  if p2->>'proof_event_id'<>proof->>'proof_event_id' then raise exception 'FAIL replay proof'; end if;
  if public.accept_assignment_verified(fam,asg,sarvam_ev) then raise exception 'FAIL accepted assignment re-verified by other event'; end if;
end $$;

-- ---------------------------------------------------------------- recording metadata, first-recording policy, purge
do $$ declare fam uuid := 'b2000000-0000-4000-8000-000000000001'; cid uuid := 'd2000000-0000-4000-8000-000000000004';
  pid uuid := 'c2000000-0000-4000-8000-000000000001'; yes uuid; gyes uuid; p1 text; p2 text; h1 text := repeat('1',64); h2 text := repeat('2',64); begin
  p1 := fam||'/calls/'||cid||'/'||repeat('1',32)||'.wav'; p2 := fam||'/calls/'||cid||'/'||repeat('2',32)||'.wav';
  begin perform public.put_call_recording(fam,cid,gen_random_uuid(),p1,now()+interval '30 days',h1); raise exception 'FAIL no consent'; exception when insufficient_privilege then null; end;
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at) values
   (fam,pid,null,'call_recording','Synthetic?',true,'v1',now()-interval '3 hours') returning id into gyes;
  begin perform public.put_call_recording(fam,cid,gyes,p1,now()+interval '30 days',h1); raise exception 'FAIL global yes granted'; exception when insufficient_privilege then null; end;
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at) values
   (fam,pid,cid,'call_recording','Synthetic?',true,'v1',now()-interval '2 hours') returning id into yes;
  begin perform public.put_call_recording(fam,cid,yes,'../'||p1,now()+interval '30 days',h1); raise exception 'FAIL bad path'; exception when invalid_parameter_value then null; end;
  begin perform public.put_call_recording(fam,cid,yes,p1,now()+interval '900 days',h1); raise exception 'FAIL retention cap'; exception when invalid_parameter_value then null; end;
  begin perform public.put_call_recording('b2000000-0000-4000-8000-000000000002',cid,yes,p1,now()+interval '30 days',h1); raise exception 'FAIL cross-family'; exception when insufficient_privilege or invalid_parameter_value then null; end;
  if public.get_call_recording_slot(fam,cid,h1)<>'none' then raise exception 'FAIL slot none'; end if;
  if public.put_call_recording(fam,cid,yes,p1,now()+interval '30 days',h1)<>'stored' then raise exception 'FAIL stored'; end if;
  if public.put_call_recording(fam,cid,yes,p1,now()+interval '30 days',h1)<>'already_stored' then raise exception 'FAIL idempotent'; end if;
  if public.put_call_recording(fam,cid,yes,p2,now()+interval '30 days',h2)<>'ignored_additional' then raise exception 'FAIL additional'; end if;
  if public.get_call_recording_slot(fam,cid,h1)<>'same' or public.get_call_recording_slot(fam,cid,h2)<>'other' then raise exception 'FAIL slot'; end if;
  if (public.get_call_media_metadata(fam,cid)->>'consent_id')::uuid<>yes then raise exception 'FAIL media metadata link'; end if;
  -- nothing to purge while retention and consent hold
  if exists(select 1 from public.list_recording_purge_candidates(100,null) where call_id=cid) then raise exception 'FAIL premature purge candidate'; end if;
  -- retention: the injected clock is capped at the database clock
  update sahaj_private.call_content set expires_at=now()+interval '1 day' where family_id=fam and call_id=cid;
  if exists(select 1 from public.list_recording_purge_candidates(100,now()+interval '30 days') where call_id=cid) then raise exception 'FAIL fast clock over-purge'; end if;
  update sahaj_private.call_content set expires_at=now()-interval '1 minute' where family_id=fam and call_id=cid;
  if not exists(select 1 from public.list_recording_purge_candidates(100,null) where call_id=cid and object_path=p1 and reason='retention') then raise exception 'FAIL expired candidate'; end if;
  if public.finish_recording_purge(fam,cid,p2) then raise exception 'FAIL purged other path'; end if;
  if public.finish_recording_purge('b2000000-0000-4000-8000-000000000002',cid,p1) then raise exception 'FAIL purged other tenant'; end if;
  if not public.finish_recording_purge(fam,cid,p1) then raise exception 'FAIL purge'; end if;
  if public.finish_recording_purge(fam,cid,p1) then raise exception 'FAIL purge replay'; end if;
  if public.get_call_recording_slot(fam,cid,h1)<>'purged' then raise exception 'FAIL purged slot'; end if;
  if public.put_call_recording(fam,cid,yes,p1,now()+interval '30 days',h1)<>'purged' then raise exception 'FAIL restored after purge'; end if;
  if (public.get_call_media_metadata(fam,cid)->>'recording_object_path') is not null then raise exception 'FAIL path still exposed'; end if;
end $$;
-- shared consent maximum age (365 days, the same sahaj_private.consent_max_age() the Phase 3 gate reads)
do $$ declare fam uuid := 'b2000000-0000-4000-8000-000000000001'; cid uuid := 'd2000000-0000-4000-8000-000000000006';
  pid uuid := 'c2000000-0000-4000-8000-000000000001'; old uuid; young uuid; grantee uuid; exp timestamptz;
  p text := 'b2000000-0000-4000-8000-000000000001/calls/d2000000-0000-4000-8000-000000000006/'||repeat('6',32)||'.wav'; begin
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at) values
   (fam,pid,cid,'call_recording','Synthetic?',true,'v1',now()-interval '366 days') returning id into old;
  begin perform public.put_call_recording(fam,cid,old,p,now()+interval '30 days',repeat('6',64)); raise exception 'FAIL expired consent stored';
  exception when insufficient_privilege then null; end;
  begin perform public.put_call_recording(fam,cid,gen_random_uuid(),p,now()+interval '30 days',repeat('6',64)); raise exception 'FAIL unknown consent';
  exception when insufficient_privilege then null; end;
  -- a purpose or call mismatch never grants, even when young
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at) values
   (fam,pid,cid,'call_transcript','Synthetic?',true,'v1',now()-interval '1 hour') returning id into grantee;
  begin perform public.put_call_recording(fam,cid,grantee,p,now()+interval '30 days',repeat('6',64)); raise exception 'FAIL wrong purpose granted';
  exception when insufficient_privilege then null; end;
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at) values
   (fam,pid,cid,'call_recording','Synthetic?',true,'v1',now()-interval '364 days') returning id into young;
  if public.put_call_recording(fam,cid,young,p,now()+interval '30 days',repeat('6',64))<>'stored' then raise exception 'FAIL young consent'; end if;
  select expires_at into exp from sahaj_private.call_content where family_id=fam and call_id=cid;
  -- retention is capped at the grant's own expiry (about one day left), not the requested 30 days
  if exp>now()+interval '2 days' or exp<=now() then raise exception 'FAIL retention not capped at consent expiry: %',exp; end if;
  if (select count(*) from public.list_recording_purge_candidates(100,null) where call_id=cid)<>0 then raise exception 'FAIL premature'; end if;
end $$;
do $$ declare fam uuid := 'b2000000-0000-4000-8000-000000000001'; cid uuid := 'd2000000-0000-4000-8000-000000000005';
  pid uuid := 'c2000000-0000-4000-8000-000000000001'; yes uuid; p text := 'b2000000-0000-4000-8000-000000000001/calls/d2000000-0000-4000-8000-000000000005/'||repeat('3',32)||'.wav'; begin
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at) values
   (fam,pid,cid,'call_recording','Synthetic?',true,'v1',now()-interval '2 hours') returning id into yes;
  if public.put_call_recording(fam,cid,yes,p,now()+interval '30 days',repeat('3',64))<>'stored' then raise exception 'FAIL store before revoke'; end if;
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at) values
   (fam,pid,null,'call_recording','Synthetic withdrawal',false,'v1',now()-interval '1 hour');
  if not exists(select 1 from public.list_recording_purge_candidates(100,null) where call_id=cid and reason='consent') then raise exception 'FAIL revoked candidate'; end if;
  if not public.finish_recording_purge(fam,cid,p) then raise exception 'FAIL revoke purge'; end if;
end $$;
do $$ declare fam uuid := 'b2000000-0000-4000-8000-000000000001'; cid uuid := 'd2000000-0000-4000-8000-000000000001';
  pid uuid := 'c2000000-0000-4000-8000-000000000001'; yes uuid; p text := 'b2000000-0000-4000-8000-000000000001/calls/d2000000-0000-4000-8000-000000000001/'||repeat('4',32)||'.wav'; begin
  -- a global refusal (inserted by the previous block, newer than this yes) blocks the writer
  insert into public.consents(family_id,person_id,call_id,purpose,question,answer,version,created_at) values
   (fam,pid,cid,'call_recording','Synthetic?',true,'v1',now()-interval '3 hours') returning id into yes;
  begin perform public.put_call_recording(fam,cid,yes,p,now()+interval '30 days',repeat('4',64)); raise exception 'FAIL refusal ignored';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
