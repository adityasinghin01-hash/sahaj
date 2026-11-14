# Phase 1 Independent QA Evidence Report & Acceptance Audit

**Date**: 2026-11-14  
**Author**: Antigravity App — Phase 1 Independent QA Worker  
**Worktree**: `D:/Projects/SAHAJ/.worktrees/antigravity-phase1-qa`  
**Branch**: `feature/phase1-qa`  
**Audited Baseline Commit**: `8133cf034dceebc8eb87787ad21704ee13f1db1d`  
**Sibling Implementation Worktree (Read-Only)**: `D:/Projects/SAHAJ/.worktrees/antigravity-foundation` (`feature/phase1-closure`)  
**Sibling Commit & Status**: `26aa605994dca284ca0416f97b505b437ab3e3d8` (with working tree fixes)

---

## 1. Executive Summary

This independent quality assurance audit and adversarial test suite was conducted in strict adherence to `coordination/ANTIGRAVITY-APP-PHASE1.md`, `PHASE1-REVIEW.md`, `PHASE1-ACCEPTANCE-AUDIT.md`, and `PHASE1-LIVE-EVIDENCE.md`.

- **Scope of Ownership**: Strictly limited to newly created QA artifacts:
  - `apps/api/tests/foundation-qa/**`
  - `infra/supabase/tests/phase1_independent_qa.sql`
  - `docs/phase1-qa/**`
- **Zero Modifications Outside Scope**: No existing application code, existing tests, migrations, manifests, lockfiles, mobile/Shield, or sibling worktrees were modified. No merges or deployments were executed.
- **Audited Baseline**: Initial QA worktree baseline is `8133cf0`. As anticipated by instructions, this baseline trails the sibling IDE fixes.
- **QA Adversarial Results against Baseline `8133cf0`**:
  - **Total Tests**: 30
  - **Passed**: 12
  - **Failed**: 18 (Exact verification of the missing capabilities/defects documented in `PHASE1-REVIEW.md`)
- **Sibling IDE Audit (Read-Only)**: Sibling implementation at `26aa605` plus unstaged working copy fixes in `antigravity-foundation` was thoroughly audited. The sibling successfully addresses all 18 defect scenarios. Minor edge-case observations have been documented for Codex coordination.

---

## 2. Independent Adversarial QA Suites (`apps/api/tests/foundation-qa/**`)

Three dedicated adversarial test suites were implemented to rigorously stress foundation health, readiness, security boundaries, and concurrency handling:

### 2.1 `schema-rpc.adversarial.test.ts` (13 tests: 3 passed, 10 failed against `8133cf0`)
1. **`evaluateReadiness` schemaOk requirement**:
   - `MUST return HTTP 503 degraded when probe.status is connected but schemaOk is false`: **FAILED** on `8133cf0` (received 200 ready).
   - `MUST return HTTP 503 degraded when probe.status is connected but schemaOk is undefined`: **FAILED** on `8133cf0` (received 200 ready).
   - `returns HTTP 200 ready ONLY when ok === true, status === 'connected', AND schemaOk === true`: **PASSED**.
   - `returns HTTP 503 degraded when probeDatabase returns missing_schema`: **PASSED**.
2. **`probeRealDatabase` service-only `foundation_readiness` RPC contract**:
   - `calls service-only public.foundation_readiness RPC and succeeds with exact valid contract`: **FAILED** on `8133cf0` (`8133cf0` queried `families` table directly instead of calling RPC).
   - `accepts valid contract returned as stringified JSON`: **FAILED** on `8133cf0`.
   - `adversarial: rejects RPC response with schema_ready = false as missing_schema`: **FAILED** on `8133cf0`.
   - `adversarial: rejects RPC response with obsolete schema_version as missing_schema`: **FAILED** on `8133cf0`.
   - `adversarial: rejects RPC response with wrong database status field`: **FAILED** on `8133cf0`.
   - `adversarial: rejects malformed unparseable JSON string from RPC`: **FAILED** on `8133cf0`.
   - `adversarial: rejects primitive or null payloads from RPC`: **FAILED** on `8133cf0`.
   - `adversarial: detects missing RPC (PostgreSQL 42883 or PGRST202) as missing_schema`: **FAILED** on `8133cf0`.
   - `detects connection failures (ECONNREFUSED / fetch failed) as unreachable`: **PASSED**.

### 2.2 `concurrency-timeout-cancellation.adversarial.test.ts` (7 tests: 1 passed, 6 failed against `8133cf0`)
1. **Hanging dependency bounded deadline**:
   - `MUST independently time out when dependency hangs indefinitely and never settles`: **FAILED** on `8133cf0` (`8133cf0` lacked an independent timer around probe; hung until test framework timeout).
   - `clears independent deadline timer when probe settles before timeout`: **PASSED**.
