#!/usr/bin/env bash
# C-06: disposable Postgres + production Next HTTP server. Never touches an existing database.
set -euo pipefail
PG_BIN="${PG_BIN:-/opt/homebrew/bin}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
for bin in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$bin" ]] || { echo "missing $PG_BIN/$bin" >&2; exit 2; }
done
TASK_TMP="$(mktemp -d /tmp/shield-app-pg.XXXXXX)"
PGDATA="$TASK_TMP/data"
STARTED_PG=0
APP_PID=""
VERIFIED=0
cleanup() {
  local rc=$?
  trap - EXIT
  if [[ -n "$APP_PID" ]]; then kill "$APP_PID" >/dev/null 2>&1 || true; wait "$APP_PID" >/dev/null 2>&1 || true; fi
  if [[ $STARTED_PG -eq 1 ]]; then "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true; fi
  if [[ $rc -ne 0 && -f "$TASK_TMP/next.log" ]]; then cat "$TASK_TMP/next.log" >&2; fi
  [[ -d "$TASK_TMP" && "$TASK_TMP" == /tmp/shield-app-pg.* ]] && rm -rf "$TASK_TMP"
  if [[ $rc -eq 0 && $VERIFIED -ne 1 ]]; then rc=3; echo 'verify step never completed' >&2; fi
  if [[ $rc -eq 0 ]]; then echo 'APP_E2E_RESULT: PASS'; else echo "APP_E2E_RESULT: FAIL (exit $rc)" >&2; fi
  exit "$rc"
}
trap cleanup EXIT
# initdb runs before allocating TCP ports so a sandbox failure names its actual boundary.
"$PG_BIN/initdb" -D "$PGDATA" -U postgres -A trust --no-locale -E UTF8 >"$TASK_TMP/initdb.log" 2>&1 \
  || { cat "$TASK_TMP/initdb.log" >&2; exit 2; }
# bash 3.2 (macOS /bin/bash) cannot parse a heredoc inside <( ), so the port picker is inline.
read -r PG_PORT APP_PORT < <(node -e '
const net = require("node:net");
const free = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
(async () => { const a = await free(); let b = await free(); while (a === b) b = await free(); console.log(a, b); })();
')
[[ -n "${PG_PORT:-}" && -n "${APP_PORT:-}" ]] || { echo "could not allocate ports" >&2; exit 2; }
"$PG_BIN/pg_ctl" -D "$PGDATA" -l "$TASK_TMP/pg.log" -w -o "-p $PG_PORT -k $TASK_TMP -c listen_addresses=127.0.0.1" start >/dev/null \
  || { cat "$TASK_TMP/pg.log" >&2; exit 2; }
STARTED_PG=1
PSQL=("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PG_PORT" -U postgres)
DB=shield_app_e2e
"${PSQL[@]}" -d postgres -c "create database $DB"
"${PSQL[@]}" -d "$DB" -f "$REPO_ROOT/infra/supabase/dev/core_stub.sql"
while IFS= read -r migration; do
  echo "Applying $(basename "$migration")"
  "${PSQL[@]}" -d "$DB" -f "$migration"
done < <(find "$REPO_ROOT/infra/supabase/migrations" -maxdepth 1 -type f -name '*.sql' | LC_ALL=C sort)
while IFS= read -r seed; do
  [[ "$(basename "$seed")" == core_stub.sql ]] && continue
  "${PSQL[@]}" -d "$DB" -f "$seed"
done < <(find "$REPO_ROOT/infra/supabase/dev" -maxdepth 1 -type f -name '*.sql' | LC_ALL=C sort)
# Explicit synthetic telephony values; real provider env is disabled below.
"${PSQL[@]}" -d "$DB" -c "update people set phone='+919000000001' where role='parent'; update people set phone='+919000000002' where role='child';"
export OPENPHISH_FEED=0 RDAP_LOOKUP=0
export DATABASE_URL="postgres://service_role@127.0.0.1:$PG_PORT/$DB"
export SHIELD_DEVICE_PAIRING_SECRET='app-e2e-only-pairing-secret-at-least-32'
export SUPABASE_JWT_SECRET='app-e2e-only-jwt-signing-secret-at-least-32'
export EXPO_PUSH_ENABLED=0 SARVAM_OUTBOUND_ENABLED=0
unset ANTHROPIC_API_KEY MUSE_API_KEY GEMINI_API_KEY SAFE_BROWSING_KEY WHATSAPP_TOKEN WHATSAPP_PHONE_NUMBER_ID SARVAM_API_KEY EXPO_ACCESS_TOKEN
if [[ ! -f "$APP_DIR/.next/BUILD_ID" ]]; then pnpm --dir "$REPO_ROOT" -F @sahaj/shield-api build; fi
export LAB_TOKEN="$(node "$SCRIPT_DIR/mint-lab-token.mjs" 33333333-3333-4333-8333-333333333332)"
(cd "$APP_DIR" && exec node "$REPO_ROOT/node_modules/next/dist/bin/next" start -H 127.0.0.1 -p "$APP_PORT") >"$TASK_TMP/next.log" 2>&1 &
APP_PID=$!
export BASE_URL="http://127.0.0.1:$APP_PORT"
for _ in $(seq 1 80); do
  if curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then break; fi
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep .25
done
curl -fsS "$BASE_URL/api/health" >/dev/null
node "$SCRIPT_DIR/e2e-app-verify.mjs"
VERIFIED=1
