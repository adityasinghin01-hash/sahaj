# Atlas runtime contracts

This document describes the joined Core 1 runtime and its Phase 2 provider bridge. It replaces the historical worker handoff notes. All 22 ordered Core 1 + Shield migrations and 15 distinct rollback SQL acceptance suites passed on local native PostgreSQL 17.12 with minimal Supabase interface stubs. This does not establish that migrations are applied to hosted Supabase or that production provider credentials and real-phone flows are verified. Consult the integration evidence for exact commands and test counts.

## Principal, subject and authorization

The AI actor is a server-owned `public.atlas_principals` row, distinct from human family members. `permissions.principal_id`, `permissions.person_id` and `target_ids` bind its authority. Deterministic commands use the verified sender as subject and target. The decrypted event's `person_id` must agree with durable metadata. Missing principal or uncertain understanding pauses for review.

`load_gate_snapshot` returns immutable request details, permissions, human approvals, consents, deny/ask precedence and an authorization revision. The application reconstructs the `GateRequest`, checks its stored fingerprint and evaluates Cedar. SQL is the authoritative transaction recheck:

1. `ensure_action_request` creates the job-bound request idempotently under the live workflow lease.
2. `enqueue_authorized_command` has 11 parameters, including optional `p_incident_id` and `p_assignment_id`. It recovers an existing matching outbox row before reserving usage again. Otherwise it locks the job, family authorization state, request and permissions, checks the revision and current clock, then reserves usage, consumes the request, inserts the outbox, creates a scheduled call when needed and binds dispatch in one transaction.
3. Answers, consents, memberships, permissions and principals take the same family authorization lock on insertion, update and deletion. Future-dated consent is rejected.
4. `recheck_dispatch_authorization` provides a fast preflight check. The `dispatch_ledger` insertion trigger repeats authorization atomically with Phase 2's claim under that family lock: current request expiry, principal/person activity, permission identity and scope, validity and usage window, deny/ask precedence, current approvals, consent and offered assignment. Usage already reserved at enqueue is not charged again.

Permission scope includes principal, subject, action, target, vendor, items and amount. A narrowed or reassigned permission refuses the queued send. `SJ001` means stale workflow lease; `40001` means a changed authorization snapshot or timeline head contention, according to the RPC.

Supported dispatch routes are `check_in -> sarvam.outbound_call`, `urgent_responder -> twilio.create_call`, and `family_report -> whatsapp.send_text`. Other actions fail closed until their routes exist. Urgent enqueue requires an existing incident for the subject and an offered, unexpired assignment for a different responder. The generic Atlas port does not create these records.

## Provider composition and contact identity

`buildProviderBridge(phase2, db, config, options)` composes Phase 2's real dispatch, normalization, recording and purge entrypoints. The main integration seam must export `dispatchStore`, `runOutboxDispatchTick`, `runStatusNormalizationJob`, `createContactResolver`, `recordingStore`, `recordingStorage`, `runRecordingJob`, `purgeStore` and `runRecordingPurgeTick`. An absent entrypoint never fabricates success.

`createContactResolver(db, { encryptionKeyHex, identitySecret, accounts })` returns a callable resolver with a required `resolveIdentity(familyId, personId, provider)` method. That method returns `{ e164, identityId, accountId, identityHash }` or null. Preserve the method when passing the resolver into Phase 2. The claim binds the exact registry identity, rather than merely proving that some contact exists for the person. Registration and resolution use the same `CONTACT_ENCRYPTION_KEY`, versioned contact AAD and `IDENTITY_HASH_SECRET`.

Numbers remain outside graph state, outbox payloads, model prompts, tick output and logs. Outbox ciphertext contains only `{ v: 1, action, requestId, eventId }`, encrypted with `WEBHOOK_ENCRYPTION_KEY` and AAD `outbox:<familyId>:<dedupeKey>`. Recipient, call and provider operation come from immutable stored bindings.

## Capability-filtered claims

`claim_outbox_for_capabilities(worker, capabilities, limit, lease_seconds)` claims only rows whose binding provider action and outbox care action match an available capability. `withCapabilityClaims` replaces only Phase 2 store's `claimOutbox`; other methods remain intact. Ineligible rows retain their attempts, status, retry and lease. Expired processing leases still become `delivery_unknown`; uncertain delivery is never resent without durable not-sent evidence.

Capabilities are:

- `sarvam.outbound_call:check_in`: valid, explicitly enabled Sarvam configuration.
- `twilio.create_call:urgent_responder`: valid Twilio configuration and an injected owned responder renderer.
- `whatsapp.send_text:family_report`: valid WhatsApp configuration and an injected text composer.

Without any capability there is no dispatch tick. Enabling one provider does not consume another provider's queued attempts.

## Twilio renderer

Twilio dispatch requires code to inject `TwilioResponderRenderer { provenance, url, gatherActionUrl, render() }`. An environment URL alone is insufficient. Validation checks provenance shape, HTTPS allowlisted URLs, the Hindi AI disclosure in a Say before Gather, and a one-digit DTMF Gather posting to the configured action. Only this path sets `aiDisclosureAttested=true`.

The route owner must serve exactly `render()` at `url` and prove that relationship with an integration test. The Gather route separately verifies Twilio signatures and resolves the offered responder from stored records. Until the owned renderer is injected, Twilio rows remain pending.

## Normalized proof and responder acceptance

Raw callbacks remain distinct from proof. Only Phase 2 proof writers create `raw_events.normalized_proof=true`. Phase 3 joins normalized evidence to the actual same-family dispatch ledger, immutable binding, call, request and provider account.

