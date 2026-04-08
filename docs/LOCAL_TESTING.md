# Local Testing Guide (C1 Hunter + Review Webapp)

This guide explains how to run **C1 (Hunter)** discovery + enrichment (Python package **`hunter/`**, script **`hunter/scraper.py`**) and the **review webapp** locally. Naming reference: **`docs/NAMING.md`**. End-to-end operator picture (cadence, queues, headful fallback) : **`docs/C1_OPERATOR_WORKFLOW.md`**. **`hunt` / `hunter` CLI** conventions : **`docs/CLI_CONVENTIONS.md`**.

## Goals

- Run discovery against job boards and write to a local SQLite DB.
- Run the review webapp locally and confirm it reads the same DB.
- Verify C1 operational events show up in the webapp summary:
  - priority job notification event
  - LinkedIn rate-limit cooldown event
  - LinkedIn automation-detected cooldown event
- Optionally: run enrichment locally (LinkedIn/Indeed), understanding LinkedIn requires Playwright + an authenticated session.

## 0. Prereqs

- Python 3.11+ recommended.
- If you will run LinkedIn enrichment:
  - Playwright Python package must be installed (via requirements)
  - Browser binaries must be installed:
    - `python -m playwright install chromium`

## 1. Choose a local runtime directory

Pick a folder where your local DB and artifacts will live. Example:

- Windows: `C:\\temp\\hunt_runtime`
- Linux/macOS: `~/tmp/hunt_runtime`

You will set:
- `HUNT_DB_PATH`: path to the SQLite DB file
- `HUNT_ARTIFACTS_DIR`: root for failure artifacts (screenshots/html/text)

## 2. Create a virtualenv and install dependencies

From the repo root (`hunt/`):

```bash
python -m venv .venv
```

Activate:

- Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
```

- Linux/macOS:

```bash
source .venv/bin/activate
```

Install deps (C1 requirements live under `hunter/`):

```bash
pip install -r hunter/requirements.txt
```

If you will run LinkedIn enrichment:

```bash
python -m playwright install chromium
```

## 3. Run the review webapp locally

In one terminal, set env vars (examples below) and start the webapp:

- Windows PowerShell:

```powershell
$env:HUNT_DB_PATH="C:\temp\hunt_runtime\hunt.db"
$env:HUNT_ARTIFACTS_DIR="C:\temp\hunt_runtime\artifacts"
$env:REVIEW_APP_HOST="127.0.0.1"
$env:REVIEW_APP_PORT="8000"
$env:REVIEW_APP_PUBLIC_URL="http://127.0.0.1:8000"
python review_app.py
```

- Linux/macOS:

```bash
export HUNT_DB_PATH="$HOME/tmp/hunt_runtime/hunt.db"
export HUNT_ARTIFACTS_DIR="$HOME/tmp/hunt_runtime/artifacts"
export REVIEW_APP_HOST="127.0.0.1"
export REVIEW_APP_PORT="8000"
export REVIEW_APP_PUBLIC_URL="http://127.0.0.1:8000"
python review_app.py
```

Open:
- `http://127.0.0.1:8000/summary`
- `http://127.0.0.1:8000/api/summary`

## 4. Run discovery locally (C1: Hunter)

In a second terminal (same env vars), run discovery:

```bash
python hunter/scraper.py --skip-enrichment
```

You should then see rows appear in the webapp (`/jobs`) and queue totals update (`/summary`).

## 5. Validate Discord + event plumbing (without waiting for real failures)

### 5.1 Discord: configure webhook and test

Set one of these env vars:
- `HUNT_DISCORD_WEBHOOK_URL` (preferred)
- `DISCORD_WEBHOOK_URL` (legacy fallback)

Then run:

```bash
python hunter/linkedin_session.py --test-discord-webhook --discord-message "Hunt local test: Discord webhook ok."
```

### 5.2 Webapp-visible C1 events

C1 emits structured JSON events into runtime state. The review webapp surfaces the **latest** events on `/summary` under the LinkedIn auth panel.

The keys currently used include:
- `hunt_last_priority_job`
- `linkedin_last_rate_limited`
- `linkedin_last_automation_flagged`

To simulate an event locally (no LinkedIn required):

```bash
python -c "from hunter.c1_logging import C1Logger; C1Logger(discord=False).event(key='linkedin_last_rate_limited', level='warn', message='Simulated rate limit', code='rate_limited', details={'account_index':0,'blocked_days':1})"
```

Refresh `http://127.0.0.1:8000/summary` and confirm the “Last rate limit” row updates.

