#!/usr/bin/env bash
# Throwaway local Postgres + live HTTP test runner for @sahaj/shield-api Phase 2 (AGY-07).
# Usage: bash apps/shield-api/scripts/e2e-phase2.sh
# Requires local Postgres binaries (/opt/homebrew/bin or PG_BIN) and pnpm install.
# Never uses a user/production database; creates an ephemeral /tmp/shield-p2-pg.* cluster and deletes it on exit.
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

TMP="$(mktemp -d /tmp/shield-p2-pg.XXXXXX)"
PGDATA="$TMP/data"
STARTED_PG=0
APP_PID=""

cleanup() {
  local rc=$?
  if [[ -n "$APP_PID" ]]; then
    kill "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
  fi
  if [[ $STARTED_PG -eq 1 ]]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true
  fi
  if [[ $rc -ne 0 && -f "$TMP/next.log" ]]; then
    echo "--- next.log ---" >&2
    cat "$TMP/next.log" >&2 || true
  fi
  [[ -n "$TMP" && -d "$TMP" && "$TMP" == /tmp/shield-p2-pg.* ]] && rm -rf "$TMP"
  if [[ $rc -eq 0 ]]; then
    echo "PHASE2_E2E_RESULT: PASS"
  else
    echo "PHASE2_E2E_RESULT: FAIL (exit $rc)" >&2
  fi
  exit $rc
}
trap cleanup EXIT

