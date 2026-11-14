# Existing Z1/Z2/Z5 integration — draft for Issue #6

This branch extends existing Phase 4 (`82e3ff1`); it does not merge PR #5, deploy, activate a Zap, or replace Phase 2/3. It is a stacked draft for review against `feature/phase4-core1`. Lead/Singhal must reconcile it after PR #3 then PR #4 are accepted. The official repository is public: only source, synthetic fixtures and sanitized findings belong here.

## Implemented versus accepted

| Component | Implemented here | Remaining gate |
|---|---|---|
| Z2 GET /api/zapier/weekly | Server bearer check, fixed server family/parent/requester scope, live child membership, bounded timeline query, reuse of Phase 4 compileFamilyReport, nine derived strings, empty/error responses, no-store | Approve cutoff/privacy contract; configure private scope; merge/reconcile, deploy and observe real authorized HTTP result |
| Z1 | Proposed ten-field contract, committed-source Ed25519/payload-hash verification, real chain_hash, stable event_id, encrypted durable outbox enqueue/replay | Actual owner writes approved post-commit signed errand facts and projection; Lead approves trigger semantics/aliases/permission references; downstream dedupe |
| Z5 | Proposed explicit-time create-only contract; stable event/reminder IDs; no inferred clock/end/offset; same encrypted outbox | Owner-authorized reminder event/projection and explicit approved timing; update/cancel policy still BLOCKED |
| Paperwork delivery | Filtered claim over existing public.outbox; reuse finish_outbox leases/backoff/attempt limits; strict HTTPS hook host/path, one HTTP attempt per claim, no redirects, eight-second timeout; network ambiguity becomes delivery_unknown | Wire runConfiguredZapierTick into existing accepted cron; verify downstream dedupe before retries; all three activation flags stay false |
| Existing Classic Zaps | Authorized browser inspection, preserved IDs/connections/destinations | No configuration edits or action tests made; contracts/deployment still unapproved |

No provider adapter, separate care engine, second queue, second scheduler or public send endpoint was introduced. No manifests, lockfile, Shield/mobile/shared packages or existing care commands were changed. The readiness route signature fix is a backport of the existing main fix needed for Next's generated typecheck; its two tests now supply a Request.

## Z2 server configuration and policy for review

Only environment names appear in .env.example. Set ZAPIER_BEARER through the approved secret store (at least 32 characters), plus approved UUIDs in ZAPIER_WEEKLY_FAMILY_ID, ZAPIER_WEEKLY_PARENT_ID and ZAPIER_WEEKLY_REQUESTER_ID. The last is the live child membership's person UUID. This is one scoped integration token, not a multi-tenant global token. Different families need separately reviewed credentials/scope design. Friendly Sheet IDs are not UUID mappings.

Caller query parameters are rejected; they cannot select family, person or reporting dates. The repository checks the configured parent and live child membership before reading only id/family/type/time from signed timeline rows. It returns no names, free-text timeline, medicines, symptoms, recordings, phone data or metadata. parent_name is the deliberate privacy alias `Parent`; mood remains unavailable, rather than invented. The report covers family activity; it does not establish per-person adherence or actual provider delivery.

Proposed period policy: most recent completed Sunday 20:00 Asia/Kolkata cutoff, seven days, [start,end). Full ISO timestamps are returned in week_start/week_end. A Sunday request before 20:00 refers to the previous completed period. No future events; over 1000 rows returns 503 instead of silently truncating. Error codes are not_configured (503), unauthorized (401), query_parameters_not_allowed (400), scope_unavailable (403), report_limit_exceeded/report_scope_invalid/report_unavailable (503). All responses are no-store. This new GET is separate from the existing authenticated family-report POST command.

## Proposed signed paperwork projection seam

The owning domain handler must first commit its authorized business state and signed timeline event. The producer accepts only family UUID + committed timeline UUID + z1/z5; it reads back the source, validates the Ed25519 envelope and payload hash with an explicitly trusted key, and derives event_id from that timeline UUID. It never signs a replacement hash or accepts an external caller's claim of success. There is no new HTTP enqueue endpoint.

