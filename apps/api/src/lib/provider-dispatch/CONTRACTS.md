# Phase 2 contracts for KiroB (outbox, authorization, workflow)

Owner: Kiro A. This file lists what the dispatch and recording code expects from other lanes. Nothing here edits their files.
Code: `apps/api/src/lib/provider-dispatch/**`, `apps/api/src/lib/recording-worker/**`. SQL: `infra/supabase/migrations/20261114201600_phase2_dispatch_recording.sql`.
The SQL has not been executed against Postgres yet (see "Status").

## 1. Outbox row -> `dispatchOutbound`

The outbox worker calls `claim_outbox`, then for each claimed row builds a `DispatchCommand` and calls `dispatchOutbound(deps, cmd)`.

| Field | Source |
| --- | --- |
| `familyId`, `outboxId` | the claimed `outbox` row |
| `outboxLease` | `outbox.lease_token` from the claim |
| `attempt` | `outbox.attempt_count` from the claim (1-based). The ledger key is `dispatch:<outboxId>:a<attempt>` |
| `personId` | recipient person, resolved by the workflow. Must belong to `familyId` |
| `callId` | required for `sarvam.outbound_call` and `twilio.create_call`: an existing `calls` row for the same family and person, `external_id` null |
| `payload` | `{action, ...}` with no phone numbers. Call text is limited to what the adapters accept |
| `aiDisclosureAttested` | Twilio only. Set `true` only if the TwiML at `twimlUrl` speaks the AI disclosure. Sets `calls.ai_disclosed_at`. The gateway refuses recording consent without it |

`dispatchOutbound` calls `finish_outbox` itself. Do not call it again for the same lease.
- `dispatched` -> `finish_outbox(success)`. This means the provider accepted the request, not that a person heard anything.
- `failed` (clean refusal or pre-network failure) -> `finish_outbox(false, code)`. `claim_outbox` may offer the row again with a higher `attempt_count`, which yields a new key. A row whose ledger entry is `claimed`, `dispatched`, `delivery_unknown` or `delivered` can never be dispatched again under any key.
- `delivery_unknown` -> `finish_outbox(false, 'delivery_unknown')`, which sets `outbox.status='delivery_unknown'` and is never reclaimed.
- `duplicate` -> outbox untouched. Its lease expires into `delivery_unknown` (existing `claim_outbox` behaviour). Do not resend.
- `denied` -> authorization refused before any claim.

Run `sweepStaleClaims(store)` on the cron tick. It marks ledger rows left `claimed` by a dead worker as `delivery_unknown`.

## 2. `deps.authorize(cmd, key)` (needs Cedar / permission gate from KiroB)

Called on every dispatch, after the outbox claim and before the ledger claim. It must re-evaluate current state (consent not revoked, permission not expired, person still in the family) and return an `ActionAuthorization` with:
`decision: 'allow'`, `consent: true`, `personId === cmd.personId`, `action === cmd.payload.action`, `idempotencyKey === key`, `expiresAt` in the future. Anything else, a thrown error, or `null` denies. The adapters check the same fields again.
Action names: `sarvam.outbound_call`, `twilio.create_call`, `whatsapp.send_text`.

## 3. `deps.resolveDestination(familyId, personId, provider)`

Returns the person's E.164 number from `provider_identities.contact_ciphertext` for that family and person, or `null`. It must filter by `family_id` AND `person_id`. The number never goes into the outbox payload, the command, outcomes or logs. Not implemented here because the contact encryption scheme is not in this lane.

## 4. Evidence events that resolve unknown deliveries

`reconcile_outbox` (existing) and `reconcile_dispatch` (new) accept only a `processed` raw event of the same family:

| event_type | metadata |
| --- | --- |
| `delivery.confirmed` | `outcome='delivered'`, `dispatch_key`, `provider_ref` (when known), `outbox_id` |
| `delivery.not_sent` | `outcome='confirmed_not_sent'`, `dispatch_key`, `provider_ref`, `outbox_id` |

`raw_events.source` must equal the ledger provider. The writer of these events should use `classifyProviderStatus(provider, status)`. A connected or completed call returns `null` because it does not prove a person was reached. Call both RPCs for one outcome; they are separate transactions on separate tables.

## 5. Responder acceptance

`acceptResponderFromVerifiedEvent(store, familyId, assignmentId, providerEventId)` calls `accept_assignment_verified`. It returns true only when:
- the event is `source='twilio'`, `event_type='twilio.gather.accepted'`, same family, not dead, received between the assignment's `offered_at` and `expires_at`;
- event metadata has `assignment_id`, `person_id` (the assignment's person) and `call_id`;
- that `calls` row is a Twilio call for that person with an `external_id` equal to `provider_ref` of a `dispatched`/`delivered` `twilio.create_call` ledger row for the same call.

A future signed Twilio Gather route (not built; `twilio/voice/test` is still 501) must ingest that event type only after signature and DTMF validation. Sarvam status, WhatsApp text, gateway "success" flags and model output are other event types and are never accepted. One event can verify one assignment only. The function does not touch `incidents`; the workflow does that after a `true` result.

## 6. Recording retrieval

Input: a raw event id for `twilio.recording.retrieval_requested`. Use `readRawEvent(db, id)` then `processRecordingEvent(deps, row)`.
- `stored`, `already_stored`, `ignored_additional` -> finish the job as completed.
- `retry` -> fail the job so it is retried with backoff (same raw event, deterministic paths).
- `rejected` -> finish as completed or failed without retry. The code says why (consent, identity, media).
The cron route currently flattens every event to `core1.ingest`. It needs a `workflow_kind` for this event type (audit M2). That route is outside this lane.

Multiple recordings per call: the first stored recording keeps the `(family_id, call_id)` slot. A different `RecordingSid` for the same call returns `ignored_additional` and its object is deleted. The same `RecordingSid` replayed returns `already_stored`.

## Status

- Verified by tests (fake stores and scripted transports): TypeScript flow, error mapping, RPC argument names.
- NOT verified: the SQL functions. `infra/supabase/tests/phase2_dispatch_recording.sql` covers them but needs Postgres. Do not apply the migration to the real project before running it on a scratch database.
- Not built: Twilio Gather route, Sarvam recording retrieval event, retention purge of expired recordings, revocation purge of already stored recordings (the media signer rechecks consent at read time), outbox payload encryption.
