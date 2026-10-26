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
- `verify-easy-apply`: verify C1 marks an Easy Apply row ineligible for external autofill

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

### Direct Workday intake

Verify supplied public Workday links through C1, including their live CXS posting
identity, description, publication status and external application availability:

```text
python -m hunter.workday_intake --urls-file jobs.json --db path/to/private.sqlite
```

The input is a JSON list of URLs or objects with `url` and optional `company`,
or one URL per line. This command uses the specified SQLite database, regardless
of `HUNT_DB_URL`. It reports exclusions without forcing eligibility. Existing
applied, cancelled and suppressed records remain unchanged. Successful intake
does not generate a resume; use C2's `generate-ready` command on the same database.

Discovery preferences default to Canada, excluding experienced titles and roles
outside the supported search lanes. Set these environment variables for the
process, or the corresponding lowercase keys in the user config file, then
restart the affected C1/C2 processes:

- `DISCOVERY_ALLOWED_GEOGRAPHIES`: comma-separated country/region labels,
  default `Canada`. Canada's existing city/province matching is retained; other
  labels require those words in the posting location. `*` removes geographic
  filtering, including for unspecified locations. This is a search preference,
  not a claim about work authorization.
- `DISCOVERY_ALLOW_EXPERIENCED`: default `false`; `true` admits experienced titles.
- `DISCOVERY_ALLOW_ALL_LANES`: default `false`; `true` admits roles outside the
  predefined search lanes.

These preferences do not bypass title blacklists, Easy Apply exclusions,
posting verification, owner dispositions, or resume readiness. Use process-local
environment values and an isolated database when evaluating a broader cohort;
changing preferences does not automatically requeue previously suppressed jobs.

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
.\hunter.ps1 config-set watchlist '["example-company"]'
```

```bash
./hunter.sh config
./hunter.sh config-set run_interval_seconds 300
./hunter.sh config-set watchlist '["example-company"]'
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

`ui serve` uses `REVIEW_APP_HOST` and `REVIEW_APP_PORT` when set, defaulting to
`127.0.0.1:8004` so it does not claim the legacy `8000` port by default. If the
requested port is already in use, the launcher prints a restart hint for the
existing instance and starts the new UI server on the first free fallback port
beginning at `8004`.

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

C4 is on hold. These retained command names exit without starting coordinator code.

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
- proving a real Easy Apply row is excluded by C1
