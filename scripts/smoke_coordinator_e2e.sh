#!/usr/bin/env bash
# End-to-end coordinator smoke: builds coordinator image, runs against real Postgres,
# exercises the full apply flow (POST /run -> C3 fill -> approve/deny).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${RUN_ID:-$$}"

IMAGE="${IMAGE:-hunt-coordinator-local:e2e}"
NETWORK="${NETWORK:-hunt-coord-e2e-${RUN_ID}}"
PG_CONTAINER="${PG_CONTAINER:-hunt-coord-e2e-pg-${RUN_ID}}"
COORD_CONTAINER="${COORD_CONTAINER:-hunt-coord-e2e-api-${RUN_ID}}"

PG_USER="${PG_USER:-hunt}"
PG_PASSWORD="${PG_PASSWORD:-hunt}"
PG_DB="${PG_DB:-hunt}"
COORD_PORT="${COORD_PORT:-19003}"
SERVICE_TOKEN="${SERVICE_TOKEN:-hunt-e2e-token}"

PASS=0
FAIL=0

ok()   { echo "  PASS  $1"; PASS=$(( PASS + 1 )); }
fail() { echo "  FAIL  $1 - $2"; FAIL=$(( FAIL + 1 )); }

check_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$actual" = "$expected" ]; then ok "$label"
    else fail "$label" "expected='$expected' got='$actual'"; fi
}
check_contains() {
    local label="$1" needle="$2" haystack="$3"
    if echo "$haystack" | grep -qF "$needle"; then ok "$label"
    else fail "$label" "expected to contain '$needle'"; fi
}
json_field() { python3 -c "import sys,json; d=json.load(sys.stdin); print(d$1)" 2>/dev/null || echo ""; }

BASE="http://127.0.0.1:${COORD_PORT}"
api() { curl -s -H "Authorization: Bearer ${SERVICE_TOKEN}" "$@"; }

cleanup() {
    docker rm -f "$COORD_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
dump_logs() {
    echo; echo "=== coordinator logs ==="
    docker logs --tail 80 "$COORD_CONTAINER" 2>/dev/null || true
    echo; echo "=== postgres logs ==="
    docker logs --tail 40 "$PG_CONTAINER" 2>/dev/null || true
}
trap cleanup EXIT
trap dump_logs ERR

cd "$ROOT"
echo "=== hunt coordinator e2e smoke ==="

# ------ build ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
docker build -f Dockerfile.coordinator -t "$IMAGE" . >/dev/null
docker network create "$NETWORK" >/dev/null

# ------ postgres ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
docker run -d \
  --name "$PG_CONTAINER" \
  --network "$NETWORK" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e POSTGRES_DB="$PG_DB" \
  postgres:16-alpine >/dev/null

PG_READY=0
for _ in $(seq 1 40); do
  if MSYS_NO_PATHCONV=1 docker exec "$PG_CONTAINER" \
      pg_isready -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    PG_READY=1; break
  fi
  sleep 1
done
[ "$PG_READY" -eq 1 ] || { echo "postgres did not become ready" >&2; exit 1; }

docker cp "$ROOT/schema/postgres_schema.sql" "$PG_CONTAINER:/tmp/postgres_schema.sql"
MSYS_NO_PATHCONV=1 docker exec \
  -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
  psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -f /tmp/postgres_schema.sql >/dev/null

# ------ coordinator ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
docker run -d \
  --name "$COORD_CONTAINER" \
  --network "$NETWORK" \
  -p "127.0.0.1:${COORD_PORT}:8003" \
  -e HUNT_DB_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_CONTAINER}:5432/${PG_DB}" \
  -e HUNT_SERVICE_TOKEN="$SERVICE_TOKEN" \
  -e HUNT_COORDINATOR_ROOT="/tmp/hunt-coordinator" \
  "$IMAGE" >/dev/null

COORD_READY=0
for _ in $(seq 1 20); do
  if curl -fsS -H "Authorization: Bearer ${SERVICE_TOKEN}" \
      "$BASE/status" >/dev/null 2>&1; then
    COORD_READY=1; break
  fi
  sleep 1
done
[ "$COORD_READY" -eq 1 ] || { echo "coordinator did not start" >&2; exit 1; }

