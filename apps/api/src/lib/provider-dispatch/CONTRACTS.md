# Phase 2 contracts for Phase 3 (atomic enqueue, Atlas runner, proof consumers)

Owner: Kiro A. Reconciled with Phase 3 `c614a32` (`atlas-runtime/CONTRACTS.md`, migrations `20261114201500` / `20261114210000`).
Code: `apps/api/src/lib/provider-dispatch/**`, `recording-worker/**`, `provider-ingestion/**`, `apps/api/src/app/api/twilio/gather/**`.
SQL: `infra/supabase/migrations/20261114201600_phase2_dispatch_recording.sql` (unapplied). Final order: Phase 3 base `201500` (creates `outbox.action`, `outbox.incident_id`, `consent_max_age()`) -> this file `201600` -> Phase 3 review `210000` -> Phase 3 bridge `213000` (calls `bind_outbox_dispatch`, `call_recording_consent`, `dispatch_account`, reads `normalized_proof`).
Tests: `apps/api/tests/{provider-dispatch,recording-worker,provider-ingestion}`, `infra/supabase/tests/phase2_dispatch_recording.sql`, `apps/api/tests/provider-dispatch/sql-concurrency.ps1`.
SQL fixtures follow the combined order: action values satisfy Phase 3's `action_requests_action_known`; each action request is attached to at most one outbox row (`outbox_one_per_action_request`; the conflict is asserted deliberately); when the bridge is present the test first proves `claim_dispatch` is refused by `dispatch_ledger_authorize` for an unauthorized row and then DISABLES that trigger inside the rolled-back transaction, so a claim satisfying the full Phase 3 authorization facts (executed request, live permission, active principal) is NOT covered by this file. `sahaj_private.outbox_proof` / `outbox_acceptance` from the bridge are run against the real proofs when they exist.
**Scratch execution (2026-11-14, loopback PostgreSQL 17.12, parent-provided, all 9 migrations applied in the final order):** `phase2_dispatch_recording.sql` exits 0 and rolls back; `sql-concurrency.ps1 -Psql <psql.exe> -HostName 127.0.0.1 -Port 55439 -User postgres -Database postgres` passes all 17 checks, twice, leaves no rows and no disabled triggers. It now uses real Phase 3 authorization facts (principal, live permission, executed request, offered assignment), so the claim race runs through the bridge's `dispatch_ledger_authorize`. Hosted Supabase behaviour (roles, grants, PostgREST) is NOT covered by this scratch run. TypeScript tests use in-memory models of the SQL rules.

## 0. Rules for every writer

- **Lock order:** `people` (FOR NO KEY UPDATE) -> `calls` (FOR UPDATE) -> `call_content` / `assignments` / ledger rows. The `consents` insert trigger `consents_serialize` takes the person lock. Phase 3 triggers take a per-family advisory lock first; the two never wait on each other in the opposite order (recording writes do not take the family lock).
- **Consent in the future:** refused by writers in both lanes. With both migrations applied, Phase 3's `consents_future` fires first (trigger name order) and raises SQLSTATE `22023` `future_consent_rejected`; this lane's `consents_serialize` (`23514` `future_consent`) only fires when Phase 3 is absent. Callers must accept exactly those two.
- `service_role` has SELECT only on `dispatch_ledger` and `dispatch_bindings`. Changes go through the functions below.
- `raw_events.normalized_proof` is set only by `record_delivery_proof` / `record_responder_acceptance` (trigger-guarded). Generic `ingest_raw_event` cannot create it, flip it, or forge a row that satisfies a strict consumer.
- **Who may write normalized proof (trust boundary).** The `raw_events_guard_proof` trigger accepts `normalized_proof=true` on INSERT only when `current_user` is the role that OWNS `raw_events` (the SECURITY DEFINER proof functions run as that owner). `service_role` cannot, through REST or direct SQL; the earlier custom GUC (`sahaj.proof_writer`) is removed because any SQL session can set a GUC, so it was not a credential. Generic `ingest_raw_event` never sets the flag and REST cannot call `set_config`. The database owner or a superuser can write anything: this protects against `service_role`, not against the owner. Residual assumption: `service_role` must not be able to `SET ROLE` to the owner or create objects owned by it (true on the stock Supabase setup, not verified here). Column-level INSERT grants were not used: they would silently break any future column that `service_role` must insert.
- **Normalized proof is frozen evidence.** `raw_events_guard_proof` (insert/update/delete) rejects, with `42501`, any update to a normalized row that changes any column other than worker bookkeeping (`attempt_count, max_attempts, retry_at, lease_token, lease_until, worker_id, last_error_code`), and any delete. That covers id, family, source, provider event id, event type, metadata (action, person, account, ...), hashes, ciphertext, status and timestamps. A proof therefore cannot be rewritten into another accepted action, person or account. Scratch cleanup must disable the trigger as owner.

