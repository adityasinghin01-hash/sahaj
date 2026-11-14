# Phase2 second pass — concrete integration blockers

Resume ONLY D:/Projects/SAHAJ/.worktrees/kiro-phase2, same owned paths plus exclusive NEW apps/api/src/app/api/twilio/gather/** (do not touch existing other routes). No cloud/env reads/push/merge. Continue from your saved commits.

Read D:/Projects/SAHAJ/coordination/PHASE2-3-INTEGRATION-REVIEW.md in full, plus your existing CONTRACTS.md and sibling Phase3 contract when available. Fix every Phase2-owned blocker. Particularly explicit service_role ledger DML revocation, immutable authorized target/action/provider/call binding at claim, future-consent rejection, serialized first-recording policy, common normalized responder/delivery proof.

Finish missing implementation rather than label incomplete parts complete:
1. Signed Twilio Gather route with configured exact URL/account, resolved stored call/assignment/responder, explicit1 acceptance, replay-bound nonce/durable evidence, common responder.accepted metadata contract. No generic completed/connected acceptance. Unknown/tampered/wrong-call/wrong-assignment and concurrent replays fail closed.
2. Normalize supported provider outcomes to common verified proof with all stored outbox/request/dispatch bindings. Unsupported or insufficient evidence remains pending/unknown. Coordinate SQL proof consumers using root common contract, no model flags or user IDs as authority.
3. Add Sarvam recording retrieval event/worker path only using actual supported Analytics endpoint/config and rechecked exact-call recording consent, no fabricated payload fields. If provider facts cannot be proven, keep configured optional path explicitly unavailable and flag exact gap.
4. Implement bounded private-recording retention/revocation purge with injected clock and narrow metadata/purge RPC, no deletion of another tenant or arbitrary bucket/path. Preserve consent rechecks, safe retry and first-recording idempotency. Parent owns scheduling integration; expose tested worker entrypoint.
5. Provider docs: your previous web tool was denied. You may use trusted execute_bash with PowerShell Invoke-WebRequest for official public docs, or consume parent coordination/PHASE2-PROVIDER-FACTS.md when available. Do not use trust-all-tools or read credentials. Avoid claiming redirect/media facts from guesses. Remove unsafe default guessed host assumptions in favor of explicit validated configuration if not guaranteed by official docs.

Run independent meaningful tests, typecheck/build. Add concurrent/SQL regression coverage for each blocker. SQL will be run by parent after review, never apply remotely yourself. Save small owned commits and precise remaining issues. Do not stop at recommendations when you own implementation. No live provider calls.
