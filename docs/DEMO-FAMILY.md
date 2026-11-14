# Sahaj Synthetic Demo Family (`Meena Sharma Family`)

This document is the single reference for the synthetic demo family seeded by [`infra/supabase/dev/seed_demo.sql`](../infra/supabase/dev/seed_demo.sql) + [`infra/supabase/dev/seed_demo_full.sql`](../infra/supabase/dev/seed_demo_full.sql) and verified by [`infra/supabase/tests/demo_seed_check.sql`](../infra/supabase/tests/demo_seed_check.sql).

- **Family ID:** `11111111-1111-4111-8111-111111111111` (`Meena Sharma Family`, `category = 'akele_ghar'`)
- **AI Principal ID (`atlas_principals`):** `44444444-4444-4444-8444-444444444441` (`Aasha Didi (Sahaj Core 1 Assistant)`)
- **Family Code Word (Core 3 + Core 2 any-phone line):** `"gulmohar"` (`sha256("gulmohar") = 95a55741b54dd9d41fd224c9260e630a9d5307165b4e2671b16d281c21d5d9df`)
- **Safe-Word Greeting:** `"Ram Ram Mummy ji"`
- **Expected Visitors (Core 3 Shield):** `"doodhwala subah 7 baje"`, `"Gupta Medical delivery"`

---

## 1. Who Is Who, Which Phone Plays Whom & Demo Scenes

| Person / Entity | Role & City | `person_id` | `auth.users.id` (`user_id`) | Synthetic E.164 (encrypted only) | Lab Env Var (Real Phone in Lab) | Real Phone Needed in Lab? | Demo Scenes Using This Person |
|---|---|---|---|---|---|---|---|
| **Meena, 67 ("Maa")** | `parent` · Lucknow (Akele Ghar — lives alone; address form `"Mummy ji"`, lang `hi`) | `22222222-2222-4222-8222-222222222221` | `33333333-3333-4333-8333-333333333331` | `+919000000001` | `LAB_PHONE_MAA_KEYPAD` (Lava keypad) & `LAB_PHONE_MAA_SMARTPHONE` (Android app, device `dddddddd-dddd-4ddd-8ddd-dddddddddd01`) | **Yes** (1 Lava keypad + 1 Android smartphone running `apps/parent`) | **Core 1:** Daily 10:00 IST check-in (`99999999-9999-4999-8999-999999999901`), quiet hours `21:00–08:00`, free time `"shaam 6 se 8"` (`18:00–20:00`), urgent 2-missed-call line, voice messages, Amlodipine 5 mg refill.<br>**Core 2:** Receives Riya's `"Main safe hoon"` reassurance & truth line.<br>**Core 3:** Keypad call gateway screening, busy-line watch, scam SMS/WhatsApp/call shield, `"gulmohar"` code word, opt-in experience drills. |
| **Riya** | `child` · Bengaluru (Daughter; Core 2 subject) | `22222222-2222-4222-8222-222222222222` | `33333333-3333-4333-8333-333333333332` | `+919000000002` | `LAB_PHONE_RIYA` | **Yes** (Smartphone running `apps/child` + Expo push token) | **Core 1:** Circle Rank 3; receives "Maa's day" check-in recap, urgent incident push alerts, two-way voice posts, and Permission #12 / two-person approval cards.<br>**Core 2:** Late-home watch subject, SOS trigger, `"Main safe hoon"` reassurance sender, borrowed-phone caller using code word `"gulmohar"`.<br>**Core 3:** Receives Shield red/yellow scam alerts, family-check prompts, and controls Maa's experience-drill switch. |
| **Rohit** | `child` · Pune (Son; on duty this week) | `22222222-2222-4222-8222-222222222223` | `33333333-3333-4333-8333-333333333333` | `+919000000003` | `LAB_PHONE_ROHIT` | **Yes** (Smartphone / WhatsApp & Twilio receiver) | **Core 1:** **Circle Rank 1** for Maa (offered first on urgent help; when skipped/declined, escalates to Sharma uncle); second approver for two-person errands > ₹600; two-way voice share with Maa.<br>**Core 2:** Rank 2 trusted contact for Riya.<br>**Core 3:** WhatsApp family-check / lab live-check target. |
| **Sharma uncle** | `circle` · Lucknow (Neighbour, 3 min from Maa) | `22222222-2222-4222-8222-222222222224` | `33333333-3333-4333-8333-333333333334` | `+919000000004` | `LAB_PHONE_SHARMA` *(optional; played by teammate phone in live urgent-call demo)* | **Optional** (Needed when demonstrating live Twilio DTMF `"1 dabaiye — main ja raha hoon"` call acceptance) | **Core 1:** **Circle Rank 2** for Maa (`access = 'incident_only'`, consented & approved; offered `"go to Maa"` when Rohit cannot answer, presses `1` to accept). |
| **Priya** | `circle` · Bengaluru (Riya's local friend) | `22222222-2222-4222-8222-222222222225` | `33333333-3333-4333-8333-333333333335` | `+919000000005` | `LAB_PHONE_PRIYA` *(optional; played by teammate phone in live Core 2 escalation demo)* | **Optional** (Needed when demonstrating live Core 2 watch escalation / SOS call or WhatsApp to Riya's local trusted contact) | **Core 2:** **Trusted Contact Rank 1** for Riya (`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01`, `state = 'active'`, consented & approved for `sos`, `watch_escalation`, `reassurance`). |
| **Gupta Medical** | `vendor` · Lucknow (Approved chemist) | `22222222-2222-4222-8222-222222222226` | `33333333-3333-4333-8333-333333333336` | `+919000000006` | `LAB_PHONE_GUPTA_MEDICAL` *(optional)* | **No** (Simulated via outbox / Sarvam vendor call or optional phone) | **Core 1:** Approved pharmacy vendor (`vendor_id = 66666666-6666-4666-8666-666666666661`) for Maa's **Amlodipine 5 mg** refill under **Permission #12**.<br>**Core 3:** Listed in Maa's expected visitors (`"Gupta Medical delivery"`), forwarded cleanly by Call Gateway. |

