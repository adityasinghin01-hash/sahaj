# Phase 5 Core 2 Checkpoint (`AGY-P5C2`)

- **Branch:** `p8/agy-p5core2`
- **Base commit (`HEAD`):** `11af38462d799d5c1c69c118c9f8cb0fbf22ec45` (clean working tree outside owned paths; uncommitted per card rules)

## 1. Files Created (Owned Paths Only)

### Database Migration & SQL Tests
- `infra/supabase/migrations/20261114230000_phase5_core2.sql`
- `infra/supabase/tests/phase5_core2.sql`

### Server Core 2 Domain, Security, Adapters & Route Wiring (`@sahaj/api`)
- `apps/api/src/lib/core2/contracts.ts`
- `apps/api/src/lib/core2/security.ts`
- `apps/api/src/lib/core2/http.ts`
- `apps/api/src/lib/core2/service.ts`
- `apps/api/src/lib/core2/supabase.ts`
- `apps/api/src/lib/core2/routes.ts`
- `apps/api/src/lib/core2/index.ts`

### Next.js App Router Endpoints (`apps/api/src/app/api/core2/**`)
- `apps/api/src/app/api/core2/sos/route.ts` (`POST`, `GET`)
- `apps/api/src/app/api/core2/sos/[sosId]/route.ts` (`GET`)
- `apps/api/src/app/api/core2/sos/[sosId]/cancel/route.ts` (`POST`)
- `apps/api/src/app/api/core2/watches/route.ts` (`POST`, `GET`)
- `apps/api/src/app/api/core2/watches/[watchId]/route.ts` (`GET`)
- `apps/api/src/app/api/core2/watches/[watchId]/extend/route.ts` (`POST`)
- `apps/api/src/app/api/core2/watches/[watchId]/cancel/route.ts` (`POST`)
- `apps/api/src/app/api/core2/watches/[watchId]/safe/route.ts` (`POST`)
- `apps/api/src/app/api/core2/trusted-contacts/route.ts` (`POST`, `GET`)
- `apps/api/src/app/api/core2/trusted-contacts/[contactId]/route.ts` (`PATCH`)
- `apps/api/src/app/api/core2/trusted-contacts/[contactId]/approve/route.ts` (`POST`)
- `apps/api/src/app/api/core2/trusted-contacts/[contactId]/revoke/route.ts` (`POST`)
- `apps/api/src/app/api/core2/reassurance/route.ts` (`POST`, `GET`)
- `apps/api/src/app/api/core2/reassurance/preferences/route.ts` (`GET`, `PUT`)

### Tests & Documentation
- `apps/api/tests/core2/harness.ts`
- `apps/api/tests/core2/core2.test.ts`
- `docs/phase5/CORE2-API.md`
- `docs/phase5/CORE2.md`
- `docs/phase5/INTEGRATION-CORE2.md`
- `docs/phase5/CHECKPOINT-CORE2.md`

## 2. Implemented Capabilities

1. **Auth, Isolation & Input Safety**: Bearer authentication, active `family_memberships` resolution (`409` on ambiguous multi-family without `X-Sahaj-Family-Id`, `403` on revoked/non-member), strict size-bounded JSON validation (`400`/`413`/`415`), `Idempotency-Key` SHA-256 request binding (`409 idempotency_conflict` on payload change), encrypted `ingest_raw_event` before `202`/`201` (`503` on ingest failure), no-same-family auto-grant for non-contacts, and `Cache-Control: no-store` / `X-Content-Type-Options: nosniff` / `Referrer-Policy: no-referrer` response headers.
2. **SOS Lifecycle**: Triggering SOS with zero approved `sos` contacts records `pending_contacts` without fabricating alerts; with active contacts, evaluates `@sahaj/gate` (`urgent_responder`), queues `public.outbox` + `core2_dispatch_fences` on `allow` (`status: "queued"`), records `awaiting_approval` on `ask`, records `denied` on `deny`, keeps `responder_accepted: false` and `delivery_status: "none" | "queued"` honest, and supports subject-only cancel/safe (`false_alarm` / `im_safe`) canceling pending dispatches.
3. **Going-Home Watch & Safe-vs-Timeout Monotonicity**: Starts with encrypted route payload and zero outbound alerts; CAS `expected_version` `extend`, `cancel`, `safe`; `core2_tick_due_watches` transitions `active` -> `checking_in` -> `escalated` with `FOR UPDATE SKIP LOCKED`; `core2_resolve_watch_safe` uses transaction advisory lock + CAS to move to `safe`, cancel still-pending outbox items while preserving sent history, and render stale overdue ticks a no-op. Pre-escalation routes remain hidden even from escalation contacts until `escalated`.
4. **Trusted Contacts & Revocation Fencing**: Bilateral invite + contact-only `approve` (requiring non-revoked consent), ranked active contact resolution filtered by `effective_from`/`effective_until`, partial unique index `core2_trusted_contacts_live_unique` (`WHERE state <> 'revoked'`) allowing audit retention + re-invite, and atomic `core2_revoke_trusted_contact` + `core2_claim_fenced_dispatch` fencing pending outbox dispatches.
5. **Reassurance Truth Line**: Default `core2_sharing_preferences` omit location/health/narrative (`false`) while sharing status; read-time re-filtering immediately reflects toggled-off preferences; audio attachment re-verifies `voice_share:<recipient>` consent before queueing dispatch; zero model generation.