Source names `errand.approved`, `errand.denied`, `errand.completed`, `reminder.created`, and the signed payload's `zapier` object are PROPOSED integration seams, not claims that Phase 4 already emits them. Lead must approve these names and the business meaning before wiring. The existing refill-proposal POST is queued/requested only and must never be treated as an authorized/completed errand.

Z1 signed payload.zapier contains only errand_type=medicine_refill, vendor_label=demo_pharmacy, amount_inr, permission_ref, decision. Metadata is derived by the producer: schema_version=1.0, stable event_id, event_type=errand.updated, occurred_at and actual chain_hash. SQL additionally binds the committed event to same-family errand/action request, permission UUID, approved stored amount_minor and appropriate durable decision/completion state. A denied event without a permission_ref needs an approved revised policy; this implementation fails closed. Demo aliases are intentionally narrow; production label catalogs require review.

Z5 signed projection contains reminder_id equal to the schedule/entity UUID, title=Family reminder, description=Synthetic family reminder, start_at, end_at, timezone and reminder_minutes_before. All times and offsets must be explicitly supplied and approved by the owner. SQL binds the same-family enabled schedule's next_at/timezone. Date-only old proposals cannot be sent. Updates/cancellations are rejected until their Calendar lookup/update/delete semantics and consent/notification policy are approved. Test fixture times are test inputs, not approved demo scheduling values.

The new migration must be reviewed/applied after the combined Phase 2/3/4 schema. It adds paperwork_hash and two service-only RPCs over the existing outbox. Its random encryption nonce does not change the canonical payload hash/event_id on replay. Old unrestricted outbox claimers must not compete with paperwork rows; use the accepted Phase 3 capability-filtered provider claims and this kind-filtered paperwork claim together.

## Delivery and failure semantics

ZAPIER_HOOK_LEDGER and ZAPIER_HOOK_DATES remain server secrets. ZAPIER_CONTRACTS_APPROVED, ZAPIER_DOWNSTREAM_DEDUPE_VERIFIED and ZAPIER_DISPATCH_ENABLED default false. These are release attestations, not substitutes for approval or technical evidence. Do not set them now. SIGNING_PUBLIC_KEY/SIGNING_KEY_ID and WEBHOOK_ENCRYPTION_KEY reuse existing infrastructure. The injected key map supports reviewed historical signing keys; the environment helper currently loads the active key only.

Singhal must arrange durable retry/catch-up from committed source IDs when enqueue fails, and wire runConfiguredZapierTick into the existing cron after care work; no source writer or retry scanner is silently invented here. The helper isolates errors and never returns raw secret/URL/provider/database text. These are genuine wiring dependencies: no automatic production event path is claimed.

Database unique(family_id,dedupe_key), row leases and payload-hash conflict checks prevent duplicate backend work. HTTP 2xx means Catch Hook acceptance only. Explicit non-2xx responses use existing bounded backoff only when downstream dedupe has been independently verified; timeout/network/redirect ambiguity is delivery_unknown and is not blindly retried. A Google Sheets lookup followed by create is NOT atomic and does not by itself prove exactly-once behavior under concurrency. Approve/test a serialized or atomic dedupe design before enabling that flag. Z5 additionally needs reminder_id -> Calendar Event ID tracking for future updates/cancels.

## Validation and release

See VALIDATION.md for exact executed commands and limits. No fixture/unit/SQL/build result is production acceptance. Keep all Zaps unpublished and all real phone/provider tests NOT RUN. Lead approves contracts, projection sources, privacy/period policy and any ledger tracking-column change. Singhal reconciles PR dependencies, hosted migrations, source hooks/catch-up, cron, secure scope/env, routing/deployment protection and deployed commit. Aditya can then finish the existing draft field mappings using EXISTING-ZAPS-AUDIT.md, perform only separately approved synthetic action tests, and collect downstream evidence.
