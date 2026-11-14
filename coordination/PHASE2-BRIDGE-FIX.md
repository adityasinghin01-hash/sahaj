# Kiro A — final cross-lane bridge fixes

Resume .worktrees/kiro-phase2 only; original ownership plus previously authorized WhatsApp/gather changes only after Codex approval. Parent independently confirmed325API+85adapter tests/typechecks pass at059f9f5. Do not call Phase2complete: actual combinedproducer/consumer path remains broken.

Read current sibling Phase3 c614a32 and its CONTRACTS.md. Coordinate by writing your updated CONTRACTS.md, not editing sibling files. Required common proof schema:
- metadata.action = outbox.action (care/domain enum check_in/send_alert/etc), NOT ledger.action (provider operation). Keep provider_action separately if needed.
- metadata.account_id must derive from the stored verified provider account/binding, never arbitrary callback data.
- responder.accepted metadata.person_id = actual offered responder; keep incident subject separately as subject_person_id. Exact incident/assignment/call/outbox/action_request/responder/account/dispatch_key bindings required.
- raw_events.normalized_proof=true is mandatory and set only by protected SQL normalization RPC; strict consumers also join actual dispatch_ledger/dispatch_bindings rows. Generic raw ingestion must never forge proof.

Implement producer changes for all these fields, with SQL and TS regression tests proving a real normalized proof matches Phase3 predicates and generic forged metadata fails. Expose stable APIs the Phase3 runner can invoke for actual dispatch/status normalization/recording/purge, not orphaned exports. Keep side effects gated and fenced. Document exact binding RPC signature for Phase3 atomic enqueue.

Additional final review: bind_outbox_dispatch/claim_dispatch must check calls.person_id equals the authorized dispatch person BEFORE external send, not only family FK or complete_dispatch afterward. Also guard_normalized_proof must freeze normalized metadata/type/family/hash/source/provider ID as well as the boolean; updating a preexisting normalized proof must not forge new evidence. Add same-family call substitution and proof rewrite regressions.

Align exact effective recording-consent expiry with Phase3 (currently365day max age); no storage/purge path may retain authorization after the gate expires it. Make the policy shared/explicit and tested rather than two conflicting interpretations. Future dates, revocation and wrong-purpose/call still fail.

Do not modify Phase3 files or apply SQL remotely. Run tests/typecheck/build, save tested small commits, report SHA and remaining cross-lane dependencies. Parent runs scratch SQL/concurrency and merged end-to-end tests. No secrets/env reads/provider calls/merge/push.
