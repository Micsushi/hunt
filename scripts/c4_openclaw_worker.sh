#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${HUNT_COORDINATOR_BASE_URL:-http://127.0.0.1:8003}"
RUNTIME="${RUNTIME:-openclaw_isolated}"

python -m coordinator.agent_worker \
  --runtime "$RUNTIME" \
  --base-url "$BASE_URL" \
  "$@"
