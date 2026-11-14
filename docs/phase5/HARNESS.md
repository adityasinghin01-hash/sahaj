# Phase 5 Integrated Acceptance Harness (`Core 1 + Core 2`)

## Purpose & Scope

This harness verifies the integrated **Core 1** (`check-ins`, `urgent responder`, `two-way voice`, `medicine refills`, `nudges/reports`) and **Core 2** (`SOS`, `going-home watch`, `"I'm safe"`, `trusted contacts`, `reassurance/truth line`, `bounded reads`) durability, security, concurrency, and provider-boundary contracts against synthetic fixtures and disposable local PostgreSQL 16 clusters.

- **Ownership boundary:** Core 3 Shield continues to own [`harness/shield/`](../../harness/shield/run.ts), which this harness never modifies or interferes with.
- **No live sends / zero real secrets:** All phone numbers use synthetic `+919000000001..+919000000999` test fixtures. Never point this harness at hosted Supabase, `~/.sahaj-lab`, `~/dev/sahaj-secrets`, or port `3100`.

---

## Layout

| Path | Responsibility |
|---|---|
| `harness/core1/` | Synthetic Core 1 family/vendor fixtures (`fixtures.ts`), `core1_commands` hash/resolver contracts (`contracts.ts`), and in-memory `ProviderStore` test adapter (`providers.ts`). |
| `harness/core2/` | Synthetic Core 2 watch/contact/preference fixtures (`fixtures.ts`) and Safe-vs-Timeout, trusted-contact, and read-time redaction contracts (`contracts.ts`). |
| `tests/acceptance/phase5/runner/types.ts` | Port interfaces (`ClockPort`, `IdentityPort`, `CallbackSignerPort`, `ScriptedTransportPort`, `CrashController`, `ConcurrencyPort`, `LaneCapabilities`) and matrix result schema. |
| `tests/acceptance/phase5/runner/ports.ts` | Deterministic injectable implementations (`ControlledClock`, `SyntheticIdentityPort`, `RealCallbackSigner`, `ScriptedTransport`, `ControlledCrashPort`, `BarrierConcurrency`). |
| `tests/acceptance/phase5/runner/pg-harness.ts` | Disposable local Postgres 16 helper (`PHASE5_TEST_DATABASE_URL` loopback guard, synthetic family seed/cleanup, `SET LOCAL ROLE authenticated` RLS executor). |
| `tests/acceptance/phase5/runner/two-process-worker.ts` | Child OS worker for real multi-process crash/resume tests against `@sahaj/atlas` `PostgresSaver` + `claim_workflow_jobs` / `finish_workflow_job`. |
| `tests/acceptance/phase5/runner/reporter.ts` | Summary formatter reporting exact `passed / failed / blocked / skipped` scenario counts separately across `unit/contract`, `disposable_integrated`, and `live` (never percentages). |
| `tests/acceptance/phase5/01..14-*.test.ts` | One Vitest suite per acceptance matrix row (`01` through `14`). |
| `tests/acceptance/phase5/run-postgres.sh` | Spawns an ephemeral local Postgres 16 cluster under `/tmp/p5h-pg.*`, applies `bootstrap.sql` and all `infra/supabase/migrations/*.sql`, runs all 14 suites, and tears down `/tmp` on `EXIT`. |
| `tests/acceptance/phase5/run.ts` | Emits the structured matrix summary across all three evidence levels. |

---

## Evidence Levels

Every matrix run keeps three evidence levels strictly separated:

1. **`unit/contract`**: Pure in-process contract checks using injectable ports (`ControlledClock`, `RealCallbackSigner`, `ScriptedTransport`, `@sahaj/gate` `evaluateGate`, `@sahaj/api` timeline signer & provider parsers).
2. **`disposable_integrated`**: Real local PostgreSQL 16 + RLS + RPCs (`ingest_raw_event`, `append_timeline_event`, `claim_workflow_jobs`, `finish_workflow_job`, `claim_outbox`, `finish_outbox`, `reconcile_outbox`) + real two-process `@sahaj/atlas` `PostgresSaver` recovery. Requires `PHASE5_TEST_DATABASE_URL` pointing to a throwaway loopback cluster (`127.0.0.1` / `localhost`).
3. **`live`**: Staging/live external provider checks — intentionally skipped (`skipped: live execution forbidden unless approved`).

---

## Commands

Run strict TypeScript check on the Phase 5 harness and tests:
```bash
./node_modules/.bin/tsc --noEmit -p tests/acceptance/phase5/tsconfig.json
```

Run unit/contract suites without booting Postgres:
```bash
./node_modules/.bin/vitest run --config tests/acceptance/phase5/vitest.config.ts
```

Run the full disposable Postgres 16 integrated suite + two-process crash/resume proof:
```bash
bash tests/acceptance/phase5/run-postgres.sh
```
