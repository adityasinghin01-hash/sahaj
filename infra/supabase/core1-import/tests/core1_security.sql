-- Run as database owner after both migrations; every fixture is rolled back.
begin;
insert into auth.users(id) values
 ('a1000000-0000-4000-8000-000000000001'),('a1000000-0000-4000-8000-000000000002'),
 ('a1000000-0000-4000-8000-000000000003'),('a1000000-0000-4000-8000-000000000004');
insert into public.families(id,name) values
 ('b1000000-0000-4000-8000-000000000001','Synthetic RLS Family A'),
 ('b1000000-0000-4000-8000-000000000002','Synthetic RLS Family B');
insert into public.people(id,family_id,display_name,role) values
 ('c1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','Synthetic Child A','child'),
 ('c1000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000001','Synthetic Parent A','parent'),
 ('c1000000-0000-4000-8000-000000000003','b1000000-0000-4000-8000-000000000001','Synthetic Circle A','circle'),
 ('c1000000-0000-4000-8000-000000000004','b1000000-0000-4000-8000-000000000002','Synthetic Child B','child');
insert into public.family_memberships(family_id,user_id,person_id,role) values
 ('b1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','child'),
 ('b1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000002','parent'),
 ('b1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000003','circle'),
 ('b1000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000004','c1000000-0000-4000-8000-000000000004','child');
insert into public.calls(id,family_id,person_id,provider) values
 ('d1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000002','synthetic'),
 ('d1000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000004','synthetic');
insert into public.incidents(id,family_id,person_id,severity) values
 ('e1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000002','routine'),
 ('e1000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000004','routine');
insert into public.assignments(family_id,incident_id,person_id,expires_at) values
 ('b1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000003',now()+interval '1 hour');
insert into public.consents(id,family_id,person_id,purpose,question,answer,version) values
 ('f1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000002','synthetic_test','Synthetic test consent?',true,'test-1');
insert into public.voice_posts(family_id,sender_id,recipient_id,consent_id) values
 ('b1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000001');

-- Database constraints protect tenant relationships even from an erroneous server command.
do $$begin
  begin
    insert into public.calls(family_id,person_id,provider)
      values('b1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000004','synthetic');
    raise exception 'FAIL cross-family person reference accepted';
  exception when foreign_key_violation then null;end;
  begin
    insert into public.assignments(family_id,incident_id,person_id,expires_at)
      values('b1000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000004',now());
    raise exception 'FAIL cross-family incident reference accepted';
  exception when foreign_key_violation then null;end;
  begin
    update public.consents set answer=false where id='f1000000-0000-4000-8000-000000000001';
    raise exception 'FAIL consent mutation accepted';
  exception when integrity_constraint_violation then null;end;
end$$;

set local role authenticated;
select set_config('request.jwt.claim.sub','a1000000-0000-4000-8000-000000000001',true);
do $$begin
  if (select count(*) from public.family_memberships)<>1 then raise exception 'FAIL membership scope';end if;
  if (select count(*) from public.families where id in ('b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002'))<>1 then raise exception 'FAIL child family scope';end if;
  if (select count(*) from public.incidents where id in ('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002'))<>1 then raise exception 'FAIL child incident scope';end if;
  begin
    update public.family_memberships set role='child';
    raise exception 'FAIL client membership mutation';
  exception when insufficient_privilege then null;end;
  begin
    perform metadata from public.raw_events;
    raise exception 'FAIL raw metadata exposed';
  exception when insufficient_privilege then null;end;
  begin
    perform transcript_ciphertext from sahaj_private.call_content;
    raise exception 'FAIL private transcript exposed';
  exception when insufficient_privilege then null;end;
  begin
    perform hearing_notes from public.people;
    raise exception 'FAIL private people column exposed';
  exception when insufficient_privilege then null;end;
  begin
    perform public.claim_raw_events('unauthorized');
    raise exception 'FAIL client can claim work';
  exception when insufficient_privilege then null;end;
