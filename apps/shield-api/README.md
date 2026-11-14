# `@sahaj/shield-api` (Stopgap Shield Test Server)

Temporary Next.js App Router API hosting **only** Shield (`createShieldRuntime(ports)`) so device pairing, signed events, voice tools, and delayed jobs can be tested end-to-end before Singhal's production `apps/api` is ready.

All routes run on the Node.js runtime (`export const runtime = "nodejs"`).

---

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | Service-role direct or session-mode Postgres URL (never a transaction-mode pooler; `withEventLock` uses session advisory locks). |
| `SHIELD_DEVICE_PAIRING_SECRET` | Yes | `>= 32` char secret used to derive per-device HMAC secrets (`packages/shared/src/shield.ts`). |
| `DEV_ADMIN_TOKEN` | Yes | Secret for `x-dev-admin-token` on `POST /api/shield/pair/code` and `GET /api/dev/outbox`. |
| `SARVAM_TOOL_TOKEN` | Yes | Bearer token (`Authorization: Bearer ...`) for `POST /api/sarvam/tool/[name]`. |
| `CRON_SECRET` | Yes | Secret for `x-cron-secret` on `GET /api/cron/shield-jobs`. |
| `ALLOW_ANY_TOOL_IP` | Local only | Set to `1` locally to bypass the Sarvam source IP allowlist (`4.213.167.70`, `35.154.84.150`). |
| `DEMO_TIMER_SCALE` | Optional | Positive number (default `1`) that divides delayed job timers (`retryCallParent`, `no_reaction_check`, `family_check.*`). |
| `ANTHROPIC_API_KEY` | Optional | Claude provider in `@sahaj/adapters` (`createDefaultRouter()`). |
| `MUSE_API_KEY` | Optional | Muse provider in `@sahaj/adapters`. |
| `GEMINI_API_KEY` | Optional | Gemini provider in `@sahaj/adapters`. |
| `SAFE_BROWSING_KEY` | Optional | Google Safe Browsing v4 API key for domain/URL reputation checks. |
| `WHATSAPP_TOKEN` | Optional | Meta WhatsApp Cloud API bearer token. If unset (or if recipient phone is a `+91XXXXXXXXXX` placeholder), messages go to `dev_outbox`. |
| `WHATSAPP_PHONE_NUMBER_ID` | Optional | Meta WhatsApp Business phone number ID paired with `WHATSAPP_TOKEN`. |
| `WHATSAPP_GRAPH_VERSION` | Optional | Meta Graph API version (defaults to `v27.0`). |
| `AASHA_DIDI_LINE_ID` | Optional | Dev telephony line id returned by `calls.getParentLine` (defaults to `dev-outbox-line`). |
| `SMS_GATEWAY_SECRET` | Optional (≥32 chars) | Shared secret (`x-sahaj-gateway-secret`) for `POST /api/sms/gateway`. |
| `CALL_GATEWAY_ENABLED` | Optional | Set to `1` to enable `POST /api/sarvam/tool/call_screen`; otherwise returns `404 {"enabled":false}`. |

---

## Run Locally

1. Apply Shield migrations + dev stub + demo seed to a fresh dev Postgres:

   ```bash
   psql "$DATABASE_URL" -f infra/supabase/dev/core_stub.sql
   psql "$DATABASE_URL" -f infra/supabase/migrations/20261114000100_shield.sql
   psql "$DATABASE_URL" -f infra/supabase/migrations/20261114000200_shield_pairing.sql
   psql "$DATABASE_URL" -f infra/supabase/migrations/20261114000300_shield_busy_warnings.sql
   psql "$DATABASE_URL" -f infra/supabase/migrations/20261114000400_shield_drills_evidence.sql
   psql "$DATABASE_URL" -f infra/supabase/migrations/20261114000500_shield_gateway.sql
   psql "$DATABASE_URL" -f infra/supabase/migrations/20261114000600_shield_dev.sql
   psql "$DATABASE_URL" -f infra/supabase/migrations/20261114000900_shield_heartbeat.sql
   psql "$DATABASE_URL" -f infra/supabase/dev/seed_demo.sql
   ```

2. Copy `.env.example` to `.env.local` inside `apps/shield-api` and fill the secrets.

3. Start the server:

   ```bash
   pnpm -F @sahaj/shield-api dev
   ```

