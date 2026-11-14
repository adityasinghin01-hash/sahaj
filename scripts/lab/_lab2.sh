#!/usr/bin/env bash
# Shared configuration for the JOINED lab (scripts/lab/lab-up2.sh, lab-reset2.sh, lab-down2.sh).
# Everything lives in its own data dir, its own Postgres cluster/port and its own DB name, so the v1 lab
# (~/.sahaj-lab, pg 54329, shield-api on 3100) is never touched. Prints variable NAMES only, never values.
#
# Layout (defaults; override any with the env var on the left):
#   LAB2_PROXY_PORT 3200  public door (scripts/lab/proxy.mjs, door mode). Use 3100 for the switch-over.
#   LAB2_SHIELD_PORT 3201 @sahaj/shield-api (next start)
#   LAB2_API_PORT   3202  @sahaj/api (next start, SAHAJ_LAB_MODE=1)
#   LAB2_GW_PORT    3203  supabase-js gateway (proxy.mjs supabase mode: /rest/v1 -> PostgREST)
#   LAB2_PGRST_PORT 3204  PostgREST
#   LAB2_PG_PORT    54339 PostgreSQL 16 cluster in $LAB2_DIR/pg, database $LAB2_DB
#   LAB2_DIR        ~/.sahaj-lab2  (pids, logs, generated lab2.env chmod 600)
#   LAB2_PROVIDERS  on|off  off strips AI/Sarvam/Expo/Langfuse keys from both servers (no paid calls, no real dialling)

LAB2_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LAB2_COMMON_DIR/../.." && pwd)"

PG_BIN="${PG_BIN:-/opt/homebrew/bin}"
LAB2_DIR="${LAB2_DIR:-$HOME/.sahaj-lab2}"
LAB2_HOST="127.0.0.1"
LAB2_PROXY_PORT="${LAB2_PROXY_PORT:-3200}"
LAB2_SHIELD_PORT="${LAB2_SHIELD_PORT:-3201}"
LAB2_API_PORT="${LAB2_API_PORT:-3202}"
LAB2_GW_PORT="${LAB2_GW_PORT:-3203}"
LAB2_PGRST_PORT="${LAB2_PGRST_PORT:-3204}"
LAB2_PG_PORT="${LAB2_PG_PORT:-54339}"
LAB2_DB="${LAB2_DB:-sahaj_lab2}"
LAB2_PROVIDERS="${LAB2_PROVIDERS:-on}"

PG_DATA="$LAB2_DIR/pg"
PG_RUN="$LAB2_DIR/pg_run"
PG_LOG_FILE="$LAB2_DIR/pg.log"
# Lab-only TLS for the Atlas checkpoint connection (verify-full). The CA exists only in this directory and is trusted only
# by the apps/api lab process (NODE_EXTRA_CA_CERTS); nothing is added to the system keychain.
LAB2_TLS_DIR="$LAB2_DIR/tls"
LAB2_CA_CERT="$LAB2_TLS_DIR/ca.crt"
LAB2_ENV_OUT="$LAB2_DIR/lab2.env"
SECRETS_FILE="${LAB_ENV_FILE:-$HOME/dev/sahaj-secrets/shield.env}"

DOOR_URL="http://${LAB2_HOST}:${LAB2_PROXY_PORT}"
SHIELD_URL="http://${LAB2_HOST}:${LAB2_SHIELD_PORT}"
API_URL="http://${LAB2_HOST}:${LAB2_API_PORT}"
GW_URL="http://${LAB2_HOST}:${LAB2_GW_PORT}"
PGRST_URL="http://${LAB2_HOST}:${LAB2_PGRST_PORT}"
SERVICE_DB_URL="postgres://service_role@${LAB2_HOST}:${LAB2_PG_PORT}/${LAB2_DB}"
# Atlas checkpoint login: the migrations' sahaj_atlas_runtime role, given LOGIN + a generated password by the lab only.
ATLAS_DB_ROLE="sahaj_atlas_runtime"

