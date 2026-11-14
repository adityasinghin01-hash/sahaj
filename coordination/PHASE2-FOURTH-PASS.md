# Kiro A: remaining Phase2 acceptance defects

Resume your existing Phase2 session in D:/Projects/SAHAJ/.worktrees/kiro-phase2. Own only your assigned Phase2 files. Read AGENTS.md and existing PHASE2-BRIDGE-FIX.md. Tip8abf699 is still unaccepted. Do not repeat already resolved producer field/routing fixes.

Independent final review still finds:
1. guard_normalized_proof protects the boolean but leaves normalized evidence mutable. Freeze all evidence-bearing fields on normalized rows, including metadata/type/family/hash/source/provider identity. Add SQL regression proving a normalized proof cannot be rewritten into another accepted action/person/account.
2. bind_outbox_dispatch and claim_dispatch must validate calls.person_id equals the authorized recipient BEFORE any external send. Same-family call substitution is still possible; complete_dispatch rejection afterward is too late. Add binding and claim regression tests.

Coordinate contracts with sibling Phase3 c184a68 through read-only inspection and your CONTRACTS.md. call_recording_consent is TABLE(id,granted_at), not scalar. Final migration order is Phase3 base201500 -> Phase2 201600 -> Phase3 review210000 -> bridge213000. Do not apply any SQL remotely. Keep normalized evidence immutable and all external calls disabled without authorization. Tests must use synthetic scripted providers. Run focused/full owned tests and typecheck; commit only owned changes, report SHA and limitations. No env reads, real providers, merge or push.
