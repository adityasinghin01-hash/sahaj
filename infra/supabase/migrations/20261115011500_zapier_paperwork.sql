-- Proposed Issue #6 seam. Review AFTER Phase 2/3/4; never applies itself to a hosted database.
-- Same durable outbox and finish_outbox/backoff; no second queue or provider dispatch implementation.
alter table public.outbox add column paperwork_hash text check(paperwork_hash ~ '^[0-9a-f]{64}$');

create function public.enqueue_zapier_outbox(p_family uuid,p_timeline uuid,p_channel text,p_hash text,p_ciphertext text,p_chain_hash text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare t public.timeline_events; o public.outbox; projection jsonb; valid_business boolean;
begin
  if p_channel is null or p_channel not in ('z1','z5') or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
    or p_ciphertext is null or length(p_ciphertext) not between 20 and 12000 or p_ciphertext not like 'v1.%'
    or p_chain_hash is null then raise exception 'invalid_paperwork' using errcode='22023'; end if;
  select * into t from public.timeline_events where family_id=p_family and id=p_timeline for share;
  if t.id is null or t.chain_hash is distinct from p_chain_hash then raise exception 'committed_timeline_required' using errcode='22023'; end if;
  -- Crypto and projection verification also run in the trusted TS producer AND again before dispatch.
  projection:=t.payload_canonical::jsonb->'zapier';
  if projection is null or jsonb_typeof(projection)<>'object' then raise exception 'source_projection_missing' using errcode='22023'; end if;
  if p_channel='z1' then
    select exists(select 1 from public.errands e join public.action_requests a on a.family_id=e.family_id and a.id=e.action_request_id
      where e.family_id=p_family and e.id=t.entity_id and a.permission_id::text=projection->>'permission_ref'
        and a.action='medicine_refill'
        and (to_jsonb(a)->>'amount_minor')::numeric=(projection->>'amount_inr')::numeric*100
        and ((t.event_type='errand.approved' and a.status in ('approved','executed') and e.status in ('authorized','dispatched','completed'))
          or (t.event_type='errand.denied' and a.status='denied')
          or (t.event_type='errand.completed' and a.status='executed' and e.status='completed'))) into valid_business;
  else
    select exists(select 1 from public.schedules s where s.family_id=p_family and s.id=t.entity_id and s.enabled
      and t.event_type='reminder.created' and s.id::text=projection->>'reminder_id'
      and s.next_at=(projection->>'start_at')::timestamptz and s.timezone=projection->>'timezone') into valid_business;
  end if;
  if not coalesce(valid_business,false) then raise exception 'authorized_business_source_required' using errcode='22023'; end if;
  insert into public.outbox(family_id,kind,dedupe_key,payload_ciphertext,paperwork_hash)
    values(p_family,'zapier.'||p_channel,'zapier:'||p_channel||':'||p_timeline::text,p_ciphertext,p_hash)
    on conflict(family_id,dedupe_key) do nothing returning * into o;
  if o.id is null then
    select * into strict o from public.outbox where family_id=p_family and dedupe_key='zapier:'||p_channel||':'||p_timeline::text;
    if o.paperwork_hash is distinct from p_hash then raise exception 'paperwork_conflict' using errcode='23505'; end if;
  end if;
  return o.id;
end $$;

create function public.claim_zapier_outbox(p_worker text,p_channels text[],p_limit integer default 2)
returns setof public.outbox language plpgsql security invoker set search_path='' as $$
begin
  if p_worker is null or length(p_worker) not between 1 and 120 or p_limit is null or p_limit not between 1 and 10
    or p_channels is null or cardinality(p_channels)=0 or not(p_channels <@ array['z1','z5']::text[])
    or array_position(p_channels,null) is not null then raise exception 'invalid_claim_options' using errcode='22023'; end if;
  -- An uncertain request may already have reached Zapier. Preserve uncertainty rather than resend.
  update public.outbox set status='delivery_unknown',lease_token=null,lease_until=null,worker_id=null,last_error_code='lease_expired'
    where kind=any(select 'zapier.'||c from unnest(p_channels) c) and status='processing' and lease_until<now();
  update public.outbox set status='dead',last_error_code='attempt_limit'
    where kind=any(select 'zapier.'||c from unnest(p_channels) c) and status in ('pending','failed') and attempt_count>=max_attempts;
  return query with ready as (
    select id from public.outbox where kind=any(select 'zapier.'||c from unnest(p_channels) c)
      and status in ('pending','failed') and retry_at<=now() and attempt_count<max_attempts
      order by retry_at,created_at for update skip locked limit p_limit
  ) update public.outbox o set status='processing',attempt_count=o.attempt_count+1,worker_id=p_worker,
    lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds'
    from ready where o.id=ready.id returning o.*;
end $$;
revoke all on function public.enqueue_zapier_outbox(uuid,uuid,text,text,text,text),public.claim_zapier_outbox(text,text[],integer) from public,anon,authenticated;
grant execute on function public.enqueue_zapier_outbox(uuid,uuid,text,text,text,text),public.claim_zapier_outbox(text,text[],integer) to service_role;
