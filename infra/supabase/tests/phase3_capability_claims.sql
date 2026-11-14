-- Capability-filtered outbox claim. Assertions are scoped to this file's synthetic family, because a shared scratch database
-- may hold other committed synthetic rows (which the claims here may also lease; the final rollback undoes that).
-- Synthetic data only; everything rolls back (including the function itself when this file
-- had to load it because 20261115000000 is not applied yet). Run with psql -v ON_ERROR_STOP=1.
begin;
select not exists(select 1 from pg_proc where proname='claim_outbox_for_capabilities') as need_fn \gset
\if :need_fn
\ir ../migrations/20261115000000_phase3_capability_claims.sql
\endif
insert into public.families(id,name) values('bc000000-0000-4000-8000-000000000001','Synthetic Capability Family');
insert into public.people(id,family_id,display_name,role) values
 ('cc000000-0000-4000-8000-000000000001','bc000000-0000-4000-8000-000000000001','Subject','parent'),
 ('cc000000-0000-4000-8000-000000000002','bc000000-0000-4000-8000-000000000001','Responder','circle');
insert into public.outbox(id,family_id,kind,dedupe_key,payload_ciphertext,action,attempt_count,max_attempts) values
 ('ac000000-0000-4000-8000-000000000001','bc000000-0000-4000-8000-000000000001','check_in','cap-sarvam','ct','check_in',0,5),
 ('ac000000-0000-4000-8000-000000000002','bc000000-0000-4000-8000-000000000001','urgent_responder','cap-twilio','ct','urgent_responder',2,5),
 ('ac000000-0000-4000-8000-000000000003','bc000000-0000-4000-8000-000000000001','family_report','cap-whatsapp','ct','family_report',0,5),
 ('ac000000-0000-4000-8000-000000000004','bc000000-0000-4000-8000-000000000001','urgent_responder','cap-twilio-dead','ct','urgent_responder',5,5),
 ('ac000000-0000-4000-8000-000000000005','bc000000-0000-4000-8000-000000000001','check_in','cap-unbound','ct','check_in',0,5);
select public.bind_outbox_dispatch('bc000000-0000-4000-8000-000000000001','ac000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000001','sarvam','sarvam.outbound_call');
select public.bind_outbox_dispatch('bc000000-0000-4000-8000-000000000001','ac000000-0000-4000-8000-000000000002','cc000000-0000-4000-8000-000000000002','twilio','twilio.create_call');
select public.bind_outbox_dispatch('bc000000-0000-4000-8000-000000000001','ac000000-0000-4000-8000-000000000003','cc000000-0000-4000-8000-000000000001','whatsapp','whatsapp.send_text');
select public.bind_outbox_dispatch('bc000000-0000-4000-8000-000000000001','ac000000-0000-4000-8000-000000000004','cc000000-0000-4000-8000-000000000002','twilio','twilio.create_call');
create temporary table t_before on commit drop as
  select id,status,attempt_count,retry_at,lease_token,last_error_code from public.outbox where family_id='bc000000-0000-4000-8000-000000000001';
grant select on t_before to service_role;

set local role service_role;
do $$declare n integer;ids uuid[];
begin
  if has_function_privilege('authenticated','public.claim_outbox_for_capabilities(text,text[],integer,integer)','EXECUTE')
    or has_function_privilege('anon','public.claim_outbox_for_capabilities(text,text[],integer,integer)','EXECUTE') then
    raise exception 'FAIL client can claim outbox';
  end if;
  -- Sarvam-only tick.
  select array_agg(id) into ids from public.claim_outbox_for_capabilities('cap-worker',array['sarvam.outbound_call:check_in'],100,60)
    where family_id='bc000000-0000-4000-8000-000000000001';
  if ids is distinct from array['ac000000-0000-4000-8000-000000000001'::uuid] then raise exception 'FAIL sarvam-only claimed %',ids; end if;
  -- Twilio, WhatsApp, the over-limit Twilio row and the unbound row are byte-for-byte untouched (no attempt, no dead-letter).
  select count(*) into n from public.outbox o join t_before b on b.id=o.id
    where o.id<>'ac000000-0000-4000-8000-000000000001' and (o.status,o.attempt_count,o.retry_at,o.lease_token,o.last_error_code)
      is distinct from (b.status,b.attempt_count,b.retry_at,b.lease_token,b.last_error_code);
  if n<>0 then raise exception 'FAIL % ineligible rows changed by a sarvam-only claim',n; end if;
  -- Same provider action under a different care action is not eligible.
  if exists(select 1 from public.claim_outbox_for_capabilities('cap-worker',array['twilio.create_call:check_in'],100,60) c
      where c.family_id='bc000000-0000-4000-8000-000000000001') then
    raise exception 'FAIL capability matched on provider action alone';
  end if;
  -- Twilio capability: claims the live row and dead-letters only its own over-limit row.
  select array_agg(id) into ids from public.claim_outbox_for_capabilities('cap-worker',array['twilio.create_call:urgent_responder'],100,60)
    where family_id='bc000000-0000-4000-8000-000000000001';
  if ids is distinct from array['ac000000-0000-4000-8000-000000000002'::uuid] then raise exception 'FAIL twilio claimed %',ids; end if;
  if (select status from public.outbox where id='ac000000-0000-4000-8000-000000000004')<>'dead' then raise exception 'FAIL over-limit eligible row not dead-lettered'; end if;
  if (select (status,attempt_count) from public.outbox where id='ac000000-0000-4000-8000-000000000002')<>('processing'::text,3) then raise exception 'FAIL claim did not count one attempt'; end if;
  if (select (status,attempt_count) from public.outbox where id='ac000000-0000-4000-8000-000000000003')<>('pending'::text,0) then raise exception 'FAIL whatsapp row touched'; end if;
  if (select (status,attempt_count) from public.outbox where id='ac000000-0000-4000-8000-000000000005')<>('pending'::text,0) then raise exception 'FAIL unbound row touched'; end if;
  -- Malformed capability sets are refused.
  begin perform public.claim_outbox_for_capabilities('cap-worker',array[]::text[],10,60); raise exception 'FAIL empty capabilities accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.claim_outbox_for_capabilities('cap-worker',array['sarvam.outbound_call'],10,60); raise exception 'FAIL capability without care action accepted';
  exception when invalid_parameter_value then null; end;
end$$;
reset role;
rollback;
