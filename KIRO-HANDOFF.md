# Kiro — Core 1 communication adapters

Work directory: `D:\Projects\SAHAJ\.worktrees\core1-adapters`
Branch: `feature/core1-adapters` (already created).

Exclusive edit ownership: `packages/adapters/**`. Codex owns the backend in the parent directory. A Codex worker prepared uncommitted drafts in this worktree and has stopped all writes. Review and finish those drafts; they are not tested or integrated.

Do not edit root manifests, lockfiles, `packages/shared`, `apps/api`, mobile apps or Shield. Ask Codex to install/lock dependencies. Do not merge branches or push to main. Commit only your reviewed adapter files and report SHA/tests to the user.

## Contracts to agree before backend integration

Keep contracts in `packages/adapters/src/contracts.ts` for now. Export an injectable fetch transport, provider request/result, structured redacted errors and action authorization binding action/person/idempotency key. Use a durable dispatcher claim before external actions. A network timeout after dispatch is delivery-unknown: do not blindly retry calls or messages. Provider status callbacks reconcile it.

## Deliverables, in order

1. WhatsApp raw-byte HMAC-SHA256 verification; Twilio official form signature verification using configured public URL; signed WhatsApp buttons binding action/object/person/sender/expiry/nonce. Document atomic nonce consumption as a backend requirement.
2. Sarvam instant outbound call, recording retrieval and distinct inbound/outbound webhook parsers. Outbound callbacks must match a stored attempt_id/app_id; inbound must match configured deployment/app/agent number and a registered caller. Unknown identities fail closed.
3. WhatsApp send text/buttons/audio and media retrieval with bounded sizes/timeouts and safe URL validation; Twilio real recorded-voice relay helpers with Hindi speech+DTMF and explicit recording consent.
4. TeleCMI missed-call validation and pull reconciliation; distinguish provider variants with fixtures. Secret URL authentication is handled by the backend; it does not replace account and call crosschecks.
5. Audio chunk plan <=28 seconds, conversion interface and injectable mock providers. AI always identifies itself as AI; real family recordings are played only with consent.
6. Synthetic no-network unit/contract tests for tampering, expiry, wrong sender, unknown IDs, malformed payloads, timeout/delivery-unknown and provider failures. No real keys, phone numbers, health records or recording files in Git/logs.

## Authoritative documents

- Build Bible: https://docs.google.com/document/d/1BLnuLwtsqdb57FK8aJDedC7EQmv_5y3s7LFq_gxt1OQ/edit
- Work Division: https://docs.google.com/document/d/1lQlNRLSDyCcyDxqW1_S8qhPdgDYbyFYq-QojqqD0Zm4/edit
- Ready Kit: https://docs.google.com/document/d/1EFDIoc6Wl3Cf-LZ1OypADot2t-gxFwMpNG-RnsF4t5Q/edit

Verify current official provider docs before implementation:
- https://docs.sarvam.ai/voice-agents/api/instant-outbound/create
- https://docs.sarvam.ai/voice-agents/api/instant-outbound/webhook-payload
- https://docs.sarvam.ai/voice-agents/api/deployments/webhooks/webhook-payload
- https://doc.telecmi.com/chub/docs/incoming-missed/
- https://www.twilio.com/docs/usage/security
- https://developers.facebook.com/docs/graph-api/webhooks/getting-started

The foundation currently refuses webhook processing until durable storage/crosschecks exist. Do not return fake success or claim live phone tests passed. Tests are not complete until verified; report missing credentials/phone acceptance separately.