---

## 2. Core-by-Core Seeded Artifacts & IDs

### Core 1 ("Pulse")
- **Check-in Schedule (`public.schedules`):**
  - `id = 99999999-9999-4999-8999-999999999901`
  - `person_id = 22222222-2222-4222-8222-222222222221` (Maa), `kind = 'check_in'`, `timezone = 'Asia/Kolkata'`, daily at **10:00 IST**, `enabled = true`.
  - Quiet hours: `21:00–08:00` IST (`people.quiet_windows`). Free window: `"shaam 6 se 8"` (`18:00–20:00` IST, `people.free_windows`).
- **Circle of Care (`public.circle`):**
  1. **Rank 1:** Rohit (`cccccccc-cccc-4ccc-8ccc-cccccccccc01`, `access = 'family'`, on duty this week, approved & consented).
  2. **Rank 2:** Sharma uncle (`cccccccc-cccc-4ccc-8ccc-cccccccccc02`, `access = 'incident_only'`, neighbour, approved & consented, offered `"go to Maa"`).
  3. **Rank 3:** Riya (`cccccccc-cccc-4ccc-8ccc-cccccccccc03`, `access = 'family'`, approved & consented).
- **Medicine (`public.medicines`):**
  - `id = 55555555-5555-4555-8555-555555555551`
  - `label = 'Amlodipine 5 mg'`, dosage `1 per day`, `remaining_count = 6`, `refill_threshold = 7` (low-stock threshold reached at 6), `instructions_confirmed_by_person = true`.
- **Approved Vendor (`public.vendors`):**
  - `id = 66666666-6666-4666-8666-666666666661` (`person_id = 22222222-2222-4222-8222-222222222226`, `category = 'pharmacy'`, approved).
