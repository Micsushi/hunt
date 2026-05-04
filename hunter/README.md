## Hunter (C1)

The **`hunter` Python package** is **C1 (Hunter)**: discovery, enrichment, and C1 operational logging.

Layout under this directory:
- **Runtime modules**: `hunter/*.py` (**`scraper.py`** = C1 discovery entrypoint only, historical name; **`enrich_*.py`**, **`db.py`**, …)
- **C1 tests**: `hunter/tests/`
- **Manual test helpers**: `hunter/devtools/`

Import in code as `from hunter...` (repo root must be on `PYTHONPATH` or run from repo root).

## Running C1

### Local dev (UI + C1, no full stack)

Starts the React UI, C0 backend, C1 hunter service, and Postgres. No C2/Ollama.

```powershell
cd frontend
npm run dev:c1
```

UI at `http://localhost:3000`. C1 service at `http://localhost:18001`.
Use this when you want the review UI connected to a live C1 without spinning up C2 or Ollama.

### Windows local deploy (Docker, with auto-scrape)

```powershell
python deploy.py c1
```

Starts `hunter`, `hunter-scheduler`, and `postgres` containers.
Scheduler fires a scrape+enrich cycle every 10 minutes automatically.

Check containers:
```powershell
docker ps --filter name=hunter
```

Tail scheduler logs:
```powershell
docker logs -f hunt-hunter-scheduler-1
```

Stop:
```powershell
python deploy.py c1 --stop
```

### Server2 deploy (Ansible)

From any directory on Windows:
```powershell
ansible.ps1 playbooks/job_agent/main.yml --tags stage6
```

Multi-tag value must be quoted (PowerShell treats bare `a,b` as an array):
```powershell
ansible.ps1 playbooks/job_agent/main.yml --tags "stage6,stage7"
```

`ansible.ps1` is in `ansible_homelab\` root and must be on PATH. Runs Ansible in Docker, no WSL needed.

### First-run auth (LinkedIn enrichment)

LinkedIn enrichment requires a saved browser session. Run once before first enrichment:
```powershell
.\hunter.ps1 auth-save
```

Check auth status:
```powershell
.\hunter.ps1 auth-check
```

---

## CLI

The standalone C1 operator CLI lives in `scripts/hunterctl.py`.
Use it through the repo-root launchers:

- Windows PowerShell: `.\hunter.ps1`
- Windows cmd: `.\hunter.cmd`
- Linux/macOS shell: `./hunter.sh`

Get help:

```powershell
.\hunter.ps1 -h
.\hunter.ps1 scrape -h
.\hunter.ps1 enrich -h
```

```bash
./hunter.sh -h
./hunter.sh scrape -h
./hunter.sh enrich -h
```

### Common commands

- `queue`: show overall queue health
- `scrape`: run discovery, optionally with immediate enrichment
- `enrich`: run enrichment for LinkedIn, Indeed, or all sources
- `jobs`: list jobs with source and status filters
- `job`: show one job by id
- `ready`, `blocked`, `failed`, `done`, `processing`, `pending`: quick status views
- `verify`: verify one enriched LinkedIn row
- `backfill`, `backfill-all`, `drain`: run batch enrichment catch-up flows
- `retry`, `requeue-enrich`, `requeue-errors`, `requeue-retryable`, `requeue-refresh`: recovery and retry helpers

Examples:

```powershell
.\hunter.ps1 queue
.\hunter.ps1 scrape
.\hunter.ps1 enrich 25 --source linkedin
.\hunter.ps1 jobs --source linkedin --status pending --limit 20
.\hunter.ps1 job 123
.\hunter.ps1 retry
.\hunter.ps1 backfill-all 25 --source all
```

### Auth commands

- `auth-save`
- `auth-check`
- `auth-auto-relogin`
- `auth-test-discord`

### Queue and inspection commands

- `queue`
- `jobs`
- `ready`
- `blocked`
- `failed`
- `done`
- `processing`
- `pending`
- `job`
- `job-linkedin`
- `verify`

### Scrape and enrich commands

- `scrape`
- `enrich`
- `backfill`
- `backfill-all`
- `drain`
- `runner`

### Retry and cleanup commands

- `requeue-refresh`
- `requeue-enrich`
- `requeue-errors`
- `requeue-retryable`
- `requeue-transient`
- `retry`
- `cleanup-lane-mismatch`
- `clean-lane-mismatch`
- `cleanup-indeed`
- `clean-indeed`

### UI helpers

- `ui serve`
- `ui build`
- `review`: legacy alias for `ui serve`
- `build-ui`: legacy alias for `ui build`

### C4 commands exposed through the Hunter CLI

- `c4-init-db`
- `c4-ready`
- `c4-ready-list`
- `c4-summary`
- `apply-prep`
- `c4-request-fill`
- `c4-record-fill`
- `c4-resolve-review`
- `c4-approve-submit`
- `c4-mark-submitted`
- `c4-pick-next`
- `c4-run`
- `c4-run-once`
- `c4-run-status`
- `c4-runs`
- `c4-events`

### Local and server control commands

- `start`
- `stop`
- `restart`
- `tests`
- `auto-on`
- `auto-off`
- `auto-status`
- `svc-start`
- `svc-stop`
- `svc-status`
- `svc-log`
- `svc-follow`
- `timer-enable`
- `timer-disable`
- `timer-start`
- `timer-stop`
- `timer-status`
- `xvfb-status`
- `review-health`

Linux/server helper notes:

- `auto-*`, `svc-*`, `timer-*`, `xvfb-status`, and `review-health` are Linux/server-oriented helpers
- `start` enables the scraper timer on Linux, but on Windows it runs one local scrape cycle instead
- `stop` is Linux-only in practice and will exit with a hint on Windows

Full command reference: [`docs/HUNTER_CLI.md`](../docs/HUNTER_CLI.md)
