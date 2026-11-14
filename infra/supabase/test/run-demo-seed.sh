#!/usr/bin/env bash
# AGY-S1: Full demo family seed verification gate against a disposable PostgreSQL 16 instance.
# Applies bootstrap.sql + all migrations sorted by name + seed_demo.sql + seed_demo_full.sql
# (twice, to prove idempotency) + demo_seed_check.sql.
# Usage: PG_BIN=/opt/homebrew/opt/postgresql@16/bin bash infra/supabase/test/run-demo-seed.sh
set -euo pipefail

PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
if [[ ! -x "$PG_BIN/initdb" && -x "/opt/homebrew/bin/initdb" ]]; then
  PG_BIN="/opt/homebrew/bin"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$(cd "$HERE/../migrations" && pwd)"
DEV_DIR="$(cd "$HERE/../dev" && pwd)"
TESTS_DIR="$(cd "$HERE/../tests" && pwd)"

MIGRATIONS=()
while IFS= read -r m; do MIGRATIONS+=("$m"); done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -type f | LC_ALL=C sort)
[[ ${#MIGRATIONS[@]} -gt 0 ]] || { echo "no migrations in $MIGRATIONS_DIR" >&2; exit 2; }
DB=sahaj_demo_seed_test

for bin in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$bin" ]] || { echo "missing $PG_BIN/$bin" >&2; exit 2; }
done
for m in "${MIGRATIONS[@]}"; do [[ -f "$m" ]] || { echo "missing $m" >&2; exit 2; }; done
for f in "$HERE/bootstrap.sql" "$DEV_DIR/seed_demo.sql" "$DEV_DIR/seed_demo_full.sql" "$TESTS_DIR/demo_seed_check.sql"; do
  [[ -f "$f" ]] || { echo "missing $f" >&2; exit 2; }
done

TMP="$(mktemp -d /tmp/sahaj-demo-seed-pg.XXXXXX)"
PGDATA="$TMP/data"
STARTED=0

cleanup() {
  local rc=$?
  if [[ $STARTED -eq 1 ]]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true
  fi
  [[ -n "$TMP" && -d "$TMP" && "$TMP" == *sahaj-demo-seed-pg.* ]] && rm -rf "$TMP"
  if [[ $rc -eq 0 ]]; then echo "RESULT: PASS"; else echo "RESULT: FAIL (exit $rc)" >&2; fi
  exit $rc
}
trap cleanup EXIT

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
"${PSQL[@]}" -d "$DB" -f "$HERE/bootstrap.sql"

echo "== apply migrations"
for m in "${MIGRATIONS[@]}"; do
  echo "   $(basename "$m")"
  "${PSQL[@]}" -d "$DB" --single-transaction -f "$m"
done

echo "== apply seed_demo.sql"
"${PSQL[@]}" -d "$DB" --single-transaction -f "$DEV_DIR/seed_demo.sql"

echo "== apply seed_demo_full.sql (pass 1)"
"${PSQL[@]}" -d "$DB" --single-transaction -f "$DEV_DIR/seed_demo_full.sql"

echo "== apply seed_demo_full.sql (pass 2 — idempotency check)"
"${PSQL[@]}" -d "$DB" --single-transaction -f "$DEV_DIR/seed_demo_full.sql"

echo "== run demo_seed_check.sql"
"${PSQL[@]}" -d "$DB" -f "$TESTS_DIR/demo_seed_check.sql"

