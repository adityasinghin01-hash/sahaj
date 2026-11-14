# Phase 5 Integration & Cross-Lane Requests

Per task ownership rules, `p8/agy-p5harness` edited only `harness/core1/**`, `harness/core2/**`, `tests/acceptance/phase5/**`, and `docs/phase5/**`. The following cross-lane additions and unblocked seams are requested for integration:

## 1. Root Manifest Wiring Request (Not Edited Here)
- Add a convenience script in root `package.json` once merged:
  ```json
  "test:phase5": "vitest run --config tests/acceptance/phase5/vitest.config.ts",
  "test:phase5:pg": "bash tests/acceptance/phase5/run-postgres.sh"
  ```
- Optional: include `harness/core1`, `harness/core2`, and `tests/acceptance/phase5` in the monorepo CI workflow (disposable local Postgres 16 job running `bash tests/acceptance/phase5/run-postgres.sh`).

## 2. Unblocking Blocked Matrix Rows After Other Lanes Merge
Once the upstream branches merge to `main`, flip the corresponding flags in `tests/acceptance/phase5/runner/types.ts` (`LaneCapabilities`) and wire real imports in the corresponding row tests (`tests/acceptance/phase5/01..10,12,13-*.test.ts`):

| Blocked Lane | Unblocks Matrix Rows | Required Exported Entry Points / SQL |
|---|---|---|
| `kiro-a (phase2-dispatch)` | `01`, `03`, `06`, `07`, `10`, `12` | `bind_outbox_dispatch`, `record_delivery_proof`, `record_responder_acceptance`, `runOutboxDispatchTick`, signed provider gather/status -> outbox reconciliation worker. |
| `kiro-b (phase3-orchestration)` | `01`, `02`, `03`, `04`, `06`, `10`, `12` | Atomic Atlas enqueue / approval consumption / shared revocation lock / `observeDelivery` implementation. |
| `agy-phase4 (core1)` | `02`, `04`, `05`, `06`, `07`, `10`, `13` | `core1_commands` migration + `accept_core1_command` RPC, check-in/urgent/voice/refill/report route handlers & cron processor. |
| `agy3 (core2)` | `02`, `03`, `05`, `08`, `09`, `10`, `13` | Phase 5 Core 2 migration (`core2_sos_events`, `core2_watches`, `core2_trusted_contacts`, `core2_sharing_preferences`, `core2_resolve_watch_safe`, `core2_claim_due_watches`), `/api/core2/**` route handlers, `tickCore2Watches`. |
