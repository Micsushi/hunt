# Linux Compatibility Notes

Audit date: 2026-07-03

## Status

Mostly compatible for Python services and Docker paths. The main Linux gaps are frontend dev scripts, C3/browser-control ergonomics, Playwright setup docs, and one Docker Compose default that assumes `USERPROFILE`.

## What Was Tested

Host:

- Python 3.12 is installed.
- `python3 -m compileall -q hunt` passed.
- Docker Compose is installed.
- Node/npm are not installed.
- `python3-venv` is not installed, so local venv creation failed on the host.

Disposable Python 3.12 Docker dependency probe:

```bash
python -m pip install --dry-run -r hunter/requirements.txt -r requirements-dev.txt
```

Result:

- Dependency resolution succeeded.

Compose config:

```bash
docker compose -f docker-compose.pipeline.yml config
```

Result:

- Config rendered successfully.
- Warning: `USERPROFILE` is unset on Ubuntu.

## What Should Work On Linux

- Python service code after creating a venv and installing requirements.
- Docker pipeline profiles.
- Postgres-backed services.
- Linux shell launchers under `scripts/launchers/*.sh`.

## Linux Blockers

- Host is missing `python3.12-venv`.
- Frontend package scripts call PowerShell:
  - `npm run dev`
  - `npm run dev:ui`
  - `npm run dev:c0`
  - `npm run dev:c1`
  - `npm run dev:c2`
- `docker-compose.pipeline.yml` defaults `HUNT_LEDGER_HOST_ROOT` through `${USERPROFILE}`.
- Playwright browser install and system dependencies are not documented clearly enough for Ubuntu.
- C3 browser lane docs and scripts are Windows-heavy.

## Likely Changes Needed

- Add Linux-native frontend scripts, for example:

```json
"dev:linux": "vite"
```

or replace the PowerShell orchestration with a Node/Python cross-platform dev runner.

- Change the ledger default to a POSIX-safe value, for example `${HOME}/.hunt/logs`, or document setting it in `.env`.
- Document Ubuntu setup:

```bash
sudo apt install python3.12-venv
python3 -m venv venv
source venv/bin/activate
pip install -r hunter/requirements.txt -r requirements-dev.txt
python -m playwright install --with-deps chromium
```

- Add a Linux note for C3: supported browser channel, extension loading path, and which PowerShell scripts are Windows-only.

## Suggested Ubuntu Smoke Path

```bash
python3 -m compileall -q .
python3 test.py c0 --dry-run
python3 quality.py frontend --dry-run
docker compose -f docker-compose.pipeline.yml config
```
