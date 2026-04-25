#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${RUN_ID:-$$}"

IMAGE="${IMAGE:-hunt-hunter-local:smoke}"
NETWORK="${NETWORK:-hunt-hunter-smoke-${RUN_ID}}"
PG_CONTAINER="${PG_CONTAINER:-hunt-hunter-smoke-pg-${RUN_ID}}"
HUNTER_CONTAINER="${HUNTER_CONTAINER:-hunt-hunter-smoke-api-${RUN_ID}}"

PG_USER="${PG_USER:-hunt}"
PG_PASSWORD="${PG_PASSWORD:-hunt}"
PG_DB="${PG_DB:-hunt}"
HUNTER_PORT="${HUNTER_PORT:-18001}"
SERVICE_TOKEN="${SERVICE_TOKEN:-hunt-local-smoke-token}"

cleanup() {
  docker rm -f "$HUNTER_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}

dump_logs() {
  echo
  echo "=== hunter logs ==="
  docker logs --tail 160 "$HUNTER_CONTAINER" 2>/dev/null || true
  echo
  echo "=== postgres logs ==="
  docker logs --tail 80 "$PG_CONTAINER" 2>/dev/null || true
}

trap cleanup EXIT
trap dump_logs ERR

cd "$ROOT"

docker build -f Dockerfile.hunter -t "$IMAGE" .
docker network create "$NETWORK" >/dev/null

docker run -d \
  --name "$PG_CONTAINER" \
  --network "$NETWORK" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e POSTGRES_DB="$PG_DB" \
  postgres:16-alpine >/dev/null

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
  --name "$HUNTER_CONTAINER" \
  --network "$NETWORK" \
  -p "127.0.0.1:${HUNTER_PORT}:8001" \
  -e HUNT_DB_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_CONTAINER}:5432/${PG_DB}" \
  -e HUNT_SERVICE_TOKEN="$SERVICE_TOKEN" \
  -e HUNT_DATA_DIR="/tmp/hunt-data" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS \
    -H "Authorization: Bearer ${SERVICE_TOKEN}" \
    "http://127.0.0.1:${HUNTER_PORT}/status" >/tmp/hunt-hunter-status.json; then
    cat /tmp/hunt-hunter-status.json
    echo
    if ! grep -q '"service":"c1-hunter"' /tmp/hunt-hunter-status.json; then
      echo "hunter status did not identify c1-hunter" >&2
      exit 1
    fi
    curl -fsS \
      -H "Authorization: Bearer ${SERVICE_TOKEN}" \
      "http://127.0.0.1:${HUNTER_PORT}/queue" >/tmp/hunt-hunter-queue.json
    if ! grep -q '"pending":' /tmp/hunt-hunter-queue.json; then
      echo "hunter /queue response missing pending key" >&2
      cat /tmp/hunt-hunter-queue.json >&2
      exit 1
    fi
    echo "hunter container smoke passed"
    exit 0
  fi
  sleep 1
done

curl -fsS \
  -H "Authorization: Bearer ${SERVICE_TOKEN}" \
  "http://127.0.0.1:${HUNTER_PORT}/status"
