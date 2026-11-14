#!/usr/bin/env bash
# Safe live endpoint verification script for Project SAHAJ Phase 1
# Does not read, log, or leak secrets.
set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
BYPASS_TOKEN="${2:-}"

AUTH_HEADER=()
if [ -n "$BYPASS_TOKEN" ]; then
  AUTH_HEADER=(-H "x-vercel-protection-bypass: $BYPASS_TOKEN")
fi

echo "=========================================================="
echo "Running SAHAJ Phase 1 Live Verification on $BASE_URL"
echo "=========================================================="

# 1. Test dedicated liveness endpoint
echo -n "Checking GET /api/health/liveness ... "
LIVENESS_RESP=$(curl -s -i "${AUTH_HEADER[@]}" "$BASE_URL/api/health/liveness")
LIVENESS_STATUS=$(echo "$LIVENESS_RESP" | grep -E '^HTTP/' | awk '{print $2}' | tail -n1)

if [ "$LIVENESS_STATUS" -ne 200 ]; then
  echo "FAILED: HTTP status $LIVENESS_STATUS (expected 200)"
  exit 1
fi

if ! echo "$LIVENESS_RESP" | grep -qi 'cache-control:.*no-store'; then
  echo "FAILED: Missing Cache-Control: no-store"
  exit 1
fi

if ! echo "$LIVENESS_RESP" | grep -q '"ok":true'; then
  echo "FAILED: Response does not contain ok:true"
  exit 1
fi

if ! echo "$LIVENESS_RESP" | grep -q '"emergency_ready":false'; then
  echo "FAILED: emergency_ready is not false"
  exit 1
fi
echo "PASS (HTTP 200, no-store, emergency_ready=false)"

# 2. Test query parameter probe=liveness
echo -n "Checking GET /api/health?probe=liveness ... "
PARAM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${AUTH_HEADER[@]}" "$BASE_URL/api/health?probe=liveness")
if [ "$PARAM_STATUS" -ne 200 ]; then
  echo "FAILED: HTTP status $PARAM_STATUS (expected 200)"
  exit 1
fi
echo "PASS (HTTP 200)"

# 3. Test readiness probe (GET /api/health)
echo -n "Checking GET /api/health (Readiness) ... "
READINESS_RESP=$(curl -s -i "${AUTH_HEADER[@]}" "$BASE_URL/api/health")
READINESS_STATUS=$(echo "$READINESS_RESP" | grep -E '^HTTP/' | awk '{print $2}' | tail -n1)

if [ "$READINESS_STATUS" -ne 200 ] && [ "$READINESS_STATUS" -ne 503 ]; then
  echo "FAILED: Unexpected HTTP status $READINESS_STATUS (expected 200 ready or 503 degraded)"
  exit 1
fi

if ! echo "$READINESS_RESP" | grep -qi 'cache-control:.*no-store'; then
  echo "FAILED: Missing Cache-Control: no-store"
  exit 1
fi

if ! echo "$READINESS_RESP" | grep -q '"emergency_ready":false'; then
  echo "FAILED: emergency_ready is not false"
  exit 1
fi

if ! echo "$READINESS_RESP" | grep -q '"care_actions":"disabled"'; then
  echo "FAILED: care_actions is not disabled"
  exit 1
fi

# Assert no credentials leak into body
if echo "$READINESS_RESP" | grep -Eiq 'postgres:|postgresql:|eyjhb|password|token'; then
  echo "FAILED: Response appears to contain credential fragments!"
  exit 1
fi

if [ "$READINESS_STATUS" -eq 200 ]; then
  echo "PASS (HTTP 200 Ready: Database and schema connected, emergency_ready=false, safe body)"
else
  echo "PASS (HTTP 503 Degraded: Safe error reported, emergency_ready=false, safe body)"
fi

echo "=========================================================="
echo "Phase 1 Live Endpoint Verification Succeeded!"
echo "=========================================================="