# ------ create fake PDF inside coordinator container ---------------------------------------------------------------------------------------------
MSYS_NO_PATHCONV=1 docker exec "$COORD_CONTAINER" \
  bash -c 'mkdir -p /tmp/resumes && printf "%%PDF-1.4 e2e-smoke\n" > /tmp/resumes/test.pdf'

# ------ helper: insert job, return id ---------------------------------------------------------------------------------------------------------------------------------------
insert_job() {
    local suffix="$1"
    local output
    local status
    set +e
    output=$(MSYS_NO_PATHCONV=1 docker exec \
      -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
      psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -X -q -t -A -v ON_ERROR_STOP=1 -c "
        INSERT INTO jobs (
            title, company, location, job_url, apply_url, description,
            source, date_posted, is_remote, level, priority, category,
            apply_type, auto_apply_eligible, enrichment_status,
            enrichment_attempts, apply_host, ats_type,
            latest_resume_job_description_path, latest_resume_flags,
            selected_resume_version_id, selected_resume_pdf_path,
            selected_resume_tex_path, selected_resume_selected_at,
            selected_resume_ready_for_c3
        ) VALUES (
            'Test Engineer', 'Acme Corp', 'Canada',
            'https://linkedin.com/jobs/view/e2e-${suffix}',
            'https://acme.workday.com/job/e2e-${suffix}',
            'A good role.', 'linkedin', '2026-04-25',
            TRUE, 'junior', FALSE, 'engineering',
            'external_apply', TRUE, 'done',
            1, 'acme.workday.com', 'workday',
            '', '', 'resume-v${suffix}', '/tmp/resumes/test.pdf',
            '/app/main.tex', NULL, TRUE
        ) RETURNING id;
      " 2>&1)
    status=$?
    set -e
    if [ "$status" -ne 0 ]; then
        echo "$output" >&2
        return 1
    fi
    echo "$output" | tr -d '[:space:]'
}

pg_exec() {
    MSYS_NO_PATHCONV=1 docker exec \
      -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
      psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -X -q -v ON_ERROR_STOP=1 -c "$1" >/dev/null
}

# ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# Tests
# ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

echo
echo "--- auth ---"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/status")
check_eq "GET /status without token -> 401" "401" "$code"

echo
echo "--- status ---"
out=$(api "$BASE/status")
check_contains "GET /status service=c4-coordinator" '"service":"c4-coordinator"' "$out"
check_contains "GET /status has ready_count" '"ready_count"' "$out"
check_contains "GET /status has global_hold" '"global_hold"' "$out"

echo
echo "--- empty state ---"
out=$(api "$BASE/runs")
check_contains "GET /runs empty on fresh DB" '"runs":[]' "$out"

out=$(api "$BASE/c3/pending-fills")
check_contains "GET /c3/pending-fills empty on fresh DB" '"fills":[]' "$out"

code=$(api -o /dev/null -w "%{http_code}" "$BASE/runs/run-does-not-exist")
check_eq "GET /runs/unknown -> 404" "404" "$code"

echo
echo "--- start run (apply_prepared) ---"
if ! JOB1=$(insert_job 1); then
    echo "failed to insert job1" >&2
    exit 1
fi
[ -n "$JOB1" ] || { echo "failed to insert job1: empty id" >&2; exit 1; }

out=$(api -X POST -H "Content-Type: application/json" -d "{\"job_id\": ${JOB1}}" "$BASE/run")
RUN1=$(echo "$out" | json_field "['run_id']")
run_status=$(echo "$out" | json_field "['status']")
check_eq "POST /run -> apply_prepared" "apply_prepared" "$run_status"
[ -n "$RUN1" ] && ok "POST /run returns run_id" || fail "POST /run returns run_id" "empty"

echo
echo "--- duplicate run blocked ---"
code=$(api -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -d "{\"job_id\": ${JOB1}}" "$BASE/run")
check_eq "POST /run duplicate -> 400" "400" "$code"

echo
echo "--- unknown job blocked ---"
code=$(api -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -d '{"job_id": 999999}' "$BASE/run")
check_eq "POST /run unknown job -> 400" "400" "$code"

echo
echo "--- runs list ---"
out=$(api "$BASE/runs")
check_contains "GET /runs lists run" "$RUN1" "$out"

out=$(api "$BASE/runs/$RUN1")
check_contains "GET /runs/{id} returns status" '"status"' "$out"
check_contains "GET /runs/{id} status=apply_prepared" '"apply_prepared"' "$out"

echo
echo "--- c3 pending fills (apply_prepared -> not in fills) ---"
out=$(api "$BASE/c3/pending-fills")
check_contains "GET /c3/pending-fills empty for apply_prepared run" '"fills":[]' "$out"

echo
echo "--- c3 fill flow ---"
# Simulate request_fill by forcing status to fill_requested
pg_exec "UPDATE orchestration_runs SET status='fill_requested', updated_at=NOW() WHERE id='${RUN1}'"

out=$(api "$BASE/c3/pending-fills")
check_contains "GET /c3/pending-fills shows fill_requested run" "$RUN1" "$out"
check_contains "GET /c3/pending-fills has c3_payload" '"c3_payload"' "$out"

out=$(api -X POST -H "Content-Type: application/json" \
  -d "{\"run_id\": \"${RUN1}\", \"payload\": {\"status\": \"ok\", \"resumeUploadOk\": true, \"generatedAnswersUsed\": true, \"finalUrl\": \"https://acme.workday.com/job/e2e-1/thanks\"}}" \
  "$BASE/c3/fill-result")
fill_status=$(echo "$out" | json_field "['run']['status']")
check_eq "POST /c3/fill-result -> awaiting_submit_approval" "awaiting_submit_approval" "$fill_status"

out=$(api "$BASE/c3/pending-fills")
check_contains "GET /c3/pending-fills empty after fill result posted" '"fills":[]' "$out"

echo
echo "--- approve submit ---"
out=$(api -X POST -H "Content-Type: application/json" \
  -d '{"decision": "approve", "approved_by": "e2e", "reason": "looks good"}' \
  "$BASE/runs/$RUN1/approve")
approve_status=$(echo "$out" | json_field "['run']['status']")
check_eq "POST /approve approve -> submit_approved" "submit_approved" "$approve_status"

out=$(api "$BASE/runs/$RUN1")
check_contains "GET /runs/{id} after approve has submit_approved" '"submit_approved"' "$out"

echo
echo "--- deny submit (separate job) ---"
if ! JOB2=$(insert_job 2); then
    echo "failed to insert job2" >&2
    exit 1
fi
[ -n "$JOB2" ] || { echo "failed to insert job2: empty id" >&2; exit 1; }
out=$(api -X POST -H "Content-Type: application/json" -d "{\"job_id\": ${JOB2}}" "$BASE/run")
RUN2=$(echo "$out" | json_field "['run_id']")
check_eq "POST /run job2 -> apply_prepared" "apply_prepared" "$(echo "$out" | json_field "['status']")"

pg_exec "UPDATE orchestration_runs SET status='fill_requested', updated_at=NOW() WHERE id='${RUN2}'"

api -X POST -H "Content-Type: application/json" \
  -d "{\"run_id\": \"${RUN2}\", \"payload\": {\"status\": \"ok\", \"resumeUploadOk\": true}}" \
  "$BASE/c3/fill-result" >/dev/null

out=$(api -X POST -H "Content-Type: application/json" \
  -d '{"decision": "deny", "approved_by": "e2e", "reason": "wrong company"}' \
  "$BASE/runs/$RUN2/approve")
deny_status=$(echo "$out" | json_field "['run']['status']")
check_eq "POST /approve deny -> submit_denied" "submit_denied" "$deny_status"

echo
echo "--- error cases ---"
code=$(api -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -d '{"run_id": "run-does-not-exist", "payload": {"status": "ok"}}' "$BASE/c3/fill-result")
check_eq "POST /c3/fill-result unknown run -> 400" "400" "$code"

code=$(api -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -d '{"decision": "approve", "approved_by": "e2e", "reason": ""}' \
  "$BASE/runs/run-does-not-exist/approve")
check_eq "POST /approve unknown run -> 400" "400" "$code"

# ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "coordinator e2e smoke PASSED" && exit 0 \
                  || { echo "coordinator e2e smoke FAILED"; exit 1; }
