-- Contact revocation fence checks (20261114220000_phase2_contact_fence.sql). SCRATCH database only, run as the owner:
--   psql -X -h 127.0.0.1 -p 55439 -U postgres -d postgres -v ON_ERROR_STOP=1 -f infra/supabase/tests/phase2_contact_fence.sql
-- Applies 214500 and 220000 INSIDE this transaction when they are absent; everything is rolled back.
-- Phase 3's dispatch_ledger_authorize is disabled inside the transaction (its own tests cover it); the end-to-end path with
-- BOTH triggers active is apps/api/tests/provider-dispatch/whatsapp-scratch.test.ts and sql-concurrency.ps1.
begin;
select to_regprocedure('public.register_contact_identity(uuid,uuid,text,text,text,text)') is null as need_registry \gset
\if :need_registry
\ir ../migrations/20261114214500_phase2_contact_registry.sql
\endif
select to_regprocedure('public.claim_dispatch_contact(uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,text,text)') is null as need_fence \gset
\if :need_fence
\ir ../migrations/20261114220000_phase2_contact_fence.sql
\endif
do $$ begin
  if exists(select 1 from pg_trigger where tgname='dispatch_ledger_authorize' and tgrelid='public.dispatch_ledger'::regclass) then
    alter table public.dispatch_ledger disable trigger dispatch_ledger_authorize;
  end if;
end $$;

alter table public.outbox add column if not exists action text;
insert into public.families(id,name) values('b8000000-0000-4000-8000-000000000001','Synthetic fence A'),('b8000000-0000-4000-8000-000000000002','Synthetic fence B');
insert into public.people(id,family_id,display_name,role) values
 ('c8000000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000001','Synthetic Parent A','parent'),
 ('c8000000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000001','Synthetic Child A','child'),
 ('c8000000-0000-4000-8000-000000000003','b8000000-0000-4000-8000-000000000002','Synthetic Parent B','parent');
insert into public.outbox(id,family_id,kind,dedupe_key,payload_ciphertext,status,attempt_count,lease_token,lease_until,action)
 select ('e8000000-0000-4000-8000-00000000000'||n)::uuid,'b8000000-0000-4000-8000-000000000001','message','fence'||n,'x','processing',1,
   ('f8000000-0000-4000-8000-00000000000'||n)::uuid,now()+interval '10 minutes','check_in' from generate_series(1,8) n;

create function pg_temp.claim(p_n integer,p_identity uuid,p_account text default '1234567890',p_hash text default repeat('1',64),
  p_person uuid default 'c8000000-0000-4000-8000-000000000001') returns text language sql as $$
  select public.claim_dispatch_contact('b8000000-0000-4000-8000-000000000001',p_person,'dispatch:fence:'||p_n,'whatsapp','whatsapp.send_text',
    ('e8000000-0000-4000-8000-00000000000'||p_n)::uuid,('f8000000-0000-4000-8000-00000000000'||p_n)::uuid,null,p_identity,p_account,p_hash)
$$;
create function pg_temp.refused(p_n integer,p_identity uuid,p_account text default '1234567890',p_hash text default repeat('1',64),
  p_person uuid default 'c8000000-0000-4000-8000-000000000001') returns text language plpgsql as $$
declare msg text; st text;
begin
  perform pg_temp.claim(p_n,p_identity,p_account,p_hash,p_person);
  return 'CLAIMED';
exception when others then get stacked diagnostics st=returned_sqlstate,msg=message_text; return st||':'||msg;
end$$;

do $$ declare
  fa uuid := 'b8000000-0000-4000-8000-000000000001'; fb uuid := 'b8000000-0000-4000-8000-000000000002';
  pa uuid := 'c8000000-0000-4000-8000-000000000001'; ca uuid := 'c8000000-0000-4000-8000-000000000002'; pb uuid := 'c8000000-0000-4000-8000-000000000003';
  ct text := 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCC';
  idp uuid; idc uuid; idb uuid; idp2 uuid; r text; n integer;
