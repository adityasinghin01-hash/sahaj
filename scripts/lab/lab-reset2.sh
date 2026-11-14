#!/usr/bin/env bash
# Joined lab: drop and rebuild $LAB2_DB (default sahaj_lab2 on 127.0.0.1:54339, data in ~/.sahaj-lab2/pg).
#   bootstrap.sql -> scripts/lab/sql/lab2_platform.sql -> ALL infra/supabase/migrations (sorted) -> infra/supabase/dev seeds
#   (demo family with the lab UUIDs) -> real demo phones from the secrets file into encrypted provider_identities.
# Never touches the v1 lab (~/.sahaj-lab, pg 54329). Running servers keep running; PostgREST is told to reload.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lab2.sh"

check_bins
load_lab2_env
start_pg2

echo "== dropping and recreating database '$LAB2_DB'"
run_psql2 postgres -c "drop database if exists $LAB2_DB with (force);"
run_psql2 postgres -c "create database $LAB2_DB;"
apply_lab2_sql
load_lab2_phones
echo "== $LAB2_DB reset complete"
