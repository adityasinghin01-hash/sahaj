# Antigravity B: authenticated family commands

Working directory: D:/Projects/SAHAJ/.worktrees/antigravity-b
Branch: feature/core1-commands. Base a2ed402.

Exclusive edit ownership: apps/api/src/app/api/commands/**, apps/api/src/lib/commands/**, apps/api/tests/commands/**. Do not edit root manifests/lockfiles, existing database/event-store/timeline helpers, Atlas/gate packages, migrations, shared, mobile or Shield. Request contract/schema needs in a short report; Codex integrates.

Read existing serviceDatabase/eventStore, Cedar and Atlas contracts and current SQL migrations. Authoritative architecture https://docs.google.com/document/d/1BLnuLwtsqdb57FK8aJDedC7EQmv_5y3s7LFq_gxt1OQ/edit and ownership https://docs.google.com/document/d/1lQlNRLSDyCcyDxqW1_S8qhPdgDYbyFYq-QojqqD0Zm4/edit. Report if inaccessible rather than guessing.

Implement authenticated backend command endpoints for check-in request, urgent-help request, voice-message request and refill proposal. Verify Supabase bearer tokens through Auth getUser; load live server-managed membership and reject revoked memberships. Actor/family IDs must derive from membership and server records, never trust request-body roles. Every target/reference must belong to the same family. Circle/parent/child capabilities must be explicit. AI results cannot grant permissions.

Validate bounded strict request schemas and stable client command idempotency keys. Persist an encrypted durable event before responding202. Return queued/requested only, never delivered, accepted, authorized or emergency-handled. Reuse serviceDatabase and existing ingest_raw_event RPC; use an allowlisted metadata contract with IDs and command enum only. Missing configuration/storage must fail503. Do not send provider actions; Atlas and Cedar execute later.

Use dependency-injected auth/repository ports for no-network tests, plus route tests. Cover invalid/expired auth, revoked member, cross-family target, forged actor, duplicate commands, changed payload same key, malformed/oversize body, persistence failure and role restrictions. Synthetic IDs only, no phone/health/keys in logs/prompts. No .env access, real calls or remote mutations. Existing dependencies only.

Commit only owned files; no merge/push/deployment. Report SHA, files, test commands/results and exact metadata schema required by the Atlas worker. Implement and test, not just plan.
