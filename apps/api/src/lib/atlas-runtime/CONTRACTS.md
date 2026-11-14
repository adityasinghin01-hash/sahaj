# Atlas runtime contracts (Kiro B, Phase 3)

Counterpart to the provider-dispatch contract owned by Kiro A. At the time of writing, `.worktrees/kiro-phase2` contained no `CONTRACTS.md`, so nothing here was checked against it. Items marked **ASK CODEX** need a shared decision. Nothing here is verified against a live database or provider.

## What is real and what is not

| Area | State |
|---|---|
| SQL `20261114201500_phase3_atomic_orchestration.sql` | Written, **never executed** (no PostgreSQL available locally). `infra/supabase/tests/phase3_atomic_orchestration.sql` is written but unexecuted. Apply and run it on a disposable database before trusting any of it. |
| TypeScript runtime (`apps/api/src/lib/atlas-runtime`) | Typechecked and unit-tested against in-memory fakes of the RPCs. Fakes prove call order and fail-closed handling, not SQL behaviour. |
| PostgresSaver wiring (`factory.ts`) | Constructed, not exercised in tests. The earlier two-process restart check covered the saver itself. |
| Model/provider understanding | Not injected. Only exact commands ("check in", "family report") are mapped. Everything else pauses for review. |

## Principal binding (actor)

The acting AI actor is a server-owned row in `public.atlas_principals` (one active row per family). It is distinct from every human. Gate `actor.id` is the principal id. `permissions.principal_id` plus `permissions.person_id` (the subject) plus `target_ids` define what it may do. If a family has no active principal, `ensure_action_request` returns null, understanding stays `uncertain`, and the job pauses for review. Nothing is authorized by inference from a human membership.

The subject and target for a deterministic command are both the verified sender (`person_id` bound inside the hashed encrypted envelope and checked against row metadata). Commands aimed at another person need structured understanding plus a database-verified target, which does not exist yet.

## Authorization protocol

1. `load_gate_snapshot` returns the request, candidate `allow` permissions, human answers, consents, a `block` flag for live deny/ask rows, and `revision` (SHA-256 over every fact the decision depends on, including false answers, revocations and consent row count).
2. The app rebuilds the `GateRequest` from stored columns and requires its `requestFingerprint()` to equal `action_requests.request_fingerprint` (stored at creation, immutable by trigger). It then runs the real Cedar `evaluateGate` once per candidate permission in SQL order. A deny/ask row beats any allow.
3. `enqueue_authorized_command` (service role only, lease-fenced) recovers an existing outbox row by `(family_id, dedupe_key)` first, comparing job, action, request and `payload_hash` (plaintext hash, since ciphertext is randomized). Otherwise it takes `lock_family_authorization`, recomputes the revision and raises `40001` if it changed, rechecks bounds with one DB clock, locks the permission row, requires two distinct active parent/child approvers when `permission.two_person_required` OR `request.two_person_required`, then increments `used_count`, marks the request `executed` (meaning "authorization committed for this outbox", not provider success), and inserts the unique outbox row, all in one transaction.
4. Writers of answers, consents, memberships, permissions and principals take the same per-family advisory lock by trigger, so a concurrent refusal or revocation cannot land between the revision check and commit. The SQL bounds are a safety recheck of the Cedar decision, never a replacement for it.
5. `urgent_responder` is refused unless an existing incident for the subject is supplied. The Atlas runtime passes none today, so urgent requests are denied with `incident_required` until incident creation exists (Phase 4). This is deliberate: no emergency path without acceptance evidence.
6. Consent purposes match media: `call_recording` bound to the exact call (global refusals also apply) for `record_audio`, and `voice_share:<recipient>` for `share_data`. Newest row wins, ties resolve to refusal. The only finite validity is `sahaj_private.consent_max_age()` (365 days); it is a stated bound, not evidence of an expiry column.

## Delivery proof (needs Kiro A / Codex)

`outbox.status='completed'` means the dispatch worker finished, never delivery. `observe_delivery` reports `delivered` only when a `raw_events` row exists with `status='processed'`, `source` in twilio/sarvam/telecmi/whatsapp, `event_type='delivery.confirmed'`, and metadata `outbox_id`, `action_request_id`, `action`, `target_id` (the subject person id) and `outcome='delivered'` all matching the outbox. `delivery.not_sent` with `outcome='confirmed_not_sent'` maps to failed. Conflicting proofs stay pending.