begin
  -- privileges and the binding for each outbox row
  if has_function_privilege('authenticated','public.claim_dispatch_contact(uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,text,text)','EXECUTE')
    or not has_function_privilege('service_role','public.claim_dispatch_contact(uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,text,text)','EXECUTE')
    or has_function_privilege('service_role','sahaj_private.dispatch_ledger_contact_fence()','EXECUTE') then
    raise exception 'FAIL fence privileges';
  end if;
  for n in 1..8 loop
    perform public.bind_outbox_dispatch(fa,('e8000000-0000-4000-8000-00000000000'||n)::uuid,case when n=7 then ca else pa end,'whatsapp','whatsapp.send_text');
  end loop;
  perform public.register_contact_identity(fa,pa,'whatsapp','1234567890',repeat('1',64),ct);
  perform public.register_contact_identity(fa,ca,'whatsapp','1234567890',repeat('2',64),ct);
  perform public.register_contact_identity(fb,pb,'whatsapp','1234567890',repeat('3',64),ct);
  perform public.register_contact_identity(fa,pa,'sarvam','app-1',repeat('4',64),ct);
  select id into idp from public.provider_identities where person_id=pa and source='whatsapp' and binding_kind='contact';
  select id into idc from public.provider_identities where person_id=ca and source='whatsapp' and binding_kind='contact';
  select id into idb from public.provider_identities where person_id=pb and source='whatsapp' and binding_kind='contact';

  -- the old claim names no identity: refused, nothing written
  begin
    perform public.claim_dispatch(fa,pa,'dispatch:fence:old','whatsapp','whatsapp.send_text','e8000000-0000-4000-8000-000000000001','f8000000-0000-4000-8000-000000000001',null);
    raise exception 'FAIL old claim accepted';
  exception when insufficient_privilege then if sqlerrm<>'contact_identity_required' then raise; end if; end;

  -- wrong identity for this claim: another person in the family, another family, another provider, wrong account, wrong hash, unknown id
  r := pg_temp.refused(1,idc,'1234567890',repeat('2',64));                 if r<>'42501:contact_identity_not_current' then raise exception 'FAIL other person: %',r; end if;
  r := pg_temp.refused(1,idb,'1234567890',repeat('3',64));                 if r<>'42501:contact_identity_not_current' then raise exception 'FAIL other family: %',r; end if;
  r := pg_temp.refused(1,(select id from public.provider_identities where person_id=pa and source='sarvam' and binding_kind='contact'),'app-1',repeat('4',64));
  if r<>'42501:contact_identity_not_current' then raise exception 'FAIL other provider: %',r; end if;
  r := pg_temp.refused(1,idp,'999',repeat('1',64));                        if r<>'42501:contact_identity_not_current' then raise exception 'FAIL other account: %',r; end if;
  r := pg_temp.refused(1,idp,'1234567890',repeat('9',64));                 if r<>'42501:contact_identity_not_current' then raise exception 'FAIL stale hash: %',r; end if;
  r := pg_temp.refused(1,gen_random_uuid());                               if r<>'23503:insert or update on table "dispatch_ledger" violates foreign key constraint "dispatch_ledger_contact_identity_id_fkey"'
    and r<>'42501:contact_identity_not_current' then raise exception 'FAIL unknown identity: %',r; end if;
  if exists(select 1 from public.dispatch_ledger where family_id=fa) then raise exception 'FAIL refused claims wrote ledger rows'; end if;

  -- the exact current identity claims
  if pg_temp.claim(1,idp)<>'claimed' then raise exception 'FAIL valid claim'; end if;
  if (select contact_identity_id from public.dispatch_ledger where idempotency_key='dispatch:fence:1')<>idp then raise exception 'FAIL identity not recorded'; end if;

  -- resolve-then-revoke: the identity a worker resolved is revoked before its claim
  perform public.revoke_contact_identity(fa,pa,'whatsapp','1234567890');
  r := pg_temp.refused(2,idp);                                             if r<>'42501:contact_identity_not_current' then raise exception 'FAIL revoked identity claimed: %',r; end if;
  -- resolve-then-replace: a replacement number is registered; the cached old identity still cannot claim, the new one can
  perform public.register_contact_identity(fa,pa,'whatsapp','1234567890',repeat('5',64),ct);
  select id into idp2 from public.provider_identities where person_id=pa and source='whatsapp' and binding_kind='contact' and revoked_at is null;
  r := pg_temp.refused(3,idp);                                             if r<>'42501:contact_identity_not_current' then raise exception 'FAIL replaced identity claimed: %',r; end if;
  if pg_temp.claim(3,idp2,'1234567890',repeat('5',64))<>'claimed' then raise exception 'FAIL replacement claim'; end if;
  -- disabled (not revoked) and edited rows are not current either
  update public.provider_identities set enabled=false where id=idc;
  r := pg_temp.refused(7,idc,'1234567890',repeat('2',64),ca);              if r<>'42501:contact_identity_not_current' then raise exception 'FAIL disabled claimed: %',r; end if;
  update public.provider_identities set enabled=true,external_id_hash=repeat('6',64) where id=idc;
  r := pg_temp.refused(7,idc,'1234567890',repeat('2',64),ca);              if r<>'42501:contact_identity_not_current' then raise exception 'FAIL edited row claimed: %',r; end if;
  if (select count(*) from public.dispatch_ledger where family_id=fa)<>2 then raise exception 'FAIL ledger row count'; end if;
end $$;
rollback;