# Secrets @sahaj/shield-api needs; generated locally when the secrets file lacks them (same list as v1 _common.sh).
SHIELD_OWN_SECRETS=(SHIELD_DEVICE_PAIRING_SECRET DEV_ADMIN_TOKEN SARVAM_TOOL_TOKEN CRON_SECRET SMS_GATEWAY_SECRET SUPABASE_JWT_SECRET SARVAM_WEBHOOK_SECRET)
# Secrets we own for the joined lab (never provider keys). Generated once into lab2.env and reused.
LAB2_OWN_SECRETS=(WEBHOOK_ENCRYPTION_KEY IDENTITY_HASH_SECRET MISSEDCALL_HOOK_SECRET SARVAM_HOOK_SECRET ATLAS_DB_PASSWORD)
# Provider/AI keys removed from both servers when LAB2_PROVIDERS=off.
PROVIDER_KEYS=(ANTHROPIC_API_KEY MUSE_API_KEY GEMINI_API_KEY SAFE_BROWSING_KEY SARVAM_API_KEY EXPO_ACCESS_TOKEN LANGFUSE_SECRET_KEY LANGFUSE_PUBLIC_KEY LANGFUSE_BASE_URL)
# Never in a server env: build-only secrets and the real demo phones (only load-phones.ts reads those).
NEVER_IN_SERVER=(EXPO_TOKEN ANDROID_KEYSTORE_PASSWORD_PARENT ANDROID_KEYSTORE_PASSWORD_CHILD LAB_PHONE_RIYA LAB_PHONE_ROHIT LAB_PHONE_MAA_SMARTPHONE LAB_PHONE_MAA_KEYPAD)

ensure_lab2_dirs() { mkdir -p "$LAB2_DIR" "$PG_RUN"; chmod 700 "$LAB2_DIR" "$PG_RUN"; }

pg_bin_path() { if [[ -x "$PG_BIN/$1" ]]; then printf '%s\n' "$PG_BIN/$1"; else command -v "$1"; fi; }

check_bins() {
  local bin
  for bin in initdb pg_ctl psql openssl; do
    command -v "$bin" >/dev/null 2>&1 || [[ -x "$PG_BIN/$bin" ]] || { echo "ERROR: missing '$bin'" >&2; exit 2; }
  done
  command -v postgrest >/dev/null 2>&1 || [[ -x "$PG_BIN/postgrest" ]] || {
    echo "ERROR: PostgREST not found. Install it once with: /opt/homebrew/bin/brew install postgrest" >&2; exit 2; }
}

pg2_is_running() { [[ -f "$PG_DATA/PG_VERSION" ]] && "$(pg_bin_path pg_ctl)" -D "$PG_DATA" status >/dev/null 2>&1; }

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

pidfile_alive() {
  local f="$1" pid
  [[ -f "$f" ]] || return 1
  pid="$(tr -d '[:space:]' <"$f" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" >/dev/null 2>&1
}

stop_pidfile() {
  local f="$1" label="$2" pid i
  if pidfile_alive "$f"; then
    pid="$(tr -d '[:space:]' <"$f")"
    kill "$pid" >/dev/null 2>&1 || true
    for i in $(seq 1 40); do kill -0 "$pid" >/dev/null 2>&1 || break; sleep 0.25; done
    kill -0 "$pid" >/dev/null 2>&1 && kill -9 "$pid" >/dev/null 2>&1 || true
    echo "   stopped $label (pid $pid)"
  fi
  rm -f "$f"
}

# start_bg <name> <cwd> <cmd> [args...]  -> detached child, pid in $LAB2_DIR/<name>.pid, log in <name>.log.
# The child inherits the CURRENT environment; call it from a subshell that exported exactly what that process needs,
# so no secret ever appears on a command line (ps).
start_bg() {
  local name="$1" cwd="$2"; shift 2
  node -e '
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const [log, pidFile, cwd, cmd, ...args] = process.argv.slice(1);
    const out = fs.openSync(log, "a");
    const child = spawn(cmd, args, { cwd, detached: true, stdio: ["ignore", out, out], env: process.env });
    fs.writeFileSync(pidFile, String(child.pid) + "\n");
    child.unref();
  ' "$LAB2_DIR/$name.log" "$LAB2_DIR/$name.pid" "$cwd" "$@"
}

