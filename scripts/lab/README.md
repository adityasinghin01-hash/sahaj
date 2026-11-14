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

