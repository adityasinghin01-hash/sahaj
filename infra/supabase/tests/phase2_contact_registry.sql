-- Contact registry checks. SCRATCH database only, run as the owner:
--   psql -X -h 127.0.0.1 -p 55439 -U postgres -d postgres -v ON_ERROR_STOP=1 -f infra/supabase/tests/phase2_contact_registry.sql
-- If 20261114214500_phase2_contact_registry.sql is not applied yet, it is applied INSIDE this transaction and rolled back with it.
begin;
select to_regprocedure('public.register_contact_identity(uuid,uuid,text,text,text,text)') is null as need_registry \gset
\if :need_registry
\ir ../migrations/20261114214500_phase2_contact_registry.sql
\endif

insert into public.families(id,name) values('b6000000-0000-4000-8000-000000000001','Synthetic contacts A'),('b6000000-0000-4000-8000-000000000002','Synthetic contacts B');
insert into public.people(id,family_id,display_name,role) values
 ('c6000000-0000-4000-8000-000000000001','b6000000-0000-4000-8000-000000000001','Synthetic Parent A','parent'),
 ('c6000000-0000-4000-8000-000000000002','b6000000-0000-4000-8000-000000000001','Synthetic Child A','child'),
 ('c6000000-0000-4000-8000-000000000003','b6000000-0000-4000-8000-000000000002','Synthetic Parent B','parent');

do $$ declare
  fa uuid := 'b6000000-0000-4000-8000-000000000001'; fb uuid := 'b6000000-0000-4000-8000-000000000002';
  pa uuid := 'c6000000-0000-4000-8000-000000000001'; ca uuid := 'c6000000-0000-4000-8000-000000000002'; pb uuid := 'c6000000-0000-4000-8000-000000000003';
  ct text := 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCC';
  h1 text := repeat('1',64); h2 text := repeat('2',64); n integer;
begin
  -- privileges: service role only
  if has_function_privilege('authenticated','public.register_contact_identity(uuid,uuid,text,text,text,text)','EXECUTE')
    or has_function_privilege('anon','public.register_contact_identity(uuid,uuid,text,text,text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.revoke_contact_identity(uuid,uuid,text,text)','EXECUTE')
    or not has_function_privilege('service_role','public.register_contact_identity(uuid,uuid,text,text,text,text)','EXECUTE') then
    raise exception 'FAIL registry privileges';
  end if;
  set local role service_role;
  if public.register_contact_identity(fa,pa,'whatsapp','1234567890',h1,ct)<>'registered' then raise exception 'FAIL register'; end if;
  if public.register_contact_identity(fa,pa,'whatsapp','1234567890',h1,ct)<>'already_registered' then raise exception 'FAIL idempotent'; end if;
  -- the same number (hash) can never move to another person in the family or to another family
  begin perform public.register_contact_identity(fa,ca,'whatsapp','1234567890',h1,ct); raise exception 'FAIL moved within family';
  exception when unique_violation then if sqlerrm<>'identity_owned_elsewhere' then raise; end if; end;
  begin perform public.register_contact_identity(fb,pb,'whatsapp','1234567890',h1,ct); raise exception 'FAIL moved across families';
  exception when unique_violation then if sqlerrm<>'identity_owned_elsewhere' then raise; end if; end;
  -- a person outside the family, a second active number for the same account, malformed input
  begin perform public.register_contact_identity(fa,pb,'whatsapp','1234567890',h2,ct); raise exception 'FAIL cross-family person';
  exception when insufficient_privilege then null; end;
  begin perform public.register_contact_identity(fa,pa,'whatsapp','1234567890',h2,ct); raise exception 'FAIL second active number';
  exception when unique_violation then if sqlerrm<>'contact_already_registered' then raise; end if; end;
  begin perform public.register_contact_identity(fa,pa,'email','1234567890',h2,ct); raise exception 'FAIL bad source';
  exception when invalid_parameter_value then null; end;
  begin perform public.register_contact_identity(fa,pa,'whatsapp','1234567890',h2,'+919000000001'); raise exception 'FAIL plaintext accepted as ciphertext';
  exception when invalid_parameter_value then null; end;
  -- the same number for a different provider account is a different identity
  if public.register_contact_identity(fa,pa,'sarvam','app-1',h1,ct)<>'registered' then raise exception 'FAIL second account'; end if;
  -- revoke, then: no implicit revival, and the number still cannot move to another person
  n := public.revoke_contact_identity(fa,pa,'whatsapp','1234567890');
  if n<>1 then raise exception 'FAIL revoke %',n; end if;
  if public.revoke_contact_identity(fa,pa,'whatsapp','1234567890')<>0 then raise exception 'FAIL revoke replay'; end if;
  begin perform public.register_contact_identity(fa,pa,'whatsapp','1234567890',h1,ct); raise exception 'FAIL revived implicitly';
  exception when unique_violation then if sqlerrm<>'identity_revoked' then raise; end if; end;
  begin perform public.register_contact_identity(fa,ca,'whatsapp','1234567890',h1,ct); raise exception 'FAIL revoked number moved';
  exception when unique_violation then if sqlerrm<>'identity_owned_elsewhere' then raise; end if; end;
  -- after revocation the person may register a NEW number for the account
  if public.register_contact_identity(fa,pa,'whatsapp','1234567890',h2,ct)<>'registered' then raise exception 'FAIL new number after revoke'; end if;
  begin perform public.revoke_contact_identity(fa,pb,'whatsapp','1234567890'); raise exception 'FAIL revoke cross-family';
  exception when insufficient_privilege then null; end;
  reset role;
  -- the partial unique index also stops a direct writer from creating a second active contact
  begin
    insert into public.provider_identities(family_id,person_id,source,account_id,external_id_hash,binding_kind,contact_ciphertext)
      values(fa,pa,'whatsapp','1234567890',repeat('3',64),'contact',ct);
    raise exception 'FAIL second active contact via direct insert';
  exception when unique_violation then null; end;
  if (select count(*) from public.provider_identities where family_id=fa and contact_ciphertext like '+%')<>0 then raise exception 'FAIL plaintext stored'; end if;
end $$;
rollback;
