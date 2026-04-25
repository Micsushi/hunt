#!/usr/bin/env bash
# C0 pipeline smoke: runs local compose services and verifies C0 is the operator gateway.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.pipeline.yml}"
PROJECT="${PROJECT:-hunt-c0-smoke-$$}"
BASE="${BASE:-http://127.0.0.1:18080}"
FRONTEND_BASE="${FRONTEND_BASE:-http://127.0.0.1:18090}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-hunt-local-admin}"
SERVICE_TOKEN="${SERVICE_TOKEN:-hunt-local-smoke-token}"

PASS=0
FAIL=0

ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1 - $2"; FAIL=$((FAIL + 1)); }
check_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then ok "$label"; else fail "$label" "missing '$needle'"; fi
}
check_http() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then ok "$label"; else fail "$label" "expected $expected got $actual"; fi
}

cleanup() {
  docker compose -p "$PROJECT" -f "$ROOT/$COMPOSE_FILE" --profile pipeline down -v >/dev/null 2>&1 || true
}
dump_logs() {
  echo
  echo "=== compose ps ==="
  docker compose -p "$PROJECT" -f "$ROOT/$COMPOSE_FILE" --profile pipeline ps || true
  echo
  echo "=== review logs ==="
  docker compose -p "$PROJECT" -f "$ROOT/$COMPOSE_FILE" --profile pipeline logs --tail 120 review || true
}
trap cleanup EXIT
trap dump_logs ERR

cd "$ROOT"
echo "=== hunt C0 pipeline smoke ==="
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --profile pipeline up -d --build

for _ in $(seq 1 60); do
  if curl -fsS "$BASE/health" >/tmp/hunt-c0-health.json 2>/dev/null; then
    break
  fi
  sleep 2
done

health="$(curl -fsS "$BASE/health")"
check_contains "GET /health reports ok" '"status":"ok"' "$health"

curl -fsS \
  -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "username=admin&password=${ADMIN_PASSWORD}" \
  -c /tmp/hunt-c0-cookies.txt \
  "$BASE/auth/login" >/tmp/hunt-c0-login.json
check_contains "C0 login returns ok" '"status":"ok"' "$(cat /tmp/hunt-c0-login.json)"

system_status="$(curl -fsS -b /tmp/hunt-c0-cookies.txt "$BASE/api/system/status")"
check_contains "system status has DB" '"db"' "$system_status"
check_contains "system status has C1" '"c1"' "$system_status"
check_contains "system status has C2" '"c2"' "$system_status"
check_contains "system status has C3" '"c3"' "$system_status"
check_contains "system status has C4" '"c4"' "$system_status"

check_http "anonymous gateway blocked" "401" "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/gateway/c1/status")"
check_http "C1 status through C0" "200" "$(curl -s -b /tmp/hunt-c0-cookies.txt -o /tmp/hunt-c0-c1.json -w "%{http_code}" "$BASE/api/gateway/c1/status")"
check_contains "C1 status body" '"service"' "$(cat /tmp/hunt-c0-c1.json)"
check_http "C2 status through C0" "200" "$(curl -s -b /tmp/hunt-c0-cookies.txt -o /tmp/hunt-c0-c2.json -w "%{http_code}" "$BASE/api/gateway/c2/status")"
check_http "C4 status through C0" "200" "$(curl -s -b /tmp/hunt-c0-cookies.txt -o /tmp/hunt-c0-c4.json -w "%{http_code}" "$BASE/api/gateway/c4/status")"

settings="$(curl -fsS -b /tmp/hunt-c0-cookies.txt -H "Content-Type: application/json" -d '{"component":"c3","key":"extension_version","value":"local-smoke","value_type":"string","secret":false}' "$BASE/api/settings")"
check_contains "settings write returns redacted record" '"extension_version"' "$settings"
settings_list="$(curl -fsS -b /tmp/hunt-c0-cookies.txt "$BASE/api/settings?component=c3")"
check_contains "settings list returns c3 setting" '"local-smoke"' "$settings_list"

account="$(curl -fsS -b /tmp/hunt-c0-cookies.txt -H "Content-Type: application/json" -d '{"username":"smoke@example.com","display_name":"Smoke","active":true}' "$BASE/api/linkedin/accounts")"
check_contains "account create returns username" '"smoke@example.com"' "$account"
accounts="$(curl -fsS -b /tmp/hunt-c0-cookies.txt "$BASE/api/linkedin/accounts")"
check_contains "account list returns username" '"smoke@example.com"' "$accounts"

check_http "C3 pending fills via service token" "200" "$(curl -s -H "Authorization: Bearer ${SERVICE_TOKEN}" -o /tmp/hunt-c0-c3.json -w "%{http_code}" "$BASE/api/c3/pending-fills")"
check_contains "C3 pending fills body" '"fills"' "$(cat /tmp/hunt-c0-c3.json)"

frontend="$(curl -fsS "$FRONTEND_BASE/")"
if echo "$frontend" | grep -qi '<!doctype html>'; then
  ok "frontend nginx serves SPA"
else
  fail "frontend nginx serves SPA" "missing doctype"
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "C0 pipeline smoke PASSED" && exit 0
echo "C0 pipeline smoke FAILED"
exit 1
