# Core 1 Read Feed Contract (`CORE1-FEED`)

Status: **Frozen** (additive fields only; existing field names and types must not break).
Consumers: `@sahaj/child` (Riya's app) and `@sahaj/parent` (Maa's app).

---

## Common Auth, Family Scoping, and Security Rules

- **Authentication:** `Authorization: Bearer <supabase_access_token>` verified server-side via `createDefaultAuthPort().getUser(token)` (`serviceDatabase().auth.getUser(token)`).
- **Family resolution:**
  - Uses `createSupabaseCore1Repository(client).getMembership(userId, requestedFamilyId)` against `public.family_memberships`.
  - If the user has one active membership, `familyId` may be omitted.
  - If the user has multiple memberships, the caller must pass `?familyId=<uuid>` or header `x-sahaj-family-id: <uuid>`. If both are sent and differ, the server returns `400 { "error": "conflicting_family_id" }`. If omitted for a multi-family user, the server returns `400 { "error": "ambiguous_family_membership_family_id_required" }`.
  - Missing or revoked memberships fail closed with `403 { "error": "family_membership_not_found" }`.
  - For `circle` callers, live `public.circle` membership is checked (`active = true`, `revoked_at is null`, `consent_at is not null`); otherwise `403`.
- **Standard response headers:**
  - `Cache-Control: no-store`
  - `Referrer-Policy: no-referrer`
  - `X-Content-Type-Options: nosniff`
  - `Content-Type: application/json`
  - On `401`: `WWW-Authenticate: Bearer`
- **Privacy invariants (never violated):**
  - **No phone numbers, OTPs, bank/payment credentials, or raw storage `object_path` values** appear in any feed response.
  - Names come strictly from `public.people.display_name`.
  - All queries are scoped to `membership.familyId` (cross-family IDs never leak).
- **Pagination:** Optional `?limit=<1..50>` (default `20`).
- **Error shape:**
  ```json
  { "error": "unauthorized_missing_bearer_token" }
  ```

---

## 1. `GET /api/core1/feed/voice`

Returns voice messages to or from the authenticated caller within their family (`public.voice_posts` where `sender_id = caller.personId OR recipient_id = caller.personId`).

- **Allowed roles:** `parent`, `child` (`circle` receives `403`).

### Response (`200 OK`)

```json
{
  "family_id": "11111111-1111-4111-8111-111111111111",
  "caller_person_id": "c1000000-0000-4000-8000-000000000001",
  "items": [
    {
      "id": "v1000000-0000-4000-8000-000000000001",
      "direction": "inbound",
      "from_person_id": "c2000000-0000-4000-8000-000000000002",
      "from_display_name": "Meena",
      "to_person_id": "c1000000-0000-4000-8000-000000000001",
      "to_display_name": "Riya",
      "state": "delivered",
      "created_at": "2026-11-15T04:30:00.000Z",
      "duration_s": 12,
      "played_at": null,
      "reply_to": null
    }
  ]
}
```

### Field Notes
- `direction`: `"inbound"` when `to_person_id === caller_person_id`, `"outbound"` when `from_person_id === caller_person_id`.
- `state`: `"queued" | "sent" | "delivered" | "heard" | "failed"`.
- `duration_s`: `number | null` (seconds, when recorded in timeline/metadata; otherwise `null`).
- `played_at`: `string | null` (ISO-8601 timestamp when verified heard/played; otherwise `null`).
- `reply_to`: `string | null` (UUID of parent `voice_post` if this is a reply).

---

## 2. `GET /api/core1/feed/voice/[id]/media`

Issues a short-lived signed URL (at most 60 seconds) for a consented private voice recording via the Core media authorization service (`createMediaService`).

- **Allowed roles:** `parent`, `child`, and the caller must be either `sender_id` or `recipient_id` of the `voice_post`.
- **Consent requirement:** Current append-only `voice_share:<recipient_id>` consent must be active (not revoked).
- **Errors:**
  - `401` `unauthenticated`
  - `403` `forbidden` | `consent_required`
  - `404` `not_found` (including cross-family or non-participant access)
  - `410` `expired` (media retention window elapsed)
  - `422` `invalid_object`
  - `503` `unavailable`

### Response (`200 OK`)

```json
{
  "url": "https://storage.example.test/object/sign/sahaj-voice/...",
  "expires_in": 60
}
```

---

## 3. `GET /api/core1/feed/incidents`

Returns open and recent urgent incidents in the caller's family, with the current responder's display name, assignment chain, and timestamps.

- **Allowed roles:** `child`, `parent`, and active/consented `circle` member.

### Response (`200 OK`)

