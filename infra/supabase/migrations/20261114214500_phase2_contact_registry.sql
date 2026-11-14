-- Phase 2 contact registry. Applies after 20261114213000_phase3_bridge.sql (final order: Phase 3 base 201500 -> Phase 2 201600 ->
-- Phase 3 review 210000 -> Phase 3 bridge 213000 -> this file). Service-role only. No client can reach it.
--
-- A contact row is a provider_identities row with binding_kind='contact'. The phone number is stored ONLY as
-- contact_ciphertext (AES-256-GCM, AAD binding family/person/provider/account/hash, written by the server helper
-- apps/api/src/lib/provider-dispatch/contacts.ts). external_id_hash is HMAC(identity secret, [source, account, digits]),
-- the same hash the inbound gateways look up. This file never sees a plaintext number.

-- One ACTIVE contact per person per provider account, so destination resolution is never ambiguous.
create unique index provider_identities_one_active_contact on public.provider_identities(family_id,person_id,source,account_id)
  where binding_kind='contact' and enabled and revoked_at is null;

-- Register (never reassign, never revive). Lock order matches every other Phase 2 writer: the person row first.
-- Returns 'registered' (new row) or 'already_registered' (identical active row for this person). Raises:
--   42501 person_not_in_family      the person does not belong to the family
--   23505 identity_owned_elsewhere  this number (hash) is bound to another family or person, active or not
--   23505 identity_revoked          this person's row for this number was revoked or disabled: revival is explicit, not implicit
--   23505 contact_already_registered the person already has a DIFFERENT active number for this provider account (revoke it first)
--   22023 invalid_contact            malformed arguments
create function public.register_contact_identity(p_family_id uuid,p_person_id uuid,p_source text,p_account_id text,
  p_identity_hash text,p_contact_ciphertext text)
returns text language plpgsql security definer set search_path='' as $$
declare existing public.provider_identities;
begin
  if p_family_id is null or p_person_id is null or p_source is null or p_source not in ('sarvam','twilio','whatsapp','telecmi')
    or p_account_id is null or p_account_id !~ '^[A-Za-z0-9_.-]{1,128}$'
    or p_identity_hash is null or p_identity_hash !~ '^[0-9a-f]{64}$'
    or p_contact_ciphertext is null or p_contact_ciphertext !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{8,200}$' then
    raise exception 'invalid_contact' using errcode='22023';
  end if;
  perform 1 from public.people p where p.id=p_person_id and p.family_id=p_family_id for no key update;
  if not found then raise exception 'person_not_in_family' using errcode='42501'; end if;
  select * into existing from public.provider_identities i
    where i.source=p_source and i.account_id=p_account_id and i.external_id_hash=p_identity_hash and i.binding_kind='contact' for update;
  if existing.id is not null then
    if existing.family_id<>p_family_id or existing.person_id<>p_person_id then
      raise exception 'identity_owned_elsewhere' using errcode='23505';
    end if;
    if not existing.enabled or existing.revoked_at is not null then
      raise exception 'identity_revoked' using errcode='23505';
    end if;
    return 'already_registered';
  end if;
  if exists(select 1 from public.provider_identities i where i.family_id=p_family_id and i.person_id=p_person_id and i.source=p_source
    and i.account_id=p_account_id and i.binding_kind='contact' and i.enabled and i.revoked_at is null) then
    raise exception 'contact_already_registered' using errcode='23505';
  end if;
  insert into public.provider_identities(family_id,person_id,source,account_id,external_id_hash,binding_kind,contact_ciphertext)
    values(p_family_id,p_person_id,p_source,p_account_id,p_identity_hash,'contact',p_contact_ciphertext);
  return 'registered';
end$$;

-- Revoke this person's active contact for one provider account. Returns the number of rows revoked (0 or 1). The row stays
-- (audit, and so the same number cannot silently move to another person later). Inbound lookups and destination
-- resolution stop matching it immediately.
create function public.revoke_contact_identity(p_family_id uuid,p_person_id uuid,p_source text,p_account_id text)
returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  if p_family_id is null or p_person_id is null or p_source is null or p_account_id is null then
    raise exception 'invalid_contact' using errcode='22023';
  end if;
  perform 1 from public.people p where p.id=p_person_id and p.family_id=p_family_id for no key update;
  if not found then raise exception 'person_not_in_family' using errcode='42501'; end if;
  update public.provider_identities set revoked_at=clock_timestamp(),enabled=false
    where family_id=p_family_id and person_id=p_person_id and source=p_source and account_id=p_account_id
      and binding_kind='contact' and revoked_at is null;
  get diagnostics n=row_count;
  return n;
end$$;

revoke all on function public.register_contact_identity(uuid,uuid,text,text,text,text),
  public.revoke_contact_identity(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.register_contact_identity(uuid,uuid,text,text,text,text),
  public.revoke_contact_identity(uuid,uuid,text,text) to service_role;
