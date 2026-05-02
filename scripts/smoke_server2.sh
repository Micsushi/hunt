#!/usr/bin/env bash
# Server2 smoke: run C0 checks against the live server2 production URLs.
# Credentials come from env vars or a .env.server2-smoke file if present.
#
# Usage:
#   bash scripts/smoke_server2.sh
#   HUNT_ADMIN_PASSWORD=xxx HUNT_SERVICE_TOKEN=yyy bash scripts/smoke_server2.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BASE="${BASE:-https://agent-hunt-review.mshi.ca}"
# Frontend SPA is served from the review container root; separate agent-hunt.mshi.ca not required.
FRONTEND_BASE="${FRONTEND_BASE:-https://agent-hunt-review.mshi.ca}"

# Load .env.server2-smoke if present and credentials not already set
ENV_FILE="$ROOT/.env.server2-smoke"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

ADMIN_PASSWORD="${ADMIN_PASSWORD:-${HUNT_ADMIN_PASSWORD:-}}"
SERVICE_TOKEN="${SERVICE_TOKEN:-${HUNT_SERVICE_TOKEN:-}}"

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "ERROR: set HUNT_ADMIN_PASSWORD or create .env.server2-smoke with HUNT_ADMIN_PASSWORD=..." >&2
  exit 1
fi
if [ -z "$SERVICE_TOKEN" ]; then
  echo "ERROR: set HUNT_SERVICE_TOKEN or create .env.server2-smoke with HUNT_SERVICE_TOKEN=..." >&2
  exit 1
fi

export BASE FRONTEND_BASE ADMIN_PASSWORD SERVICE_TOKEN

echo "=== hunt server2 smoke ==="
echo "  BASE:          $BASE"
echo "  FRONTEND_BASE: $FRONTEND_BASE"
echo

exec bash "$ROOT/scripts/smoke_c0_pipeline_container.sh" --existing
