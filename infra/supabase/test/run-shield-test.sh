#!/usr/bin/env bash
# Throwaway-Postgres test for the Shield migration + RLS (card K-A1).
# Usage: bash infra/supabase/test/run-shield-test.sh
# Needs local Postgres binaries (default /opt/homebrew/bin; override with PG_BIN). No Docker.
set -euo pipefail

PG_BIN="${PG_BIN:-/opt/homebrew/bin}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION="$HERE/../migrations/20261114000100_shield.sql"
RLS_SQL="$HERE/shield_rls.sql"

for bin in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$bin" ]] || { echo "missing $PG_BIN/$bin" >&2; exit 2; }
done

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
  -o "-p $PORT -k $TMP -c listen_addresses=localhost -c wal_level=logical" start >/dev/null \
  || { cat "$TMP/server.log" >&2; exit 2; }
STARTED=1

PSQL=("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$TMP" -p "$PORT" -U postgres)

# Supabase-like base: roles, auth.uid() stub, default grants, assumed core tables.
setup_db() {
  local db=$1 with_publication=$2
  "${PSQL[@]}" -d postgres -c "create database $db"
  "${PSQL[@]}" -d "$db" <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;

create schema auth;
create function auth.uid() returns uuid language sql stable as \$f\$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
\$f\$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Mirror Supabase: new public tables are granted to all API roles by default.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

-- Assumed core tables (Singhal's migration), minimal.
create table public.families (id uuid primary key default gen_random_uuid());
create table public.people (id uuid primary key default gen_random_uuid(), family_id uuid references public.families(id));
create table public.family_members (
  family_id uuid references public.families(id),
  user_id uuid,
  person_id uuid,
  role text
);
SQL
  if [[ $with_publication == yes ]]; then
    "${PSQL[@]}" -d "$db" -c "create publication supabase_realtime"
  fi
}

echo "== guard check: migration applies with no supabase_realtime publication"
setup_db shield_nopub no
"${PSQL[@]}" -d shield_nopub -f "$MIGRATION"
echo "   ok"

echo "== main DB: migration with supabase_realtime publication present"
setup_db shield_test yes
"${PSQL[@]}" -d shield_test -f "$MIGRATION"

echo "== RLS checks"
"${PSQL[@]}" -d shield_test -f "$RLS_SQL" 2>&1 | sed 's/^psql:[^:]*:[0-9]*: //'
# pipefail propagates a psql failure through sed.