wait_http() {
  local url="$1" label="$2" tries="${3:-120}" i
  for i in $(seq 1 "$tries"); do
    curl -s -o /dev/null -m 2 "$url" && return 0
    sleep 0.25
  done
  echo "ERROR: $label did not answer at $url" >&2
  return 1
}

run_psql2() {
  local db="${1:-$LAB2_DB}"; shift || true
  "$(pg_bin_path psql)" -X -q -v ON_ERROR_STOP=1 -h "$LAB2_HOST" -p "$LAB2_PG_PORT" -U postgres -d "$db" "$@"
}

# Creates the lab CA and a server certificate for 127.0.0.1/localhost once (10 years; keys chmod 600).
ensure_lab2_tls() {
  mkdir -p "$LAB2_TLS_DIR"; chmod 700 "$LAB2_TLS_DIR"
  [[ -s "$LAB2_TLS_DIR/server.crt" && -s "$LAB2_TLS_DIR/server.key" && -s "$LAB2_CA_CERT" ]] && return 0
  echo "== creating lab-only CA + Postgres server certificate in $LAB2_TLS_DIR"
  ( cd "$LAB2_TLS_DIR"
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Sahaj lab2 local CA" \
      -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -keyout ca.key -out ca.crt >/dev/null 2>&1
    openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -keyout server.key -out server.csr >/dev/null 2>&1
    printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n' >server.ext
    openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -extfile server.ext -out server.crt >/dev/null 2>&1
    rm -f server.csr server.ext ca.srl
    chmod 600 ca.key server.key; chmod 644 ca.crt server.crt )
}

# The Atlas login may only connect over TLS with its password; every other lab role keeps local trust.
ensure_lab2_hba() {
  local hba="$PG_DATA/pg_hba.conf" marker="# sahaj-lab2 atlas tls"
  grep -q "$marker" "$hba" 2>/dev/null && return 0
  { echo "$marker"
    echo "hostssl ${LAB2_DB} ${ATLAS_DB_ROLE} 127.0.0.1/32 scram-sha-256"
    echo "host    all ${ATLAS_DB_ROLE} 0.0.0.0/0 reject"
    echo "local   all ${ATLAS_DB_ROLE} reject"
    cat "$hba"; } >"$hba.new" && mv "$hba.new" "$hba"
}

start_pg2() {
  ensure_lab2_dirs
  ensure_lab2_tls
  if [[ ! -f "$PG_DATA/PG_VERSION" ]]; then
    echo "== initdb $PG_DATA"
    "$(pg_bin_path initdb)" -D "$PG_DATA" -U postgres -A trust --no-locale -E UTF8 >"$LAB2_DIR/initdb.log" 2>&1 \
      || { cat "$LAB2_DIR/initdb.log" >&2; exit 2; }
  fi
  ensure_lab2_hba
  if pg2_is_running; then
    echo "== PostgreSQL already running on ${LAB2_HOST}:${LAB2_PG_PORT} ($PG_DATA)"
    "$(pg_bin_path pg_ctl)" -D "$PG_DATA" reload >/dev/null 2>&1 || true
  else
    if port_in_use "$LAB2_PG_PORT"; then echo "ERROR: port $LAB2_PG_PORT is taken by another process" >&2; exit 2; fi
    echo "== starting PostgreSQL 16 on ${LAB2_HOST}:${LAB2_PG_PORT}"
    "$(pg_bin_path pg_ctl)" -D "$PG_DATA" -l "$PG_LOG_FILE" -w \
      -o "-p $LAB2_PG_PORT -k $PG_RUN -c listen_addresses=${LAB2_HOST} -c ssl=on -c ssl_cert_file=$LAB2_TLS_DIR/server.crt -c ssl_key_file=$LAB2_TLS_DIR/server.key -c password_encryption=scram-sha-256" start >/dev/null \
      || { tail -n 30 "$PG_LOG_FILE" >&2 || true; exit 2; }
  fi
}

