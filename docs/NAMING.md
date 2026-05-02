# Hunt: component IDs, code names, and code layout

Single source for resolving naming: **C1–C4**, **Hunter / Fletcher / Executioner / Coordinator**, code locations.

## Components (stable labels)

| ID | Code name | Role | Primary code in this repo | Container(s) |
|----|-----------|------|---------------------------|--------------|
| **C0** | **Frontend** | Operator dashboard and control plane — SPA UI plus FastAPI backend. Backend is the API gateway: all component API calls route through it. | **`frontend/`** + **`backend/`** | `hunt-frontend` (nginx + SPA) + `hunt-backend` (FastAPI) |
| **C1** | **Hunter** | Job discovery and multi-source enrichment. Exposes service API for backend to trigger scrapes and enrichment from the UI. | Python package **`hunter/`** (see below) | `hunt-hunter` |
| **C2** | **Fletcher** | Resume tailoring (LaTeX pipeline, PDF, DB attempts). Exposes service API for one-off generation triggered from the UI file drop. | **`fletcher/`** | `hunt-fletcher` |
| **C3** | **Executioner** | Browser autofill and apply assistance (Chrome extension). Runs on operator's local machine — not a server container. Polls backend for pipeline fill requests. | **`executioner/`** (Chrome extension sources) | local only — no server container |
| **C4** | **Coordinator** | Orchestration, readiness, apply-prep, submit control. Exposes submit approval API. | **`coordinator/`** | `hunt-coordinator` |

**C1 (Hunter)**: formerly “the scraper”. `scraper/` directory gone — code in `hunter` package.

## C1 (Hunter): `hunter` package vs `hunter/scraper.py`

- `hunter/` (`__init__.py`): Python package. Import: `from hunter.db import ...`.
- `hunter/scraper.py`: discovery entrypoint only (historical filename). Not a separate component.
- `hunter/runner.py`: continuous loop for unattended runs.
- Systemd units `hunt-scraper.service`/`hunt-scraper.timer`: legacy names — run C1 (`python hunter/scraper.py`). Renaming needs separate Ansible change.

## Quick map for operators

- Install C1 deps: `pip install -r hunter/requirements.txt`
- One-shot discovery (typical): `python hunter/scraper.py` (or **`./hunter.sh scrape`** from repo root)
- C1 apply/readiness helpers used by C4: `coordinator/` + `scripts/hunterctl.py` (legacy: `scripts/huntctl.py`)

## Docs convention

- First mention: **”C1 (Hunter)”**, then **C1** or **Hunter**. Same for C2/C3/C4.
- Never “the scraper package” for C1 — use `hunter` package or C1 (Hunter).

## `shared/`: cross-component utilities

`shared/` is a Python package at the repo root for code with no component-specific logic.

| Module | Contents |
|--------|----------|
| `shared/notifications.py` | Canonical Discord webhook util — `send_discord_webhook_message()`, `get_discord_webhook_url()`. Used by C1 and C4; C2/C3 can import when needed. |
| `shared/timestamps.py` | `utc_iso()` — ISO 8601 UTC timestamp, second precision. |

**Import pattern**: each component adds the repo root to `sys.path` before importing shared, so it works regardless of whether the code runs as a package or a standalone script:
```python
import sys
from pathlib import Path
_repo_root = Path(__file__).resolve().parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))
from shared.notifications import send_discord_webhook_message
```

**Rule**: `shared/` must not import from any component package (`hunter`, `coordinator`, `backend`, etc.).

## C4 (Coordinator): package vs tables vs env vars

- Package: `coordinator/` (import `from coordinator...`, run `python -m coordinator.cli`).
- Artifacts root: `HUNT_COORDINATOR_ROOT` (preferred); `HUNT_ORCHESTRATION_ROOT` backward-compatible alias.
- DB tables: `orchestration_runs`, `orchestration_events` etc. keep historical prefix — rename needs migration.

