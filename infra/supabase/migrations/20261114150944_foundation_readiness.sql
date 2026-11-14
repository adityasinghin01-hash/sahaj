-- Bounded API health probe uses a single read-only service RPC. No tenant data.
create function public.foundation_readiness() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if pg_catalog.to_regnamespace('sahaj_checkpoints') is null
   or pg_catalog.to_regclass('sahaj_checkpoints.checkpoint_migrations') is null
   or pg_catalog.to_regclass('storage.buckets') is null then
   return jsonb_build_object('database','connected','schema_version','foundation-v4','schema_ready',false);
 end if;
 return (with required_tables(schema_name,table_name) as (values
 ('public','action_answers'),('public','action_requests'),('public','assignments'),
 ('public','calls'),('public','child_alerts'),('public','circle'),('public','consents'),
 ('public','errands'),('public','families'),('public','family_memberships'),
 ('public','idempotency_keys'),('public','incidents'),('public','medicines'),
 ('public','nudges'),('public','outbox'),('public','people'),('public','permissions'),
 ('public','provider_identities'),('public','raw_events'),('public','requests'),
 ('public','schedules'),('public','timeline_events'),('public','timeline_stream_heads'),
 ('public','vendors'),('public','voice_posts'),('public','workflow_jobs'),
 ('sahaj_private','call_content'),('sahaj_private','private_items'),('sahaj_private','voice_content'),
 ('sahaj_checkpoints','checkpoint_blobs'),('sahaj_checkpoints','checkpoint_migrations'),
 ('sahaj_checkpoints','checkpoint_writes'),('sahaj_checkpoints','checkpoints')
), required_functions(signature) as (values
 ('public.ingest_raw_event(text,text,text,uuid,jsonb,text,text)'),
 ('public.claim_raw_events(text,integer,integer)'),
 ('public.dispatch_raw_event(uuid,uuid,text,text)'),
 ('public.claim_workflow_jobs(text,integer,integer)'),
 ('public.append_timeline_event(jsonb,text,text,text)'),
 ('public.get_voice_media_metadata(uuid,uuid)'),
 ('public.get_call_media_metadata(uuid,uuid)')
)
select jsonb_build_object('database','connected','schema_version','foundation-v4','schema_ready',
 not exists(
   select 1 from required_tables t
   left join pg_catalog.pg_namespace n on n.nspname=t.schema_name
   left join pg_catalog.pg_class c on c.relnamespace=n.oid and c.relname=t.table_name
   where c.oid is null or c.relkind<>'r' or not c.relrowsecurity
 )
 and not exists(
   select 1 from required_functions f
   where pg_catalog.to_regprocedure(f.signature) is null
     or pg_catalog.has_function_privilege('anon',pg_catalog.to_regprocedure(f.signature),'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated',pg_catalog.to_regprocedure(f.signature),'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role',pg_catalog.to_regprocedure(f.signature),'EXECUTE')
 )
 and (select count(*)=3 from storage.buckets
   where id in ('sahaj-voice','sahaj-recordings','sahaj-lines') and not public)
 and exists(select 1 from pg_catalog.pg_roles r where r.rolname='sahaj_atlas_runtime'
   and not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole
   and not r.rolreplication and not r.rolinherit
   and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=r.oid)
   and not pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE'))
 and not pg_catalog.has_schema_privilege('anon','sahaj_checkpoints','USAGE')
 and not pg_catalog.has_schema_privilege('authenticated','sahaj_checkpoints','USAGE')
 and (select coalesce(array_agg(v order by v)=array[0,1,2,3,4,5],false) from sahaj_checkpoints.checkpoint_migrations)
)
);
end;
$$;
revoke all on function public.foundation_readiness() from public,anon,authenticated;
grant execute on function public.foundation_readiness() to service_role;
