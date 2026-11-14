#!/usr/bin/env bash
# C-04: full Shield suite plus drill/evidence migration and RLS checks against a throwaway Postgres, including joined runtime scenes.
# Usage: bash packages/shield/test/drills/run-postgres.sh
# Needs local Postgres binaries (default /opt/homebrew/bin; override with PG_BIN) and the
# workspace installed (pnpm install). No Docker. The cluster lives in a temp dir and is deleted after.
set -euo pipefail

PG_BIN="${PG_BIN:-/opt/homebrew/bin}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$(cd "$HERE/../../../../infra/supabase/migrations" && pwd)"
# All migrations, in file-name order (C collation, so the timestamp prefixes sort numerically).
MIGRATIONS=()
while IFS= read -r m; do MIGRATIONS+=("$m"); done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -type f | LC_ALL=C sort)
[[ ${#MIGRATIONS[@]} -gt 0 ]] || { echo "no migrations in $MIGRATIONS_DIR" >&2; exit 2; }
PKG="$(cd "$HERE/../.." && pwd)"
VITEST="$PKG/node_modules/.bin/vitest"
[[ -x "$VITEST" ]] || VITEST="$(cd "$PKG/../.." && pwd)/node_modules/.bin/vitest"   # hoisted installs
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
"${PSQL[@]}" -d "$DB" -f "$MIGRATIONS_DIR/../test/bootstrap.sql"

echo "== apply migrations"
for m in "${MIGRATIONS[@]}"; do
  echo "   $(basename "$m")"
  "${PSQL[@]}" -d "$DB" --single-transaction -f "$m"
done

echo "== vitest run (full Shield suite, Postgres enabled)"
cd "$PKG"
DATABASE_URL="postgres://service_role@localhost:$PORT/$DB" SHIELD_DB_TEST_REQUIRED=1 SHIELD_DRILLS_DB_TEST_REQUIRED=1 "$VITEST" run