## 1. Phase 3 atomic enqueue MUST call the binding RPC

```
public.bind_outbox_dispatch(
  p_family_id uuid, p_outbox_id uuid, p_person_id uuid, p_provider text, p_action text,
  p_call_id uuid default null, p_incident_id uuid default null, p_assignment_id uuid default null) returns boolean
```
Call it in the SAME transaction as the `outbox` insert, after `outbox.action`, `.incident_id`, `.action_request_id` are set.
- `p_person_id`: the person who will be contacted (for urgent responder calls, the RESPONDER, not the incident subject).
- `p_provider`: `sarvam | twilio | whatsapp`. `p_action`: the PROVIDER operation, must start with `<provider>.`: `sarvam.outbound_call`, `twilio.create_call`, `whatsapp.send_text`. This is NOT `outbox.action` (the care/domain action such as `check_in`, `send_alert`, `urgent_responder`).
- `p_call_id`: required for the two call operations. **Validated at bind time:** the `calls` row must exist in the same family, belong to `p_person_id` and have `external_id` null, otherwise `42501 call_person_mismatch` and nothing is recorded (an identical replay after dispatch is still a no-op). `claim_dispatch` re-validates that the bound call still belongs to the BOUND recipient before any ledger row is written, so a same-family call swap after binding is refused before any external send.
- `p_incident_id`: optional; if the outbox row has `incident_id` it must match and is used when omitted. `p_assignment_id`: urgent responder only; its person must equal `p_person_id` and its incident the bound incident.
- `action_request_id` is copied from the outbox row (never passed in). Rebinding with different values raises `23505`; identical is a no-op. Row is immutable (update/delete trigger).
- Without a binding, `claim_dispatch` refuses the row (`42501`). With one, a claim whose person, provider, action or call differs is refused even with a valid lease inside the family.

## 2. Common verified proof (what the producers write, what Phase 3 reads)

Raw provider callbacks stay raw. Proof is derived only by SQL from stored records: raw callback -> `calls.external_id` -> `dispatch_ledger` -> `dispatch_bindings` -> `outbox` / `action_requests` / `assignments` / `incidents` -> the provider account bound at dispatch.
`account_id` comes from `provider_identities` rows written by `complete_dispatch` (server-configured account, never callback data): Sarvam `app_id` (kind `attempt`), Twilio `AccountSid` (`call`), WhatsApp `phone_number_id` (`message`); `attempt_id` = provider reference, `person_id` = the contacted person.

