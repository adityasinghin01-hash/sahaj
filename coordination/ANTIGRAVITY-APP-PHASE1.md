# Antigravity App — Phase1 independent QA worker

Folder D:/Projects/SAHAJ/.worktrees/antigravity-phase1-qa; branch feature/phase1-qa. IDE implements health in sibling antigravity-foundation; do not edit that sibling's files.

Read root coordination/PHASE1-REVIEW.md, PHASE1-ACCEPTANCE-AUDIT.md and PHASE1-LIVE-EVIDENCE.md. Inspect the sibling IDE implementation read-only, including its uncommitted fixes. You own ONLY NEW apps/api/tests/foundation-qa/**, infra/supabase/tests/phase1_independent_qa.sql, and docs/phase1-qa/** in your own worktree. Do not edit existing health tests/code, existing SQL tests, manifests, lockfile, shared/mobile/Shield or any other file.

Implement independent adversarial acceptance tests and a concise evidence report. Test healthy/failed/missing/malformed schema RPC, hanging dependency, cancellation, failure recovery, safe responses, liveness independence, no-store and care_actions/emergency readiness disabled. Add rollback-only SQL assertions for both browser roles against all service-only readiness/media RPCs; required tables/RLS; private-content isolation; exactly3 private care buckets; runtime role least privilege. Authenticated schema USAGE for RLS helper functions is intentionally allowed; table access is not. PUBLIC ACL grantee is0, not a role named public.

Your initial source baseline may trail IDE fixes. Record failures against exact SHA; do not copy uncommitted source or modify it. Codex will integrate the IDE commit into the QA worktree when ready and rerun your tests. Install frozen dependencies if needed. No env/secret reads, cloud actions, real phones or provider calls.

Commit only owned QA files, report SHA/tests and concrete defects with file/function references. Codex independently runs all tests/database/deployment checks and sends failures back to the implementation owner. Do not mark100% from mocked tests alone or merge/push/deploy.
