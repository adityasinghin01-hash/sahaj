# Kiro B: remaining Phase3 acceptance defects

Resume existing Phase3 session in D:/Projects/SAHAJ/.worktrees/kiro-phase3. Own only Phase3 files; read AGENTS.md and PHASE3-BRIDGE-FIX.md. Tipc184a68 is unaccepted. Producer field names, ledger joins and Sarvam routing are improved; preserve them.

Independent final review requires:
1. request_consent currently assigns call_recording_consent TABLE(id,granted_at) to uuid. Consume the real table result and granted_at; fail closed on no rows.
2. observe_delivery checks delivered proof before responder.accepted. A verified Twilio acceptance has responder.accepted but no invented delivered proof. Let authoritative acceptance finish the urgent transition with all required binding checks. Add actual producer-to-consumer regression, not copied predicates.
3. Lock loss still merely sets held=false and is checked after graph execution. Cancel in-flight work AND fence actual PostgresSaver writes after lock loss. Prove an in-flight checkpoint mutation cannot commit after the lock connection dies; discarding final graph output is insufficient.
4. recheck_dispatch_authorization must enforce request expiry, permission period_end and current approving membership validity, atomically with dispatch claim to prevent revoke/recheck/claim races. Coordinate a shared atomic contract with Phase2 through documented interfaces; do not edit sibling files.
5. merged-path.test.ts imports sibling .worktrees paths and fails a fresh checkout. Make it integration-safe through stable repo imports and documented staged integration. Do not copy sibling implementation.
6. Production buildProviderBridge returns {}. Implement real configured composition with injected providers/identity/authorization and fail closed when absent. Merely exporting interfaces is not runtime integration.
7. phase3_atomic_orchestration.sql still looks up dropped10arg enqueue signature; final bridge has11args. Update final regression tests and fixtures for contact_ciphertext/binding kind. Drive real Phase2 normalization through real Phase3 observe_delivery in combined acceptance.

Final migration order: Phase3 base201500 -> Phase2 201600 -> Phase3 review210000 -> bridge213000. Do not apply SQL remotely. Run owned tests/typecheck, save small scoped commits and exact evidence; no secrets/env reads/provider calls/merge/push. Explicitly report anything that requires parent integration rather than claiming completion.
