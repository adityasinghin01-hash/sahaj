# @sahaj/adapters

Provider adapters for Sarvam, Twilio, WhatsApp Cloud API and TeleCMI. No network calls happen at import time; every call goes through an injected `FetchTransport`. Tests use synthetic data and scripted transports only.

## Contracts (`src/contracts.ts`)

- `ProviderRequest` carries `personId`, `idempotencyKey` and an `ActionAuthorization` issued by the server's permission gate. Adapters check that action, person, key, consent and expiry all match before any call.
- `DispatchLedger` is implemented by the backend. `claim()` must be atomic and durable and runs before the provider is contacted. A second claim for the same key throws `duplicate_dispatch`.
- A timeout, network error, 5xx, or a 2xx without the expected id after dispatch is `delivery_unknown`. The ledger is marked unknown and the call is never retried. Provider status callbacks (Twilio, WhatsApp statuses, Sarvam outbound webhook) reconcile it.
- 4xx responses are `provider_rejected` (ledger `failed`, nothing was delivered).
- Read-only calls (recording/media download, TeleCMI pull) fail with `provider_unavailable` and may be retried.
- `AdapterError` carries only a code, provider and HTTP status. No bodies, numbers or credentials.

## Backend requirements

1. **Nonce consumption.** `verifyWhatsAppButton` checks the MAC and expiry only. The backend must consume the returned nonce atomically (unique-key insert, zero rows means replay) before acting. Pass `personId`, `from`, `action`, `objectId` from your own records, never from the button.
2. **Raw bytes.** Pass the unparsed request body to `parseWhatsAppWebhook`. Twilio callbacks must use the configured public URL, not the request's Host header.
3. **Stored identities.** Sarvam sends no signature. Store `attempt_id` + `app_id` when the call is created and pass them to `parseSarvamOutboundWebhook`. For inbound, pass the configured deployment and a caller resolver. Unknown identities throw `unknown_identity`.
4. **TeleCMI.** The secret URL is not enough. `parseTeleCmiMissedWebhook` also checks `appid`, virtual number and a registered caller. Webhook CDRs (`cmiuuid`, `appid`, `virtual_number`) and pull records (`cmiuid`, `to`, no `appid`) are different variants.
5. **Retention.** Transcripts and agent variables from Sarvam are dropped by the parsers. Recordings are returned as bytes for the caller to store under its own retention rules.

## Authorization actions

`sarvam.outbound_call`, `sarvam.recording.read`, `whatsapp.send_text`, `whatsapp.send_buttons`, `whatsapp.send_audio`, `whatsapp.media.read`, `twilio.create_call`.

## Voice rules

AI calls and synthetic speech always start with the AI disclosure (`AI_DISCLOSURE`). Real family recordings play only with `RecordingConsent` matching person and recording. The caller's reply is recorded only after a "yes" (digit 1 or spoken yes).

## Provider facts used

Verified against provider docs on 2026-11 (see links in `KIRO-HANDOFF.md`): Sarvam create-outbound, outbound and inbound webhook payloads, analytics recording endpoint; Twilio request signing (HMAC-SHA1, sorted params); Meta `X-Hub-Signature-256`; TeleCMI missed-call webhook and `/v2/missed` pull. Not verified: the WhatsApp media download host list (`DEFAULT_MEDIA_HOSTS`) and the current Graph API version (`graphVersion` is required config). Sarvam's `failure_reason` and TeleCMI auth failure (HTTP 404) follow the docs as written.

## Provider facts checked against official docs (2026-11-14, public pages fetched)

- **Twilio recording media** (twilio.com/docs/voice/api/recording): `GET https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Recordings/{Sid}.wav` (or `.mp3`); omitting the extension or using `.wav` returns binary WAV with MIME type `audio/x-wav`. The media is only available when the recording is `completed` and stored at Twilio; otherwise the request returns Not Found. HTTP Basic auth is required for media URLs and the page names an API key SID and secret. `RecordingStatus` is `in-progress`, `completed` or `absent`. Used by `fetchTwilioRecording`.
- **Twilio Gather** (twiml/gather): digits are posted to the `action` URL as `Digits`; `finishOnKey` defaults to `#`; the caller can do nothing and the request then carries no digits.
- **Twilio signatures** (usage/webhooks/webhooks-security): HMAC-SHA1 over the full URL plus sorted parameters, keyed by the auth token, sent as `X-Twilio-Signature`; Twilio may add parameters without notice. The verifier signs the configured exact URL.
- **Sarvam analytics** (docs.sarvam.ai/voice-agents/api/analytics): base `https://apps.sarvam.ai/api/analytics/v1/{org_id}/{workspace_id}/{app_id}`, header `X-API-Key`. Get recording `GET .../recordings/{interaction_id}` (`YYYYMMDD/id`, slash literal or `%2F`) returns `audio/wav`; 404 if the interaction has no recording. List attempts `GET .../attempts` requires `start_datetime` and `end_datetime`, takes `limit` 1-1000, `offset`, `sort_by`, `sort_order`; the official example items carry `attempt_id` and `interaction_id`, and also the user's unmasked contact (never read or kept). Used by `getSarvamRecording` and `verifySarvamAttemptInteraction`.

## Still unconfirmed (do not rely on)

1. Whether Twilio ever redirects a `.wav` media request. The page does not say; the shared HTTP helper treats any 3xx as `provider_rejected`, so it fails closed.
2. Twilio media auth with AccountSid and AuthToken. The page documents an API key pair; `fetchTwilioRecording` currently sends AccountSid:AuthToken.
3. Sarvam: how soon after the post-call webhook a recording exists, that List attempts returns every attempt in a window (paging is capped at 5 pages of 200), and that the unsigned webhook's `interaction_id` field is the same value List attempts reports (the worker only trusts the pair after Sarvam confirms it).
4. Meta media host: Meta does not document the media `url` host, so `fetchWhatsAppMedia` has NO default allowlist and requires explicit `allowedHosts` from deployment configuration.
5. WhatsApp Graph version string and the `statuses` webhook shape: supplied by deployment config, no route in this lane.
6. `twilio.gather.response` and `responder.accepted` are internal contract names, not provider names.
## Not done

No live calls or messages were made. Real credentials, phone acceptance tests and the Sarvam dashboard setup are outstanding. Twilio call creation requires a server-controlled `allowedWebhookHosts` list so caller payloads cannot substitute arbitrary TwiML. The default Meta media host allowlist contains only `lookaside.fbsbx.com`; configure additional exact hosts only after verifying provider documentation and deployment responses. Authorization grants are server-issued; the backend must bind actual recipient and media/recording resources to its permission decision. Dependencies are declared in `package.json`; installing and locking them is Codex's job.

## Commands

`pnpm --filter @sahaj/adapters test` and `typecheck`.