```json
{
  "family_id": "11111111-1111-4111-8111-111111111111",
  "items": [
    {
      "id": "d0000000-0000-4000-8000-000000000001",
      "subject_person_id": "c2000000-0000-4000-8000-000000000002",
      "subject_display_name": "Meena",
      "state": "accepted",
      "severity": "urgent",
      "responder": {
        "assignment_id": "a1000000-0000-4000-8000-000000000002",
        "person_id": "c3000000-0000-4000-8000-000000000003",
        "display_name": "Sharma uncle",
        "state": "accepted",
        "offered_at": "2026-11-15T16:11:30.000Z",
        "expires_at": "2026-11-15T16:14:30.000Z",
        "accepted_at": "2026-11-15T16:12:48.000Z"
      },
      "assignments": [
        {
          "assignment_id": "a1000000-0000-4000-8000-000000000001",
          "person_id": "c1000000-0000-4000-8000-000000000002",
          "display_name": "Rohit",
          "state": "expired",
          "offered_at": "2026-11-15T16:11:00.000Z",
          "expires_at": "2026-11-15T16:13:00.000Z",
          "accepted_at": null
        },
        {
          "assignment_id": "a1000000-0000-4000-8000-000000000002",
          "person_id": "c3000000-0000-4000-8000-000000000003",
          "display_name": "Sharma uncle",
          "state": "accepted",
          "offered_at": "2026-11-15T16:11:30.000Z",
          "expires_at": "2026-11-15T16:14:30.000Z",
          "accepted_at": "2026-11-15T16:12:48.000Z"
        }
      ],
      "promised_at": "2026-11-15T16:27:48.000Z",
      "created_at": "2026-11-15T16:11:00.000Z"
    }
  ]
}
```

### Field Notes
- `state`: `"open" | "offered" | "accepted" | "heard" | "done" | "reopened" | "escalated" | "closed"`.
- `severity`: `"routine" | "urgent" | "critical"`.
- `responder`: Active/accepted responder assignment, or latest offered assignment if still pending, or `null` if none.
- `responder.state`: `"offered" | "accepted" | "declined" | "expired" | "completed"`.
- `promised_at`: `string | null` (ISO-8601 timestamp).

---

## 4. `GET /api/core1/feed/refills`

Returns medicine refill proposals (`public.action_requests` where `action = 'medicine_refill'`) with medicine label, integer minor-unit amount, vendor display name, state, and approval history.

- **Allowed roles:** `child`, `parent` (`circle` receives `403`).

### Response (`200 OK`)

```json
{
  "family_id": "11111111-1111-4111-8111-111111111111",
  "items": [
    {
      "id": "r1000000-0000-4000-8000-000000000001",
      "person_id": "c2000000-0000-4000-8000-000000000002",
      "person_display_name": "Meena",
      "medicine_id": "a0000000-0000-4000-8000-000000000001",
      "medicine": "Amlodipine 5 mg",
      "amount_minor": 18400,
      "currency": "INR",
      "vendor_id": "b0000000-0000-4000-8000-000000000001",
      "vendor": "Gupta Medical",
      "state": "pending",
      "two_person_required": false,
      "who_approved": [],
      "approvals": [],
      "created_at": "2026-11-15T08:30:00.000Z",
      "expires_at": "2026-11-15T20:30:00.000Z"
    }
  ]
}
```

### Field Notes
- `amount_minor`: non-negative integer in minor currency units (paise for `"INR"`, e.g. `18400` = ₹184).
- `state`: `"pending" | "approved" | "denied" | "expired" | "executed" | "failed"`.
- `who_approved`: `string[]` of `display_name`s from `public.action_answers` where `answer === true`.
- `approvals`: full list of `action_answers` rows (`person_id`, `display_name`, `answer`, `answered_at`).
- `medicine_id` and `vendor_id`: UUID string or `null` (when resolved from `action_requests.item_ids[0]` / `action_requests.target_id` and `action_requests.vendor_id`).

---

## 5. `GET /api/core1/feed/checkins`

Returns recent check-ins, the next scheduled check-in, and active/recent missed-call nudges for the family.

- **Allowed roles:** `child`, `parent` (`circle` receives `403`).
- **Parent scoping:** A `parent` caller sees only check-ins/schedules/nudges for their own `person_id`. A `child` caller sees all family check-ins/nudges.
- **Redaction:** `short_summary` is derived only from call status or redacted `public.timeline_events.human_line` (never from `sahaj_private.call_content` transcripts).

### Response (`200 OK`)

```json
{
  "family_id": "11111111-1111-4111-8111-111111111111",
  "next_checkin": {
    "schedule_id": "e0000000-0000-4000-8000-000000000001",
    "person_id": "c2000000-0000-4000-8000-000000000002",
    "person_display_name": "Meena",
    "scheduled_for": "2026-11-16T04:30:00.000Z",
    "timezone": "Asia/Kolkata",
    "enabled": true
  },
  "items": [
    {
      "id": "call-0001-0000-4000-8000-000000000001",
      "person_id": "c2000000-0000-4000-8000-000000000002",
      "person_display_name": "Meena",
      "scheduled_for": "2026-11-15T04:30:00.000Z",
      "started_at": "2026-11-15T04:44:00.000Z",
      "ended_at": "2026-11-15T04:48:00.000Z",
      "state": "completed",
      "short_summary": "Check-in call · all well",
      "ai_disclosed": true
    }
  ],
  "missed_call_nudges": [
    {
      "id": "n1000000-0000-4000-8000-000000000001",
      "person_id": "c2000000-0000-4000-8000-000000000002",
      "person_display_name": "Meena",
      "kind": "missed_call_single",
      "status": "pending",
      "scheduled_at": "2026-11-15T12:10:00.000Z"
    }
  ]
}
```

### Field Notes
- `next_checkin`: `null` when no enabled check-in schedule exists.
- `items[].state`: `"scheduled" | "ringing" | "connected" | "completed" | "failed" | "cancelled"`.
- `items[].short_summary`: sanitized non-clinical status line (e.g. `"Check-in call completed"`, `"Scheduled check-in"`, or redacted timeline `human_line` with any 4+ digit run masked).
- `missed_call_nudges`: rows from `public.nudges` where `kind like 'missed_call%'`, ordered newest first.
