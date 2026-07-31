# macOS Compatibility Notes

Audit date: 2026-07-03

## Status

Mostly compatible for the active C0-C2 Python services and shell launchers. C3
v3 has not been implemented or assessed for macOS.

This was audited from Ubuntu, so no native macOS browser automation was executed.

## What Was Checked

- Static scan of scripts, docs, and frontend package scripts.
- Linux audit results still apply to most Python/Docker paths:
  - Python compile passed.
  - Python dependency dry-run succeeded in a Python 3.12 container.
  - `docker-compose.pipeline.yml` rendered, but warned about `USERPROFILE`.

## What Should Work On macOS

- Python code after a venv and requirements install.
- Shell launchers:
  - `hunt.sh`
  - `hunter.sh`
  - `fletch.sh`
  - `ui.sh`
- Docker Compose pipeline, with local paths adjusted.
- Vite frontend build/typecheck once Node is installed.

## macOS Blockers

- `frontend/package.json` dev scripts call `powershell.exe`.
- C3 v3 browser compatibility remains a future implementation concern.
- Playwright browser installation and system dependency notes need macOS-specific instructions.
- Some docs present PowerShell as the primary path even when `.sh` wrappers exist.

## Likely Changes Needed

- Add macOS-friendly frontend scripts, for example:

```json
"dev:mac": "vite"
```

or replace PowerShell orchestration with a cross-platform Node/Python runner.

- Document macOS setup:

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r hunter/requirements.txt -r requirements-dev.txt
python -m playwright install chromium
```

- Define macOS C3 v3 support:
  - Chrome app path
  - remote debugging launch command
  - unpacked extension path
  - which PowerShell lane scripts are Windows-only

## Suggested macOS Smoke Path

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r hunter/requirements.txt -r requirements-dev.txt
python test.py c0 --dry-run
python quality.py frontend --dry-run
docker compose -f docker-compose.pipeline.yml config
```
