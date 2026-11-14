# Phase 3 implementation contract review

Reviewed the root checkout's four existing migrations, `packages/gate/src/index.ts`, `packages/atlas/src/index.ts`, provider-ingestion identity/envelope storage, media contracts/consent helpers, and signed timeline append SQL. This is a local source review, not a new cloud verification. Kiro owns implementation in its assigned worktree. Preserve explicit deny when facts are missing.

## Existing durable records: use these actual fields

| Record | Existing fields that matter | Missing facts; do not invent a mapping |
|---|---|---|
| `family_memberships` | `(family_id,user_id)` PK, unique `(family_id,person_id)`, `role` = parent/child/circle, `revoked_at` | No `active` or `can_approve` boolean; derive from current nonrevoked membership and an explicit approved-role rule. Never JWT user metadata. |
| `people` | UUID `id`, `family_id`, role parent/child/circle/vendor | No AI/service actor record or authorization flag. Being a person alone proves neither active membership nor approver eligibility. |
| `permissions` | UUID `id`, `family_id`, `person_id`, `action`, `decision` allow/deny/ask, `limits` JSONB, `expires_at`, `revoked_at`, `consent_id`, `two_person_required` | No `actor_id`, `valid_from`, usage counter/window, target/vendor/item columns. `person_id` is not documented as an AI actor. Define its subject/actor semantics explicitly before mapping. `limits={}` is not unlimited permission. |
| `action_requests` | UUID `id`, `family_id`, `person_id`, nullable `permission_id`, `action`, status pending/approved/denied/expired/executed/failed, `expires_at`, `two_person_required`, `created_at` | No amount/vendor/items/target/fingerprint/consumption field. An `approved` status alone cannot authorize an arbitrary replacement payload. |
| `action_answers` | PK `(family_id,action_request_id,approver_person_id)`, boolean `answer`, `answered_at` | No standalone UUID, expiry, revocation, fingerprint, permission reference, or consumed flag. Composite uniqueness prevents duplicate person rows, but does not establish live authorization. |
| `consents` | UUID `id`, `family_id`, `person_id`, nullable `call_id`, `turn_id`, `purpose`, `question`, boolean `answer`, `version`, `created_at` | Append-only trigger forbids UPDATE/DELETE. No `target_id`, `expires_at`, `revoked_at`, or `scope` column. Refusal is a later `answer=false` row, not an UPDATE. |
| `workflow_jobs` | UUID `id`, `family_id`, `raw_event_id`, `thread_id`, `workflow_kind`, state pending/processing/interrupted/completed/failed/dead, `checkpoint_ref`, `interrupt_ref`, attempts/retry/lease fields, `resume_payload_ciphertext` | No built-in actor/target/action-request binding. Add a narrow immutable binding if not derivable from verified durable records. |
| `outbox` | UUID `id`, `family_id`, nullable `workflow_job_id`, nullable `action_request_id`, `kind`, `dedupe_key`, `payload_ciphertext`, status/attempt/retry/lease/error fields, `reconciliation_event_id` | Unique `(family_id,dedupe_key)` already exists. No current quota reservation or transaction binding to approved immutable action contents. |
| `raw_events` | `family_id`, `source`, `provider_event_id`, `event_type`, `metadata`, `payload_hash`, `payload_ciphertext`, status/lease fields | Event verification is an ingestion invariant, not a `verified` column. `status='processed'` alone proves neither successful delivery nor responder acceptance. |

All related public domain rows have tenant-composite foreign keys where declared. Keep every repository read/write explicitly scoped by family; a UUID alone is not an authorization boundary. `assignments.verified_by_provider_event` already has a family-composite FK. Runtime checkpoint role owns only `sahaj_checkpoints`; do not grant it public application tables to make a repository query work.

## Cedar translation must be exact and fail closed

`GateRequest` requires immutable `id`, `familyId`, `action`, `targetId`; optional integer minor-unit amount, vendor, item IDs and consent subject. A refill requires explicit amount, vendor and nonempty items. `targetId` means the durable recipient/subject for this exact action, never a phone number. For a voice post the sender/consent subject and recipient target can differ; for a recording the call's person and call scope must be proven separately.

