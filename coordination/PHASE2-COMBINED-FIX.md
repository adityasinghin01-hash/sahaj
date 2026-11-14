# Kiro A: combined SQL fixture regression

Resume Phase2 only. Independent review accepts the proof freeze and pre-send call-recipient checks at1f54fd8;348API/85adapter tests and both typechecks pass. Do not regress them.

Fix infra/supabase/tests/phase2_dispatch_recording.sql (locate actual owned filename): final Phase2 fixture action_requests a300...002 uses action other_action, rejected by Phase3 base action_requests_action_known. Use a valid non-urgent action. Outbox e200...005 initially references a300...002; later e200...004 is updated to that same request, violating Phase3 outbox_one_per_action_request. Use distinct/null request IDs with deliberate conflict only in explicit rejection assertions. Review all fixtures under actual Phase3base ->Phase2 ->Phase3followups ->bridge order and align with final11arg enqueue/table consent contract. Do not edit sibling files or apply hosted SQL. Run owned tests/typecheck, commit and report exact SQL limitations.

Also document the trusted direct-SQL boundary for sahaj.proof_writer custom GUC: service_role with direct SQL can set it and insert normalized_proof. REST generic ingestion cannot. Prefer column-level insert restrictions/owner-run writer if compatible; do not create misleading protection against a fully privileged database owner. Report the chosen trust boundary and tests.