end$$;
select set_config('request.jwt.claim.sub','a1000000-0000-4000-8000-000000000002',true);
do $$begin
  if (select count(*) from public.calls where id in ('d1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002'))<>1 then raise exception 'FAIL parent own call status';end if;
  if exists(select 1 from public.incidents) then raise exception 'FAIL parent incidents exposed';end if;
  if not exists(select 1 from public.voice_posts where family_id='b1000000-0000-4000-8000-000000000001') then raise exception 'FAIL parent own voice absent';end if;
end$$;
select set_config('request.jwt.claim.sub','a1000000-0000-4000-8000-000000000003',true);
do $$begin
  if exists(select 1 from public.incidents) then raise exception 'FAIL circle incident payload exposed';end if;
  if exists(select 1 from public.calls) then raise exception 'FAIL circle call status exposed';end if;
  if exists(select 1 from public.voice_posts) then raise exception 'FAIL circle voice exposed';end if;
  if (select count(*) from public.assignments where family_id='b1000000-0000-4000-8000-000000000001')<>1 then raise exception 'FAIL circle assignment absent';end if;
end$$;
reset role;
update public.family_memberships set revoked_at=now() where user_id='a1000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub','a1000000-0000-4000-8000-000000000001',true);
do $$begin
  if exists(select 1 from public.families) then raise exception 'FAIL revoked member still reads';end if;
end$$;
reset role;
set local role anon;
do $$begin
  begin perform * from public.people;raise exception 'FAIL anonymous people access';
  exception when insufficient_privilege then null;end;
end$$;
reset role;

