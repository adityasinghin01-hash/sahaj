-- ============================================================================
-- Project SAHAJ — Phase 1 Independent QA Acceptance Suite
-- File: infra/supabase/tests/phase1_independent_qa.sql
--
-- Independent adversarial acceptance verification suite for Phase 1 Foundation:
-- 1. Non-vacuous application table existence and Row-Level Security (RLS) enablement
-- 2. Schema USAGE and isolation boundaries (anon, authenticated, PUBLIC grantee=0)
-- 3. Private content table privilege isolation (call_content, voice_content, private_items)
-- 4. Storage bucket verification: exactly 3 private care buckets
-- 5. LangGraph Checkpoint runtime least privilege (sahaj_atlas_runtime)
-- 6. Service-only RPC existence, catalog execution grants, and runtime invocation denial
-- 7. Multi-tenant cross-family boundary, intra-tenant role fencing, and revocation
--
-- Rollback-only: Runs inside a transaction and ends with rollback.
-- Zero persistent changes to database or storage.
-- ============================================================================

begin;

-- ============================================================================
-- Section 1: Non-Vacuous Application Table Existence & RLS Enablement
-- ============================================================================
do $$
declare
  expected_tables text[] := array[
    -- Public foundation, security & workflow tables (25)
    'public.families',
    'public.people',
    'public.family_memberships',
    'public.circle',
    'public.calls',
    'public.consents',
    'public.schedules',
    'public.requests',
    'public.incidents',
    'public.assignments',
    'public.voice_posts',
    'public.medicines',
    'public.vendors',
    'public.permissions',
    'public.action_requests',
    'public.action_answers',
    'public.errands',
    'public.nudges',
    'public.child_alerts',
    'public.provider_identities',
    'public.raw_events',
    'public.idempotency_keys',
    'public.timeline_events',
    'public.timeline_stream_heads',
    'public.workflow_jobs',
    'public.outbox',

    -- Private schema content tables (3)
    'sahaj_private.call_content',
    'sahaj_private.voice_content',
    'sahaj_private.private_items',

    -- LangGraph checkpoint tables (4)
    'sahaj_checkpoints.checkpoint_migrations',
    'sahaj_checkpoints.checkpoints',
    'sahaj_checkpoints.checkpoint_blobs',
    'sahaj_checkpoints.checkpoint_writes'
  ];
  missing_tables text[];
  missing_rls text[];
begin
  -- Assert that every expected table actually exists in pg_class; absent objects must fail immediately
  select array_agg(req_tbl) into missing_tables
  from unnest(expected_tables) as req_tbl
  where not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = split_part(req_tbl, '.', 1)
      and c.relname = split_part(req_tbl, '.', 2)
      and c.relkind = 'r'
  );

  if missing_tables is not null and array_length(missing_tables, 1) > 0 then
    raise exception 'FAIL [QA] Required application/security tables missing: %', array_to_string(missing_tables, ', ');
  end if;

  -- Assert that RLS (relrowsecurity) is enabled on every single table
  select array_agg(n.nspname || '.' || c.relname) into missing_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where (n.nspname || '.' || c.relname) = any(expected_tables)
    and not c.relrowsecurity;

  if missing_rls is not null and array_length(missing_rls, 1) > 0 then
    raise exception 'FAIL [QA] Row-Level Security (RLS) disabled on required tables: %', array_to_string(missing_rls, ', ');
  end if;
end $$;

-- ============================================================================
-- Section 2: Schema USAGE, Isolation & Private Content Table Privilege Fencing
-- ============================================================================
do $$
declare
  r text;
  t text;
  priv text;
