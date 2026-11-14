# Antigravity A: Core 1 domain logic

Working directory: D:/Projects/SAHAJ/.worktrees/antigravity-a
Branch: feature/core1-domain. Base: a2ed402 (integration checkpoint, not a complete service).

You exclusively own packages/atlas/src/core1/** and packages/atlas/test/core1/**. Do not edit any other file, package manifests, lockfiles, shared contracts, database migrations, apps/parent, apps/child or packages/shield. Codex owns integration. Other workers own authenticated commands, provider webhooks and media.

Read existing Atlas/gate/adapters contracts. Read authoritative architecture https://docs.google.com/document/d/1BLnuLwtsqdb57FK8aJDedC7EQmv_5y3s7LFq_gxt1OQ/edit and ownership https://docs.google.com/document/d/1lQlNRLSDyCcyDxqW1_S8qhPdgDYbyFYq-QojqqD0Zm4/edit before coding. If documents inaccessible, report that and use documented existing contracts; do not invent provider facts.

Implement pure TypeScript domain functions with injected clocks and explicit typed inputs/outputs:
1. Daily check-in scheduling with local windows/time zones, finite retries, quiet hours, cancellation, consent and duplicate wake handling. Output intents only; never dial directly.
2. Urgent responder offer/decline/timeout/escalation transitions. Acceptance requires a verified event bound to the specific offered person and incident; no false accepted/handled state. Define promises and overdue re-escalation.
3. Medicine inventory/refill math: confirmed dose/count inputs, missed/double doses handled without diagnosing or prescribing, low-stock/refill proposal, vendor/amount/item constraints passed to Cedar. No automatic payments.
4. Missed-call grouping and family nudges: unique provider IDs, deterministic ordering, configurable approximately20-second window; one/two/three calls differentiated. No irreversible actions.

Preserve privacy: no raw phone numbers, transcripts or health information in model prompts/logs/fixtures. Use synthetic identifiers and demo data. AI discloses it is AI; consent required for recording/sharing. Do not create fabricated accepted responders or completed calls.

Add meaningful tests for timezone edges, duplicates, stale events, wrong responders, retry exhaustion, inventory boundaries and missing consent. Use existing dependencies; no installation or manifest changes. You may use root's installed toolchain for tests; if unavailable report exact command. Commit only owned files on your branch, no merge/push/deploy/remote mutation. Report SHA, changed files, tests and remaining integration requirements. Keep working until tests pass.
