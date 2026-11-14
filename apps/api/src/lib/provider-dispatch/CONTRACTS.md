# Phase 2 contracts for KiroB / Phase 3 (outbox, authorization, workflow, proof)

Owner: Kiro A. Code: `apps/api/src/lib/provider-dispatch/**`, `recording-worker/**`, `provider-ingestion/**`, `apps/api/src/app/api/twilio/gather/**`.
SQL: `infra/supabase/migrations/20261114201600_phase2_dispatch_recording.sql` (unapplied, single file, edited in place after review).
Tests: `apps/api/tests/{provider-dispatch,recording-worker,provider-ingestion}`, `infra/supabase/tests/phase2_dispatch_recording.sql`, `apps/api/tests/provider-dispatch/sql-concurrency.ps1`.
The SQL and the two-session script have NOT been executed (no Postgres in the authoring environment). Run both on a scratch database first.

## 0. Rules every writer must follow

- **Lock order:** `people` (FOR NO KEY UPDATE) -> `calls` (FOR UPDATE) -> `call_content` / `assignments` / ledger rows. The `consents` insert trigger takes the person lock, so a refusal cannot be inserted between a consent read and the write that relied on it. Phase 3 enqueue, approval and revocation writers should use the same first lock for the same person.
- **No future-dated consent:** `consents_before_insert` raises `23514` if `created_at > now()`.
- **`service_role` has SELECT only** on `dispatch_ledger` and `dispatch_bindings` (explicit `REVOKE ALL ... FROM service_role` before the grant). All state changes go through the functions below.
- **Normalized proof is distinguishable.** `raw_events.normalized_proof` is true only for rows written by `record_delivery_proof` / `record_responder_acceptance`. A trigger rejects setting it any other way, and consumers ignore events without it. A generic `ingest_raw_event` row with perfect-looking metadata is not proof.

## 1. Enqueue transaction -> `bind_outbox_dispatch` (REQUIRED, Phase 3)

In the SAME transaction that inserts the outbox row (and consumes approval/quota), call `bind_outbox_dispatch(family, outbox, person, provider, action, call?, incident?, assignment?)`. It records, once and immutably (update/delete trigger), WHO may be contacted, through WHICH provider action, for WHICH call. `action_request_id` is copied from the outbox row, never passed in. `claim_dispatch` refuses (`42501`) any outbox row without a binding and any claim whose person, provider, action or call differs from it, even with a valid lease inside the same family.
- `action` must start with `provider.` (`sarvam.outbound_call`, `twilio.create_call`, `whatsapp.send_text`).
- Urgent responder calls: pass `incident` and `assignment`; the assignment's person must equal `person` (the responder being called) and the outbox row's `action_request_id` must point at an `action_requests` row whose `action = 'urgent_responder'`.
- Rebinding with different values raises `23505`. Same values is a no-op.

## 2. Outbox row -> `dispatchOutbound`

Command fields: `familyId`, `outboxId`, `outboxLease`, `attempt` (= `outbox.attempt_count`), `personId`, `callId` (call actions), `payload`, `aiDisclosureAttested` (Twilio only: TwiML speaks the AI disclosure). Key is `dispatch:<outboxId>:a<attempt>`.
`dispatchOutbound` calls `finish_outbox` itself: `dispatched` -> success; `failed` -> `finish_outbox(false, code)`, a later attempt gets a new key; `delivery_unknown` -> `finish_outbox(false,'delivery_unknown')`, never reclaimed; `duplicate` -> outbox untouched (lease expiry makes it `delivery_unknown`); `denied` -> nothing claimed. A live ledger row for an outbox blocks any other key.
`deps.authorize(cmd, key)` must re-evaluate current consent/permission/membership and return an `ActionAuthorization` for this person, action and key; anything else denies. `deps.resolveDestination(family, person, provider)` returns E.164 from `provider_identities.contact_ciphertext` filtered by BOTH family and person; the number never enters outbox payloads, commands, outcomes or logs.
Run `sweepStaleClaims` on the cron tick.

## 3. Common verified proof (root contract) and who writes it

Raw provider callbacks stay raw. Normalized proof is created only by SQL, from stored records, never from callback fields.

### `delivery.confirmed` / `delivery.not_sent`
Producer: `normalizeDeliveryOutcome(store, {familyId, sourceEventId, provider, status})` -> `record_delivery_proof(family, raw_event_id, outcome)`.
- Source must be a durably `processed` raw event of type `twilio.call_status` / `sarvam.outbound` / `whatsapp.status` in the same family. The gateway now stores OUR `call_id` in the metadata of Twilio status and Sarvam outbound events (same family and person only); SQL resolves call -> `calls.external_id` -> ledger row -> binding. WhatsApp status events (not produced in this lane) must carry `provider_ref` in metadata.
- Status mapping (SQL and TS agree): `confirmed_not_sent` for Twilio `busy|no-answer|failed|canceled`, Sarvam `no_answer|busy|failed`, WhatsApp `failed`. `delivered` only for WhatsApp `delivered|read`. A connected or completed call is never proof; those events stay pending and the ledger stays `delivery_unknown`.
- Metadata written by SQL: `normalized=true, outcome, outbox_id, action_request_id (null if the outbox has none), action, dispatch_key, provider_ref, person_id, source_event_id`. Contradicting proof for the same dispatch is refused (`23505`).
- Consumers: `reconcile_dispatch(family,key,proof,outcome)` then `reconcile_outbox(outbox,proof,outcome)` (replaced in this migration; it now needs normalized proof, equal outbox/request/action, and a ledger row already reconciled with that exact proof). Only `delivery_unknown` rows change. A dispatch that timed out has no provider reference, so no callback can be linked to it: it stays unknown for review. That is intended.

