# Phase 5: Core 2 server and integrated acceptance — Aditya Singh

Read [START-HERE](START-HERE.md) and [Phase 4](PHASE4-CORE1.md). Aditya owns this phase, including the integrated Core 1/Core 2 harness. Kiro retains Phase 2/3 implementation. Phase 5 can begin now with typed ports, domains, routes, repositories and harness scenarios; **final acceptance waits for reviewed Phase 2 + 3 + 4 integration**.

## Actual mobile seam: do not assume screens imply APIs

Current `apps/child/lib/api.ts` sends requests to `/api/app/` and uses existing shared Zod contracts. Its methods cover Shield summary/alerts/detail/feedback/pairing/busy reply/evidence/drills/harness, push registration, timeline and verification. It does not currently expose a Core 2 SOS/watch/safe client method, despite corresponding screens. Preserve these existing methods and exports.

Implement Core 2 routes under owned `/api/core2/**`, and document the proposed mapping to app methods/DTOs in `docs/phase5/INTEGRATION.md`. Mobile/shared owners must agree before modifying `apps/child`, `apps/parent`, existing `/api/app` handlers or `packages/shared`. Existing Shield timeline/harness endpoints are not evidence that Core 1/2 integrated acceptance exists.

## Core 2 server tasks

1. **SOS:** authenticated adult-child subject, durable incident/request creation, current trusted-contact resolution, bounded verified escalation and deduplication. Record requested/queued/pending/verified outcomes accurately; no emergency handled/accepted claim without exact evidence.
2. **Watch/check-in:** explicit watch start/deadline/timezone, scheduled check-ins, late-home grace and escalation, restart/missed-cron catch-up, bounded cancellation and monotonic versions. Do not add a second unfenced scheduler over Kiro's worker.
3. **I am safe:** authenticate the actual subject or explicitly delegated actor, bind exact watch/incident/version, idempotent safe event and reassurance. Define safe-vs-timeout race transactionally; a stale timeout cannot reopen a resolved watch or trigger an avoidable new dispatch. A legitimately dispatched earlier action has a separate reconciliation history and cannot be unsent by changing a row.
4. **Trusted contacts:** lifecycle, invitation/approval/consent, scope, ordering, revocation and effective-date validation; same-family membership alone is not a trusted emergency contact grant. Fence revocation against pending dispatch.
5. **Emergency communication/reassurance:** use Phase 2 dispatch and Phase 3 Cedar/atomic outbox, current consent, verified status and redacted facts. Maa's reassurance/truth-line response must preserve the subject's sharing preferences; do not expose location, private narrative or health information by default. No model-created facts or fabricated certainty.
6. **Authenticated reads:** bounded pagination and family/subject-scoped status/history. Expose safe state rather than raw events, encrypted payloads, private media paths or unrestricted timeline human lines.

Suggested proposed resources: `/api/core2/sos`, `/api/core2/watches`, `/api/core2/watches/:id/safe`, `/api/core2/trusted-contacts`, `/api/core2/reassurance`. Finalize semantics, DTOs and error mapping before wiring apps. These paths are proposals, not already-supported mobile contracts.

## Security and persistence requirements

Use Auth getUser and live canonical membership; derive actor/family on the server, require explicit family for ambiguity, prove every person/contact/watch/incident/request reference, and enforce actor-versus-subject capabilities. Strict bounded bodies reject unknown fields and forged authority. Stable family+actor+client idempotency isolates users/tenants; changed content conflicts. Encrypt durable input before 202; missing configuration/storage fails closed.

All external actions use current real Cedar decisions and the atomic authorized outbox protocol; never directly call providers from routes. Model understanding cannot authorize or establish emergency acceptance. Reuse signed timeline and existing encryption. New state tables need service-only mutations, RLS and composite tenant references in the owned Phase 5 migration. Do not activate it until the shared schema plan is accepted. No environment reads, hosted SQL changes, real phone numbers/records or provider sends in development tests.

## Harness ownership and architecture

