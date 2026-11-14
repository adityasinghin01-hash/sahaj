# Parent integration contract review — draft worker code

Review conducted while Kiro workers are editing. These are blockers to check against final commits, not claims that current drafts are complete. No draft migrations have been applied.

## Common verified proof contract

Use normalized internal proof events, created only after provider request verification and authoritative identity/call/assignment resolution. A client/model-supplied verified boolean is never evidence.

- `responder.accepted`: bind family, incident, assignment, responder person, call, outbox and immutable action request. Metadata must include `incident_id`, `assignment_id`, `responder_person_id`, `person_id`, `call_id`, `outbox_id`, `action_request_id`, `action=urgent_responder`. Persist verified raw provenance. A signed Gather callback must prove explicit acceptance by this offered responder; connected/completed call alone is insufficient.
- `delivery.confirmed` / `delivery.not_sent`: retain existing SQL evidence contract `outbox_id` and `outcome=delivered|confirmed_not_sent`, plus immutable action binding `action_request_id`, `action`, ledger `dispatch_key` and `provider_ref`. Derive all linkage from stored records, not arbitrary provider form fields. A connected call cannot establish that a person heard a message.
- Raw provider callbacks remain distinct from normalized proof. A durable worker normalizes only supported, sufficiently verified statuses. Unsupported/ambiguous evidence remains pending/unknown/review.

## Early blockers requiring regression tests

1. Phase2 initially required twilio.gather.accepted; Phase3 initially required responder.accepted. Implement the common proof above in producers and consumers. Existing provider store metadata allowlist does not yet emit these normalized fields.
2. Explicitly REVOKE ALL on dispatch_ledger FROM service_role before granting SELECT only. Supabase default privileges can already grant ALL; a later GRANT SELECT does not subtract DML rights. Ensure all state changes use fenced service-only RPCs.
3. A valid outbox lease must not authorize a different person, provider, action or call within the family. Derive immutable dispatch target/action/provider from the authorized stored request, or validate every field against it before claim. Test same-family substitution as well as cross-family substitution.
4. Locking quota/permission rows is insufficient if consent, membership or approvals can revoke concurrently. Use a shared locking protocol for every relevant writer, enforce it through safe RPCs/triggers and grants, and test two concurrent transactions. Lock acquisition must have deterministic order. A read followed by enqueue without shared revocation fencing is insufficient.
5. Specify and test permission deny/ask precedence. Do not silently pick an allow while ignoring an applicable active deny. Raw database decision fields must map explicitly into the Cedar contract. Missing data/unsupported policy fails closed.
6. Approval snapshot initially omitted GateApproval requestId/requestFingerprint/familyId and permission binding. Preserve the exact immutable request fingerprint and actual selected permission; never fabricate fields to satisfy the gate. Prove a valid two-person approval succeeds and stale/wrong-request approvals fail.
7. Normalize purpose-specific consent contracts: Phase2 call_recording+exact call and Phase3 record_audio:<target> initially differ. If distinct purposes are intentionally required, capture and test both; never infer one grant from an unrelated purpose. Reject future grants in every writer, not only in application readers.
8. put_call_recording must serialize the first recording by locking the existing calls row before selecting possibly absent call_content. Two simultaneous first recordings must follow the documented stored/ignored_additional policy, rather than an unexpected unique violation. Recheck exact effective consent under that same fence.

Read coordination/PHASE3-CONTRACT-REVIEW.md for exact current schema and atomic invariants. Save tested scoped commits and parent will re-review actual changes before any migration or deployment.

## Phase3 committed TypeScript review of552b0bb

- Timeline replay currently compares only signature/family/key/eventType; also compare immutable payload hash, entity ID and human line. Changed content under an existing key must conflict, not silently succeed. Generated current timestamp/head should not create false conflicts on a valid replay.
- A renew-before/after-work lease does not fence a graph/model/checkpoint operation longer than its lease. Prevent two processes writing the same thread and ensure timeline append is fenced atomically with current lease, not renew-then-separate-append. Use durable exclusivity/fencing and tests with lease expiry mid-operation.
- Sarvam outbound/TeleCMI events cannot simply complete as generic status facts when they contain check-in understanding or nudge input. Sarvam transcript extraction must read the consented encrypted content; WhatsApp-only text extraction leaves Hindi call understanding inert. Unsupported/missing content requires durable review, not success.
- Interrupted urgent jobs must not wake endlessly from the same previously-consumed delivery proof while responder acceptance is absent. Bind wakeup to new relevant proof/revision and test duplicate evidence.
