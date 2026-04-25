# Local Postgres Container Smokes

These scripts catch SQLite-to-Postgres compatibility bugs before deploying to server2.
Run them from the repo root with Docker available.

## Coordinator End-to-End

```bash
bash scripts/smoke_coordinator_e2e.sh
```

What it does:

- builds `Dockerfile.coordinator`
- starts disposable `postgres:16-alpine`
- applies `schema/postgres_schema.sql`
- starts the C4 Coordinator API with `HUNT_DB_URL`
- seeds ready C4 jobs directly into Postgres
- exercises the HTTP flow:
  - `GET /status`
  - `GET /runs`
  - `POST /run`
  - duplicate-run guard
  - unknown-job guard
  - `GET /c3/pending-fills`
  - `POST /c3/fill-result`
  - `POST /runs/{run_id}/approve` with approve and deny decisions
  - unknown-run error cases

Expected result:

```text
Results: 25 passed, 0 failed
coordinator e2e smoke PASSED
```

The script creates and removes its own Docker network and containers. Override names, port, image, or token with environment variables:

```bash
COORD_PORT=19013 SERVICE_TOKEN=local-token bash scripts/smoke_coordinator_e2e.sh
```

## Component Container Smokes

These check that individual service containers boot and can talk to Postgres:

```bash
bash scripts/smoke_hunter_container.sh
bash scripts/smoke_fletcher_container.sh
bash scripts/smoke_coordinator_container.sh
bash scripts/smoke_review_container.sh
```

Use the coordinator end-to-end smoke for C4 database transition coverage. Use the smaller component smokes when you only need startup and basic health coverage.

## Why This Exists

SQLite accepts several patterns that Postgres rejects or treats differently:

- Boolean columns should receive booleans, not inline `0` or `1` values in API paths.
- Failed Postgres statements abort the current transaction until rollback.
- SQLite `lastrowid` behavior needs compatibility handling for Postgres sequence-backed tables.
- Curl wrapper scripts must preserve JSON quoting. Avoid `eval` for API helpers.

When changing C4 run creation, C3 fill bridging, submit approval, or `hunter/db_compat.py`, run both:

```bash
PYTHONPATH=. .venv/Scripts/python.exe -m pytest tests/ -q
bash scripts/smoke_coordinator_e2e.sh
```
