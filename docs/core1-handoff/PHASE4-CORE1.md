# Phase 4: Core 1 Pulse — Aditya Singh

Read [START-HERE](START-HERE.md) for repository branches, authoritative documents, ownership and database restrictions. Implement a reliable demonstrated Core 1 before expanding optional features. No mobile/Shield/LLM/shared edits.

## Existing building blocks and missing integration

Foundation already supplies bearer-verifiable Supabase access, encrypted raw-event ingestion, leased raw events/workflow jobs/outbox, purpose-scoped consent history, private media signing, SHA-256/Ed25519 timeline functions and a real LangGraph/PostgresSaver graph. Existing API routes cover health, providers, cron and media; they do not constitute complete Core 1 command/features.

`packages/atlas/src/index.ts` defines `AtlasPorts`: loadJob, understand, loadGateInput, enqueueAuthorized, observeDelivery, appendSignedOutcome and withJobLock. Its graph recognizes check_in/urgent_responder/voice_message/medicine_refill/missed_call_nudge/send_alert/family_report/record_audio/share_data. Do not bypass it with direct provider fetches. Kiro Phase 3 owns the actual durable runtime adapter; Phase 2 owns dispatch/provider reconciliation/recording retrieval. Read their current contracts before finalizing feature DTOs.

Real seams to settle with Kiro:

- **Principals:** a `people` row is not an AI/service actor or an active authenticated member. Use explicit server-managed principal setup and the canonical membership mapping; do not fabricate active actors, permission grants or approvals.
- **Understanding:** only protected, consented content reaches the structured-understanding boundary. Persist actual action/request/target binding and uncertain/review outcomes; a model's `verified`/`accepted` field grants nothing. Sarvam check-ins need the consented encrypted call content path, not WhatsApp-only text extraction.
- **Incident setup:** Phase 4 creates incident and offered assignments, request linkage and escalation policy. Agree on the immutable family/person/incident/assignment/call/outbox/action_request association before Phase 2 dispatch can produce acceptance proof.
- **Permissions:** actual `permissions`/`action_requests`/`action_answers` fields differ from pure Cedar types. Load Kiro's accepted projection and atomic commit API; never cast unsupported actions or create dummy permissions to pass the gate.

## Implement in this order

### 1. Secure command entry and onboarding prerequisites

Add routes under `/api/core1/**` with typed handlers/repositories under the owned directories. Suggested resources: `check-ins`, `urgent-help`, `voice-messages`, `refill-proposals`, `alerts`, `reports`; finalize exact paths in an API contract before implementation. These are proposed Core 1 routes, not claims that the current child app calls them.

Every mutation: Auth `getUser` verification; explicit family selection when multiple memberships exist; current membership and permitted role; strict bounded request schema; every referenced object scoped to family and intended subject; actor from server records; scoped idempotency by family + actor + client key; changed-body conflict; encrypted durable input before 202. Return queued/requested only. Unknown fields, contradictory aliases, missing principals/configuration and ambiguous memberships fail closed. No user/model-supplied authorization booleans.

Validate incident IDs as well as person/medicine/vendor/reply/consent IDs. A medicine must belong to the intended subject, not merely the same family. Reject cross-tenant/remote/encoded-traversal media paths and prove their stored object/owner binding. Circle capabilities need an actual current approved/consenting circle record and action scope.

### 2. Daily Hindi check-ins

Implement local-time schedules with explicit timezone, quiet windows, duplicate-safe occurrences, cancellation, missed cron recovery and bounded retry/backoff. Define DST/nonexistent/ambiguous local-time policy even when the demo uses Asia/Kolkata. AI disclosure precedes AI speech. Recording and sharing require their distinct current consent. Persist call attempts and outcomes; uncertainty/no answer is not a completed wellbeing check. Report what was actually observed without diagnosis.

### 3. Urgent responder chain

Create tenant-scoped incidents and ranked offered assignments; support decline, timeout, alternate responder, accepted promises, overdue promises, reopening and escalation. Define monotonic transitions and allowed exceptions. A connected/completed call or queued alert never establishes acceptance.

