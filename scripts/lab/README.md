# Sahaj Shield Local Lab (`scripts/lab`)

Persistent local Postgres 16 + `@sahaj/shield-api` + background cron loop + no-phone scene player.

## Commands

1. **Start the lab stack (`scripts/lab/lab-up.sh`)**
   ```bash
   bash scripts/lab/lab-up.sh
   ```
   - Initializes a persistent PostgreSQL 16 cluster at `~/.sahaj-lab/pg` listening on `127.0.0.1:54329` (database `sahaj_lab`).
   - Applies `infra/supabase/test/bootstrap.sql` (local platform only), all sorted `infra/supabase/migrations/*.sql`, and the remaining `infra/supabase/dev/*.sql` files, tracking each applied file in `public.lab_applied(file, sha256)` so re-runs apply only new SQL files.
   - Loads `${LAB_ENV_FILE:-$HOME/dev/sahaj-secrets/shield.env}` if present (prints only variable **names**, never values), defaults `DATABASE_URL`, `ALLOW_ANY_TOOL_IP=1`, `DEMO_TIMER_SCALE=60`, and writes any missing required lab secrets into `~/.sahaj-lab/lab.env` (`chmod 600`).
   - Builds `apps/shield-api` if `.next/BUILD_ID` is missing, starts `next start -H 127.0.0.1 -p 3100`, waits for `/api/health`, and runs a 30 s background cron loop against `/api/cron/shield-jobs`.

2. **Play all 14 Shield scenes without a phone (`scripts/lab/scenes.mjs`)**
   ```bash
   node scripts/lab/scenes.mjs
   # or run a subset:
   node scripts/lab/scenes.mjs --only A,C
   ```
   - Mints a 12-hour Riya JWT, creates a pairing code via `/api/app/shield/pair-code`, pairs a lab device via `/api/shield/pair`, signs device events in memory (same HMAC format as `apps/shield-api/scripts/e2e-app-verify.mjs`), and prints `input -> verdict -> dev_outbox effects -> Riya's /api/app/shield/alerts`.
   - Exits non-zero if any scene's server verdict disagrees with its expected level.
   - States clearly at the top whether real AI keys (`ANTHROPIC_API_KEY`, `MUSE_API_KEY`, `GEMINI_API_KEY`) are loaded or running rules-only (`0` paid AI calls). To force rules-only explicitly: `LAB_ENV_FILE=/nonexistent bash scripts/lab/lab-up.sh` followed by `LAB_ENV_FILE=/nonexistent node scripts/lab/scenes.mjs`.

3. **Check lab status (`scripts/lab/lab-status.sh`)**
   ```bash
   bash scripts/lab/lab-status.sh
   ```
   Shows Postgres, `@sahaj/shield-api`, cron loop PIDs, applied SQL count, and live `/api/health` output.

4. **Reset the lab database (`scripts/lab/lab-reset.sh`)**
   ```bash
   bash scripts/lab/lab-reset.sh
   ```
   Drops and recreates `sahaj_lab`, re-applies all seed and migration SQL from scratch, and restarts the server/cron loop if they were running before the reset.

5. **Stop everything (`scripts/lab/lab-down.sh`)**
   ```bash
   bash scripts/lab/lab-down.sh
   ```
   Stops the cron loop, `@sahaj/shield-api`, and PostgreSQL 16 cleanly.

## Ports & Logs

- **Shield API**: `http://127.0.0.1:3100` (health: `http://127.0.0.1:3100/api/health`)
- **PostgreSQL 16**: `127.0.0.1:54329` (`postgres://service_role@127.0.0.1:54329/sahaj_lab`)
- **Logs & PIDs** (`~/.sahaj-lab/`):
  - `~/.sahaj-lab/next.log` & `next.pid`
  - `~/.sahaj-lab/cron.log` & `cron.pid`
  - `~/.sahaj-lab/pg.log` & `pg/`
  - `~/.sahaj-lab/lab.env` (`chmod 600`)

## Connecting Riya's App (`apps/child`) Web Preview

1. Ensure the lab is running (`bash scripts/lab/lab-up.sh`).
2. Mint Riya's 12-hour bearer token (loads `SUPABASE_JWT_SECRET` from `~/.sahaj-lab/lab.env`):
   ```bash
   set -a && source ~/.sahaj-lab/lab.env && set +a
   node apps/shield-api/scripts/mint-lab-token.mjs 33333333-3333-4333-8333-333333333332
   ```
   *(If `SUPABASE_JWT_SECRET` came from your `LAB_ENV_FILE`, source that file instead or alongside `~/.sahaj-lab/lab.env`.)*
3. Start the child web preview in another terminal:
   ```bash
   pnpm --dir apps/child dev
   ```
   Press `w` to open web preview (or open its localhost origin; `APP_ALLOWED_ORIGINS` is pre-configured on the lab server for `localhost` / `127.0.0.1` ports `8081`, `19006`, `3000`).
