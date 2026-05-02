# Hunt : Local Postgres Smokes

Purpose: quick end-to-end checks for the local container stack that uses `docker-compose.pipeline.yml`.

## Scope

This runbook covers:

- `scripts/smoke_pipeline_compose.sh`: full pipeline compose smoke.
- `scripts/smoke_c0_pipeline_container.sh`: C0 gateway/operator smoke.
- `scripts/smoke_coordinator_e2e.sh`: C4 orchestration smoke with Postgres.

## Prerequisites

- Docker Desktop or Docker Engine running.
- Repo root as current working directory.

For the default (fresh-stack) mode, local ports `18080`, `18001`, `18002`, `18003`, and `15432` must be free. If the stack is already running on those ports, use `--existing` instead.

## Commands

### Local smoke — stack already running

When `docker compose up` is already active (normal dev), skip container startup and check the running stack directly:

```bash
python smoke.py --existing
```

This is the default workflow during development.

### Local smoke — fresh stack (CI / clean environment)

Spin up isolated containers, verify, then tear them down:

```bash
python smoke.py
```

Fails if the ports are already occupied. Use `--existing` in that case.

### Server2 smoke

Check the live production stack at `agent-hunt-review.mshi.ca`:

```bash
python smoke.py server2
```

Requires credentials in `.env.server2-smoke` at the repo root (gitignored):

```
HUNT_ADMIN_PASSWORD=...
HUNT_SERVICE_TOKEN=...
```

`python smoke.py server2` now runs both:

- `scripts/smoke_server2.sh`: C0 and public surface checks
- `scripts/smoke_server2_c1.sh`: live C1 scrape and enrich cycle through C0, then idle-state validation

If you only want the C1 production check:

```bash
python smoke.py server2-c1
```

### Dry-run (print commands without starting anything)

```bash
python smoke.py --dry-run
python smoke.py --dry-run --existing
```

### Short component commands

Use the same command shape on Windows and Linux:

```bash
python smoke.py c0
python smoke.py c1
python smoke.py c2
python smoke.py c4
```

Targets:

- `python smoke.py all`: full local smoke suite (default)
- `python smoke.py c0`: C0 gateway/operator smoke using the compose pipeline stack
- `python smoke.py c1`: C1 Hunter container smoke
- `python smoke.py c2`: C2 Fletcher container smoke
- `python smoke.py c4`: C4 Coordinator end-to-end smoke
- `python smoke.py c4-container`: C4 Coordinator container boot smoke only
- `python smoke.py review`: review image smoke
- `python smoke.py server2`: server2 production smoke
- `python smoke.py server2-c0`: server2 C0/public smoke only
- `python smoke.py server2-c1`: server2 C1 scrape/enrich smoke only

Aliases:

- `python smoke.py full`: same as `python smoke.py all`
- `python smoke.py hunter`: same as `python smoke.py c1`
- `python smoke.py fletcher`: same as `python smoke.py c2`
- `python smoke.py coordinator`: same as `python smoke.py c4`

Current gap:

- `python smoke.py c3` does not exist yet because there is no cross-platform C3 smoke script in the repo today.

Windows note:

- Recommended short command on both Windows and Linux: `python smoke.py --existing`
- `python scripts/run_local_smoke.py` works on Windows when `bash` is available through Git Bash or `wsl`
- `python scripts/run_local_smoke.py --dry-run` prints the exact commands without starting containers

## Expected results

- `python smoke.py all`: prints `[local-smoke] smoke target `all` passed`.
- `python smoke.py c1`: prints `hunter container smoke passed`.
- `python smoke.py c2`: prints `fletcher container smoke passed`.
- `python smoke.py c4`: prints `coordinator e2e smoke PASSED`.
- `smoke_pipeline_compose.sh`: prints `pipeline compose smoke passed`.
- `smoke_c0_pipeline_container.sh`: prints `C0 pipeline smoke PASSED`.
- `smoke_coordinator_e2e.sh`: prints `coordinator e2e smoke PASSED`.

Any non-zero exit or `FAILED` output means the smoke did not pass.

## Cleanup note

Each script tears down its own containers on exit. If you need manual cleanup:

```bash
docker compose -f docker-compose.pipeline.yml down -v --remove-orphans
```