**Existing `harness/shield/**` is Core 3 lead-owned. Do not modify or relabel it.** New integrated safety acceptance belongs to Phase 5:

- `harness/core1/**`: scripted synthetic Core 1 scenarios and fixture providers.
- `harness/core2/**`: synthetic SOS/watch/safe/reassurance scenarios.
- `tests/acceptance/phase5/**`: combined route → durable database → actual worker/graph → gated outbox → scripted provider → verified callback → signed outcome assertions.
- `docs/phase5/**`: runner instructions, contract mappings, acceptance matrix and checkpoint evidence.

Kiro's Phase 2/3 lower-level suites remain prerequisites: verified ingestion/idempotency/dispatch reconciliation; transaction fencing/authorization/quota/checkpoint restart. Phase 5 composes those implementations rather than copying their predicates or treating fake success returns as durable proof.

Build an injectable scenario runner with explicit controls for clock, request identity, callback verification, provider transport, crash points and concurrent transactions. Exercise real repositories/RPCs in a disposable PostgreSQL environment with synthetic fixtures and rollback/cleanup; tests must never fall back to hosted credentials. Run process A to checkpoint/crash and a fresh process B to resume when claiming cross-process durability. Preserve runtime/checkpoint role least privilege. Request root test-script/manifests changes through integration review.

## Required integrated acceptance matrix

| Scenario | Required assertion |
|---|---|
| Duplicate signed provider callback | One durable normalized event/action; tampered bytes/wrong account/unknown sender rejected |
| Restart/lost commit response | Same request/outbox/timeline identity recovered; no duplicate quota or approval consumption, no double send |
| Revocation before dispatch | New contact/consent/permission refusal invalidates pending send under shared fencing; no stale allow |
| Two-person approval | Two distinct current eligible humans for exact immutable request; self/duplicate/no/wrong-role/changed fingerprint denied |
| Same-family target substitution | Wrong person/medicine/vendor/contact/assignment/call rejected even within the correct family |
| Responder acceptance | Explicit provider proof for exact offered incident/responder accepted once; connected/delivered alone stays pending |
| Core 1 voice | Exact sender/recipient/recording/share consent, expiry and real-recording binding; forbidden object access fails before signing |
| Core 2 SOS replay | Repeated key returns original durable request; changed body conflicts; user/tenant keys do not collide |
| Safe vs timeout | Concurrent safe and overdue tick produce a documented monotonic result; stale task cannot re-escalate resolved watch |
| Missed cron/restart | Due work recovered once with bounded retries; failure is observable and never labelled successfully handled |
| Lease/checkpoint theft | Expired token or second process cannot append checkpoint/timeline/outbox mutations owned by another worker |
| Unknown delivery | Timeout/5xx remains delivery_unknown; no blind resend; only exact persisted reconciliation evidence unblocks |
| Reports/reassurance | Cross-family/revoked/unauthorized contact denied; permitted response excludes private content and unsupported certainty |
| Timeline verification | Real SHA-256/Ed25519 verification, lost-response replay, chain/head mismatch and changed-content dedupe rejection |

Distinguish three evidence levels in reports: unit/contract fixtures, disposable integrated DB/process scenarios, and separately authorized live provider/phone acceptance. Each scenario records passed/failed/blocked/skipped and the reason. No percentage or 100% claim based solely on fixture counts.

## Completion and reporting

First save typed contracts and independent domain/routes/repository tests. Then integrate accepted Kiro/Phase 4 commits through parent-reviewed changes and run the actual combined harness. Save small scoped commits and PRs; no direct main push. `docs/phase5/CHECKPOINT.md` must list base/SHA, commands/counts, SQL/process tests actually run, blocked seams, deployment status and next task.

Phase 5 is complete only after accepted Core 2 server behavior and integrated Core 1/2 acceptance pass on the combined implementation. Live credentials, phone tests or hosted deployment that were not executed remain explicitly unverified; do not infer emergency readiness from green synthetic tests.