Demo UUIDs from `infra/supabase/dev/seed_demo.sql`:
- `family_id`: `11111111-1111-4111-8111-111111111111`
- `parent_id` (Meena "Maa"): `22222222-2222-4222-8222-222222222221`
- `user_id` (Riya): `33333333-3333-4333-8333-333333333332`

---

## Scheduling `/api/cron/shield-jobs` every 30 s

### Option A: Supabase `pg_cron` + `pg_net` (every 30 seconds)

```sql
select cron.schedule(
  'shield-jobs-30s',
  '30 seconds',
  $$
  select net.http_get(
    url := 'https://<your-shield-api-host>/api/cron/shield-jobs',
    headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET>')
  );
  $$
);
```

### Option B: Vercel Cron (`vercel.json`)

Vercel Cron minimum interval is 1 minute (`* * * * *`). Note that Vercel Cron sends `Authorization: Bearer $CRON_SECRET`, whereas this stopgap endpoint expects `x-cron-secret: $CRON_SECRET` — so for 30 s cadence in testing, prefer Supabase `pg_cron` (above) or a 30 s loop in dev:

```bash
while true; do
  curl -sS -H "x-cron-secret: $CRON_SECRET" http://localhost:3000/api/cron/shield-jobs
  echo
  sleep 30
done
```

---

## Curl Examples

```bash
BASE="http://localhost:3000"
FAMILY_ID="11111111-1111-4111-8111-111111111111"
PARENT_ID="22222222-2222-4222-8222-222222222221"
USER_ID="33333333-3333-4333-8333-333333333332"
```

### 1. `GET /api/health`

```bash
curl -sS "$BASE/api/health" | jq
```

### 2. `POST /api/shield/pair/code`

```bash
CODE_JSON=$(curl -sS -X POST "$BASE/api/shield/pair/code" \
  -H "content-type: application/json" \
  -H "x-dev-admin-token: $DEV_ADMIN_TOKEN" \
  -d "{\"family_id\":\"$FAMILY_ID\",\"user_id\":\"$USER_ID\"}")
echo "$CODE_JSON"
CODE=$(echo "$CODE_JSON" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.code)")
```

### 3. `POST /api/shield/pair`

```bash
PAIR_JSON=$(curl -sS -X POST "$BASE/api/shield/pair" \
  -H "content-type: application/json" \
  -d "{\"code\":\"$CODE\",\"parent_person_id\":\"$PARENT_ID\",\"platform\":\"android\",\"label\":\"Maa Phone\",\"protections\":{\"sms\":true}}")
echo "$PAIR_JSON"
DEVICE_ID=$(echo "$PAIR_JSON" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.device_id)")
DEVICE_SECRET=$(echo "$PAIR_JSON" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.device_secret)")
```

### 4. `POST /api/shield/event` (HMAC-SHA256 signed with `SHIELD_HEADERS`)

Signing rule (`packages/shared/src/shield.ts`):
- Headers: `x-shield-device`, `x-shield-ts` (unix ms), `x-shield-sig`
- Signature: `hex(HMAC-SHA256(device_secret, "${ts}.${rawBody}"))`

```bash
TS=$(node -e "console.log(Date.now())")
EVENT_BODY=$(node -e '
  const [family_id, parent_id, device_id] = process.argv.slice(1);
  console.log(JSON.stringify({
    idempotency_key: "kyc-demo-" + Date.now(),
    family_id,
    parent_id,
    device_id,
    channel: "device",
    kind: "sms",
    occurred_at: new Date().toISOString(),
    sender_type: "mobile_10",
    masked_text: "SBI KYC expire ho raha hai, turant update karein: <URL:sbi-kyc-update.in>"
  }));
' "$FAMILY_ID" "$PARENT_ID" "$DEVICE_ID")

SIG=$(node -e '
  const crypto = require("node:crypto");
  const [secret, ts, body] = process.argv.slice(1);
  console.log(crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex"));
' "$DEVICE_SECRET" "$TS" "$EVENT_BODY")

curl -sS -X POST "$BASE/api/shield/event" \
  -H "content-type: application/json" \
  -H "x-shield-device: $DEVICE_ID" \
  -H "x-shield-ts: $TS" \
  -H "x-shield-sig: $SIG" \
  --data-binary "$EVENT_BODY" | jq
```

### 5. `POST /api/sarvam/tool/[name]`

