-- Pinned to @langchain/langgraph-checkpoint-postgres 1.1.3 migrations 0..5.
-- Provision through the administrative migration connection, never grant database
-- CREATE to the runtime. Existing login credentials are deliberately preserved.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='sahaj_atlas_runtime') then
    create role sahaj_atlas_runtime nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;
grant sahaj_atlas_runtime to postgres;
create schema if not exists sahaj_checkpoints authorization sahaj_atlas_runtime;
set local role sahaj_atlas_runtime;
create table sahaj_checkpoints.checkpoint_migrations(v integer primary key);
create table sahaj_checkpoints.checkpoints(
 thread_id text not null, checkpoint_ns text not null default '', checkpoint_id text not null,
 parent_checkpoint_id text, type text, checkpoint jsonb not null, metadata jsonb not null default '{}',
 primary key(thread_id,checkpoint_ns,checkpoint_id));
create table sahaj_checkpoints.checkpoint_blobs(
 thread_id text not null,checkpoint_ns text not null default '',channel text not null,version text not null,
 type text not null,blob bytea,primary key(thread_id,checkpoint_ns,channel,version));
create table sahaj_checkpoints.checkpoint_writes(
 thread_id text not null,checkpoint_ns text not null default '',checkpoint_id text not null,
 task_id text not null,idx integer not null,channel text not null,type text,blob bytea not null,
 task_path text not null default '',primary key(thread_id,checkpoint_ns,checkpoint_id,task_id,idx));
insert into sahaj_checkpoints.checkpoint_migrations(v) select generate_series(0,5);
revoke all on schema sahaj_checkpoints from public,anon,authenticated;
revoke all on all tables in schema sahaj_checkpoints from public,anon,authenticated;
alter default privileges in schema sahaj_checkpoints revoke all on tables from public,anon,authenticated;
alter table sahaj_checkpoints.checkpoint_migrations enable row level security;
alter table sahaj_checkpoints.checkpoints enable row level security;
alter table sahaj_checkpoints.checkpoint_blobs enable row level security;
alter table sahaj_checkpoints.checkpoint_writes enable row level security;
reset role;
revoke sahaj_atlas_runtime from postgres;

-- Narrow metadata bridges; private schema remains absent from PostgREST.
create function public.get_voice_media_metadata(p_family_id uuid,p_post_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('family_id',v.family_id,'voice_post_id',v.voice_post_id,
   'object_path',v.object_path,'expires_at',v.expires_at)
 from sahaj_private.voice_content v where v.family_id=p_family_id and v.voice_post_id=p_post_id
$$;
create function public.get_call_media_metadata(p_family_id uuid,p_call_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('family_id',c.family_id,'call_id',c.call_id,'consent_id',c.consent_id,
   'recording_object_path',c.recording_object_path,'expires_at',c.expires_at)
 from sahaj_private.call_content c where c.family_id=p_family_id and c.call_id=p_call_id
$$;
revoke all on function public.get_voice_media_metadata(uuid,uuid),public.get_call_media_metadata(uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.get_voice_media_metadata(uuid,uuid),public.get_call_media_metadata(uuid,uuid)
 to service_role;