read -r PG_PORT APP_PORT < <(node -e '
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
Promise.all([freePort(), freePort()]).then(([a, b]) => {
  if (a === b) process.exit(2);
  console.log(a, b);
});
')

echo "== initdb throwaway cluster in $TMP (pg port $PG_PORT, app port $APP_PORT)"
"$PG_BIN/initdb" -D "$PGDATA" -U postgres -A trust --no-locale -E UTF8 >"$TMP/initdb.log" 2>&1 \
  || { cat "$TMP/initdb.log" >&2; exit 2; }
"$PG_BIN/pg_ctl" -D "$PGDATA" -l "$TMP/pg.log" -w \
  -o "-p $PG_PORT -k $TMP -c listen_addresses=127.0.0.1" start >/dev/null \
  || { cat "$TMP/pg.log" >&2; exit 2; }
STARTED_PG=1

PSQL=("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PG_PORT" -U postgres)
DB=shield_phase2_e2e
"${PSQL[@]}" -d postgres -c "create database $DB"

echo "== applying platform bootstrap, foundation and Shield migrations, and seed_demo"
"${PSQL[@]}" -d "$DB" -f "$REPO_ROOT/infra/supabase/test/bootstrap.sql"
for m in "$REPO_ROOT"/infra/supabase/migrations/*.sql; do
  echo "   applying $(basename "$m")"
  "${PSQL[@]}" -d "$DB" --single-transaction -f "$m"
done
"${PSQL[@]}" -d "$DB" -f "$REPO_ROOT/infra/supabase/dev/seed_demo.sql"

echo "== seeding synthetic Family 2 + verdicts for feedback / confirmation / race tests"
FAMILY_1="11111111-1111-4111-8111-111111111111"
PARENT_1="22222222-2222-4222-8222-222222222221"
FAMILY_2="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PARENT_2="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
EVENT_F1_FRAUD="e1111111-1111-4111-8111-111111111111"
EVENT_F2_FRAUD="e2222222-2222-4222-8222-222222222222"
EVENT_F1_SAFE="e3333333-3333-4333-8333-333333333333"
EVENT_F1_RACE="e4444444-4444-4444-8444-444444444444"
VERDICT_F1_FRAUD="55555555-5555-4555-8555-555555555551"
VERDICT_F2_FRAUD="55555555-5555-4555-8555-555555555552"
VERDICT_F1_SAFE="55555555-5555-4555-8555-555555555553"
VERDICT_F1_RACE="55555555-5555-4555-8555-555555555554"

"${PSQL[@]}" -d "$DB" <<SQL
insert into public.families (id, name)
values (
  '$FAMILY_2',
  'Kavita Verma Family'
);

insert into public.people (id, family_id, display_name, aliases, role)
values (
  '$PARENT_2',
  '$FAMILY_2',
  'Kavita',
  array['Kavita', 'Maa'],
  'parent'
);

insert into public.shield_events (
  id, family_id, parent_id, channel, kind, masked_text, sender_type, link_domains, matched_rules, local_level, occurred_at, idempotency_key
) values
  ('$EVENT_F1_FRAUD', '$FAMILY_1', '$PARENT_1', 'device', 'sms',
   'Your SBI KYC is blocked share OTP urgently via <URL:kyc-fake-demo.example>',
   'mobile_10', array['kyc-fake-demo.example'], array['kyc_scam'], 'red', now() - interval '2 hours', 'e2e-p2-ev-f1-fraud'),
  ('$EVENT_F2_FRAUD', '$FAMILY_2', '$PARENT_2', 'device', 'sms',
   'Bank account suspended today verify at <URL:kyc-fake-demo.example>',
   'mobile_10', array['kyc-fake-demo.example'], array['kyc_scam'], 'red', now() - interval '1 hour', 'e2e-p2-ev-f2-fraud'),
  ('$EVENT_F1_SAFE', '$FAMILY_1', '$PARENT_1', 'device', 'sms',
   'Your electricity bill payment receipt confirmed <URL:bescom-legit.example>',
   'business_header', array['bescom-legit.example'], array[]::text[], 'yellow', now() - interval '50 minutes', 'e2e-p2-ev-f1-safe'),
  ('$EVENT_F1_RACE', '$FAMILY_1', '$PARENT_1', 'device', 'sms',
   'Courier parcel address pending pay fee at <URL:parcel-race-demo.example>',
   'mobile_10', array['parcel-race-demo.example'], array['parcel_scam'], 'red', now() - interval '40 minutes', 'e2e-p2-ev-f1-race');

insert into public.shield_verdicts (
  id, family_id, parent_id, event_ids, level, scam_type, reasons, checks_fired, ai_used, models_agreed, confidence, actions
) values
  ('$VERDICT_F1_FRAUD', '$FAMILY_1', '$PARENT_1', array['$EVENT_F1_FRAUD']::uuid[], 'red', 'kyc_block',
   '[{"rule_id":"kyc_scam","hi":"KYC scam","en":"Fake KYC link"}]'::jsonb, array['kyc_scam'], false, '{}', 0.95, array['alert_child']),
  ('$VERDICT_F2_FRAUD', '$FAMILY_2', '$PARENT_2', array['$EVENT_F2_FRAUD']::uuid[], 'red', 'kyc_block',
   '[{"rule_id":"kyc_scam","hi":"KYC scam","en":"Fake KYC link"}]'::jsonb, array['kyc_scam'], false, '{}', 0.95, array['alert_child']),
  ('$VERDICT_F1_SAFE', '$FAMILY_1', '$PARENT_1', array['$EVENT_F1_SAFE']::uuid[], 'yellow', 'electricity_cut',
   '[]'::jsonb, '{}', false, '{}', 0.55, array['alert_child']),
  ('$VERDICT_F1_RACE', '$FAMILY_1', '$PARENT_1', array['$EVENT_F1_RACE']::uuid[], 'red', 'parcel_customs',
   '[{"rule_id":"parcel_scam","hi":"Parcel scam","en":"Fake parcel link"}]'::jsonb, array['parcel_scam'], false, '{}', 0.9, array['alert_child']);
SQL

if [[ ! -f "$APP_DIR/.next/BUILD_ID" ]]; then
  echo "== building @sahaj/shield-api"
  pnpm --dir "$REPO_ROOT" -F @sahaj/shield-api build >/dev/null
fi

export OPENPHISH_FEED=0 RDAP_LOOKUP=0 SARVAM_OUTBOUND_ENABLED=0 EXPO_PUSH_ENABLED=0
unset ANTHROPIC_API_KEY MUSE_API_KEY GEMINI_API_KEY SAFE_BROWSING_KEY WHATSAPP_TOKEN SARVAM_API_KEY EXPO_ACCESS_TOKEN
export DATABASE_URL="postgres://service_role@127.0.0.1:$PG_PORT/$DB"
export SHIELD_DEVICE_PAIRING_SECRET="e2e-pairing-secret-at-least-32-chars"
export DEV_ADMIN_TOKEN="e2e-dev-admin-token"
export CRON_SECRET="e2e-cron-secret"
export SARVAM_TOOL_TOKEN="e2e-sarvam-token"
export ALLOW_ANY_TOOL_IP="1"
export DEMO_TIMER_SCALE="120"

NEXT_BIN="$REPO_ROOT/node_modules/.bin/next"
[[ -x "$NEXT_BIN" ]] || NEXT_BIN="$APP_DIR/node_modules/.bin/next"

echo "== starting @sahaj/shield-api on http://127.0.0.1:$APP_PORT"
(cd "$APP_DIR" && exec "$NEXT_BIN" start -H 127.0.0.1 -p "$APP_PORT") >"$TMP/next.log" 2>&1 &
APP_PID=$!

for _ in $(seq 1 60); do
  if curl -sSf "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -sSf "http://127.0.0.1:$APP_PORT/api/health" >/dev/null

echo "== running HTTP + real-Postgres scenarios"
export APP_DIR
export BASE_URL="http://127.0.0.1:$APP_PORT"
export PG_HOST="127.0.0.1"
export PG_PORT
export PG_DB="$DB"
export FAMILY_1 PARENT_1 FAMILY_2 PARENT_2 VERDICT_F1_FRAUD VERDICT_F2_FRAUD VERDICT_F1_SAFE VERDICT_F1_RACE

node "$SCRIPT_DIR/e2e-phase2-verify.mjs"
