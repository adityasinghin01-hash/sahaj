-- Existing unsigned starter events cannot be silently relabelled as a verified chain.
do $$begin
  if exists(select 1 from public.timeline_events) then
    raise exception 'timeline_backfill_requires_explicit_review';
  end if;
end$$;
alter table public.timeline_events add column sequence bigint not null check(sequence between 1 and 9007199254740991);
alter table public.timeline_events add column dedupe_key text not null;
alter table public.timeline_events add column envelope_canonical text not null;
alter table public.timeline_events add column payload_canonical text not null;
alter table public.timeline_events add column occurred_at_iso text not null;
alter table public.timeline_events add unique(family_id,sequence);
alter table public.timeline_events add unique(family_id,dedupe_key);
alter table public.timeline_events add constraint timeline_payload_hash_format check(payload_hash ~ '^[0-9a-f]{64}$');
alter table public.timeline_events add constraint timeline_chain_hash_format check(chain_hash ~ '^[0-9a-f]{64}$');
alter table public.timeline_events add constraint timeline_prev_hash_format check(prev_chain_hash is null or prev_chain_hash ~ '^[0-9a-f]{64}$');

create table public.timeline_stream_heads (
  family_id uuid primary key references public.families(id),
  last_sequence bigint not null default 0 check(last_sequence between 0 and 9007199254740991),
  last_chain_hash text,
  check((last_sequence=0 and last_chain_hash is null) or
    (last_sequence>0 and last_chain_hash ~ '^[0-9a-f]{64}$'))
);
alter table public.timeline_stream_heads enable row level security;
revoke all on public.timeline_stream_heads from public,anon,authenticated;
grant select on public.timeline_stream_heads to service_role;

-- PostgreSQL's JSON string encoder and numeric integers match canonicalJson for this fixed scalar envelope.
-- Arbitrary payloads are already canonicalized by the trusted application and never placed in this envelope.
create function sahaj_private.timeline_envelope_canonical(p_event jsonb)
returns text language sql immutable strict set search_path='' as $$
  select '{'||string_agg(to_json(key)::text||':'||value::text,',' order by key collate "C")||'}'
  from jsonb_each(p_event)
$$;
revoke all on function sahaj_private.timeline_envelope_canonical(jsonb) from public,anon,authenticated;
grant execute on function sahaj_private.timeline_envelope_canonical(jsonb) to service_role;

-- SECURITY DEFINER is intentionally private. Only a service-role wrapper can reach it.
-- Dedicated ownership of writes prevents service code from bypassing the head CAS with direct inserts.
create function sahaj_private.append_timeline_event(p_event jsonb,p_payload_canonical text,p_chain_hash text,p_signature text)
returns public.timeline_events language plpgsql security definer set search_path='' as $$
declare
  canonical text;payload_hash text;computed_hash text;family uuid;event_id uuid;seq bigint;
  prior text;head public.timeline_stream_heads;result public.timeline_events;
  expected_keys text[]:=array['dedupeKey','entityId','eventId','eventType','familyId','humanLine','keyId','occurredAt','payloadHash','previousHash','sequence','version'];
