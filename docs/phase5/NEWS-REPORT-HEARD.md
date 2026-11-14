# Phase 5 — Core 2: G8 Gentle News, G9 After-Report (Zapier Z3) & Real "Maa Heard It" Proof (`AGY-X2`)

## 1. Architecture & Guarantees

### G8 Gentle News (`public.core2_gentle_news`)
1. **Never push bad news directly to Maa**: When Riya (`role='child'`) or the accepting responder marks a Core 2 incident `"hurt / at hospital"` (`POST /api/core2/news`), zero push notifications or outbound phone calls are sent directly to Maa (`maa_notified_via_push: false`).
2. **Core 1 circle companion first**:
   - The server queries `public.circle` for the top-ranked active, approved, consented companion (`rank ASC`, excluding `subject_person_id` and `parent_person_id`, e.g. Sharma Uncle) and offers `"please go and sit with Maa"` (`gentle_news.circle_offer`) with a live countdown (`maa_call_due_at`, scaled by `DEMO_TIMER_SCALE` via `scaleDurationMs`).
   - If the companion declines (`POST /api/core2/news/[incidentId]/circle` with `{ "action": "decline" }`), the next active Core 1 circle companion is offered automatically.
3. **Calm Aasha Didi call once someone is with Maa or timer expires**:
   - When the companion confirms `"Maa ke paas hoon"` (`{ "action": "with_maa" }`) **or** the wait window expires (`POST /api/core2/news/tick`, secured by `CRON_SECRET` and gated by `MAINTENANCE_KILL`), Sahaj queues a calm outbound call (`sarvam.outbound_call`) to Maa.
   - Aasha Didi explicitly discloses that she is an AI (`ai_disclosed: true`) and never clones a family voice (`ai_cloned_voice_used: false`). If Riya or Rohit recorded a real family voice note (`voice_post_id`), it is attached as a real recording.
4. **If Maa calls `"1 Sahaj"` first (`POST /api/core2/news/sarvam`)**:
   - Secured by `SARVAM_TOOL_TOKEN`.
   - `action: "aasha_didi_check"` returns the same short, calm, never-graphic summary + `voice_post_id`.
   - `action: "record_maa_questions"` redacts any phone/4+-digit runs from Maa's questions, stores them in `maa_questions`, and dispatches them calmly to Riya (`expo.calm_questions`).

---

### Real "Maa Heard It" Proof (`public.core2_heard_receipts` & `public.core2_record_heard_receipt`)
A message to Maa (Core 2 `"Main safe hoon"` reassurance or Core 1 voice post) is **never** marked heard on a timer. It requires one of three cryptographic/telephony proofs:
1. **Smartphone (`POST /api/core2/heard/device`)**:
   - Verifies `X-Sahaj-Device`, `X-Sahaj-Timestamp`, `X-Sahaj-Signature` using `verifyMaaDeviceRequest` from `@/app/api/core1/maa/_lib/device-auth` with replay protection.
   - Requires `playback_finished === true` and `played_duration_s >= clip_duration_s`.
2. **Keypad DTMF after playback (`POST /api/core2/heard/twilio/gather`)**:
   - Verifies `X-Twilio-Signature` using `verifyTwilioFormSignature` from `@sahaj/adapters`.
   - Requires `playback_completed === "true"` **and** a valid DTMF digit (`Digits` matching `^[0-9*#]{1,4}$`).
3. **Keypad full-duration call (`POST /api/core2/heard/twilio/status`)**:
   - Verifies `X-Twilio-Signature` using `verifyTwilioFormSignature` from `@sahaj/adapters`.
   - Requires `CallStatus === "completed"` **and** `CallDuration >= clip_duration_s`.

**UI Badge in Riya's app (`apps/child/components/sahaj/heard-badge.tsx`)**:
- Verified: `"Maa ne suna ✓ 01:12"` (formatted in `Asia/Kolkata` 24h `HH:MM`)
- Unconfirmed: `"Bheja gaya — sunna confirm nahi"`

---