set local role service_role;
do $$declare e public.raw_events;dup public.raw_events;claimed public.raw_events;evidence public.raw_events; job uuid;o public.outbox;oc public.outbox;jc public.workflow_jobs;
begin
  e:=public.ingest_raw_event('synthetic-security','event-1','checkin.completed','b1000000-0000-4000-8000-000000000001','{}',repeat('a',64),'ciphertext-fixture');
  dup:=public.ingest_raw_event('synthetic-security','event-1','checkin.completed','b1000000-0000-4000-8000-000000000001','{}',repeat('a',64),'ignored-duplicate');
  if e.id<>dup.id or dup.payload_ciphertext<>'ciphertext-fixture' then raise exception 'FAIL duplicate overwritten';end if;
  begin
    perform public.ingest_raw_event('synthetic-security','event-1','checkin.completed','b1000000-0000-4000-8000-000000000001','{}',repeat('b',64));
    raise exception 'FAIL conflicting payload accepted';
  exception when unique_violation then null;end;
  select * into claimed from public.claim_raw_events('synthetic-worker',100,60) where id=e.id;
  if claimed.id is null or claimed.lease_token is null or claimed.attempt_count<>1 then raise exception 'FAIL claim';end if;
  if public.finish_raw_event(e.id,gen_random_uuid(),true) then raise exception 'FAIL stale lease completed';end if;
  job:=public.dispatch_raw_event(e.id,claimed.lease_token,'checkin','synthetic-thread');
  if job is null or not exists(select 1 from public.workflow_jobs where id=job) then raise exception 'FAIL durable dispatch';end if;
  if (select status from public.raw_events where id=e.id)<>'processed' then raise exception 'FAIL event not acknowledged atomically';end if;
  insert into public.outbox(family_id,workflow_job_id,kind,dedupe_key,payload_ciphertext,max_attempts)
    values(e.family_id,job,'synthetic','synthetic-security-fixture','ciphertext-fixture',1) returning * into o;
  select * into oc from public.claim_outbox('synthetic-outbox-worker',100,60) where id=o.id;
  if oc.lease_token is null then raise exception 'FAIL outbox claim';end if;
  if public.finish_outbox(o.id,gen_random_uuid(),true) then raise exception 'FAIL stale outbox lease';end if;
  if not public.finish_outbox(o.id,oc.lease_token,false,'synthetic_failure') then raise exception 'FAIL outbox failure transition';end if;
  if (select status from public.outbox where id=o.id)<>'dead' then raise exception 'FAIL exhausted outbox not dead';end if;
  insert into public.outbox(family_id,workflow_job_id,kind,dedupe_key,payload_ciphertext)
    values(e.family_id,job,'synthetic','synthetic-uncertain-fixture','ciphertext-fixture') returning * into o;
  select * into oc from public.claim_outbox('synthetic-outbox-worker',100,60) where id=o.id;
  update public.outbox set lease_until=now()-interval '1 second' where id=o.id;
  if exists(select 1 from public.claim_outbox('synthetic-outbox-worker',100,60) where id=o.id) then raise exception 'FAIL ambiguous delivery reclaimed';end if;
  if (select status from public.outbox where id=o.id)<>'delivery_unknown' then raise exception 'FAIL ambiguous delivery state';end if;
  if public.finish_outbox(o.id,oc.lease_token,true) then raise exception 'FAIL expired outbox lease completed';end if;
  if public.reconcile_outbox(o.id,e.id,'delivered') then raise exception 'FAIL unrelated evidence accepted';end if;
  evidence:=public.ingest_raw_event('synthetic-security','delivery-evidence-1','delivery.confirmed',e.family_id,
    jsonb_build_object('outbox_id',o.id,'outcome','delivered'),repeat('c',64),'ciphertext-evidence');
  select * into claimed from public.claim_raw_events('synthetic-evidence-worker',100,60) where id=evidence.id;
  if not public.finish_raw_event(evidence.id,claimed.lease_token,true) then raise exception 'FAIL evidence processing';end if;
  if public.reconcile_outbox(o.id,evidence.id,'confirmed_not_sent') then raise exception 'FAIL mismatched evidence outcome accepted';end if;
  if not public.reconcile_outbox(o.id,evidence.id,'delivered') then raise exception 'FAIL reconciliation';end if;
  if (select status from public.outbox where id=o.id)<>'completed' then raise exception 'FAIL reconciliation state';end if;
  select * into jc from public.claim_workflow_jobs('synthetic-workflow-worker',100,120) where id=job;
  if jc.lease_token is null then raise exception 'FAIL workflow claim';end if;
  if not public.finish_workflow_job(job,jc.lease_token,'interrupted','synthetic-checkpoint','synthetic-interrupt') then raise exception 'FAIL durable interrupt';end if;
  if public.resume_workflow_job(job,'b1000000-0000-4000-8000-000000000002','synthetic-interrupt') then raise exception 'FAIL cross-family workflow resume';end if;
  if not public.resume_workflow_job(job,e.family_id,'synthetic-interrupt','ciphertext-resume-fixture') then raise exception 'FAIL valid workflow resume';end if;
  if public.resume_workflow_job(job,e.family_id,'synthetic-interrupt') then raise exception 'FAIL replayed workflow resume';end if;
  select * into jc from public.claim_workflow_jobs('synthetic-workflow-worker',100,120) where id=job;
  if jc.resume_payload_ciphertext is distinct from 'ciphertext-resume-fixture' then raise exception 'FAIL durable resume payload';end if;
  if not public.finish_workflow_job(job,jc.lease_token,'completed','synthetic-final-checkpoint') then raise exception 'FAIL workflow completion';end if;
end$$;
reset role;
do $$begin
  if exists(select 1 from storage.buckets where id in ('sahaj-voice','sahaj-recordings','sahaj-lines') and public) then
    raise exception 'FAIL public media bucket';end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','sahaj_private') and c.relkind='r' and not c.relrowsecurity
      and c.relname in ('family_memberships','circle','calls','consents','schedules','requests','incidents',
        'assignments','voice_posts','medicines','vendors','permissions','action_requests','action_answers',
        'errands','nudges','child_alerts','provider_identities','workflow_jobs','outbox','call_content','private_items','voice_content')) then
    raise exception 'FAIL care table lacks RLS';end if;
end$$;
rollback;
