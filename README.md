# Hunt

Putting in the Work so it is less Work for you to apply for Work

Automated Hunt runtime. Today it includes **C0 (Frontend)**, **C1 (Hunter)** discovery/enrichment, **C2 (Fletcher)** resume generation, a local **C3 (Executioner)** browser extension, and **C4 (Coordinator)** orchestration scaffolding.

Current operator confidence snapshot (subjective, as of 2026-05-08):
- **C0**: mostly done
- **C1 / Hunter**: about 95% done
- **C2 / Fletcher**: about 80% done
- **C3**: standalone extension lane exists, but not meaningfully live-proven yet
- **C4**: coordinator state machine, API, CLI, worker lease protocol, stale recovery, and OpenClaw/Hermes one-shot launcher exist; live browser/agent execution is not proven yet

The most solid path today is **C0 + C1**, with Hunter now mostly down to live Easy Apply proof. C2 has grown into a strong operator workflow: Option B pasted-JD queue/history, Option A job-linked master-resume generation, persistent artifacts, PDF/TeX upload and export, full review workspace, manual edits, segment revert, compile, progress recovery, keyword inspection, logs, and multi-provider LLM configuration. C3 now has a standalone extension lane for extension-local profile/resume fill plus a route vocabulary for generic, ATS-specific, DB-backed, and C4-backed fills. C4 has a real DB-backed orchestration scaffold plus a worker lease/heartbeat/result protocol, but C3/OpenClaw/Hermes browser-backed runs are still the main unproven gap before long-running job-application agents can be trusted.

C0 note: the React SPA is the primary operator UI, but `/legacy/*` server-rendered routes still exist as fallback while we retire them.

Component rule: build each component so it can run and be tested on its own. Today that means **C0 (Frontend)** should remain usable through `backend/app.py` against the shared DB/artifacts even if other component runtimes are not running, and **C1/C2/C3** should keep direct terminal-driven workflows without requiring the UI. **C4 (Coordinator)** is the only intentionally coupled component: it depends on C1/C2/C3 contracts to do end-to-end orchestration, but the other components must not depend on C4 to do their own work.

**Names and folders:** see **`docs/NAMING.md`** (C1 code is the **`hunter`** package; **`hunter/scraper.py`** is the discovery script name only).

Current focus:
- keep C0 stable and documented accurately
- finish C1's last live proof: verify Easy Apply filtering on a real matching row
- validate C2's Option A/Option B workflows against real server2 jobs and keep improving generation quality
- prove C3 `filler` on safe ordinary pages before trusting live job pages
- harden C4 as the durable state machine for long-running Windows/WSL2/Linux job-application agents
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

## Quick commands

**C1 (Hunter) CLI:** see `docs/HUNTER_CLI.md` for scrape, enrich, drain, queue, auth, config, and all other Hunter CLI commands. Config values can also be edited via the **Settings** page in the web UI.

**Start the local UI (C0)**
```
hunter ui serve            # serve the review app at http://localhost:8000
```

**Deploy (Docker, server2)**
```
python deploy.py all
python deploy.py all --mode server --env-file .env.server2
```

**Tests and CI**
```
python ci.py c1            # C1 checks + tests
python ci.py               # full repo CI
python test.py c1          # C1 tests only
python smoke.py c1         # C1 smoke tests
```

## Config

User-tunable settings live in `hunt_user_config.json` at the repo root (gitignored).
Copy `hunt_user_config.example.json` to get started:

```bash
cp hunt_user_config.example.json hunt_user_config.json
# then edit it, or use: hunter config-set <key> <value>
# or use the Settings page in the web UI (requires C1 service running)
```

**Configurable values:**
- `watchlist` : priority company list - Discord alert fires on scrape when a match lands
- `title_blacklist` : title phrases to filter out during scrape
- `search_terms` : search queries per lane (engineering / product / data)
- `locations` : where to search
- `sites` : boards to scrape (`indeed`, `linkedin`)
- `run_interval_seconds` : time between scrape cycles (default 600)
- `hours_old` : job posting lookback window (default 24)
- `results_wanted` : max listings per search term (default 500)
- `enrichment_batch_limit` : rows enriched per cycle (default 25)
- `enrichment_max_attempts` : retries before marking failed (default 4)
- `enrichment_alert_failure_rate_percent` : Discord alert threshold (default 50%)

Priority: **env var** > **config file** > hardcoded default in `config.py`.

C2/Fletcher settings use the shared DB-backed `component_settings` table instead of
`hunt_user_config.json`. Edit them in the Settings page under `C2 Fletcher`; see
`docs/C2_SETTINGS.md` for provider/runtime, notification, prompt policy, and
numeric guardrail keys.

## Planning Docs

