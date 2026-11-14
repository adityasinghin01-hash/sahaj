#!/usr/bin/env bash
# Drops and recreates sahaj_lab, re-applying core_stub, all sorted migrations, and dev seeds.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lab/_common.sh
source "$SCRIPT_DIR/_common.sh"

check_pg_bins
load_and_prepare_env 0

WAS_NEXT_RUNNING=0
if pidfile_is_running "$NEXT_PID_FILE"; then
  WAS_NEXT_RUNNING=1
fi

stop_pidfile "$CRON_PID_FILE" "cron loop"
stop_pidfile "$NEXT_PID_FILE" "@sahaj/shield-api"

if [[ ! -f "$PG_DATA/PG_VERSION" ]]; then
  echo "ERROR: $PG_DATA does not exist yet; run bash scripts/lab/lab-up.sh first" >&2
  exit 2
fi

if ! pg_is_running; then
  echo "== starting PostgreSQL 16 temporarily for reset"
  "$(pg_bin_path pg_ctl)" -D "$PG_DATA" -l "$PG_LOG_FILE" -w \
    -o "-p $PG_PORT -k $PG_RUN -c listen_addresses=${PG_HOST}" start >/dev/null
fi

echo "== dropping and recreating database '$LAB_DB'"
run_psql_lab postgres -c "drop database if exists $LAB_DB with (force);"
run_psql_lab postgres -c "create database $LAB_DB;"

apply_lab_sql

if [[ $WAS_NEXT_RUNNING -eq 1 ]]; then
  echo "== restarting @sahaj/shield-api and cron loop"
  exec bash "$SCRIPT_DIR/lab-up.sh"
fi

echo "== sahaj_lab reset complete. Run 'bash scripts/lab/lab-up.sh' when ready to start the server."