begin
  -- 2A. sahaj_private schema privilege boundaries:
  -- anon must have NO USAGE
  if has_schema_privilege('anon', 'sahaj_private', 'USAGE') then
    raise exception 'FAIL [QA] sahaj_private schema USAGE granted to anon';
  end if;

  -- authenticated intentionally preserves USAGE on sahaj_private for has_role/is_person RLS helper functions
  if not has_schema_privilege('authenticated', 'sahaj_private', 'USAGE') then
    raise exception 'FAIL [QA] sahaj_private schema USAGE missing for authenticated (required for RLS helpers)';
  end if;

  -- PUBLIC (ACL pseudo-role, grantee=0) must have NO USAGE or CREATE on sahaj_private
  if exists (
    select 1
    from pg_namespace n,
         aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
    where n.nspname = 'sahaj_private'
      and a.grantee = 0
      and a.privilege_type in ('USAGE', 'CREATE')
  ) then
    raise exception 'FAIL [QA] sahaj_private schema USAGE or CREATE granted to PUBLIC (grantee=0)';
  end if;

  -- 2B. Direct table privileges on sahaj_private content tables:
  -- Untrusted browser roles (anon, authenticated) must have ZERO direct table privileges
  for r in select unnest(array['anon', 'authenticated']) loop
    for t in select unnest(array['call_content', 'voice_content', 'private_items']) loop
      for priv in select unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) loop
        if has_table_privilege(r, 'sahaj_private.' || t, priv) then
          raise exception 'FAIL [QA] browser role % has % privilege on sahaj_private.%', r, priv, t;
        end if;
      end loop;
    end loop;
  end loop;

  -- 2C. RLS helper functions:
  -- Signatures must exist
  if to_regprocedure('sahaj_private.has_role(uuid,text[])') is null then
    raise exception 'FAIL [QA] RLS helper procedure sahaj_private.has_role(uuid,text[]) missing';
  end if;
  if to_regprocedure('sahaj_private.is_person(uuid,uuid)') is null then
    raise exception 'FAIL [QA] RLS helper procedure sahaj_private.is_person(uuid,uuid) missing';
  end if;

  -- authenticated must have EXECUTE on RLS helpers
  if not has_function_privilege('authenticated', 'sahaj_private.has_role(uuid,text[])', 'EXECUTE') then
    raise exception 'FAIL [QA] authenticated lacks EXECUTE on sahaj_private.has_role(uuid,text[])';
  end if;
  if not has_function_privilege('authenticated', 'sahaj_private.is_person(uuid,uuid)', 'EXECUTE') then
    raise exception 'FAIL [QA] authenticated lacks EXECUTE on sahaj_private.is_person(uuid,uuid)';
  end if;

  -- anon must NOT have EXECUTE on RLS helpers
  if has_function_privilege('anon', 'sahaj_private.has_role(uuid,text[])', 'EXECUTE') then
    raise exception 'FAIL [QA] anon granted EXECUTE on sahaj_private.has_role(uuid,text[])';
  end if;
  if has_function_privilege('anon', 'sahaj_private.is_person(uuid,uuid)', 'EXECUTE') then
    raise exception 'FAIL [QA] anon granted EXECUTE on sahaj_private.is_person(uuid,uuid)';
  end if;

  -- PUBLIC (grantee=0) must NOT have EXECUTE on RLS helpers
  if exists (
    select 1
    from pg_proc p,
         aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
    where p.oid in ('sahaj_private.has_role(uuid,text[])'::regprocedure, 'sahaj_private.is_person(uuid,uuid)'::regprocedure)
      and a.grantee = 0
      and a.privilege_type = 'EXECUTE'
  ) then
    raise exception 'FAIL [QA] PUBLIC granted EXECUTE on sahaj_private RLS helper procedures';
  end if;
end $$;

