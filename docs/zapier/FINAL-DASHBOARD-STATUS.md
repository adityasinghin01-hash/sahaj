# Existing Zap drafts — saved configuration, 15 November 2026

Actual authorized edits were saved in the existing Classic editor and reopened after reload. This is configuration evidence, not execution evidence. All three remain drafts/off. No replacement Zap, Classic conversion, account change, publication, trigger/action test, HTTP request, spreadsheet row, Calendar event, document or email was created. The original ledger's data and columns were preserved.

| Zap | Configuration completed | Saved in existing editor | Backend dependency | Remaining blockers |
|---|---|---|---|---|
| Z1, 386748738 | PARTIALLY CONFIGURED: literal values removed; four genuine destination tokens saved | YES; source-step token metadata and empty fields read back after reload | Approved v1 Hook sample; producer integration/deployment | Four missing source fields, timestamp parsing/reporting timezone, atomic destination dedupe; NOT TESTED |
| Z5, 386750124, still named Untitled Zap | Required Calendar field bindings configured; PARTIALLY CONFIGURED as an integration | YES; corrected title/start and preserved end/description/minutes tokens read back after reload | Approve explicit-time contract and deploy producer | Contract, durable identity/dedupe, update/cancel policy and controlled tests; NOT TESTED |
| Z2, 386754760 | PARTIALLY CONFIGURED: safe GET header, template, PDF export, name prefix and email text; unused Formatter removed | YES; graph and configured values persisted after reload | Approved deployed weekly route, secure bearer and genuine GET result | Nine response bindings, title/subject suffix, PDF attachment output, approved recipient and privacy/output checks; NOT TESTED |

None is FULLY CONFIGURED or READY FOR CONTROLLED TESTING yet. All are BLOCKED BY CONTRACT and BLOCKED BY DEPLOYMENT for backend acceptance. A green editor Configure check or old sample preview is not a successful action run.

## Z1 — original SAHAJ LEDGER / ERRANDS

Existing Google Sheets account was compared privately before/after and matched. Drive, spreadsheet and worksheet selections are unchanged. No Event_ID column was added.

| Field | Saved state | Source / exact remaining work |
|---|---|---|
| Formatter Input | Blank; literal 2026-11-14 removed | Hook `occurred_at` is unavailable in the current sample |
| Formatter To Format | YYYY-MM-DD preserved | Intended display only; date processing not accepted |
| Formatter From Format, From/To Timezone | Legacy YYYY-MM-DD and UTC preserved | Approve full timestamp parsing and reporting zone before execution; preserving these is not a new UTC policy approval |
| Sheets Date | Genuine Formatter Output token | Source step 386748739, `output`; old displayed sample is cached, not a new date result |
| Errand | Blank; literal removed | Await Hook `errand_type` |
| Vendor | Blank; literal removed | Await Hook `vendor_label` |
| Amount_INR | Genuine Hook token | Source 386748738, `amount_inr` |
| Permission_ID | Blank; literal removed | Await Hook `permission_ref`; never substitute the friendly sample permission number |
| Decision | Genuine Hook token | Source 386748738, `decision` |
| Chain_Hash | Genuine Hook token | Source 386748738, `chain_hash`; cached DEMO_NOT_A_REAL_SIGNATURE is synthetic sample content, not a literal binding or verified signature |

The available Hook sample has only `event_date`, `errand`, `vendor`, `amount_inr`, `permission_id`, `decision`, `chain_hash`. Missing `occurred_at`, `errand_type`, `vendor_label`, `permission_ref` were checked in the picker. No old-name substitution, typed token syntax, sample refresh or webhook replay was used. Actual producer types and IDs still require approval.

Historical Request A remains PASS for Catch Hook receipt/extraction ONLY. Formatter, Sheets row creation and end-to-end Z1 are unverified. The old sample badge is not new execution evidence.

## Z5 — original Sahaj Demo Reminders

Existing Calendar account was privately compared before/after and matched. Calendar selection is unchanged. The user confirmed this existing Untitled Zap is Z5; it was not renamed or recreated.

| Calendar field | Saved state / source step 386750124 |
|---|---|
| Summary | Corrected from `start_at` to genuine `title` token |
| Description | Genuine `description` token preserved |
| Start Date & Time | Corrected from date-only Formatter output to genuine `start_at` token, preserving the complete ISO timestamp and offset |
| End Date & Time | Genuine `end_at` token preserved |
| Minutes Before Reminders | Actual numeric field exists; genuine `reminder_minutes_before` token was already present and is preserved; existing sample preview 1440 was not invented or entered |
| Reminder method / defaults | Popup / Use Default Reminders No preserved |
| All Day / conferencing / attendees | No / No / empty preserved |
| Visibility | Private preserved |

The unused legacy date Formatter is retained but bypassed by Calendar start/end. Its output no longer strips the event start time. No new time, duration, offset or timezone was invented. The supplied earlier date-only `due_date` contract is insufficient for these explicit timestamps: Lead/Singhal must approve which final contract applies. Numeric reminder support is verified in configuration, not reminder delivery.

## Z2 — existing Sunday 20:00 Asia/Kolkata schedule

Saved graph: Schedule -> Webhooks GET -> Google Docs Create Document From Template -> Gmail Send Email. Other step IDs remain: GET 386754761, Docs _GEN_1794674561698, Gmail _GEN_1794674561699. Blank Capitalize Formatter _GEN_1794674561697 was removed using a narrowly constrained Copilot edit after the direct Delete control failed. The resulting graph and absence of that step persisted after reload. A recoverable checkpoint was created; no test or unrelated step change was requested.

