#!/usr/bin/env bash
# Full real schema and both teams rollback-only SQL gates on a disposable cluster.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$HERE/run-integration.sh"