-- ============================================================================
-- Section 3: Checkpoint Schema & Runtime Least Privilege Assertions
-- ============================================================================
do $$
begin
  -- 3A. sahaj_checkpoints schema privileges:
  -- Untrusted browser roles must have NO USAGE
  if has_schema_privilege('anon', 'sahaj_checkpoints', 'USAGE')
     or has_schema_privilege('authenticated', 'sahaj_checkpoints', 'USAGE') then
    raise exception 'FAIL [QA] sahaj_checkpoints schema USAGE granted to browser roles';
  end if;

  -- PUBLIC (grantee=0) must have NO USAGE or CREATE
  if exists (
    select 1
    from pg_namespace n,
         aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
    where n.nspname = 'sahaj_checkpoints'
      and a.grantee = 0
      and a.privilege_type in ('USAGE', 'CREATE')
  ) then
    raise exception 'FAIL [QA] sahaj_checkpoints schema USAGE or CREATE granted to PUBLIC (grantee=0)';
  end if;

  -- 3B. Checkpoint runtime role least privilege (sahaj_atlas_runtime):
  -- Must NOT have database-wide CREATE
  if has_database_privilege('sahaj_atlas_runtime', current_database(), 'CREATE') then
    raise exception 'FAIL [QA] sahaj_atlas_runtime has database CREATE privilege';
  end if;

  -- Must have USAGE on sahaj_checkpoints
  if not has_schema_privilege('sahaj_atlas_runtime', 'sahaj_checkpoints', 'USAGE') then
    raise exception 'FAIL [QA] sahaj_atlas_runtime lacks USAGE on sahaj_checkpoints';
  end if;

  -- Must NOT have USAGE on sahaj_private
  if has_schema_privilege('sahaj_atlas_runtime', 'sahaj_private', 'USAGE') then
    raise exception 'FAIL [QA] sahaj_atlas_runtime has USAGE on sahaj_private';
  end if;

  -- Must NOT have table SELECT privileges on application tables
  if has_table_privilege('sahaj_atlas_runtime', 'public.families', 'SELECT')
     or has_table_privilege('sahaj_atlas_runtime', 'public.people', 'SELECT')
     or has_table_privilege('sahaj_atlas_runtime', 'public.incidents', 'SELECT')
     or has_table_privilege('sahaj_atlas_runtime', 'sahaj_private.call_content', 'SELECT')
     or has_table_privilege('sahaj_atlas_runtime', 'sahaj_private.voice_content', 'SELECT')
     or has_table_privilege('sahaj_atlas_runtime', 'sahaj_private.private_items', 'SELECT') then
    raise exception 'FAIL [QA] sahaj_atlas_runtime has excessive table privileges on care data';
  end if;

  -- Checkpoint schema must contain exactly 4 tables
  if (select count(*) from pg_tables where schemaname = 'sahaj_checkpoints') <> 4 then
    raise exception 'FAIL [QA] sahaj_checkpoints table count mismatch (expected exactly 4)';
  end if;
end $$;

-- ============================================================================
-- Section 4: Media Storage Bucket Verification (Exactly 3 Private Care Buckets)
-- ============================================================================
do $$
declare
  expected_buckets text[] := array['sahaj-voice', 'sahaj-recordings', 'sahaj-lines'];
  missing_buckets text[];
  bucket_count integer;
  public_buckets text[];
begin
  -- Assert that all 3 care buckets actually exist
  select array_agg(b) into missing_buckets
  from unnest(expected_buckets) as b
  where not exists (
    select 1 from storage.buckets where id = b
  );

  if missing_buckets is not null and array_length(missing_buckets, 1) > 0 then
    raise exception 'FAIL [QA] Required care storage buckets missing: %', array_to_string(missing_buckets, ', ');
  end if;

  -- Assert that the count of care buckets is exactly 3
  select count(*) into bucket_count
  from storage.buckets
  where id = any(expected_buckets);

  if bucket_count <> 3 then
    raise exception 'FAIL [QA] Care storage bucket count mismatch: found %, expected 3', bucket_count;
  end if;

  -- Assert that all care buckets are private (public = false)
  select array_agg(id) into public_buckets
  from storage.buckets
  where id = any(expected_buckets) and public;

  if public_buckets is not null and array_length(public_buckets, 1) > 0 then
    raise exception 'FAIL [QA] Care storage bucket(s) erroneously marked public: %', array_to_string(public_buckets, ', ');
  end if;
end $$;

