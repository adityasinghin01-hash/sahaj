#!/usr/bin/env bash
# Joined lab v2: all 3 cores behind ONE door.
#
#   door (proxy.mjs)  :LAB2_PROXY_PORT (3200; 3100 for the tunnel)  -> /api/core1|core2|twilio|missed-call|... -> apps/api
#                                                                    -> everything else                        -> shield-api
#   @sahaj/shield-api :3201   DATABASE_URL = service_role on the lab Postgres
#   @sahaj/api        :3202   SAHAJ_LAB_MODE=1 (local JWT login), supabase-js -> gateway :3203 -> PostgREST :3204
#   PostgreSQL 16     :54339  own cluster in ~/.sahaj-lab2/pg, db sahaj_lab2 (created + seeded on first run)
#   cron              shield-api cron-worker.mjs (/api/cron/shield-jobs + weekly drills) and a 30 s /api/cron/tick loop,
#                     both through the door.
#
# Spare-port test:  bash scripts/lab/lab-up2.sh
# Switch-over:      LAB2_PROXY_PORT=3100 bash scripts/lab/lab-up2.sh  (after the v1 server on 3100 is stopped; the
#                   cloudflared tunnel keeps pointing at http://127.0.0.1:3100 and is never restarted by this script)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lab2.sh"

check_bins
load_lab2_env
start_pg2

if [[ -z "$(run_psql2 postgres -tA -c "select 1 from pg_database where datname = '$LAB2_DB'")" ]]; then
  echo "== database '$LAB2_DB' missing: building it with lab-reset2.sh"
  bash "$SCRIPT_DIR/lab-reset2.sh"
else
  apply_lab2_sql
fi

# Refuse to start over someone else's listener (e.g. the v1 shield-api still on 3100).
for pair in "pgrst:$LAB2_PGRST_PORT" "gateway:$LAB2_GW_PORT" "shield:$LAB2_SHIELD_PORT" "api:$LAB2_API_PORT" "door:$LAB2_PROXY_PORT"; do
  name="${pair%%:*}"; port="${pair##*:}"
  if ! pidfile_alive "$LAB2_DIR/$name.pid" && port_in_use "$port"; then
    echo "ERROR: port $port ($name) is already in use by another process." >&2
    [[ "$port" == "3100" ]] && echo "       Stop the v1 shield-api first (see scripts/lab/README.md 'Switch-over'). Do not stop the tunnel." >&2
    exit 2
  fi
done

SHIELD_DIR="$REPO_ROOT/apps/shield-api"
API_DIR="$REPO_ROOT/apps/api"
if needs_build "$SHIELD_DIR" "$SHIELD_DIR/src" "$REPO_ROOT/packages/shield/src" "$REPO_ROOT/packages/shared/src" "$REPO_ROOT/packages/adapters/src"; then
  echo "== building @sahaj/shield-api"; pnpm --dir "$REPO_ROOT" -F @sahaj/shield-api build >"$LAB2_DIR/build-shield.log" 2>&1 \
    || { tail -n 40 "$LAB2_DIR/build-shield.log" >&2; exit 1; }
fi
if needs_build "$API_DIR" "$API_DIR/src" "$REPO_ROOT/packages/adapters/src" "$REPO_ROOT/packages/atlas/src" "$REPO_ROOT/packages/gate/src" "$REPO_ROOT/packages/shared/src"; then
  echo "== building @sahaj/api"; pnpm --dir "$REPO_ROOT" -F @sahaj/api build >"$LAB2_DIR/build-api.log" 2>&1 \
    || { tail -n 40 "$LAB2_DIR/build-api.log" >&2; exit 1; }
fi
NEXT_BIN="$REPO_ROOT/node_modules/.bin/next"
[[ -x "$NEXT_BIN" ]] || { echo "ERROR: missing next binary; run pnpm install" >&2; exit 2; }
PGRST_BIN="$(command -v postgrest || echo "$PG_BIN/postgrest")"

start_once() { # <name> <cwd> <env-profile> <cmd...>
  local name="$1" cwd="$2" profile="$3"; shift 3
  if pidfile_alive "$LAB2_DIR/$name.pid"; then echo "== $name already running (pid $(cat "$LAB2_DIR/$name.pid"))"; return; fi
  echo "== starting $name"
  ( server_env "$profile"; start_bg "$name" "$cwd" "$@" )
}

start_once pgrst "$REPO_ROOT" pgrst "$PGRST_BIN"
wait_http "$PGRST_URL/" "PostgREST"
start_once gateway "$REPO_ROOT" proxy-supabase node scripts/lab/proxy.mjs
start_once shield "$SHIELD_DIR" shield "$NEXT_BIN" start -H "$LAB2_HOST" -p "$LAB2_SHIELD_PORT"
start_once api "$API_DIR" api "$NEXT_BIN" start -H "$LAB2_HOST" -p "$LAB2_API_PORT"
start_once door "$REPO_ROOT" proxy-door node scripts/lab/proxy.mjs

wait_http "$GW_URL/rest/v1/" "supabase gateway"
wait_http "$SHIELD_URL/api/health" "@sahaj/shield-api"
wait_http "$API_URL/api/health/liveness" "@sahaj/api"
wait_http "$DOOR_URL/api/health" "door"

# Cron workers get only CRON_SECRET + the door URL; both go through the door like a provider would.
start_once cron-shield "$REPO_ROOT" cron-shield node apps/shield-api/scripts/cron-worker.mjs
start_once cron-tick "$REPO_ROOT" cron-tick node scripts/lab/cron-tick.mjs

cat <<EOF

====================================================================
Sahaj joined lab (3 cores, one door) ready
====================================================================
Door (public)  : ${DOOR_URL}        <- phone apps / tunnel use only this
  shield-api   : ${SHIELD_URL}
  apps/api     : ${API_URL}   (SAHAJ_LAB_MODE=1)
  supabase gw  : ${GW_URL} -> PostgREST ${PGRST_URL}
Postgres       : ${SERVICE_DB_URL}
Logs, pids, env: ${LAB2_DIR}/ (door.log, shield.log, api.log, pgrst.log, cron-*.log, lab2.env)
Health         : ${DOOR_URL}/api/health (shield)  ${DOOR_URL}/api/health/readiness (apps/api)
Riya JWT       : set -a; source "$SECRETS_FILE"; set +a; node apps/shield-api/scripts/mint-lab-token.mjs 33333333-3333-4333-8333-333333333332
Stop           : bash scripts/lab/lab-down2.sh   (same LAB2_* env as you started with)
====================================================================
EOF
