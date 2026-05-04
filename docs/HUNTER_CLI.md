# Hunter CLI

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
.\hunter.ps1 jobs -h
```

```bash
./hunter.sh -h
./hunter.sh scrape -h
./hunter.sh enrich -h
./hunter.sh jobs -h
```

## Daily use

- `queue`: show overall queue health
- `scrape`: run discovery, optionally with immediate enrichment
- `enrich`: run enrichment for LinkedIn, Indeed, or all sources
- `jobs`: list jobs with filters
- `job`: show one job by id
- `ready`, `blocked`, `failed`, `done`, `processing`, `pending`: quick status views
- `verify`: verify one enriched LinkedIn row
- `verify-easy-apply`: verify an Easy Apply row is still excluded from C4

Examples:

```powershell
.\hunter.ps1 queue
.\hunter.ps1 scrape
.\hunter.ps1 enrich 25 --source linkedin
.\hunter.ps1 jobs --source linkedin --status pending --limit 20
.\hunter.ps1 job 123
.\hunter.ps1 verify-easy-apply 123
```

## Command groups

### Auth

- `auth-save`
- `auth-check`
- `auth-auto-relogin`
- `auth-test-discord`

### Config

- `config`: show current config file path and effective values
- `config-set KEY VALUE`: set one config key (VALUE parsed as JSON, then plain string fallback)

Examples:

```powershell
.\hunter.ps1 config
.\hunter.ps1 config-set run_interval_seconds 300
.\hunter.ps1 config-set watchlist '["shopify","stripe"]'
```

```bash
./hunter.sh config
./hunter.sh config-set run_interval_seconds 300
./hunter.sh config-set watchlist '["shopify","stripe"]'
```

Config values can also be edited via the **Settings** page in the web UI (requires C1 service running).

### Queue and inspection

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
- `verify-easy-apply`

### Scrape and enrich

- `scrape`
- `enrich`
- `backfill`
- `backfill-all`
- `drain`
- `runner`

### Retry and cleanup

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

### Local and server control

- `start`
- `stop`
- `restart`
- `tests`

Linux/server-oriented helpers:

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

Notes:

- On Linux, `start` enables the scraper timer.
- On Windows, `start` runs one local scrape cycle instead.
- `stop` is meaningful on Linux; on Windows it exits with a hint.

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

## Validation

Standalone launcher validation completed on both Windows and Linux:

- `hunter.ps1`: valid command returns `0`, invalid command returns nonzero
- `hunter.cmd`: valid command returns `0`, invalid command returns nonzero
- `hunter.sh`: valid command returns `0`, invalid command returns nonzero

That confirms the CLI is usable without Docker through all supported launchers.

## Local operator runbook

Use `docs/C1_LOCAL_RUNBOOK.md` for:

- saving or checking a local LinkedIn browser session
- switching headless and headful enrichment runs
- running headed Linux sessions on Xvfb
- running scrape and enrich locally on Windows with `hunter.ps1` or `hunter.cmd`
- proving a real Easy Apply row is excluded from C4
