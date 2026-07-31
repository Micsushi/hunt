# Linux Compatibility Notes

Audit date: 2026-07-03

## Status

Mostly compatible for the active C0-C2 Python services and Docker paths. C3 v3
has not been implemented or assessed for Linux.

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
- Playwright browser install and system dependencies are not documented clearly enough for Ubuntu.
- C3 v3 browser compatibility remains a future implementation concern.

## Likely Changes Needed

- Add Linux-native frontend scripts, for example:

```json
"dev:linux": "vite"
```

or replace the PowerShell orchestration with a Node/Python cross-platform dev runner.

- Document Ubuntu setup:

```bash
sudo apt install python3.12-venv
python3 -m venv venv
source venv/bin/activate
pip install -r hunter/requirements.txt -r requirements-dev.txt
python -m playwright install --with-deps chromium
```

- Define C3 v3 Linux browser support during its implementation stages.

## Suggested Ubuntu Smoke Path

```bash
python3 -m compileall -q .
python3 test.py c0 --dry-run
python3 quality.py frontend --dry-run
docker compose -f docker-compose.pipeline.yml config
```
