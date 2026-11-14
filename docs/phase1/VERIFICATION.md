# Phase 1 Verification Guide

This document describes how to execute local verification and how parent/Codex executes remote acceptance verification without exposing secrets.

---

## 1. Local Verification (Completed by Antigravity)

Run these checks inside the repository / worktree (`.worktrees/antigravity-foundation`):

```powershell
# 1. Typecheck API package
pnpm --filter @sahaj/api typecheck

# 2. Run unit & route test suites (including health & readiness suite)
pnpm --filter @sahaj/api test

# 3. Compile optimized production build
pnpm --filter @sahaj/api build
```

### Local Test Coverage Summary (31 Health Tests):
- `tests/health/readiness.test.ts` (15 tests):
  - Database unconfigured / unavailable (HTTP 503 `database_not_configured`)
  - Safe failure when `isConfigured` throws an exception (HTTP 503 without leaking error details)
  - Configured but unreachable (HTTP 503 `database_unreachable`)
  - Missing schema detection (HTTP 503 `schema_missing`)
  - **Regression**: `connected + schemaOk=false` returns HTTP 503 degraded, never 200 ready
  - Bounded timeout abort response (HTTP 503 `database_timeout`)
  - **Independent bounded deadline**: Probe that never settles is cancelled and resolved via fake timers to HTTP 503 `database_timeout`
  - Transient failure recovery: transition from 503 failure to 200 ready
  - Dynamic recovery after a never-resolving timeout failure using fake timers
  - Safe error bodies (zero leaks of credentials, connection strings, tenant UUIDs, or SQL traces)
  - Disabled care actions (`emergency_ready: false`, `care_actions: "disabled"`, `voice: "disabled"`)
  - Liveness vs readiness distinction (liveness 200 vs readiness 503)
  - Unhandled exception containment in probe calls
  - **Abort handling**: Immediate 503 timeout return when external `abortSignal` is already aborted
  - **Abort handling**: Bounded probe cancelled and resolved to 503 timeout when external `abortSignal` aborts mid-probe
- `tests/health/ports.test.ts` (10 tests):
  - Configuration detection from environment variables
  - Successful RPC call consuming `public.foundation_readiness()` JSON contract (`{ database: 'connected', schema_ready: true, schema_version: 'foundation-v4' }`)
  - Missing schema detection when RPC returns `schema_ready = false`
  - Missing RPC function detection (PostgREST PGRST202 or PostgreSQL 42883)
  - Malformed or invalid RPC response handling (defensive JSON schema validation)
  - SDK abort `{ error }` response recognized as `database_timeout`
  - Thrown SDK `AbortError` recognized as `database_timeout`
  - Network failure (ECONNREFUSED / fetch failure) recognized as `database_unreachable`
  - **Abort handling**: Immediate timeout return when `externalSignal` is already aborted (zero Supabase calls made)
  - **Abort handling**: Timeout returned and internal query aborted when `externalSignal` fires mid-call
- `tests/health/routes.test.ts` (6 tests):
  - `GET /api/health?probe=liveness` returns 200 with `Cache-Control: no-store`
  - `GET /api/health` defaults to readiness probe and returns 200 when ready
  - `GET /api/health` returns 503 when readiness probe fails
  - `GET /api/health/liveness` dedicated route returns 200 with `no-store`
  - `GET /api/health/readiness` dedicated route returns 503 when dependency fails
  - `GET /api/health` with aborted request signal returns 503 timeout with `no-store` header

Total API test suite: 207 tests passing across 15 test files.

---

## 2. Schema Dependency & Final Migration

- **RPC Contract**: The API readiness probe calls the service-only `public.foundation_readiness()` procedure.
- **Payload Schema**:
  ```json
  {
    "database": "connected",
    "schema_ready": true,
    "schema_version": "foundation-v4"
  }
  ```
- **Migration Version**: Version `20261114150944` (`infra/supabase/migrations/20261114150944_foundation_readiness.sql`). Applied remotely by parent; parent owns reconciling that migration into integration.
- **Defensive Handling**: The API treats any missing RPC, invalid version, unparseable payload, or `schema_ready: false` as HTTP 503 `missing_schema`.

---

## 3. Remote Database Acceptance Execution (Parent Action)

Execute the rollback-only SQL acceptance test against the connected Supabase instance:

```bash
# Using Supabase CLI (or psql with administrative connection string):
supabase db execute --file infra/supabase/tests/phase1_security_acceptance.sql
```

Or via `psql`:

```bash
psql "$SUPABASE_DB_URL" -f infra/supabase/tests/phase1_security_acceptance.sql
```

**Key Assertions Verified**:
1. Non-vacuous table existence: All 33 tables across `public`, `sahaj_private`, and `sahaj_checkpoints` must exist before checking RLS.
2. All 33 tables have `relrowsecurity = true`.
3. Schema isolation: `anon` has no USAGE on `sahaj_private`; PUBLIC (grantee = 0) has no USAGE/CREATE on `sahaj_private`; `authenticated` USAGE is preserved for `has_role`/`is_person` RLS helpers; browser roles have zero direct table privileges on `call_content`, `voice_content`, or `private_items`. RLS helper signatures in `sahaj_private` are validated and confirmed executable by `authenticated` and denied to `anon`.
4. Storage buckets: All 3 care buckets (`sahaj-voice`, `sahaj-recordings`, `sahaj-lines`) must exist AND be private (`public = false`).
5. Checkpoint least privilege: `sahaj_atlas_runtime` lacks database CREATE, lacks application table access, and `sahaj_checkpoints` has exactly 4 tables.
6. Non-vacuous RPC existence & exact signatures: All 14 service-only RPC signatures (including `foundation_readiness()`) must exist via `to_regprocedure`; neither `anon`, `authenticated`, nor `PUBLIC` has EXECUTE; only `service_role` has EXECUTE. Direct execution denial tested under both `anon` and `authenticated`.
7. Tenant boundary fixtures: Validates anonymous default deny, Family A vs Family B isolation, intra-tenant role fencing, and immediate revocation cutoff.
8. Rolls back cleanly with zero persistent residue.

---

## 4. Safe Deployed Health Verification (Parent Action)

To verify the deployed API without reading or logging sensitive tokens or environment variables, execute `docs/phase1/verify_live.sh` or `docs/phase1/verify_live.ps1`.

### Explicit Remaining Live Readiness Evidence:
1. Reconcile parent's remote migration `infra/supabase/migrations/20261114150944_foundation_readiness.sql` (recorded version `20261114150944`) into integration.
2. Run `infra/supabase/tests/phase1_security_acceptance.sql` against the connected Supabase database.
3. Deploy the integration commit to Vercel.
4. Verify protected `GET /api/health` returns HTTP 200 with `database.status = "connected"` and `database.schema = "present"`.
5. Note: No provider or Atlas feature readiness is claimed in Phase 1; external care actions and voice remain disabled.