2. **Cancellation propagation & AbortSignal handling**:
   - `immediately returns 503 timeout without probing when external abortSignal is already aborted`: **FAILED** on `8133cf0` (`8133cf0` lacked `abortSignal` parameter).
   - `cancels in-flight probe and returns 503 timeout when external abortSignal fires mid-probe`: **FAILED** on `8133cf0`.
   - `removes abort event listener from external signal when probe finishes cleanly`: **FAILED** on `8133cf0`.
   - `probeRealDatabase aborts immediately when passed pre-aborted externalSignal`: **FAILED** on `8133cf0`.
3. **Failure recovery & sequential resilience**:
   - `recovers cleanly from repeated intermittent failure to healthy 200 ready`: **FAILED** on `8133cf0` (due to missing schema validation).

### 2.3 `safety-isolation-headers.adversarial.test.ts` (10 tests: 8 passed, 2 failed against `8133cf0`)
1. **Safe error handling & Zero Credential/Error Leakage**:
   - `MUST fail safely to HTTP 503 when deps.isConfigured() throws an exception with secrets`: **FAILED** on `8133cf0` (unhandled exception in `evaluateReadiness` crashed caller instead of returning safe 503).
   - `redacts raw database errors, connection strings, and passwords in probeDatabase rejections`: **PASSED**.
   - `verifies response contains ONLY sanctioned fields and values`: **PASSED**.
2. **Liveness independence from readiness state**:
   - `evaluateLiveness always returns 200 pass even when database dependencies are failing`: **PASSED**.
   - `GET /api/health?probe=liveness returns 200 without calling database dependencies`: **PASSED**.
   - `GET /api/health/liveness dedicated endpoint returns 200 with no-store header`: **PASSED**.
3. **HTTP Cache-Control: no-store on all health endpoints**:
   - `attaches Cache-Control: no-store on ready response (200)`: **PASSED**.
   - `attaches Cache-Control: no-store on degraded response (503)`: **PASSED**.
   - `attaches Cache-Control: no-store on dedicated /api/health/readiness endpoint (503)`: **PASSED**.
   - `propagates client request abort signal returning 503 with Cache-Control: no-store`: **FAILED** on `8133cf0` (`route.ts` did not pass `req.signal`).

---

## 3. Concrete Defect Log (Audited Against Baseline `8133cf0`)

| ID | Component | File & Function | Severity | Defect Description & Concrete Evidence |
|---|---|---|---|---|
| **DEF-01** | API Readiness | `apps/api/src/lib/health/readiness.ts`<br>`evaluateReadiness()` | High | **Missing schemaOk requirement**: In `8133cf0`, lines 42–79 evaluate `if (!probe.ok \|\| probe.status !== "connected")`. When `probe.ok === true` and `probe.status === "connected"` but `probe.schemaOk === false`, the function returns HTTP 200 with `status: "ready"` and `schema: "missing"`, violating readiness criteria. |
| **DEF-02** | API Readiness | `apps/api/src/lib/health/readiness.ts`<br>`evaluateReadiness()` | High | **Unbounded hanging dependency**: In `8133cf0`, `evaluateReadiness()` directly awaits `deps.probeDatabase(timeoutMs)`. If the underlying probe ignores timeout or hangs forever, `evaluateReadiness` never settles. Lacks independent `setTimeout` deadline and `Promise.race`. |
| **DEF-03** | API Readiness | `apps/api/src/lib/health/readiness.ts`<br>`evaluateReadiness()` | High | **Unhandled exception in isConfigured**: In `8133cf0`, line 19 executes `if (!deps.isConfigured())` outside the `try/catch` block. If `isConfigured()` throws (e.g., misconfigured parser or environment read error), an uncaught exception is thrown and leaks internal error details to the HTTP framework. |
| **DEF-04** | API Health Ports | `apps/api/src/lib/health/ports.ts`<br>`probeRealDatabase()` | High | **Improper table probe instead of RPC**: In `8133cf0`, `probeRealDatabase()` queries `from("families").select("id").limit(1)` directly. A `families`-only probe cannot prove schema readiness, queries tables directly, and does not consume the service-only `public.foundation_readiness()` RPC. |
| **DEF-05** | API Health Ports | `apps/api/src/lib/health/ports.ts`<br>`probeRealDatabase()` | Medium | **Missing RPC Contract defensive validation**: In `8133cf0`, the code lacks parsing and validation for the exact JSON contract `{ database: 'connected', schema_ready: boolean, schema_version: 'foundation-v4' }`. |
| **DEF-06** | API Routes | `apps/api/src/app/api/health/route.ts`<br>`GET()` | Medium | **Missing client AbortSignal propagation**: In `8133cf0`, `req.signal` is not passed to `evaluateReadiness()`. If a client aborts the incoming HTTP request during an in-flight probe, the server probe continues running rather than immediately aborting. |
| **DEF-07** | Database Acceptance | `infra/supabase/tests/phase1_security_acceptance.sql` | Medium | **Invalid PUBLIC role query & over-broad schema denial**: In `8133cf0`, SQL attempted `has_schema_privilege('public', ...)` (PUBLIC is an ACL pseudo-role, not a role). Furthermore, it did not verify that `authenticated` preserves `USAGE` on `sahaj_private` for `has_role`/`is_person` RLS helpers while denying table content. |