gen_hex() { openssl rand -hex "$1"; }

# Mints the service-role key for PostgREST/supabase-js from SUPABASE_JWT_SECRET (10 years, lab only).
mint_service_role_key() {
  node -e '
    const { createHmac } = require("node:crypto");
    const s = process.env.SUPABASE_JWT_SECRET, b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const d = b({ alg: "HS256", typ: "JWT" }) + "." + b({ role: "service_role", iss: "sahaj-lab2", iat: now, exp: now + 10 * 365 * 86400 });
    process.stdout.write(d + "." + createHmac("sha256", s).update(d).digest("base64url"));'
}

# Prints KEY="PEM" lines for a fresh Ed25519 pair: <PRIV_NAME> and optional <PUB_NAME>.
gen_ed25519_env() {
  node -e '
    const { generateKeyPairSync } = require("node:crypto");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const [priv, pub] = process.argv.slice(1);
    process.stdout.write(priv + "=\"" + privateKey.export({ type: "pkcs8", format: "pem" }).trim() + "\"\n");
    if (pub) process.stdout.write(pub + "=\"" + publicKey.export({ type: "spki", format: "pem" }).trim() + "\"\n");' "$@"
}

# Loads lab2.env, then the secrets file, generates what we own, persists lab2.env (0600), strips forbidden names.
load_lab2_env() {
  ensure_lab2_dirs
  if [[ -r "$LAB2_ENV_OUT" ]]; then set -a; source "$LAB2_ENV_OUT"; set +a; fi
  if [[ -r "$SECRETS_FILE" ]]; then
    set -a; source "$SECRETS_FILE"; set +a
    echo "== env: loaded secrets file '$SECRETS_FILE' (values hidden)"
  else
    echo "== env: secrets file '$SECRETS_FILE' not present (rules-only / outbox mode)"
  fi

  local -a generated=()
  local key
  for key in "${SHIELD_OWN_SECRETS[@]}" "${LAB2_OWN_SECRETS[@]}"; do
    if [[ -z "${!key:-}" ]]; then
      case "$key" in
        WEBHOOK_ENCRYPTION_KEY) export WEBHOOK_ENCRYPTION_KEY="$(gen_hex 32)" ;;
        *) export "$key=$(gen_hex 24)" ;;
      esac
      generated+=("$key")
    fi
  done
  if [[ -z "${TIMELINE_SIGNING_PRIVATE_KEY:-}" ]]; then
    eval "$(gen_ed25519_env TIMELINE_SIGNING_PRIVATE_KEY)"; export TIMELINE_SIGNING_PRIVATE_KEY; generated+=(TIMELINE_SIGNING_PRIVATE_KEY)
  fi
  if [[ -z "${SIGNING_PRIVATE_KEY:-}" || -z "${SIGNING_PUBLIC_KEY:-}" ]]; then
    eval "$(gen_ed25519_env SIGNING_PRIVATE_KEY SIGNING_PUBLIC_KEY)"; export SIGNING_PRIVATE_KEY SIGNING_PUBLIC_KEY; generated+=(SIGNING_PRIVATE_KEY SIGNING_PUBLIC_KEY)
  fi
  export TIMELINE_SIGNING_KEY_ID="${TIMELINE_SIGNING_KEY_ID:-lab2-core2-1}"
  export SIGNING_KEY_ID="${SIGNING_KEY_ID:-lab2-atlas-1}"
  if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
    export SUPABASE_SERVICE_ROLE_KEY="$(mint_service_role_key)"; generated+=(SUPABASE_SERVICE_ROLE_KEY)
  fi

  local tmp
  tmp="$(mktemp "$LAB2_DIR/lab2.env.XXXXXX")"; chmod 600 "$tmp"
  {
    echo "# Generated by scripts/lab/_lab2.sh: lab-only secrets we own (chmod 600). Never copy into the repo or an app."
    for key in "${SHIELD_OWN_SECRETS[@]}" "${LAB2_OWN_SECRETS[@]}" SUPABASE_SERVICE_ROLE_KEY TIMELINE_SIGNING_KEY_ID SIGNING_KEY_ID; do
      # Values that came from the secrets file stay there; only generated/derived ones are persisted here.
      if [[ " ${generated[*]-} " == *" $key "* ]] || grep -q "^${key}=" "$LAB2_ENV_OUT" 2>/dev/null; then printf '%s=%s\n' "$key" "${!key}"; fi
    done
    for key in TIMELINE_SIGNING_PRIVATE_KEY SIGNING_PRIVATE_KEY SIGNING_PUBLIC_KEY; do
      if [[ " ${generated[*]-} " == *" $key "* ]] || grep -q "^${key}=" "$LAB2_ENV_OUT" 2>/dev/null; then printf '%s="%s"\n' "$key" "${!key}"; fi
    done
  } >"$tmp"
  mv "$tmp" "$LAB2_ENV_OUT"; chmod 600 "$LAB2_ENV_OUT"
  [[ ${#generated[@]} -gt 0 ]] && echo "== generated lab-only secrets into $LAB2_ENV_OUT (chmod 600): ${generated[*]}"

  # WhatsApp is dropped: no WHATSAPP_* variable may reach either server (sends go to the outbox).
  local name
  for name in $(compgen -v | grep '^WHATSAPP_' || true); do unset "$name"; done
  # Shared lab defaults.
  export ALLOW_ANY_TOOL_IP="${ALLOW_ANY_TOOL_IP:-1}"
  export DEMO_TIMER_SCALE="${DEMO_TIMER_SCALE:-60}"
  export APP_ALLOWED_ORIGINS="${APP_ALLOWED_ORIGINS:-http://127.0.0.1:8081,http://localhost:8081,http://127.0.0.1:19006,http://localhost:19006,http://127.0.0.1:3000,http://localhost:3000}"
  # apps/api naming for values that already exist under shield-api names (same provider object, different variable).
  [[ -n "${SARVAM_AGENT_PHONE_NUMBER:-}" && -z "${SARVAM_AGENT_NUMBER:-}" ]] && export SARVAM_AGENT_NUMBER="$SARVAM_AGENT_PHONE_NUMBER"
  [[ -n "${SARVAM_TOOL_TOKEN:-}" && -z "${SARVAM_TOOL_BEARER:-}" ]] && export SARVAM_TOOL_BEARER="$SARVAM_TOOL_TOKEN"
  if [[ "$LAB2_PROVIDERS" == "off" ]]; then
    for name in "${PROVIDER_KEYS[@]}"; do unset "$name"; done
    export SARVAM_OUTBOUND_ENABLED=0 EXPO_PUSH_ENABLED=0 CALL_GATEWAY_ENABLED=0
    echo "== LAB2_PROVIDERS=off: AI, Sarvam, Expo and Langfuse keys removed; outbound calls and push disabled"
  fi
}

# Keeps only the named variables (plus PATH/HOME/TMPDIR) in the current shell. Call inside a subshell.
only_env() {
  local keep=" PATH HOME TMPDIR $* " name
  for name in $(compgen -e); do
    [[ "$keep" == *" $name "* ]] && continue
    # LAB2_* layout overrides (ports, LAB2_DIR) may arrive exported from the caller's shell; start_bg still needs them,
    # so they leave the child's environment but stay as shell variables. Everything else (secrets) is unset.
    if [[ "$name" == LAB2_* ]]; then export -n "$name"; else unset "$name" 2>/dev/null || true; fi
  done
}

# Exports the env for ONE process (call inside a subshell). $1 = shield|api|pgrst|proxy-door|proxy-supabase|cron-*.
server_env() {
  local name
  for name in "${NEVER_IN_SERVER[@]}"; do unset "$name"; done
  case "$1" in
    proxy-door)
      export PROXY_MODE=door PROXY_HOST="$LAB2_HOST" PROXY_PORT="$LAB2_PROXY_PORT" SHIELD_URL API_URL
      only_env PROXY_MODE PROXY_HOST PROXY_PORT SHIELD_URL API_URL
      ;;
    proxy-supabase)
      # LAB_STORAGE_DIR turns on the lab-only object store (scripts/lab/proxy.mjs createLabStorage) for voice media.
      # LAB_STORAGE_DB_URL mirrors each stored object into storage.objects, as Supabase Storage does (voice-post RPCs check it).
      export PROXY_MODE=supabase PROXY_HOST="$LAB2_HOST" PROXY_PORT="$LAB2_GW_PORT" PGRST_URL LAB_STORAGE_DIR="$LAB2_DIR/storage" SUPABASE_SERVICE_ROLE_KEY \
        LAB_STORAGE_DB_URL="$SERVICE_DB_URL"
      only_env PROXY_MODE PROXY_HOST PROXY_PORT PGRST_URL LAB_STORAGE_DIR SUPABASE_SERVICE_ROLE_KEY LAB_STORAGE_DB_URL
      ;;
    cron-shield)
      export SHIELD_API_URL="$DOOR_URL" CRON_SECRET
      only_env SHIELD_API_URL CRON_SECRET
      ;;
    cron-tick)
      export TICK_BASE_URL="$DOOR_URL" CRON_SECRET TICK_INTERVAL_SECONDS="${LAB2_TICK_SECONDS:-30}" DEMO_TIMER_SCALE
      only_env TICK_BASE_URL CRON_SECRET TICK_INTERVAL_SECONDS DEMO_TIMER_SCALE
      ;;
    shield)
      export DATABASE_URL="$SERVICE_DB_URL"
      unset ATLAS_DB_PASSWORD
      unset SUPABASE_SERVICE_ROLE_KEY SIGNING_PRIVATE_KEY SIGNING_PUBLIC_KEY TIMELINE_SIGNING_PRIVATE_KEY SAHAJ_LAB_MODE
      ;;
    api)
      export SAHAJ_LAB_MODE=1 SUPABASE_URL="$GW_URL"
      # Atlas checkpoints: verify-full TLS (packages/atlas/scripts/database-url.mjs) against the lab CA, as the
      # restricted sahaj_atlas_runtime login. LAB2_ATLAS=off leaves DATABASE_URL unset (workflow: not_configured).
      if [[ "${LAB2_ATLAS:-on}" != "off" ]]; then
        export DATABASE_URL="postgres://${ATLAS_DB_ROLE}:${ATLAS_DB_PASSWORD}@${LAB2_HOST}:${LAB2_PG_PORT}/${LAB2_DB}?sslmode=verify-full"
        export NODE_EXTRA_CA_CERTS="$LAB2_CA_CERT"
      else
        unset DATABASE_URL
      fi
      # TeleCMI missed-call ingestion needs an app id + virtual number. Without real ones the lab uses synthetic values
      # (not a dialable number); joined-smoke.mjs posts a synthetic CDR with the same values.
      export TELECMI_APP_ID="${TELECMI_APP_ID:-900001}" TELECMI_VIRTUAL_NUMBER="${TELECMI_VIRTUAL_NUMBER:-910000000099}"
      # The device pairing secret is shared with shield-api: Maa's paired-device routes (/api/core1/maa/**) verify with it.
      unset DEV_ADMIN_TOKEN SMS_GATEWAY_SECRET SARVAM_WEBHOOK_SECRET ATLAS_DB_PASSWORD
      ;;
    pgrst)
      unset ATLAS_DB_PASSWORD
      only_env SUPABASE_JWT_SECRET LAB2_HOST LAB2_PG_PORT LAB2_DB LAB2_PGRST_PORT
      export PGRST_DB_URI="postgres://authenticator@${LAB2_HOST}:${LAB2_PG_PORT}/${LAB2_DB}"
      export PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET="$SUPABASE_JWT_SECRET"
      export PGRST_SERVER_HOST="$LAB2_HOST" PGRST_SERVER_PORT="$LAB2_PGRST_PORT" PGRST_DB_POOL=10
      ;;
  esac
}

