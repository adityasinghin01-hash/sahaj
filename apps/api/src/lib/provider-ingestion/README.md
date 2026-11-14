# Provider webhook gateway (Sarvam, TeleCMI, Twilio)

Routes: `POST /api/sarvam/post-call/[secret]` (outbound and inbound), `POST /api/missed-call/[secret]`,
`POST /api/twilio/status`, `POST /api/twilio/recording`. Each route acknowledges with HTTP 200 only after
`ingest_raw_event` committed. 200 means "queued for processing". It never means a call was delivered,
heard, accepted, or that a recording was retrieved.

## Trust model

| Provider | Authentication | Identity cross-check |
| --- | --- | --- |
| Sarvam (unsigned) | URL secret, timing-safe, wrong => 404 | Configured app id and agent number. Outbound: server-stored `attempt` binding for that app. Inbound: configured deployment id and a registered `contact`. |
| TeleCMI (unsigned) | URL secret, timing-safe, wrong => 404 | Configured appid and virtual number, and a registered `contact` caller. |
| Twilio | `X-Twilio-Signature` (HMAC-SHA1) over the configured public URL plus raw form parameters | Configured AccountSid, and a `calls` row with `provider='twilio'` and `external_id=CallSid`. Recording events also need `ai_disclosed_at` and an effective `call_recording` consent (below). |

IDs alone never prove the sender. Unknown identity => 403 with no write.

## Environment (server only)

`SARVAM_HOOK_SECRET`, `SARVAM_APP_ID`, `SARVAM_AGENT_NUMBER`, `SARVAM_DEPLOYMENT_ID` (inbound only),
`MISSEDCALL_HOOK_SECRET`, `TELECMI_APP_ID`, `TELECMI_VIRTUAL_NUMBER`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_STATUS_CALLBACK_URL`, `TWILIO_RECORDING_CALLBACK_URL` (exact public https URLs registered with Twilio), `CALL_CONSENT_VERSION` (required `consents.version`; unset means no consent is ever effective),
plus existing `WEBHOOK_ENCRYPTION_KEY`, `IDENTITY_HASH_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
These names are new and are not yet in `apps/api/.env.example` (not owned by this lane).

## Data contract with the rest of the system

`provider_identities` rows (hash = `identityHash(source, account_id, id, IDENTITY_HASH_SECRET)`):

- Sarvam outbound attempt: `source='sarvam'`, `account_id=<app id>`, `binding_kind='attempt'`, `attempt_id=<attempt id>`, `agent_id=<app id>`, `external_id_hash=hash(attempt id)`. **Whoever creates the Sarvam call must write this row (family and person) before or atomically with dispatch.** No such writer exists in this lane.
- Caller contact: `binding_kind='contact'`, `account_id` = Sarvam app id or TeleCMI appid (string), id = phone digits only (no `+`).

`raw_events` written (`source`, `provider_event_id`, `event_type`, metadata `{person_id, status}`):

| source | event id | types |
| --- | --- | --- |
| sarvam | `<app>:outbound:<attempt>:<status>`, `<deployment>:inbound:<interaction>` | `sarvam.outbound`, `sarvam.inbound` |
| telecmi | `<appid>:missed:<cmiuuid>` | `telecmi.missed_call` |
| twilio | `<AccountSid>:call:<CallSid>:<status>:<seq>`, `<AccountSid>:recording:<RecordingSid>:<status>` | `twilio.call_status`, `twilio.recording.status`, `twilio.recording.retrieval_requested` |

The encrypted payload holds IDs, enums and counters only. Transcripts, phone numbers, failure text and
recording URLs are dropped at parse time. A retrieval worker must rebuild the Twilio media URL from
`account_sid` and `recording_sid` and must re-check consent at fetch time.

Same event id and identical payload is accepted unchanged. Same id with a different payload returns 409.

## Consent rules

`consents` is append-only; the newest matching row decides. For a call, per purpose (`call_recording`, `call_transcript`):
only rows with the same family, person and purpose count. The newest row with this exact `call_id` must be `answer=true` on
`CALL_CONSENT_VERSION`. The newest call-independent refusal (`call_id` null, `answer=false`) at or after that time overrides it; call-independent affirmations are ignored and never restore consent. The storage query for global rows selects refusals only
(ties go to refusal); a later call-specific yes overrides an earlier global refusal. Rows for other calls are ignored, so a
yes on another call never revives a revoked consent here. The `calls` row must belong to the same family and person as the
verified identity.

- Twilio recording callbacks: no effective `call_recording` consent, or no `ai_disclosed_at`, means 403 and no write. Otherwise the event carries `call_id` and `consent_id` in the encrypted payload and in ID-only metadata. The retrieval worker must re-check consent at fetch time.
- Sarvam post-call: `interaction_transcript` and `final_agent_variables` (the field names in Sarvam's webhook payloads) are kept in the encrypted payload only when an effective `call_transcript` consent exists for the `calls` row (`provider='sarvam'`, `external_id` = attempt id for outbound, interaction id for inbound). Otherwise they are dropped, the payload gets `review_required: consent_missing`, and metadata gets `review: consent_missing`. A provider retry after consent changes then conflicts (409) by design.
- `person_id` is part of the hashed and encrypted payload of every event, so replaying an event after identity reassignment conflicts.

## Writers that do not exist yet (dependencies)

1. Sarvam dispatch: write the `provider_identities` attempt binding with the attempt id.
2. `calls` rows: `provider` and `external_id` set to the Twilio CallSid, Sarvam attempt id (outbound) or interaction id (inbound), with `ai_disclosed_at` once disclosed. Inbound Sarvam calls have no row until something creates one.
3. Consent capture: append `consents` rows with `purpose` `call_recording` / `call_transcript`, the exact `call_id`, and the `version` that `CALL_CONSENT_VERSION` names. The purpose names are this lane's proposal; no migration defines them.

## Limits

Sarvam 512 KiB, Twilio 64 KiB (and 100 parameters), TeleCMI 16 KiB. Checked by `Content-Length` and while streaming.

## Not verified

Provider field names come from the adapters branch contracts and Twilio's documented callback parameters.
Live provider documentation could not be fetched in this session. Re-check before connecting real providers.
