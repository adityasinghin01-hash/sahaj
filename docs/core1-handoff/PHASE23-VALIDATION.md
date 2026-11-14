# Phase 2/3 final coding checkpoint — 2026-11-15

Both PRs target the leader's joined `main` (`18ccffe`, Core 1 foundation plus Core 3). Phase 2 PR #3 is `chatgpt/phase2-final`. Phase 3 uses `chatgpt/phase3-final`; merge Phase 2 first, then Phase 3. Apply migrations only after both are merged.

## Verified

- Phase 2 branch: API typecheck and Next production build passed; API tests **436 passed / 5 skipped** (scratch PostgreSQL tests); adapter typecheck and tests **144 passed**.
- Phase 3 branch: API typecheck passed; API tests **301 passed / 9 skipped** (integrated Phase 2 cases are skipped on the standalone Phase 3 PR); Atlas **35 passed / 2 native PostgreSQL fence tests separately passed**; Cedar gate **39 passed**. Atlas and gate typechecks passed.
- Joined native PostgreSQL 17.12 database: all **22 ordered Core 1 + Shield migrations** applied and **15 distinct rollback SQL acceptance suites** passed. The joined Core security fixture now rejects generic caller supplied delivery evidence and demonstrates positive reconciliation only through the verified provider proof functions. Both Phase 3's dispatch acceptance test and Phase 2's contact fence remain enabled together.
- The first joined Next build exposed a missing Cedar WASM artifact. `apps/api/next.config.ts` now externalizes the Cedar WASM package; rebuild is being rerun before this PR is ready.

Local PostgreSQL was fresh and disposable, with minimal Auth/Storage interface stubs and synthetic rows. This does not test hosted Supabase PostgREST, real provider networks, real phones, or the hosted migration runner. No hosted migration was applied.

## Migration order

After the leader's existing Core 1 and Shield migrations through `20261114160900_shield_heartbeat.sql`, apply:

1. `20261114201500_phase3_atomic_orchestration.sql`
2. `20261114201600_phase2_dispatch_recording.sql`
3. `20261114210000_phase3_review_fixes.sql`
4. `20261114213000_phase3_bridge.sql`
5. `20261114214500_phase2_contact_registry.sql`
6. `20261114220000_phase2_contact_fence.sql`
7. `20261115000000_phase3_capability_claims.sql`

Use migration tooling against the intended hosted project only after review of both merged PRs and the complete joined order.

## Manual setup needed for live acceptance

No API key is needed for local tests or review. Before live provider tests, an authorized operator must configure, in the secret manager (never Git/chat):

- `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, Atlas signing key pair and `SIGNING_KEY_ID`;
- `WEBHOOK_ENCRYPTION_KEY`, `IDENTITY_HASH_SECRET`, and matching `CONTACT_ENCRYPTION_KEY`;
- chosen provider credentials/account IDs: `SARVAM_API_KEY`, `SARVAM_ORG_ID`, `SARVAM_WORKSPACE_ID`, `SARVAM_APP_ID`, `SARVAM_APP_VERSION`, `SARVAM_CONNECTION_ID`; Twilio account SID/auth token/from number; WhatsApp access token/phone-number ID/explicit Graph API version;
- public HTTPS webhook hosts/URLs, provider webhook verification secrets/tokens, cron secret and consent-version settings;
- explicit provider and recording enable flags only after corresponding principals, permissions, consent and trusted contact identities exist.

Twilio responder calls remain unavailable until Phase 4 provides and tests the owned disclosure renderer. WhatsApp text remains unavailable until Phase 4 supplies a reviewed content composer. No keys were requested in chat and none are committed.

## Phase 4/5 existing work

See `ANTIGRAVITY-EXISTING-WORK.md` in this handoff for the saved Antigravity branch commits, independently rerun focused tests, concrete defects and reuse guidance. Aditya owns both phases; do not start duplicate agents. Phase 5 owns the integrated Core 1/Core 2 harness. The existing Shield harness remains with Core 3.