## 3. Three Evidence Levels (Verification Honesty)

| Level | Command | Result | What Was Proved / Not Proved |
|---|---|---|---|
| **1. Real PostgreSQL 16 (throwaway `/tmp` cluster)** | `PG_BIN=/opt/homebrew/opt/postgresql@16/bin bash infra/supabase/test/run-integration.sh` | **PASS** (`exit 0`, `RESULT: PASS`) | Applied all 16 migrations cleanly including `20261114230000_phase5_core2.sql`; executed `phase5_core2.sql` + all integration suites (`checkpoint_media_metadata.sql`, `core1_security.sql`, `phase1_independent_qa.sql`, `phase1_security_acceptance.sql`, `signed_timeline.sql`, `shield_rls.sql`, `shield_busy_warnings_rls.sql`, `shield_foundation_bridge.sql`), proving RLS, column-level `authenticated` SELECT, composite FKs, check constraints, contact revocation fencing, and `core2_resolve_watch_safe` / `core2_tick_due_watches` concurrency in real PG 16. Note: `shield_rls.sql` printed `SKIP 6: no supabase_realtime publication in this DB`. |
| **2. Contract, Security & Build Gates (`@sahaj/api` + monorepo)** | `pnpm -F @sahaj/api typecheck && pnpm -F @sahaj/api test && pnpm -F @sahaj/api build`; `pnpm typecheck` | **PASS** (`exit 0`; `19 passed (19)` files, `245 passed (245)` tests; Next 16.4.6 webpack build compiled all 14 `/api/core2/**` routes) | Proved strict request parsing, auth/multi-family/revoked membership, idempotency replay/conflict, pre-`202` raw ingest failure handling, real `@sahaj/gate` Cedar `allow`/`ask`/`deny`, real Ed25519 signing + full `verifyTimelineChain`, real AES-256-GCM encryption, and read/privacy boundaries against in-memory test ports (`tests/core2/harness.ts`). Does not prove live Supabase HTTP roundtrips or runtime `next start` WASM loading without `serverExternalPackages`. |
| **3. Live Providers / External Cloud** | Not executed | **Not tested** | Live Twilio SMS/voice, push notifications, Supabase cloud instance, and `apps/child` UI end-to-end flows were withheld per card rules. |

## 4. Remaining Dependencies Outside AGY-P5C2
- Wire `getCore2Service().tickDueWatches(25)` into `apps/api/src/app/api/cron/tick/route.ts` and `core2_claim_fenced_dispatch` into worker outbox claimers.
- Add `serverExternalPackages: ["@cedar-policy/cedar-wasm"]` in `apps/api/next.config.ts` for production `next start` standalone WASM loading (detailed in `docs/phase5/INTEGRATION-CORE2.md`).
- Wire `apps/child/lib/api.ts` and `apps/child/app/{sos,watch,safe}.tsx` to `/api/core2/**`.
- Reconcile `Core2DispatchPort.enqueueAuthorized` with Kiro Phase 2/3 `dispatch_ledger` / `DispatchAuthorizer` when merging branches.

