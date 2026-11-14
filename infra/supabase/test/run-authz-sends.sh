#!/usr/bin/env bash
set -euo pipefail
PG_BIN="${PG_BIN:-/opt/homebrew/bin}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
C14_TMP="$(mktemp -d /tmp/c14-authz-pg.XXXXXX)"
C14_STARTED=0
cleanup() {
  local rc=$?
  if [[ $C14_STARTED -eq 1 ]]; then "$PG_BIN/pg_ctl" -D "$C14_TMP/data" -m fast -w stop >/dev/null 2>&1 || true; fi
  rm -rf "$C14_TMP"
  exit "$rc"
}
trap cleanup EXIT
"$PG_BIN/initdb" -D "$C14_TMP/data" -U postgres -A trust --no-locale -E UTF8 >"$C14_TMP/initdb.log" 2>&1 \
  || { cat "$C14_TMP/initdb.log"; exit 2; }
# Use a free loopback port, not a fixed/shared scratch instance.
C14_PORT="$(node -e 'const n=require("net").createServer();n.listen(0,"127.0.0.1",()=>{console.log(n.address().port);n.close()})')"
"$PG_BIN/pg_ctl" -D "$C14_TMP/data" -l "$C14_TMP/server.log" -w \
  -o "-p $C14_PORT -k $C14_TMP -c listen_addresses=127.0.0.1" start >/dev/null \
  || { cat "$C14_TMP/server.log"; exit 2; }
C14_STARTED=1
PSQL=("$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$C14_TMP" -p "$C14_PORT" -U postgres -d postgres)
"${PSQL[@]}" -f "$HERE/bootstrap.sql"
while IFS= read -r migration; do
  echo "Applying $(basename "$migration")"
  "${PSQL[@]}" --single-transaction -f "$migration"
done < <(find "$HERE/../migrations" -maxdepth 1 -type f -name '*.sql' | LC_ALL=C sort)
cd "$ROOT"
C14_TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$C14_PORT/postgres" \
  pnpm -F @sahaj/api exec vitest run tests/core1/authorized-send.pg.test.ts
