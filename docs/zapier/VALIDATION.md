# Executed local validation — 15 November 2026

IMPLEMENTED does not mean DEPLOYED, TESTED in production, or ACCEPTED.

| Check | Result and scope |
|---|---|
| API unit/regression suite | 310 tests PASS, 27 files; includes 40 new Zapier tests using injected fakes, no provider network |
| Atlas suite | 62 tests PASS, 8 files; reused Phase 4 compiler covered by original and new API tests |
| API + Atlas TypeScript | PASS |
| Next production build | PASS, /api/zapier/weekly included; local build only |
| Disposable SQL | 20 checks PASS on PGlite 0.5.16 in-memory PostgreSQL; new migration plus actual existing finish_outbox against minimal compatible schema, including explicit failed-delivery backoff/reclaim; not the full joined migration/RLS/concurrency suite |
| Actual local HTTP | 5 checks PASS through built Next route and localhost-only mock Supabase REST: missing bearer 401 without timeline access, authorized synthetic exact nine-field report 200, empty report 200, family-query override 400, revoked scope 403 |
| Classic Zap inspection | Existing Z1/Z2/Calendar draft inspected; integration mappings not edited, no duplicate workflows or action tests |
| Production deployment / real provider / Sheets / Calendar / Gmail | NOT RUN, no new acceptance evidence |

Commands from this isolated checkout:

```
# Locked install used existing pnpm 11.25.0, --ignore-scripts; no manifest/lockfile dependency changes.
pnpm.cmd install --frozen-lockfile --ignore-scripts
cd apps/api
node_modules/.bin/vitest.cmd run --maxWorkers=2 --minWorkers=1
node_modules/.bin/tsc.cmd --noEmit
node_modules/.bin/next.cmd build --webpack
cd ../../packages/atlas
node_modules/.bin/vitest.cmd run --maxWorkers=2 --minWorkers=1
node_modules/.bin/tsc.cmd --noEmit
cd ../..
node scripts/test-zapier-sql.mjs
node scripts/test-zapier-http.mjs
```

PGlite is a validation-only install in ignored tmp/zapier-db-test, not a production dependency. To reproduce, install @electric-sql/pglite@0.5.16 there with lifecycle scripts disabled, or set PGLITE_MODULE to an already installed absolute dist/index.js path. Local HTTP binds to 127.0.0.1, supplies synthetic credentials to its local REST double, disables all dispatch flags and shuts down its child server. It never calls a live hook. Real phone tests and historical Catch Hook scope remain unchanged.

Initial sandboxed Vitest startup was denied ancestor-directory access; the approved outside-sandbox run passed. The first build exposed an existing optional readiness Request signature error on the Phase 4 branch. The identical required-Request fix already on main was backported, and two old tests were updated to pass Request objects. No readiness functionality or authorization policy was redesigned.

Remaining release tests: actual joined Phase 2/3/4 migration and concurrent worker/claim tests, hosted scope/secret/routing checks, approved business-event source/catch-up wiring, approved downstream atomic/serialized dedupe, exact deployed SHA and separately authorized synthetic action tests. No guarantee of exactly-once Sheets/Calendar behavior is made by these local checks.