`SetupPermission` needs an explicit actor, target/vendor/item allowlists, amount limit, valid-from/expiry, a finite period and authoritative use count. These do not currently exist as typed SQL columns. Add only the narrow fields/ledger or validated versioned `limits` contract required by the supported implementation. Reject unknown limit versions, missing keys, negative/fractional/unsafe integers, malformed dates, zero-length validity, wrong action/actor/family/target. Never use `[]` as wildcard, `Infinity`, synthetic far-future expiry or `usedCount=0` as a fallback for an absent record. Keep exact integer bounds safe in both PostgreSQL and JavaScript.

Check `permissions.decision` before constructing candidate allows. A database deny/ask row must not become an allow merely because `SetupPermission` has no decision property. If overlapping grants/denials exist and precedence is not defined, deny/review rather than picking a convenient allow. A preapproved refill within explicit limits may use `approvalMode='setup'`; do not require two people for every refill. `two_person_required=true` on permission or action request must never be downgraded to setup.

Do not infer an AI actor's active membership from the parent's membership or reuse the target's person ID as actor. Choose and document a server-owned principal binding with explicit setup permission; keep it distinct from the two human approvers. If that binding is not implemented, return review instead of claiming actor authorization.

The actual Cedar engine remains authoritative for the app-side policy evaluation. A SQL `p_allow=true`, client-supplied `GateInput`, or homemade TypeScript evaluator is not an alternative to the fixed real Cedar policy.

## Approval binding and consumption

Persist the immutable request being approved before recording answers. Use `requestFingerprint()` from the package; its bytes are SHA-256 over `JSON.stringify` with the exact property order: `id,familyId,action,amountMinor,vendorId,itemIds,consentSubjectId,targetId`; amount defaults to 0, vendor/consent/target missing string defaults are empty, item IDs are deduplicated then sorted. Do not assume PostgreSQL `jsonb::text` produces identical canonical bytes. Persist/verify server-generated canonical bytes or implement and test exact parity.

Approvals must reference that request's current fingerprint and selected permission. `action_answers` lacks these fields: bind answers through an immutable fingerprinted action-request record, or add a narrow explicit binding. Exclude false answers; an explicit rejection of the current request must not be silently treated as a missing yes. Require two distinct currently authorized humans in the same family, neither the acting principal. Resolve `approver_person_id` through current `family_memberships`, including revocation. A `circle` role is not an approver by default merely because it exists; encode the authorized role rule explicitly.

Gate approval IDs cannot be fabricated as random new IDs on each read. If mapping the existing composite PK, use one deterministic opaque composite identity or add a genuine ID field. Expiry must be explicit and no later than the request/permission window; `answered_at` is the grant time. Existing rows have no separate revoked field: a change/revocation must have an authoritative durable representation and invalidate the snapshot. No request-id-only replay across changed amount/items/vendor/target/subject.

Consume/reserve approval capacity in the same transaction as the outbox insert. Existing status `action_requests.executed` can serve as a single-use boundary only if documented as “authorization committed for this outbox,” uniquely linked to that outbox; it must not falsely claim provider execution succeeded. Otherwise add a narrow reservation link/state. A failed/unknown provider attempt must not make the same approval reusable for a second distinct action.

## Atomic enqueue protocol

The invariant is one committed outbox intent, one quota reservation and one approval consumption for one immutable request. JS reads followed by a bare insert do not meet it.