- **Permission #12 (`public.permissions`):**
  - **Inside-limit rule (`id = 77777777-7777-4777-8777-777777777712`):** `action = 'medicine_refill'`, `decision = 'allow'`, `max_amount_minor = 60000` (≤ ₹600), `max_uses = 1` (once a month), `used_count = 0`, vendor `Gupta Medical`, item `Amlodipine 5 mg`, expires **31 Dec 2026** (`2026-12-31T23:59:59+05:30`), `two_person_required = false` (single-approver / setup inside limit).
  - **Above-limit rule (`id = 77777777-7777-4777-8777-777777777713`):** `action = 'medicine_refill'`, `decision = 'allow'`, `two_person_required = true` for amounts above ₹600 (up to ₹5,000).
  - **Core 1 operational permissions:** `check_in` (`77777777-7777-4777-8777-777777777701`), `urgent_responder` (`77777777-7777-4777-8777-777777777702`), `missed_call_nudge` (`77777777-7777-4777-8777-777777777703`), `family_report` (`77777777-7777-4777-8777-777777777704`).

### Core 2 (Adult Child Safety)
- **Trusted Contacts (`public.core2_trusted_contacts`):**
  - **Rank 1:** Priya (`id = aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01`, `subject_person_id = Riya`, `contact_person_id = Priya`, `scopes = ['sos','watch_escalation','reassurance']`, `state = 'active'`, consented & approved).
  - **Rank 2:** Rohit (`id = aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02`, `subject_person_id = Riya`, `contact_person_id = Rohit`, `scopes = ['sos','watch_escalation','reassurance']`, `state = 'active'`, consented & approved).
- **Reassurance & Sharing Preferences (`public.core2_sharing_preferences`):**
  - `share_status_with_parent = true`, `allow_narrative_share = true`, `allow_location_share = false`, `allow_health_share = false`.
- **Device Status (`public.core2_device_status`):**
  - Riya's phone battery `84%`, `is_charging = false`, recent heartbeat recorded.

### Core 3 ("Shield")
- **Code Word (`public.shield_family_security`):**
  - Plaintext word: `"gulmohar"` → stored only as `code_word_hash = 95a55741b54dd9d41fd224c9260e630a9d5307165b4e2671b16d281c21d5d9df`.
- **Safe-Word Greeting & Expected Visitors (`public.people.free_windows` + `public.dev_cache`):**
  - Key: `shield:family:11111111-1111-4111-8111-111111111111:security_meta`
  - Safe-word greeting: `"Ram Ram Mummy ji"`
  - Expected visitors: `["doodhwala subah 7 baje", "Gupta Medical delivery"]`
- **Maa's Two Devices / Identities:**
  1. **Lava Keypad:** `public.shield_gateway_parents` (`phone_hash = sha256('9000000001')`) + `public.provider_identities` (`binding_kind = 'device'`, `source = 'sarvam'`).
  2. **Android Smartphone:** `public.shield_devices` (`id = dddddddd-dddd-4ddd-8ddd-dddddddddd01`, all 6 protections enabled) + `public.provider_identities` (`binding_kind = 'device'`, `source = 'whatsapp'`).
- **Opt-in Experience Drills:**
  - `public.shield_drill_consents` (`id = eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01`, active recorded consent from Maa).
  - `public.shield_experience_settings` (`experience_drills_enabled = true`, enabled by Riya).

---

## 3. Contact Encryption & Lab Phone Binding

Plaintext phone numbers are **never** stored in database columns (Ground Rule #1).
- In disposable tests and local lab resets, `seed_demo.sql` and `seed_demo_full.sql` populate `public.provider_identities` (`binding_kind = 'contact'`) for `+919000000001`..`+919000000006` across `whatsapp`, `sarvam`, `twilio`, and `telecmi` using the public test-only fixture key documented in [`infra/supabase/dev/README.md`](../infra/supabase/dev/README.md).
- When running live calls/messages in the physical lab with real phones (`LAB_PHONE_MAA_KEYPAD`, `LAB_PHONE_MAA_SMARTPHONE`, `LAB_PHONE_RIYA`, `LAB_PHONE_ROHIT`, and optionally `LAB_PHONE_SHARMA` / `LAB_PHONE_PRIYA`), register or rotate the live contact ciphertexts using `registerContactIdentity` (which calls `public.register_contact_identity`) under the lab's real `WEBHOOK_ENCRYPTION_KEY` and `IDENTITY_HASH_SECRET`.

