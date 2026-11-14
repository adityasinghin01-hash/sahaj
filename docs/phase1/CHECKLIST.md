# Phase 1 Foundation Closure Acceptance Checklist

## 1. Overview & Scope

Phase 1 establishes the secure build, API foundation, database schema, Row-Level Security (RLS), private media storage, and bounded health/readiness architecture for Project SAHAJ.

- **Worktree**: `D:/Projects/SAHAJ/.worktrees/antigravity-foundation`
- **Branch**: `feature/phase1-closure`
- **Ownership Scope**:
  - `apps/api/src/app/api/health/**`
  - `apps/api/src/lib/health/**`
  - `apps/api/tests/health/**`
  - `infra/supabase/tests/phase1_*.sql`
  - `docs/phase1/**`
- **Excluded from Phase 1 Scope (No Provider or Atlas Feature Readiness Claims)**:
  - External care actions and voice remain strictly disabled (`care_actions: "disabled"`, `voice: "disabled"`, `emergency_ready: false`).
  - Provider credentials, live phone calls/SMS, WhatsApp webhooks, complete webhook dispatch/retry consumers, media Cedar policy wiring, full Atlas workflow engine repositories, and outbox consumers belong to Phases 2–5.

---

## 2. Build & Install Integrity

- [x] **Frozen Lockfile**: Verified via `pnpm install --frozen-lockfile`.
- [x] **Exact esbuild Approval**: `package.json` pnpm configuration maintains exact build approval (`onlyBuiltDependencies: ["esbuild"]`); no global build script execution bypass (`ignore-scripts` or wildcard approvals) introduced.
- [x] **TypeScript Typecheck**: Verified zero type errors via `pnpm --filter @sahaj/api typecheck` (`tsc --noEmit`).
- [x] **Production Build**: Verified clean Next.js Turbopack build via `pnpm --filter @sahaj/api build`.

---

## 3. API Health & Dependency Readiness

- [x] **Bounded Readiness Architecture & Schema Probe**:
  - Consumes service-only `public.foundation_readiness()` RPC returning exact JSON contract:
    `{ database: 'connected', schema_ready: boolean, schema_version: 'foundation-v4' }`.
  - Final migration/schema dependency: Parent has applied migration version `20261114150944` (`infra/supabase/migrations/20261114150944_foundation_readiness.sql`) remotely; parent owns reconciling that migration into integration.
  - Consumes exact result defensively, handling missing RPC, malformed response, or false schema (`schema_ready: false`) as HTTP 503 degraded (`missing_schema`, `schema_missing`).
  - Requires `probe.schemaOk === true` as well as `probe.ok === true` and `probe.status === "connected"` for HTTP 200 ready. Regression tested: `connected + schemaOk=false` returns HTTP 503, never 200 ready.
  - Does not query or expose private schemas directly.
- [x] **Independent Bounded Deadline & Comprehensive Abort Handling**:
  - Enforces an independent bounded deadline around the injected probe, ensuring `evaluateReadiness` resolves even when the dependency ignores its timeout or hangs indefinitely.
  - Propagates cancellation via `AbortController` where supported.
  - Comprehensive abort handling tested: early-return timeout on pre-aborted external signal, mid-probe cancellation propagation, and Next.js request signal (`req.signal`) integration.
  - Guarantees timer clearance (`clearTimeout`) across all execution paths.
  - Tested with never-resolving fake probes and recovery tests using Vitest fake timers.
  - Safe error handling: `isConfigured` exceptions fail safely to HTTP 503 without leaking error details.
  - SDK abort `{ error }` responses and thrown `AbortError` recognized as timeout (`database_timeout`).
- [x] **Liveness vs. Readiness Distinction**:
  - Liveness probe (`/api/health/liveness` or `GET /api/health?probe=liveness`) returns HTTP 200 without downstream checks.
  - Readiness probe (`/api/health/readiness` or default `GET /api/health`) evaluates dependencies and returns HTTP 200 when ready or HTTP 503 Service Unavailable when configuration, connectivity, or schema is missing or timed out.
- [x] **Safe Error Bodies**:
  - Zero leakages: credentials, connection strings, tenant UUIDs, and raw SQL/PostgreSQL error traces are never exposed in JSON responses.
  - Standardized bounded error codes: `database_not_configured`, `database_unreachable`, `database_timeout`, `schema_missing`, `database_error`.
- [x] **Disabled Care Actions & Emergency Readiness**:
  - `emergency_ready: false` strictly enforced across all health responses.
  - `care_actions: "disabled"` and `voice: "disabled"` explicitly reported.
- [x] **HTTP Caching**:
  - Strict `Cache-Control: no-store` response header attached to all health routes.

---

## 4. Database Security & Isolation (Rollback Acceptance Assertions)

- [x] **Acceptance Suite**: Implemented in `infra/supabase/tests/phase1_security_acceptance.sql`.
- [x] **Rollback-Only**: Encapsulated within `begin; ... rollback;`; zero persistent state or test residue.
- [x] **Non-Vacuous Object Existence & Application Table RLS**:
  - Explicitly asserts that all 33 required tables across `public`, `sahaj_private`, and `sahaj_checkpoints` exist before iterating RLS (absent objects fail immediately and cannot vacuously pass).
  - Validates `relrowsecurity = true` on every required table.
