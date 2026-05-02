#!/usr/bin/env bash
# Server2 C1 smoke: trigger one live scrape + enrich cycle through C0,
# then verify C1 returns to an idle state without stale processing rows.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${BASE:-https://agent-hunt-review.mshi.ca}"
ENV_FILE="$ROOT/.env.server2-smoke"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

ADMIN_PASSWORD="${ADMIN_PASSWORD:-${HUNT_ADMIN_PASSWORD:-}}"
C1_ENRICH_LIMIT="${C1_ENRICH_LIMIT:-1}"
C1_TRIGGER_RETRIES="${C1_TRIGGER_RETRIES:-3}"
C1_IDLE_WAIT_SECONDS="${C1_IDLE_WAIT_SECONDS:-240}"
C1_RUN_WAIT_SECONDS="${C1_RUN_WAIT_SECONDS:-900}"
C1_RECENT_JOB_LIMIT="${C1_RECENT_JOB_LIMIT:-10}"

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "ERROR: set HUNT_ADMIN_PASSWORD or create .env.server2-smoke with HUNT_ADMIN_PASSWORD=..." >&2
  exit 1
fi

PASS=0
FAIL=0

ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1 : $2"; FAIL=$((FAIL + 1)); }

json_get() {
  local path="$1"
  local json_file="${2:-}"
  if [ -z "$json_file" ]; then
    echo "json_get requires a JSON file path" >&2
    return 1
  fi
  python - "$path" "$json_file" <<'PY'
import json
import sys

parts = [p for p in sys.argv[1].split(".") if p]
with open(sys.argv[2], "r", encoding="utf-8") as handle:
    value = json.load(handle)
for part in parts:
    if isinstance(value, list):
        value = value[int(part)]
    else:
        value = value[part]
if isinstance(value, bool):
    print("true" if value else "false")
elif value is None:
    print("")
else:
    print(value)
PY
}

login() {
  curl -fsS \
    -X POST \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data "username=admin&password=${ADMIN_PASSWORD}" \
    -c /tmp/hunt-server2-c1-cookies.txt \
    "$BASE/auth/login" >/tmp/hunt-server2-c1-login.json
}

fetch_c1_status() {
  curl -fsS \
    -b /tmp/hunt-server2-c1-cookies.txt \
    "$BASE/api/gateway/c1/status" >/tmp/hunt-server2-c1-status.json
}

fetch_c1_queue() {
  curl -fsS \
    -b /tmp/hunt-server2-c1-cookies.txt \
    "$BASE/api/gateway/c1/queue" >/tmp/hunt-server2-c1-queue.json
}

fetch_system_status() {
  curl -fsS \
    -b /tmp/hunt-server2-c1-cookies.txt \
    "$BASE/api/system/status" >/tmp/hunt-server2-c1-system.json
}

fetch_processing_count() {
  curl -fsS \
    -b /tmp/hunt-server2-c1-cookies.txt \
    "$BASE/api/jobs/count?source=linkedin&status=processing" >/tmp/hunt-server2-c1-processing.json
}

fetch_recent_linkedin_jobs() {
  curl -fsS \
    -b /tmp/hunt-server2-c1-cookies.txt \
    "$BASE/api/jobs?source=linkedin&limit=${C1_RECENT_JOB_LIMIT}&sort=date_scraped&direction=desc" \
    >/tmp/hunt-server2-c1-jobs.json
}

wait_for_idle() {
  local timeout_seconds="$1"
  local started_at
  started_at="$(date +%s)"
  while true; do
    fetch_c1_status
    local scrape_running enrich_running
    scrape_running="$(json_get scrape_running /tmp/hunt-server2-c1-status.json)"
    enrich_running="$(json_get enrich_running /tmp/hunt-server2-c1-status.json)"
    if [ "$scrape_running" = "false" ] && [ "$enrich_running" = "false" ]; then
      return 0
    fi
    if [ $(( $(date +%s) - started_at )) -ge "$timeout_seconds" ]; then
      return 1
    fi
    sleep 5
  done
}