-- ============================================================================
-- Section 5: Service-Only RPC Signatures & Execution Access Fencing
-- ============================================================================
do $$
declare
  expected_rpc_signatures text[] := array[
    'public.get_voice_media_metadata(uuid,uuid)',
    'public.get_call_media_metadata(uuid,uuid)',
    'public.ingest_raw_event(text,text,text,uuid,jsonb,text,text)',
    'public.claim_raw_events(text,integer,integer)',
    'public.finish_raw_event(uuid,uuid,boolean,text)',
    'public.dispatch_raw_event(uuid,uuid,text,text)',
    'public.claim_outbox(text,integer,integer)',
    'public.finish_outbox(uuid,uuid,boolean,text)',
    'public.reconcile_outbox(uuid,uuid,text)',
    'public.claim_workflow_jobs(text,integer,integer)',
    'public.finish_workflow_job(uuid,uuid,text,text,text,text)',
    'public.resume_workflow_job(uuid,uuid,text,text)',
    'public.append_timeline_event(jsonb,text,text,text)',
    'public.foundation_readiness()'
  ];
  missing_signatures text[];
  sig text;
  fn_oid regprocedure;
  p record;
  forbidden_exec text[];
begin
  -- Assert that all required service-only RPC signatures exist
  select array_agg(req_sig) into missing_signatures
  from unnest(expected_rpc_signatures) as req_sig
  where to_regprocedure(req_sig) is null;

  if missing_signatures is not null and array_length(missing_signatures, 1) > 0 then
    raise exception 'FAIL [QA] Service-only RPC signatures missing: %', array_to_string(missing_signatures, ', ');
  end if;

  -- Assert execution privileges across anon, authenticated, PUBLIC (grantee=0), and service_role
  foreach sig in array expected_rpc_signatures loop
    fn_oid := to_regprocedure(sig);

    if has_function_privilege('anon', sig, 'EXECUTE') then
      forbidden_exec := array_append(forbidden_exec, 'anon can execute ' || sig);
    end if;

    if has_function_privilege('authenticated', sig, 'EXECUTE') then
      forbidden_exec := array_append(forbidden_exec, 'authenticated can execute ' || sig);
    end if;

    -- Inspect PUBLIC (ACL pseudo-role, grantee=0) through aclexplode
    select proacl, proowner into p from pg_proc where oid = fn_oid::oid;
    if exists (
      select 1
      from aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ) then
      forbidden_exec := array_append(forbidden_exec, 'PUBLIC can execute ' || sig);
    end if;

    if not has_function_privilege('service_role', sig, 'EXECUTE') then
      raise exception 'FAIL [QA] service_role lacks EXECUTE privilege on %', sig;
    end if;
  end loop;

  if forbidden_exec is not null and array_length(forbidden_exec, 1) > 0 then
    raise exception 'FAIL [QA] Service-only RPCs exposed to untrusted roles: %', array_to_string(forbidden_exec, '; ');
  end if;
end $$;

-- ============================================================================
-- Section 6: Dynamic Runtime Invocation Denial for Browser Roles
-- ============================================================================

