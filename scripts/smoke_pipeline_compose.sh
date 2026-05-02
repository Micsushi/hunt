#!/usr/bin/env bash
# Pass --existing to skip docker compose up and run checks against the already-running stack.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${PROJECT:-hunt-pipeline-smoke}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.pipeline.yml}"

# Source .env so credentials match whatever the running stack was started with.
# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && set -a && source "$ROOT/.env" && set +a || true

SERVICE_TOKEN="${SERVICE_TOKEN:-${HUNT_SERVICE_TOKEN:-hunt-local-smoke-token}}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-${HUNT_ADMIN_PASSWORD:-hunt-local-admin}}"

EXISTING=0
for arg in "$@"; do
  [ "$arg" = "--existing" ] && EXISTING=1
done

compose() {
  docker compose -f "$ROOT/$COMPOSE_FILE" -p "$PROJECT" --profile pipeline "$@"
}

cleanup() {
  [ "$EXISTING" -eq 1 ] && return
  compose down -v --remove-orphans >/dev/null 2>&1 || true
}

dump_logs() {
  [ "$EXISTING" -eq 1 ] && return
  echo
  echo "=== compose ps ==="
  compose ps 2>/dev/null || true
  echo
  echo "=== compose logs ==="
  compose logs --tail=160 2>/dev/null || true
}

wait_for() {
  local url="$1"
  local header="${2:-}"
  local output="$3"

  for _ in $(seq 1 30); do
    if [ -n "$header" ]; then
      if curl -fsS -H "$header" "$url" >"$output"; then
        return 0
      fi
    else
      if curl -fsS "$url" >"$output"; then
        return 0
      fi
    fi
    sleep 1
  done

  if [ -n "$header" ]; then
    curl -fsS -H "$header" "$url" >"$output"
  else
    curl -fsS "$url" >"$output"
  fi
}

trap cleanup EXIT
trap dump_logs ERR

cd "$ROOT"

if [ "$EXISTING" -eq 0 ]; then
  cleanup
  compose up -d --build
fi

wait_for "http://127.0.0.1:18080/health" "" /tmp/hunt-compose-review-health.json
wait_for "http://127.0.0.1:18001/status" "Authorization: Bearer ${SERVICE_TOKEN}" /tmp/hunt-compose-c1-status.json
wait_for "http://127.0.0.1:18002/status" "Authorization: Bearer ${SERVICE_TOKEN}" /tmp/hunt-compose-c2-status.json
wait_for "http://127.0.0.1:18003/status" "Authorization: Bearer ${SERVICE_TOKEN}" /tmp/hunt-compose-c4-status.json

curl -fsS \
  -c /tmp/hunt-compose-cookies.txt \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "username=admin&password=${ADMIN_PASSWORD}" \
  "http://127.0.0.1:18080/auth/login" >/tmp/hunt-compose-login.json

curl -fsS \
  -b /tmp/hunt-compose-cookies.txt \
  "http://127.0.0.1:18080/api/gateway/c1/status" >/tmp/hunt-compose-gateway-c1.json

cat /tmp/hunt-compose-review-health.json
echo
cat /tmp/hunt-compose-c1-status.json
echo
cat /tmp/hunt-compose-c2-status.json
echo
cat /tmp/hunt-compose-c4-status.json
echo
cat /tmp/hunt-compose-gateway-c1.json
echo

grep -q '"status":"ok"' /tmp/hunt-compose-review-health.json
grep -q '"service":"c1-hunter"' /tmp/hunt-compose-c1-status.json
grep -q '"service":"c2-fletcher"' /tmp/hunt-compose-c2-status.json
grep -q '"service":"c4-coordinator"' /tmp/hunt-compose-c4-status.json
grep -q '"service":"c1-hunter"' /tmp/hunt-compose-gateway-c1.json

echo "pipeline compose smoke passed"
