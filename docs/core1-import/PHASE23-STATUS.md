# Phase2/3 source integration checkpoint

Phase4/5 owner: Aditya Singh. Start with docs/core1-handoff/START-HERE.md. Kiro owns Phase2/3 and the remaining runtime completion; do not duplicate those workers.

This branch combines the reviewed Phase2 implementation through6774f18 and Phase3 throughc967231, with real provider-dispatch/recording imports into Atlas. Source history is also preserved on singhal/phase23-integration. Lead mobile, Shield, shared and LLM implementation files remain unchanged.

The leader workspace preserves its root LLM exports and adds @sahaj/adapters/communication for Core API imports. This avoids bundling the lead's Node/tsx .js-to-TypeScript LLM module tree into Next's communication routes. Future Phase4 model integration must explicitly resolve the lead LLM runtime boundary; no lead LLM files were rewritten here. Existing ProviderRequest retains its LLM meaning at the root, while the communication subpath exposes its own request type.

Database source remains archived in infra/supabase/core1-import until the canonical Core/Shield schema and migration-runner compatibility is reviewed. Do not activate these files with the current Shield development-stub bootstrap. Native tests below validate Core-only database behavior, not a joined Shield database or Supabase Auth/Storage HTTP APIs.

## Verified evidence

- Combined standalone Core workspace:626 tests, all typechecks and Next production build passed.
- Leader workspace: frozen install/typechecks passed; adapters144, gate39, Atlas35 and Shield649 tests passed,39ShieldDB cases skipped. Both test/** and tests/** adapter directories ran. Core API tests and build are verified separately as the import paths are reconciled; exact final totals are recorded in the release checkpoint.
- All9Core foundation/Phase2/Phase3 migrations applied on isolated PostgreSQL17.12 using minimal Auth/Storage interface stubs.
- Parent reran ALL4final rollback suites: phase2_dispatch_recording, phase3_atomic_orchestration, phase3_bridge, phase3_combined_acceptance:passed.
- Parent reran both real PostgreSQL checkpoint fence tests:2/2passed, including mid-transaction failure and killed lock session. Separate fake-only tests do not substitute for this evidence.
- Kiro also ran7Phase3two-session checks and Phase2claim-race/Gather-replay/first-recording/refusal-during-write checks successfully. Synthetic test rows are confined to the disposable loopback database; append-only fixtures may remain there.
- Native fences are skipped in ordinary unit runs unless explicitly enabled; they were actually exercised separately. Live providers, real phones, unified schema and hosted deployment of this revision are unverified.

## Remaining completion work

KiroA is implementing the encrypted contact registry/resolver and WhatsApp status metadata producer. KiroB is implementing complete provider configuration, contact resolver composition and explicit recording purge scheduling. These are not silently delegated to Phase4. Care feature/domain/model rules, setup permissions/principals and incident/assignment creation belong to Aditya's Phase4; full Core1/Core2 harness belongs to Phase5. External actions remain disabled when configuration/authorization is absent; emergency_ready remainsfalse.
