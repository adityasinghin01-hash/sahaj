# Zapier Integrations (Z1, Z2, Z3, Z5)

> K-ZAP (15 Nov): Z1/Z5 bodies and the Z2 response now also carry the snake_case fields the saved Zaps read (`occurred_at`, `start_at`, `week_start`, …). The examples below show only the original fields. See [docs/zapier/WIRING.md](../zapier/WIRING.md) for the current field lists.

Sahaj Core 1 uses three minimal Zapier integration seams. Every webhook/report passes through its redaction boundary so **no phone numbers, OTPs, bank account numbers, or raw provider tokens** ever leave Sahaj. Outbound Zapier catch-hook delivery is strictly optional (env-gated) and **non-blocking** so a failed or slow webhook never blocks or rolls back Core 1 workflows.

---

## Z1 — Medicine Refill / Errand Webhook (`ZAPIER_HOOK_Z1`)

- **Direction:** Sahaj → Zapier Catch Hook (`POST $ZAPIER_HOOK_Z1`)
- **Env Var:** `ZAPIER_HOOK_Z1`
- **Behavior:**
  - Triggered asynchronously when a medicine refill passes or requests Cedar `evaluateGate` (`refill.approval_requested`, `refill.authorized`, `refill.dispatched`, `refill.delivered`).
  - Only fires when `process.env.ZAPIER_HOOK_Z1` is set to a valid `http:`/`https:` URL.
  - Failures (network error, timeout at 3s, non-2xx HTTP status) are captured in `{ sent: false, error }` telemetry and **never** fail the Core 1 refill flow.
- **Payload Shape (`sahaj.zapier.z1.v1`):**

```json
{
  "schema": "sahaj.zapier.z1.v1",
  "event": "refill.authorized",
  "familyId": "11111111-1111-4111-8111-111111111111",
  "personId": "22222222-2222-4222-8222-222222222222",
  "medicineId": "33333333-3333-4333-8333-333333333333",
  "vendorId": "44444444-4444-4444-8444-444444444444",
  "actionRequestId": "55555555-5555-4555-8555-555555555555",
  "errandId": "66666666-6666-4666-8666-666666666666",
  "medicineLabel": "Medicine refill",
  "reorderPacks": 1,
  "amountMinor": 25000,
  "status": "authorized",
  "occurredAt": "2026-11-15T06:00:00.000Z"
}
```

---

## Z2 — Weekly Family Report Pull Endpoint (`GET /api/core1/family-report/weekly`)

- **Direction:** Zapier Scheduled Poll → Sahaj (`GET /api/core1/family-report/weekly`)
- **Auth:** Shared secret header `x-sahaj-zap-secret` must match env `ZAPIER_REPORT_SECRET` (verified with constant-time SHA-256 `timingSafeEqual`; returns `503` if unset or `401` if missing/invalid).
- **Query Params:**
  - `familyId` (required UUID): family whose weekly digest is compiled.
  - `periodStart` (optional ISO timestamp; defaults to 7 days before `periodEnd`).
  - `periodEnd` (optional ISO timestamp; defaults to current UTC time).
- **Data Sources (Real Database Rows):**
  - `calls`: weekly check-in call totals & completed count.
  - `incidents`: urgent incidents opened/closed count.
  - `errands` + `medicines`: refill proposals, dispatches, and deliveries.
  - `nudges`: missed-call nudges generated.
  - `shield_events`: weekly Shield safety event count.
  - `timeline_events`: verified timeline summaries passed through `compileFamilyReport` / `redactSensitiveText`.
- **Response JSON (`200 OK`):**

```json
{
  "schema": "sahaj.zapier.z2.v1",
  "familyId": "11111111-1111-4111-8111-111111111111",
  "periodStart": "2026-11-08T00:00:00.000Z",
  "periodEnd": "2026-11-15T00:00:00.000Z",
  "generatedAt": "2026-11-15T00:00:00.000Z",
  "totalEvents": 4,
  "counts": {
    "checkIns": 7,
    "incidents": 0,
    "refills": 1,
    "nudges": 2,
    "shieldEvents": 3
  },
  "summaryLines": [
    "Daily check-in completed calmly for Maa.",
    "Refill proposal authorized for Metformin 500mg.",
    "Missed call nudge sent to Riya app."
  ],
  "redacted": true
}
```

---

## Z5 — Care Dates & Refill Reminders Webhook (`ZAPIER_HOOK_Z5`)

- **Direction:** Sahaj → Zapier Catch Hook (`POST $ZAPIER_HOOK_Z5`)
- **Env Var:** `ZAPIER_HOOK_Z5`
- **Behavior:**
  - Emits due dates / care reminders (such as stock reaching refill threshold on confirmed/reconciled count, or scheduled care date reminders) when `ZAPIER_HOOK_Z5` is configured.
  - Skipped silently when `ZAPIER_HOOK_Z5` is unset; network or HTTP errors never block or fail the core workflow.
- **Payload Shape (`sahaj.zapier.z5.v1`):**

```json
{
  "schema": "sahaj.zapier.z5.v1",
  "event": "reminder.refill_due",
  "familyId": "11111111-1111-4111-8111-111111111111",
  "personId": "22222222-2222-4222-8222-222222222222",
  "entityId": "33333333-3333-4333-8333-333333333333",
  "label": "Care reminder",
  "dueAt": "2026-11-16T09:00:00.000Z",
  "summary": "Care reminder due; details stay in Sahaj.",
  "occurredAt": "2026-11-15T00:00:00.000Z"
}
```


## C-15 delivery decision (15 Nov 2026)

Z1, Z5 and Z3 use an **env-configured redacted webhook; not a security boundary**.
The optional integration POSTs directly to the corresponding `ZAPIER_HOOK_*` URL;
it does not use the Phase 3 dispatch ledger or grant permission to send a care
notification, place an order, share location, or accept an incident.

Every configured HTTP attempt first writes a signed `zapier.attempt` timeline row.
If signing fails, no POST is made. Missing configuration skips the hook. Invalid
URLs, signing failure, HTTP errors, network exceptions and a three-second deadline
produce optional failure telemetry; they do not fail or roll back the core flow.
The HTTP transport refuses redirects and is bounded even if a transport ignores
AbortSignal. URLs and secrets are never included in attempt rows. Z1/Z5 attempt
rows include a payload hash and unique attempt ID; the HTTP idempotency header
contains the payload hash. Zapier consumers should deduplicate this header when
performing effects. There is no automatic retry of an uncertain attempt.

Z1/Z5 payloads use explicit field allowlists, generic labels and summaries, and
recursive redaction of contact, OTP/PIN and location fields. Free-form medicine
labels and summaries stay in Sahaj so a pasted address cannot leak through them. Z3 deliberately sends only IDs,
timestamps and aggregate delivery/heard counts, with a fixed neutral summary:
`accepted_by_name` and `report` are null. The full signed family report stays in
Sahaj. No location, contact number, OTP, raw provider token or free-form incident
narrative is included in Z3.

The existing Z2 inbound shared-secret check is unchanged. These hook URLs are
server environment configuration and never supplied by an app or request body.
