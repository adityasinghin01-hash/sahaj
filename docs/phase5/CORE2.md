# Phase 5 Core 2 — Adult Child Safety, SOS, Going-Home Watch & Reassurance

Core 2 server implementation in `@sahaj/api` and PostgreSQL migration `20261114230000_phase5_core2.sql`.

## 1. Architecture & Request Lifecycle

Every `/api/core2/**` route handler delegates to `apps/api/src/lib/core2/service.ts` via `apps/api/src/lib/core2/routes.ts`.
All requests follow this fail-closed sequence before any domain side effect:

1. **Bearer Verification & Active Membership**: `authenticateCore2Actor` validates the Supabase JWT via `supabaseAuth(db).verifyBearer`, queries active memberships (`revoked_at IS NULL`), requires `X-Sahaj-Family-Id` with `409 family_selection_required` if an actor holds multiple active family memberships, and rejects non-members/revoked members with `403`.
2. **Strict Bounded Input & Idempotency**: `readBoundedJson` enforces size limits (`<= 32 KiB`) and strict unknown-field / UUID / integer / IANA-timezone / ISO-timestamp validation (`400`/`413`/`415`). Every write requires an `Idempotency-Key` header (`1..128` printable ASCII chars) and hashes `(method, canonical_route, canonical_body)` with SHA-256 into `core2_idempotency_records`. Replays with identical key+hash return the stored response (`idempotent_replay: true`); reused keys with a changed payload return `409 idempotency_conflict`.
3. **Durable Encrypted Raw Ingest Before `202`**: Mutating triggers persist encrypted payloads (`encryptWebhook` AES-256-GCM with `AUTH_IDENTITY_SECRET` pseudonymization + `AUTH_ENCRYPTION_KEY`) via `ingest_raw_event` before returning `202`/`201`. Storage failures abort with `503`.
4. **Same-Family Isolation**: Membership in `family_id` NEVER automatically authorizes Core 2 SOS/watch/reassurance access to another family member (`child` or `parent`). Non-subject access requires an explicit `active` row in `core2_trusted_contacts` whose `effective_from..effective_until` window covers `now()` and whose `scopes` array includes the required capability.
5. **Cedar Authorization (`@sahaj/gate`) & Fenced Dispatch**: Every outbound dispatch passes through `evaluateGate` (`urgent_responder` for SOS and watch escalations, `check_in` for watch check-ins, and `share_data` / `voice_message` for reassurance) with live DB `setup_permissions`, `consents`, and `action_requests`/`action_approvals`. Only `allow` queues `public.outbox` + `public.core2_dispatch_fences`; `ask` records `awaiting_approval`; `deny` records `denied`. Zero model calls generate facts or claim unverified delivery.
6. **Hash-Chained Ed25519 Timeline**: Every state transition signs an operational summary (`humanLine` free of plaintext notes, routes, numbers, or transcripts) via `signTimelineEvent` and appends through `append_timeline_event`.

## 2. Database Schema & Atomic Concurrency (`20261114230000_phase5_core2.sql`)

| Table | Purpose | Key Invariants |
|---|---|---|
| `core2_trusted_contacts` | Invite, bilateral consent, rank, scopes, validity window, revoke | `CHECK (subject_person_id <> contact_person_id)`; active requires non-null `consent_id` + `approved_at`; partial unique index `core2_trusted_contacts_live_unique` (`WHERE state <> 'revoked'`) permits audit retention + re-invite |
| `core2_watches` | Going-home watch state, ETA/grace deadlines, CAS version | Encrypted `encrypted_route` (`jsonb` ciphertext envelope, never plaintext); indexed partial `next_tick_at` |
| `core2_sos_events` | SOS lifecycle & honest delivery/responder flags | `responder_accepted = true` strictly requires non-null `responder_person_id` & `responder_accepted_at`; `delivery_verified = true` strictly requires non-null `delivery_verified_at` |
| `core2_sharing_preferences` | Per-subject truth-line sharing controls | `share_status_with_parent = true`, `share_location_with_parent = false`, `share_health_with_parent = false`, `share_narrative_with_parent = false` by default |
| `core2_reassurance_updates` | Sanitized reassurance projections + delivery/heard booleans | Safe default exposes only `status_label`; audio reassurance binds `voice_post_id` and re-verifies `voice_share:<recipient>` consent |
| `core2_dispatch_fences` | Maps `outbox.id` to `trusted_contact_id` / `watch_id` | Fenced atomically when contacts revoke or watches resolve `safe` / `cancelled` |
| `core2_idempotency_records` | Tenant + actor scoped request idempotency store | Unique on `(family_id, actor_person_id, action, key_hash)` |

