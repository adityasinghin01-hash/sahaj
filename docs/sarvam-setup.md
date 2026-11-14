# Sarvam setup sheet (for Antara)

This sheet says what to paste into the Sarvam dashboard for each Sahaj agent, and what to send back to the lead.

- Replace `<PUBLIC_URL>` with the link the lead sends you (it looks like `https://something.trycloudflare.com`). The lead gets it from `bash scripts/lab/tunnel.sh`.
- Replace `<SARVAM_TOOL_TOKEN>` and `<SARVAM_WEBHOOK_SECRET>` with the values the lead sends you privately (not in chat groups, not in a doc).
- This sheet never contains real secrets or real phone numbers. Don't add any.
- All demo people are synthetic: Meena "Maa" (67), Riya, Rohit, Sharma uncle.

## 0. Rules every agent follows

These are already in the prompt files. Check that they survive your edits:

1. The agent always says it is an AI ("Sahaj ki AI sahayak"). It never speaks as a family member.
2. It never asks for money, OTP, PIN or bank details.
3. It never blocks or hangs up on Maa because of a tool. If a tool fails, it says the fixed line and transfers to `@bridge_to`.
4. Turn **Protect sensitive info: ON** in every agent.

## 1. Settings that are the same for every tool

Every Shield tool is called the same way:

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `<PUBLIC_URL>/api/sarvam/tool/<tool name>` |
| Header | `Authorization: Bearer <SARVAM_TOOL_TOKEN>` |
| Header | `Content-Type: application/json` |
| Timeout | 5 seconds (the server answers `drill_answer` within 3 s) |

**The JSON body must say whose call this is.** Add two fields to every tool body, filled from agent variables:

```json
{ "family_id": "@family_id", "parent_id": "@parent_id", "...tool fields...": "..." }
```

The server also accepts these two ids inside `variables`, `agent_variables` or `context`, and the tool fields inside `input` or `arguments`. Without both ids the Shield server answers `400 {"error":"missing_context"}`. Outbound calls now send `@family_id` / `@parent_id`; inbound calls still need verified context from the host.

Server replies you may see:

| Reply | Meaning |
|---|---|
| `200` + JSON | Normal answer. Speak the `line_hi` (or `line`, `teach_line_hi`) exactly. |
| `401 unauthorized` | Wrong token, or the call came from an IP that isn't Sarvam's. The lab allows any IP (`ALLOW_ANY_TOOL_IP=1`). |
| `400 missing_context` / `invalid_request` | `family_id`/`parent_id` missing, or a field has the wrong type. |
| `404 unknown_tool` / `parent_not_found` | Tool name misspelt, or the parent isn't in that family. |
| `404 {"enabled":false}` | `call_screen` while the call gateway is switched off (normal). |

### Tool list (fields the server reads)

| Tool | JSON fields | Returns |
|---|---|---|
| `classify_scam` | `said` (string, 1–2000 chars: what Maa heard on the suspicious call) | `scam_type`, `level`, `stop_script_id`, `line_hi`, `bridge_to` |
| `check_message` | `from_kind` (one of `unknown_number`, `bank_name`, `saved`, `not_sure`), `mentions` (list of short words like `bijli`, `bank`, `otp`, max 20), optional `number_said` (string) | `level`, `scam_type`, `line_id`, `line_hi` |
| `family_check` | `claimed_name` (string, e.g. `Rohit`), `asked_for` (string: what the caller asked for) | `check_id`, `status` (`checking` / `unknown_person`), `line_id`, `line_hi` |
| `family_check_result` | `check_id` (string from `family_check`) | `status` (`confirmed`/`denied`/`pending`/`no_answer`/`not_found`), `level`, `line_id`, `line_hi` |
| `check_code_word` | `heard` (string, max 200: the code word the caller said) | `{ok:true}` or `{ok:false, level:"red", line_hi}` |
| `money_sent` | optional `amount_said`, optional `how` (strings, max 200) | `level: "red"`, `line_id: 7`, `line_hi` (the 1930 line) |
| `drill_answer` | `drill_id` (string), `said` (string, 1–2000) | `score` (0/1/2), `teach_line_hi`, `teach` |
| `experience_turn` | `drill_id` (string), `said` (string, may be empty), `hung_up` (true/false) | `stop`, `line` (or null), `score` (0 or 2, when stopped) |
| `call_screen` | `from` (caller number from telephony), `said_who`, `said_why` (strings) | `{enabled:false}` or `{enabled:true, action:"forward"\|"end", reason, line, ...}` |

