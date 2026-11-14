-- Combined-schema tenant/revocation/column-privacy regression. Rollback-only.
begin;
insert into auth.users(id) values ('90909090-9090-4090-8090-909090909091');
insert into public.families(id,name) values ('90909090-9090-4090-8090-909090909092','Synthetic bridge family');
insert into public.people(id,family_id,display_name,role,aliases)
values ('90909090-9090-4090-8090-909090909093','90909090-9090-4090-8090-909090909092','Synthetic child','child',array['Beta']);
insert into public.family_memberships(family_id,user_id,person_id,role)
values ('90909090-9090-4090-8090-909090909092','90909090-9090-4090-8090-909090909091','90909090-9090-4090-8090-909090909093','child');
insert into public.shield_family_security(family_id,code_word_hash)
values ('90909090-9090-4090-8090-909090909092',repeat('a',64));
insert into public.shield_verdicts(family_id,parent_id,level,scam_type,confidence,actions)
values ('90909090-9090-4090-8090-909090909092','90909090-9090-4090-8090-909090909093','red','kyc_block',1,'{}');
do $$ begin
 if exists(select 1 from information_schema.columns where table_schema='public' and table_name='people' and column_name='phone') then raise exception 'plaintext people.phone exists'; end if;
 if to_regclass('public.family_members') is not null then raise exception 'obsolete membership table exists'; end if;
 if has_column_privilege('authenticated','public.people','aliases','SELECT') then raise exception 'client aliases exposed'; end if;
 if has_table_privilege('authenticated','public.shield_family_security','SELECT') then raise exception 'client code hash exposed'; end if;
 if has_table_privilege('authenticated','public.provider_identities','SELECT') then raise exception 'client contact index exposed'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','90909090-9090-4090-8090-909090909091',true);
do $$ begin
 if (select count(*) from public.shield_verdicts where family_id='90909090-9090-4090-8090-909090909092')<>1 then raise exception 'active child denied'; end if;
end $$;
reset role;
update public.family_memberships set revoked_at=now() where user_id='90909090-9090-4090-8090-909090909091';
set local role authenticated;
do $$ begin
 if exists(select 1 from public.shield_verdicts where family_id='90909090-9090-4090-8090-909090909092') then raise exception 'revoked membership retains Shield access'; end if;
end $$;
reset role;
rollback;