Delivery proof metadata includes `outbox_id`, `action_request_id`, `action` (care action), `provider_action`, `dispatch_key`, `provider_ref`, `person_id`, `account_id`, `source_event_id` and `outcome`. `delivery.confirmed` uses outcome `delivered`; `delivery.not_sent` uses `confirmed_not_sent`. A completed outbox means the dispatch attempt finished, not that a person heard a message. Connected/completed calls are not delivery evidence. Contradictory or insufficient proof remains unresolved.

`responder.accepted` binds the exact incident, assignment, responder, subject, call, outbox, action request, dispatch key and account. Its `person_id` and `responder_person_id` identify the responder; `subject_person_id` identifies the person needing assistance. `assignments.verified_by_provider_event` references this normalized proof. For urgent actions `observe_delivery` accepts that evidence directly, returning the graph's delivered observation with `responderAccepted=true`; a separate fabricated call-delivery proof is never required. Enqueue alone never establishes acceptance.

## Jobs and recordings

Cron routes WhatsApp messages, Sarvam inbound/outbound and TeleCMI missed-call input to Atlas. WhatsApp statuses and Twilio call statuses go to status normalization. Sarvam outbound status is normalized before its consented content is understood. Normalized proof jobs are durable facts. Unknown event types are explicitly dead-lettered.

Recording events use `core1.recording.twilio` and `core1.recording.sarvam`. Each kind is claimed only when that provider's retrieval handler exists. Legacy `core1.recording` jobs require both providers. Handler selection checks event source/type against the job kind. A Sarvam-only setup needs no Twilio credentials. Missing capability leaves work queued instead of consuming attempts.

`record_audio` reads the table-valued Phase 2 `call_recording_consent` result `(id, granted_at)`. Exact-call grants, global refusals, refusal precedence on ties, required version checks and the shared finite consent policy govern recording collection and access. Recipient-specific sharing uses `voice_share:<recipient>`. `CALL_CONSENT_VERSION` and `consent_max_age()` must remain consistent across ingestion, recording, media and SQL.

Purge runs after dispatch only when `RECORDING_PURGE_ENABLED=true`. The bridge invokes `runRecordingPurgeTick({ store: purgeStore(db), storage: recordingStorage(db), enabled: true, limit })`. Phase 2 owns the fixed private bucket, exact family/call path checks, retention/consent eligibility and metadata compare-and-set. Tick output contains counts or availability/error codes, never paths or contact data.

## Durable execution and signed timeline

The runner holds a workflow lease, renews it by heartbeat and uses a `CheckpointFence` per Atlas thread. Every PostgresSaver statement uses the same dedicated session as the advisory lock. Pool checkouts are serialized from connect through release, so concurrent put/putWrites transactions cannot overlap; standalone pool queries use the same queue. Abandoned transactions roll back before the next checkout. Lease or lock loss aborts graph execution, rejects queued checkouts and refuses subsequent statements. COMMIT verifies advisory-lock ownership. Use a direct or session-mode checkpoint connection with verified TLS.

Interrupts persist checkpoint and opaque interrupt references. Resume reloads authority and proof from the database. Wakes require relevant normalized evidence; existing delivery evidence alone does not repeatedly wake an urgent job still awaiting acceptance. Missing setup or uncertain understanding requires a deliberate review/setup resume path. Failed work uses bounded retries and safe error codes.

Timeline entries are Ed25519 signed and appended through `append_timeline_event_fenced`, which checks the live job lease in the same transaction as append. Replay verifies signature, family, dedupe key, type, entity, human text and payload hash; generated sequence/head/time remain those of the first write. Human lines are fixed and contain no personal content.

## Configuration

See `apps/api/.env.example` for names. Atlas requires `DATABASE_URL`, `WEBHOOK_ENCRYPTION_KEY`, `SIGNING_PRIVATE_KEY`, `SIGNING_PUBLIC_KEY` and `SIGNING_KEY_ID`. Signing keys must be a matching Ed25519 pair, represented as PEM or base64 DER. The checkpoint connection requires verified TLS and session semantics.

Outbound side effects require `PROVIDER_DISPATCH_ENABLED=true`, a provider's own exact enable flag, all validated provider settings, contact crypto and its content/renderer capability. Callback URLs use `PROVIDER_WEBHOOK_HOSTS`. WhatsApp Graph API version is explicit. Recording retrieval has a master flag and independent `TWILIO_RECORDING_RETRIEVAL` / `SARVAM_RECORDING_RETRIEVAL` flags. Purge is independent, with a limit of 1 through 100. Configuration problems are reported by variable name only.

Cedar's filesystem WASM loader is externalized in `apps/api/next.config.ts`. Production artifact tracing and runtime loading require deployment verification.

## Evidence and remaining dependencies

The joined 22 SQL acceptance checks passed on local native PostgreSQL. This supersedes the earlier statements that SQL had never run. Focused unit, saver concurrency and merged-path test files accompany the implementation; use current integration evidence for exact results. Scratch-only tests require explicit disposable-database configuration. Local acceptance does not imply hosted migration application or provider acceptance.

Remaining work includes hosted deployment verification, a synthetic deployed cron flow with PostgresSaver, real provider/phone acceptance, the owned Twilio renderer, report text composition, structured Hindi understanding, authenticated setup and review paths, and Core 1 incident/assignment and medicine workflows. The runtime exposes integration ports for these features; it does not make them complete merely by supplying the ports.