1. Validate current workflow ownership and **unexpired lease token**. Acquire the workflow row plus shared authorization/permission/usage/request locks in a deterministic order. Every mutation in a running workflow must be fenced; `finish_workflow_job` fencing alone does not stop an expired worker from inserting an outbox row.
2. Recover `(family_id,dedupe_key)` first. Verify its job, action-request, action kind and immutable payload identity match this operation, then return the existing row without charging quota or requiring already-consumed approvals again. A same-key changed payload is a conflict. Randomized encryption produces different ciphertext on a retry, so compare a durable plaintext-envelope hash/canonical identity, not ciphertext equality.
3. For a genuinely new intent, read current memberships, permission/decision/limits, vendor approval/revocation, request/fingerprint/expiry, effective consent history and human answers under the transaction protocol. Use a single trusted database time for all final validity/period checks, with exclusive end boundaries (`now < expiry`, `usedCount < maxUses`). Model output and request-body booleans are never authority.
4. Require a genuine Cedar allow on **those same facts**. With Supabase REST RPCs, locks cannot span two HTTP calls. A workable narrow design is server-produced Cedar evaluation plus a service-only commit RPC that locks/reloads all authoritative facts, validates an exact snapshot/revision token and all final safety bounds, and rejects changed facts. If the snapshot changed, reload and rerun Cedar; do not accept a stale allow. Alternatively, run server-side Cedar while holding the same database transaction on a properly scoped application DB connection. Do not widen the checkpoint role for this.
5. The database must check quota and atomically create one durable period-scoped reservation. Count an existing reservation once even after lost responses. Two concurrent jobs using a single-use permission must result in exactly one committed new outbox. Period boundaries must be explicit, timezone-defined where calendar-based, and not recomputed ad hoc from local server time. Avoid unconditional counter increment plus `ON CONFLICT DO NOTHING`, which still charges a retry.
6. Insert the unique outbox intent, link the action request/reservation/approval consumption, and commit together. Every exception rolls all those changes back. Return review/deny with zero external effects if facts cannot be proven. Provider dispatch happens in the separate worker, with its own lease fencing.

Membership/permission/consent mutation paths must use the same serialization convention. Locking existing consent rows alone does not prevent a concurrent newly inserted refusal (a phantom). Use a stable parent/request/scope lock shared by the append path, or a correctly tested serializable/CAS protocol including the effective consent revision. Likewise, snapshot validation must detect newly inserted deny rows/answers, not just changes to the previously chosen rows. This matters more than the name of the RPC.

Document the boundary after commit: revocation can occur while an authorized command waits for dispatch. The dispatch contract must recheck current consent/permission immediately before a fresh provider attempt where applicable. An already accepted external action cannot be retroactively unsent. Never automatically resend `delivery_unknown` without persisted provider reconciliation proving not sent.

## Existing consent semantics and media

Consent is not normally a consumable once-only token: it is a purpose/version/subject/scope-bound grant whose effective state must remain current. Do not delete, mutate or mark the append-only `consents` row consumed just to implement approval consumption. Preserve consent evidence with the outbox/media action and recheck effective consent when reading or dispatching.

Current media uses `purpose='call_recording'` for the exact call and `purpose='voice_share:<recipient UUID>'` for sharing. There is no target column. Use the recipient-specific purpose to prove target binding; do not map generic `share_data` to every recipient. For call consent, only the exact call's yes/no and global (`call_id IS NULL`) refusals apply. Other-call grants and global affirmations do not restore a revoked call grant. Latest relevant refusal wins timestamp ties. Never decide consent by `some(answer=true)` or ignore truncated history.

`GateConsent`'s `grantedAt/expiresAt/revokedAt/scope/targetId` is an adapter projection, not the SQL table shape. A configured, documented maximum age or a new explicit validity field is needed to supply finite expiry; do not invent a 2099 date. Keep the current consent-version requirement. The permission's `consent_id` itself must also be current for its intended purpose, not only a valid FK.

The gate currently supports care action enums, while media asks `read_voice_media` / `read_call_recording`. Implement a separate fixed real-Cedar policy for those exact read operations with proven membership/subject/recipient/consent/object facts, or a rigorously documented equivalent supported contract. Do not cast arbitrary strings into `GateAction`, manufacture dummy setup permissions, or return allow because a fact object exists. Preserve current object path/bucket/expiry checks and the maximum 60-second signed URL. Revalidate consent as close to URL issuance as possible; already issued signed URLs remain usable until expiry, so document that bounded revocation window.

