-- Administrative verification only; all statements roll back.
begin;
do $$ begin
 if has_function_privilege('anon','public.get_voice_media_metadata(uuid,uuid)','EXECUTE')
   or has_function_privilege('authenticated','public.get_call_media_metadata(uuid,uuid)','EXECUTE') then
   raise exception 'media_rpc_exposed';
 end if;
 if not has_function_privilege('service_role','public.get_voice_media_metadata(uuid,uuid)','EXECUTE') then
   raise exception 'service_rpc_missing';
 end if;
 if has_database_privilege('sahaj_atlas_runtime','postgres','CREATE') then
   raise exception 'runtime_create_privilege';
 end if;
 if (select count(*) from pg_tables where schemaname='sahaj_checkpoints')<>4
   or exists(select 1 from pg_tables where schemaname='sahaj_checkpoints' and not rowsecurity) then
   raise exception 'checkpoint_tables_or_rls_missing';
 end if;
 if has_schema_privilege('anon','sahaj_checkpoints','USAGE')
   or has_schema_privilege('authenticated','sahaj_checkpoints','USAGE') then
   raise exception 'checkpoint_schema_exposed';
 end if;
 if public.get_voice_media_metadata('00000000-0000-4000-8000-000000000000',
   '00000000-0000-4000-8000-000000000000') is not null then
   raise exception 'absent_rpc_result';
 end if;
end $$;
rollback;
