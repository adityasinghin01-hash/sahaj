# Aditya Singh: Phase 4 and Phase 5 handoff

**Owner: Aditya Singh.** The user's current assignment replaces the earlier Antigravity App/IDE allocation. Kiro owns Phase 2 ingestion/dispatch and Phase 3 orchestration; Aditya owns Phase 4 Core 1 features and Phase 5 Core 2 server plus integrated acceptance. Coordinate integration changes instead of editing another lane.

## Repository and starting point

- Working repository: [adityasinghin01-hash/sahaj](https://github.com/adityasinghin01-hash/sahaj).
- Reviewed foundation integration: [PR #1](https://github.com/adityasinghin01-hash/sahaj/pull/1), branch [chatgpt/core1-foundation](https://github.com/adityasinghin01-hash/sahaj/tree/chatgpt/core1-foundation). Start from its latest reviewed commit, or main after that PR is merged. Record the actual base SHA.
- Standalone source history: [singhal/core1-phase1](https://github.com/adityasinghin01-hash/sahaj/tree/singhal/core1-phase1).
- Kiro review lanes: [singhal/phase2-ingestion](https://github.com/adityasinghin01-hash/sahaj/tree/singhal/phase2-ingestion), [singhal/phase3-orchestration](https://github.com/adityasinghin01-hash/sahaj/tree/singhal/phase3-orchestration). These are implementation/review inputs, not proof of accepted deployment. If a branch is unavailable, request its pushed checkpoint; do not reconstruct its interfaces from memory.

Use two separate worktrees if developing both phases concurrently:

```powershell
git fetch origin
git worktree add ../sahaj-phase4 -b chatgpt/phase4-core1 origin/chatgpt/core1-foundation
git worktree add ../sahaj-phase5 -b chatgpt/phase5-core2-harness origin/chatgpt/core1-foundation
```

`origin` here means the leader repository above; check `git remote -v` first. These are portable relative folder examples, not required local machine paths. Follow root AGENTS.md: small commits, PRs into main, no direct main push or force push.

## Read before implementing

1. [Build Bible v3](https://docs.google.com/document/d/1BLnuLwtsqdb57FK8aJDedC7EQmv_5y3s7LFq_gxt1OQ/edit).
2. [Work Division FINAL](https://docs.google.com/document/d/1lQlNRLSDyCcyDxqW1_S8qhPdgDYbyFYq-QojqqD0Zm4/edit).
3. [Ready Kit v2](https://docs.google.com/document/d/1EFDIoc6Wl3Cf-LZ1OypADot2t-gxFwMpNG-RnsF4t5Q/edit).
4. [Shield specification](https://docs.google.com/document/d/19OKzKD_osNWfFlFzyYXJ7PuTn-v9AnGEXvBQB0dAbFU/edit), for boundaries only; Shield implementation remains the lead's lane.
5. Repository AGENTS.md, `docs/core1-import/INTEGRATION.md`, actual Atlas/gate/adapter contracts, `apps/child/lib/api.ts`, and Kiro's provider-dispatch/atlas-runtime CONTRACTS.md files on the review branches.

Report inaccessible documents and unresolved contracts. Do not silently invent requirements, model IDs, provider facts or schema fields.

## Ownership and safe integration

| Owner | Editable scope |
|---|---|
| Kiro Phase 2 | Existing provider-ingestion/dispatch/recording workers and associated Phase 2 migrations/tests/contracts |
| Kiro Phase 3 | Existing Atlas runtime repositories/workers, Cedar/atomic authorization, checkpoint/lease integration and associated Phase 3 migrations/tests/contracts |
| Aditya Phase 4 | `packages/atlas/src/core1/**`, `packages/atlas/test/core1/**`, `apps/api/src/lib/core1/**`, `apps/api/src/app/api/core1/**`, `apps/api/tests/core1/**`, `infra/supabase/migrations/20261114220000_phase4_core1.sql`, `infra/supabase/tests/phase4_core1.sql`, `docs/phase4/**` |
| Aditya Phase 5 | `apps/api/src/lib/core2/**`, `apps/api/src/app/api/core2/**`, `apps/api/tests/core2/**`, `infra/supabase/migrations/20261114230000_phase5_core2.sql`, `infra/supabase/tests/phase5_core2.sql`, `harness/core1/**`, `harness/core2/**`, `tests/acceptance/phase5/**`, `docs/phase5/**` |
| Lead/mobile owners | `packages/shield/**`, `packages/shield-kotlin/**`, `harness/shield/**`, `apps/parent/**`, `apps/child/**`, `apps/shield-api/**`, `packages/adapters/src/llm/**`, existing Shield migrations |

Do not change existing `packages/shared` contracts/exports without both coders' agreement. Root/package manifests, lockfile, existing cron routes and cross-lane wiring require an explicit integration patch request. Put exact requested changes in each phase's `INTEGRATION.md`; do not create duplicate workers or incompatible replacement endpoints. Proposed migration filenames reserve ownership only: activation depends on the combined schema plan below.

## Database warning: staged source is not a joined schema

The imported Core migrations are archived under `infra/supabase/core1-import`, outside active migrations. Shield migrations and its migrator currently depend on development stub contracts: `family_members`, `people.name/aliases/phone`, `families.code_word_hash`. Core uses `family_memberships`, `display_name` and protected contacts. Shield timestamps also precede Core prerequisites, and the migration ledgers differ.

Do not run the Shield development stub on the verified Core database, copy all archived SQL into active migrations, rename applied migrations or introduce plaintext contact copies. Parent/lead must review a canonical membership model, revocation-aware compatibility, bootstrap/upgrade ordering and disposable combined database tests before hosted application. A source PR may be ready while combined database deployment remains blocked. Keep new phase migrations under review until that activation plan is accepted.

## Evidence and progress

The standalone Phase 1 acceptance recorded 372 tests plus build/typechecks, database security suites and protected readiness. The source-import report records 1,080 passing tests and 39 skipped database tests; these are historical checkpoint-specific results, not Phase 4/5 completion. Re-run against your final commits and report skipped checks separately.

For each checkpoint save: base/commit SHA, files changed, completed behavior, exact test commands/results, database tests actually executed, integration/deployment state and remaining dependencies. Never label a mocked port implementation, queued request or skipped live test as verified end-to-end behavior. **Phase 5 final acceptance waits for reviewed Phase 2, 3 and 4 integration; independent code and harness design can start now.**

Continue with [Phase 4](PHASE4-CORE1.md) and [Phase 5](PHASE5-CORE2-HARNESS.md).