---

## 4. Sibling IDE Implementation Audit (`antigravity-foundation`)

A read-only inspection of sibling worktree `antigravity-foundation` (commit `26aa605` plus unstaged working copy changes) reveals that the IDE worker has addressed each of the defects identified in `PHASE1-REVIEW.md`:

1. **`evaluateReadiness` (`readiness.ts`)**:
   - Enforces `const isReady = probe.ok === true && probe.status === "connected" && probe.schemaOk === true;`. If `!isReady`, returns HTTP 503 degraded.
   - Adds independent `deadlinePromise` with `setTimeout` and `Promise.race` to bound hanging dependencies. Clears timers via `clearTimeout` in `finally`.
   - Wraps `deps.isConfigured()` in `try/catch` with safe fallback to `isConfigured = false`.
   - Accepts `options.abortSignal` and registers abort event listeners to cancel probe mid-flight.
2. **`probeRealDatabase` (`ports.ts`)**:
   - Calls `supabase.rpc("foundation_readiness")`.
   - Accepts `externalSignal?: AbortSignal` and propagates cancellation to `controller.abort()`.
   - Recognizes SDK abort responses (`response.error?.name === "AbortError"` or message containing "abort") as `status: "timeout"`, `code: "database_timeout"`.
   - Validates JSON payload defensively: requires object, `database === "connected"`, `typeof schema_ready === "boolean"`, and `schema_version === "foundation-v4"`.
   - Maps missing RPC (PostgreSQL `42883` or PostgREST `PGRST202`) to `missing_schema` / `schema_missing`.
3. **Route Handlers (`route.ts`, `readiness/route.ts`)**:
   - Forwards `req.signal` (or `req?.signal`) as `abortSignal` to `evaluateReadiness`.
4. **SQL Acceptance Suite (`phase1_security_acceptance.sql`)**:
   - Asserts non-vacuous existence of all 33 tables across `public`, `sahaj_private`, and `sahaj_checkpoints` before asserting `relrowsecurity = true`.
   - Checks PUBLIC (grantee = 0) via `aclexplode` rather than pseudo-role name.
   - Asserts `authenticated` preserves `USAGE` on `sahaj_private` for RLS helpers (`has_role`, `is_person`), while asserting browser roles lack all table privileges on `call_content`, `voice_content`, and `private_items`.
   - Asserts all 14 service-only RPC signatures exist and deny execution to `anon`, `authenticated`, and `PUBLIC` (grantee = 0).
   - Asserts all 3 care buckets (`sahaj-voice`, `sahaj-recordings`, `sahaj-lines`) exist and are private.

### Observation for Codex Integration:
In `readiness.ts`:
```ts
if (!isReady) {
  const isMissingSchema = probe.schemaOk === false || probe.status === "missing_schema";
  const dbStatus: DatabaseStatus = isMissingSchema ? "missing_schema" : probe.status;
  ...
```
If a custom probe returns `{ ok: false, status: "connected" }` with `probe.schemaOk` undefined, `dbStatus` defaults to `"connected"` inside an HTTP 503 response. While rare (since `probeRealDatabase` properly sets `schemaOk: false` or `unreachable`/`timeout`), Codex should note that any failed probe with `ok === false` should guarantee a non-`"connected"` database status (e.g. `"unhealthy"` or `"missing_schema"`).

---

## 5. Independent SQL Acceptance Suite (`infra/supabase/tests/phase1_independent_qa.sql`)

An independent, rollback-only SQL acceptance test was authored at `infra/supabase/tests/phase1_independent_qa.sql`.

### Key Verification Sections:
1. **Section 1 (Table Existence & RLS)**:
   - Non-vacuously validates existence of 25 public tables, 3 private content tables, and 4 checkpoint tables (total 32+ application/security tables).
   - Asserts `relrowsecurity = true` on every single table.
