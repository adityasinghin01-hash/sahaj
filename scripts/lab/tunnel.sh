#!/usr/bin/env bash
# Opens a public HTTPS link to the local lab server (http://127.0.0.1:3100) with a Cloudflare
# quick tunnel (no Cloudflare account), so Meta (WhatsApp) and Sarvam can reach it.
#
# - Reuses a running tunnel (pid in ~/.sahaj-lab/tunnel.pid) instead of starting a second one.
# - Saves the bare public URL to ~/.sahaj-lab/public-url.txt.
# - Saves the full provider URLs (WITH secrets) to ~/.sahaj-lab/public-urls.txt (chmod 600).
# - On screen, every secret is shown masked as <NAME>. Secret values are never printed.
# - Use the same LAB_ENV_FILE you gave lab-up.sh; the script probes the local server and warns
#   if the secrets in the sheet do not match the running server.
#
# Stop it with: bash scripts/lab/tunnel-down.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lab/_common.sh
source "$SCRIPT_DIR/_common.sh"

TUNNEL_PID_FILE="$LAB_DIR/tunnel.pid"
TUNNEL_LOG_FILE="$LAB_DIR/tunnel.log"
PUBLIC_URL_FILE="$LAB_DIR/public-url.txt"
PUBLIC_URLS_FILE="$LAB_DIR/public-urls.txt"
DEMO_FAMILY_ID="11111111-1111-4111-8111-111111111111"

# Every tool name /api/sarvam/tool/[name] accepts (packages/shield/src/runtime/index.ts `shieldTools`
# + apps/shield-api/src/lib/handlers.ts). call_screen answers {enabled:false} unless CALL_GATEWAY_ENABLED=1.
SARVAM_TOOLS=(
  classify_scam
  check_message
  family_check
  family_check_result
  check_code_word
  money_sent
  drill_answer
  experience_turn
  call_screen
)

ensure_lab_dirs

