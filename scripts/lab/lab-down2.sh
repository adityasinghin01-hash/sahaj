#!/usr/bin/env bash
# Stops the joined lab started by lab-up2.sh (same LAB2_DIR). Never touches ~/.sahaj-lab or the cloudflared tunnel.
# Postgres is stopped too unless LAB2_KEEP_PG=1.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lab2.sh"

echo "== stopping joined lab in $LAB2_DIR"
for name in cron-tick cron-shield door api shield gateway pgrst; do
  stop_pidfile "$LAB2_DIR/$name.pid" "$name"
done
if [[ "${LAB2_KEEP_PG:-0}" != "1" ]] && pg2_is_running; then
  "$(pg_bin_path pg_ctl)" -D "$PG_DATA" -m fast -w stop >/dev/null 2>&1 || true
  echo "   stopped PostgreSQL ($PG_DATA)"
fi
