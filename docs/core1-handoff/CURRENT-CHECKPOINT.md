# SAHAJ coding checkpoint — 2026-11-15 00:35 IST

Leader `main` is `18ccffe` and contains the joined Core 1 foundation and Core 3. This checkpoint reflects coding and local acceptance only; deployment and real-provider operation are tracked separately.

| Phase | Coding completion | State |
|---|---:|---|
| 1 — foundation/schema/health | 100% | Previously deployed and verified. |
| 2 — provider ingestion/dispatch | 100% | Final code on [PR #3](https://github.com/adityasinghin01-hash/sahaj/pull/3), based on current main. Review/merge pending. |
| 3 — Cedar/Atlas/orchestration | 100% | Final code on [PR #4](https://github.com/adityasinghin01-hash/sahaj/pull/4), based on current main. Merge after Phase 2. |
| 4 — Core 1 care workflows | ~60% draft | Reusable Antigravity work exists, but is not accepted against joined main; Aditya owns completion. |
| 5 — Core 2 server and integrated harness | ~45% draft | Reusable service/route work exists, but default runtime uses fake auth/in-memory state and has no final integrated harness; Aditya owns completion. |

The Phase 4/5 percentages are a review estimate of scoped code coverage, not acceptance. Their measured focused tests are 71 total for Phase 4 and 45 for Phase 5, but they run against mocks/in-memory stores. Exact saved commits and file-level findings are in `ANTIGRAVITY-EXISTING-WORK.md`.

## Phase 2/3 combined evidence

- Combined Phase 2 + Phase 3 API suite: **509 passed, 5 scratch-PostgreSQL tests skipped**; API typecheck passed.
- Atlas suite: **35 passed, 2 PostgreSQL fence tests skipped by default**; Atlas typecheck passed. Both fence cases have separately passed against native PostgreSQL.
- Cedar gate: **39 passed**, typecheck passed.
- Adapter suite: **144 passed**, typecheck passed.
- All 22 migrations in joined Core 1 + Shield order applied to a fresh local PostgreSQL 17.12 database; all 15 distinct rollback acceptance suites passed. This includes contact revocation fencing, capability-filtered claims and real normalized provider-proof reconciliation.
- The joined production build passed after configuring Next to keep Cedar's runtime WASM package intact.

Scratch uses synthetic rows and minimal Auth/Storage interface stubs. Hosted Supabase/PostgREST, hosted migration application, deployed cron/PostgresSaver, live providers and phones remain unverified. Phase 2/3 are 100% coding complete; they are not 100% deployed/live-accepted.

## Order and dependencies

Merge Phase 2 PR #3, then Phase 3 PR #4. Apply the seven new migrations only after both are merged, following `PHASE23-VALIDATION.md`. Do not run the older Phase 4/5 rollback proposals on a hosted database.

Phase 4 should reuse Phase 2's authorized contact registration/revocation RPCs and the durable Phase 3 incident, permission, assignment and provider contracts. Current Phase 2/3 deliberately refuse WhatsApp text without a content composer and Twilio responder calls without an owned, verified AI-disclosure renderer; these are Phase 4 implementation dependencies. Phase 5 owns the integrated Core 1/Core 2 harness; the existing Shield harness remains with Core 3.

## Aditya's existing work to repair

**Phase 4:** preserve the pure scheduling/urgent/voice/medicine/nudge/report domain functions and tests. Fix revoked-membership checks, `raw_events` inserts to use the accepted ingestion RPC/schema, invalid `circle.active` and proof/consent column references, and service-only security-definer mutations with real caller authorization. Add durable workflow/provider integration and cross-check the mobile API mapping. Its saved SQL is not ready to apply.

**Phase 5:** preserve SOS/safe/watch/trusted-contact/truth-line domain code as a draft. Replace acceptance of any nonempty bearer with real Supabase user validation; replace in-memory repository/outbox/events and ephemeral signing keys with durable Postgres-backed contracts; remove permission synthesis when Cedar data is absent; correct non-UUID SQL fixtures; then create and run the actual `harness/core1/**`, `harness/core2/**` and phase 5 acceptance flows against the combined API and database.

Both worktrees start from old staging `4a080e3`, not joined main. Port scoped changes; do not merge old branch histories over main. The review evidence and exact original branch commits are linked in `ANTIGRAVITY-EXISTING-WORK.md`.

## Manual setup before live acceptance

No keys are needed for code review or synthetic local testing. Before an authorized live test, configure secrets in Vercel/Supabase secret stores, never in chat/Git: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, Atlas signing keys/ID, `WEBHOOK_ENCRYPTION_KEY`, `IDENTITY_HASH_SECRET`, matching `CONTACT_ENCRYPTION_KEY`, selected Sarvam/Twilio/WhatsApp credentials and account IDs, public HTTPS webhook hosts/URLs and their verification tokens, `CRON_SECRET`, and the exact consent version. Confirm Meta Graph version explicitly. Keep outbound and recording flags off until contact authorization, consent, provider setup and renderer/content dependencies are reviewed.

No hosted schema changes or real provider calls were made in this checkpoint.
