# Integration contract audit (read-only)

Scope: root `D:/Projects/SAHAJ` (webhooks `7ec4889`, media `990938a`, adapters, `20261114130240_core1_security_workflows.sql`,
`20261114141830_checkpoint_media_metadata.sql`, `infra/supabase/tests/*.sql`). Nothing was run against a database or provider.
The four provider test files pass at root (53 tests). SQL was read, not executed, so the SQL claims below are from the source text.

"Bug" means the code does the wrong thing today. "Missing" means a feature is absent and the system fails closed.

## Bugs

### B1. Media consent history can drop a newer refusal (fails open)
`apps/api/src/lib/media/supabase.ts` `listConsentHistory` selects the person's `call_recording` rows ordered newest first with
`limit(200)`, across all calls. `apps/api/src/lib/media/service.ts` `callRecording` passes that to `consentIsCurrent` / `latestConsent`
(`consent.ts`). The linked consent comes from `getConsent`, so it is always present. A global refusal (`call_id` null, `answer=false`)
that is newer than the linked yes but older than the 200 newest rows of any call is not loaded. `latestConsent` then sees only the
yes and `callRecording` signs a URL. This needs about 200 later recording-consent rows for the same person (one per call, so roughly
200 calls), so it appears over time rather than immediately.
Smallest fix, in media files: replace the single query with the two queries in `provider-ingestion/store.ts` `findConsents`
(exact `call_id` rows, plus global rows filtered `answer=false`, each ordered and limited). `latestConsent` already ignores global yes rows.

### B2. WhatsApp envelope does not bind the person
`apps/api/src/lib/event-store.ts` `ingest` hashes and encrypts `event.payload` (`{account, event}`) with no `person_id`. Replaying the same
event after a registered contact is reassigned to another person in the same family is accepted under the old person. The webhook gateway
fixed this in `provider-ingestion/store.ts` (`envelope = { person_id, ...payload }`). Smallest fix: the same one-line envelope change in
`eventStore().ingest`, plus a store test.

### B3. `supabase/README.md` hash statement is not true for any route
`infra/supabase/README.md` (ingestion paragraph) says the hash is SHA-256 over the verified original request bytes. Both `event-store.ts`
and `provider-ingestion/store.ts` hash the JSON of a redacted, allowlisted payload, because storing the original bytes would keep transcripts,
phone numbers and recording URLs. The parent should change the README to "SHA-256 over the canonical stored envelope" and keep the redaction.
`ingest_raw_event` only compares the hash string, so SQL is unaffected.

## Missing features that block end-to-end (all currently fail closed)

### M1. No writer for `sahaj_private.call_content`, so recording retrieval cannot link to consent
`sahaj_private` is not exposed to PostgREST. Only the read RPCs `get_voice_media_metadata` and `get_call_media_metadata` exist.
A retrieval worker with `supabase-js` cannot insert `call_content` (`family_id, call_id, consent_id not null, recording_object_path, expires_at not null`,
primary key `(family_id, call_id)`, foreign keys to `calls` and `consents`).
Smallest parent implementation: a service-only security-definer RPC
`put_call_recording(p_family_id, p_call_id, p_consent_id, p_object_path, p_expires_at)`. It should check that the consent row is
`purpose='call_recording'`, same family, same person as `calls.person_id`, and `call_id = p_call_id`. It must also re-check there is no
newer refusal, using the same rule as `effectiveConsent`. The worker takes `call_id`, `consent_id` and `recording_sid` from
`raw_events.metadata` and the decrypted payload of the `twilio.recording.retrieval_requested` event.
Note the primary key allows one recording per call. Twilio can send several `RecordingSid` values per call, so the RPC needs an explicit
rule (reject, or keep the first) instead of failing on a duplicate key.

### M2. Nothing consumes my event types; the cron route flattens them
`apps/api/src/app/api/cron/tick/route.ts` dispatches every claimed event with `p_workflow_kind: 'core1.ingest'` and `p_thread_id: event.id`.
`dispatch_raw_event` then marks the raw event `processed` once the job row exists. So `processed` means "durably queued", not "handled",
and no worker maps these types to behavior:
`sarvam.outbound`, `sarvam.inbound`, `telecmi.missed_call`, `twilio.call_status`, `twilio.recording.status`, `twilio.recording.retrieval_requested`.
`workflow_jobs` carries only `raw_event_id`, so metadata (`person_id`, `status`, `call_id`, `consent_id`, `review`) is not copied; the worker must
read `raw_events` by `raw_event_id`. That works (service role has all grants and `claim_raw_events` returns full rows). The decrypt
context is `source:provider_event_id` (`encryptWebhook` call in both stores), so the worker needs only the row. No `decryptWebhook` caller exists yet.
Smallest fix: in the tick route pick `workflow_kind` from `event_type` (a fixed map, unknown type means `finish_raw_event` with a code, not dispatch).

