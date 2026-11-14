-- Phase 3 capability-filtered outbox claim. Applies after 20261114213000_phase3_bridge.sql (and Phase 2's dispatch_bindings).
-- Adds one function; changes no existing object.
--
-- claim_outbox (foundation) claims EVERY ready row regardless of provider, so a tick with only some providers configured
-- would claim and then fail rows it can never send, burning attempts. This variant claims only rows whose immutable
-- dispatch binding matches an allowed (provider action, care action) capability supplied by the trusted runtime.
-- Rows outside the capability set are not touched: status, attempt_count, retry_at and lease stay exactly as they were.
-- The lease-expiry sweep (processing -> delivery_unknown) stays global because it never resends and consumes no attempt;
-- the attempt-limit dead-lettering is restricted to eligible rows.
create function public.claim_outbox_for_capabilities(p_worker_id text,p_capabilities text[],p_limit integer default 10,
  p_lease_seconds integer default 60)
returns setof public.outbox language plpgsql security invoker set search_path='' as $$
begin
  if p_worker_id is null or length(p_worker_id) not between 1 and 120 or p_capabilities is null
    or coalesce(array_length(p_capabilities,1),0) not between 1 and 20
    or exists(select 1 from unnest(p_capabilities) c where c is null or c !~ '^[a-z0-9_]+\.[a-z0-9_]+:[a-z0-9_]{1,80}$')
    or p_limit is null or p_lease_seconds is null or p_limit not between 1 and 100 or p_lease_seconds not between 10 and 900 then
    raise exception 'invalid_claim_options' using errcode='22023';
  end if;
  update public.outbox set status='delivery_unknown',lease_token=null,lease_until=null,worker_id=null,last_error_code='lease_expired'
    where status='processing' and lease_until<now();
  update public.outbox o set status='dead',last_error_code='attempt_limit'
    where o.attempt_count>=o.max_attempts and o.status in ('pending','failed')
      and exists(select 1 from public.dispatch_bindings b where b.outbox_id=o.id and b.family_id=o.family_id
        and (b.action||':'||o.action)=any(p_capabilities));
  return query with ready as (
    select o.id from public.outbox o
    join public.dispatch_bindings b on b.outbox_id=o.id and b.family_id=o.family_id
    where o.attempt_count<o.max_attempts and o.status in ('pending','failed') and o.retry_at<=now()
      and (b.action||':'||o.action)=any(p_capabilities)
    order by o.retry_at,o.created_at for update of o skip locked limit p_limit
  ) update public.outbox o set status='processing',attempt_count=o.attempt_count+1,
    worker_id=p_worker_id,lease_token=gen_random_uuid(),lease_until=now()+make_interval(secs=>p_lease_seconds)
    from ready where o.id=ready.id returning o.*;
end$$;
revoke all on function public.claim_outbox_for_capabilities(text,text[],integer,integer) from public,anon,authenticated;
grant execute on function public.claim_outbox_for_capabilities(text,text[],integer,integer) to service_role;