### `delivery.confirmed` / `delivery.not_sent` (source = provider, `status='processed'`, `normalized_proof=true`)
`outbox_id, action_request_id, action` (= `outbox.action`, care enum), `provider_action` (= ledger operation), `account_id`, `dispatch_key` (= `dispatch_ledger.idempotency_key`), `provider_ref`, `outcome` (`delivered` | `confirmed_not_sent`), `person_id`, `source_event_id`, `normalized=true`.
Producer: `record_delivery_proof(family, raw_event_id, outcome)` via `normalizeDeliveryOutcome`. Status mapping (SQL = TS): `confirmed_not_sent` for Twilio `busy|no-answer|failed|canceled`, Sarvam `no_answer|busy|failed`, WhatsApp `failed`; `delivered` ONLY for WhatsApp `delivered|read`. A connected or completed call is never proof. A dispatch that timed out has no provider reference, so no callback can be linked to it and it stays `delivery_unknown`. Contradicting proof for one dispatch is refused.
Consumers: `reconcile_dispatch(family,key,proof,outcome)` then `reconcile_outbox(outbox,proof,outcome)` (replaced here: needs normalized proof, equal outbox/request/care action/provider action/account, and a ledger row already reconciled with that exact proof).

### `responder.accepted` (source `twilio`, `normalized_proof=true`, `verified_by='twilio_signature'`)
`incident_id, assignment_id, responder_person_id, person_id` (= the OFFERED RESPONDER, equal to `responder_person_id`), `subject_person_id` (the incident's subject, must differ), `call_id, outbox_id, action_request_id, action='urgent_responder'` (= `outbox.action`), `provider_action, account_id, dispatch_key, source_event_id, normalized=true`.
Producer: Gather route -> `record_responder_acceptance(family, gather_provider_event_id)` -> `accept_assignment_verified(family, assignment, proof)`; `assignments.verified_by_provider_event` is the normalized `responder.accepted` row, NOT the raw Gather event. `accept_assignment_verified` re-derives every field and demands exact equality.
Phase 3 predicate parity: `infra/supabase/tests/phase2_dispatch_recording.sql` mirrors Phase 3's `outbox_proof` / `outbox_acceptance` and runs them against real proof (current and strict forms) and against a generic forged row (passes only the non-strict form). **Phase 3 should adopt the strict form:** add `e.normalized_proof` and join `dispatch_ledger` on `idempotency_key = metadata.dispatch_key AND outbox_id = o.id AND provider_ref = metadata.provider_ref`.

## 3. Consent validity: ONE shared policy

`sahaj_private.call_recording_consent(family, call, person)` returns `TABLE(id uuid, granted_at timestamptz)` (zero rows when not effective), NOT a scalar uuid, and is executable by nobody except definer functions. Call it as `select e.id into v from sahaj_private.call_recording_consent(...) e` inside a definer function.

`sahaj_private.consent_max_age()` = 365 days is defined in both migrations (`create or replace`, identical) and read by Phase 3 `consent_current`, by `call_recording_consent` / `put_call_recording` / purge here, and mirrored in TS (`provider-ingestion/consent-policy.ts`, `CONSENT_MAX_AGE_MS`). A grant counts only while `created_at <= now` and `created_at > now - 365d` (strict); newest row for the exact call plus global refusals wins, ties go to refusal, refusals never age out, a global yes never grants, other purposes (`call_transcript`, `voice_share:*`) never grant `call_recording`. Stored recording retention is capped at `grant.created_at + 365d` in SQL and TS, and the purge treats an aged-out grant like a revoked one, so no stored recording survives the gate refusing it. If Phase 3 changes the value, change the single function and `CONSENT_MAX_AGE_MS` together (a TS test pins the number).

## 4. Runner entrypoints (stable, gated, no live calls here)

All take injected dependencies; none reads the environment.
- `runOutboxDispatchTick({ ...DispatchDeps, enabled, compose, workerId, limit?, leaseSeconds?, staleClaimSeconds? })` (`provider-dispatch`): when `enabled` is false it does nothing. Otherwise: sweep abandoned claims -> `claim_outbox` -> `get_dispatch_binding` -> trusted `compose(row, binding)` (must return exactly the bound operation; returns the provider payload, e.g. language or TwiML URL; no phone numbers) -> `dispatchOutbound` (reauthorize via `authorize`, ledger claim, adapter, atomic result, `finish_outbox`). Rows with no binding are finished `binding_missing` without any claim. `delivery_unknown` rows are never claimed again.
- `runStatusNormalizationJob({ store, readRaw }, rawEventId)`: for `twilio.call_status` / `sarvam.outbound` / `whatsapp.status` raw events. Returns `{action:'complete'|'retry', code}`; completing never means delivered. Phase 3 currently completes these as facts: call this first in the `core1.provider_status` handler (and for the Sarvam events it routes to Atlas, so proof is written before Atlas reviews them).
- `runRecordingJob(workerDeps, db, rawEventId)` (`recording-worker`): the `core1.recording` handler. `complete` for stored / already stored / ignored additional / permanent refusal (code `rejected:<why>`), `retry` for transient failures (finish the job failed with backoff).
- `runRecordingPurgeTick({ store: purgeStore(), storage: recordingStorage(), enabled, now?, limit? })`: scheduler entrypoint; `enabled=false` lists and deletes nothing.
- `runGatherAcceptance` is the route itself: `POST /api/twilio/gather`.
Factories for the real stores: `dispatchStore()`, `recordingStore()`, `recordingStorage()`, `purgeStore()`, `gatherStore()` (service role, read env through `serviceDatabase()` only when called).

## 5. Other contract points (unchanged)

- Dispatch key `dispatch:<outboxId>:a<attempt>`; one live ledger row per outbox regardless of key. `denied` / `failed` / `delivery_unknown` / `duplicate` semantics as in the code comments. `deps.authorize` must re-evaluate current consent/permission/membership; `deps.resolveDestination` must filter by family AND person and never log numbers.
- Gather route: signed, exact configured URL (`TWILIO_GATHER_CALLBACK_URL`), stored call, explicit digit `1`; nothing identifying an assignment is read from the request. The TwiML that places the call must use `<Gather input="dtmf" numDigits="1" action="<exact gather URL>">`.
- Recordings: Twilio and (opt-in, `SARVAM_RECORDING_RETRIEVAL=true` plus worker `sarvam` config) Sarvam; first recording per call wins; purged recordings are never stored again; purge deletes only `<family>/calls/<call>/...` exact stored paths.
- Environment names introduced: `TWILIO_GATHER_CALLBACK_URL`, `SARVAM_RECORDING_RETRIEVAL`; worker config values are passed in by the caller.

## 6. Open items needing other lanes

0. **Phase 3 bridge `c184a68` (read-only review, not edited):** (a) `20261114213000_phase3_bridge.sql` `request_consent` assigns `cid := sahaj_private.call_recording_consent(...)` as a scalar; the function returns a table, so that must become `select e.id into cid from sahaj_private.call_recording_consent(...) e`, otherwise `record_audio` consent fails at runtime. (b) Its comment says recording consent has \

1. Phase 3 enqueue must call `bind_outbox_dispatch` and set `outbox.action` / `incident_id`; its `observe_delivery` / `outbox_acceptance` should add the strict join in section 2.
2. Phase 3 cron must route `twilio.call_status` and the Sarvam/WhatsApp status events through `runStatusNormalizationJob`, `twilio.recording.retrieval_requested` and `sarvam.recording.retrieval_requested` through `runRecordingJob`, and schedule `runOutboxDispatchTick` / `runRecordingPurgeTick`. Phase 3's router lists only the Twilio recording event today.
3. No producer exists for `whatsapp.status` events; WhatsApp `delivered|read` proof therefore cannot occur yet.
4. Incident and assignment creation (Phase 4) is required before any urgent responder call can be bound.
5. Twilio media Basic auth (API key pair vs AccountSid:AuthToken), Twilio `.wav` redirect behaviour and Sarvam recording timing remain unconfirmed (see `packages/adapters/README.md`).