trigger_scrape_cycle() {
  local attempt code
  for attempt in $(seq 1 "$C1_TRIGGER_RETRIES"); do
    if ! wait_for_idle "$C1_IDLE_WAIT_SECONDS"; then
      echo "C1 did not become idle before trigger attempt ${attempt}" >&2
      continue
    fi
    code="$(
      curl -s \
        -o /tmp/hunt-server2-c1-trigger.json \
        -w "%{http_code}" \
        -b /tmp/hunt-server2-c1-cookies.txt \
        -H "Content-Type: application/json" \
        -d "{\"enrich_after\":true,\"enrich_limit\":${C1_ENRICH_LIMIT}}" \
        "$BASE/api/gateway/c1/scrape"
    )"
    if [ "$code" = "200" ]; then
      return 0
    fi
    if [ "$code" != "409" ]; then
      echo "Unexpected scrape trigger HTTP ${code}" >&2
      cat /tmp/hunt-server2-c1-trigger.json >&2 || true
      return 1
    fi
    sleep 5
  done
  echo "Could not trigger a scrape cycle without colliding with another run" >&2
  return 1
}

echo "=== hunt server2 C1 smoke ==="
echo "  BASE: $BASE"
echo "  C1_ENRICH_LIMIT: $C1_ENRICH_LIMIT"
echo

login
if grep -q '"status":"ok"' /tmp/hunt-server2-c1-login.json; then
  ok "C0 login works"
else
  fail "C0 login works" "login response was not ok"
fi

fetch_c1_status
if grep -q '"service":"c1-hunter"' /tmp/hunt-server2-c1-status.json; then
  ok "C1 status route reachable through C0"
else
  fail "C1 status route reachable through C0" "missing c1-hunter marker"
fi

fetch_c1_queue
if grep -q '"pending":' /tmp/hunt-server2-c1-queue.json && grep -q '"ready":' /tmp/hunt-server2-c1-queue.json; then
  ok "C1 queue returns pending and ready counts"
else
  fail "C1 queue returns pending and ready counts" "queue response was incomplete"
fi

if trigger_scrape_cycle; then
  ok "C1 scrape trigger accepted"
else
  fail "C1 scrape trigger accepted" "could not start a live scrape cycle"
fi

if wait_for_idle "$C1_RUN_WAIT_SECONDS"; then
  ok "C1 scrape and enrich cycle returned to idle"
else
  fail "C1 scrape and enrich cycle returned to idle" "C1 stayed busy past timeout"
fi

fetch_c1_status
if [ "$(json_get scrape_running /tmp/hunt-server2-c1-status.json)" = "false" ] && \
   [ "$(json_get enrich_running /tmp/hunt-server2-c1-status.json)" = "false" ]; then
  ok "C1 steady-state flags are clear after run"
else
  fail "C1 steady-state flags are clear after run" "scrape_running or enrich_running stayed true"
fi

fetch_processing_count
if [ "$(json_get count /tmp/hunt-server2-c1-processing.json)" = "0" ]; then
  ok "LinkedIn queue drained out of processing"
else
  fail "LinkedIn queue drained out of processing" "processing rows remained after the run"
fi

fetch_system_status
if [ "$(json_get components.c1.status /tmp/hunt-server2-c1-system.json)" = "ok" ]; then
  ok "C0 still sees C1 as healthy after the cycle"
else
  fail "C0 still sees C1 as healthy after the cycle" "system status did not report c1 healthy"
fi

fetch_recent_linkedin_jobs
if python - /tmp/hunt-server2-c1-jobs.json <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    rows = json.load(handle)
if not isinstance(rows, list) or not rows:
    raise SystemExit(1)
linked = [row for row in rows if row.get("source") == "linkedin"]
if not linked:
    raise SystemExit(1)
required_keys = {"id", "title", "company", "enrichment_status"}
if not any(required_keys.issubset(set(row)) for row in linked if isinstance(row, dict)):
    raise SystemExit(1)
PY
then
  ok "Recent LinkedIn jobs remain queryable through C0"
else
  fail "Recent LinkedIn jobs remain queryable through C0" "recent LinkedIn rows were missing or malformed"
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "Server2 C1 smoke PASSED" && exit 0
echo "Server2 C1 smoke FAILED"
exit 1