```bash
curl -sS -X POST "$BASE/api/sarvam/tool/check_code_word" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $SARVAM_TOOL_TOKEN" \
  -d "{\"variables\":{\"family_id\":\"$FAMILY_ID\",\"parent_id\":\"$PARENT_ID\"},\"heard\":\"gulab\"}" | jq
```

### 6. `GET /api/cron/shield-jobs`

```bash
curl -sS -H "x-cron-secret: $CRON_SECRET" "$BASE/api/cron/shield-jobs" | jq
```

### 7. `GET /api/dev/outbox`

```bash
curl -sS -H "x-dev-admin-token: $DEV_ADMIN_TOKEN" "$BASE/api/dev/outbox" | jq
```

---

## Phase 2 Endpoints (Busy-Line Watch & Shared Scam Warnings)

All `/api/dev/shield/*` routes require `x-dev-admin-token: $DEV_ADMIN_TOKEN` and enforce family/parent/verdict/streak ownership before writing.

### 8. `POST /api/dev/shield/call-status`

Forward check-in call outcomes (`connected`, `no_answer`, `busy`, `failed`) into `recordCallStatus`:

```bash
curl -sS -X POST "$BASE/api/dev/shield/call-status" \
  -H "content-type: application/json" \
  -H "x-dev-admin-token: $DEV_ADMIN_TOKEN" \
  -d "{\"family_id\":\"$FAMILY_ID\",\"parent_id\":\"$PARENT_ID\",\"status\":\"busy\",\"in_checkin_window\":true}" | jq
```

### 9. `POST /api/dev/shield/busy-reply`

Record child reply to a busy-line alert (`recordBusyAlertReply`) so pending `shield.busy.circle` escalation does not fire:

```bash
curl -sS -X POST "$BASE/api/dev/shield/busy-reply" \
  -H "content-type: application/json" \
  -H "x-dev-admin-token: $DEV_ADMIN_TOKEN" \
  -d "{\"streak_id\":\"<STREAK_ID>\",\"family_id\":\"$FAMILY_ID\"}" | jq
```

### 10. `POST /api/dev/shield/feedback`

Store `safe` or `fraud` feedback on `public.shield_verdicts` under a per-verdict advisory lock and invoke `onChildFeedback`:
- Repeated identical feedback is idempotent (`200`, `repeated: true`).
- Conflicting opposite overwrite (`safe` vs `fraud`) returns `409` (`feedback_conflict`) so persisted verdict choice and `scam_indicator_sightings` never disagree.

```bash
curl -sS -X POST "$BASE/api/dev/shield/feedback" \
  -H "content-type: application/json" \
  -H "x-dev-admin-token: $DEV_ADMIN_TOKEN" \
  -d "{\"verdict_id\":\"<VERDICT_ID>\",\"feedback\":\"fraud\"}" | jq
```

### 11. `GET` / `POST /api/dev/shield/weekly-tip`

Fetch weekly bilingual scam tip (`pickWeeklyTip`) for a valid family:

```bash
curl -sS -H "x-dev-admin-token: $DEV_ADMIN_TOKEN" \
  "$BASE/api/dev/shield/weekly-tip?family_id=$FAMILY_ID" | jq
```

---

## Real vs Outbox-Simulated vs Unwired Behavior

- **Real (Postgres + `@sahaj/shield`):** Device pairing, signed events, brain verdicts, voice tools, `busy_streaks` persistence/locking, `scam_indicators` / `scam_indicator_sightings` confirmation (`CONFIRM_MIN_FAMILIES = 2`), `pickWeeklyTip`, durable `shield_jobs` locking (`FOR UPDATE SKIP LOCKED`), and SHA-256 hash-chained `dev_timeline`.
- **Simulated in `public.dev_outbox`:**
  - `alerts.sendBusyAlert` writes `channel = 'push'`, `kind = 'busy_alert'`.
  - `shield.busy.retry` cron job writes `channel = 'calls'`, `kind = 'busy_checkin_retry_requested'` (`simulated: true`, `delivery_claimed: false`) — real check-in call scheduling belongs to Singhal's check-in caller.
  - `atlas.startCircleChain` (`shield.busy.circle`) writes `channel = 'atlas'`, `kind = 'start_circle_chain'`.
  - WhatsApp without live Meta credentials (`+91XXXXXXXXXX`), push notifications, and telephony calls.