### M3. Outbox reconciliation cannot be fed by provider callbacks
`reconcile_outbox` requires a `processed` same-family raw event with `event_type` `delivery.confirmed` or `delivery.not_sent`,
`metadata.outbox_id` and `metadata.outcome`. My routes write `twilio.call_status` and `sarvam.outbound` and know no `outbox_id`.
`public.outbox` has no provider reference column (only `dedupe_key` and encrypted `payload_ciphertext`), so a CallSid or attempt id cannot be mapped to an outbox row in SQL.
Smallest parent implementation: add `outbox.provider_ref text` (unique per provider) written by the dispatcher when the provider returns the id,
then a worker that reads a terminal `twilio.call_status` or `sarvam.outbound` event, looks up the outbox row by `provider_ref`, and ingests a separate
evidence event (`delivery.confirmed` / `delivery.not_sent`, metadata `{outbox_id, outcome}`, id such as `delivery:<outbox_id>:<outcome>`).
Mapping caution: a Twilio `completed` or Sarvam `connected` means a call connected. It is not proof a person was reached or heard a message,
so it should not by itself set `delivered` for care messages. `no-answer`, `busy`, `failed`, `canceled` fit `confirmed_not_sent`.

### M4. Nothing updates `calls` from events
No code moves `calls.status`, `started_at`, `ended_at` from Twilio or Sarvam events, so calls stay `scheduled`. Same worker as M2.
`calls` rows are readable by children and parents under RLS and are in the Realtime publication, including `external_id` (CallSid, attempt id)
and `ai_disclosed_at`. If those identifiers should stay private, give clients a column-limited view; this is a design decision, not a defect.

### M5. No Twilio Gather/DTMF acceptance route, and no Sarvam recording retrieval request
`twilio/voice/test` is still 501 and there is no callback for TwiML `Gather`. `assignments.accepted` needs `verified_by_provider_event`
(a `raw_events.id`), so responder acceptance has no ingestion path from a phone call yet. Sarvam recordings (adapter `getSarvamRecording`, by
`app_id` and `interaction_id`) have no retrieval-request event either; only the interaction id is kept in the outbound payload. Both stay out of
this lane until parents ask for them.

## Contracts checked and consistent

- **`provider_identities`:** `unique(source, account_id, external_id_hash, binding_kind)`; hash is `identityHash(source, account, id)` = HMAC-SHA256 of
  `JSON.stringify([source, account, id])` with `IDENTITY_HASH_SECRET` (`webhook-security.ts`). Same function in `event-store.ts` and my store.
  Conventions: WhatsApp `source='whatsapp'`, `account_id=phone_number_id`, id = sender digits as Meta sends them. Sarvam contact `account_id=app_id`.
  TeleCMI contact `account_id=String(appid)`. Sarvam attempt: `binding_kind='attempt'`, `account_id=agent_id=app_id`, `attempt_id`, hash of attempt id.
  Because `source` differs, one person needs a separate contact row per provider. The table has no check that an `attempt` row sets `attempt_id` and `agent_id`;
  my lookup requires both, so a malformed row just never matches (fail closed).
- **`ingest_raw_event`:** conflicts on family, hash or event type with SQLSTATE 23505; `raw_events.family_id` is not null. Metadata is not compared on
  replay, which is fine because every metadata ID/enum that matters is also inside the hashed envelope (`call_id`, `consent_id`, `review_required`, `person_id`).
  `p_metadata` is any JSON object with no DB allowlist; the allowlist is enforced only in application code.
- **Consent semantics:** gateway `effectiveConsent` and media `latestConsent` agree on call-specific rows, global refusals only, ties go to refusal.
  The gateway is stricter: it also requires `CALL_CONSENT_VERSION` and AI disclosure. Media only requires a non-empty version, so a consent on an old
  version stays readable there after the gateway stopped queuing new ones. That direction is safe; align it if old versions should expire.
- **Call/consent linkage for recordings:** the retrieval event carries `call_id` and `consent_id` in encrypted payload and metadata.
  `get_call_media_metadata` returns `consent_id` from `call_content`, and `callRecording` re-validates it against call and history. Linkage works once M1 exists.
- **Env:** `.env.example` already lists every variable the gateway reads, including `CALL_CONSENT_VERSION`.

## Suggested order

1. B1 (small, safety). 2. M1 and M2 (needed before any recording or workflow behavior). 3. B2 and B3. 4. M3 and M4 with the dispatcher. M5 later.