-- 6A. Dynamic Denial for Anonymous Role
set local role anon;
do $$
begin
  -- Service-only RPC execution denial
  begin
    perform public.foundation_readiness();
    raise exception 'FAIL [QA] anon executed public.foundation_readiness()';
  exception when insufficient_privilege then null; end;

  begin
    perform public.get_voice_media_metadata('00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid);
    raise exception 'FAIL [QA] anon executed public.get_voice_media_metadata()';
  exception when insufficient_privilege then null; end;

  begin
    perform public.get_call_media_metadata('00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid);
    raise exception 'FAIL [QA] anon executed public.get_call_media_metadata()';
  exception when insufficient_privilege then null; end;

  -- Application table direct read denial
  begin
    perform * from public.families;
    raise exception 'FAIL [QA] anon selected from public.families';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.people;
    raise exception 'FAIL [QA] anon selected from public.people';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.calls;
    raise exception 'FAIL [QA] anon selected from public.calls';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.incidents;
    raise exception 'FAIL [QA] anon selected from public.incidents';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.raw_events;
    raise exception 'FAIL [QA] anon selected from public.raw_events';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.outbox;
    raise exception 'FAIL [QA] anon selected from public.outbox';
  exception when insufficient_privilege then null; end;

  begin
    perform * from sahaj_private.call_content;
    raise exception 'FAIL [QA] anon selected from sahaj_private.call_content';
  exception when insufficient_privilege then null; end;

  begin
    perform * from sahaj_private.voice_content;
    raise exception 'FAIL [QA] anon selected from sahaj_private.voice_content';
  exception when insufficient_privilege then null; end;

  begin
    perform * from sahaj_private.private_items;
    raise exception 'FAIL [QA] anon selected from sahaj_private.private_items';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 6B. Dynamic Denial for Authenticated Role
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000099', true);
do $$
begin
  -- Service-only RPC execution denial
  begin
    perform public.foundation_readiness();
    raise exception 'FAIL [QA] authenticated executed public.foundation_readiness()';
  exception when insufficient_privilege then null; end;

  begin
    perform public.get_voice_media_metadata('00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid);
    raise exception 'FAIL [QA] authenticated executed public.get_voice_media_metadata()';
  exception when insufficient_privilege then null; end;

  begin
    perform public.get_call_media_metadata('00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid);
    raise exception 'FAIL [QA] authenticated executed public.get_call_media_metadata()';
  exception when insufficient_privilege then null; end;

  -- Private content table access denial
  begin
    perform * from sahaj_private.call_content;
    raise exception 'FAIL [QA] authenticated selected from sahaj_private.call_content';
  exception when insufficient_privilege then null; end;

  begin
    perform * from sahaj_private.voice_content;
    raise exception 'FAIL [QA] authenticated selected from sahaj_private.voice_content';
  exception when insufficient_privilege then null; end;

  begin
    perform * from sahaj_private.private_items;
    raise exception 'FAIL [QA] authenticated selected from sahaj_private.private_items';
  exception when insufficient_privilege then null; end;

  -- Internal workflow queues / stream heads access denial
  begin
    perform * from public.raw_events;
    raise exception 'FAIL [QA] authenticated selected from public.raw_events';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.outbox;
    raise exception 'FAIL [QA] authenticated selected from public.outbox';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.workflow_jobs;
    raise exception 'FAIL [QA] authenticated selected from public.workflow_jobs';
  exception when insufficient_privilege then null; end;

  begin
    perform * from public.timeline_stream_heads;
    raise exception 'FAIL [QA] authenticated selected from public.timeline_stream_heads';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ============================================================================
-- Section 7: Multi-Tenant Boundary Isolation & Immediate Revocation Cutoff
-- ============================================================================

-- Synthetic Auth Users
insert into auth.users (id) values
  ('a2000000-0000-4000-8000-000000000001'), -- Child in Family A
  ('a2000000-0000-4000-8000-000000000002'), -- Parent in Family A
  ('a2000000-0000-4000-8000-000000000003'), -- Circle in Family A
  ('a2000000-0000-4000-8000-000000000004'); -- Child in Family B

-- Synthetic Families
insert into public.families (id, name, language, demo) values
  ('b2000000-0000-4000-8000-000000000001', 'QA Synthetic Family A', 'hi', true),
  ('b2000000-0000-4000-8000-000000000002', 'QA Synthetic Family B', 'hi', true);

-- Synthetic People
insert into public.people (id, family_id, display_name, role) values
  ('c2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'QA Child A', 'child'),
  ('c2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'QA Parent A', 'parent'),
  ('c2000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000001', 'QA Circle A', 'circle'),
  ('c2000000-0000-4000-8000-000000000004', 'b2000000-0000-4000-8000-000000000002', 'QA Child B', 'child');

-- Synthetic Family Memberships
insert into public.family_memberships (family_id, user_id, person_id, role) values
  ('b2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'child'),
  ('b2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'parent'),
  ('b2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000003', 'circle'),
  ('b2000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000004', 'child');

-- Synthetic Operational Records
insert into public.calls (id, family_id, person_id, provider) values
  ('d2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002', 'synthetic'),
  ('d2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000004', 'synthetic');

insert into public.incidents (id, family_id, person_id, severity) values
  ('e2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002', 'routine'),
  ('e2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000004', 'routine');

insert into public.assignments (family_id, incident_id, person_id, expires_at) values
  ('b2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000003', now() + interval '2 hours');

insert into public.consents (id, family_id, person_id, purpose, question, answer, version) values
  ('f2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002', 'qa_consent', 'QA acceptance consent?', true, 'phase1-qa-v1');

insert into public.voice_posts (family_id, sender_id, recipient_id, consent_id) values
  ('b2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000001');

-- 7A. Tenant Fencing: Child A (Family A) cannot see Family B
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a2000000-0000-4000-8000-000000000001', true);
do $$
begin
  if (select count(*) from public.families where id in ('b2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002')) <> 1 then
    raise exception 'FAIL [QA] Child A saw wrong family count';
  end if;

  if exists (select 1 from public.families where id = 'b2000000-0000-4000-8000-000000000002') then
    raise exception 'FAIL [QA] Child A crossed tenant boundary to view Family B';
  end if;

  if exists (select 1 from public.incidents where id = 'e2000000-0000-4000-8000-000000000002') then
    raise exception 'FAIL [QA] Child A saw Family B incidents';
  end if;

  -- Client mutation denial: cannot change membership role
  begin
    update public.family_memberships set role = 'parent';
    raise exception 'FAIL [QA] Client updated membership table';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 7B. Intra-Tenant Role Fencing: Parent A sees only own calls, not triage incidents
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a2000000-0000-4000-8000-000000000002', true);
do $$
begin
  if (select count(*) from public.calls where id in ('d2000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000002')) <> 1 then
    raise exception 'FAIL [QA] Parent A saw invalid call count';
  end if;

  if exists (select 1 from public.calls where id = 'd2000000-0000-4000-8000-000000000002') then
    raise exception 'FAIL [QA] Parent A saw Family B call';
  end if;

  -- Parent role does not have triage permission on incidents
  if exists (select 1 from public.incidents) then
    raise exception 'FAIL [QA] Parent saw triage incidents';
  end if;

  -- Parent can read their own voice post metadata
  if not exists (select 1 from public.voice_posts where family_id = 'b2000000-0000-4000-8000-000000000001') then
    raise exception 'FAIL [QA] Parent own voice post missing';
  end if;
end $$;
reset role;

-- 7C. Circle Member Least Privilege: Circle A sees only assigned tasks
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a2000000-0000-4000-8000-000000000003', true);
do $$
begin
  if (select count(*) from public.assignments where family_id = 'b2000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'FAIL [QA] Circle A missing assigned task';
  end if;

  if exists (select 1 from public.calls) then
    raise exception 'FAIL [QA] Circle A saw unpermitted calls';
  end if;

  if exists (select 1 from public.incidents) then
    raise exception 'FAIL [QA] Circle A saw unassigned incidents';
  end if;

  if exists (select 1 from public.voice_posts) then
    raise exception 'FAIL [QA] Circle A saw voice posts';
  end if;
end $$;
reset role;

-- 7D. Immediate Revocation Cutoff: Revoking membership immediately removes all access
update public.family_memberships set revoked_at = now()
where user_id = 'a2000000-0000-4000-8000-000000000001';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a2000000-0000-4000-8000-000000000001', true);
do $$
begin
  if exists (select 1 from public.families) then
    raise exception 'FAIL [QA] Revoked member still reads families';
  end if;
  if exists (select 1 from public.family_memberships) then
    raise exception 'FAIL [QA] Revoked member still reads memberships';
  end if;
  if exists (select 1 from public.calls) then
    raise exception 'FAIL [QA] Revoked member still reads calls';
  end if;
  if exists (select 1 from public.incidents) then
    raise exception 'FAIL [QA] Revoked member still reads incidents';
  end if;
end $$;
reset role;

-- ============================================================================
-- Section 8: Clean Rollback of All Fixtures and Transactions
-- ============================================================================
rollback;
