#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${RUN_ID:-$$}"

IMAGE="${IMAGE:-hunt-coordinator-local:smoke}"
NETWORK="${NETWORK:-hunt-coordinator-smoke-${RUN_ID}}"
PG_CONTAINER="${PG_CONTAINER:-hunt-coordinator-smoke-pg-${RUN_ID}}"
COORDINATOR_CONTAINER="${COORDINATOR_CONTAINER:-hunt-coordinator-smoke-api-${RUN_ID}}"

PG_USER="${PG_USER:-hunt}"
PG_PASSWORD="${PG_PASSWORD:-hunt}"
PG_DB="${PG_DB:-hunt}"
COORDINATOR_PORT="${COORDINATOR_PORT:-18003}"
SERVICE_TOKEN="${SERVICE_TOKEN:-hunt-local-smoke-token}"

cleanup() {
  docker rm -f "$COORDINATOR_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}

dump_logs() {
  echo
  echo "=== coordinator logs ==="
  docker logs --tail 160 "$COORDINATOR_CONTAINER" 2>/dev/null || true
  echo
  echo "=== postgres logs ==="
  docker logs --tail 80 "$PG_CONTAINER" 2>/dev/null || true
}

trap cleanup EXIT
trap dump_logs ERR

cd "$ROOT"

docker build -f Dockerfile.coordinator -t "$IMAGE" .
docker network create "$NETWORK" >/dev/null

docker run -d \
  --name "$PG_CONTAINER" \
  --network "$NETWORK" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e POSTGRES_DB="$PG_DB" \
  postgres:16-alpine >/dev/null

# Wait for postgres to finish init cycle (it restarts once after creating the hunt DB)
# Use a generous retry loop to survive the brief downtime during the restart.
PG_READY=0
for _ in $(seq 1 40); do
  if docker exec "$PG_CONTAINER" pg_isready -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    PG_READY=1
    break
  fi
  sleep 1
done
[ "$PG_READY" -eq 1 ] || { echo "postgres did not become ready in time" >&2; exit 1; }

docker cp "$ROOT/schema/postgres_schema.sql" "$PG_CONTAINER:/tmp/postgres_schema.sql"
MSYS_NO_PATHCONV=1 docker exec \
  -e PGPASSWORD="$PG_PASSWORD" \
  "$PG_CONTAINER" \
  psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -f /tmp/postgres_schema.sql >/dev/null

docker run -d \
  --name "$COORDINATOR_CONTAINER" \
  --network "$NETWORK" \
  -p "127.0.0.1:${COORDINATOR_PORT}:8003" \
  -e HUNT_DB_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_CONTAINER}:5432/${PG_DB}" \
  -e HUNT_SERVICE_TOKEN="$SERVICE_TOKEN" \
  -e HUNT_COORDINATOR_ROOT="/tmp/hunt-coordinator" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 20); do
  if curl -fsS \
    -H "Authorization: Bearer ${SERVICE_TOKEN}" \
    "http://127.0.0.1:${COORDINATOR_PORT}/status" >/tmp/hunt-coordinator-status.json; then
    cat /tmp/hunt-coordinator-status.json
    echo
    if ! grep -q '"service":"c4-coordinator"' /tmp/hunt-coordinator-status.json; then
      echo "coordinator status did not identify c4-coordinator" >&2
      exit 1
    fi
    curl -fsS \
      -H "Authorization: Bearer ${SERVICE_TOKEN}" \
      "http://127.0.0.1:${COORDINATOR_PORT}/runs" >/tmp/hunt-coordinator-runs.json
    if ! grep -q '"runs":' /tmp/hunt-coordinator-runs.json; then
      echo "coordinator /runs response missing runs key" >&2
      cat /tmp/hunt-coordinator-runs.json >&2
      exit 1
    fi
    echo "coordinator container smoke passed"
    exit 0
  fi
  sleep 1
done

curl -fsS \
  -H "Authorization: Bearer ${SERVICE_TOKEN}" \
  "http://127.0.0.1:${COORDINATOR_PORT}/status"
