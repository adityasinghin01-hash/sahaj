-- C-12: isolated synthetic fixtures; all writes roll back. SQL checks hashes/CAS;
-- Ed25519 verification is covered separately by the TypeScript adapter test.
begin;
create temp table c12_checks(label text primary key);
create function pg_temp.c12_assert(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'C-12 FAIL: %', label; end if;
  insert into c12_checks values(label);
end $$;
insert into auth.users(id) values ('a1200000-0000-4000-8000-000000000001'),('a1200000-0000-4000-8000-000000000002');
insert into public.families(id,name) values ('b1200000-0000-4000-8000-000000000001','C12 synthetic A'),('b1200000-0000-4000-8000-000000000002','C12 synthetic B');
insert into public.people(id,family_id,display_name,role) values
 ('c1200000-0000-4000-8000-000000000001','b1200000-0000-4000-8000-000000000001','Riya','child'),
 ('c1200000-0000-4000-8000-000000000002','b1200000-0000-4000-8000-000000000001','Maa','parent'),
 ('c1200000-0000-4000-8000-000000000003','b1200000-0000-4000-8000-000000000002','Other','child');
insert into public.family_memberships(family_id,user_id,person_id,role) values
 ('b1200000-0000-4000-8000-000000000001','a1200000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001','child'),
 ('b1200000-0000-4000-8000-000000000002','a1200000-0000-4000-8000-000000000002','c1200000-0000-4000-8000-000000000003','child');
insert into public.raw_events(id,family_id,source,provider_event_id,event_type,payload_hash,metadata,status) values
 ('d1200000-0000-4000-8000-000000000001','b1200000-0000-4000-8000-000000000001','core2','c12-fixture','core2.watch.started',repeat('a',64),'{}','processed');
insert into public.core2_watches(id,family_id,subject_person_id,raw_event_id,timezone,deadline_at,grace_until,created_at) values
 ('e1200000-0000-4000-8000-000000000001','b1200000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001','d1200000-0000-4000-8000-000000000001','Asia/Kolkata',now()+interval '10 min',now()+interval '20 min',now()-interval '10 min');

-- Atomic idempotency, monotonic samples and the exact <=10 threshold.
do $$ declare r jsonb; baseline timestamptz; n integer;
begin
  r:=public.core2_report_device_status('b1200000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',repeat('1',64),repeat('2',64),
    jsonb_build_object('battery_level',11,'is_charging',false,'sampled_at',now()-interval '2 min'),'d1200000-0000-4000-8000-000000000001');
  perform pg_temp.c12_assert((r->'device_status'->>'battery_level')::int=11,'own status stored');
  perform pg_temp.c12_assert(not (r->>'idempotent_replay')::boolean,'initial write is not replay');
  select count(*) into n from public.core2_due_device_handovers(180000);
  perform pg_temp.c12_assert(n=0,'11 percent does not trigger');
  select heartbeat_at into baseline from public.core2_device_status;
  r:=public.core2_report_device_status('b1200000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',repeat('1',64),repeat('2',64),
    jsonb_build_object('battery_level',11,'is_charging',false,'sampled_at',now()-interval '2 min'),'d1200000-0000-4000-8000-000000000001');
  perform pg_temp.c12_assert((r->>'idempotent_replay')::boolean,'identical key replays');
  perform pg_temp.c12_assert((select heartbeat_at=baseline from public.core2_device_status),'replay does not refresh heartbeat');
  begin
    perform public.core2_report_device_status('b1200000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',repeat('1',64),repeat('3',64),
      '{"battery_level":1,"is_charging":false,"sampled_at":"2026-11-15T00:00:00.000Z"}','d1200000-0000-4000-8000-000000000001');
    raise exception 'changed-key payload accepted';
  exception when unique_violation then perform pg_temp.c12_assert(true,'changed key conflicts'); end;
  r:=public.core2_report_device_status('b1200000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',repeat('4',64),repeat('5',64),
    jsonb_build_object('battery_level',1,'is_charging',true,'sampled_at',now()-interval '3 min'),'d1200000-0000-4000-8000-000000000001');
  perform pg_temp.c12_assert((r->'device_status'->>'battery_level')::int=11,'late older request cannot replace current status');
  perform pg_temp.c12_assert((select heartbeat_at=baseline from public.core2_device_status),'older sample cannot freshen heartbeat');
  r:=public.core2_report_device_status('b1200000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',repeat('6',64),repeat('7',64),
    jsonb_build_object('battery_level',10,'is_charging',false,'sampled_at',now()-interval '1 min'),'d1200000-0000-4000-8000-000000000001');
  select count(*) into n from public.core2_due_device_handovers(180000);
  perform pg_temp.c12_assert(n=1,'10 percent triggers during active watch');
  perform pg_temp.c12_assert((select reason='low_battery' from public.core2_device_handovers),'threshold reason is low battery');
  perform public.core2_due_device_handovers(180000);
  perform pg_temp.c12_assert((select count(*)=1 from public.core2_device_handovers),'repeated ticks do not duplicate work');
end $$;

-- A recovered phone must invalidate a prepared job before signing/dispatching.
update public.core2_device_status set battery_level=80;
select public.core2_complete_device_handover((select id from public.core2_device_handovers),'{}','{}',repeat('0',64),'invalid','[]');
select pg_temp.c12_assert((select count(*)=0 from public.core2_device_handovers),'recovery cancels unfinished low-battery job');
update public.core2_device_status set battery_level=10;
select pg_temp.c12_assert((select count(*)=1 from public.core2_due_device_handovers(180000)),'later low-battery drop can create fresh work');

-- Signed timeline commit is atomic and idempotent, using SQL-layer signature-format
-- fixture only (the TS suite generates and verifies a real Ed25519 signature).
do $$ declare j public.core2_device_handovers; e jsonb; payload text:='{"location_included":false}'; h text; notices jsonb;
begin
  select * into strict j from public.core2_device_handovers;
  e:=jsonb_build_object('version',1,'familyId',j.family_id,'eventId',j.id,'sequence',1,
    'dedupeKey','core2:device:'||j.id,'eventType','core2.device.handover','entityId',j.watch_id,
    'humanLine','Phone update handover recorded calmly.','previousHash',null,'occurredAt','2026-11-15T00:00:00.000Z',
    'keyId','c12-sql-fixture','payloadHash',encode(sha256(convert_to(E'SAHAJ.timeline.payload.v1\n'||payload,'UTF8')),'hex'));
  h:=encode(sha256(convert_to(E'SAHAJ.timeline.chain.v1\n'||sahaj_private.timeline_envelope_canonical(e),'UTF8')),'hex');
  notices:=jsonb_build_array(jsonb_build_object('recipient','c1200000-0000-4000-8000-000000000002','parent',true,
    'statusLabel','Riya ka phone charge kam hai; naye update ka intezar hai','command',jsonb_build_object(
      'familyId',j.family_id,'kind','core2.reassurance','dedupeKey','c12-notice','payloadCiphertext','encrypted-synthetic','trustedContactId',null)));
  begin
    perform public.core2_complete_device_handover(j.id,e,payload,repeat('0',64),repeat('A',86)||'==',notices);
    raise exception 'invalid timeline accepted';
  exception when invalid_parameter_value then perform pg_temp.c12_assert(true,'invalid signature envelope hash fails closed'); end;
  perform pg_temp.c12_assert((select count(*)=0 from public.outbox where dedupe_key='c12-notice'),'failed commit has no outbox');
  perform pg_temp.c12_assert((select completed_at is null from public.core2_device_handovers where id=j.id),'failed job remains retryable');
  perform public.core2_complete_device_handover(j.id,e,payload,h,repeat('A',86)||'==',notices);
  perform public.core2_complete_device_handover(j.id,e,payload,h,repeat('A',86)||'==',notices);
  perform pg_temp.c12_assert((select count(*)=1 from public.timeline_events where event_type='core2.device.handover'),'one immutable timeline on replay');
  perform pg_temp.c12_assert((select count(*)=1 from public.outbox where dedupe_key='c12-notice'),'one outbox on replay');
  perform pg_temp.c12_assert((select count(*)=1 from public.core2_reassurance_updates where subject_person_id=j.person_id),'one Maa truth line');
  perform pg_temp.c12_assert((select not location_shared and not health_shared and not narrative_shared and not delivery_verified
    from public.core2_reassurance_updates where subject_person_id=j.person_id),'Maa line no location and no invented delivery');
end $$;

-- Stale >3min boundary, scaled timer, resolved watches, unknown/never-seen battery.
delete from public.core2_device_handovers;
update public.core2_device_status set battery_level=null,heartbeat_at=now()-interval '3 min';
select pg_temp.c12_assert((select count(*)=0 from public.core2_due_device_handovers(180000)),'exact three minutes is not stale');
update public.core2_device_status set heartbeat_at=now()-interval '3 min 1 sec';
select pg_temp.c12_assert((select count(*)=1 from public.core2_due_device_handovers(180000)),'over three minutes is stale');
select pg_temp.c12_assert((select reason='stale_heartbeat' from public.core2_device_handovers),'unknown battery uses stale reason');
delete from public.core2_device_handovers;
update public.core2_device_status set heartbeat_at=now()-interval '2 sec';
select pg_temp.c12_assert((select count(*)=0 from public.core2_due_device_handovers(180000)),'normal timer remains fresh');
select pg_temp.c12_assert((select count(*)=1 from public.core2_due_device_handovers(1800)),'demo timer scales stale threshold');
delete from public.core2_device_handovers;
delete from public.core2_device_status;
select pg_temp.c12_assert((select count(*)=1 from public.core2_due_device_handovers(180000)),'never-seen phone uses watch creation');
delete from public.core2_device_handovers;
update public.core2_watches set state='safe',safe_at=now(),next_tick_at=null;
select pg_temp.c12_assert((select count(*)=0 from public.core2_due_device_handovers(180000)),'safe watch never triggers');

-- Low battery alone is quiet; an active SOS also hands over (including charging state).
insert into public.core2_device_status(family_id,person_id,battery_level,is_charging,sampled_at) values
 ('b1200000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',0,true,now());
select pg_temp.c12_assert((select count(*)=0 from public.core2_due_device_handovers(180000)),'zero battery without watch or SOS is quiet');
insert into public.requests(id,family_id,person_id,kind) values
 ('e1200000-0000-4000-8000-000000000002','b1200000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001','sos');
insert into public.incidents(id,family_id,person_id,request_id,severity) values
 ('e1200000-0000-4000-8000-000000000003','b1200000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001','e1200000-0000-4000-8000-000000000002','critical');
insert into public.core2_sos_events(id,family_id,subject_person_id,incident_id,request_id,raw_event_id,status) values
 ('e1200000-0000-4000-8000-000000000004','b1200000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001','e1200000-0000-4000-8000-000000000003','e1200000-0000-4000-8000-000000000002','d1200000-0000-4000-8000-000000000001','queued');
select pg_temp.c12_assert((select count(*)=1 from public.core2_due_device_handovers(180000)),'zero percent while charging triggers active SOS');
select pg_temp.c12_assert((select sos_id is not null and watch_id is null from public.core2_device_handovers),'SOS job references only SOS');
delete from public.core2_device_handovers;
update public.core2_sos_events set status='safe',safe_at=now();
select pg_temp.c12_assert((select count(*)=0 from public.core2_due_device_handovers(180000)),'safe SOS never triggers');
delete from public.core2_device_status;

-- Real RLS: own insert/update/read, no writes to another person or family, no RPC bypass.
set local role authenticated;
select set_config('request.jwt.claim.sub','a1200000-0000-4000-8000-000000000001',true);
insert into public.core2_device_status(family_id,person_id,battery_level,is_charging,sampled_at) values
 ('b1200000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',15,false,now());
update public.core2_device_status set battery_level=14 where person_id='c1200000-0000-4000-8000-000000000001';
do $$ begin
  if (select battery_level from public.core2_device_status)<>14 then raise exception 'own write failed'; end if;
  begin
    insert into public.core2_device_status(family_id,person_id,battery_level,is_charging,sampled_at) values
      ('b1200000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000002',10,false,now());
    raise exception 'another person write allowed';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.core2_device_status(family_id,person_id,battery_level,is_charging,sampled_at) values
      ('b1200000-0000-4000-8000-000000000002','c1200000-0000-4000-8000-000000000003',10,false,now());
    raise exception 'another family write allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform public.core2_due_device_handovers(1);
    raise exception 'client worker RPC allowed';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','a1200000-0000-4000-8000-000000000002',true);
do $$ begin
  if (select count(*) from public.core2_device_status)<>0 then raise exception 'cross-family read allowed'; end if;
  update public.core2_device_status set battery_level=0;
  if found then raise exception 'cross-family update allowed'; end if;
end $$;
reset role;
select pg_temp.c12_assert(true,'RLS own write and read');
select pg_temp.c12_assert(true,'RLS same-family other-person write denied');
select pg_temp.c12_assert(true,'RLS other-family insert denied');
select pg_temp.c12_assert(true,'RLS worker RPC denied');
select pg_temp.c12_assert(true,'RLS cross-family read denied');
select pg_temp.c12_assert((select battery_level=14 from public.core2_device_status),'RLS cross-family update denied');
update public.family_memberships set revoked_at=now() where user_id='a1200000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub','a1200000-0000-4000-8000-000000000001',true);
do $$ begin if (select count(*) from public.core2_device_status)<>0 then raise exception 'revoked member read allowed'; end if; end $$;
reset role;
select pg_temp.c12_assert(true,'RLS revoked member read denied');
select 'C-12 SQL checks passed: '||count(*) from c12_checks;
rollback;