apply_tracked2() {
  local key="$1" path="$2" sha existing
  sha="$(shasum -a 256 "$path" | awk '{print $1}')"
  existing="$(run_psql2 "$LAB2_DB" -tA -c "select sha256 from public.lab_applied where file = '$key'")"
  if [[ -z "$existing" ]]; then
    echo "   applying $key"
    run_psql2 "$LAB2_DB" --single-transaction -f "$path" >/dev/null
    run_psql2 "$LAB2_DB" -c "insert into public.lab_applied (file, sha256) values ('$key', '$sha')"
    return 0
  fi
  [[ "$existing" != "$sha" ]] && echo "   WARNING: $key changed since it was applied (run scripts/lab/lab-reset2.sh)" >&2
  return 1
}

# bootstrap -> lab platform -> every migration (sorted) -> dev seeds. Re-runs apply only new files.
apply_lab2_sql() {
  run_psql2 "$LAB2_DB" -c "create table if not exists public.lab_applied (file text primary key, sha256 text not null, applied_at timestamptz not null default now());"
  local n=0 m
  apply_tracked2 "test/bootstrap.sql" "$REPO_ROOT/infra/supabase/test/bootstrap.sql" && n=$((n + 1))
  apply_tracked2 "lab/lab2_platform.sql" "$REPO_ROOT/scripts/lab/sql/lab2_platform.sql" && n=$((n + 1))
  while IFS= read -r m; do apply_tracked2 "migrations/$(basename "$m")" "$m" && n=$((n + 1)); done \
    < <(find "$REPO_ROOT/infra/supabase/migrations" -maxdepth 1 -name '*.sql' | LC_ALL=C sort)
  while IFS= read -r m; do apply_tracked2 "dev/$(basename "$m")" "$m" && n=$((n + 1)); done \
    < <(find "$REPO_ROOT/infra/supabase/dev" -maxdepth 1 -name '*.sql' | LC_ALL=C sort)
  echo "== lab_applied: $n new file(s), $(run_psql2 "$LAB2_DB" -tA -c 'select count(*) from public.lab_applied') tracked"
  enable_atlas_login
  # Lab object store (proxy.mjs) plays Supabase Storage: it records objects in storage.objects as service_role.
  run_psql2 "$LAB2_DB" -c "grant usage on schema storage to service_role; grant select, insert, delete on storage.objects to service_role;" >/dev/null
  # PostgREST caches the schema; ask it to reload (ignored when it is not running yet).
  run_psql2 "$LAB2_DB" -c "notify pgrst, 'reload schema'" >/dev/null || true
}

