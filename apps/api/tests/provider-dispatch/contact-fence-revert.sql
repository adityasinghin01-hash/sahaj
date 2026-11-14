-- Reverts EXACTLY the objects created by 20261114214500_phase2_contact_registry.sql and 20261114220000_phase2_contact_fence.sql.
-- Used only by sql-concurrency.ps1 -InstallContactFence on the loopback scratch database, when those two migrations were not
-- part of the parent's applied set and the script installed them temporarily (two sessions need committed schema). The script
-- compares a schema fingerprint before install and after this revert and fails if they differ.
begin;
drop trigger dispatch_ledger_contact_fence on public.dispatch_ledger;
drop function sahaj_private.dispatch_ledger_contact_fence();
drop function public.claim_dispatch_contact(uuid,uuid,text,text,text,uuid,uuid,uuid,uuid,text,text);
alter table public.dispatch_ledger drop column contact_identity_hash, drop column contact_account_id, drop column contact_identity_id;
drop function public.register_contact_identity(uuid,uuid,text,text,text,text);
drop function public.revoke_contact_identity(uuid,uuid,text,text);
drop index public.provider_identities_one_active_contact;
commit;
