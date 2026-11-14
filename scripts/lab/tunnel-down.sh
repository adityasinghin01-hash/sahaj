#!/usr/bin/env bash
# Stops the Cloudflare quick tunnel started by scripts/lab/tunnel.sh and removes the saved URLs
# (a quick-tunnel URL is dead once the tunnel stops). Leaves the lab server running.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lab/_common.sh
source "$SCRIPT_DIR/_common.sh"

TUNNEL_PID_FILE="$LAB_DIR/tunnel.pid"

if pidfile_is_running "$TUNNEL_PID_FILE"; then
  stop_pidfile "$TUNNEL_PID_FILE" "cloudflared tunnel"
else
  rm -f "$TUNNEL_PID_FILE"
  echo "No running tunnel."
fi
rm -f "$LAB_DIR/public-url.txt" "$LAB_DIR/public-urls.txt"
echo "Removed $LAB_DIR/public-url.txt and $LAB_DIR/public-urls.txt"