- [x] **Private Schema & Storage Bucket Isolation**:
  - `sahaj_private`: `anon` has no `USAGE`. PUBLIC (grantee = 0 inspected via `aclexplode`) has no `USAGE` or `CREATE`.
  - Authenticated `USAGE` on `sahaj_private` is preserved for `has_role`/`is_person` RLS helpers (as documented in `PHASE1-LIVE-EVIDENCE.md`).
  - Browser roles (`anon`, `authenticated`) lack direct table privileges (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) on all private content tables (`call_content`, `voice_content`, `private_items`).
  - `sahaj_checkpoints`: `anon` and `authenticated` have no `USAGE`. PUBLIC has no `USAGE` or `CREATE`.
  - Media storage buckets: Asserts all 3 named care buckets (`sahaj-voice`, `sahaj-recordings`, `sahaj-lines`) actually exist AND are private (`public = false`).
- [x] **PUBLIC Role Handling**:
  - Recognizes `PUBLIC` as an ACL pseudo-role (grantee = 0), never calling `has_*_privilege('public', ...)`.
  - Inspects `aclexplode` grantee = 0 for schema and procedure privilege verification.
- [x] **Service-Only RPCs & Exact Signatures**:
  - Explicitly asserts that all 14 required service-only procedures (including `public.foundation_readiness()`) actually exist via exact procedure signatures (`to_regprocedure`) before checking execution grants.
  - Verifies that neither `anon`, `authenticated`, nor `PUBLIC` (grantee = 0) has `EXECUTE` privileges.
  - Verifies that `service_role` has `EXECUTE` privileges.
  - In addition to ACL assertions, both `anon` and `authenticated` roles are tested for direct execution denial against `foundation_readiness()`, `get_voice_media_metadata()`, and `get_call_media_metadata()`.
  - Asserted RLS helpers in `sahaj_private` (`has_role(uuid,text[])`, `is_person(uuid,uuid)`) exist and are executable by `authenticated` while denied to `anon`.
- [x] **Anonymous Role Boundary**:
  - Confirms default deny: `anon` cannot read or write any application tables (`families`, `people`, `calls`, `incidents`, `raw_events`, `consents`, etc.).
- [x] **Authenticated Tenant Boundary**:
  - Cross-tenant fencing: Family A members cannot view or access Family B data.
  - Role fencing: Child, Parent, and Circle roles strictly adhere to least-privilege visibility rules.
  - Revoked membership: `revoked_at` revocation immediately cuts off all tenant access.
  - Client mutation denial: `authenticated` role cannot update `family_memberships` or access private content tables.
- [x] **Checkpoint Runtime Role Least Privilege**:
  - `sahaj_atlas_runtime` role has NO database-wide `CREATE` privilege.
  - Restricted to `USAGE` on `sahaj_checkpoints` with zero access to `sahaj_private` or sensitive application tables.
  - Exactly 4 checkpoint tables verified.

---

## 5. Foundation Defect Report & Proposed Patch to Parent

### Defect Notice: `scripts/check.ps1` Local Smoke Expectation
- **Observed Behavior**: The existing scaffold script `scripts/check.ps1` calls `GET http://localhost:3000/api/health` and throws if the HTTP status is not 200 (`if (-not $health.ok)`).
- **Impact**: Under Phase 1 foundation readiness, `/api/health` correctly returns HTTP 503 in local development environments where real Supabase credentials (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) are intentionally not configured.
- **Proposed Patch to Parent** (since `scripts/` is outside Antigravity's owned paths):
  ```diff
  --- a/scripts/check.ps1
  +++ b/scripts/check.ps1
  @@ -2,3 +2,3 @@
   Write-Host 'Checking Sahaj local API http://localhost:3000 ...'
  -$health = Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -Method Get
  +$health = Invoke-RestMethod -Uri 'http://localhost:3000/api/health?probe=liveness' -Method Get
   if (-not $health.ok -or $health.emergency_ready) { throw 'Unexpected health response' }
  ```
  Alternatively, operators testing full readiness can set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to verify the 200 readiness path.

---

## 6. Remaining Remote Verification (Required Before 100% Phase 1 Closure)

In accordance with `coordination/PHASE1-REVIEW.md`, `coordination/PHASE1-ACCEPTANCE-AUDIT.md`, and `coordination/ANTIGRAVITY-IDE-PHASE1.md`, Phase 1 cannot be marked 100% complete until the following parent actions and live readiness evidence are completed:

1. **Schema Dependency Migration (Parent Action Completed Remotely; Integration Reconcile Pending)**:
   - Parent has applied migration version `20261114150944` (`infra/supabase/migrations/20261114150944_foundation_readiness.sql`) remotely, creating `public.foundation_readiness()` returning `{database:'connected', schema_ready:boolean, schema_version:'foundation-v4'}`.
   - Parent owns reconciling that migration into integration.
2. **Remote Database Security Acceptance (Parent Action)**:
   - Execute `infra/supabase/tests/phase1_security_acceptance.sql` against the connected hosted Supabase project.
   - Verify transaction rolls back with zero assertion exceptions.
3. **Deployed Vercel Health & Readiness (Parent Action)**:
   - Trigger deployment of the integration branch containing Phase 1 closure.
   - Probe deployed endpoint `/api/health?probe=liveness` -> returns HTTP 200 with `no-store`.
   - Probe deployed endpoint `/api/health` (readiness) with configured database -> returns HTTP 200 (`database.status = "connected"`, `database.schema = "present"`).
4. **Independent Closure Suite Record**:
   - Parent records exact deployed commit SHA, local/deployed readiness evidence, and PostgreSQL closure results before marking Phase 1 100%.
