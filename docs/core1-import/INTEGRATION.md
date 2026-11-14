# Core1 foundation source import

Verified source release: b1904b2a765c83f9e44b243036fb119f5a5eee1b from the staging project; full history is transferred to this repository on singhal/core1-phase1. Original foundation acceptance:372 tests, all package typechecks/build, hosted rollback security suites, protected health200/no-store with database connected/schema present. That evidence belongs to the standalone foundation, not the combined Shield workspace.

This main-based branch adds apps/api, packages/atlas and packages/gate. Communication adapters are additive: existing src/llm, its exports, dependencies and tests are preserved. Mobile, Shield and shared contracts are unchanged. The leader's pnpm12.18 and hoisted workspace remain; build-script approvals are restricted to the exact esbuild/protobufjs versions already present in the leader lockfile. No global build-security bypass is introduced.

The leader's existing LLM ProviderRequest export keeps its meaning; the communication request type is exported as CommunicationProviderRequest to avoid a name collision. Vitest discovers both test/** and tests/**. Typecheck adds the new communication tests while retaining the leader's existing exclusion of test/**: including that historical directory additionally reveals a missing SpanExporterOption export in the lead-owned LLM index, outside this import's ownership. Reported separately for the lead; no LLM files were changed.

## Database import is deliberately staged

Original Core1 database files are archived under infra/supabase/core1-import using their original bytes. They are NOT copied into the active migrations directory, because the existing Shield migrator automatically loads a development core stub and would execute Shield migrations before Core1's prerequisites. Do not point either migrator at the other schema or run the development stub against the configured Core1 database.

Compatibility decisions required before unified database installation:
- One canonical live membership model: Core1 family_memberships versus Shield family_members; revocations must take effect on both APIs immediately.
- Family/person fields differ (display_name/language/encrypted contacts versus name/aliases/phone and code_word_hash). Never introduce plaintext contact copies merely to satisfy an old contract.
- Establish explicit bootstrap/upgrade order and reconcile Supabase migration history with the Shield schema_migrations ledger. Do not rename already applied files or change their recorded content.
- Review auth/RLS/storage access across both cores and run the combined rollback/security/concurrency suite on a disposable database before hosted changes.

Default API readiness fails closed503 if the required foundation RPC/schema is absent. Liveness remains independent. Emergency readiness remainsfalse. This PR does not certify joined Core1/Shield deployment, live providers or real-phone acceptance. Kiro Phase2/3 and Antigravity Phase4/5 remain separate review branches.

## Import verification

- pnpm install --lockfile-only and pnpm install --frozen-lockfile: passed using pnpm12.18; only exact approved esbuild0.28.2 and protobufjs7.6.6 build scripts ran.
- adapters typecheck/tests: passed,131 tests across BOTH existing test and imported tests directories.
- Atlas typecheck/tests: passed,24 tests. Gate typecheck/tests: passed,39 tests.
- API typecheck/tests/build: passed,237 tests and Next production build.
- Shield typecheck/tests: passed,649 tests;39 database-dependent tests skipped because no disposable joined database was configured. No live database claim is made.
- Total:1080 tests passed,39 skipped. No real provider/phone calls or hosted migration changes performed for this import. The separate pre-existing lead test/** typecheck gap is noted above.
