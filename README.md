# Hunt

Putting in the Work so it is less Work for you to apply for Work

Automated Hunt runtime. Today it includes **C0 (Frontend)**, **C1 (Hunter)** discovery/enrichment, **C2 (Fletcher)** resume generation, a local **C3 (Executioner)** browser extension, and **C4 (Coordinator)** orchestration scaffolding.

Current operator confidence snapshot (subjective, as of 2026-05-01):
- **C0**: mostly done
- **C1**: about 70% done
- **C2**: about 30% working
- **C3**: not meaningfully tested end to end yet
- **C4**: not really implemented end to end yet

The most solid path today is still **C0 + C1**. C2 exists in partial form. C3 and C4 both have code in the repo, but they should still be treated as unproven until live browser-backed runs are validated.

C0 note: the React SPA is the primary operator UI, but `/legacy/*` server-rendered routes still exist as fallback while we retire them.

Component rule: build each component so it can run and be tested on its own. Today that means **C0 (Frontend)** should remain usable through `backend/app.py` against the shared DB/artifacts even if other component runtimes are not running, and **C1/C2/C3** should keep direct terminal-driven workflows without requiring the UI. **C4 (Coordinator)** is the only intentionally coupled component: it depends on C1/C2/C3 contracts to do end-to-end orchestration, but the other components must not depend on C4 to do their own work.

**Names and folders:** see **`docs/NAMING.md`** (C1 code is the **`hunter`** package; **`hunter/scraper.py`** is the discovery script name only).

Current focus:
- keep C0 stable and documented accurately
- validate C1 (Hunter) on server2 against Postgres
- move C2 from partial pipeline to a usable operator workflow
- keep Easy Apply classified as `easy_apply` and excluded from downstream external-apply automation

## C1 (Hunter) v0.1 : how it runs

- **Discovery** : **JobSpy** fetches recent **LinkedIn** and **Indeed** listings for your search terms; rows land in the Hunt DB as **`pending`** enrichment when the board is supported. The DB uses Postgres when `HUNT_DB_URL` is set and SQLite as the local fallback. Indeed matching is loose; LinkedIn listing payloads are often thin until enrichment.
- **Enrichment** : **Playwright** (and related workers) process the queue **by `source`** (**LinkedIn first**, then **Indeed**), **in batches** per run, usually **headless**. **LinkedIn** needs **auth** (saved session and/or env credentials). **Easy Apply** is **detected and labeled** so later automation ignores it as an external apply target. Optional **headful** rerun for blocked rows when **`ENRICHMENT_UI_VERIFY_BLOCKED`** is enabled (often on **Xvfb** on servers).
- **Service API** : **`hunter/service.py`** exposes status, queue, scrape, enrich, and account reauth endpoints for C0.
- **Control plane** : **`backend/app.py`** serves the C0 dashboard plus filter, sort, search jobs, errors, artifacts, and gateway routes over the same DB.

**Component versions and future milestones:** **`docs/roadmap.md`**.

## Setup (Ubuntu)

```bash
git clone <repo> ~/hunt && cd ~/hunt
python3 -m venv venv && source venv/bin/activate
pip install -r hunter/requirements.txt
```

Edit `tools/legacy/hunt.service`: set `User=` to your server username, then:

```bash
sudo cp tools/legacy/hunt.service /etc/systemd/system/hunt.service
sudo systemctl daemon-reload
sudo systemctl enable hunt
sudo systemctl start hunt
```

Check logs: `sudo journalctl -u hunt -f`

The legacy systemd helper is still available, but current container smoke work uses the service Dockerfiles and `docker-compose.pipeline.yml`.

## Manual run

```bash
source venv/bin/activate
python hunter/scraper.py
python hunter/runner.py
```

## Config

Edit `hunter/config.py`:
- `SEARCH_TERMS` : what to search
- `HOURS_OLD` : how far back to look
- `RUN_INTERVAL_SECONDS` : time between runs
- `WATCHLIST` : companies you want to apply to manually
- `TITLE_BLACKLIST` : job titles to filter out

## Planning Docs

