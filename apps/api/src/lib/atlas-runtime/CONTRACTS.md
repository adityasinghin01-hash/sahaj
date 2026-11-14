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

`outbox.status='completed'` means the dispatch worker finished, never delivery. `observe_delivery` reports `delivered` only when a `raw_events` row exists with `status='processed'`, `source` in twilio/sarvam/telecmi/whatsapp, `event_type='delivery.confirmed'`, and metadata `outbox_id`, `action_request_id`, `action`, and `outcome='delivered'` all matching the outbox (superseded: see "Second pass" for the current exact fields). `delivery.not_sent` with `outcome='confirmed_not_sent'` maps to failed. Conflicting proofs stay pending.

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

## Second pass (review fixes; supersedes earlier statements where they differ)

Migration `20261114210000_phase3_review_fixes.sql`, source only, never executed. Needs scratch-database execution of `infra/supabase/tests/phase3_atomic_orchestration.sql` and `packages/atlas/scripts/phase3-two-session.mjs` (guarded by `SAHAJ_SCRATCH_OK=1`).

* **Lock coverage.** `authz_lock` triggers now fire on INSERT, UPDATE and DELETE for answers, memberships, permissions, principals and consents. UPDATE locks both families (smaller uuid first); DELETE locks `OLD.family_id`. A trigger rejects future-dated consent in every writer.
* **Clock.** `enqueue_authorized_command` and `ensure_action_request` read `clock_timestamp()` only after every blocking acquisition (job row, family lock, request row, permission rows by id). Lease, request expiry, permission windows and consent are rechecked with a fresh reading immediately before the mutation. `consent_current` uses `clock_timestamp()`. Stale lease is errcode `SJ001`; changed snapshot is `40001`; the TypeScript layer maps them to `stale_lease` and `stale_snapshot`.
* **Timeline.** Replay compares family, dedupe key, event type, entity, human line and payload hash after signature verification; sequence/head/timestamp are not compared. Append goes through `append_timeline_event_fenced`, which locks the job row and requires the live lease in the same transaction (`SJ001` otherwise, never retried).
* **Thread and lease execution.** The runner holds a PostgreSQL session advisory lock per Atlas thread on a dedicated pooled connection for the whole run (needs a direct or session-mode `DATABASE_URL`), renews the lease on a timer, and cancels at the next port call once renewal fails. Results of a run that lost its lease or lock are not recorded. All database mutations are separately fenced inside their transactions. Remaining gap: a model call already in flight cannot be aborted mid-request; it is only discarded.
* **Urgent wake.** `workflow_jobs.interrupted_at` is stamped by trigger. An urgent job wakes only on verified acceptance, not-sent proof, a dead outbox, or a relevant `delivery.*`/`responder.accepted` event received after the interrupt. Old delivery proof alone never wakes it.
* **Normalized evidence consumed.**
  * `delivery.confirmed` / `delivery.not_sent`: processed, source twilio/sarvam/telecmi/whatsapp, metadata `outbox_id`, `action_request_id`, `action`, non-empty `dispatch_key`, `outcome`, and `account_id` that is an enabled `provider_identities` binding of the request's target person for that source.
  * `responder.accepted`: referenced by `assignments.verified_by_provider_event`; metadata `outbox_id`, `action_request_id`, `action='urgent_responder'`, `incident_id`, `assignment_id`, `responder_person_id`, `person_id` (both equal the assignment person), `call_id` (a `calls` row of that person with the same provider and a non-null `external_id`), and an `account_id` bound to the responder. The incident must belong to the request's subject and the responder must differ from the subject.
  * **ASK CODEX / Kiro A:** Kiro A's `accept_assignment_verified` currently stores the raw `twilio.gather.accepted` event as `verified_by_provider_event`. Atlas requires the normalized `responder.accepted` event (with the fields above, including `account_id`) there instead. Until a producer emits that, urgent jobs correctly stay unaccepted. The delivery proof also needs `account_id` and `dispatch_key` in metadata, which current ingestion does not write.
