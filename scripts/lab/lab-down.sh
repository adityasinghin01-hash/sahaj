#!/usr/bin/env bash
# Stops the background cron loop, @sahaj/shield-api Next server, and lab PostgreSQL 16 cluster.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lab/_common.sh
source "$SCRIPT_DIR/_common.sh"

stop_pidfile "$CRON_PID_FILE" "cron loop"
stop_pidfile "$NEXT_PID_FILE" "@sahaj/shield-api"

if pg_is_running; then
  "$(pg_bin_path pg_ctl)" -D "$PG_DATA" -m fast -w stop >/dev/null 2>&1 || true
  echo "Stopped PostgreSQL 16 ($PG_DATA)"
else
  echo "PostgreSQL 16 already stopped"
fi