4. On the child app **Sign in** screen, paste:
   - Server URL: `http://127.0.0.1:3100`
   - Bearer token: the JWT printed by `mint-lab-token.mjs`
   - Never paste `SUPABASE_JWT_SECRET` into the app.


## Joined lab v2: all 3 cores behind one door (`lab-up2.sh`)

`@sahaj/shield-api` and `@sahaj/api` (Singhal's Core 1 / Core 2 / provider webhooks) run side by side behind one
zero-dependency path proxy (`proxy.mjs`). Everything lives in `~/.sahaj-lab2` with its own Postgres cluster
(`127.0.0.1:54339`, db `sahaj_lab2`), so the v1 lab above is never touched.

| Port | Process | Notes |
|---|---|---|
| `LAB2_PROXY_PORT` 3200 (3100 after switch-over) | door (`proxy.mjs`, door mode) | `/api/core1`, `/api/core2`, `/api/twilio`, `/api/missed-call`, `/api/sarvam/post-call`, `/api/media`, `/api/cron/tick`, `/api/health/liveness`, `/api/health/readiness`, exact `/api/whatsapp`, exact `/api/sarvam/tool/ping` → apps/api; everything else → shield-api (`/api/health` stays shield's) |
| 3201 | `@sahaj/shield-api` | `DATABASE_URL` = service_role on the lab cluster |
| 3202 | `@sahaj/api` | `SAHAJ_LAB_MODE=1`: bearer tokens verified locally with `SUPABASE_JWT_SECRET` (`apps/api/src/lib/lab-auth.ts`) |
| 3203 | supabase gateway (`proxy.mjs`, supabase mode) | `/rest/v1/*` → PostgREST; `/auth/v1`, `/storage/v1` → 501 |
| 3204 | PostgREST (`brew install postgrest`, arm64 `/opt/homebrew`) | connects as lab-only `authenticator` (`sql/lab2_platform.sql`) |
| 54339 | PostgreSQL 16 | `~/.sahaj-lab2/pg` |

```bash
bash scripts/lab/lab-reset2.sh          # fresh DB: bootstrap + lab platform + ALL migrations + demo seed + real demo phones (encrypted)
bash scripts/lab/lab-up2.sh             # Postgres, PostgREST, gateway, both servers, door, cron (shield cron-worker + /api/cron/tick)
LAB2_PROVIDERS=off bash scripts/lab/lab-up2.sh   # same, but no AI/Sarvam/Expo/Langfuse keys (no paid calls, no real dialling)
set -a; source ~/dev/sahaj-secrets/shield.env; set +a; node scripts/lab/joined-smoke.mjs   # health, lab login, Core 2, Core 1, Shield signatures
LAB_DIR=~/.sahaj-lab2 LAB_API_URL=http://127.0.0.1:3200 DATABASE_URL=postgres://service_role@127.0.0.1:54339/sahaj_lab2 node scripts/lab/scenes.mjs --only A
bash scripts/lab/lab-down2.sh           # stops everything in ~/.sahaj-lab2 (LAB2_KEEP_PG=1 keeps Postgres)
node --test scripts/lab/proxy.test.mjs  # proxy unit tests (loopback only)
```

Real phones: `load-phones.ts` reads `LAB_PHONE_*` from the secrets file at runtime and writes them only as encrypted
`provider_identities` rows (`source=sarvam`) through the Shield contact port. Maa's keypad is her enabled call target;
her smartphone is stored disabled (`LAB_MAA_PRIMARY=smartphone` + `lab-reset2.sh` flips it). Numbers are never printed.
No `WHATSAPP_*` variable reaches either server.

### Switch-over (keep the tunnel URL)

The cloudflared quick tunnel forwards to `http://127.0.0.1:3100`; it is never stopped or restarted here.

1. `bash scripts/lab/lab-reset2.sh` (v1 keeps running), optionally `bash scripts/lab/lab-up2.sh` + smoke on 3200, then `LAB2_KEEP_PG=1 bash scripts/lab/lab-down2.sh`.
2. `bash scripts/lab/lab-down.sh` stops the v1 cron loop, the v1 shield-api on 3100 and v1 Postgres. It does not touch `tunnel.pid`.
3. `LAB2_PROXY_PORT=3100 bash scripts/lab/lab-up2.sh`
4. `curl "$(cat ~/.sahaj-lab/public-url.txt)/api/health"` and `.../api/health/readiness`.
5. Rollback: `bash scripts/lab/lab-down2.sh && bash scripts/lab/lab-up.sh`.

### Riya's web app on the public URL (`LAB2_WEB_DIR`)
- Open the lab's public URL (`cat ~/.sahaj-lab/public-url.txt`, or `http://127.0.0.1:3100`) in a laptop browser; `proxy.mjs` serves `LAB2_WEB_DIR` (default `~/dev/sahaj-riya-web`) for non-`/api` `GET`/`HEAD` requests, and Riya's web app defaults its server URL to `window.location.origin` with no CORS issues.
- Rebuild Riya's static web bundle: `pnpm -C apps/child exec expo export --platform web --output-dir ~/dev/sahaj-riya-web`
