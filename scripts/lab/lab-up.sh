#!/usr/bin/env bash
# Starts the persistent local Shield lab stack:
# - PostgreSQL 16 at ~/.sahaj-lab/pg on 127.0.0.1:54329 (db: sahaj_lab)
# - @sahaj/shield-api Next.js server on http://127.0.0.1:3100
# - Background cron loop hitting /api/cron/shield-jobs every 30 s
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lab/_common.sh
source "$SCRIPT_DIR/_common.sh"

check_pg_bins
load_and_prepare_env 1

INITDB_BIN="$(pg_bin_path initdb)"
PG_CTL_BIN="$(pg_bin_path pg_ctl)"

if [[ ! -f "$PG_DATA/PG_VERSION" ]]; then
  echo "== initdb persistent cluster in $PG_DATA"
  "$INITDB_BIN" -D "$PG_DATA" -U postgres -A trust --no-locale -E UTF8 >"$LAB_DIR/initdb.log" 2>&1 \
    || { cat "$LAB_DIR/initdb.log" >&2; exit 2; }
fi

if ! pg_is_running; then
  echo "== starting PostgreSQL 16 on ${PG_HOST}:${PG_PORT}"
  "$PG_CTL_BIN" -D "$PG_DATA" -l "$PG_LOG_FILE" -w \
    -o "-p $PG_PORT -k $PG_RUN -c listen_addresses=${PG_HOST}" start >/dev/null \
    || { tail -n 30 "$PG_LOG_FILE" >&2 || true; exit 2; }
else
  echo "== PostgreSQL 16 already running on ${PG_HOST}:${PG_PORT}"
fi

if [[ -z "$(run_psql_lab postgres -tA -c "select 1 from pg_database where datname = '$LAB_DB'")" ]]; then
  echo "== creating database '$LAB_DB'"
  run_psql_lab postgres -c "create database $LAB_DB"
fi

apply_lab_sql

APP_DIR="$REPO_ROOT/apps/shield-api"
BUILD_ID_FILE="$APP_DIR/.next/BUILD_ID"
NEEDS_BUILD=0
if [[ ! -f "$BUILD_ID_FILE" ]]; then
  echo "== building @sahaj/shield-api (missing .next/BUILD_ID)"
  NEEDS_BUILD=1
elif [[ -n "$(find "$APP_DIR/src" "$REPO_ROOT/packages/shield/src" "$REPO_ROOT/packages/shared/src" -type f -newer "$BUILD_ID_FILE" -print -quit 2>/dev/null)" ]]; then
  echo "== building @sahaj/shield-api (source newer than .next/BUILD_ID)"
  NEEDS_BUILD=1
fi
if [[ $NEEDS_BUILD -eq 1 ]]; then
  pnpm --dir "$REPO_ROOT" -F @sahaj/shield-api build
fi

NEXT_BIN="$REPO_ROOT/node_modules/.bin/next"
[[ -x "$NEXT_BIN" ]] || NEXT_BIN="$APP_DIR/node_modules/.bin/next"
[[ -x "$NEXT_BIN" ]] || { echo "ERROR: missing next binary; run pnpm install first" >&2; exit 2; }

if pidfile_is_running "$NEXT_PID_FILE"; then
  echo "== @sahaj/shield-api already running (pid $(cat "$NEXT_PID_FILE")) at $APP_URL"
else
  rm -f "$NEXT_PID_FILE"
  echo "== starting @sahaj/shield-api at $APP_URL"
  node -e '
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const out = fs.openSync(process.argv[1], "a");
    const child = spawn(process.argv[2], ["start", "-H", process.argv[3], "-p", process.argv[4]], {
      cwd: process.argv[5],
      detached: true,
      stdio: ["ignore", out, out],
    });
    fs.writeFileSync(process.argv[6], String(child.pid) + "\n");
    child.unref();
  ' "$NEXT_LOG_FILE" "$NEXT_BIN" "$APP_HOST" "$APP_PORT" "$APP_DIR" "$NEXT_PID_FILE"
fi

healthy=0
for _ in $(seq 1 120); do
  if curl -sSf "${APP_URL}/api/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 0.25
done
if [[ $healthy -ne 1 ]]; then
  echo "ERROR: ${APP_URL}/api/health did not become ready within 30 s" >&2
  tail -n 40 "$NEXT_LOG_FILE" >&2 || true
  exit 1
fi

if pidfile_is_running "$CRON_PID_FILE"; then
  echo "== cron loop already running (pid $(cat "$CRON_PID_FILE"))"
else
  rm -f "$CRON_PID_FILE"
  echo "== starting background 30s cron loop (/api/cron/shield-jobs)"
  node -e '
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const out = fs.openSync(process.argv[1], "a");
    const script = [
      "set -u",
      "while true; do",
      "  printf \"header = \\\"x-cron-secret: %s\\\"\\n\" \"$CRON_SECRET\" | curl -sS -m 10 -K - \"$1/api/cron/shield-jobs\" >>\"$2\" 2>&1 || true",
      "  printf \"\\n\" >>\"$2\"",
      "  sleep 30",
      "done",
    ].join("\n");
    const child = spawn("bash", ["-c", script, "cron-loop", process.argv[2], process.argv[1]], {
      detached: true,
      stdio: ["ignore", out, out],
    });
    fs.writeFileSync(process.argv[3], String(child.pid) + "\n");
    child.unref();
  ' "$CRON_LOG_FILE" "$APP_URL" "$CRON_PID_FILE"
fi

cat <<EOF

====================================================================
Sahaj Shield Local Lab Ready
====================================================================
API URL    : ${APP_URL}
Health     : ${APP_URL}/api/health
Postgres   : postgres://service_role@${PG_HOST}:${PG_PORT}/${LAB_DB}
Logs & env : ${LAB_DIR}/ (next.log, cron.log, pg.log, lab.env)

Mint Riya's 12h bearer token:
  set -a && source "${LAB_ENV_FILE_OUT}" && set +a
  node apps/shield-api/scripts/mint-lab-token.mjs 33333333-3333-4333-8333-333333333332

Child app (apps/child) web preview sign-in steps:
  1. Run the token command above and copy the printed JWT.
  2. Start the child web preview: pnpm --dir apps/child dev  (then press 'w').
  3. Open Sign in -> paste Server URL '${APP_URL}' and the bearer token.
  (Never paste SUPABASE_JWT_SECRET into the app.)

Play all Shield scenes without a phone:
  node scripts/lab/scenes.mjs
Stop the lab stack:
  bash scripts/lab/lab-down.sh
====================================================================
EOF
