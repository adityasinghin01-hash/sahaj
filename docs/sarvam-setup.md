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

The server also accepts these two ids inside `variables`, `agent_variables` or `context`, and the tool fields inside `input` or `arguments`. Without both ids the server answers `400 {"error":"missing_context"}`. Read section 9: the server does not send `@family_id` / `@parent_id` yet.

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

## 2. Agent: daily check-in (outbound)

- **Prompt file:** `packages/shared/prompts/sarvam/checkin.md` (copy section 4 "System Prompt" into the system prompt, section 3 into the first message). For hearing mode, make a second agent from `checkin_hearing.md`.
- **Add the weekly drill segment:** paste section 3 of `packages/shared/prompts/sarvam/drill_checkin.md` into the same system prompt, after the haal-chaal part.
- **Variables the Shield server sends when it places the call** (`agent_variables`):
  - `purpose` = `checkin`
  - `introduction` = `Main Sahaj ki AI sahayak hoon.`
  - First message override: `Main Sahaj ki AI sahayak hoon. Main kabhi OTP, PIN, paise ya bank details nahi maangti.`
- **Variables the prompt also uses** (`@address_form`, `@greeting`, `@hearing_mode`, `@consent_done`, `@last_summary`, `@open_requests`, `@pending_voice`, `@fraud_tip`, `@bridge_to`, `@medicines_list`, `@drill_id`, `@drill_story`, `@drill_praise`, `@family_id`, `@parent_id`): give each one an empty default in the dashboard, so the agent still works when the server doesn't send it. See section 9 for which of these are not sent yet.
- **Fraud tip of the week:** `GET <PUBLIC_URL>/api/sarvam/checkin-vars?family_id=<family id>` with header `Authorization: Bearer <SARVAM_TOOL_TOKEN>`. It returns `fraud_tip_hi`, `fraud_tip_en`, `as_of`. Use `fraud_tip_hi` for `@fraud_tip`.
- **Shield tools:** `classify_scam`, `drill_answer`.
- **Core 1 tools in the prompt** (`record_consent`, `reschedule`, `mark_private`, `raise_urgent`): these are not served by the Shield server. Leave them out until the lead gives you their URLs. `call_transfer` is Sarvam's built-in transfer to `@bridge_to`.
- **Post-call webhook:** `<PUBLIC_URL>/api/sarvam/webhook/<SARVAM_WEBHOOK_SECRET>`. The server already puts this URL on every outbound call it places. If the dashboard also has a field for it, paste the same URL.
- **Send back:** the agent id → `SARVAM_AGENT_ID_CHECKIN`, and its published version number → `SARVAM_AGENT_VERSION`.

## 3. Agent: inbound keypad helper "Aasha Didi" (Madad line)

- **Prompt file:** `packages/shared/prompts/sarvam/madad.md`.
- Maa calls this number herself (speed dial 2, "1 Sahaj"). Availability 24×7, `Asia/Kolkata`.
- **Variables:** the prompt uses `@address_form`, `@greeting`, `@hearing_mode`, `@consent_done`, `@last_summary`, `@open_requests`, `@pending_voice`, `@fraud_tip`, `@bridge_to`. On an inbound call the Shield server sends nothing. These would come from an on-start hook, which is not on the Shield server (section 9). Set safe defaults: `@address_form` = `ji`, `@greeting` = `Namaste`, others empty / `false`.
- **Shield tools:** `classify_scam`, `check_message`, `family_check`, `family_check_result`, `check_code_word`, `money_sent`.
  - After `family_check` returns `status: "checking"`, wait about 20 s, then call `family_check_result` with the same `check_id`. This order is already in the prompt.
- **Core 1 tools in the prompt** (`raise_urgent`, `check_status`, `leave_message`, `cancel_permission`, `child_status`, `child_scam_check`): not on the Shield server. Leave them out until the lead gives you their URLs.
- **Post-call webhook:** paste `<PUBLIC_URL>/api/sarvam/webhook/<SARVAM_WEBHOOK_SECRET>` if the dashboard has the field. Inbound call reports don't carry our family ids, so the server just replies `ok` and records nothing. That is expected.
- **Send back:** the inbound phone number shown on the agent (write it as `+91` followed by 10 digits) and the agent id. The lead keeps the number in the env file; don't post it anywhere else.

## 4. Agent: responder (outbound, calls a circle member)

- **Prompt file:** `packages/shared/prompts/sarvam/responder.md`.
- **Variables the Shield server sends:** `purpose` = `responder`, `introduction`, and the same first-message override as the check-in.
- **Variables the prompt also uses:** `@responder_name`, `@subject_name`, `@incident_summary`, `@address_line`, `@incident_id`, `@is_danger`, `@bridge_to`. Give them empty defaults; the Shield server doesn't send them yet (section 9).
- **Shield tools:** none. Its tools `accept_incident` / `decline_incident` belong to Core 1; leave them out until the lead gives you their URLs.
- **Post-call webhook:** set automatically per call by the server (same URL as above).
- **Send back:** agent id → `SARVAM_AGENT_ID_RESPONDER`.

## 5. Agent: callback (outbound, calls Maa back)

- **Prompt file:** `packages/shared/prompts/sarvam/callback.md`.
- **Variables the Shield server sends:** `purpose` = `callback`, `introduction`, and `line`: the exact Hindi result line to say (already masked, e.g. "Ye Rohit nahi the. Paise mat bhejiye.").
  - The prompt calls this line `@callback_line`. The server sends it as **`@line`**. When you paste the prompt, change `@callback_line` to `@line`.
  - `@callback_reason`, `@missed_count`, `@check_id` are not sent yet (section 9). Default `@callback_reason` to `family_check_answer` while testing Shield.
- **Shield tools:** `classify_scam`, `money_sent`.
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

- The Shield server's outbound calls send only `purpose`, `introduction` and (for callback) `line`. They don't send `family_id` / `parent_id`, which every tool needs, nor the other prompt variables (`@address_form`, `@drill_id`, `@drill_story`, `@drill_praise`, the responder card fields, `@callback_reason`, …).
- There is no on-start hook route (`/api/sarvam/hook/start`) on the Shield server. The prompt files refer to one from Core 1.
- Experience drills go out through the responder agent id, without the drill variables.
- The Core 1 tools in the prompts are not on the Shield server.