# Lab only: the migrations create sahaj_atlas_runtime NOLOGIN ("existing login credentials are deliberately preserved").
# Give it LOGIN with the generated password (read by psql from the environment, never on a command line).
enable_atlas_login() {
  [[ "${ATLAS_DB_PASSWORD:-}" =~ ^[0-9a-f]{32,}$ ]] || { echo "ERROR: ATLAS_DB_PASSWORD missing or not hex" >&2; return 1; }
  # The statement goes through stdin (not argv) so the password never shows in ps.
  printf "alter role %s with login password '%s';\n" "$ATLAS_DB_ROLE" "$ATLAS_DB_PASSWORD" | run_psql2 "$LAB2_DB" >/dev/null
  echo "== Atlas checkpoint login enabled for ${ATLAS_DB_ROLE} (TLS + password only)"
}

load_lab2_phones() {
  echo "== loading demo phones into encrypted provider_identities (numbers never printed)"
  ( export DATABASE_URL="$SERVICE_DB_URL"; cd "$REPO_ROOT" && ./node_modules/.bin/tsx scripts/lab/load-phones.ts )
}

needs_build() {
  local app_dir="$1"; shift
  [[ -f "$app_dir/.next/BUILD_ID" ]] || return 0
  [[ -n "$(find "$@" -type f -newer "$app_dir/.next/BUILD_ID" -print -quit 2>/dev/null)" ]]
}