All Core 2 tables enable RLS, revoke write privileges from `authenticated`, grant `SELECT` only on safe projections (`core2_trusted_contacts`, `core2_watches` excluding `encrypted_route`, `core2_sos_events` excluding `encrypted_context`, `core2_sharing_preferences`, `core2_reassurance_updates`), and restrict mutations + `core2_*` RPCs to `service_role`.

### Atomic PostgreSQL RPCs

- **`core2_resolve_watch_safe(p_family_id, p_watch_id, p_actor_person_id, p_expected_version, p_now)`**: Takes transaction advisory lock on watch ID, checks CAS `expected_version` (`state IN ('active','checking_in','escalated')`), transitions watch to `safe`, cancels only still-`pending` `core2_dispatch_fences` + `public.outbox` rows while keeping already-`sent` history intact, and is idempotent if already `safe`.
- **`core2_tick_due_watches(p_now, p_limit)`**: Uses `FOR UPDATE SKIP LOCKED` to move `active` -> `checking_in` when `check_in_at <= p_now < grace_until`, and `active`/`checking_in` -> `escalated` when `grace_until <= p_now`. Terminal watches (`safe`, `cancelled`) have `next_tick_at = NULL` so stale timeouts are guaranteed no-ops.
- **`core2_revoke_trusted_contact(p_family_id, p_contact_id, p_revoked_by_person_id, p_expected_version, p_reason, p_now)`**: Locks contact row, verifies subject-or-contact authorization and `expected_version`, sets `state = 'revoked'`, and atomically fails/fences all pending `outbox` dispatches tied to that contact.
- **`core2_claim_fenced_dispatch(p_outbox_id, p_now)`**: Worker claim fence returning `false` (`fence_blocked`) if the target `trusted_contact_id` is revoked/expired or target `watch_id` is `safe`/`cancelled`.

## 3. State Machines & Domain Flows

1. **SOS**: `POST /api/core2/sos` resolves ordered active `sos` trusted contacts. If none exist, records `status = "pending_contacts"` (never fakes alerts). Otherwise evaluates `@sahaj/gate` (`send_alert`) per contact, queues only `allow` dispatches, and keeps `responder_accepted: false` and `delivery_status: "none" | "queued"` until an actual downstream proof callback occurs. `POST /api/core2/sos/:sosId/cancel` transitions `pending_contacts|queued|awaiting_approval|denied` to `safe` (`im_safe`) or `cancelled` (`false_alarm`) and cancels pending outbox items.
2. **Going-Home Watch**: `POST /api/core2/watches` starts `state = "active"` with encrypted route metadata and **zero** outbound alerts. `extend` increments `check_in_at`, `grace_until`, `next_tick_at`, and CAS `version`. `tickDueWatches` steps `active` -> `checking_in` (notifying the subject via `check_in`) and, after `grace_until`, `escalated` (notifying active `watch_escalation` contacts). Pre-escalation watch routes are hidden even from escalation contacts until `state` reaches `escalated`. `POST /watches/:id/safe` resolves safe monotonically and fences pending escalation outbox items.
3. **Trusted Contacts**: `POST /trusted-contacts` creates an `invited` relationship; only the named contact (`actor.personId === contact.contactPersonId`) can call `POST /approve` (requiring non-revoked consent). Revocation (`POST /revoke`) succeeds for either subject or contact and fences pending dispatches atomically in SQL/service.
4. **Emergency Communication / Reassurance**: Reads and writes apply `core2_sharing_preferences` deterministically. Status updates omit `location`, `health`, and `narrative` fields unless explicitly opted in. Re-checking sharing preferences at read time immediately hides updates from recipients if sharing was turned off. Audio attachments (`voice_post_id`) re-verify `voice_share:<recipient>` consent before queueing dispatch.

## 4. Verification Status Summary

| Layer | What Was Executed | Result | Scope Boundary |
|---|---|---|---|
| Real PostgreSQL 16 (throwaway cluster) | All 16 migrations + `phase5_core2.sql` + existing integration suites | Real PG schema, FK, check constraints, RLS/column grants, advisory-lock safe-vs-timeout race, contact revocation fencing verified | Local throwaway PG via `run-integration.sh` |
| `@sahaj/api` TS + Vitest + Next.js webpack build | Real `@sahaj/gate` Cedar engine, real Ed25519 timeline signatures + `verifyTimelineChain`, real AES-256-GCM payload encryption, all 14 Next routes | Typecheck, unit/contract suite, production webpack build verified | Repository/dispatch DB calls in Vitest use `tests/core2/harness.ts` |
| Live telephony / push / cloud Supabase | Not executed in this card | Unverified | Explicitly withheld per AGY-P5C2 rules |