- **Component IDs and code names:** `docs/NAMING.md`
- System roadmap: `docs/roadmap.md`
- Shared glossary: `docs/GLOSSARY.md`
- Local Postgres/container smoke tests: `docs/LOCAL_POSTGRES_SMOKES.md`
- One-command local smoke runner: `python smoke.py`
- Component smokes: `python smoke.py c0`, `python smoke.py c1`, `python smoke.py c2`, `python smoke.py c4`
- Short test groups: `python test.py c0`, `python test.py c1`, `python test.py c2`, `python test.py c3`, `python test.py c4`
- Short quality checks: `python quality.py c0`, `python quality.py c1`, `python quality.py c2`, `python quality.py c3`, `python quality.py c4`
- Full CI entrypoints: `python ci.py` and `python ci.py c0|c1|c2|c3|c4|shared|frontend`
- Live fix tracker: `docs/TODO.md`

Quick test aliases:
- `python test.py all`: all repo Python tests
- `python test.py c0`: C0/backend and related UI-facing backend tests
- `python test.py c1`: C1/Hunter tests
- `python test.py c2`: C2/Fletcher tests
- `python test.py c3`: C3/Executioner-related tests
- `python test.py c4`: C4/Coordinator tests
- `python test.py shared`: DB/runtime/deploy-readiness shared tests

Quick quality aliases:
- `python quality.py all`: Python Ruff + frontend lint/typecheck + Prettier checks + C3 Prettier check
- `python quality.py c0`: backend Ruff + frontend lint/typecheck/Prettier
- `python quality.py c1`: Hunter Ruff checks
- `python quality.py c2`: Fletcher Ruff checks
- `python quality.py c3`: Executioner Prettier check
- `python quality.py c4`: Coordinator Ruff checks
- `python quality.py shared`: scripts/tests Ruff checks

Quick CI aliases:
- `python ci.py all`: full quality checks plus full Python test suite
- `python ci.py c0`: C0 checks plus C0 tests
- `python ci.py c1`: C1 checks plus C1 tests
- `python ci.py c2`: C2 checks plus C2 tests
- `python ci.py c3`: C3 checks plus C3 tests
- `python ci.py c4`: C4 checks plus C4 tests

Compatibility alias:
- `python check.py ...` still works, but `python quality.py ...` is now the preferred name.

## Definition Of Done

Before saying work is done:
- run the relevant verification command for the change you made
- prefer the smallest matching CI target first: `python ci.py c0`, `python ci.py c1`, `python ci.py c2`, `python ci.py c3`, `python ci.py c4`, `python ci.py shared`, or `python ci.py frontend`
- run `python ci.py` when the change crosses component boundaries or when you are unsure which component owns the impact
- do not claim success based only on reading code or on a dry-run command
- if a required verification command cannot be run, say exactly what was not run and why

For every feature or bug fix:
- add or update tests when the behavior can be checked automatically
- for bug fixes: add a regression test that fails before the fix and passes after it when feasible
- for new features: add tests that prove the intended behavior, not just happy-path wiring
- if automated coverage is not practical, say what manual validation is still required and why

Repo homes by component:
- `frontend/` + `backend/` : **C0 (Frontend)** UI and control-plane backend
- `hunter/` : **C1 (Hunter)** runtime package
- `fletcher/` : **C2 (Fletcher)** source and contracts
- `executioner/` : **C3 (Executioner)** source and fixtures
- `coordinator/` : **C4 (Coordinator)** source and contracts

Testing posture by component:
- `backend/app.py` / C0: browse and inspect DB-backed state without requiring live C1/C2/C3/C4 services
- C1/C2/C3: runnable from terminal without C0
- C4: depends on upstream/downstream component outputs by design

Current local checkpoint for later components:
- `fletcher/` : **C2 (Fletcher)** partial implementation only. Service and pipeline exist, but the operator workflow and generation quality work are still incomplete.
- `executioner/` : **C3 (Executioner)** local extension implementation exists, but it has not been meaningfully validated end to end through the live pipeline yet.
- `coordinator/` : **C4 (Coordinator)** scaffolding, service routes, and smoke-test pieces exist, but it should still be treated as early-stage orchestration code rather than a completed component.

## Legacy Helpers

Older one-off setup and run helpers now live under:
- `tools/legacy/run.bat`
- `tools/legacy/run.sh`
- `tools/legacy/run_scheduled.bat`
- `tools/legacy/setup.bat`
- `tools/legacy/hunt.service`

The preferred modern entrypoints are **C1 (Hunter)** scoped:
- `.\hunter.ps1` (Windows PowerShell)
- `hunter.cmd` (Windows cmd)
- `./hunter.sh` (POSIX)

**Legacy aliases:** `hunt.ps1`, `hunt.cmd`, `./hunt.sh`, and `python scripts/huntctl.py` forward to the same CLI.
