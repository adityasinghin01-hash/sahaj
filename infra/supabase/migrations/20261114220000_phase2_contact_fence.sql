-- Phase 2 contact revocation fence. Applies after 20261114214500_phase2_contact_registry.sql.
-- Final order: Phase 3 base 201500 -> Phase 2 201600 -> Phase 3 review 210000 -> Phase 3 bridge 213000 ->
-- Phase 2 contact registry 214500 -> this file 220000.
--
-- Problem fixed: dispatch resolved a recipient's number BEFORE claiming, and nothing tied the claim to that exact registry row,
-- so revoke_contact_identity (or revoke + register a replacement) between resolve and claim still let the worker send to the
-- cached old number. Now every dispatch ledger row names the exact provider_identities contact row it was resolved from, and an
-- insert trigger re-validates that row atomically with the claim, under the same person lock revoke_contact_identity takes.
--
-- Lock order (unchanged convention): Phase 3 family advisory lock (dispatch_ledger_authorize, fires first by trigger name)
-- -> people row FOR NO KEY UPDATE (this fence; also taken first by revoke/register_contact_identity) -> provider_identities row.
-- A revocation therefore either commits before the claim (claim refused, no ledger row, no provider call) or waits for the
-- claim to commit (the send was authorized at claim time; it cannot be recalled after the provider accepted it).

alter table public.dispatch_ledger add column contact_identity_id uuid references public.provider_identities(id);
alter table public.dispatch_ledger add column contact_account_id text check(contact_account_id is null or contact_account_id ~ '^[A-Za-z0-9_.-]{1,128}$');
alter table public.dispatch_ledger add column contact_identity_hash text check(contact_identity_hash is null or contact_identity_hash ~ '^[0-9a-f]{64}$');

-- Every NEW ledger row must name a current contact identity of exactly this family, person, provider and account, with the
-- same identity hash the resolver decrypted and verified. Applies to every insert path (old 8-argument claim_dispatch included,
-- which never sets these columns and is therefore refused: no claim, so no provider call).
create function sahaj_private.dispatch_ledger_contact_fence() returns trigger
language plpgsql security definer set search_path='' as $$
declare i public.provider_identities;
begin
  if new.contact_identity_id is null or new.contact_account_id is null or new.contact_identity_hash is null then
    raise exception 'contact_identity_required' using errcode='42501';
  end if;
  perform 1 from public.people p where p.id=new.person_id and p.family_id=new.family_id for no key update;
  if not found then raise exception 'contact_identity_not_current' using errcode='42501'; end if;
  select * into i from public.provider_identities x where x.id=new.contact_identity_id for share;
  if i.id is null or i.family_id<>new.family_id or i.person_id<>new.person_id or i.source<>new.provider
    or i.binding_kind<>'contact' or not i.enabled or i.revoked_at is not null
    or i.account_id<>new.contact_account_id or i.external_id_hash<>new.contact_identity_hash then
    raise exception 'contact_identity_not_current' using errcode='42501';
  end if;
  return new;
end$$;
revoke all on function sahaj_private.dispatch_ledger_contact_fence() from public,anon,authenticated,service_role;
create trigger dispatch_ledger_contact_fence before insert on public.dispatch_ledger
  for each row execute function sahaj_private.dispatch_ledger_contact_fence();

-- The claim used by the dispatcher from now on: the 8-argument claim_dispatch plus the resolved contact identity. Same checks,
-- same return values ('claimed' | 'duplicate'), same error codes, plus 42501 contact_identity_required / contact_identity_not_current.
create function public.claim_dispatch_contact(
  p_family_id uuid,p_person_id uuid,p_key text,p_provider text,p_action text,
  p_outbox_id uuid,p_outbox_lease uuid,p_call_id uuid,
  p_contact_identity_id uuid,p_contact_account_id text,p_contact_identity_hash text
) returns text language plpgsql security definer set search_path='' as $$
declare existing public.dispatch_ledger;o public.outbox;b public.dispatch_bindings;n integer;
begin
  if p_family_id is null or p_person_id is null or p_key is null or p_provider is null or p_action is null or p_outbox_id is null
    or p_key !~ '^[A-Za-z0-9:_.-]{8,128}$' or p_provider not in ('sarvam','twilio','whatsapp','telecmi')
    or p_action !~ '^[a-z0-9_.]{1,80}$'
    or p_contact_identity_id is null or p_contact_account_id is null or p_contact_identity_hash is null then
    raise exception 'invalid_dispatch_claim' using errcode='22023';
  end if;
  select * into o from public.outbox where id=p_outbox_id and family_id=p_family_id for update;
  if o.id is null or o.status<>'processing' or p_outbox_lease is null or o.lease_token is distinct from p_outbox_lease
    or o.lease_until<=now() then
    raise exception 'stale_outbox_lease' using errcode='40001';
  end if;
  select * into b from public.dispatch_bindings where outbox_id=p_outbox_id and family_id=p_family_id;
  if b.outbox_id is null or b.person_id<>p_person_id or b.provider<>p_provider or b.action<>p_action
    or b.call_id is distinct from p_call_id then
    raise exception 'dispatch_binding_mismatch' using errcode='42501';
  end if;
  if b.call_id is not null and not exists(select 1 from public.calls c where c.id=b.call_id and c.family_id=b.family_id and c.person_id=b.person_id) then
    raise exception 'call_person_mismatch' using errcode='42501';
  end if;
  select * into existing from public.dispatch_ledger where family_id=p_family_id and idempotency_key=p_key;
  if existing.id is not null then
    if existing.outbox_id<>p_outbox_id then raise exception 'dispatch_key_conflict' using errcode='23505'; end if;
    return 'duplicate';
  end if;
  if exists(select 1 from public.dispatch_ledger l where l.family_id=p_family_id and l.outbox_id=p_outbox_id
    and l.status not in ('failed','not_sent')) then
    return 'duplicate';
  end if;
  if p_call_id is not null and exists(select 1 from public.calls c where c.id=p_call_id and c.external_id is not null) then
    raise exception 'call_already_bound' using errcode='23505';
  end if;
  insert into public.dispatch_ledger(family_id,person_id,idempotency_key,provider,action,outbox_id,call_id,
      contact_identity_id,contact_account_id,contact_identity_hash)
    values(p_family_id,b.person_id,p_key,b.provider,b.action,p_outbox_id,b.call_id,
      p_contact_identity_id,p_contact_account_id,p_contact_identity_hash)
    on conflict(family_id,idempotency_key) do nothing;
  get diagnostics n=row_count;
  return case when n=1 then 'claimed' else 'duplicate' end;
end$$;
revoke all on function public.claim_dispatch_contact(uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_dispatch_contact(uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,text,text) to service_role;
