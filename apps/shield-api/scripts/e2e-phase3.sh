#!/usr/bin/env bash
# Throwaway local Postgres + live HTTP test runner for @sahaj/shield-api Phase 3 (AGY-09).
# Usage: bash apps/shield-api/scripts/e2e-phase3.sh
# Requires local Postgres binaries (/opt/homebrew/bin or PG_BIN) and pnpm install.
# Applies bootstrap.sql, ALL migrations sorted by name, and seed_demo.sql on a /tmp cluster deleted on exit.
set -euo pipefail
# Public synthetic contact fixture configuration; no real-provider dispatch.
export WEBHOOK_ENCRYPTION_KEY='1919191919191919191919191919191919191919191919191919191919191919' IDENTITY_HASH_SECRET='sahaj-synthetic-contact-hash-secret-only'
export WHATSAPP_PHONE_NUMBER_ID='synthetic-wa-account' SARVAM_APP_ID='synthetic-sarvam-app'

PG_BIN="${PG_BIN:-/opt/homebrew/bin}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

for bin in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$bin" ]] || { echo "missing $PG_BIN/$bin" >&2; exit 2; }
done

TMP="$(mktemp -d /tmp/shield-p3-pg.XXXXXX)"
PGDATA="$TMP/data"
STARTED_PG=0
APP1_PID=""
APP2_PID=""

cleanup() {
  local rc=$?
  for pid in "$APP1_PID" "$APP2_PID"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
  if [[ $STARTED_PG -eq 1 ]]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true
  fi
  if [[ $rc -ne 0 ]]; then
    for log in "$TMP/next1.log" "$TMP/next2.log"; do
      if [[ -f "$log" ]]; then
        echo "--- $(basename "$log") ---" >&2
        cat "$log" >&2 || true
      fi
    done
  fi
  [[ -n "$TMP" && -d "$TMP" && "$TMP" == /tmp/shield-p3-pg.* ]] && rm -rf "$TMP"
  if [[ $rc -eq 0 ]]; then
    echo "PHASE3_E2E_RESULT: PASS"
  else
    echo "PHASE3_E2E_RESULT: FAIL (exit $rc)" >&2
  fi
  exit $rc
}
trap cleanup EXIT

read -r PG_PORT APP1_PORT APP2_PORT < <(node -e '
const net = require("node:net");
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}
Promise.all([freePort(), freePort(), freePort()]).then(([a, b, c]) => {
  if (new Set([a, b, c]).size !== 3) process.exit(2);
  console.log(a, b, c);
});
')

echo "== initdb throwaway cluster in $TMP (pg port $PG_PORT, app1 port $APP1_PORT, app2 port $APP2_PORT)"
"$PG_BIN/initdb" -D "$PGDATA" -U postgres -A trust --no-locale -E UTF8 >"$TMP/initdb.log" 2>&1 \
  || { cat "$TMP/initdb.log" >&2; exit 2; }
"$PG_BIN/pg_ctl" -D "$PGDATA" -l "$TMP/pg.log" -w \
  -o "-p $PG_PORT -k $TMP -c listen_addresses=127.0.0.1" start >/dev/null \
  || { cat "$TMP/pg.log" >&2; exit 2; }
STARTED_PG=1

PSQL=("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PG_PORT" -U postgres)
DB=shield_phase3_e2e
"${PSQL[@]}" -d postgres -c "create database $DB"

echo "== applying bootstrap.sql, all migrations sorted by name, and dev seed SQL"
"${PSQL[@]}" -d "$DB" -f "$REPO_ROOT/infra/supabase/test/bootstrap.sql"
while IFS= read -r m; do
  echo "   applying $(basename "$m")"
  "${PSQL[@]}" -d "$DB" --single-transaction -f "$m"
done < <(find "$REPO_ROOT/infra/supabase/migrations" -maxdepth 1 -name '*.sql' | LC_ALL=C sort)

while IFS= read -r dev_sql; do
  [[ "$(basename "$dev_sql")" == "bootstrap.sql" ]] && continue
  echo "   applying dev/$(basename "$dev_sql")"
  "${PSQL[@]}" -d "$DB" -f "$dev_sql"
done < <(find "$REPO_ROOT/infra/supabase/dev" -maxdepth 1 -name '*.sql' | LC_ALL=C sort)

if [[ ! -f "$APP_DIR/.next/BUILD_ID" ]]; then
  echo "== building @sahaj/shield-api"
  pnpm --dir "$REPO_ROOT" -F @sahaj/shield-api build >/dev/null
fi

export OPENPHISH_FEED=0 RDAP_LOOKUP=0 SARVAM_OUTBOUND_ENABLED=0 EXPO_PUSH_ENABLED=0
unset ANTHROPIC_API_KEY MUSE_API_KEY GEMINI_API_KEY SAFE_BROWSING_KEY WHATSAPP_TOKEN SARVAM_API_KEY EXPO_ACCESS_TOKEN
export DATABASE_URL="postgres://service_role@127.0.0.1:$PG_PORT/$DB"
export SHIELD_DEVICE_PAIRING_SECRET="e2e-pairing-secret-at-least-32-chars"
export SMS_GATEWAY_SECRET="e2e-sms-gateway-secret-at-least-32-chars"
export DEV_ADMIN_TOKEN="e2e-dev-admin-token"
export CRON_SECRET="e2e-cron-secret"
export SARVAM_TOOL_TOKEN="e2e-sarvam-token"
export SUPABASE_JWT_SECRET="e2e-only-jwt-signing-secret-at-least-32-chars"
export ALLOW_ANY_TOOL_IP="1"
export DEMO_TIMER_SCALE="120"

NEXT_BIN="$REPO_ROOT/node_modules/.bin/next"
[[ -x "$NEXT_BIN" ]] || NEXT_BIN="$APP_DIR/node_modules/.bin/next"

echo "== starting server #1 (CALL_GATEWAY_ENABLED=0) on http://127.0.0.1:$APP1_PORT"
(cd "$APP_DIR" && CALL_GATEWAY_ENABLED=0 exec "$NEXT_BIN" start -H 127.0.0.1 -p "$APP1_PORT") >"$TMP/next1.log" 2>&1 &
APP1_PID=$!

echo "== starting server #2 (CALL_GATEWAY_ENABLED=1) on http://127.0.0.1:$APP2_PORT"
(cd "$APP_DIR" && CALL_GATEWAY_ENABLED=1 exec "$NEXT_BIN" start -H 127.0.0.1 -p "$APP2_PORT") >"$TMP/next2.log" 2>&1 &
APP2_PID=$!

for port in "$APP1_PORT" "$APP2_PORT"; do
  for _ in $(seq 1 60); do
    if curl -sSf "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  curl -sSf "http://127.0.0.1:$port/api/health" >/dev/null
done

echo "== running Phase 3 HTTP + real-Postgres scenarios"
export BASE_URL="http://127.0.0.1:$APP1_PORT"
export ENABLED_BASE_URL="http://127.0.0.1:$APP2_PORT"
export FAMILY_ID="11111111-1111-4111-8111-111111111111"
export PARENT_ID="22222222-2222-4222-8222-222222222221"
export USER_ID="33333333-3333-4333-8333-333333333332"

node "$SCRIPT_DIR/e2e-phase3-verify.mjs"

