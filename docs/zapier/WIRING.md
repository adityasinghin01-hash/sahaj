# Zapier wiring sheet (for Aditya)

What our backend sends to each saved Zap, field by field. No secret or Hook URL is in this file; exchange those with the lead privately.

## Send the lead privately

| Zap | What to send | Server env name it goes into |
|---|---|---|
| Z1 Errand Ledger (386748738) | Catch Hook URL | `ZAPIER_HOOK_Z1` |
| Z5 Reminders (386750124) | Catch Hook URL | `ZAPIER_HOOK_Z5` |
| Z3 After-report (no saved Zap yet) | Catch Hook URL, once you create it | `ZAPIER_HOOK_Z3` |

The lead sends you `ZAPIER_REPORT_SECRET` privately for Z2.

## Z1: errand ledger to Google Sheets (POST to your Catch Hook)

Sent on refill approval request, authorization and delivery. Map these fields:

| Hook field | Type | Example | Sheet column |
|---|---|---|---|
| `occurred_at` | string, ISO with offset | `2026-11-15T11:30:00+05:30` | Formatter Input, then Date |
| `errand_type` | string | `medicine_refill` | Errand |
| `vendor_label` | string, fixed | `Approved vendor` | Vendor |
| `amount_inr` | number, rupees | `350.5` | Amount_INR |
| `permission_ref` | string (UUID) or null | `7777…-7777` | Permission_ID |
| `decision` | string | `approved` or `awaiting_approval` | Decision |
| `chain_hash` | string, 64 hex chars, or null | `ab12…` | Chain_Hash |

Formatter: parse `occurred_at` as an ISO timestamp. It is already in Asia/Kolkata (+05:30), so set the To Timezone to Asia/Kolkata to keep the local date.

The body also carries `event_date`, `errand`, `vendor` and `permission_id` (the old sample names, same values) plus the earlier camelCase fields (`schema`, `event`, `familyId`, `errandId`, `status`, …). Map the new names above, not these.

No phone numbers, OTPs, addresses, locations or medicine names are sent. The vendor table has no display name, so `vendor_label` is always `Approved vendor`.

## Z5: reminders to Google Calendar (POST to your Catch Hook)

Sent when medicine stock reaches its refill threshold. The event is set for 10:00 IST the next day.

| Hook field | Type | Example | Calendar field |
|---|---|---|---|
| `title` | string | `Medicine refill due` | Summary |
| `description` | string | `Medicine stock is low. Open Sahaj to review the refill; details stay in Sahaj.` | Description |
| `start_at` | string, ISO with +05:30 | `2026-11-16T10:00:00+05:30` | Start Date & Time |
| `end_at` | string, ISO with +05:30 | `2026-11-16T10:15:00+05:30` | End Date & Time |
| `reminder_minutes_before` | number | `60` | Minutes Before Reminders |

The old fields (`schema`, `event`, `entityId`, `label`, `dueAt`, `summary`, `occurredAt`, ids) are still in the body. You can ignore them.

## Z2: weekly report (Webhooks GET, then Docs template, then Gmail)

- URL: `https://experimental-simultaneously-lol-john.trycloudflare.com/api/core1/family-report/weekly?familyId=<family UUID from the lead>`
- Header: `x-sahaj-zap-secret: <ZAPIER_REPORT_SECRET from the lead, sent privately>`
- Keep `Accept: application/json`. Leave Basic Auth blank. This route does not use a Bearer header (the earlier audit's `/api/zapier/weekly` + `ZAPIER_BEARER` plan is not what the code does).
- Optional query: `periodEnd` / `periodStart` (ISO). By default the window is the 7 days ending at request time.
- Errors: `503` if the server secret is unset, `401` for a missing or wrong header, `404` for an unknown family.

The JSON response has these top-level string fields, one per template placeholder:

| Field | Example |
|---|---|
| `week_start` | `2026-11-08T20:00:00+05:30` |
| `week_end` | `2026-11-15T20:00:00+05:30` |
| `parent_name` | `Meena Maa` |
| `checkin_summary` | `1 of 2 check-in calls completed.` |
| `mood_summary` | `Mood noted on 1 check-in: calm.` |
| `medicine_summary` | `Medicines discussed on 1 check-in: taken.` |
| `errand_summary` | `1 medicine refill: 1 completed, 0 in progress.` |
| `alert_summary` | `1 urgent alert (1 resolved), 0 missed-call nudges, 2 scam warnings.` |
| `weekly_summary` | `Meena Maa had 1 urgent alert this week; 1 of 2 check-in calls completed.` |

The response also keeps the older report keys (`schema`, `counts`, `summaryLines`, `timeline`, …). Map only the nine fields above. `week_start`/`week_end` are full timestamps, so use a Formatter step if the doc title should show only the date.

## Z3: after-report (POST to `ZAPIER_HOOK_Z3`)

Sent when an urgent incident is closed. Only IDs, timestamps and counts are sent. The full report stays in Sahaj.

| Hook field | Type | Notes |
|---|---|---|
| `schema` | string | `sahaj.zapier.z3.v1` |
| `event` | string | `core2.after_report.closed` |
| `family_id` | string (UUID) | |
| `incident_id` | string (UUID) | |
| `closed_at` | string, ISO (UTC, `Z`) | |
| `summary_line` | string, fixed | `Incident closed; family report available in Sahaj.` |
| `accepted_by_name` | always null | names stay in Sahaj |
| `accepted_at` | string ISO or null | |
| `deliveries_count` | number | |
| `heard_count` | number | |
| `resolution_duration_s` | number or null | |
| `report` | always null | |

Every POST also has the header `x-sahaj-idempotency-key` (a payload hash). Use it to drop duplicates if you add a dedupe step.
