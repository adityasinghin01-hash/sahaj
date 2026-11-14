#!/usr/bin/env bash
# Shows status of PostgreSQL 16 (54329), @sahaj/shield-api (3100), cron loop, and /api/health.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lab/_common.sh
source "$SCRIPT_DIR/_common.sh"

echo "=== Sahaj Lab Status ==="
echo "Data dir : $LAB_DIR"

if pg_is_running; then
  applied_count="$(run_psql_lab "$LAB_DB" -tA -c "select count(*) from public.lab_applied" 2>/dev/null || echo "?")"
  echo "Postgres : running on ${PG_HOST}:${PG_PORT} (db=${LAB_DB}, lab_applied=${applied_count})"
else
  echo "Postgres : stopped"
fi

if pidfile_is_running "$NEXT_PID_FILE"; then
  echo "API      : running (pid $(cat "$NEXT_PID_FILE")) at $APP_URL"
else
  echo "API      : stopped"
fi

if pidfile_is_running "$CRON_PID_FILE"; then
  echo "Cron     : running (pid $(cat "$CRON_PID_FILE"), every 30s)"
else
  echo "Cron     : stopped"
fi

if curl -sSf -m 3 "${APP_URL}/api/health" >/dev/null 2>&1; then
  health_json="$(curl -sS -m 3 "${APP_URL}/api/health")"
  echo "Health   : $health_json"
else
  echo "Health   : unreachable (${APP_URL}/api/health)"
fi