### `responder.accepted`
Producer: the signed Gather route -> `record_responder_acceptance(family, gather_provider_event_id)` then `accept_assignment_verified(family, assignment, proof)`.
- Metadata (all derived by SQL from the call -> twilio ledger row -> immutable binding -> assignment/incident/outbox/action request): `incident_id, assignment_id, responder_person_id, person_id (the incident's person), call_id, outbox_id, action_request_id, action='urgent_responder'`, plus `normalized=true, verified_by='twilio_signature', source_event_id`.
- Requires: Twilio call placed by this system to the responder (ledger `dispatched|delivered`, `provider_ref = calls.external_id`), assignment `offered`, unexpired, press received inside its window, `action_requests.action='urgent_responder'`. `accept_assignment_verified` re-derives everything and requires exact equality with the proof; it is idempotent for the same proof and false for any other. One event verifies one assignment (unique index).
- Phase 3 consumers should read `responder.accepted` with `normalized_proof=true` (or the `assignments.status='accepted'` row, which already requires the proof). The old `twilio.gather.accepted` name no longer exists.

## 4. Gather route

`POST /api/twilio/gather`: signature over the exact configured URL (`TWILIO_GATHER_CALLBACK_URL`) and account, stored call by `CallSid`, explicit digit `1`. Any other digit or no digit writes nothing. The assignment, incident, responder and outbox are never read from the request. The raw press is persisted (`twilio.gather.response`, id `<AC>:gather:<CA>`) before SQL resolves acceptance. Failure to prove any link returns 403 and no proof. The TwiML that places the call must use `<Gather input="dtmf" numDigits="1" action="<exact gather URL>">`; building that TwiML is outside this lane.

## 5. Recordings

- Twilio: `twilio.recording.retrieval_requested` (existing). Sarvam: `sarvam.recording.retrieval_requested`, queued only when `SARVAM_RECORDING_RETRIEVAL=true`, the call disclosed AI and exact-call `call_recording` consent is effective; payload fields are only ids already stored or sent by Sarvam. The worker needs `deps.sarvam` (apiKey, orgId, workspaceId, appId); without it such events are rejected `sarvam_recording_unavailable`.
- For outbound Sarvam calls the worker first confirms with Sarvam's List attempts that the stored attempt produced the interaction in the (unsigned) webhook body. Unconfirmed: rejected, nothing fetched.
- `processRecordingEvent` outcomes: `stored | already_stored | ignored_additional` -> complete; `retry` -> fail with backoff; `rejected` -> do not retry.
- First recording per call wins (`put_call_recording` serializes on the person and call locks; the second concurrent writer gets `ignored_additional`). A purged recording is never stored again (`purged`).
- **Purge entrypoint (scheduler is the parent's):** `runRecordingPurge({store: purgeStore(), storage: recordingStorage(), now, limit})`. SQL lists rows past retention or whose consent is no longer effective; the worker deletes only the exact stored path (validated to be `<family>/calls/<call>/...` for that row), then `finish_recording_purge` compare-and-sets family, call and path. `p_as_of` can never exceed the database clock. After purge `get_call_media_metadata` returns a null path, so the media signer denies.

## 6. Environment names introduced (values are the parent's to set)

`TWILIO_GATHER_CALLBACK_URL`, `SARVAM_RECORDING_RETRIEVAL` (`true` to enable), and for the recording worker Sarvam config `SARVAM_API_KEY`, `SARVAM_ORG_ID`, `SARVAM_WORKSPACE_ID` (passed in by the caller; this lane never reads the environment). `.env.example` is not in this lane.

## 7. Not done / needs a decision

- Revocation fencing for writers outside this lane (Phase 3 approvals, memberships, permissions) is their job; they must adopt the lock order in section 0.
- `whatsapp.status` ingestion route does not exist, so WhatsApp delivery proof has no producer yet.
- Twilio media auth: Twilio's page says to use an API key SID and secret for media URLs. `fetchTwilioRecording` sends AccountSid:AuthToken Basic auth. Confirm in a sandbox or switch the config to an API key pair.
- Twilio `.wav` redirect behaviour is not documented on the recording page, so a redirect still fails closed.
- Sarvam recording availability timing after the webhook, and whether the attempts list is complete for the lookback window, are unconfirmed; the worker treats 404 as retryable and unconfirmed attempts as rejected.
