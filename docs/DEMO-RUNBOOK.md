# Sahaj real-phone demo runbook (p10/integrate 66c705c)

Written from the code at 66c705c. Every quoted label cites its file. Paths are repo-relative. `parent/` = `apps/parent/`, `child/` = `apps/child/`, `shield/` = `apps/parent/modules/sahaj-shield/android/src/main/java/app/sahaj/shield/` (Kotlin).
Role names only; real numbers live in `LAB_PHONE_*` env vars (`docs/DEMO-FAMILY.md:15-22`).

> **Update 15 Nov 03:16 IST:** the section 0 blockers are fixed. The lab now serves all three cores behind the same public URL (apps/api + shield-api via scripts/lab/proxy.mjs). C-15 + K-DELIVER make Core 2 / phone-dying / refill sends reach the outbox. The keypad Core 1 tools answer for real (commit 792208b).

## 0. Read this before 03:15: blockers found in code

| # | Blocker | Evidence | Effect on stage |
|---|---|---|---|
| B1 | The lab and tunnel serve only `apps/shield-api` on :3100. All `/api/core1/*` and `/api/core2/*` routes live in `apps/api`, which no lab script starts, and nothing routes them through the tunnel. | `scripts/lab/_common.sh:17`, `scripts/lab/tunnel.sh:80-91`, `ls apps/shield-api/src/app/api` (no core1/core2), `docs/sarvam-setup.md:67` | **Every Core 1 and Core 2 live scene returns 404**, both in Riya's app (`child/lib/core1.ts:314`, `child/lib/core2.ts:229`) and in Maa's app (`parent/src/lib/maa-api.ts:123-156`, `maa-proof.ts:107`, `maa-heard.ts:88`). The single server address on both apps points at :3100. |
| B2 | `apps/api` needs hosted Supabase (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`), not the lab Postgres. Its crons (`/api/cron/tick`, `/api/core2/cron/overdue`, `/api/core2/device-status/tick`, `/api/core1/matcher/tick`, `/api/core2/news/tick`) are not scheduled. | `apps/api/src/lib/database.ts:5-8` | Even if started, check-in retries, watch overdue, phone-dying and matcher never fire on their own. |
| B3 | Every Core 2 send fails closed with 503 "Core 2 authorized dispatch binding is not integrated." | `apps/api/src/lib/core2/supabase.ts:1168-1175`, `core2-device/supabase.ts:38-41`, `core2-news/service.ts:134` | Watch escalation, SOS, "Main safe hoon" push, gentle news and phone-dying notices **send nothing**. |
| B4 | Keypad `raise_urgent` (Sarvam tool) only queues a generic command. It does not start the Twilio urgent chain. | `apps/api/src/lib/core1/sarvam-tools/production.ts:119-122`, `core1/service.ts:167-185` | Speed dial 2 → "madad" will **not** ring Rohit. Only Maa's smartphone SOS (`POST /api/core1/maa/urgent`) or Riya's app starts the chain. |
| B5 | Inbound Sarvam calls get no `family_id`/`parent_id`. | `docs/sarvam-setup.md:37,139,210,212` | Shield tools answer `400 missing_context`; Core 1 tools transfer to Riya. Needs Antara's agent config. |
| B6 | Family-check answers arrive only through WhatsApp replies (haan/1, nahi/2). No app button answers it. | `packages/shield/src/lib/whatsapp_inbound.ts:31-32`, `tools/family_check.ts:31-72` | Without WhatsApp, the family check ends as no-answer and Maa gets the callback "Abhi jawab nahi aaya…" (`tools/lines.ts:30`). Scene C in `scripts/lab/scenes.mjs` fakes Rohit denying it. |
| B7 | Maa's app cannot receive pushes. | §5 | Maa must open or return to Home to see new items. |
| B8 | The Maa APK bakes in `EXPO_PUBLIC_SAHAJ_PARENT_ID`, `EXPO_PUBLIC_SAHAJ_FAMILY_ID` and `EXPO_PUBLIC_SAHAJ_CHILD_NUMBER` at build time. If either ID is missing and a server is set, pairing fails. | `parent/src/lib/pairing.ts:11,19-21`, `parent/src/lib/demo.ts:14` | Check the EAS build env before installing. |
| B9 | `SAHAJ_LAB_MODE` does not exist anywhere in the repo. "Lab mode" for Riya is: sign in with a 12-hour JWT minted by a script. | `grep -r SAHAJ_LAB_MODE` (no hits); `apps/shield-api/scripts/mint-lab-token.mjs:4-22` | See §3. |

**What works on the current lab (:3100):** Core 3 Shield on Maa's phone (SMS, calls, WhatsApp notifications, warnings), pairing, Riya Shield tab, alerts, timeline, the test alarm and Riya's push for Shield verdicts. Core 1 and Core 2 run only as the labelled demo (signed out) unless B1–B3 are fixed.

## 1. Install (both APKs)

| Step | Phone | Do | Check |
|---|---|---|---|
| 1.1 | phone1 (Maa) | Open the Maa APK link: `<EAS link: Sahaj Maa, package app.sahaj.parent>` (`parent/app.json`; `parent/eas.json` profile `preview`, apk). | Download done |
| 1.2 | Riya phone | Open the Riya APK link: `<EAS link: Riya app>` (`child/eas.json`). If there is no phone, use the web export (§3.4). | Download done |
| 1.3 | each | When Android asks, go to Settings → "Install unknown apps" → allow the browser / Files app → Install. | App icon shows "Sahaj Maa" / Riya app |
| 1.4 | phone1 | Android 13+: App info → Sahaj Maa → ⋮ → "Allow restricted settings". Without this, SMS and notification access stay greyed out. The wizard has this step too (§2, step 6). | Menu item gone |
| 1.5 | phone1 | Battery: App info → Battery → Unrestricted (the wizard step "Keep Sahaj running" asks too). On OEM phones also enable Autostart. | ☐ |
| 1.6 | Riya phone | Battery → Unrestricted, so the red alarm is not delayed. | ☐ |

## 2. Maa app setup (phone1)

The wizard opens from the Home chip "Needs setup" / "सहज सेटअप बाकी है" (`parent/src/app/index.tsx:66-77`), or Settings → "Set up phone" (`parent/src/app/settings.tsx`). Steps come from `parent/src/lib/setup.ts:26-39`, and the screen is `parent/src/app/setup/[step].tsx`. The header shows "कदम n / 11".
Main button: "Allow"/"अनुमति दें". On steps 6–8 it reads "Open settings"/"सेटिंग खोलें", on step 9 "Turn on"/"चालू करें" and on step 11 "Test"/"जाँचें" (`[step].tsx:139-146`). Second button: "Skip"/"छोड़ें" → "Next"/"आगे" → "Done"/"हो गया" (`:200`). The ✓ refreshes when you come back from Settings (`:60-62`).

**Before step 1:** Riya creates the code (§3.3). It expires in 10 min.

| # | Title (hi / en) | Grants | How | ☐ |
|---|---|---|---|---|
| 1 | "रिया से जोड़ें" / "Pair with Riya" | Server address + pairing | Type the **"Server address"** field (placeholder "https://your-shield-server") = contents of `~/.sahaj-lab/public-url.txt` (HTTPS origin, no path; `parent/src/lib/server-address.ts:2-16`). Then type the 6-digit code from Riya's app on the keypad; it submits on the 6th digit. Success shows "Paired with Riya". Failure: "कोड नहीं चला। फिर से डालें।" (`[step].tsx:227-260`). Calls `POST /api/shield/pair` (`parent/src/lib/pairing.ts:24-36`). | ☐ |
| 2 | "SMS पढ़ना" / "Read SMS" | RECEIVE_SMS, READ_SMS | System dialog (`shield/SahajShieldModule.kt:114-116`) | ☐ |
| 3 | "फ़ोन और संपर्क" / "Phone and contacts" | READ_PHONE_STATE, READ_CONTACTS, CALL_PHONE, POST_NOTIFICATIONS (13+) | System dialogs (`:122-126`) | ☐ |
| 4 | "ऊपर चेतावनी दिखाना" / "Show warnings on top" | SYSTEM_ALERT_WINDOW | Settings page → toggle on → Back (`:249-256`) | ☐ |
| 5 | "कॉल जाँचना" / "Check calls" | ROLE_CALL_SCREENING | System role dialog → pick Sahaj Maa (`:128-136`) | ☐ |
| 6 | "प्रतिबंधित सेटिंग की अनुमति" / "Allow restricted settings" | Sideload unlock | App info → ⋮ → "Allow restricted settings". Shows "Not needed on this phone" below SDK 35 (`[step].tsx:103-106`). | ☐ |
| 7 | "कौन सा ऐप खुला है" / "See which app is open" | PACKAGE_USAGE_STATS | Usage access list → Sahaj Maa → on (`:169-172`) | ☐ |
| 8 | "WhatsApp सूचनाएँ पढ़ना" / "Read WhatsApp alerts" | Notification listener | Notification access → Sahaj Maa → allow (`:177-188`) | ☐ |
| 9 | "ऐप जाँच" / "App check" | No permission; turns on the installed-apps scan (now + every 6 h) | In the app | ☐ |
| 10 | "सहज चालू रखें" / "Keep Sahaj running" | REQUEST_IGNORE_BATTERY_OPTIMIZATIONS | System dialog → Allow. Also tap "ऑटोस्टार्ट" / "Autostart" on OEM phones (`shield/KeepAlive.kt:59-60`, `[step].tsx:193`). | ☐ |
| 11 | "जाँच अलर्ट" / "Test alert" | None | Tap "जाँचें": a red overlay appears (native `testRedScreen`, or `/warning?test=1` if overlay is missing). Shows "Maa has seen the warning". | ☐ |

**After setup:**
- The Home chip must read "Sahaj is on ✓" (`index.tsx:66-77`). It turns on only when SMS, phone, contacts, overlay, the screening role, pairing and the JSON rules are all OK.
- The ongoing notification reads "सहज सुरक्षा चालू है" (`shield/Notifications.kt`).
- **Not in the wizard:** ROLE_CALL_REDIRECTION, which the P8 "pause risky calls" feature needs. Grant it from the hidden debug screen: long-press the "Sahaj" title for 3 s (`index.tsx:146`) → ShieldTestScreen (`parent/src/debug/ShieldTestScreen.tsx:30`). Also turn on Settings → "Pause risky calls".
- The server address has no Settings field. To change the tunnel URL, re-run "Set up phone" and re-pair with a new code.

## 3. Riya app / web setup

### 3.1 Mint a token (laptop)
`node apps/shield-api/scripts/mint-lab-token.mjs 33333333-3333-4333-8333-333333333332` gives a JWT valid for 12 h (`scripts/lab/README.md:54-71`). Send it to Riya's phone via a private channel; never paste it into chat or logs.

### 3.2 Sign in
Signed-out Home → "Connect live Shield" (`child/app/(tabs)/index.tsx`) → screen "Lab sign-in" / "Connect Riya's Shield" (`child/components/sahaj/live.tsx:593-670`).

| Field / button | Value |
|---|---|
| "API URL" | Tunnel URL from `public-url.txt` (HTTPS origin only; `child/lib/session.ts:55-71`) |
| "Access token" | JWT from 3.1 |
| "Connect" | Calls `GET /api/app/shield/summary`, then opens the Shield tab |
| "Use labelled Demo / sign out" | Back to synthetic demo |

- **Push:** after sign-in the native app asks for notification permission once (`child/lib/notifications.tsx:33-43,123-130`), then registers via `POST /api/app/push-token`. The status line must read "Push alerts are connected." If it reads "Push alerts are off: finish eas init…", the build has no EAS projectId.
- **DND prompt:** next comes "Maa ka red alarm · DND access (optional)". Tap "Open DND settings" and allow (`child/lib/shield-alarm.ts:48-71`).

### 3.3 Pair code for Maa
In the signed-in Home or Shield tab session bar, tap **"Pair Maa's phone"** → **"Create pairing code"** (`live.tsx:68,529-592`). Read the 6 digits to the lead. The screen shows "Expires {time}". Codes are single-use and last 10 min; 5 wrong tries lock pairing for 10 min (`packages/shield/src/server/pairing.ts:11,26-67`).

### 3.4 Test alarm
Shield tab → "Red alert alarm" → **"Test alarm"** (`child/components/sahaj/alarm-settings.tsx:10-37`). Lock the phone. About 2 s later the red-channel alarm "🔴 Test alarm · Maa ka Shield" sounds. Tapping it opens "Test alarm · sirf test hai" → "Back to Shield" (`child/app/alert.tsx:133-152`). It is local only and not available on web. ☐

### 3.5 Web fallback (no Riya phone)
- `pnpm -C apps/child exec expo export --platform web --output-dir /tmp/riya-web`, then serve it with SPA fallback.
- Or run `pnpm --dir apps/child dev` and press `w` (port 8081).
- `APP_ALLOWED_ORIGINS` allows only ports 8081, 19006 and 3000 (`scripts/lab/_common.sh:148`), so serve the export on 3000 or add the port.
- Web has **no push and no test alarm**. Watch the Shield tab and Timeline instead.

## 4. Scene checklist

**Legend:**
- Maa-K = Lava keypad. Maa-S = phone1. "Scammer" = phone1 calling or texting the Lava, or the lead's laptop.
- Timers are divided by `DEMO_TIMER_SCALE=60` (`scripts/lab/_common.sh:145`), so 60 s becomes 1 s and the 30 s cron loop decides when things fire.
- Alternative: `node scripts/lab/scenes.mjs --only <A,C,…>` replays the 14 Shield scenes without phones.

### Core 3 Shield (works on lab :3100)

| Scene | Who / where does what | Must appear | ☐ |
|---|---|---|---|
| S1 Scam SMS link | Lead sends a scam SMS (KYC/link text) from an unsaved number to **Maa-S**. | Maa-S: red overlay "रुकिए! यह धोखा हो सकता है।" + clip line 1, buttons "Theek hai" / "{Riya} ko call karo" (`shield/AlertController.kt:75,135-145,301`). Riya: red push → `/alert?id=` with "Masked message", "Why Shield flagged it", "What Maa was told" (`child/lib/push-routes.ts`, `live.tsx:265-369`). Timeline: new signed row ("Verify hash chain" OK). | ☐ |
| S2 Unknown caller after scam SMS (P8) | After S1, Maa-S taps to call back the number from the SMS (needs ROLE_CALL_REDIRECTION + "Pause risky calls"). | Maa-S: pause overlay "Ruk jaiye. Ye number ek fraud message se aaya tha…" + clip line 3, buttons "Phir bhi call karo" (green) / "Mat karo" (`AlertController.kt:113-131`, `shield/Phase2.kt:13-17`). The call is never blocked: "Phir bhi call karo" lets it through. | ☐ |
| S2b Unknown incoming call | Unsaved number calls Maa-S. | Call always rings (`ShieldCallScreeningService`, allow-only). If the call is P1-flagged, after hang-up the notification "अभी वाली कॉल के बारे में एक सवाल" appears (`shield/ShieldRuntime.kt:171-174`) → S5. | ☐ |
| S3 Video-call "police" (P2) | Unsaved WhatsApp contact makes a long video call to Maa-S (needs notification access). | Maa-S overlay text "Police kabhi video call par arrest nahi karti. Phone kaat dijiye. Riya aapko abhi call karegi." + clip line 4 (`Phase2.kt:24-29`). Riya: push + alert (rule `digital_arrest`, `packages/shield/rules/rules.json:146-158`). | ☐ |
| S4 OTP ask | SMS to Maa-S asking her to share an OTP. | Red overlay; the app warning reason reads "Someone is asking for your OTP." (`parent/src/app/warning.tsx:20-33`). Riya: alert shows the OTP masked as `******`. | ☐ |
| S5 1930 after a loss | Maa-S: tap the after-call notification (or Settings → "After-call question") → "Did you share an OTP or PIN?" → "हाँ, OTP बताया". | "Call 1930 now." with buttons "Call 1930" (`tel:1930`), "Call Riya" and "Home" (`parent/src/app/after-call.tsx:36-51`). On keypad, Aasha Didi tool `money_sent` speaks line 7 "Paise chale gaye hain toh abhi 1930 par call kijiye…" (`packages/shield/src/tools/money_sent.ts`, `lines.ts:7`), only if B5 is fixed. Riya: report pack → "Copy for 1930" (`live.tsx:430-517`). | ☐ |
| S6 Family check "Rohit se pooch rahi hoon" | Maa-K: speed dial 2 → tells Aasha Didi "Rohit ne paise maange". | Aasha says "Ek minute rukiye ji, main Rohit se pooch rahi hoon." (`packages/shield/src/tools/lines.ts:25`). Rohit gets a WhatsApp card (B6: dev_outbox only without `WHATSAPP_TOKEN`). After 60 s with no tap, Sarvam rings Rohit; at 120 s Maa gets a callback (`jobs/family_check_jobs.ts:60-61`, scaled). **Needs B5 + B6.** The smartphone app does not play this line by itself (clip 8 exists but no screen calls it). | ☐ |
| S7 Drill 9a / 9b | Lead: `POST /api/dev/shield/experience-drill` with `x-dev-admin-token` (`apps/shield-api/src/lib/experience_routes.ts:44-49`), or the drill rides in the check-in (`drill_answer`). Allowed at most once per 7 days, never 20:00–09:00 (`docs/sarvam-setup.md:169`). | Maa-K is rung; handled safely → praise (9a), otherwise → gentle correction (9b). The clips `warning-clips/9a.mp3` and `9b.mp3` exist on phone1, but no app screen plays them (`WarningAudio.kt:9-11,33-46`). Riya: Shield tab "Maa's scam-sense". | ☐ |

### Core 1 Pulse (needs B1 + B2 fixed; else demo mode only)

| Scene | Who / where does what | Must appear | ☐ |
|---|---|---|---|
| P1 Urgent help | Maa-S: Home tile "Madad" (hold 2 s) → "Madad bulaun?" → "हाँ, मदद बुलाएँ" (`parent/src/app/index.tsx:118-138`). **Keypad speed dial 2 does not start the chain (B4).** | Server calls Rohit (phone3) with Twilio: AI disclosure, then "1 dabaiye — main ja raha hoon, 2 — nahi ja sakta" (10 s gather; `apps/api/src/lib/core1/urgent-help-service.ts:96-106`). Rohit presses **1**: only "1" counts as acceptance (`provider-ingestion/gateway.ts:22-23`). Riya: push `urgent_help` → `/incident` "Response order" with Rohit accepted (`child/components/sahaj/core1-screens.tsx:787-935`). Maa-S: `/madad` polls every 5 s and shows the status line (`parent/src/app/madad.tsx:16,46-72`). No answer in 3 min (scaled) → next rank. | ☐ |
| P2 Voice Riya → Maa | Riya: `/voice` → "Record voice" → "Stop recording" → consent "Yes" → **"Send voice message"** (`child/components/sahaj/core1-screens.tsx:516-785`). | Maa-K: Twilio call, AI disclosure, then the real recording, then "सुनने के लिए 1 दबाएँ, जवाब देने के लिए 2 दबाएँ" (`packages/adapters/src/twilio.ts:64-68`). Maa-S: open the app or return to Home → "▶ Riya ka sandesh" → `/voice` plays at 0.88× (`parent/src/app/voice.tsx`). Riya: heard badge. Needs `TWILIO_OUTBOUND_ENABLED=true` and related env (`apps/api/src/lib/core1/voice-notify.ts:114-124`). | ☐ |
| P3 Maa reply | Maa-S: `/voice` → "Jawab do · Reply" (≤30 s) → "Bhej diya ✓". Maa-K: press 2 → consent 1 → speak (≤60 s). | Riya: the `/voice` list shows an inbound item with "Play" / "Reply". | ☐ |
| P4 Refill → Riya approve | Check-in call: Maa-K says the medicine count (tool `medicine_count`). | Riya: `/refills` "Refill approvals" → **"Approve"** ("2-person required" chip) (`child/components/sahaj/core1-screens.tsx:1044-1051`). Never a payment. The push sender for refill does not exist yet (`child/lib/push-routes.ts:14-16`), so open `/refills` by hand. | ☐ |
| P5 Missed-call nudge | Lead: `POST /api/core1/missed-call-nudge` (member auth). The TeleCMI ingest is not wired up (`apps/api/src/lib/core1/missed-call-nudge-service.ts:495`). | Riya: Home card "Missed-call nudge from Sahaj" / "Maa gave a missed call — call when free" → "Open Maa's day" (`child/components/sahaj/core1-screens.tsx:204-250`). 1 call = single, 2 = repeated, 3+ = urgent (`packages/atlas/src/core1/missed-calls.ts:10-13`). | ☐ |
| P6 Check-in call | Lead: `node scripts/lab/sarvam-check.mjs --call-keypad` (one real Sarvam call to Maa-K; without the flag it is a dry run). | Maa-K rings, the agent says it is an AI. Riya: `/maa-day` "Recent check-ins" (needs apps/api). | ☐ |
| P7 Free-times matcher | Riya: `/free-times` → "Free now for 30 min" or "Save free window". Lead: `POST /api/core1/matcher/tick` (cron secret). | Riya push `core1.both_free_nudge` → `/maa-day` (`push-routes.ts`). Skipped in quiet hours or if they already talked today (`apps/api/src/lib/core1-matcher/matcher.ts:126-148`). | ☐ |
| P8 Family report | Riya: `/maa-day` → **"Request family report (7 days)"**. | Report text appears on `/maa-day` (`POST /api/core1/family-report`). | ☐ |

### Core 2 Riya's safety (needs B1 + B2; **B3 blocks every send**)

| Scene | Who / where does what | Must appear | ☐ |
|---|---|---|---|
| C1 Going-home watch → late → escalation | Riya: `/watch` → set ETA → **"Start watch"**. Do not respond. | At ETA: push `core2.watch_checkin` → `/watch` "Are you home, Riya?". After grace (10 min scaled): `escalated`, offer goes to Priya (rank 1), then Rohit (rank 2), each offer 120 s scaled (`apps/api/src/lib/core2/service.ts:600-645`). Live screen shows "Escalation recorded · response unconfirmed"; there is **no Priya/Rohit choice button**. The offer send itself hits B3. Overdue needs the `/api/core2/cron/overdue` cron. | ☐ |
| C2 SOS + cancel | Riya: `/sos` → "Request SOS" → "Confirm SOS", then "Cancel alert" (`child/components/core2/sos.tsx`, `core2-strings.ts:47-60`). | Timeline row for open → cancel. Notify sends hit B3. | ☐ |
| C3 "Main safe hoon" → Maa hears | Riya: `/safe` → kind "I'm safe" → **"Send update"**. | Push to Maa (`service.ts:1839-1860`) hits B3, and Maa's app has no push receiver (§5). Maa-K: speed dial 2 → "Riya kaisi hai?" → tool `child_status` reads the truth line. Maa-S: Home tile "Riya kaisi hai?". | ☐ |
| C4 Phone dying ≤10% | Riya phone at ≤10% battery (signed in; reports every 60 s, immediately when crossing 10%; `child/lib/device-reporter.ts:18-37`). | Riya banner at ≤15%: "Phone low — Priya and Maa will be told calmly if it dies" (`child/components/core2/device-banner.tsx`). Notices to Priya/Maa hit B3. Needs the `/api/core2/device-status/tick` cron. | ☐ |
| C5 Truth line `child_status` (keypad) | Maa-K: speed dial 2 → asks about Riya. | Aasha speaks a calm line, e.g. "Riya ne bataya hai ki woh surakshit hai." (`apps/api/src/lib/core1/sarvam-tools/handler.ts:96-109`), never the location (`formatCalmTruthLine`). Needs B5. | ☐ |
| C6 Proof-of-life word | Maa-S: Home → "Riya kaisi hai?" → `/riya` → "Hear Riya now" → `/proof` → "रिया ठीक है?" / "Ask Riya". Riya: `/proof` → "Record your voice (max 30 s)" while saying the word → **"Send to Maa"**. | Maa-S `/proof` (polls every 2.5 s, `parent/src/app/proof.tsx:42,225-230`): "Asked Riya to say "{word}" now." → fresh-voice card. Challenge TTL is 60 s scaled, so at scale 60 it lasts about 1 s; **set `DEMO_TIMER_SCALE=1` for this scene**. Needs `SARVAM_API_KEY` (Saaras). | ☐ |
| C7 Gentle news | Riya: `/after-report` → "Load Gentle News" → "Hurt / At Hospital — Circle ko pehle bhejein" / "Maa ke paas hoon (Queue calm Aasha Didi call)" (`child/app/after-report.tsx`). | A nearby circle member is told before Maa (`core2-news/service.ts:235-247`). The send hits B3. | ☐ |

**Fallback for every blocked row:** Riya signed out (labelled demo). Tap Riya's face 5× on Home → `/demo` → "Simulate 2 missed calls", "Send scam SMS scene", "Late-watch scene", "Reset demo" (`child/app/demo.tsx:39-50`). The footer says "Synthetic scenes. No real calls, messages or emergency alerts are sent." Say so on stage.

## 5. How Maa's smartphone learns about new items

There is no push receiver, no background fetch, and no notification for voice messages or family items.

| Item | Mechanism | File:line |
|---|---|---|
| New voice message badge "▶ Riya ka sandesh" | Fetched by `useFocusEffect` when Home gains focus; Home does not poll | `parent/src/app/index.tsx:63-81` |
| Voice screen list | Fetched once when the screen opens | `parent/src/app/voice.tsx:89-110` |
| Proof of life | Polls `GET /api/core2/maa-proof` every 2.5 s while open | `parent/src/app/proof.tsx:42,225-230` |
| Urgent help status | Polls `GET /api/core1/maa/urgent/{id}` every 5 s while open | `parent/src/app/madad.tsx:16,46-72` |
| Shield verdicts | Native: overlay or red notification; after-call notification deep link `sahajmaa://after-call` | `shield/Notifications.kt:27,162`, `ShieldRuntime.kt:171-174` |
| Red verdict while app open | Navigates to `/warning` | `parent/src/app/_layout.tsx:27-36` |

**On stage:** after Riya sends something, Maa (or the lead) must **open Sahaj Maa or go back to Home** (any screen → Home). There is no pull-to-refresh. If the fetch fails, Home shows "Could not reach Sahaj server…" → "Try again" (`index.tsx:215-229`). For proof and madad, keep the screen open and it updates by itself.

## 6. Known limits

| Limit | Detail |
|---|---|
| Twilio trial | Calls start with the trial preamble ("press any key") and can only reach **verified** numbers. Verify Lava, Rohit and Priya before 03:15. The urgent gather is 10 s and the voice gather 6 s, both after the preamble, so timing is tight. The repo has no trial handling. |
| Twilio status callback | The default is `/api/providers/twilio/status` (`voice-notify.ts:122`), but the route is `/api/twilio/status`. Set it explicitly. |
| WhatsApp | Not in the demo. Without `WHATSAPP_TOKEN`, sends go to `dev_outbox` (`apps/shield-api/README.md:24`). Family-check answers need WhatsApp (B6). Core 1 is push-only. |
| Sarvam | Needs Antara's agent config: `SARVAM_AGENT_ID_{CHECKIN,RESPONDER,CALLBACK,EXPERIENCE}`, `SARVAM_AGENT_VERSION`, `SARVAM_CONNECTION_ID`, `SARVAM_AGENT_PHONE_NUMBER`, `SARVAM_WEBHOOK_URL`, `SARVAM_OUTBOUND_ENABLED=1`, empty variable defaults, and tool URLs from the tunnel sheet (`docs/sarvam-setup.md:127,139,186-203`). Inbound has no family context (B5). |
| Tunnel URL | Changes on every `tunnel.sh` restart (`tunnel.sh:231`). Then re-pair Maa (no Settings field), re-sign-in Riya, and update the Sarvam tool URLs. |
| Timer scale 60 | The 3-min urgent offer becomes 3 s, and family check 60/120 s becomes 1/2 s. The proof challenge becomes about 1 s (C6). The stale-heartbeat window **grows** to 3 h (`core2-device/service.ts:76`). Real firing is bounded by the 30 s cron. |
| Push gaps | The missed-call, refill and core2 push kinds have no sender yet (`child/lib/push-routes.ts:14-16`). |
| No Sharma uncle phone | The urgent chain rank 2 (Sharma) will time out. Maa's demo `/madad` screen still says "Sharma uncle is coming" in demo mode only. |
| Never | Sahaj never blocks or hangs up a call ("Phir bhi call karo" is always offered). It never asks for money, OTP or PIN, and Aasha always says she is an AI. |
