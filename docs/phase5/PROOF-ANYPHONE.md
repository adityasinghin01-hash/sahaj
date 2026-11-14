# Core 2 — Fresh Proof of Life (`I2`) + Any-Phone Line (`G10` / `I3`)

This document describes the server contracts, Sarvam Samvaad tool integration, post-call live voice recording relay, mobile clients, and security invariants for **AGY-X1**:

1. **I2 — Fresh Proof of Life (anti-voice-clone word challenge)**:
   - Maa (or Shield when a scammer claims *"Riya is in trouble / send money"*) triggers *"Riya theek hai?"*.
   - Server issues a 60-second (`× DEMO_TIMER_SCALE`) challenge with a random Hindi/Hinglish word (`gulab`, `elaichi`, `tulsi`, `kesar`, `badam`, `haldi`, `genda`, `mishri`, `chandan`, `neelam`, `amrud`, `chameli`).
   - Riya gets a push notification (`"Maa puch rahi hain — Bolo: <word>"`), records a fresh clip (`<= 30 s`), and uploads it.
   - Server verifies the spoken word via **Sarvam Saaras v3 STT** (`mode=codemix`, Roman + Devanagari aliases) and delivers the verified voice clip to Maa with a freshness stamp:
     - `"Riya ne 40 second pehle ye kaha."` / `"Riya said this 40 seconds ago."`
   - If Riya does not answer within 60 seconds, the challenge escalates to the named local circle contact (e.g., Priya) via Core 2's sequential escalation and tells Maa:
     - `"Riya se abhi baat nahi hui, Priya unke paas ja rahi hai. Paise bilkul mat bhejiye."`

2. **G10 / I3 — Any-Phone Line (Shield code word = identity)**:
   - Riya's phone is dead, lost, or stolen; she borrows any stranger's or shopkeeper's phone, dials the Sahaj number, and says her name + family Shield code word.
   - Reuses Shield's `checkCodeWord` (`packages/shield/src/tools/check_code_word.ts`) against `families.code_word_hash`.
   - **Caller number privacy**: Caller's phone number is never spoken, never stored in plain text, and never returned in any API/tool response (`call_ref` is SHA-256 hashed if present).
   - **3-strike 15-minute lock**: 3 wrong code word attempts lock any-phone verification for 15 minutes (`core2_record_any_phone_attempt`).
   - **Automatic code-word rotation**: After a successful verification, the family's `code_word_hash` is rotated immediately so an overheard code word cannot be replayed.
   - **Limited powers**: Session grants only `["reassure_maa", "alert_local_circle", "relay_live_voice"]` and explicitly denies `["change_settings", "view_location", "approve_money"]`.
   - **Live voice relay**: Post-call recording (`POST /api/core2/any-phone/recording`, Twilio HMAC or Sarvam Bearer) stores Riya's real voice in `voice_posts` + `voice_media` and triggers Core 1 `notifyVoicePost` so Maa hears Riya's real voice (never AI imitating Riya).

---

## Database Migration

- **Migration**: `infra/supabase/migrations/20261115002000_core2_proof_anyphone.sql`
- **SQL Test**: `infra/supabase/tests/core2_proof_anyphone.sql`
- **Tables & RPCs**:
  - `public.core2_proof_challenges`: word token, aliases, status (`pending | verified | word_mismatch | expired | escalated`), `ttl_seconds`, `expires_at`, `voice_media_id`, `voice_post_id`, `stt_transcript`, `stt_matched`, `incident_id`, `offered_contact_person_id`, `offered_contact_name`.
  - `public.core2_any_phone_guards`: per-family 3-strike counter + `locked_until` (`15 min`).
  - `public.core2_any_phone_sessions`: verified session with `call_ref_hash` (no plain phone number), `granted_powers`, `denied_powers`, `code_word_rotated`, `voice_post_id`, `status_message_hi`, `status_message_en`.
  - `public.core2_claim_due_proof_challenges(p_now, p_limit)`: `FOR UPDATE SKIP LOCKED` claim for expired challenges.
  - `public.core2_record_any_phone_attempt(p_family_id, p_ok, p_now, p_max_attempts, p_lock_seconds)`: atomic lock + counter update.

---

## HTTP Routes & JSON Contracts

### 1. `POST /api/core2/proof`
Creates a fresh proof-of-life word challenge (Bearer JWT, parent or child in family).

**Headers**:
- `Authorization: Bearer <supabase-jwt>`
- `Idempotency-Key: <ascii-1..128>` (optional)

**Request JSON** (optional):
```json
{
  "subject_person_id": "c5000000-0000-4000-8000-000000000001"
}
```

