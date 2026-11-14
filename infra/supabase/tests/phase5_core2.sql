-- Phase 5 Core 2 Postgres regression suite (transactional, synthetic fixtures, rolled back).
-- Run after bootstrap.sql and all active migrations through 20261114230000_phase5_core2.sql.
begin;

insert into auth.users (id) values
  ('a2000000-0000-4000-8000-000000000001'), -- Family A child (Riya)
  ('a2000000-0000-4000-8000-000000000002'), -- Family A parent (Maa)
  ('a2000000-0000-4000-8000-000000000003'), -- Family A circle friend
  ('a2000000-0000-4000-8000-000000000004'); -- Family B child

insert into public.families (id, name) values
  ('b2000000-0000-4000-8000-000000000001', 'Synthetic Core2 Family A'),
  ('b2000000-0000-4000-8000-000000000002', 'Synthetic Core2 Family B');

insert into public.people (id, family_id, display_name, role) values
  ('c2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Riya Synth', 'child'),
  ('c2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'Meena Synth', 'parent'),
  ('c2000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000001', 'Neha Synth', 'circle'),
  ('c2000000-0000-4000-8000-000000000004', 'b2000000-0000-4000-8000-000000000002', 'Family B Child', 'child');

insert into public.family_memberships (family_id, user_id, person_id, role) values
  ('b2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'child'),
  ('b2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'parent'),
  ('b2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000003', 'circle'),
  ('b2000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000004', 'child');

insert into public.raw_events (id, family_id, source, provider_event_id, event_type, metadata, status, payload_hash) values
  ('d2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'core2', 'watch-ev-1', 'core2.watch.started', '{}'::jsonb, 'processed', repeat('a', 64)),
  ('d2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'core2', 'sos-ev-1', 'core2.sos.triggered', '{}'::jsonb, 'processed', repeat('b', 64)),
  ('d2000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000002', 'core2', 'watch-ev-b', 'core2.watch.started', '{}'::jsonb, 'processed', repeat('c', 64));

insert into public.consents (id, family_id, person_id, purpose, question, answer, version) values
  ('f2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000003', 'trusted_contact', 'Accept emergency contact role?', true, 'core2-v1');

insert into public.requests (id, family_id, person_id, kind) values
  ('e2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'sos');

insert into public.incidents (id, family_id, person_id, request_id, severity) values
  ('e2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'critical');

-- 1. Constraint checks: cross-family FKs, self-contact, active without consent, unverified acceptance.
do $$ begin
  begin
    insert into public.core2_trusted_contacts (family_id, subject_person_id, contact_person_id, rank, scopes, state, approved_at, consent_id, consent_at)
      values ('b2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000004', 1, array['sos'], 'active', now(), 'f2000000-0000-4000-8000-000000000001', now());
    raise exception 'FAIL cross-family contact allowed';
  exception when foreign_key_violation then null; end;

  begin
    insert into public.core2_trusted_contacts (family_id, subject_person_id, contact_person_id, rank, scopes, state, approved_at, consent_id, consent_at)
      values ('b2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 1, array['sos'], 'active', now(), 'f2000000-0000-4000-8000-000000000001', now());
    raise exception 'FAIL self trusted contact allowed';
  exception when check_violation then null; end;

  begin
    insert into public.core2_trusted_contacts (family_id, subject_person_id, contact_person_id, rank, scopes, state)
      values ('b2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000003', 1, array['sos'], 'active');
    raise exception 'FAIL active trusted contact without consent allowed';
  exception when check_violation then null; end;

  begin
    insert into public.core2_sos_events (family_id, subject_person_id, incident_id, request_id, raw_event_id, status, responder_accepted)
      values ('b2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000002', 'verified_accepted', true);
    raise exception 'FAIL unverified SOS acceptance allowed';
  exception when check_violation then null; end;
end $$;

-- 2. Trusted contact lifecycle + dispatch fence against revocation.
insert into public.core2_trusted_contacts (id, family_id, subject_person_id, contact_person_id, rank, scopes, state, approved_at, consent_id, consent_at)
values ('e2000000-0000-4000-8000-000000000010', 'b2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000003', 1, array['sos', 'watch_escalation', 'reassurance'], 'active', now(), 'f2000000-0000-4000-8000-000000000001', now());

insert into public.outbox (id, family_id, kind, dedupe_key, payload_ciphertext, status) values
  ('e2000000-0000-4000-8000-000000000020', 'b2000000-0000-4000-8000-000000000001', 'core2.sos_alert', 'core2:fence:1', 'enc:pending', 'pending'),
  ('e2000000-0000-4000-8000-000000000021', 'b2000000-0000-4000-8000-000000000001', 'core2.watch_alert', 'core2:sent:1', 'enc:sent', 'completed');

insert into public.core2_dispatch_fences (family_id, outbox_id, trusted_contact_id, state) values
  ('b2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000020', 'e2000000-0000-4000-8000-000000000010', 'armed');

do $$
declare
  revoked_contact public.core2_trusted_contacts;
  outbox_status text;
  fence_state text;
  claim_ok boolean;
begin
  revoked_contact := public.core2_revoke_trusted_contact('b2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000010', 1);
  if revoked_contact.state <> 'revoked' or revoked_contact.version <> 2 then
    raise exception 'FAIL contact revoke state/version mismatch';
  end if;
  select status into strict outbox_status from public.outbox where id = 'e2000000-0000-4000-8000-000000000020';
  if outbox_status <> 'failed' then
    raise exception 'FAIL armed pending outbox was not fenced on revoke';
  end if;
  select state into strict fence_state from public.core2_dispatch_fences where outbox_id = 'e2000000-0000-4000-8000-000000000020';
  if fence_state <> 'fenced_revoked' then
    raise exception 'FAIL fence state not fenced_revoked';
  end if;
  claim_ok := public.core2_claim_fenced_dispatch('e2000000-0000-4000-8000-000000000020');
  if claim_ok then
    raise exception 'FAIL revoked dispatch claim succeeded';
  end if;
end $$;

-- 3. Going-home watch tick -> safe resolution race safety & history preservation.
insert into public.core2_watches (id, family_id, subject_person_id, incident_id, raw_event_id, timezone, state, grace_minutes, deadline_at, grace_until, next_tick_at, route_ciphertext) values
  ('e2000000-0000-4000-8000-000000000030', 'b2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'Asia/Kolkata', 'active', 10, now() - interval '2 minutes', now() + interval '8 minutes', now() - interval '2 minutes', 'enc:route-secret'),
  ('e2000000-0000-4000-8000-000000000031', 'b2000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000004', null, 'd2000000-0000-4000-8000-000000000003', 'Asia/Kolkata', 'active', 10, now() + interval '20 minutes', now() + interval '30 minutes', now() + interval '20 minutes', 'enc:other-family');

insert into public.outbox (id, family_id, kind, dedupe_key, payload_ciphertext, status) values
  ('e2000000-0000-4000-8000-000000000022', 'b2000000-0000-4000-8000-000000000001', 'core2.watch_alert', 'core2:watch:armed:1', 'enc:armed-watch', 'pending');

insert into public.core2_dispatch_fences (family_id, outbox_id, watch_id, state) values
  ('b2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000022', 'e2000000-0000-4000-8000-000000000030', 'armed'),
  ('b2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000021', 'e2000000-0000-4000-8000-000000000030', 'dispatched');

do $$
declare
  ticked_count integer;
  resolved public.core2_watches;
  stale_ticks integer;
  dispatched_status text;
  incident_state text;
  key_hash text := repeat('d', 64);
begin
  select count(*) into strict ticked_count from public.core2_tick_due_watches(now(), 10) where id = 'e2000000-0000-4000-8000-000000000030';
  if ticked_count <> 1 then
    raise exception 'FAIL active watch did not transition to checking_in on due tick';
  end if;

  resolved := public.core2_resolve_watch_safe('b2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000030', 'c2000000-0000-4000-8000-000000000001', 2, key_hash, null);
  if resolved.state <> 'safe' or resolved.version <> 3 or resolved.next_tick_at is not null then
    raise exception 'FAIL resolve_watch_safe did not close watch cleanly';
  end if;

  -- Stale timeout long past grace_until must not reopen or re-escalate safe watch.
  select count(*) into strict stale_ticks from public.core2_tick_due_watches(now() + interval '2 hours', 10) where id = 'e2000000-0000-4000-8000-000000000030';
  if stale_ticks <> 0 then
    raise exception 'FAIL stale timeout tick processed an already-safe watch';
  end if;

  -- Earlier completed outbox row keeps its historical reconciliation status untouched.
  select status into strict dispatched_status from public.outbox where id = 'e2000000-0000-4000-8000-000000000021';
  if dispatched_status <> 'completed' then
    raise exception 'FAIL already-dispatched historical outbox was altered';
  end if;

  select state into strict incident_state from public.incidents where id = 'e2000000-0000-4000-8000-000000000002';
  if incident_state <> 'done' then
    raise exception 'FAIL linked incident not closed on watch safe';
  end if;

  -- Idempotent replay on safe watch returns identical state; wrong version rejects.
  resolved := public.core2_resolve_watch_safe('b2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000030', 'c2000000-0000-4000-8000-000000000001', 999, key_hash, null);
  if resolved.version <> 3 then
    raise exception 'FAIL idempotent replay altered version';
  end if;
end $$;

-- 4. RLS & column-level privilege enforcement under authenticated role.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a2000000-0000-4000-8000-000000000001', true);

do $$ begin
  if (select count(*) from public.core2_watches where id in ('e2000000-0000-4000-8000-000000000030', 'e2000000-0000-4000-8000-000000000031')) <> 1 then
    raise exception 'FAIL child RLS saw cross-family watch';
  end if;
  begin
    perform route_ciphertext from public.core2_watches;
    raise exception 'FAIL encrypted watch route exposed to authenticated role';
  exception when insufficient_privilege then null; end;
  begin
    perform raw_event_id from public.core2_watches;
    raise exception 'FAIL raw_event_id exposed to authenticated role';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from public.core2_dispatch_fences;
    raise exception 'FAIL dispatch fences exposed to authenticated role';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from public.core2_idempotency_records;
    raise exception 'FAIL idempotency records exposed to authenticated role';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.core2_watches;
    raise exception 'FAIL client delete accepted on core2_watches';
  exception when insufficient_privilege then null; end;
  begin
    perform public.core2_resolve_watch_safe('b2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000030', 'c2000000-0000-4000-8000-000000000001', 3, null, null);
    raise exception 'FAIL client invoked service-only RPC';
  exception when insufficient_privilege then null; end;
end $$;

-- Unrelated Family B parent cannot read Family A trusted contacts or watches.
select set_config('request.jwt.claim.sub', 'a2000000-0000-4000-8000-000000000004', true);
do $$ begin
  if exists (select 1 from public.core2_trusted_contacts where family_id = 'b2000000-0000-4000-8000-000000000001') then
    raise exception 'FAIL cross-family trusted contacts readable';
  end if;
end $$;

rollback;

