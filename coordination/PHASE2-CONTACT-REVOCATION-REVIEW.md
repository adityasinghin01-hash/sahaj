# Phase 2 final blocking review: recipient revocation

Work only in `.worktrees/kiro-phase2`, on its existing branch. Preserve other workers' files. Review AGENTS.md and the existing Phase 2 production work order first.

Independent review of c8c9aa1 found a race: dispatch resolves a recipient before claiming the dispatch, while revoke_contact_identity can disable that identity between resolution and claim. Neither the claim nor the authorization trigger binds and checks the exact resolved identity. Replacement by another contact for the same person also permits sending to the cached old destination.

Fix this before claiming Phase 2 complete. Bind the resolved registry identity and provider/account to the durable dispatch claim and atomically revalidate that exact identity's family, person, source, account, enabled and revocation state. Use compatible locking with revocation. Checking merely that some active contact exists is insufficient. Keep encryption and redacted logs intact. Coordinate any claim ABI change explicitly with the Phase 3 seam; document the exact new contract. Do not edit Phase 3-owned files.

Add deterministic resolve-then-revoke and resolve-then-replace tests asserting no provider call, plus actual loopback PostgreSQL concurrency coverage. Use only the existing synthetic scratch database at 127.0.0.1:55439; no hosted schema changes or external communications. Run relevant typechecks, tests and SQL acceptance; commit scoped changes and report SHA, exact commands/results and unresolved limitations. Do not merge or push.