### G9 After-Report & Zapier Z3 (`public.core2_after_reports`)
- When Riya closes a Core 2 incident (`POST /api/core2/news/[incidentId]/close` or `POST /api/core2/after-report/[incidentId]`), Sahaj builds a structured report (`schema_version: "sahaj.after_report.v1"`) from:
  - The Ed25519-signed timeline (`verifyTimelineChain` verification status included)
  - Incident & responder assignment records (who accepted and when)
  - Every delivery with `sent` / `delivered` / `heard` status and `heard_evidence`
  - Key timings (`incident_created_at`, `first_offer_at`, `accepted_at`, `hurt_marked_at`, `circle_with_maa_at`, `maa_call_queued_at`, `first_heard_at`, `closed_at`)
- **Strict Redaction (`redaction.ts`)**: Strips all phone numbers, 4+-digit numeric sequences, and location/route keys (`from_label`, `to_label`, `route_ciphertext`, `cab_note`, `lat`, `lng`, `latitude`, `longitude`, `location`, `coordinates`, `address`).
- **Zapier Z3 (`ZAPIER_HOOK_Z3`)**:
  - Triggered **only** when `process.env.ZAPIER_HOOK_Z3` is set (`schema: "sahaj.zapier.z3.v1"`).
  - Enforces a 3-second timeout and non-blocking error handling: webhook failure or timeout records `zapier_z3.status = "failed"` and never blocks closing the incident.

---

## 2. HTTP Routes Summary

| Method & Path | Auth | Description |
|---|---|---|
| `POST /api/core2/news` | Bearer (`child` or accepting responder) + `Idempotency-Key` | Mark incident hurt/at hospital; offer Core 1 circle companion first |
| `GET /api/core2/news/[incidentId]` | Bearer (`child` or assigned `circle`; `parent` -> `403`) | Fetch gentle news state & live countdown (`remaining_ms`) |
| `POST /api/core2/news/[incidentId]/circle` | Bearer (offered `circle`, or `child` for `with_maa`) | `{ "action": "accept" \| "decline" \| "with_maa" }` |
| `POST /api/core2/news/tick` | `X-Cron-Secret` / Bearer `CRON_SECRET` | Queue calm Maa call for due gentle news rows |
| `POST /api/core2/news/sarvam` | Bearer `SARVAM_TOOL_TOKEN` | `aasha_didi_check` (`"1 Sahaj"`) and `record_maa_questions` |
| `POST /api/core2/news/[incidentId]/close` | Bearer (`child`) | Close incident, persist redacted G9 after-report, fire Zapier Z3 |
| `GET /api/core2/after-report/[incidentId]` | Bearer (`child`) | Read redacted G9 after-report |
| `POST /api/core2/after-report/[incidentId]` | Bearer (`child`) | Alias for closing incident & generating G9 after-report |
| `GET /api/core2/heard` | Bearer (`child` or recipient `parent`) | Query verified heard status & Hindi badge label |
| `POST /api/core2/heard/device` | Shield device headers (`verifyMaaDeviceRequest`) | Record smartphone full-playback completion proof |
| `POST /api/core2/heard/twilio/gather` | `X-Twilio-Signature` (`verifyTwilioFormSignature`) | Record keypad playback + DTMF key proof |
| `POST /api/core2/heard/twilio/status` | `X-Twilio-Signature` (`verifyTwilioFormSignature`) | Record keypad full call duration (`>= clip_duration_s`) proof |

---

## 3. Lead Wiring Guide (Shared Files Not Edited by `AGY-X2`)

1. **Maa's smartphone audio player (`apps/parent/src/app/voice.tsx`)**:
   - Import `reportMaaPlaybackFinished` from `../lib/maa-heard`.
   - Inside the audio player completion handler (`if (status.isLoaded && status.didJustFinish)`), call:
     ```ts
     await reportMaaPlaybackFinished({
       messageKind: "core1_voice_post", // or "core2_reassurance"
       deliveryId: item.id,
       voicePostId: item.id,
       clipDurationS: item.durationSeconds,
       playedDurationS: Math.round((status.positionMillis ?? 0) / 1000),
       playbackFinished: true,
     });
     ```
2. **Riya's reassurance & incident cards (`apps/child/components/core2/reassurance.tsx`, `apps/child/app/incident.tsx`)**:
   - Render `<HeardBadge heardVerified={u.heard_verified} heardAt={heardStatus?.heard_at} badgeLabel={heardStatus?.badge_label} />` from `apps/child/components/sahaj/heard-badge.tsx`.
   - Add a navigation button to `/after-report?incidentId=${incidentId}` on `apps/child/app/incident.tsx`.
