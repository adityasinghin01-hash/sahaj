# Antigravity A review of d3407ed

Continue only in D:/Projects/SAHAJ/.worktrees/antigravity-a, original owned packages/atlas/src/core1 and test/core1 paths. Parent has NOT integrated this commit. Fix independently found blockers before integration; no manifests/shared/schema/provider calls.

1. Responder acceptance evidence cannot be only eventId+verified. Bind authoritative evidence to family, incident, offered assignment, responder and exact action/status. Reject unrelated verified events. Completion must validate current assignment belongs to family/incident/person and is in the correct state. Do not fabricate acceptance from connected/completed call status.
2. Check-in scheduling must treat a connected call as ongoing and avoid scheduling another call while it is active. Validate timestamps/timezone/state rather than silently scheduling duplicates.
3. Medicine/refill must require instructionsConfirmedByPerson and matching vendor family. Reject invalid/fractional/negative/non-finite doses, quantities and prices; never silently floor/clamp. Clarify estimatedUnitPriceMinor units: unit price times total quantity (packs*packSize), or explicitly define pack price consistently. Test exact totals and cross-family vendor rejection. No diagnosis or automatic payment.
4. Missed-call dedup must bind family, person and provider account/call identity before grouping. A providerCallId collision in one family must not drop another family's event.
5. Fix timezone/DST conversion: quiet-end03:30 in America/New_York on2026-03-08 must resolve07:30Z, not08:30Z (04:30 local). Base target calculation on the injected current clock, not stale wake time; validate schedule/state family and date correspondence.
6. Pure repeated evaluation must produce stable incident/assignment/proposal identities. Inject IDs derived from durable command identity or deterministically derive them; avoid random IDs inside replayed calculations. Validate missed-call timestamps/windows and inject current clock for deferred grouping.

Add adversarial regression tests for every blocker, run all Atlas tests and typecheck, commit scoped fixes and report SHA/tests. Parent will independently re-review. No live data, secret reads, pushes or merges.
