# Existing Classic Zap inspection and exact changes to review

Latest update, 15 November: the subsequent FINAL ZAPIER DASHBOARD COMPLETION instruction explicitly authorized safe proposed draft edits before contract approval. Those edits have now been saved and read back in the SAME existing Classic Zaps. See [FINAL-DASHBOARD-STATUS.md](FINAL-DASHBOARD-STATUS.md) for the current field-level evidence, blockers and rollback. The sections below preserve the pre-edit inspection baseline; their "not edited" statements describe that earlier snapshot only. The user confirmed Untitled Zap 386750124 is Z5. Its numeric reminder field was later found and verified as an existing genuine reminder_minutes_before token, correcting the earlier limited inspection. No action tests or publication occurred.

15 November 2026: authenticated browser inspection succeeded after the user signed in. No Zapier MCP tools were exposed; plugin discovery returned no Zapier plugin. A native Windows automation attempt failed before useful input; supported in-app browser access then worked. Dashboard showed exactly three unpublished/draft Zaps. No new workflow, connection, spreadsheet, calendar, publication, action test, email, reminder or webhook request was created.

| Workflow | Existing ID | Observed |
|---|---|---|
| Sahaj Z1 — Errand Ledger | 386748738 | Catch Hook -> date Formatter -> Create Spreadsheet Row; draft |
| Untitled Zap (existing Z5 candidate) | 386750124 | Catch Hook -> Date/Time Formatter -> Google Calendar Create Detailed Event; Sahaj Demo Reminders selected; draft. User may confirm/rename later; not renamed here. |
| Sahaj Z2 — Weekly Care Report | 386754760 | Sunday 20:00 Asia/Kolkata schedule -> GET -> Text Formatter -> Google Docs template -> Gmail; draft with four incomplete steps |

## Z1 exact observed bindings and migration

Preserve the existing Google account, My Google Drive, SAHAJ LEDGER and ERRANDS worksheet. Do not recreate/overwrite the spreadsheet or repoint to the new QA dataset. The seven action fields currently contain literal sample values: Date=2026-11-14, Errand=Medicine refill, Vendor=Gupta Medical, Amount_INR=350, Permission_ID=12, Decision=approved, Chain_Hash=DEMO_NOT_A_REAL_SIGNATURE. The Date DOM has plain text with no mapping token. Formatter Input is also the literal 2026-11-14, To/From Format YYYY-MM-DD, To/From Timezone UTC. These are configuration defects, not successful dynamic integration.

After the Lead approves the proposed v1 contract, replace literals using the existing step editor:

| Existing target | Required dynamic source |
|---|---|
| Formatter Input | Catch Hook occurred_at |
| Formatter From format/timezone | Approved ISO timestamp parsing, UTC input for producer timestamps |
| Formatter To format/timezone | YYYY-MM-DD; approve ledger timezone (proposed Asia/Kolkata) |
| Date | Formatter Output, not a typed example date |
| Errand | Catch Hook errand_type, optionally approved friendly-label formatter |
| Vendor | Catch Hook vendor_label, optionally approved alias display |
| Amount_INR | Catch Hook amount_inr as number; no hardcoded amount |
| Permission_ID | Catch Hook permission_ref; do not substitute friendly permission 12 for a real backend UUID |
| Decision | Catch Hook decision |
| Chain_Hash | Catch Hook chain_hash, never a demo placeholder |

event_id is missing from the existing sheet. Do not add Event_ID or other columns until authorized. Approve a durable unique-ID/serialization design, then map the same immutable event_id, reject conflicting reuse, replay the same event and prove exactly one final row, including concurrent retry behavior. Lookup-then-create alone is not atomic. Do not enable dispatch/retry until verified. Historical Request A PASS remains Catch Hook receipt/extraction ONLY; no Formatter/Sheet/full integration PASS.

## Z5 exact observed bindings and migration

Preserve existing ID 386750124, Google account and Sahaj Demo Reminders calendar. Current Summary is incorrectly mapped to Catch Hook Start At (sample 2026-11-20T10:00:00+05:30). Description maps to Catch Hook Description. Start Date & Time maps to Formatter Output containing only 2026-11-14, whereas End Date & Time maps to Catch Hook End At (sample 2026-11-20T10:15:00+05:30). All day=No, conferencing=No; no attendees. Reminders includes an empty item and Popup; no approved numeric offset was observed. No calendar timing was tested.

After approved explicit-time contract and sample are available: Summary <- title; Description <- description (plus approved stable IDs if needed for tracking); Start <- start_at preserving offset; End <- end_at preserving offset. Keep/change Formatter only as needed to preserve the full approved timestamp and timezone, never truncate to a date. Use the explicit timezone policy and reminder_minutes_before only in a field/action confirmed to accept minutes. No midnight/end/duration/all-day defaults. Confirm start < end and intended local clock before any event action test. Approve event_id dedupe and persistent reminder_id/Calendar Event ID tracking. Do not implement update/cancel using another create action; those policies remain blocked. Do not create a replacement Zap.

## Z2 exact remaining configuration

The schedule step is already complete and labeled Sunday 8 PM Asia/Kolkata; preserve it. GET URL, query parameters, Basic Auth and Headers are blank. The Google Docs Template Document, New Document Name and Export Formats are unselected/blank; no placeholder mappings are available before template selection. Formatter currently uses Capitalize with blank Input and no completed test. Gmail To/Cc/Bcc, Subject, Body and Attachments are blank; Body type is Plain. No backend test result or PDF/email delivery is claimed. Inspection used navigation only, with no mapping input, test button, account change or publication action.

1. After verified deployment, set existing step 2 URL to the approved externally reachable API base + /api/zapier/weekly. Do not assume the old deployment has this new route. Leave query params and Basic Auth blank. Set Headers Authorization to Bearer plus the private server-configured ZAPIER_BEARER through the approved dashboard/secret process; never paste it in Git/chat. Set Accept=application/json if needed.
2. Test the GET only against an approved synthetic scoped deployment. Expect the exact nine fields and full cutoff timestamps. No SSO challenge or deployment-protection bypass; Singhal supplies legitimate routing access.
3. Configure existing Text Formatter only for report presentation. Keep full reporting dates intact; do not invent mood or adherence. Map the nine returned values directly where no formatting is needed.
4. Select the existing approved private Maa ka hafta template and existing Google connection. Set document name using parent_name/week_start/week_end. Map matching placeholders to week_start, week_end, parent_name, checkin_summary, mood_summary, medicine_summary, errand_summary, alert_summary and weekly_summary. Keep documents private. Do not recreate the template or generate a real document during configuration.
5. Select PDF export in the existing Docs step if its action exposes a usable PDF file output (the observed action exposes Export Formats). Inspect the test output before assuming it is an attachment. A document URL alone is not a PDF. If a separate export action is genuinely required, approve that addition inside this same Zap.
6. Set existing Gmail subject/body from the approved fields and attach the actual PDF output. No real family recipients; use a separately approved test inbox only when email test authorization is given. Do not click Gmail Test or run the whole Zap now.

Official reference: [Zapier MCP quickstart](https://docs.zapier.com/mcp/quickstart), [Next Gen Zaps](https://help.zapier.com/hc/en-us/articles/48391476448141-Get-started-with-Next-Gen-Zaps). Available MCP app actions or Classic import into Next Gen would not prove in-place editing of these IDs. No import/conversion was attempted. Browser editor access is available, but approved contracts, routing and deployment are the remaining gates. Existing Zaps were inspected, not edited.