Consume only persisted normalized `responder.accepted` proof tied to exact family, incident, assignment, responder, call/account, outbox and action request. Acceptance must come from that offered responder's verified explicit response. Bind `verified_by_provider_event`; reject same-family substitutions and replay from an older offer. Emergency status remains pending/escalating until evidence supports the stronger state.

### 4. Real two-way family voice

Route genuine consented family recordings through existing private media and dispatch contracts. Preserve AI disclosure for AI narration, never clone/impersonate a family voice. Reply recording requires explicit consent. Bind sender/recipient/object/reply, use recording/share purposes correctly, enforce retention/MIME/size and maximum 60-second signed URLs. Signed URLs may remain usable until expiry after revocation; document this bounded window. A delivery receipt does not prove listening; only supported verified evidence may mark heard.

### 5. Medicine and refill proposals

Use confirmed medicine/count/dose inputs; bounded nonnegative inventory and positive quantities. Distinguish missed/double-dose uncertainty from inventory updates and treatment advice. A refill proposal requires explicit item IDs, approved vendor, integer minor-unit amount and target; pass exact immutable request through Cedar and two-person mode when required. Reserve quota/approvals atomically with one outbox; uncertain delivery does not free approval for a second send. No autonomous payment or medical recommendation.

### 6. Nudges, alerts and reports

Group missed calls per registered person/family with provider-ID dedupe, explicit time windows and ordering; late events must not corrupt a newer group. Use existing TeleCMI event processing instead of a second poller. Reports use authorization- and consent-aware redacted signed timeline projections; do not expose transcript, contacts, human_line or private object paths through broad family membership. Alerts must distinguish queued/sent/delivered/verified-accepted.

## Durable repository contract

Use actual records: calls, consents, schedules, requests, incidents, assignments, voice_posts/private voice_content, medicines, vendors, nudges, child_alerts; add only justified Phase 4 fields/tables in the owned migration. Preserve composite tenant foreign keys and service-only writes. Consents are append-only: later refusals revoke, ties prefer refusal; exact call + global refusals for recording, `voice_share:<recipient>` for sharing. Do not invent a consent expiry/target column or infer permission from an old yes.

Each repository mutation and outbox write must be fenced by the current unexpired workflow lease. Use Kiro's atomic authorization/outbox path, shared revocation lock/snapshot protocol and stable replay hash. Provider uncertainty remains delivery_unknown until verified reconciliation proves delivered or not sent. Timeline replay must recover the identical immutable committed entry after a lost response; no freshly timestamped conflicting re-sign on retry.

## Acceptance matrix

| Area | Minimum meaningful proof |
|---|---|
| Commands | Real handler + repository contract tests: invalid auth, revoked/multiple membership, role restrictions, unknown fields, cross-family AND same-family wrong-subject references, changed payload/key conflict, persistence failure never 202 |
| Scheduling | Duplicate tick, concurrent tick, missed tick/restart, quiet window/DST boundary, bounded retries and cancellation produce one durable occurrence/action |
| Urgent | Wrong incident/responder/call/account/offer proof rejected; connected-only stays pending; explicit verified acceptance works once; timeout/decline/overdue escalation/reopen survive restart |
| Voice | Refusal/revocation/recipient substitution/traversal/expired object fail before storage/dispatch; consented real-recording/reply flow through ports; receipt does not imply heard |
| Refill | Under/over-limit, item/vendor/subject substitution, distinct human approvals, quota final-slot race, retry after lost commit charges once; no payment |
| Reports/nudges | Duplicate/late missed calls grouped correctly; revoked access and private content hidden; redaction retains verifiable permitted status |
| Durability | Actual disposable PostgreSQL transaction/concurrency tests and two-process restart tests through integrated runtime, not only in-memory predicates |

Run focused API/Atlas tests and typechecks using the existing workspace toolchain; run API production build after route changes. Add rollback-only `phase4_core1.sql`. Put any required cross-lane wiring in `docs/phase4/INTEGRATION.md` and checkpoint evidence in `docs/phase4/CHECKPOINT.md`. Provider phone tests and joined-schema deployment must remain explicitly pending when not executed.