## Existing workflow and evidence boundaries

`claim_workflow_jobs` already supplies token/expiry with `FOR UPDATE SKIP LOCKED`. `finish_workflow_job(job,token,state,checkpoint_ref,interrupt_ref,error)` only changes the active unexpired token; check its boolean result. `resume_workflow_job(job,family,expected_interrupt_ref,encrypted_payload)` already CASes an interrupted job but explicitly relies on server verification before invocation. A wakeup is not an approval. Authenticate family/actor, validate exact outstanding interrupt and current authorization/evidence first. Graph `resume` accepts scope only and reloads facts.

`createAtlas.start` returns an existing checkpoint unchanged; use `resume` to continue unfinished/error checkpoints. A graph interrupt is a successful durable pause, not a completed care action. Persist checkpoint/interrupt references before finishing the job as interrupted. A stolen/expired lease may not resume or mutate another worker's checkpoint. A recoverable cross-process lock/lease must fence checkpoint writes or guarantee that a live old worker cannot continue after takeover; a process-local mutex is insufficient.

`outbox.status='completed'` currently means the delivery worker completed its action, not necessarily end-recipient delivery, hearing or acceptance. For `observeDelivery`, read verified persisted proof bound to exact family, provider account, action/outbox, intended person and incident/call/assignment. `calls.status='completed'` alone is never a responder acceptance proof. `assignments.status='accepted'` already requires `accepted_at` and `verified_by_provider_event`, but inspect that event's semantic and identity bindings too. The current reconciliation RPC only checks limited metadata; do not mistake that minimum for sufficient acceptance semantics.

For timeline writes, use the existing real SHA-256/Ed25519 signing code and `append_timeline_event`; the SQL enforces head CAS and exact dedupe-envelope equality. After an uncertain append response, look up the stable dedupe key and verify the persisted semantic outcome first. Re-signing a retry with a new event UUID/time/head under the same dedupe key will intentionally conflict. Only retry a new signed envelope after proving no append committed and refreshing the family head. Never label a queued command delivered or accepted.

## Minimum adversarial tests for the new subset

- Two concurrent jobs, final quota slot: one outbox/reservation wins; quota never exceeds the period limit.
- Lost commit response, graph reconstruction and duplicate wake: same outbox ID, quota/approvals charged once; changed payload under the same key conflicts.
- Revocation or changed limits/target/amount after Cedar read but before commit: stale authorization rejected, no row/usage consumed.
- New refusal/deny inserted during authorization: snapshot/locking protocol catches the phantom; same-timestamp refusal wins.
- Wrong tenant actor/target/approver/vendor/medicine/request/outbox/raw event; inactive membership; wrong action; missing limits; expiration exactly now.
- Setup refill at the allowed amount and once/calendar period passes; second use, overlimit and unrelated vendor/item fail. Two-person mode cannot be downgraded.
- Duplicate/self/wrong-role/revoked/expired/false answers, changed request fingerprint, request already reserved for another outbox: no dispatch.
- Stale workflow/outbox lease and wrong interrupt CAS: no mutation; `delivery_unknown` cannot auto-resend.
- Delivered call without identity-bound verified acceptance remains pending; foreign/replayed provider proof cannot complete an incident.
- Genuine Cedar error/ask/missing media consent denies before storage calls; short-lived URL and cross-recipient consent tests remain intact.
- Timeline lost-response recovery returns the committed entry; head races retry safely without conflicting duplicate outcomes.

Local mocks demonstrate code contracts only. Record actual database transaction/concurrency test results separately; do not claim real-provider, real-phone or production workflow success from fixtures.
# Required integration review

Before your final checkpoint, also read `D:/Projects/SAHAJ/coordination/PHASE2-3-INTEGRATION-REVIEW.md`. It records concrete cross-worker contract and security blockers found in the draft migrations, including acceptance-proof event mismatch, explicit deny precedence, revocation fencing and approval binding. Resolve these in your owned files and flag other-worker dependencies; do not apply drafts remotely.
