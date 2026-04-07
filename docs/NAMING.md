# Hunt: component IDs, code names, and code layout

This file is the **single place** to resolve naming: **C1–C4**, **Hunter / Trapper / Executioner / Coordinator**, and **where code lives in this repo**.

## Four components (same system, stable labels)

| ID | Code name | Role | Primary code in this repo |
|----|-----------|------|---------------------------|
| **C1** | **Hunter** | Job discovery and multi-source enrichment (SQLite, review app, C1 logging) | Python package **`hunter/`** (see below) |
| **C2** | **Trapper** | Resume tailoring (LaTeX pipeline, PDF, DB attempts) | **`trapper/`** |
| **C3** | **Executioner** | Browser autofill and apply assistance (extension) | **`executioner/`** (Chrome extension sources) |
| **C4** | **Coordinator** | Orchestration, readiness, apply-prep, submit control | **`coordinator/`** |

**C1 (Hunter)** is what used to be described as “the scraper” in older docs. The **directory `scraper/` is gone**: runtime code now lives under the **`hunter`** package.

## C1 (Hunter): `hunter` package vs `hunter/scraper.py`

- **`hunter/`** (with `__init__.py`) is the **Python package name** for C1 (Hunter). Import like: `from hunter.db import ...`.
- **`hunter/scraper.py`** is only the **discovery entrypoint script** (historical filename: “scraper”). It is **not** a separate component and **not** the old `scraper` package.
- **`hunter/runner.py`** loops and calls into the discovery/enrichment flow for unattended runs.
- Systemd units **`hunt-scraper.service`** / **`hunt-scraper.timer`** are **legacy unit names** on the server; they run **C1 (Hunter)** (`python hunter/scraper.py` from the Hunt repo root). Renaming those units would be a separate Ansible change.

## Quick map for operators

- Install C1 deps: `pip install -r hunter/requirements.txt`
- One-shot discovery (typical): `python hunter/scraper.py` (or **`./hunt.sh scrape`** from repo root)
- C1 apply/readiness helpers used by C4: `coordinator/` + `scripts/huntctl.py`
- **CLI conventions** ( **`hunt` / `hunter`**, adding future C2–C4 subcommands): **`docs/CLI_CONVENTIONS.md`**

## Docs convention

- Prefer **“C1 (Hunter)”** on first mention in a doc, then **C1** or **Hunter** where clear.
- Same for **C2 (Trapper)**, **C3 (Executioner)**, **C4 (Coordinator)**.
- Avoid saying “the scraper package” for C1; say **`hunter` package** or **C1 (Hunter)**.
- Older prose used **“Component N”**; repo docs and user-facing strings now use **“CN (code name)”** consistently (folder names like `docs/components/component1/` stay as stable paths).

## C4 (Coordinator) : package vs SQLite tables vs env vars

- The Python package directory is **`coordinator/`** (import `from coordinator...`, run `python -m coordinator.cli ...`).
- **Runtime filesystem root** for C4 artifacts: set **`HUNT_COORDINATOR_ROOT`** (preferred). **`HUNT_ORCHESTRATION_ROOT`** is accepted as a backward-compatible alias (same resolution order in code).
- SQLite tables are still named **`orchestration_runs`**, **`orchestration_events`**, etc. Renaming those would require a DB migration; they keep the historical **orchestration** prefix.

See also: `docs/VERSIONS.md`, `README.md`, and per-component folders under `docs/components/`.