find_cloudflared() {
  local candidate
  for candidate in "$(command -v cloudflared 2>/dev/null || true)" /opt/homebrew/bin/cloudflared /usr/local/bin/cloudflared; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

CLOUDFLARED_BIN="$(find_cloudflared || true)"
if [[ -z "$CLOUDFLARED_BIN" ]]; then
  echo "ERROR: cloudflared not found. Install it with: /opt/homebrew/bin/brew install cloudflared" >&2
  exit 2
fi

if ! curl -sSf -m 3 "${APP_URL}/api/health" >/dev/null 2>&1; then
  echo "WARNING: ${APP_URL}/api/health is not answering. Start the lab first: bash scripts/lab/lab-up.sh" >&2
fi

parse_public_url() {
  [[ -f "$TUNNEL_LOG_FILE" ]] || return 1
  grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG_FILE" | grep -v '^https://api\.' | tail -n 1
}

PUBLIC_URL=""
if pidfile_is_running "$TUNNEL_PID_FILE" && [[ -s "$PUBLIC_URL_FILE" ]]; then
  PUBLIC_URL="$(tr -d '[:space:]' < "$PUBLIC_URL_FILE")"
  echo "== tunnel already running (pid $(tr -d '[:space:]' < "$TUNNEL_PID_FILE")), reusing it"
else
  if pidfile_is_running "$TUNNEL_PID_FILE"; then
    # Running but the URL file is missing: try to recover it from the log before restarting.
    PUBLIC_URL="$(parse_public_url || true)"
  fi
  if [[ -z "$PUBLIC_URL" ]]; then
    stop_pidfile "$TUNNEL_PID_FILE" "old cloudflared tunnel" >/dev/null
    rm -f "$PUBLIC_URL_FILE" "$PUBLIC_URLS_FILE"
    : >"$TUNNEL_LOG_FILE"
    echo "== starting Cloudflare quick tunnel -> ${APP_URL}"
    node -e '
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      const out = fs.openSync(process.argv[1], "a");
      const child = spawn(process.argv[2], ["tunnel", "--url", process.argv[3], "--no-autoupdate"], {
        detached: true,
        stdio: ["ignore", out, out],
      });
      fs.writeFileSync(process.argv[4], String(child.pid) + "\n");
      child.unref();
    ' "$TUNNEL_LOG_FILE" "$CLOUDFLARED_BIN" "$APP_URL" "$TUNNEL_PID_FILE"

    for _ in $(seq 1 60); do
      PUBLIC_URL="$(parse_public_url || true)"
      [[ -n "$PUBLIC_URL" ]] && break
      if ! pidfile_is_running "$TUNNEL_PID_FILE"; then
        break
      fi
      sleep 0.5
    done
    if [[ -z "$PUBLIC_URL" ]]; then
      echo "ERROR: no https://*.trycloudflare.com URL in $TUNNEL_LOG_FILE within 30 s" >&2
      tail -n 20 "$TUNNEL_LOG_FILE" >&2 || true
      stop_pidfile "$TUNNEL_PID_FILE" "cloudflared tunnel" >&2
      exit 1
    fi
  fi
  printf '%s\n' "$PUBLIC_URL" >"$PUBLIC_URL_FILE"
  chmod 600 "$PUBLIC_URL_FILE"
fi

# Same env precedence as the running lab server: ~/.sahaj-lab/lab.env, then LAB_ENV_FILE / shield.env.
# Values are only used to build the 0600 file below. Only names reach the screen.
load_and_prepare_env 0

missing=()
for name in SARVAM_WEBHOOK_SECRET SARVAM_TOOL_TOKEN; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done

# Writes the provider sheet. $1 = "real" (values) or "masked" (<NAME> placeholders).
write_sheet() {
  local mode="$1"
  local webhook_secret tool_token verify_token
  if [[ "$mode" == "real" ]]; then
    webhook_secret="${SARVAM_WEBHOOK_SECRET:-<SARVAM_WEBHOOK_SECRET missing>}"
    tool_token="${SARVAM_TOOL_TOKEN:-<SARVAM_TOOL_TOKEN missing>}"
    verify_token="${WHATSAPP_VERIFY_TOKEN:-<WHATSAPP_VERIFY_TOKEN not set>}"
  else
    webhook_secret="<SARVAM_WEBHOOK_SECRET>"
    tool_token="<SARVAM_TOOL_TOKEN>"
    verify_token="<WHATSAPP_VERIFY_TOKEN>"
  fi
  local tool
  cat <<EOF
# Sahaj lab public URLs ($(date -u +%Y-%m-%dT%H:%M:%SZ))
PUBLIC_URL=${PUBLIC_URL}
HEALTH=${PUBLIC_URL}/api/health

## WhatsApp (Meta app -> WhatsApp -> Configuration -> Webhook)
WHATSAPP_WEBHOOK_URL=${PUBLIC_URL}/api/whatsapp/webhook
WHATSAPP_VERIFY_TOKEN=${verify_token}

## Sarvam call-status webhook (also the value for env SARVAM_WEBHOOK_URL)
SARVAM_WEBHOOK_URL=${PUBLIC_URL}/api/sarvam/webhook/${webhook_secret}

## Sarvam tools: method POST, header  Authorization: Bearer ${tool_token}
EOF
  for tool in "${SARVAM_TOOLS[@]}"; do
    printf 'TOOL_%s=%s/api/sarvam/tool/%s\n' "$(printf '%s' "$tool" | tr '[:lower:]' '[:upper:]')" "$PUBLIC_URL" "$tool"
  done
  cat <<EOF
TOOL_AUTH_HEADER=Authorization: Bearer ${tool_token}

## Sarvam check-in variables (GET, same Bearer header) and experience-drill consent (POST, same header)
SARVAM_CHECKIN_VARS_URL=${PUBLIC_URL}/api/sarvam/checkin-vars?family_id=${DEMO_FAMILY_ID}
SARVAM_EXPERIENCE_CONSENT_URL=${PUBLIC_URL}/api/sarvam/experience-consent
EOF
}

tmp_urls="$(mktemp "$LAB_DIR/public-urls.XXXXXX")"
chmod 600 "$tmp_urls"
write_sheet real >"$tmp_urls"
mv "$tmp_urls" "$PUBLIC_URLS_FILE"
chmod 600 "$PUBLIC_URLS_FILE"

# Self-check against the LOCAL server (read-only calls; secrets go through a 0600 curl config file,
# never argv or the screen): do the secrets in this sheet match the env the server was started with?
probe() {
  # $1 = method, $2 = path (may contain a secret), $3 = optional bearer token. Prints the HTTP code.
  local cfg code
  cfg="$(mktemp "$LAB_DIR/curl.XXXXXX")"
  chmod 600 "$cfg"
  {
    printf 'url = "%s%s"\n' "$APP_URL" "$2"
    printf 'request = "%s"\n' "$1"
    printf 'header = "Content-Type: application/json"\n'
    if [[ -n "${3:-}" ]]; then printf 'header = "Authorization: Bearer %s"\n' "$3"; fi
    if [[ "$1" == "POST" ]]; then printf 'data = "{}"\n'; fi
  } >"$cfg"
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -K "$cfg" 2>/dev/null || true)"
  rm -f "$cfg"
  printf '%s\n' "${code:-000}"
}
webhook_probe="skipped"
tool_probe="skipped"
if [[ -n "${SARVAM_WEBHOOK_SECRET:-}" ]]; then
  webhook_probe="$(probe POST "/api/sarvam/webhook/${SARVAM_WEBHOOK_SECRET}")"
