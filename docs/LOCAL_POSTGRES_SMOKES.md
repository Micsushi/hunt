# Hunt : Local Postgres Smokes

Purpose: quick end-to-end checks for the local container stack that uses `docker-compose.pipeline.yml`.

## Scope

This runbook covers:

- `scripts/smoke_pipeline_compose.sh`: full pipeline compose smoke.
- `scripts/smoke_c0_pipeline_container.sh`: C0 gateway/operator smoke.
- `scripts/smoke_coordinator_e2e.sh`: C4 orchestration smoke with Postgres.

## Prerequisites

- Docker Desktop or Docker Engine running.
- Local ports `18080`, `18001`, `18002`, `18003`, and `5432` available.
- Repo root as current working directory.

## Commands

### One-command full local smoke

Run the whole local smoke suite with one command:

```bash
python smoke.py
```

Equivalent longer form:

```bash
python scripts/run_local_smoke.py
```

What it does:

- runs `scripts/smoke_pipeline_compose.sh`
- runs `scripts/smoke_c0_pipeline_container.sh`
- runs `scripts/smoke_coordinator_e2e.sh`
- stops on the first failure and returns that exit code

### Short component commands

Use the same command shape on Windows and Linux:

```bash
python smoke.py c0
python smoke.py c1
python smoke.py c2
python smoke.py c4
```

Targets:

- `python smoke.py all`: full local smoke suite
- `python smoke.py c0`: C0 gateway/operator smoke using the compose pipeline stack
- `python smoke.py c1`: C1 Hunter container smoke
- `python smoke.py c2`: C2 Fletcher container smoke
- `python smoke.py c4`: C4 Coordinator end-to-end smoke
- `python smoke.py c4-container`: C4 Coordinator container boot smoke only
- `python smoke.py review`: review image smoke

Aliases:

- `python smoke.py full`: same as `python smoke.py all`
- `python smoke.py hunter`: same as `python smoke.py c1`
- `python smoke.py fletcher`: same as `python smoke.py c2`
- `python smoke.py coordinator`: same as `python smoke.py c4`

Current gap:

- `python smoke.py c3` does not exist yet because there is no cross-platform C3 smoke script in the repo today.

Windows note:

- Recommended short command on both Windows and Linux: `python smoke.py`
- `python scripts/run_local_smoke.py` works on Windows when `bash` is available through Git Bash or `wsl`
- `python scripts/run_local_smoke.py --dry-run` prints the exact commands without starting containers
- `python smoke.py c1 --dry-run` and similar target-specific dry-runs also work

### Linux

```bash
python smoke.py
```

### Windows (PowerShell with WSL)

```powershell
python smoke.py
```

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
