#!/usr/bin/env bash
# Shared configuration and helpers for the local Shield lab stack (scripts/lab/*).
# Never prints secret values; prints only variable names when reporting loaded configuration.

LAB_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LAB_COMMON_DIR/../.." && pwd)"

PG_BIN="${PG_BIN:-/opt/homebrew/bin}"
LAB_DIR="${LAB_DIR:-$HOME/.sahaj-lab}"
PG_DATA="$LAB_DIR/pg"
PG_RUN="$LAB_DIR/pg_run"
PG_HOST="127.0.0.1"
PG_PORT="54329"
LAB_DB="sahaj_lab"

APP_HOST="127.0.0.1"
APP_PORT="3100"
APP_URL="http://${APP_HOST}:${APP_PORT}"

NEXT_PID_FILE="$LAB_DIR/next.pid"
NEXT_LOG_FILE="$LAB_DIR/next.log"
CRON_PID_FILE="$LAB_DIR/cron.pid"
CRON_LOG_FILE="$LAB_DIR/cron.log"
PG_LOG_FILE="$LAB_DIR/pg.log"
LAB_ENV_FILE_OUT="$LAB_DIR/lab.env"

DEFAULT_SECRETS_FILE="$HOME/dev/sahaj-secrets/shield.env"
SECRETS_FILE="${LAB_ENV_FILE:-$DEFAULT_SECRETS_FILE}"

REQUIRED_SECRETS=(
  SHIELD_DEVICE_PAIRING_SECRET
  DEV_ADMIN_TOKEN
  SARVAM_TOOL_TOKEN
  CRON_SECRET
  SMS_GATEWAY_SECRET
  SUPABASE_JWT_SECRET
  SARVAM_WEBHOOK_SECRET
)

AI_KEY_NAMES=(
  ANTHROPIC_API_KEY
  MUSE_API_KEY
  GEMINI_API_KEY
  SAFE_BROWSING_KEY
  WHATSAPP_TOKEN
  WHATSAPP_PHONE_NUMBER_ID
  EXPO_ACCESS_TOKEN
  SARVAM_API_KEY
)

ensure_lab_dirs() {
  mkdir -p "$LAB_DIR" "$PG_RUN"
  chmod 700 "$LAB_DIR" "$PG_RUN"
}

check_pg_bins() {
  local bin
  for bin in initdb pg_ctl psql shasum; do
    if ! command -v "$bin" >/dev/null 2>&1 && [[ ! -x "$PG_BIN/$bin" ]]; then
      echo "ERROR: missing required binary '$bin' (checked PATH and $PG_BIN)" >&2
      exit 2
    fi
  done
}

pg_bin_path() {
  local name="$1"
  if [[ -x "$PG_BIN/$name" ]]; then
    printf '%s\n' "$PG_BIN/$name"
  else
    command -v "$name"
  fi
}

pg_is_running() {
  [[ -f "$PG_DATA/PG_VERSION" ]] || return 1
  "$(pg_bin_path pg_ctl)" -D "$PG_DATA" status >/dev/null 2>&1
}

pidfile_is_running() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$file" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1
}

stop_pidfile() {
  local file="$1"
  local label="$2"
  if pidfile_is_running "$file"; then
    local pid
    pid="$(tr -d '[:space:]' < "$file")"
    kill "$pid" >/dev/null 2>&1 || true
    local i
    for i in $(seq 1 20); do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
    echo "Stopped $label (pid $pid)"
  fi
  rm -f "$file"
}

gen_hex_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))'
  fi
}