Pass Maa's words in `said` as she said them. The server masks numbers and OTPs before anything reaches an AI model or storage. Never ask Maa to repeat an OTP or number "for the tool".

## Core 1 tools

These routes are served by **`apps/api`**, alongside Core 2. Route `/api/core1/*` and `/api/core2/*` to that app when sharing one `<PUBLIC_URL>` with the Shield server. They use the same `Authorization: Bearer <SARVAM_TOOL_TOKEN>` header, JSON content type and Sarvam IP allowlist as Shield. Use a **5 second** tool timeout: the route returns its transfer fallback within **4.5 seconds**, below Sarvam's 30 second ceiling. All requests are `POST`.

Every body includes `family_id: "@family_id"` and `parent_id: "@parent_id"` (internal UUIDs from verified agent variables). Context may instead be under `variables`, `agent_variables`, or `context`; tool fields may be under `input` or `arguments`. Do not invent IDs or ask Maa to read them. The host must supply the saved internal `@call_id` (not the provider interaction ID), `@schedule_id`, medicine IDs and permission IDs as needed.

Every mutation also needs `Idempotency-Key: <stable tool invocation ID>` or body `idempotency_key`; alternatively send both `call_id: "@call_id"` and `turn_id: "@turn_id"`. Keep it unchanged on retries and use a new key for each new spoken action. `record_consent` requires a distinct `turn_id` for each question. Read-only `check_status` and `child_status` return live results on every invocation.

An incomplete or uncertain mutation transfers on retry instead of repeating its side effects. A tool deadline stops waiting; work already started may finish in the background. Do not invent a new invocation key to force the same action again.

