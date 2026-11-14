#!/usr/bin/env bash
# Throwaway-Postgres test for the Shield Postgres layer (card K-B3): packages/shield/src/db.
# Usage: bash infra/supabase/test/run-shield-db-test.sh
# Needs local Postgres binaries (default /opt/homebrew/bin; override with PG_BIN) and the
# workspace installed (pnpm install). No Docker. The cluster lives in a temp dir and is deleted after.
set -euo pipefail

PG_BIN="${PG_BIN:-/opt/homebrew/bin}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS=(
  "$HERE/../migrations/20261114000100_shield.sql"
  "$HERE/../migrations/20261114000200_shield_pairing.sql"
)
PKG="$(cd "$HERE/../../../packages/shield" && pwd)"
VITEST="$PKG/node_modules/.bin/vitest"
DB=shield_db_test

for bin in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$bin" ]] || { echo "missing $PG_BIN/$bin" >&2; exit 2; }
done
[[ -x "$VITEST" ]] || { echo "missing $VITEST (run pnpm install)" >&2; exit 2; }
for m in "${MIGRATIONS[@]}"; do [[ -f "$m" ]] || { echo "missing $m" >&2; exit 2; }; done

TMP="$(mktemp -d /tmp/shield-pg.XXXXXX)"
PGDATA="$TMP/data"
STARTED=0

cleanup() {
  local rc=$?
  if [[ $STARTED -eq 1 ]]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true
  fi
  [[ -n "$TMP" && -d "$TMP" && "$TMP" == *shield-pg.* ]] && rm -rf "$TMP"
  if [[ $rc -eq 0 ]]; then echo "RESULT: PASS"; else echo "RESULT: FAIL (exit $rc)" >&2; fi
  exit $rc
}
trap cleanup EXIT

# Pick a free TCP port.
PORT=""
for p in $(seq 54330 54399); do
  if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then PORT=$p; break; fi
done
[[ -n "$PORT" ]] || { echo "no free port in 54330-54399" >&2; exit 2; }

echo "== initdb in $TMP (port $PORT)"
"$PG_BIN/initdb" -D "$PGDATA" -U postgres -A trust --no-locale -E UTF8 >"$TMP/initdb.log" 2>&1 \
  || { cat "$TMP/initdb.log" >&2; exit 2; }
"$PG_BIN/pg_ctl" -D "$PGDATA" -l "$TMP/server.log" -w \
  -o "-p $PORT -k $TMP -c listen_addresses=localhost" start >/dev/null \
  || { cat "$TMP/server.log" >&2; exit 2; }
STARTED=1

PSQL=("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$TMP" -p "$PORT" -U postgres)

echo "== stub Supabase roles, auth.uid(), core tables"
"${PSQL[@]}" -d postgres -c "create database $DB"
"${PSQL[@]}" -d "$DB" <<'SQL'
create role anon nologin;
create role authenticated nologin;
-- The app connects as the service role. LOGIN only so the test can connect as it directly;
-- BYPASSRLS as on Supabase. It is not a superuser, so missing grants would fail the tests.
create role service_role login bypassrls;

create schema auth;
create function auth.uid() returns uuid language sql stable as $f$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$f$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Mirror Supabase: new public tables are granted to all API roles by default.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

-- Assumed core tables (Singhal's migration). Only the columns src/db reads; see src/db/README.md.
create table public.families (
  id             uuid primary key default gen_random_uuid(),
  code_word_hash text
);
create table public.people (
  id        uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id),
  name      text not null,
  aliases   text[] not null default '{}',
  role      text
);
create table public.family_members (
  family_id uuid references public.families(id),
  user_id   uuid,
  person_id uuid references public.people(id),
  role      text
);
SQL

echo "== apply migrations"
for m in "${MIGRATIONS[@]}"; do
  echo "   $(basename "$m")"
  "${PSQL[@]}" -d "$DB" -f "$m"
done

echo "== vitest run test/db"
cd "$PKG"
DATABASE_URL="postgres://service_role@localhost:$PORT/$DB" SHIELD_DB_TEST_REQUIRED=1 "$VITEST" run test/db