| Field | Actually saved / blocked |
|---|---|
| GET Headers | `Accept: application/json` saved |
| GET URL | Blank; no assumed deployment/base URL entered |
| Authorization / Basic Auth / query | No bearer or fake credential entered; Basic Auth/query remain blank. Singhal must confirm deployed route, server scope and legitimate routing, then the owner configures the matching bearer securely |
| Template Document | Selected the existing private native document titled SAHAJ, whose content is Maa Ka Hafta / Weekly Family Care Report. Matched the private file ID through authorized Drive read and the native picker; private file identifier is intentionally omitted here |
| New Document Name | Saved static prefix `Sahaj Weekly Report — `; parent/date suffix remains blocked by missing genuine GET tokens |
| Export Formats | PDF selected in the existing Docs action; no additional export action created |
| Placeholder inputs | All nine fields exposed by the selected template, left unmapped because the GET picker says complete the source step before its data is available |
| Gmail Subject | Saved static prefix `Sahaj Weekly Care Report — `; date suffix blocked |
| Gmail Body | Saved plain text below; dynamic weekly summary blocked |
| Gmail To/Cc/Bcc | Empty; no approved test recipient supplied |
| Gmail Attachment | Empty; Docs picker also requires the source step to be completed. No genuine PDF file token is available yet; no document URL substituted |

Required one-to-one Docs mappings, once genuine source tokens exist: `week_start`, `week_end`, `parent_name`, `checkin_summary`, `mood_summary`, `medicine_summary`, `errand_summary`, `alert_summary`, `weekly_summary`, each from GET step 386754761. No fake variables or typed internal Zapier references were inserted. Final document name adds parent_name, week_start and week_end; subject adds week_start and week_end; append approved weekly_summary to the body.

Saved email body:

```text
Hello,

Please review the weekly care report for check-ins, medicine updates, errands and alerts.

Regards,
Sahaj
```

Docs connection privately compared equal before/after; Gmail connection was not changed. Existing root output folder preserved. The template's source visibility was private/not shared. Sharing Preference remains blank: the actual menu only offers link/organization sharing modes, so none was selected. Before an authorized synthetic document run, confirm root-folder inheritance/private output and define safe unused-field handling. Do not assert generated-document privacy, PDF contents or delivery before evidence.

## Durable identity, duplicates and recovery — design still awaiting approval

Z1 requires immutable `event_id`, canonical payload digest and an atomic unique claim in a durable owner-approved store. Same ID/same content is a replay; same ID/different content is a conflict. A Sheets lookup then Create Row is not atomic and cannot establish exactly-once output. Serialize per destination, persist pending/completed state and row identity, and reconcile an ambiguous write before retrying. A crash after a Sheets write but before completion must not blindly create another row. Do not enable dispatch until this gap and original-sheet tracking changes are approved and tested.

Z5 similarly needs immutable delivery `event_id`, stable `reminder_id`, digest/state and returned Calendar Event ID stored durably. Same event replay must resolve to the recorded result. Different update/cancel events address the same reminder/Event ID using approved Update/Delete actions/policy; never another Create action to simulate them. Concurrent duplicate and ambiguous-success recovery need evidence. No tracking store, column, update/cancel action or claim of working dedupe was added here.

## Rollback and evidence

- The preceding EXISTING-ZAPS-AUDIT.md snapshot records the exact prior configuration. Z1 rollback would restore the seven old synthetic literals and Formatter literal; this recreates known defects and is only a recovery reference. Do not run/publish that rollback. Current intended configuration is the dynamic/blank state above.
- Z5 rollback: Summary -> Hook start_at; Start -> Formatter Output; Description/end/minutes and calendar/account were not changed. These old Summary/Start bindings are known defects.
- Z2 rollback: recover the checkpoint immediately before the isolated Formatter deletion to restore that exact existing step, then clear the newly configured Accept header, Docs template/name/PDF, Gmail subject/body if a complete baseline restore is required. That checkpoint was after the Docs selections; it does not undo them. Use native change history/versions for earlier states and inspect the restored draft before any action. Do not create a replacement Zap or regenerate IDs.
- Readback inspected real mapping chips and their source-step metadata, not just visible example values. Each edited Zap was reloaded/reopened and remained Draft/off. Destinations and private account comparisons above were verified. No secret or private Hook URL is in this evidence.
- Three local configuration screenshots were saved and visually reviewed: Z1 saved draft, Z5 corrected Summary/calendar, Z2 graph after removal. These support configuration inspection only. Private browser artifacts remain outside the public repository; this sanitized field-level readback is the committed evidence.

## Smallest remaining handoff

1. Lead/Singhal approve final schemas, Z1 parsing/reporting zone, Z5 explicit time/reminder/update/cancel policy, weekly window/privacy and durable destination dedupe.
2. Singhal reconciles and deploys the reviewed backend with actual source/cron/catch-up wiring, approved migrations/env scope and legitimate external routing; supply deployed SHA and sanitized readiness evidence. Vercel READY alone is insufficient.
3. Authorized owner configures the real weekly URL/bearer privately. Supply an approved synthetic source record through a separately authorized process so missing genuine tokens can be selected. Complete Z1's four mappings and Z2's nine mappings/name/subject/body/PDF, approve a synthetic test inbox and verify private output.
4. Obtain separate controlled-test authorization: GET/auth/empty/error cases, Z1 one-row/replay/concurrency recovery, Z5 timing/offset/identity/replay, and Z2 actual private PDF attachment to the approved inbox. No action test occurred in this task.
5. Review evidence and request explicit publication approval. All existing drafts stay off until then.