Responder acceptance additionally needs an `assignments` row (`status='accepted'`, responder different from the subject, on the outbox incident of the same subject) whose `verified_by_provider_event` is a processed `responder.accepted` event with metadata `outbox_id`, `action_request_id`, `incident_id`, `responder_person_id`.

**ASK CODEX / Kiro A:** provider ingestion currently emits none of `delivery.confirmed`, `delivery.not_sent`, `responder.accepted` and writes none of this metadata. Until ingestion maps verified provider callbacks to these events, every job waits and nothing is reported delivered. Provider account binding (`account_id`) is not checked yet.

## Outbox payload for the dispatch worker

`payload_ciphertext` is AES-256-GCM (`v1.nonce.tag.data`, base64url) over `{"v":1,"action","requestId","eventId"}` with AAD `outbox:<familyId>:<dedupeKey>`, using the same key as raw events (`WEBHOOK_ENCRYPTION_KEY`). It carries ids only, no contact data or text. The worker must resolve the recipient from database rows and recheck current consent/permission immediately before a fresh provider attempt. Never resend `delivery_unknown` without persisted not-sent proof (`reconcile_outbox`). Revocation after commit cannot unsend an accepted provider request.

## Jobs, routing and resume

* Cron routes by `event_type`: `whatsapp.*` and `sarvam.inbound` to `core1.atlas`; `delivery.*`/`responder.accepted` to `core1.proof`; `sarvam.outbound`, `twilio.call_status`, `telecmi.missed_call` to `core1.provider_status`; `twilio.recording.retrieval_requested` to `core1.recording` (left for the recording worker, which must claim by kind). Anything else is dead-lettered with `unknown_event_type` (`dead_letter_raw_event`), never a care action. Proof/status jobs complete without acting; they are facts read by Atlas.
* The runner claims only its own kinds (`claim_workflow_jobs_for_kinds`), renews the lease around every port call, and passes the lease token into every mutating RPC, so an expired worker cannot enqueue, create requests, or append timeline entries.
* An interrupt stores `checkpoint_ref` and `interrupt_ref = <kind>:<sha256(kind+checkpoint)[:32]>` only. `wake_ready_interrupted_jobs` does the CAS (`state='interrupted' AND interrupt_ref=<read value>`) and only when the awaited persisted fact exists: delivery proof for `delivery_pending`, two distinct yes answers or `approved` status for `review_required`. A wake is scheduling only; the graph reloads and rechecks everything. A review pause caused by a missing permission or principal is not woken automatically: the setup path must call `resume_workflow_job` after granting it.
* Failures finish the job `failed` with a safe error code and exponential backoff (existing `finish_workflow_job`); attempts are capped and become `dead`.
* Legacy `core1.ingest` jobs created by the previous cron are not claimed by this runtime.

## Timeline

`createTimelineWriter` signs with Ed25519 and appends through `append_timeline_event` (head CAS, dedupe equality). Before every attempt it looks up the dedupe key; a stored row is signature-verified and returned unchanged, which recovers lost responses without signing a second variant. Event id is derived from the dedupe key. Human lines are fixed strings with no personal data. Required environment (read only in `cron/tick/route.ts`): `DATABASE_URL` (restricted checkpoint role), `TIMELINE_SIGNING_PRIVATE_KEY` (PEM, `\n` allowed), `TIMELINE_KEY_ID`, `WEBHOOK_ENCRYPTION_KEY`. If any is missing the tick still routes events and reports `workflow: not_configured`.

## Media

`authorizeMedia` is now the fixed Cedar `MEDIA_READ_POLICY` in `@sahaj/gate` (`evaluateMediaRead`). The service proves membership, party status, consent history and object expiry from live rows; Cedar re-evaluates reader role/party, consent purpose and subject binding, and object expiry. The service authorizes before stat and again right before signing. A signed URL already issued remains valid for at most 60 seconds after a later revocation. Missing/ask/error facts deny.

## Added outside the stated ownership list

`apps/api/next.config.ts` marks `@cedar-policy/cedar-wasm` as a server external package. Without it `next build` failed while collecting `/api/media/*` (the wasm path was rewritten to a nonexistent location) once media imported `@sahaj/gate`. Review for Vercel tracing.

## Remaining live evidence

Run the SQL test file against a disposable database; run concurrent enqueue (two connections, last quota slot); run a real PostgresSaver job through the cron route with synthetic data; verify provider ingestion emits the proof events above; verify `next start` loads Cedar WASM from the externalized package on Vercel.