#### PowerShell-friendly (recommended on Windows)

PowerShell quoting can easily cause `SyntaxError` when using `python -c`. Use the dev helper instead:

```powershell
python hunter/devtools/emit_event.py --key linkedin_last_rate_limited --level warn --message "Simulated rate limit" --code rate_limited --details-json "{\"account_index\":0,\"blocked_days\":1}"
python hunter/devtools/emit_event.py --key linkedin_last_automation_flagged --level error --message "Simulated automation detected" --code automation_detected --details-json "{\"account_index\":0,\"blocked_days\":7}"
```

## 6. Optional: run enrichment locally

### Indeed

```bash
python hunter/enrich_indeed.py --limit 10
```

### LinkedIn (requires auth state)

1) Save storage state (interactive login):

```bash
python hunter/linkedin_session.py --save-storage-state --channel chrome
```

2) Enrich a small batch:

```bash
python hunter/enrich_linkedin.py --limit 5 --channel chrome
```

If LinkedIn auth is expired, the system can pause the LinkedIn lane and the webapp `/summary` should show “LinkedIn auth paused”.

## 7. Requeue by error code (auth_expired / rate_limited)

This is useful when those failures are considered “not real failures” and you want to retry them cleanly.

```bash
python scripts/requeue_enrichment_rows.py --source all --error-code auth_expired --error-code rate_limited
```

Or via the wrapper:

```bash
python scripts/hunterctl.py requeue-errors --source all --error-code auth_expired --error-code rate_limited
```

### 7.1 Seed rows to test requeue manually

If you want to test requeue end-to-end without waiting for real failures:

```powershell
python hunter/devtools/seed_requeue_rows.py --source linkedin
python scripts/hunterctl.py requeue-errors --source all --error-code auth_expired --error-code rate_limited
```

## 8. Unit tests and Ruff (C1 vs full suite; lint; format)

From the **repo root** (`hunt/`). Use the same venv where you installed Hunter deps. **Ruff** is listed in `requirements-dev.txt`:

```bash
pip install -r requirements-dev.txt
```

### Test output: dots mixed with logs (expected)

Many tests exercise **C1 (Hunter)** code (scrape, enrich, batch, Playwright-related paths). That code **prints or logs to stdout/stderr**, so you will see lines like `[enrich] Claimed LinkedIn job`, `browser_unavailable`, or `A browser window opened for LinkedIn login` **between** unittest’s progress dots. That is normal.

**Success** is the summary at the end:

```text
Ran 93 tests in …

OK
```

Messages in the middle are usually from **tests invoking real modules with mocks**; they do not mean a browser actually opened on your machine unless you ran an interactive flow outside the test suite.

### Quieter unittest runs

Append **`-q`** (same as **`--quiet`**) to hide per-test dots and reduce noise; failures and errors still print.

```bash
python -m unittest discover -s tests -p "test_stage*.py" -q
python -m unittest discover -s tests -p "test*.py" -q
```

### C1 (Hunter) unit tests only

These are the `test_stage*.py` files under `tests/` (discovery, DB, enrichment plumbing for **`hunter/`**).

**bash / PowerShell:**

```bash
python -m unittest discover -s tests -p "test_stage*.py"
```

### All unit tests (C1 + C2 + C3 + C4)

```bash
python -m unittest discover -s tests -p "test*.py"
```

### C2 / C3 / C4 only (optional)

```bash
python -m unittest discover -s tests -p "test_component2_*.py"
python -m unittest discover -s tests -p "test_component3_*.py"
python -m unittest discover -s tests -p "test_component4_*.py"
```

### Ruff: lint (read-only)

```bash
ruff check .
```

### Ruff: auto-fix lint (import order, safe fixes)

```bash
ruff check . --fix
```

### Ruff: format (code style)

```bash
ruff format .
```

### One shot: fix lint then format

**bash:**

```bash
ruff check . --fix && ruff format .
```

**Windows PowerShell 5.1** (no `&&`): run on two lines, or:

```powershell
ruff check . --fix; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ruff format .
```

**PowerShell 7+:**

```powershell
ruff check . --fix && ruff format .
```

### Optional: byte-compile main packages (fast sanity check)

```bash
python -m compileall -q coordinator fletcher hunter scripts review_app.py
```

## 9. Quick local verification checklist

- Webapp loads: `/summary` and `/jobs` render.
- Webapp reads your chosen DB: `/api/summary` changes after `hunter/scraper.py --skip-enrichment`.
- Discord test message succeeds (if configured).
- Simulated event shows up on `/summary`.