- **Unwired / External owners:** Child app UI taps for `feedback` and `busy-reply`, Singhal's live check-in caller consuming `shield.busy.retry` and speaking `pickWeeklyTip` on calls, and live Sarvam/Atlas/FCM/Meta provider credentials.

---

## Phase 2 Throwaway-Postgres HTTP Runner

Runs against an ephemeral `/tmp/shield-p2-pg.*` cluster (deleted on exit; requires `/opt/homebrew/bin` or `PG_BIN`):

```bash
pnpm -F @sahaj/shield-api test:e2e-pg
```

---

## Phase 3 Endpoints (SMS Gateway, Heartbeat, Drills & Call Screening)

### 12. `POST /api/dev/shield/gateway-parent`

Admin endpoint (`x-dev-admin-token`) hashing phone via `numberFingerprint` into `public.shield_gateway_parents` (delegates to `runtime.registerGatewayParent` when present, otherwise `src/lib/gateway_admin.ts`). Never logs or stores raw phone numbers:

```bash
curl -sS -X POST "$BASE/api/dev/shield/gateway-parent" \
  -H "content-type: application/json" \
  -H "x-dev-admin-token: $DEV_ADMIN_TOKEN" \
  -d "{\"family_id\":\"$FAMILY_ID\",\"parent_id\":\"$PARENT_ID\",\"phone\":\"+919000000001\"}" | jq
```

### 13. `POST /api/sms/gateway`

Receives forwarded SMS from the spare Android gateway phone (`x-sahaj-gateway-secret: $SMS_GATEWAY_SECRET`), masks OTPs/numbers, inserts idempotently into `shield_events`, and runs the Shield brain via `after()`:

```bash
curl -sS -X POST "$BASE/api/sms/gateway" \
  -H "content-type: application/json" \
  -H "x-sahaj-gateway-secret: $SMS_GATEWAY_SECRET" \
  -d "{\"from\":\"+919000000001\",\"body\":\"URGENT KYC update OTP 482910 https://kyc-demo.example\",\"received_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"gateway_id\":\"gw-1\"}" | jq
```

### 14. `POST /api/shield/heartbeat`

Device heartbeat signed with the same HMAC-SHA256 + timestamp skew headers (`x-shield-device`, `x-shield-ts`, `x-shield-sig`) as `/api/shield/event`:

```bash
HB_TS=$(node -e "console.log(Date.now())")
HB_BODY="{\"device_id\":\"$DEVICE_ID\",\"protections\":{\"sms\":true,\"screening\":true,\"redirection\":false,\"usage\":true,\"notifications\":true,\"overlay\":true},\"android_version\":\"15\",\"app_version\":\"1.0.0\",\"sent_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
HB_SIG=$(node -e "const c=require('node:crypto'); console.log(c.createHmac('sha256',process.argv[1]).update(process.argv[2]+'.'+process.argv[3]).digest('hex'))" "$DEVICE_SECRET" "$HB_TS" "$HB_BODY")
curl -sS -X POST "$BASE/api/shield/heartbeat" \
  -H "content-type: application/json" \
  -H "x-shield-device: $DEVICE_ID" \
  -H "x-shield-ts: $HB_TS" \
  -H "x-shield-sig: $HB_SIG" \
  --data-binary "$HB_BODY" | jq
```

### 15. Phase 3 Sarvam Tools (`drill_answer`, `experience_turn`, `call_screen`)

`/api/sarvam/tool/[name]` routes `drill_answer`, `experience_turn`, and `call_screen`. `call_screen` returns `404 {"enabled":false}` unless `CALL_GATEWAY_ENABLED=1` (`501 tool_not_registered` if enabled before `shieldTools` registration is merged in `@sahaj/shield`).

---

## Phase 3 Throwaway-Postgres HTTP Runner

Applies `core_stub.sql`, all `infra/supabase/migrations/*.sql` sorted by name, and `infra/supabase/dev/*.sql` onto an ephemeral `/tmp/shield-p3-pg.*` cluster:

```bash
pnpm -F @sahaj/shield-api test:e2e-phase3
```

---

## Scheduling `/api/cron/weekly-drills` (run once a day)

`GET /api/cron/weekly-drills` calls `planWeeklyDrills({ now })` to schedule the weekly helper drill (stored as the next check-in variables) and start eligible opt-in experience drills. Run once a day (daytime IST, outside quiet hours) with `x-cron-secret: $CRON_SECRET`; re-running within the same 7-day window is idempotent.