begin
  if p_event is null or jsonb_typeof(p_event)<>'object' or p_payload_canonical is null
    or p_chain_hash is null or p_signature is null then
    raise exception 'invalid_timeline_envelope' using errcode='22023';
  end if;
  if (select array_agg(key order by key collate "C") from jsonb_each(p_event)) is distinct from expected_keys
    or exists(select 1 from jsonb_each(p_event) where jsonb_typeof(value) not in ('string','number','null'))
    or p_event->>'version'<>'1' or jsonb_typeof(p_event->'version')<>'number'
    or jsonb_typeof(p_event->'sequence')<>'number' or (p_event->>'sequence') !~ '^[1-9][0-9]{0,15}$'
    or jsonb_typeof(p_event->'entityId') not in ('string','null')
    or jsonb_typeof(p_event->'previousHash') not in ('string','null') then
    raise exception 'invalid_timeline_envelope' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_each(p_event) where key not in ('version','sequence','entityId','previousHash') and jsonb_typeof(value)<>'string') then
    raise exception 'invalid_timeline_field_type' using errcode='22023';
  end if;
  seq:=(p_event->>'sequence')::bigint;
  prior:=p_event->>'previousHash';
  if seq>9007199254740991
    or (seq=1)<>(prior is null)
    or (prior is not null and prior !~ '^[0-9a-f]{64}$')
    or (p_event->>'familyId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or (p_event->>'eventId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or ((p_event->>'entityId') is not null and (p_event->>'entityId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (p_event->>'eventType') !~ '^[a-zA-Z0-9_.:-]{1,120}$'
    or (p_event->>'keyId') !~ '^[a-zA-Z0-9_.:-]{1,120}$'
    or length(p_event->>'dedupeKey') not between 1 and 256
    or length(p_event->>'humanLine')>2000
    or (p_event->>'occurredAt') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
    or p_signature !~ '^[A-Za-z0-9+/]{86}==$' then
    raise exception 'invalid_timeline_envelope' using errcode='22023';
  end if;
  -- Parsing rejects invalid JSON but preserves the original canonical bytes used for hashing.
  perform p_payload_canonical::jsonb;
  payload_hash:=encode(sha256(convert_to(E'SAHAJ.timeline.payload.v1\n'||p_payload_canonical,'UTF8')),'hex');
  if payload_hash is distinct from p_event->>'payloadHash' then
    raise exception 'timeline_payload_hash_mismatch' using errcode='22023';
  end if;
  canonical:=sahaj_private.timeline_envelope_canonical(p_event);
  computed_hash:=encode(sha256(convert_to(E'SAHAJ.timeline.chain.v1\n'||canonical,'UTF8')),'hex');
  if computed_hash<>p_chain_hash then raise exception 'timeline_chain_hash_mismatch' using errcode='22023';end if;
  family:=(p_event->>'familyId')::uuid;
  event_id:=(p_event->>'eventId')::uuid;
  insert into public.timeline_stream_heads(family_id) values(family) on conflict(family_id) do nothing;
  select * into strict head from public.timeline_stream_heads where family_id=family for update;
  select * into result from public.timeline_events where family_id=family and dedupe_key=p_event->>'dedupeKey';
  if result.id is not null then
    if result.envelope_canonical<>canonical or result.payload_canonical<>p_payload_canonical
      or result.chain_hash<>p_chain_hash or result.signature<>p_signature then
      raise exception 'timeline_dedupe_conflict' using errcode='23505';
    end if;
    return result;
  end if;
  if head.last_sequence+1<>seq or head.last_chain_hash is distinct from prior then
    raise exception 'timeline_head_conflict' using errcode='40001';
  end if;
  insert into public.timeline_events(id,family_id,event_type,entity_id,human_line,payload_hash,prev_chain_hash,
    chain_hash,signature,signing_key_id,created_at,sequence,dedupe_key,envelope_canonical,payload_canonical,occurred_at_iso)
    values(event_id,family,p_event->>'eventType',(p_event->>'entityId')::uuid,p_event->>'humanLine',payload_hash,prior,
      p_chain_hash,p_signature,p_event->>'keyId',(p_event->>'occurredAt')::timestamptz,seq,p_event->>'dedupeKey',canonical,p_payload_canonical,p_event->>'occurredAt')
    returning * into result;
  update public.timeline_stream_heads set last_sequence=seq,last_chain_hash=p_chain_hash where family_id=family;
  return result;
end$$;
revoke all on function sahaj_private.append_timeline_event(jsonb,text,text,text) from public,anon,authenticated;
grant execute on function sahaj_private.append_timeline_event(jsonb,text,text,text) to service_role;
create function public.append_timeline_event(p_event jsonb,p_payload_canonical text,p_chain_hash text,p_signature text)
returns public.timeline_events language sql security invoker set search_path='' as $$
  select sahaj_private.append_timeline_event(p_event,p_payload_canonical,p_chain_hash,p_signature)
$$;
revoke all on function public.append_timeline_event(jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.append_timeline_event(jsonb,text,text,text) to service_role;
revoke all on public.timeline_events from service_role;
grant select on public.timeline_events to service_role;
-- Role remains unable to change the stream head directly; only the private append routine owns it.
revoke all on public.timeline_stream_heads from service_role;
grant select on public.timeline_stream_heads to service_role;
