# Deploying Sahaj Shield on Render

This guide deploys `@sahaj/shield-api`, its background cron worker, and managed PostgreSQL 16 in Render's **Singapore** region using [`render.yaml`](../render.yaml).

**Do not commit secrets** to Git, and never paste secret values into tickets, PRs, or logs.

---

## 1. Architecture & Monthly Cost (Cheapest Non-Sleeping Tiers)

Per [Render's pricing](https://render.com/pricing) and [Blueprint spec](https://render.com/docs/blueprint-spec):

| Resource | Render Name | Plan | Specs / Notes | Monthly Cost |
|---|---|---|---|---|
| Workspace | — | **Hobby** | Up to 25 services, 5 GB bandwidth included | **\$0 / mo** |
| PostgreSQL 16 | `sahaj-shield-db` | `basic-256mb` | 0.1 CPU, 256 MB RAM, 1 GB SSD (+ \$0.30/GB/mo extra). Free Postgres expires after 30 days. | **\$6 / mo** |
| Web Service | `sahaj-shield-api` | `starter` | 0.5 CPU, 512 MB RAM. Required because Render's Free web tier sleeps after 15 min idle (breaking Meta/Sarvam webhooks) and `preDeployCommand` requires a paid plan. | **\$7 / mo** |
| Background Worker | `sahaj-shield-cron` | `starter` | 0.5 CPU, 512 MB RAM. Polls `/api/cron/shield-jobs` every 30 s and `/api/cron/weekly-drills` once a day over Render's private network. Workers have no free tier. | **\$7 / mo** |
| **Total baseline** | | | Prorated by the second while running | **\$20 / mo** |

---

## 2. Create the Render Blueprint

1. Create or sign in to your Render account (select the **Hobby** workspace).
2. Connect your GitHub account (`adityasinghin01-hash`).
3. In the Render dashboard, click **New** → **Blueprint**.
4. Choose the repository **`adityasinghin01-hash/sahaj`** and branch **`main`**.
5. Render reads [`render.yaml`](../render.yaml) and shows three resources to create:
   - `sahaj-shield-db` (Postgres 16)
   - `sahaj-shield-api` (Web Service)
   - `sahaj-shield-cron` (Background Worker)

---

## 3. Fill Every Secret Environment Variable

Render wires `DATABASE_URL` (from `sahaj-shield-db`) and `SHIELD_API_URL` (from `sahaj-shield-api` internal `hostport`) automatically. Every variable marked `sync: false` in [`render.yaml`](../render.yaml) must be filled in the Render Blueprint setup screen (or per-service **Environment** tab) before the first deploy finishes.

On Aditya's laptop, existing team values live in **`~/dev/sahaj-secrets/shield.env`**. Copy values directly into Render without printing or committing that file. Generate any brand-new random secret locally with:

```bash
openssl rand -hex 32
```

> **Important:** Set the **exact same** `CRON_SECRET` value on **both** `sahaj-shield-api` and `sahaj-shield-cron`.

### Core Secrets (`sahaj-shield-api` + `CRON_SECRET` on `sahaj-shield-cron`)

| Variable | Where to get it |
|---|---|
| `SHIELD_DEVICE_PAIRING_SECRET` | `~/dev/sahaj-secrets/shield.env` (or generate with `openssl rand -hex 32`) |
| `DEV_ADMIN_TOKEN` | `~/dev/sahaj-secrets/shield.env` (or generate with `openssl rand -hex 32`) |
| `SARVAM_TOOL_TOKEN` | `~/dev/sahaj-secrets/shield.env` (bearer token configured in Sarvam agent tools) |
| `CRON_SECRET` | `~/dev/sahaj-secrets/shield.env` (must match across `sahaj-shield-api` and `sahaj-shield-cron`) |

### LLM Router, Threat Intel & Observability (`sahaj-shield-api`)

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Console / `~/dev/sahaj-secrets/shield.env` |
| `MUSE_API_KEY` | Muse provider key / `~/dev/sahaj-secrets/shield.env` |
| `MUSE_BASE_URL` | Optional override for Muse OpenAI-compatible base URL (leave blank if using default) |
| `MUSE_MODEL` | Optional override for Muse model id (leave blank if using default) |
| `GEMINI_API_KEY` | Google AI Studio / `~/dev/sahaj-secrets/shield.env` |
| `SAFE_BROWSING_KEY` | Google Cloud Safe Browsing v4 API key / `~/dev/sahaj-secrets/shield.env` |
| `LANGFUSE_PUBLIC_KEY` | Langfuse project settings / `~/dev/sahaj-secrets/shield.env` |
| `LANGFUSE_SECRET_KEY` | Langfuse project settings / `~/dev/sahaj-secrets/shield.env` |
| `LANGFUSE_BASE_URL` | Langfuse host URL (e.g. `https://cloud.langfuse.com`) |

### WhatsApp Cloud API (`sahaj-shield-api`)

See [`docs/whatsapp-setup.md`](./whatsapp-setup.md) for how each field maps in Meta Developer Console:

| Variable | Where to get it |
|---|---|
| `WHATSAPP_TOKEN` | Meta App → WhatsApp → permanent System User token (or temporary token for testing) |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta App → WhatsApp → API Setup → Phone number ID |
| `WHATSAPP_GRAPH_VERSION` | Graph API version (e.g. `v27.0`) |
| `WHATSAPP_VERIFY_TOKEN` | Any random string you set in Meta Webhook verify dialog |
| `WHATSAPP_APP_SECRET` | Meta App → App settings → Basic → App secret (`X-Hub-Signature-256` validation) |

### Keypad Helpline, SMS & Call Gateway (`sahaj-shield-api`)

| Variable | Where to get it |
|---|---|
| `AASHA_DIDI_LINE_ID` | Keypad helpline line identifier / `~/dev/sahaj-secrets/shield.env` |
| `SMS_GATEWAY_SECRET` | Shared HMAC secret for SMS gateway webhook (if enabled; else `openssl rand -hex 32`) |
| `CALL_GATEWAY_ENABLED` | `"1"` to enable live `call_screen` screening, or `"0"` / blank until Call Gateway is tested |

### Sarvam Voice Agents (`sahaj-shield-api`)

See [`docs/sarvam-setup.md`](./sarvam-setup.md) section 8 for exact locations in the Sarvam dashboard:

| Variable | Where to get it |
|---|---|
| `SARVAM_WEBHOOK_SECRET` | Random secret (`openssl rand -hex 32`) placed in the post-call webhook URL path |
| `SARVAM_OUTBOUND_ENABLED` | `"1"` when ready for live outbound calls, or `"0"` to keep calls in `outbox` |
| `SARVAM_API_KEY` | Sarvam dashboard API key / `~/dev/sahaj-secrets/shield.env` |
| `SARVAM_ORG_ID` | Sarvam → Organisation settings |
| `SARVAM_WORKSPACE_ID` | Sarvam → Workspace settings |
| `SARVAM_AGENT_ID_RESPONDER` | Sarvam → Responder agent id |
| `SARVAM_AGENT_ID_CALLBACK` | Sarvam → Callback agent id |
| `SARVAM_AGENT_ID_CHECKIN` | Sarvam → Check-in agent id |
| `SARVAM_AGENT_ID_EXPERIENCE` | Sarvam → Experience drill agent id (optional; falls back to Responder if unset) |
| `SARVAM_AGENT_VERSION` | Published whole-number version (e.g. `1`) shared across the agents |
| `SARVAM_CONNECTION_ID` | Sarvam telephony connection id |
| `SARVAM_AGENT_PHONE_NUMBER` | Sarvam outbound caller number in `+91XXXXXXXXXX` format (no spaces) |
| `SARVAM_WEBHOOK_URL` | `https://<service>.onrender.com/api/sarvam/webhook/<SARVAM_WEBHOOK_SECRET>` (set once Render assigns your URL) |

### Mobile Auth, CORS & Push (`sahaj-shield-api`)

| Variable | Where to get it |
|---|---|
| `SUPABASE_JWT_SECRET` | Supabase / Auth JWT signing secret (or `~/dev/sahaj-secrets/shield.env`) |
| `APP_ALLOWED_ORIGINS` | Comma-separated allowed origins for mobile/web callers (leave blank for non-browser native callers) |
| `EXPO_PUSH_ENABLED` | `"1"` to send live Expo push notifications, `"0"` to record them in `outbox` |
| `EXPO_ACCESS_TOKEN` | Expo account access token (only needed if Expo push access security is enabled) |

### Intentionally Fixed / Omitted Variables

- `DEMO_TIMER_SCALE="60"` is pinned in `render.yaml` so 1 real minute represents 1 hour for live demo timers.
- `ALLOW_ANY_TOOL_IP` is **omitted** so production enforces the Sarvam IP allowlist on `/api/sarvam/tool/*`.
- `OPENPHISH_FEED` and `RDAP_LOOKUP` are **omitted** (unset = enabled) so live link threat intelligence stays active.

---

## 4. Deploy & Automatic Database Migration

Click **Apply** in Render.

On every deploy of `sahaj-shield-api`, Render runs `preDeployCommand`:

```bash
node apps/shield-api/scripts/migrate.mjs
```

On the first deploy against the empty `sahaj-shield-db`:
1. `public.schema_migrations` is created.
2. `public.families` does not exist yet (`to_regclass('public.families') is null`), so `infra/supabase/dev/core_stub.sql` runs inside a transaction.
3. All files in `infra/supabase/migrations/*.sql` run in ascending filename order, each inside its own transaction and recorded with its SHA-256 hash.
4. On future deploys, already-applied migrations are skipped (and any modified historical migration aborts the deploy with `exit 1`).

---

## 5. Seed the Demo Family Once

`migrate.mjs` never seeds demo rows automatically. Once the first deploy succeeds:

1. Open Render Dashboard → **`sahaj-shield-api`** → **Shell**.
2. Run:

```bash
node apps/shield-api/scripts/migrate.mjs --seed
```

This applies `infra/supabase/dev/seed_demo.sql` once and tracks it in `public.schema_migrations`.

---

## 6. Replace Placeholder Phone Numbers with Real Team Numbers

`seed_demo.sql` inserts `+91XXXXXXXXXX` placeholders. Update `public.people.phone` for your live demo devices (keep E.164 format `+91...`).

From `sahaj-shield-api` **Shell** (using `psql "$DATABASE_URL"`):

```sql
update public.people
set phone = case id
  when '22222222-2222-4222-8222-222222222221' then '+91<MAA_10_DIGITS>'
  when '22222222-2222-4222-8222-222222222222' then '+91<RIYA_10_DIGITS>'
  when '22222222-2222-4222-8222-222222222223' then '+91<ROHIT_10_DIGITS>'
  when '22222222-2222-4222-8222-222222222224' then '+91<SHARMA_10_DIGITS>'
  else phone
end
where id in (
  '22222222-2222-4222-8222-222222222221',
  '22222222-2222-4222-8222-222222222222',
  '22222222-2222-4222-8222-222222222223',
  '22222222-2222-4222-8222-222222222224'
);
```

After updating the numbers, send `"hi"` from each test phone to your WhatsApp Business number so Meta opens the 24-hour customer service window (see [`docs/whatsapp-setup.md`](./whatsapp-setup.md)).

---

## 7. Update External Webhook & Tool URLs

Note the HTTPS hostname assigned to `sahaj-shield-api`, e.g. `https://<service>.onrender.com`.

1. **Render env update (`SARVAM_WEBHOOK_URL`)**:
   In `sahaj-shield-api` → **Environment**, set:
   ```text
   SARVAM_WEBHOOK_URL=https://<service>.onrender.com/api/sarvam/webhook/<SARVAM_WEBHOOK_SECRET>
   ```
   (Let the service redeploy or save & restart.)

2. **Meta WhatsApp Webhook** ([`docs/whatsapp-setup.md`](./whatsapp-setup.md)):
   - **Callback URL:** `https://<service>.onrender.com/api/whatsapp/webhook`
   - **Verify token:** the `WHATSAPP_VERIFY_TOKEN` you set on Render
   - Verify **messages** field subscription is enabled.

3. **Sarvam Agent Tool URLs** ([`docs/sarvam-setup.md`](./sarvam-setup.md)):
   - Update every agent tool endpoint to `https://<service>.onrender.com/api/sarvam/tool/<name>` (`classify_scam`, `check_message`, `family_check`, `family_check_result`, `check_code_word`, `money_sent`, `drill_answer`, `experience_turn`, `call_screen`), keeping `Authorization: Bearer <SARVAM_TOOL_TOKEN>`.
   - Update the Check-in start variable endpoint to `https://<service>.onrender.com/api/sarvam/checkin-vars?family_id=...`.
   - Update the post-call webhook URL in Sarvam to `https://<service>.onrender.com/api/sarvam/webhook/<SARVAM_WEBHOOK_SECRET>`.

---

## 8. Smoke Tests

Run these checks from your terminal after deployment settles:

1. **Health endpoint:**

```bash
curl -fsS https://<service>.onrender.com/api/health
```

Expected: HTTP `200` with `"ok":true`, `"db":"ok"`, `"router":"real"` (and `"whatsapp":"real"` if WhatsApp creds are configured).

2. **Cron worker logs:**
   In Render Dashboard → **`sahaj-shield-cron`** → **Logs**, confirm output shows `cron /api/cron/shield-jobs status=200` every 30 seconds and `cron /api/cron/weekly-drills status=200` on startup (once per 24 h).

3. **Live provider checks (`live-check.mjs`):**

```bash
LAB_API_URL=https://<service>.onrender.com node scripts/lab/live-check.mjs
```

> **Note on `LAB_API_URL`:** [`scripts/lab/live-check.mjs`](../scripts/lab/live-check.mjs) verifies live provider credentials directly (Claude, Muse, Langfuse, OpenPhish, RDAP, and WhatsApp token; add `--send-whatsapp` to test delivery), and intentionally enforces a loopback `http://127.0.0.1|localhost` guard on its own final `Lab health` sub-check. Always rely on `curl -fsS https://<service>.onrender.com/api/health` above for checking the deployed Render host.

