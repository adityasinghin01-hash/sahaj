# Existing Antigravity Phase 4/5 work: handoff to Aditya Singh

Reviewed 2026-11-15. **Aditya Singh / the leader now owns Phase 4 and Phase 5.** No new worker was launched and no Phase 4/5 implementation was edited. Existing work is reusable draft material, not accepted production integration. Do not duplicate it blindly or apply its migrations remotely.

## Saved branches and contents

Both worktrees were clean at review time and remain separate from the reviewed foundation/Phase 2/3 integration.

| Lane | Saved commits | Portable remote source |
|---|---|---|
| Phase 4 Core 1 | `20770d0` domain; `158e772` SQL; `0f83239` commands/API; tip `82e3ff1` checkpoint | [singhal/phase4-core1](https://github.com/adityasinghin01-hash/sahaj/tree/singhal/phase4-core1), also tracked as feature/phase4-core1 |
| Phase 5 Core 2 | `999805c` SQL; `d7b8944` service/adapters/routes; `880e44d` unit/route tests; `28e6703` acceptance/docs; `7bec3a9` checkpoint; tip `618fc1a` | [singhal/phase5-core2](https://github.com/adityasinghin01-hash/sahaj/tree/singhal/phase5-core2), also tracked as feature/phase5-core2 |

Remote branch containment was observed in local fetched refs, not reverified with a new network request. Both lanes started from staging base `4a080e3`, not current joined leader main. Preserve lead mobile/Shield/shared/LLM files during any port.

Phase 4 contains pure scheduling, urgent-responder, two-way voice, medicine, missed-call and report functions under `packages/atlas/src/core1/**`, seven command route resources under `/api/core1/**`, injected repository/auth ports, a Supabase adapter, tests and one SQL migration/rollback suite. Its docs are `docs/phase4/CHECKPOINT.md` and `INTEGRATION.md`.

Phase 5 contains SOS, safe reassurance, watch, trusted-contact, acceptance and truth-line services; routes under `/api/core2/**`; proposed SQL tables/RPCs; in-memory repository/outbox/event/timeline adapters; unit/route tests and `tests/acceptance/phase5/combined-backend-scenarios.test.ts`. Its docs include CHECKPOINT, INTEGRATION, MAPPINGS and a destructive rollback proposal. **It does not supply the final integrated `harness/core1/**` / `harness/core2/**`.** Existing Shield harness remains lead-owned.

## Tests actually evidenced in this review

No dependencies installed, environment files read, providers contacted or database migrations executed.

| Worktree command | Independently observed result |
|---|---|
| Phase 4: `pnpm.cmd --filter @sahaj/api exec vitest run tests/core1` | 7 files, **33 passed** |
| Phase 4: `pnpm.cmd --filter @sahaj/atlas exec vitest run test/core1` | 6 files, **38 passed** |
| Phase 5: `pnpm.cmd --filter @sahaj/api exec vitest run tests/core2` | 7 files, **30 passed** |
| Phase 5: `node ./apps/api/node_modules/vitest/vitest.mjs run --dir tests/acceptance/phase5` | 1 file, **15 passed** |

These are domain/mocked/in-memory checks. The Phase 5 acceptance file constructs `createInMemoryCore2Repository` and scripted ports; it does not demonstrate real PostgreSQL transactions, actual Phase 2/3 workers or two-process durability. Its green scenario names must not be reported as full combined acceptance.

Worker-authored historical claims: Phase 4 reports full workspace 443 tests, typechecks and API production build; Phase 5 reports API 267 tests and typecheck. Those wider checks were **not rerun in this review**. Neither checkpoint provides executed real SQL/concurrency/phone evidence sufficient for acceptance. Both workers reported inaccessible authoritative Google Docs; Aditya should read the linked authoritative documents in `docs/core1-handoff/START-HERE.md` before treating feature assumptions as agreed requirements.

## Concrete Phase 4 blockers to fix before reuse

1. **Revoked membership accepted.** `apps/api/src/lib/core1/repository.ts:37–64` selects membership without `revoked_at` filtering or returning that field, using a service-role client. A revoked membership can still become a command actor. The SQL helper at migration lines 5–17 also omits revocation.
2. **Production ingestion does not match the real schema.** Repository lines 166–180 insert `familyId` rather than `family_id` and `status='queued'`; raw_events accepts pending/processing/processed/failed/dead. Use the existing `ingest_raw_event` RPC and accepted normalized command contract instead of direct insertion. Preserve scoped replay/conflict semantics under concurrent requests, not only lookup-before-insert.
3. **Invented columns break runtime SQL.** Repository circle query and SQL use `circle.active`, which is absent in the saved foundation. Acceptance SQL function reads top-level `raw_events.normalized_proof` / `verified_by`; those fields are not foundation columns. Voice SQL reads `consents.revoked_at`, but consents are append-only and revocation is a newer refusal. Reconcile against actual accepted Phase 2/3 schema/contracts rather than adding authority booleans just to satisfy code.
4. **Unsafe security-definer mutation RPCs.** Phase 4 migration lines 347–350 grant direct authenticated execution. The public mutation functions do not establish caller membership/Cedar authorization; the helper is not used. There are no corresponding explicit PUBLIC revokes or fixed search_path. Keep mutation entry service-only and enforce the accepted authorization/lease protocol; do not activate this migration as written.
5. **Evidence and workflow seams remain draft.** Reuse Kiro's exact normalized proof bindings and incident/request/outbox/call/account associations; do not infer responder acceptance from processed status or missing/nullable metadata. Integrate structured check-in understanding, schedule/retry workers, consented audio and redacted reports through the real runtime. Pure domain flags such as AI disclosure or cloning prohibition are not proof that provider execution follows them.

The pure functions and test cases are useful starting material. Review report fallback content and every same-family subject/recipient authorization before exposing reports; regex phone/number masking is not a complete privacy policy.

## Concrete Phase 5 blockers to fix before reuse

1. **Fake default authentication.** `apps/api/src/lib/core2/runtime.ts:29,45` accepts any nonempty bearer as `synthetic-auth-user`. Production must call Supabase getUser, load actual live membership and reject missing runtime dependencies. Test overrides must not install a synthetic singleton for subsequent production requests.
2. **Manufactured Cedar permission.** `gate-adapter.ts:45–69` synthesizes a 30-day, 1,000-use permission and active actor when no real permission was loaded. Remove this bypass; use current server-authoritative principal/permissions/consent/approval facts and Kiro's atomic authorization commit. No setup permission may be invented by a safety adapter.
3. **No durable default repository/outbox/event/timeline.** `repository.ts` is explicitly in-memory. `outbox-adapter.ts:14–25` uses Set/array dedupe; `event-store-adapter.ts:25–34` generates an ephemeral encryption key and keeps a plaintext Map unless an optional persistence callback exists; timeline uses a newly generated signing key and Map stream heads. Defaults do not persist to the database and cannot survive restart. Replace with the accepted durable adapters; absence must return unavailable rather than successful queued/durable claims.
4. **SQL suite has invalid UUID fixtures.** `infra/supabase/tests/phase5_core2.sql` uses `p200...` people IDs and `tc000...` contact IDs, which cannot be PostgreSQL UUIDs. Its claimed tenant/monotonic assertions cannot pass as written; correct and execute on a disposable accepted schema before claiming DB evidence.
5. **Combined acceptance and application wiring remain unfinished.** Existing acceptance tests are in-memory; no actual two-process checkpoint restart, cross-transaction safe/timeout race or integrated no-double-dispatch proof is shown. Cron, real trusted-contact/consent writers, normalized provider acceptance and mobile API mapping still need accepted integration. Do not follow the old integration doc's instruction to apply hosted SQL or forward a webhook directly to an acceptance endpoint without current verified normalized-proof contracts.

`docs/phase5/ROLLBACK.sql` drops tables with CASCADE; it is a proposal, not permission to run destructive SQL against a hosted/shared database.

## Aditya's reuse steps

1. Fetch the leader repository; start separate review branches from its **current accepted main/foundation**, recording SHA. Inspect these saved branches read-only. Do not merge their staging histories wholesale over main.
2. Read the detailed current handoff at `docs/core1-handoff/START-HERE.md`, PHASE4-CORE1 and PHASE5-CORE2-HARNESS. The user's Aditya ownership supersedes older Antigravity allocation text in these draft checkpoints.
3. Port useful scoped domain/test code in small commits, correct the blockers above, and adapt to accepted Phase 2/3 contracts. Request any cross-lane integration changes instead of editing Kiro/lead files. Do not copy mock adapters into production defaults.
4. Keep Core migrations staged until the combined Shield/Core membership, privacy and migration-order plan is reviewed. Never run the Shield dev stub on the verified Core database or add plaintext contacts to make the drafts appear compatible.
5. Re-run focused and workspace checks on the actual combined branch. Execute corrected rollback SQL and genuine DB/process/concurrency harness scenarios; record exact results, skipped dependencies and deployment status. Do not infer completion from the independently passing fixture counts above.

**Disposition:** preserve both branches as reusable drafts; neither is approved for blind integration or deployment. Aditya owns repairs/completion. Codex/Kiro continue only the separately assigned Phase 2/3 work and integration review; no duplicate Phase 4/5 agents are needed.
