#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${RUN_ID:-$$}"

IMAGE="${IMAGE:-hunt-review-local:smoke}"
NETWORK="${NETWORK:-hunt-local-deploy-${RUN_ID}}"
PG_CONTAINER="${PG_CONTAINER:-hunt-local-deploy-pg-${RUN_ID}}"
REVIEW_CONTAINER="${REVIEW_CONTAINER:-hunt-local-deploy-review-${RUN_ID}}"

PG_USER="${PG_USER:-hunt}"
PG_PASSWORD="${PG_PASSWORD:-hunt}"
PG_DB="${PG_DB:-hunt}"
REVIEW_PORT="${REVIEW_PORT:-18000}"
SERVICE_TOKEN="${SERVICE_TOKEN:-hunt-local-smoke-token}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-hunt-local-admin}"

cleanup() {
  docker rm -f "$REVIEW_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}

dump_logs() {
  echo
  echo "=== review logs ==="
  docker logs --tail 160 "$REVIEW_CONTAINER" 2>/dev/null || true
  echo
  echo "=== postgres logs ==="
  docker logs --tail 80 "$PG_CONTAINER" 2>/dev/null || true
}

trap cleanup EXIT
trap dump_logs ERR

cd "$ROOT"

docker build -f Dockerfile.review -t "$IMAGE" .
docker network create "$NETWORK" >/dev/null

docker run -d \
  --name "$PG_CONTAINER" \
  --network "$NETWORK" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e POSTGRES_DB="$PG_DB" \
  postgres:16-alpine >/dev/null

for _ in $(seq 1 20); do
  if docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null

docker cp "$ROOT/schema/postgres_schema.sql" "$PG_CONTAINER:/tmp/postgres_schema.sql"
docker exec \
  -e PGPASSWORD="$PG_PASSWORD" \
  "$PG_CONTAINER" \
  psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" -f /tmp/postgres_schema.sql >/dev/null

docker run -d \
  --name "$REVIEW_CONTAINER" \
  --network "$NETWORK" \
  -p "127.0.0.1:${REVIEW_PORT}:8000" \
  -e HUNT_DB_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_CONTAINER}:5432/${PG_DB}" \
  -e HUNT_SERVICE_TOKEN="$SERVICE_TOKEN" \
  -e HUNT_ADMIN_USERNAME="admin" \
  -e HUNT_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -e HUNT_HUNTER_URL="http://127.0.0.1:8001" \
  -e HUNT_FLETCHER_URL="http://127.0.0.1:8002" \
  -e HUNT_COORDINATOR_URL="http://127.0.0.1:8003" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${REVIEW_PORT}/health" >/tmp/hunt-review-health.json; then
    cat /tmp/hunt-review-health.json
    echo
    echo "review container smoke passed"
    exit 0
  fi
  sleep 1
done

curl -fsS "http://127.0.0.1:${REVIEW_PORT}/health"