```sql
select cron.schedule(
  'shield-weekly-drills-daily',
  '30 4 * * *', -- run once a day (10:00 IST / 04:30 UTC, outside quiet hours)
  $$
  select net.http_get(
    url := 'https://<your-shield-api-host>/api/cron/weekly-drills',
    headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET>')
  );
  $$
);
```

```bash
curl -sS -H "x-cron-secret: $CRON_SECRET" "$BASE/api/cron/weekly-drills" | jq
```

## C-07: WhatsApp family-check replies and opt-in live checks

Set server-only `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET` (at least 32
characters). Register `<public base>/api/whatsapp/webhook` with Meta and subscribe
to messages. GET verifies the token in constant time and returns the plain-text
challenge. POST verifies `X-Hub-Signature-256` over the exact raw bytes before
parsing; the maximum body is 256 KiB. Missing/short app secret fails closed (500),
invalid signatures return 401, oversized bodies return 413. Valid signed events,
including statuses-only and unrecognized payloads, receive 200 promptly.

Text, button and interactive replies accept `CONFIRMED/haan/ha/yes/1` or
`DENIED/nahi/na/no/2`, ignoring case and surrounding whitespace. The sender's
last-ten-digit `numberFingerprint` must resolve to exactly one person with an
unmasked E.164 `people.phone`. Only their newest `asked` check created within
30 minutes is answered. Ambiguous people/phone matches and other text are ignored.
The existing `family_check_result` tool then reads `confirmed`/`denied` as usual.
No runtime answer writer is exposed, so the inbound adapter uses the same columns
and states through `auxSql`. A transaction stores a hashed message ID in
`dev_cache` for 24 hours, updates `state`/`answered_at`, and writes
`shield.family_check.answered` with the existing canonical SHA-256 timeline chain.
This prevents concurrent replays from answering another pending check. The cache
port is link-result-only and has no atomic claim, hence this transactional cache
access. No schema change or dependency installation is required.

Next's `after` lifecycle performs the bounded database work after acknowledgement.
Valid signed deliveries are acknowledged even if background storage fails; this
is not a durable inbound queue. No raw reply text, routing number or provider
error is logged or stored by this receiver. Expired `dev_cache` rows follow the
host's existing cache cleanup policy.

Scene C now sends a signed synthetic Meta `DENIED` reply, waits for that answer,
then calls `family_check_result` and expects red. It upgrades only Rohit's masked
demo phone fixture to `+919000000003` and refuses to impersonate real routing data.
The running lab and scene player must share a lab-only `WHATSAPP_APP_SECRET`.
The `_common.sh` secret list is owned by the other lane: its owner must add
`WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET` to `REQUIRED_SECRETS`, generating
at least 32 characters, then restart the lab. No other lab script is changed here.

Run these checks manually when ready to use real accounts:

```bash
node scripts/lab/live-check.mjs
node scripts/lab/live-check.mjs --send-whatsapp
```

The script reads `${LAB_ENV_FILE:-$HOME/dev/sahaj-secrets/shield.env}` with shell
env taking precedence, and prints only configured variable names and fixed check
results with timings. It imports the actual adapters through the workspace's
already installed `jiti` TypeScript loader. Claude and Muse use separate router
environments, so fallback cannot conceal a failed key. Langfuse uses the adapters'
metadata-only tracing path, flushes, and polls the public traces API with Basic
auth for a new observation carrying this run's task marker. With no model keys,
Langfuse can test genuine `not_configured` router traces without paid inference.
It also checks the OpenPhish feed, RDAP for `google.com`, the Meta v27 phone-number
endpoint, and the loopback lab's `/api/health` for `ports.router === "real"`.

WhatsApp sends are skipped without `--send-whatsapp`. With that flag, exactly one
text (`Sahaj lab test ✓`) is sent only to `LAB_PHONE_ROHIT`, with no retries or
other recipient fallback. This must be the lead's own phone. No phone numbers,
tokens or raw provider failures are printed. Missing keyed configuration is
SKIPPED; any attempted check failure makes the exit status nonzero. OpenPhish,
RDAP and lab health need no keys and are always checked. The script does not
start or reconfigure the lab. `--help` performs no checks.
