# Phase 4 Core 1 C3: Automatic Both-Free Matcher (`MATCHER.md`)

## 1. Overview (Build Bible C3)
- **Maa's free times** come from her daily check-in calls via the Sarvam agent tool `save_free_time` (e.g., `"shaam 6 ke baad free hoon"` -> deterministic read-back `"Theek hai, aap shaam 6 se 8 baje tak free hain."` -> saved to `public.core1_free_windows`).
- **Riya's free times** are configured in her app (`apps/child/app/free-times.tsx`), including recurring daily windows and a one-tap **"Free now for 30 min"** button.
- **Matcher Tick (`POST /api/core1/matcher/tick`)** runs every `10 min` (`600000 / DEMO_TIMER_SCALE` ms). When:
  1. **BOTH** Maa and Riya are free right now (in their respective window timezones),
  2. It is **NOT** Maa's quiet hours (`public.people.quiet_windows` in Maa's timezone),
  3. **No matcher nudge** has been sent today (`public.core1_matcher_nudge_log` unique per `(family_id, parent_person_id, local_date)`),
  4. **They haven't talked today** (no non-failed `voice_posts` between them today and no connected/completed non-AI call today),
  then Sahaj sends **ONE** nudge to Riya via the existing outbox + Expo app push path:
  > `"Abhi aap dono free hain — aap Maa ko call kar sakti hain."`
- **Notify only:** Never auto-bridges a call (`auto_bridge: false`).

---

## 2. Routes & JSON Contracts

### 2.1 `GET /api/core1/free-times`
- **Auth:** `Authorization: Bearer <access_token>` (optional `x-sahaj-family-id` header or `?familyId=<uuid>` when user belongs to multiple families).
- **Roles:** `child` (sees own windows + family windows + live match status) or `parent` (sees own windows only).
- **Response (`200 OK`):**
```json
{
  "family_id": "11111111-1111-4111-8111-111111111111",
  "person_id": "33333333-3333-4333-8333-333333333333",
  "timezone": "Asia/Kolkata",
  "windows": [
    {
      "id": "d3000000-0000-4000-8000-000000000002",
      "person_id": "33333333-3333-4333-8333-333333333333",
      "person_display_name": "Riya",
      "person_role": "child",
      "timezone": "Asia/Kolkata",
      "start_time": "18:00",
      "end_time": "20:00",
      "start_minute": 1080,
      "end_minute": 1200,
      "kind": "recurring",
      "days_of_week": null,
      "expires_at": null,
      "source": "app",
      "label": "Shaam 6 se 8 baje tak",
      "active_now": true,
      "created_at": "2026-11-15T13:00:00.000Z"
    }
  ],
  "family_windows": [
    {
      "id": "d3000000-0000-4000-8000-000000000001",
      "person_id": "22222222-2222-4222-8222-222222222222",
      "person_display_name": "Meena Maa",
      "person_role": "parent",
      "timezone": "Asia/Kolkata",
      "start_time": "18:00",
      "end_time": "20:00",
      "start_minute": 1080,
      "end_minute": 1200,
      "kind": "recurring",
      "days_of_week": null,
      "expires_at": null,
      "source": "sarvam_checkin",
      "label": "Shaam 6 se 8 baje tak",
      "active_now": true,
      "created_at": "2026-11-15T04:00:00.000Z"
    }
  ],
  "both_free_now": true,
  "maa_free_now": true,
  "riya_free_now": true,
  "maa_quiet_now": false,
  "talked_today": false,
  "nudged_today": false,
  "nudge_message": "Abhi aap dono free hain — aap Maa ko call kar sakti hain.",
  "last_nudge": null
}
```

### 2.2 `POST /api/core1/free-times`
- **Auth:** `Authorization: Bearer <access_token>` (`child` or `parent`).
- **Mode A — Recurring window (`201 Created`):**
```json
{
  "start_time": "18:00",
  "end_time": "20:00",
  "timezone": "Asia/Kolkata",
  "days_of_week": [1, 2, 3, 4, 5],
  "label": "Evening after work"
}
```
- **Mode B — "Free now for 30 min" (`201 Created`):**
```json
{
  "mode": "free_now",
  "duration_minutes": 30,
  "timezone": "Asia/Kolkata"
}
```
- **Response (`201 Created`):**
```json
{
  "ok": true,
  "window": {
    "id": "10000000-0000-4000-8000-000000000001",
    "person_id": "33333333-3333-4333-8333-333333333333",
    "person_display_name": "Riya",
    "person_role": "child",
    "timezone": "Asia/Kolkata",
    "start_time": "18:30",
    "end_time": "19:00",
    "start_minute": 1110,
    "end_minute": 1140,
    "kind": "ad_hoc",
    "days_of_week": null,
    "expires_at": "2026-11-15T13:30:00.000Z",
    "source": "free_now",
    "label": "Free now (30 min)",
    "active_now": true,
    "created_at": "2026-11-15T13:00:00.000Z"
  }
}
```