2. **Section 2 (Schema USAGE & RLS Helper Privileges)**:
   - Asserts `anon` has NO USAGE on `sahaj_private`.
   - Asserts `authenticated` DOES have USAGE on `sahaj_private` (specifically preserved for RLS helpers).
   - Asserts PUBLIC (grantee = 0 via `aclexplode`) has NO USAGE or CREATE on `sahaj_private`.
   - Asserts browser roles (`anon`, `authenticated`) have NO table privileges (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) on `call_content`, `voice_content`, `private_items`.
   - Asserts RLS helper functions `has_role(uuid,text[])` and `is_person(uuid,uuid)` exist, `authenticated` has EXECUTE, `anon` has NO EXECUTE, and PUBLIC (grantee = 0) has NO EXECUTE.
3. **Section 3 (Checkpoint Runtime Least Privilege)**:
   - Untrusted browser roles have NO USAGE on `sahaj_checkpoints`.
   - `sahaj_atlas_runtime` has NO database-wide `CREATE`.
   - `sahaj_atlas_runtime` has USAGE on `sahaj_checkpoints`, NO USAGE on `sahaj_private`, and zero table access to care data.
   - `sahaj_checkpoints` contains exactly 4 tables.
4. **Section 4 (Care Storage Buckets)**:
   - Asserts all 3 named care buckets (`sahaj-voice`, `sahaj-recordings`, `sahaj-lines`) exist.
   - Asserts bucket count is exactly 3.
   - Asserts all 3 buckets are private (`public = false`).
5. **Section 5 (Service-Only RPC Signatures & Catalog Grants)**:
   - Asserts all 14 service-only signatures exist, including `public.foundation_readiness()`, `public.get_voice_media_metadata(uuid,uuid)`, `public.get_call_media_metadata(uuid,uuid)`, and workflow procedures.
   - Asserts `anon`, `authenticated`, and `PUBLIC` (grantee = 0) have NO EXECUTE.
   - Asserts `service_role` has EXECUTE.
6. **Section 6 (Dynamic Runtime Invocation Denial)**:
   - `set local role anon`: Verifies runtime exception (`insufficient_privilege`) when invoking service-only RPCs or reading application tables.
   - `set local role authenticated`: Verifies runtime exception (`insufficient_privilege`) when invoking service-only RPCs or selecting from `sahaj_private` tables or internal queue tables (`raw_events`, `outbox`, `workflow_jobs`, `timeline_stream_heads`).
7. **Section 7 (Tenant Boundary Fixtures & Revocation Cutoff)**:
   - Inserts synthetic fixtures across two families (Family A, Family B).
   - Child in Family A cannot see Family B or Family B incidents.
   - Parent in Family A sees only own calls, not Family B calls, and cannot see triage incidents.
   - Circle in Family A sees only assigned tasks.
   - Revoked member (`revoked_at = now()`) is immediately barred from all reads.
8. **Section 8 (Clean Rollback)**:
   - Concludes with `rollback;`, ensuring zero persistent state changes or test residue.

---

## 6. Remaining Evidence Required Before 100% Phase 1 Closure

In alignment with `coordination/PHASE1-REVIEW.md`, `PHASE1-ACCEPTANCE-AUDIT.md`, and `PHASE1-LIVE-EVIDENCE.md`:
**Phase 1 CANNOT be marked 100% complete from mocked unit tests alone.**

The following live parent actions remain required:
1. **Migration Reconcile & Remote Application**:
   - Parent reconciles migration `20261114150944_foundation_readiness.sql` creating `public.foundation_readiness()`.
   - Applies migration to the connected Supabase project.
2. **Execute Database Acceptance**:
   - Run `infra/supabase/tests/phase1_independent_qa.sql` (or `phase1_security_acceptance.sql`) against the hosted database.
   - Confirm all assertions pass and transaction rolls back cleanly.
3. **Integration Merge & Local Verification**:
   - Codex integrates IDE fixes into QA worktree and verifies that all 30 tests in `apps/api/tests/foundation-qa/**` pass.
   - Verifies frozen install (`pnpm install --frozen-lockfile`), typecheck, tests, and build.
4. **Deployed Vercel Health Verification**:
   - Deploy integrated commit to Vercel.
   - Verify protected endpoint `GET /api/health?probe=liveness` returns HTTP 200 with `Cache-Control: no-store`.
   - Verify protected endpoint `GET /api/health` returns HTTP 200 with `database: { status: "connected", schema: "present" }` and `Cache-Control: no-store`.
5. **No Claims Beyond Phase 1 Foundation**:
   - External voice, care actions, and emergency readiness remain strictly disabled (`voice: "disabled"`, `care_actions: "disabled"`, `emergency_ready: false`).