fi
if [[ -n "${SARVAM_TOOL_TOKEN:-}" ]]; then
  tool_probe="$(probe GET "/api/sarvam/checkin-vars?family_id=${DEMO_FAMILY_ID}" "$SARVAM_TOOL_TOKEN")"
fi

echo
echo "===================================================================="
echo "Sahaj lab public link (secrets masked on screen)"
echo "===================================================================="
write_sheet masked
echo
echo "Full values (with secrets) saved to: $PUBLIC_URLS_FILE (chmod 600)"
echo "Bare public URL saved to:            $PUBLIC_URL_FILE"
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "WARNING: not set in the lab env: ${missing[*]} (run bash scripts/lab/lab-up.sh to generate lab values)"
fi
if [[ -z "${WHATSAPP_VERIFY_TOKEN:-}" ]]; then
  echo "NOTE: WHATSAPP_VERIFY_TOKEN is not set. Pick any long random string, put it in the env file and in Meta."
fi
echo
echo "Secret match with the running lab server (local, read-only probes):"
case "$webhook_probe" in
  200) echo "  ✓ SARVAM_WEBHOOK_SECRET matches the server" ;;
  401) echo "  ✗ SARVAM_WEBHOOK_SECRET does NOT match the server (it was started with a different env file)." ;;
  000) echo "  ? webhook probe: local server not reachable" ;;
  *)   echo "  ? webhook probe: HTTP $webhook_probe" ;;
esac
case "$tool_probe" in
  401) echo "  ✗ SARVAM_TOOL_TOKEN does NOT match the server (it was started with a different env file)." ;;
  000) echo "  ? tool-token probe: local server not reachable" ;;
  skipped) echo "  ? tool-token probe skipped (SARVAM_TOOL_TOKEN not set)" ;;
  *)   echo "  ✓ SARVAM_TOOL_TOKEN accepted by the server (HTTP $tool_probe)" ;;
esac
if [[ "$webhook_probe" == "401" || "$tool_probe" == "401" ]]; then
  echo "  Fix: run tunnel.sh with the same LAB_ENV_FILE you gave lab-up.sh (e.g. LAB_ENV_FILE=/nonexistent bash scripts/lab/tunnel.sh)."
fi
cat <<EOF

Reminders:
- Sarvam calls tools from its own IPs. The server allows only Sarvam's IPs unless
  ALLOW_ANY_TOOL_IP=1; lab-up already sets ALLOW_ANY_TOOL_IP=1 for the lab (current: ${ALLOW_ANY_TOOL_IP:-unset}).
- Put SARVAM_WEBHOOK_URL (from $PUBLIC_URLS_FILE) into the env file, then restart the lab.
- A quick tunnel URL changes every time the tunnel restarts; re-paste it into Meta and Sarvam then.
- Stop the tunnel: bash scripts/lab/tunnel-down.sh
EOF
