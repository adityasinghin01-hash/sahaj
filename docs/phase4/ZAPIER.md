# Core 1 Zapier Integrations (Z1, Z2, Z5)

Sahaj Core 1 uses three minimal Zapier integration seams. Every webhook/report passes through `redactSensitiveText` so **no phone numbers, OTPs, bank account numbers, or raw provider tokens** ever leave Sahaj. Outbound Zapier catch-hook delivery is strictly optional (env-gated) and **non-blocking** so a failed or slow webhook never blocks or rolls back Core 1 workflows.

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
  "medicineLabel": "Metformin 500mg",
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
  "label": "Metformin 500mg",
  "dueAt": "2026-11-16T09:00:00.000Z",
  "summary": "Low stock threshold reached (2 remaining); refill due for Metformin 500mg.",
  "occurredAt": "2026-11-15T00:00:00.000Z"
}
```

