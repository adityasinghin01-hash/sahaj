-- Schema fingerprint of public and sahaj_private (functions, triggers, indexes, columns, table grants, function EXECUTE grants).
-- Used by sql-concurrency.ps1 to prove the temporary contact-fence install is fully reverted.
select md5(string_agg(x,'|' order by x)) from (
 select 'f:'||p.oid::regprocedure::text||':'||md5(pg_get_functiondef(p.oid)) x from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','sahaj_private') and p.prokind='f'
 union all select 't:'||c.relname||'.'||t.tgname||':'||t.tgenabled::text from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal
 union all select 'i:'||indexdef from pg_indexes where schemaname in ('public','sahaj_private')
 union all select 'c:'||table_name||'.'||column_name||':'||data_type from information_schema.columns where table_schema in ('public','sahaj_private')
 union all select 'g:'||grantee||':'||table_name||':'||privilege_type from information_schema.role_table_grants where table_schema in ('public','sahaj_private')
 union all select 'x:'||r.rolname||':'||p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace, pg_roles r where n.nspname in ('public','sahaj_private') and r.rolname in ('service_role','authenticated','anon') and has_function_privilege(r.oid,p.oid,'EXECUTE')
) s;