### 2.3 `DELETE /api/core1/free-times/[id]` (or `DELETE /api/core1/free-times?id=<uuid>`)
- **Auth:** `Authorization: Bearer <access_token>`. Only deletes a window owned by the authenticated caller (`person_id = actor.personId`).
- **Response (`200 OK`):**
```json
{
  "ok": true,
  "deleted_id": "10000000-0000-4000-8000-000000000001"
}
```

### 2.4 `POST /api/core1/matcher/tick`
- **Auth:** `x-cron-secret: <CRON_SECRET>` (or `Authorization: Bearer <CRON_SECRET>`).
- **Optional Body:** `{ "family_id": "<uuid>" }` (or empty body to evaluate all families with active windows).
- **Timer Scaling:** `tick_interval_ms = max(1000, round(600000 / DEMO_TIMER_SCALE))`.
- **Response (`200 OK`):**
```json
{
  "ok": true,
  "checked_families": 1,
  "nudges_sent": [
    {
      "family_id": "11111111-1111-4111-8111-111111111111",
      "parent_person_id": "22222222-2222-4222-8222-222222222222",
      "child_person_id": "33333333-3333-4333-8333-333333333333",
      "local_date": "2026-11-15",
      "nudge_id": "6f9c92a4-...",
      "outbox_id": "outbox-1",
      "push_count": 1,
      "dispatched": true
    }
  ],
  "skipped": [],
  "timer_scale": 60,
  "tick_interval_ms": 10000,
  "auto_bridge": false
}
```

### 2.5 `POST /api/core1/matcher/free-time-tool`
- **Auth:** `Authorization: Bearer <SARVAM_TOOL_TOKEN>` (falls back to `SARVAM_TOOL_BEARER`).
- **Request Body:**
```json
{
  "family_id": "11111111-1111-4111-8111-111111111111",
  "parent_id": "22222222-2222-4222-8222-222222222222",
  "said": "shaam 6 ke baad free hoon"
}
```
*(Also accepts `family_id` / `parent_id` nested inside `variables`, `agent_variables`, or `context`, and `said` nested inside `input` or `arguments`.)*
- **Response when parsed (`200 OK`):**
```json
{
  "ok": true,
  "saved": true,
  "window_id": "10000000-0000-4000-8000-000000000001",
  "start_time": "18:00",
  "end_time": "20:00",
  "timezone": "Asia/Kolkata",
  "label": "Shaam 6 se 8 baje tak",
  "line_hi": "Theek hai, aap shaam 6 se 8 baje tak free hain.",
  "read_back": "Theek hai, aap shaam 6 se 8 baje tak free hain."
}
```
- **Response when unknown (`200 OK`, asks again without triggering call transfer):**
```json
{
  "ok": false,
  "saved": false,
  "reason": "unknown_time_window",
  "line_hi": "Maaf kijiye, mujhe samay samajh nahi aaya. Aap kab se kab tak free rahengi? Jaise subah 10 se 12 ya shaam 6 ke baad.",
  "read_back": "Maaf kijiye, mujhe samay samajh nahi aaya. Aap kab se kab tak free rahengi? Jaise subah 10 se 12 ya shaam 6 ke baad."
}
```

---

## 3. Sarvam Setup for Antara (`save_free_time`)

Add this tool to the **daily check-in (`checkin` and `checkin_hearing`)** agent in the Sarvam dashboard:

| Field | Value |
|---|---|
| **Tool Name** | `save_free_time` |
| **Description** | Save when Maa is free today so Sahaj can nudge Riya when both are free. Speak back `line_hi` verbatim. |
| **Method** | `POST` |
| **URL** | `<PUBLIC_URL>/api/core1/matcher/free-time-tool` |
| **Header 1** | `Authorization: Bearer <SARVAM_TOOL_TOKEN>` |
| **Header 2** | `Content-Type: application/json` |
| **Timeout** | `5 seconds` |

### Exact JSON Body Template in Sarvam
```json
{
  "family_id": "@family_id",
  "parent_id": "@parent_id",
  "said": "<what Maa said about when she is free, e.g. 'shaam 6 ke baad free hoon'>"
}
```

### Exact One Prompt Line to Add to Check-in Agent (`packages/shared/prompts/sarvam/checkin.md`)
*(Note: Do not edit `packages/shared/prompts/**` in this lane; add this single line in the check-in agent prompt under `Baat karne ka kram` step 4 / before step 7 Recap):*

```text
- Free samay: Poocho "Aaj aap Riya se baat karne ke liye kab free rahengi?" Aur jab @address_form samay batayein (jaise "shaam 6 ke baad" ya "4 se 6"), turant `save_free_time` tool chalao aur uska `line_hi` jawab ("Theek hai, aap ... baje tak free hain.") bilkul waise hi पढ़कर sunao.
```