**Response `201 Created`**:
```json
{
  "ok": true,
  "challenge": {
    "id": "99000000-0000-4000-8000-000000000501",
    "family_id": "b5000000-0000-4000-8000-000000000001",
    "requester_person_id": "c5000000-0000-4000-8000-000000000002",
    "subject_person_id": "c5000000-0000-4000-8000-000000000001",
    "subject_display_name": "Riya",
    "word_token": "gulab",
    "prompt_hi": "Bolo: gulab",
    "prompt_en": "Say the word: gulab",
    "status": "pending",
    "ttl_seconds": 60,
    "expires_at": "2026-11-15T10:01:00.000Z",
    "answered_at": null,
    "verified_at": null,
    "escalated_at": null,
    "freshness_seconds": null,
    "freshness_stamp_hi": null,
    "freshness_stamp_en": null,
    "escalation_message_hi": null,
    "escalation_message_en": null,
    "offered_contact_name": null,
    "incident_id": null,
    "voice_post_id": null,
    "media_url": null,
    "attempts": 0,
    "created_at": "2026-11-15T10:00:00.000Z"
  }
}
```

### 2. `GET /api/core2/proof` & `GET /api/core2/proof/[id]`
Fetches the latest (or specific) proof challenge for the family. Automatically evaluates whether a pending challenge has passed `expires_at` and escalates to the named local circle contact if due.

### 3. `POST /api/core2/proof/[id]/answer`
Riya submits her freshly recorded voice clip (`<= 30 s`) for Saaras STT word verification.

**Request JSON**:
```json
{
  "voice_media_id": "99000000-0000-4000-8000-000000000502",
  "duration_s": 4
}
```

**Response `200 OK` (verified)**:
```json
{
  "ok": true,
  "matched": true,
  "challenge": {
    "id": "99000000-0000-4000-8000-000000000501",
    "status": "verified",
    "word_token": "gulab",
    "freshness_seconds": 0,
    "freshness_stamp_hi": "Riya ne 0 second pehle ye kaha.",
    "freshness_stamp_en": "Riya said this 0 seconds ago.",
    "media_url": "https://.../voice/..."
  }
}
```

**Response `422 Unprocessable Entity` (word mismatch, retryable before 60s expiry)**:
```json
{
  "ok": false,
  "matched": false,
  "error": "word_mismatch",
  "message": "The spoken word did not match \"gulab\". Please say \"gulab\" clearly.",
  "challenge": {
    "id": "99000000-0000-4000-8000-000000000501",
    "status": "word_mismatch",
    "attempts": 1
  }
}
```

### 4. `GET /api/core2/maa-proof` & `POST /api/core2/maa-proof`
Maa's paired device route, authenticated via Shield's HMAC headers (`x-sahaj-device`, `x-sahaj-ts`, `x-sahaj-sig`) reusing `apps/api/src/app/api/core1/maa/_lib/device-auth.ts`.
- `POST /api/core2/maa-proof` starts a new 60-second word challenge for Riya.
- `GET /api/core2/maa-proof` returns both the latest `proof` challenge (with signed `media_url` and `"Riya ne 40 second pehle ye kaha."`) and the latest `any_phone` session (with `"Riya ne kisi aur ke phone se call kiya — ..."` and signed `media_url`).

### 5. `POST /api/core2/any-phone/verify` (Sarvam Samvaad Tool `any_phone_verify`)
Called by Antara during an inbound call when the caller says they are calling from another phone.

**Authentication**: `Authorization: Bearer <SARVAM_TOOL_TOKEN>`

**Request JSON**:
```json
{
  "family_id": "b5000000-0000-4000-8000-000000000001",
  "said_name": "Riya",
  "said_code_word": "kesar",
  "status_kind": "help",
  "call_ref": "call-sid-synthetic-001"
}
```

**Response `200 OK` (verified)**:
```json
{
  "ok": true,
  "verified": true,
  "locked": false,
  "session_id": "99000000-0000-4000-8000-000000000505",
  "subject_person_id": "c5000000-0000-4000-8000-000000000001",
  "subject_display_name": "Riya",
  "incident_id": "99000000-0000-4000-8000-000000000503",
  "offered_contact_name": "Priya",
  "code_word_rotated": true,
  "granted_powers": ["reassure_maa", "alert_local_circle", "relay_live_voice"],
  "denied_powers": ["change_settings", "view_location", "approve_money"],
  "status_message_hi": "Riya ne kisi aur ke phone se call kiya — madad bheji ja rahi hai",
  "status_message_en": "Riya called from another phone — help is being sent",
  "speak_hi": "Code word sahi hai Riya. Aap abhi apni aawaz mein Maa ke liye chhota sandesh boliye — hum aapki asli aawaz Maa ko sunayenge, aur Priya ko bhi bhej rahe hain. Suraksha ke liye code word ab badal diya gaya hai.",
  "speak_en": "Code word verified, Riya. Please speak a short message in your own voice for Maa — we will play your real voice to her, and we are alerting Priya. For safety, your family code word has now been rotated."
}
```

### 6. `POST /api/core2/any-phone/recording`
Ingests the post-call live voice recording from Twilio (`application/x-www-form-urlencoded` + `X-Twilio-Signature`) or Sarvam (`application/json` + `Authorization: Bearer <SARVAM_TOOL_TOKEN>`), attaches the real voice clip to the any-phone session, and triggers `notifyVoicePost` so Maa hears Riya's real voice.

---

## Verification Commands

```bash
pnpm -F @sahaj/api exec vitest run tests/core2-proof
pnpm -C apps/child exec tsc --noEmit
pnpm -C apps/parent exec tsc --noEmit
```