- **Component IDs and code names:** `docs/NAMING.md`
- C4 coordinator contract and commands: `docs/C4_COORDINATOR.md`
- C2 Fletcher runtime, queue/history, and review workspace: `fletcher/README.md`
- C2 settings and provider/runtime controls: `docs/C2_SETTINGS.md`
- C3 safe testing runbook: `docs/C3_TESTING_RUNBOOK.md`
- C4 shared worker protocol: `docs/C4_AGENT_WORKERS.md`
- C4 OpenClaw runbook: `docs/C4_OPENCLAW_RUNBOOK.md`
- C4 Hermes runbook: `docs/C4_HERMES_RUNBOOK.md`
- Detailed C4 long-running agent plan: `docs/superpowers/plans/2026-05-05-c4-long-running-agent-orchestration.md`
- CI-first planning checklist for new projects, components, and features: `docs/PLANNING.md`
- System roadmap: `docs/roadmap.md`
- Shared glossary: `docs/GLOSSARY.md`
- Repo-native deploy command: `python deploy.py all`
- Server-shaped deploy command: `python deploy.py all --mode server --env-file .env.server2`
- Host-side manual recovery on server2: `python deploy.py all --mode server --env-file .env.server2 --project-name hunt-server2`
- Deploy targets runbook: `docs/DEPLOY.md`
- Local Postgres/container smoke tests: `docs/LOCAL_POSTGRES_SMOKES.md`
- Local C1 browser/auth/headful/Xvfb/Windows runbook: `docs/C1_LOCAL_RUNBOOK.md`
- Server2 deploy runbook: `docs/SERVER2_DEPLOY.md`
- One-command local smoke runner: `python smoke.py`
- Windows deploy wrapper for server2: `.\scripts\deploy_server2.ps1 -Stages 6`
- Public `server2` access still relies on Cloudflare Tunnel and Cloudflare Access around the Hunt runtime
- Component smokes: `python smoke.py c0`, `python smoke.py c1`, `python smoke.py c2`, `python smoke.py c4`
- Short test groups: `python test.py c0`, `python test.py c1`, `python test.py c2`, `python test.py c3`, `python test.py c4`
- Short quality checks: `python quality.py c0`, `python quality.py c1`, `python quality.py c2`, `python quality.py c3`, `python quality.py c4`
- Full CI entrypoints: `python ci.py` and `python ci.py c0|c1|c2|c3|c4|shared|frontend`
- Root hygiene: keep service Dockerfiles under `docker/`, one-off probes under `tools/dev-probes/`, and checked-in database fixtures under `tests/fixtures/databases/`.
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
- `python quality.py all`: Python Ruff + frontend lint/typecheck + Prettier checks + C3 extension quality
- `python quality.py c0`: backend Ruff + frontend lint/typecheck/Prettier
- `python quality.py c1`: Hunter Ruff checks
- `python quality.py c2`: Fletcher Ruff checks
- `python quality.py c3`: Executioner JS syntax lint + Prettier check
- `python quality.py c4`: Coordinator Ruff checks
- `python quality.py shared`: scripts/tests Ruff checks

C3 extension dev reload:
- Options page button: `Reload Extension`
- Terminal helper: `.\hunter.ps1 c3-reload`
- Requires Chrome launched with `--remote-debugging-port=9222` for terminal reload.

C3 extension quality:
- `.\hunter.ps1 c3-quality`: lint + format check
- `.\hunter.ps1 c3-test`: C3 pytest target
- `.\hunter.ps1 c3-ci`: quality + tests
- `.\hunter.ps1 c3-lint`: JS syntax lint only
- `.\hunter.ps1 c3-format-check`: Prettier check only
- `.\hunter.ps1 c3-format`: Prettier write
- `.\hunter.ps1 c3-package`: create an unpacked extension folder and zip in `dist/c3/`
- `.\hunter.ps1 c3-store-deploy`: package and upload C3 to an existing Chrome Web Store item

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
- `fletcher/` : **C2 (Fletcher)** has usable Option B pasted-JD and Option A job-linked workflows, a shared review workspace, provider/settings scaffolding, progress/restart recovery, and job-linked resume persistence. Treat generation quality, live C1 -> C2 server proof, keyword-list-only targeting, section-level regeneration, and provider model evaluation as the remaining risks.
- `executioner/` : **C3 (Executioner)** has standalone profile/resume storage, generic required-field fill, a browser-backed basic generic fixture test, Workday-specific fill, activity logging, extension reload helpers, named fill routes, detected-page prompt scaffold, and C4 polling/postback scaffold. It still needs a manual loaded-extension fixture proof, prompt-noise validation, C4 polling/postback proof, broader fixture coverage, and live ATS proof before it should be trusted on real applications.
- `coordinator/` : **C4 (Coordinator)** DB-backed readiness/state-machine code, service routes, CLI commands, C3 bridge tests, and a Postgres smoke exist. It should still be treated as early-stage automation because live browser-backed workers and stale-run recovery are not proven yet.

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