| Tool URL | Method | Extra body fields | Agent(s) |
|---|---|---|---|
| `<PUBLIC_URL>/api/core1/sarvam/raise_urgent` | POST | `said` (masked account of what Maa said), optional `severity` (`routine`, `urgent`, `critical`; default `urgent`) | Madad, checkin, checkin_hearing, callback |
| `<PUBLIC_URL>/api/core1/sarvam/check_status` | POST | None | Madad |
| `<PUBLIC_URL>/api/core1/sarvam/leave_message` | POST | `transcript` (Maa's words, 1–2000 chars) | Madad |
| `<PUBLIC_URL>/api/core1/sarvam/child_status` | POST | Optional `subject_person_id` (saved child UUID) | Madad |
| `<PUBLIC_URL>/api/core1/sarvam/child_scam_check` | POST | `asked_for` (masked caller claim/request, 1–300 chars); always checks saved family member Riya | Madad |
| `<PUBLIC_URL>/api/core1/sarvam/record_consent` | POST | `purpose` (`call`, `record`, `share`), `answer` (JSON boolean from spoken yes/no), `call_id: "@call_id"`, `turn_id: "@turn_id"` | checkin, checkin_hearing |
| `<PUBLIC_URL>/api/core1/sarvam/reschedule` | POST | `schedule_id: "@schedule_id"`, `hours` (integer 1–168) | checkin, checkin_hearing |
| `<PUBLIC_URL>/api/core1/sarvam/mark_private` | POST | `call_id: "@call_id"` | checkin, checkin_hearing |
| `<PUBLIC_URL>/api/core1/sarvam/cancel_permission` | POST | `permission_id` (saved standing permission UUID), `confirmed: true` **only after read-back and spoken yes** | Madad |
| `<PUBLIC_URL>/api/core1/sarvam/medicine_count` | POST | `medicine_id` (matched saved medicine UUID), `count` (absolute remaining tablets, integer 0–999), optional `vendor_id` (saved approved pharmacy UUID) | checkin, checkin_hearing |
| `<PUBLIC_URL>/api/core1/sarvam/accept_incident` | POST | `call_id: "@call_id"`, `incident_id: "@incident_id"`, `assignment_id: "@assignment_id"`, `responder_person_id: "@responder_person_id"`, `raw_event_id: "@raw_event_id"` (verified normalized provider proof), `promise_minutes` (integer 1–180) | responder, **only when the host supplies verified proof** |
| `<PUBLIC_URL>/api/core1/sarvam/decline_incident` | POST | Same saved IDs/proof as accept, without `promise_minutes` | responder, **only when the host supplies verified proof** |
| `<PUBLIC_URL>/api/core1/matcher/free-time-tool` (tool name `save_free_time`) | POST | `said` (what Maa said about when she is free, e.g. `shaam 6 ke baad free hoon`) | checkin, checkin_hearing |
| `<PUBLIC_URL>/api/core2/any-phone/verify` (tool name `any_phone_verify`) | POST | `family_id: "@family_id"`, `said_name`, `said_code_word`, `status_kind` (`help` or `safe`), optional `call_ref: "@call_id"`. **No `parent_id`** (the route rejects unknown fields) and never a phone number. Speak `spoken_text`. | Madad |

The keypad truth line remains **`POST <PUBLIC_URL>/api/core2/truth-line`**, with the same bearer and `{ "family_id": "@family_id", "parent_id": "@parent_id" }`, optional `subject_person_id`. `child_status` imports that service and speaks fixed calm words from its status; it returns no location, map, contact number or address.

Speak the returned **`line_hi` exactly**. Core 1 responses are `{ "line_hi": "...", "result": { ... }, "transfer": false }`. On an internal failure or deadline, the response is `{ "line_hi": "Maaf kijiye, main aapko abhi Riya se jod rahi hoon.", "result": { "error": "unavailable" }, "transfer": true }`. Immediately use Sarvam's built-in `call_transfer` to `@bridge_to`. Authentication/validation failures also include this line and `transfer: true`, with HTTP 401/400. Never wait, disconnect, block Maa, or ask her to try again. Never pass `@bridge_to` through tool/model text.

`leave_message` sends **text labeled "AI transcript of Maa's words"**, saved to the signed timeline and pushed to Riya. In the dashboard's Madad prompt, replace the old promise of "aapki apni awaaz" with the tool's returned transcript line; this tool does not record or imitate Maa's voice. The host needs Riya's active push registration; push-disabled/unavailable delivery falls back to transfer. The text remains durably saved even if the push fails.

`medicine_count` reconciles inventory through the existing medicine domain. At/below the saved threshold, it calls the existing refill proposal service and Cedar permission gate, never a payment or automatic order. If `vendor_id` is absent, exactly one approved family pharmacy must exist; ambiguous setup transfers to Riya. Never change a dose or give medical advice.

Consent writes use the existing purposes `check_in`, `call_recording`, and `call_transcript` for `call`, `record`, and `share`. `mark_private` appends an exact-call transcript refusal, which the existing post-call ingestion gate checks, and stores an encrypted private marker. It never copies private words to the timeline. There is no `v_shareable` view in this checkout; any future summary/report writer must honor this refusal. `CALL_CONSENT_VERSION` must match ingestion, and writes need database/encryption/timeline signing configuration.

The urgent tools import the existing Core 1 `urgent_help` command; at baseline it only queues the command, so the urgent-help lane must finish its execution/persistence wiring before live use. A queued command does **not** prove that a responder has accepted. Responder Core 2 HTTP routes already exist, but no bare Sarvam spoken "haan" can serve as normalized acceptance proof. Keep the responder tools disabled until the host supplies proof for the saved call/assignment; absent or mismatched proof transfers to Riya.

### Per-agent tool table (paste exactly these; nothing else)

Each prompt file's "Tools" table lists the same set with one line on when to call it. `call_transfer` is Sarvam's built-in transfer to `@bridge_to` on every agent.

| Agent | Prompt file | Shield tools (`<PUBLIC_URL>/api/sarvam/tool/<name>`) | Core 1 / Core 2 tools (URLs in the table above) |
|---|---|---|---|
| Madad (inbound keypad helper) | `madad.md` | `classify_scam`, `check_message`, `family_check`, `family_check_result`, `check_code_word`, `money_sent` | `raise_urgent`, `check_status`, `leave_message`, `cancel_permission`, `child_status` (speaks the `/api/core2/truth-line` status), `child_scam_check`, `any_phone_verify` |
| Daily check-in | `checkin.md` (+ `drill_checkin.md` section 3) | `classify_scam`, `drill_answer` | `record_consent`, `reschedule`, `mark_private`, `medicine_count`, `save_free_time`, `raise_urgent` |
| Daily check-in, hearing mode | `checkin_hearing.md` | `classify_scam` | `record_consent`, `reschedule`, `mark_private`, `medicine_count`, `save_free_time`, `raise_urgent` |
| Responder | `responder.md` | none | `accept_incident`, `decline_incident` (only when the host supplies verified proof) |
| Callback | `callback.md` | `classify_scam`, `money_sent` | `raise_urgent` |
| Experience drill | `experience_drill.md` | `experience_turn` | none |
| Call gateway screener | `call_gateway.md` | `call_screen` | none |

## 2. Agent: daily check-in (outbound)

- **Prompt file:** `packages/shared/prompts/sarvam/checkin.md` (copy section 4 "System Prompt" into the system prompt, section 3 into the first message). For hearing mode, make a second agent from `checkin_hearing.md`.
- **Add the weekly drill segment:** paste section 3 of `packages/shared/prompts/sarvam/drill_checkin.md` into the same system prompt, after the haal-chaal part.
- **Variables the Shield server sends when it places the call** (`agent_variables`):
  - `purpose` = `checkin`
  - `introduction` = `Main Sahaj ki AI sahayak hoon.`
  - `family_id`, `parent_id` = the saved family and Maa UUIDs.
  - First message override: `Main Sahaj ki AI sahayak hoon. Main kabhi OTP, PIN, paise ya bank details nahi maangti.`
- **Variables the prompt also uses** (`@address_form`, `@greeting`, `@hearing_mode`, `@consent_done`, `@last_summary`, `@open_requests`, `@pending_voice`, `@fraud_tip`, `@bridge_to`, `@medicines_list`, `@drill_id`, `@drill_story`, `@drill_praise`, `@family_id`, `@parent_id`): give each one an empty default in the dashboard, so the agent still works when the server doesn't send it. See section 9 for which of these are not sent yet.
- **Fraud tip of the week:** `GET <PUBLIC_URL>/api/sarvam/checkin-vars?family_id=<family id>` with header `Authorization: Bearer <SARVAM_TOOL_TOKEN>`. It returns `fraud_tip_hi`, `fraud_tip_en`, `as_of`. Use `fraud_tip_hi` for `@fraud_tip`.
- **Shield tools:** `classify_scam`, `drill_answer`.
- **Shield tools (hearing mode):** `classify_scam` only. The weekly drill segment goes into the normal check-in agent.
- **Core 1 tools:** add `record_consent`, `reschedule`, `mark_private`, `raise_urgent`, `medicine_count`, `save_free_time` using the Core 1 tools URLs above, for both normal and hearing-mode agents. `call_transfer` is Sarvam's built-in transfer to `@bridge_to`.
- **Post-call webhook:** `<PUBLIC_URL>/api/sarvam/webhook/<SARVAM_WEBHOOK_SECRET>`. The server already puts this URL on every outbound call it places. If the dashboard also has a field for it, paste the same URL.
- **Send back:** the agent id → `SARVAM_AGENT_ID_CHECKIN`, and its published version number → `SARVAM_AGENT_VERSION`.

## 3. Agent: inbound keypad helper "Aasha Didi" (Madad line)

- **Prompt file:** `packages/shared/prompts/sarvam/madad.md`.
- Maa calls this number herself (speed dial 2, "1 Sahaj"). Availability 24×7, `Asia/Kolkata`.
- **Variables:** the prompt uses `@address_form`, `@greeting`, `@hearing_mode`, `@consent_done`, `@last_summary`, `@open_requests`, `@pending_voice`, `@fraud_tip`, `@bridge_to`. On an inbound call the Shield server sends nothing. These would come from an on-start hook, which is not on the Shield server (section 9). Set safe defaults: `@address_form` = `ji`, `@greeting` = `Namaste`, others empty / `false`.
- **Shield tools:** `classify_scam`, `check_message`, `family_check`, `family_check_result`, `check_code_word`, `money_sent`.
  - After `family_check` returns `status: "checking"`, wait about 20 s, then call `family_check_result` with the same `check_id`. This order is already in the prompt.
- **Core 1 tools:** add `raise_urgent`, `check_status`, `leave_message`, `cancel_permission`, `child_status`, `child_scam_check` using the Core 1 tools URLs above.
- **Core 2 tool:** add `any_phone_verify` (`<PUBLIC_URL>/api/core2/any-phone/verify`) for when the caller says she is Riya on another phone. Its body carries `family_id` but not `parent_id`.
- **Post-call webhook:** paste `<PUBLIC_URL>/api/sarvam/webhook/<SARVAM_WEBHOOK_SECRET>` if the dashboard has the field. Inbound call reports don't carry our family ids, so the server just replies `ok` and records nothing. That is expected.
- **Send back:** the inbound phone number shown on the agent (write it as `+91` followed by 10 digits) and the agent id. The lead keeps the number in the env file; don't post it anywhere else.

## 4. Agent: responder (outbound, calls a circle member)

- **Prompt file:** `packages/shared/prompts/sarvam/responder.md`.
- **Variables the Shield server sends:** `purpose` = `responder`, `introduction`, and the same first-message override as the check-in.
- **Variables the prompt also uses:** `@responder_name`, `@subject_name`, `@incident_summary`, `@address_line`, `@incident_id`, `@is_danger`, `@bridge_to`. Give them empty defaults; the Shield server doesn't send them yet (section 9).
- **Shield tools:** none. `accept_incident` / `decline_incident` URLs and their required verified-proof fields are listed under Core 1 tools. Keep them disabled until that proof binding is supplied by the host.
- **Post-call webhook:** set automatically per call by the server (same URL as above).
- **Send back:** agent id → `SARVAM_AGENT_ID_RESPONDER`.

## 5. Agent: callback (outbound, calls Maa back)

- **Prompt file:** `packages/shared/prompts/sarvam/callback.md`.
- **Variables the Shield server sends:** `purpose` = `callback`, `introduction`, `family_id`, `parent_id`, and both `line` and `callback_line`: the exact Hindi result line to say (already masked, e.g. "Ye Rohit nahi the. Paise mat bhejiye.").
  - The prompt's `@callback_line` matches the variable now sent; `@line` remains available for older prompts.
  - `@callback_reason`, `@missed_count`, `@check_id` are not sent yet (section 9). Default `@callback_reason` to `family_check_answer` while testing Shield.
- **Shield tools:** `classify_scam`, `money_sent`. **Core 1 tool:** `raise_urgent` using its URL above.
- **Post-call webhook:** set automatically per call by the server.
- **Send back:** agent id → `SARVAM_AGENT_ID_CALLBACK`.

## 6. Agent: experience drill (outbound practice scam call, opt-in)

- **Prompt file:** `packages/shared/prompts/sarvam/experience_drill.md` (section 3 = system prompt). Max call length 2 min, temperature 0.1.
- Only placed when Maa has said a recorded "haan" and Riya has switched drills on. Never more than once in 7 days, and never between 20:00 and 09:00.
- **Variables the prompt uses:** `@drill_id`, `@opening`, `@ask`, `@nudge`. `@opening` always says it is an AI voice.
- **Shield tool:** `experience_turn` (`drill_id` = `@drill_id`, `said` = Maa's words). When Maa hangs up, the host sends `hung_up: true`.
- **Consent route** (for whoever records Maa's "haan"): `POST <PUBLIC_URL>/api/sarvam/experience-consent`, header `Authorization: Bearer <SARVAM_TOOL_TOKEN>`, body `{ "family_id": "...", "parent_id": "...", "clip_ref": "<storage reference of the recording>" }`.
- **Today the server places this call with the responder agent id** and doesn't yet send `@drill_id`/`@opening`/`@ask`/`@nudge` (section 9). Build the agent, send its id back under the name `SARVAM_AGENT_ID_EXPERIENCE`, and the lead will wire it up.

## 7. Agent: call gateway screener (inbound, OFF by default)

- **Prompt file:** `packages/shared/prompts/sarvam/call_gateway.md`.
- It answers a call to Maa first, asks who is calling and why, then asks the server whether to connect.
- **Variables:** `@from` (caller number from telephony; it goes only into the tool, never spoken), `@address_form`.
- **Shield tool:** `call_screen` (`from` = `@from`, `said_who`, `said_why`).
- The server answers `{ "enabled": false }` unless the lead sets `CALL_GATEWAY_ENABLED=1`. Whenever the agent gets `enabled: false` or any error, it connects the call to Maa. It never blocks a call.
- **Send back:** the agent id (the lead stores it; there is no env name for it yet).

## 8. What to send back to the lead

Send these privately (one message, not a shared doc):

| Env name | Where you find it |
|---|---|
| `SARVAM_ORG_ID` | Organisation settings |
| `SARVAM_WORKSPACE_ID` | Workspace settings |
| `SARVAM_AGENT_ID_CHECKIN` | Check-in agent → its id |
| `SARVAM_AGENT_ID_RESPONDER` | Responder agent → its id |
| `SARVAM_AGENT_ID_CALLBACK` | Callback agent → its id |
| `SARVAM_AGENT_VERSION` | The published version number (a whole number, e.g. `1`). One number is used for all three agents, so publish them at the same version. |
| `SARVAM_CONNECTION_ID` | Telephony / phone connection used for outbound calls |
| `SARVAM_AGENT_PHONE_NUMBER` | The number outbound calls come from, as `+91` and 10 digits, no spaces |

Also useful: the inbound Madad agent id and number, the experience-drill agent id, the call-gateway agent id.

The lead then:

1. Puts them in the env file with `SARVAM_WEBHOOK_URL=<PUBLIC_URL>/api/sarvam/webhook/<SARVAM_WEBHOOK_SECRET>` and `SARVAM_OUTBOUND_ENABLED=1`.
2. Runs `node scripts/lab/sarvam-check.mjs`. This is a dry run that prints names, formats and the masked request only, and calls nobody.
3. Only when everything shows ✓, places one test call to the team's own keypad phone with `node scripts/lab/sarvam-check.mjs --call-keypad`.

## 9. Known gaps (the lead is tracking these; not your job to fix)

- The Shield server's outbound calls now send `family_id` / `parent_id`, plus `purpose`, `introduction` and (for callback) both `line` and `callback_line`. Some other prompt variables still depend on the calling workflow (`@address_form`, `@drill_id`, `@drill_story`, `@drill_praise`, responder proof/card fields, `@callback_reason`, …); do not assume defaults provide verified identity.
- There is no on-start hook route (`/api/sarvam/hook/start`) on the Shield server. The prompt files refer to one from Core 1.
- Experience drills go out through the responder agent id, without the drill variables.
- Core 1 tools are on `apps/api` at `/api/core1/sarvam/*`, not on the Shield server. Inbound verified context and responder proof still need host wiring; missing context/proof always transfers.