* **Routing.** `sarvam.inbound`, `sarvam.outbound`, `telecmi.missed_call` and `whatsapp.*` go to `core1.atlas`. Understanding reads decrypted, identity-bound content: Sarvam `interaction_transcript` / `final_agent_variables` go only to the injected port (never exact-command matching); `review_required=consent_missing`, status-only and missed-call events pause for durable review; with no port, consented transcripts also pause. Only `twilio.call_status` and the proof events remain completed-as-fact. Status-only Sarvam events therefore create review jobs until a dedicated status workflow exists (Phase 4).
* **Configuration (names only; values never read here).** `loadAtlasConfig` requires `WEBHOOK_ENCRYPTION_KEY` (64 hex), `DATABASE_URL` (direct/session, verify-full), `SIGNING_PRIVATE_KEY`, `SIGNING_PUBLIC_KEY`, `SIGNING_KEY_ID`. Keys are Ed25519 as PEM (literal `\n` allowed) or base64 DER (PKCS#8 / SPKI) and must be a matching pair. The earlier `TIMELINE_*` names are gone. The tick reports problem names (for example `SIGNING_PRIVATE_KEY:missing`), never values, and still routes events.
* **Media.** Unchanged: fixed Cedar `MEDIA_READ_POLICY`, consent history and expiry from live rows, authorize before stat and again before signing, URL lifetime at most 60 seconds.
* **`apps/api/next.config.ts`** (externalizes `@cedar-policy/cedar-wasm`) was authorized for this checkpoint. It still needs independent build and Vercel tracing review.

### Phase 4 / cross-lane dependencies (not implemented here)

1. Incident creation: no code creates `incidents` or `assignments`, so `urgent_responder` is refused (`incident_required`). Needs a tested service RPC that creates the incident, offers the assignment and passes `incident_id` to enqueue.
2. Setup: `atlas_principals` rows and `permissions` rows (principal, subject, targets, limits, window) have no creation path. Without them every job pauses for review. A review caused by missing setup is not auto-woken.
3. Model/provider understanding port: none exists. Non-exact input always pauses for review. Targets other than the verified sender are unsupported.
4. Producers for the normalized proof events above.
5. Status-only provider events need their own workflow kind instead of review jobs.
6. Medicine refill needs vendor/item/amount rows on the request; `ensure_action_request` has no path to set them.

## Bridge pass (Phase 2 integration; supersedes earlier statements where they differ)

Migration `20261114213000_phase3_bridge.sql` (source only, never executed; applies after Phase 2's `20261114201600` and my `20261114210000`). SQL check source: `infra/supabase/tests/phase3_bridge.sql`.

* **Atomic binding.** `enqueue_authorized_command` (now 11 arguments, adds `p_assignment_id`; the 10-argument form is dropped) resolves provider, provider action and call need from `sahaj_private.dispatch_route(action)` (check_in -> sarvam.outbound_call with a new `calls` row, urgent_responder -> twilio.create_call with the offered assignment's responder, family_report -> whatsapp.send_text; every other action is refused `no_dispatch_route`). The recipient comes from stored rows (the subject, or the offered responder), and must have an enabled `contact` identity for that provider. After the outbox insert, in the same function, it calls `bind_outbox_dispatch`. Any failure rolls back usage, request consumption, outbox row, call row and binding together. There is no post-commit binding path.
* **Proof contract consumed.** `outbox_proof` and `outbox_acceptance` require `raw_events.normalized_proof` AND a join to the real same-family `dispatch_ledger` and `dispatch_bindings` rows: key, provider reference, provider, call, outbox, request, recipient, `metadata.action` = domain outbox action, `metadata.provider_action` = ledger/binding action, and `metadata.account_id` equal to Phase 2's `dispatch_account(family, person, provider, provider_ref)`. Acceptance additionally requires `person_id` = responder, `subject_person_id` = the incident's person (read from the incident), the Twilio ledger row for that call, and `dispatch_key`. Phase 2's working tree at the time of writing already emits these fields (static test reads it).
* **Shared recording consent.** `record_audio` consent now uses Phase 2's `call_recording_consent` (exact call plus global refusals, newest wins, tie refuses, no age bound). Only `voice_share` keeps `consent_max_age()`. The media service has no age bound by default, so all recording paths now agree.
* **Dispatch worker (tick boundary, `runDispatchTick`).** Claims outbox rows, runs `recheck_dispatch_authorization` (live lease, executed request, active principal and recipient, unrevoked permission, no deny/ask overlap, current consent), builds the command only from the immutable binding, and calls the injected dispatcher. `createDispatchAuthorizer` is the `authorize` dependency of Phase 2's `dispatchOutbound` and re-runs the same SQL recheck on every dispatch. Payloads are built only for `sarvam.outbound_call` (fixed Hindi); twilio and whatsapp need content or a TwiML URL the parent must inject (`payloadFor`), otherwise the row fails `payload_unavailable`. This means `family_report` cannot be dispatched until report content exists (Phase 4).
* **Status and recording jobs.** `whatsapp.status` and `twilio.call_status` route to `core1.provider_status`; `sarvam.outbound` stays on `core1.atlas` (it can carry consented content) and the runner normalizes its status first. Phase 2's `normalizeDeliveryOutcome` runs through `bridge.normalize`; unsupported statuses (a connected call) stay pending. `twilio.recording.retrieval_requested` and `sarvam.recording.retrieval_requested` both route to `core1.recording`; `bridge.recording` maps `stored|already_stored|ignored_additional` to completed, `retry` to a failed job with backoff, `rejected` to completed with the code. Status and recording kinds are claimed only when their entrypoint is injected; otherwise they stay queued and the tick reports `unavailable`.
* **Where Phase 2 is attached.** `atlas-runtime/providers.ts#buildProviderBridge()` returns `{}` on this branch (no Phase 2 source). The parent fills it in using the snippet in that file. The cron tick reports `providers: { dispatch, normalize, recording }` as `ok`/`configured` or `unavailable`.
* **Tests.** `tests/atlas-runtime/merged-path.test.ts` drives the REAL Phase 2 `dispatchOutbound`, `dispatchStore` and `normalizeDeliveryOutcome` (imported read-only from `.worktrees/kiro-phase2`) over an in-memory model of both lanes' SQL. It covers authorize -> binding -> claim -> scripted dispatch -> callback -> normalized proof -> Atlas outcome, forged raw proof, substituted account/action/key/person/call, revoked permission after commit, and non-retry of unknown delivery. The test file depends on the sibling worktree path and must be repointed or replaced after the branches merge. The SQL contracts are checked statically only.

### Remaining evidence (nothing below is verified)
Scratch PostgreSQL run of both migration sets plus `phase3_atomic_orchestration.sql`, `phase3_bridge.sql`, `phase2_dispatch_recording.sql` and the two-session scripts; one real synthetic cron tick with PostgresSaver; merged build after the parent wires `buildProviderBridge`; sandbox provider checks (Twilio media auth, Sarvam recording timing) listed in Phase 2's contract; Phase 4 incident/assignment creation, principal and permission setup, report content and the understanding port.