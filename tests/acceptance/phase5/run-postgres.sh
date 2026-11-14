#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
export PATH="/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:$PATH"

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Missing required Postgres binary: $bin" >&2
    exit 1
  fi
done

TMP_DIR="$(mktemp -d /tmp/p5h-pg.XXXXXX)"
PGDATA="$TMP_DIR/data"
PGLOG="$TMP_DIR/postgres.log"
PG_PORT="$(node -e "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>{console.log(p);});});")"

cleanup() {
  if [ -d "$PGDATA" ]; then
    pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

initdb -D "$PGDATA" -U postgres -A trust --encoding=UTF8 --locale=C >/dev/null
pg_ctl -D "$PGDATA" -l "$PGLOG" -o "-p $PG_PORT -k $TMP_DIR -c listen_addresses=127.0.0.1" start >/dev/null

export PHASE5_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:${PG_PORT}/postgres"

psql "$PHASE5_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/infra/supabase/test/bootstrap.sql" >/dev/null
while IFS= read -r mig; do
  psql "$PHASE5_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$mig" >/dev/null
done < <(LC_ALL=C find "$ROOT_DIR/infra/supabase/migrations" -maxdepth 1 -name '*.sql' | LC_ALL=C sort)

READINESS="$(psql "$PHASE5_TEST_DATABASE_URL" -tAc "SELECT public.foundation_readiness()->>'schema_ready'")"
if [ "$READINESS" != "true" ]; then
  echo "foundation_readiness schema_ready != true (got: $READINESS)" >&2
  exit 1
fi

cd "$ROOT_DIR"
./node_modules/.bin/vitest run --config tests/acceptance/phase5/vitest.config.ts
./node_modules/.bin/tsx tests/acceptance/phase5/run.ts
