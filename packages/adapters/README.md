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

## Not done

No live calls or messages were made. Real credentials, phone acceptance tests and the Sarvam dashboard setup are outstanding. Twilio call creation requires a server-controlled `allowedWebhookHosts` list so caller payloads cannot substitute arbitrary TwiML. The default Meta media host allowlist contains only `lookaside.fbsbx.com`; configure additional exact hosts only after verifying provider documentation and deployment responses. Authorization grants are server-issued; the backend must bind actual recipient and media/recording resources to its permission decision. Dependencies are declared in `package.json`; installing and locking them is Codex's job.

## Commands

`pnpm --filter @sahaj/adapters test` and `typecheck`.
