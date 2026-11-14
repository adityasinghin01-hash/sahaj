# Phase 1 closure — Antigravity

Folder D:/Projects/SAHAJ/.worktrees/antigravity-foundation. Branch feature/phase1-closure. Start from this worktree's current Git state. Previous Antigravity feature branches are separate and must not be merged here. Codex owns integration/deployment and remote database actions.

Exclusive edit ownership: apps/api/src/app/api/health/**, apps/api/src/lib/health/**, apps/api/tests/health/**, infra/supabase/tests/phase1_*.sql, docs/phase1/**. No other paths/manifests/lockfiles/migrations/shared/mobile/Shield. Other workers own adapters, media, cron, Atlas, Cedar and workflow migrations.

Read root PROGRESS.md, infra/supabase/README.md, actual SQL migrations and existing test conventions. Read authoritative documents listed in KIRO-HANDOFF.md if available. Do not invent undocumented provider facts.

Implement foundation closure:
1. Replace static health database claim with bounded, redacted real dependency readiness through injected ports. Distinguish liveness200 from readiness503; readiness must fail when configuration/database/schema dependency is missing or timed out. Never expose credentials, tenant identifiers or database errors. Emergency readiness remains false until full verified acceptance. Preserve no-store responses.
2. Add meaningful tests for database unavailable, configured-but-unreachable, missing schema, bounded timeout, recovery, safe error bodies and disabled care actions. No network in unit tests; design an explicit live verification script/report for Codex without reading secrets.
3. Write rollback-only Phase1 SQL acceptance assertions for application table RLS, anon/authenticated tenant boundary, private schema/bucket isolation, service-only RPC execution and checkpoint role least privilege. Use synthetic fixtures and actual schema; do not change application grants or publish private schemas. Codex runs against connected project.
4. Document exact setup/build/security acceptance checklist and remaining evidence. Build/install scripts must keep exact esbuild approval, no global build-script bypass. Flag any actual foundation defects with minimal proposed patch to Codex rather than editing unowned paths.

Run pnpm.cmd install --frozen-lockfile then API typecheck/tests and build. Commit owned files only. Report SHA, checks and exact remaining remote verification. Do not declare Phase1 100% without combined build, local+deployed health/readiness and database isolation checks. No secrets/env reads, cloud actions, pushes or merges. No actual phone calls.