# Loads existing ~/.sahaj-lab/lab.env (if present), then SECRETS_FILE (if readable),
# sets lab defaults, and writes any missing required secrets into ~/.sahaj-lab/lab.env (mode 600).
load_and_prepare_env() {
  local allow_generate="${1:-0}"
  ensure_lab_dirs

  if [[ -r "$LAB_ENV_FILE_OUT" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$LAB_ENV_FILE_OUT"
    set +a
  fi

  local secrets_loaded=0
  local -a loaded_names=()
  if [[ -r "$SECRETS_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$SECRETS_FILE"
    set +a
    secrets_loaded=1
    while IFS= read -r varname; do
      [[ -n "$varname" && -n "${!varname:-}" ]] && loaded_names+=("$varname")
    done < <(awk -F= '/^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=/{sub(/^[[:space:]]*(export[[:space:]]+)?/, "", $1); gsub(/[[:space:]]+$/, "", $1); print $1}' "$SECRETS_FILE" | LC_ALL=C sort -u)
  fi

  export DATABASE_URL="${DATABASE_URL:-postgres://service_role@${PG_HOST}:${PG_PORT}/${LAB_DB}}"
  export ALLOW_ANY_TOOL_IP="${ALLOW_ANY_TOOL_IP:-1}"
  export DEMO_TIMER_SCALE="${DEMO_TIMER_SCALE:-60}"
  export APP_ALLOWED_ORIGINS="${APP_ALLOWED_ORIGINS:-http://127.0.0.1:8081,http://localhost:8081,http://127.0.0.1:19006,http://localhost:19006,http://127.0.0.1:3000,http://localhost:3000}"

  local -a generated_names=()
  local key
  if [[ "$allow_generate" == "1" ]]; then
    for key in "${REQUIRED_SECRETS[@]}"; do
      if [[ -z "${!key:-}" ]]; then
        export "${key}=$(gen_hex_secret)"
        generated_names+=("$key")
      fi
    done

    # Persist non-empty lab configuration (lab defaults + active required secrets) cleanly with 0600 permissions.
    local tmp_env
    tmp_env="$(mktemp "$LAB_DIR/lab.env.XXXXXX")"
    chmod 600 "$tmp_env"
    {
      echo "# Generated/maintained by scripts/lab/lab-up.sh — lab-only env (chmod 600)."
      echo "DATABASE_URL=$DATABASE_URL"
      echo "ALLOW_ANY_TOOL_IP=$ALLOW_ANY_TOOL_IP"
      echo "DEMO_TIMER_SCALE=$DEMO_TIMER_SCALE"
      echo "APP_ALLOWED_ORIGINS=$APP_ALLOWED_ORIGINS"
      for key in "${REQUIRED_SECRETS[@]}"; do
        if [[ -n "${!key:-}" ]]; then
          printf '%s=%s\n' "$key" "${!key}"
        fi
      done
    } >"$tmp_env"
    mv "$tmp_env" "$LAB_ENV_FILE_OUT"
    chmod 600 "$LAB_ENV_FILE_OUT"
  fi

  local -a all_set_names=()
  local candidate
  for candidate in DATABASE_URL ALLOW_ANY_TOOL_IP DEMO_TIMER_SCALE APP_ALLOWED_ORIGINS "${REQUIRED_SECRETS[@]}" "${AI_KEY_NAMES[@]}" ${loaded_names[@]+"${loaded_names[@]}"}; do
    if [[ -n "${!candidate:-}" ]]; then
      if [[ " ${all_set_names[*]-} " != *" $candidate "* ]]; then
        all_set_names+=("$candidate")
      fi
    fi
  done

  if [[ $secrets_loaded -eq 1 ]]; then
    echo "== env: loaded secrets file '$SECRETS_FILE' (values hidden)"
  else
    echo "== env: secrets file '$SECRETS_FILE' not present (rules-only / outbox mode)"
  fi
  echo "== env variables set (names only): ${all_set_names[*]-}"
  if [[ ${#generated_names[@]} -gt 0 ]]; then
    echo "== generated lab-only secrets into $LAB_ENV_FILE_OUT (chmod 600): ${generated_names[*]}"
  fi
}

run_psql_lab() {
  local db="${1:-$LAB_DB}"
  shift || true
  "$(pg_bin_path psql)" -X -q -v ON_ERROR_STOP=1 -h "$PG_HOST" -p "$PG_PORT" -U postgres -d "$db" "$@"
}

apply_tracked_file() {
  local key="$1"
  local path="$2"
  local sha
  sha="$(shasum -a 256 "$path" | awk '{print $1}')"
  local existing
  existing="$(run_psql_lab "$LAB_DB" -tA -c "select sha256 from public.lab_applied where file = '$key'")"
  if [[ -z "$existing" ]]; then
    echo "   applying $key"
    run_psql_lab "$LAB_DB" -f "$path"
    run_psql_lab "$LAB_DB" -c "insert into public.lab_applied (file, sha256) values ('$key', '$sha')"
    return 0
  fi
  if [[ "$existing" != "$sha" ]]; then
    echo "   WARNING: $key already applied with different sha256 (run scripts/lab/lab-reset.sh to rebuild)" >&2
  fi
  return 1
}

apply_lab_sql() {
  run_psql_lab "$LAB_DB" -c "create table if not exists public.lab_applied (file text primary key, sha256 text not null, applied_at timestamptz not null default now());"

  local applied_count=0
  local m
  if apply_tracked_file "dev/core_stub.sql" "$REPO_ROOT/infra/supabase/dev/core_stub.sql"; then
    applied_count=$((applied_count + 1))
  fi

  while IFS= read -r m; do
    if apply_tracked_file "migrations/$(basename "$m")" "$m"; then
      applied_count=$((applied_count + 1))
    fi
  done < <(find "$REPO_ROOT/infra/supabase/migrations" -maxdepth 1 -name '*.sql' | LC_ALL=C sort)

  while IFS= read -r m; do
    [[ "$(basename "$m")" == "core_stub.sql" ]] && continue
    if apply_tracked_file "dev/$(basename "$m")" "$m"; then
      applied_count=$((applied_count + 1))
    fi
  done < <(find "$REPO_ROOT/infra/supabase/dev" -maxdepth 1 -name '*.sql' | LC_ALL=C sort)

  local total
  total="$(run_psql_lab "$LAB_DB" -tA -c "select count(*) from public.lab_applied")"
  echo "== lab_applied: $applied_count new file(s) applied ($total total tracked)"
}
