# C1 (Hunter) : Posting Discovery And Multi-Source Enrichment

**C1 (Hunter)** runtime code lives in the Python package **`hunter/`** (the old **`scraper/`** directory was renamed). The file **`hunter/scraper.py`** is only the **discovery entrypoint** (historical filename), not a separate component. See **`docs/NAMING.md`**.

**Short operator narrative** (JobSpy discovery → Playwright enrichment → review app) : **`docs/C1_OPERATOR_WORKFLOW.md`**.

## Goal

Complete **C1 (Hunter)** so the system can:
- discover new jobs continuously
- store the listing URL
- store the real external application URL when available
- store a usable job description
- classify LinkedIn Easy Apply jobs so they are never sent to later automation

LinkedIn is the priority source even if other sources remain enabled.

## Current State

Discovery already exists in **`hunter/scraper.py`** (C1 discovery script inside the **`hunter`** package).
The discovery script can now optionally trigger a follow-up enrichment pass immediately after it writes rows to SQLite.
Stage 1, Stage 2, Stage 3, and Stage 3.2 repo-side code are complete and locally validated.
The initial Stage 4 runtime slice now exists too:
- failure-artifact capture
- machine-readable queue monitoring
- review-surface artifact visibility

What Stage 1 changed:
- `job_url` now represents the discovered listing URL
- `apply_url` now represents the best-known external application URL
- new LinkedIn metadata columns were added for enrichment
- existing LinkedIn rows were marked `enrichment_status = 'pending'`
- old fake LinkedIn `apply_url` values that simply copied `job_url` were cleared
- runtime SQLite data should not live inside the git checkout on deployed servers

Why this matters:
- later automation must not confuse a LinkedIn listing page with an external ATS application URL
- `status` remains reserved for actual application lifecycle

## Deployment Model

Component deployment on `server2` is intentionally split:
- **C1 (Hunter)** deploys through the current Hunt-focused Ansible step/stage
  - today that is the `job_agent` Stage 6 deployment in `ansible_homelab` (systemd units may still be named `hunt-scraper.*`; they run `python hunter/scraper.py`)
- **C2 (Fletcher)** should deploy in its own later Ansible step/stage
- **C3 (Executioner)** should deploy in its own later Ansible step/stage
- **C4 (Coordinator)** / OpenClaw integration should deploy in its own later Ansible step/stage

Do not treat **C2 (Fletcher)** or **C3 (Executioner)** as extensions of the current **C1 (Hunter)** Stage 6 deploy.

## Desired LinkedIn Behavior

For each LinkedIn row:
1. Open the LinkedIn job page in a logged-in browser session.
2. Expand and save the full job description.
3. Inspect the primary application action.
4. If the job is `Easy Apply`, classify it and stop.
5. If the job uses external `Apply`, capture the outbound destination URL.
6. Save the destination hostname and ATS type when possible.
7. Mark the row as enriched.

Rules:
- `Easy Apply` means `apply_type = 'easy_apply'`
- `Easy Apply` means `auto_apply_eligible = 0`
- `Easy Apply` jobs should not be retried by later automation
- external `Apply` means `apply_type = 'external_apply'`
- external `Apply` means `auto_apply_eligible = 1`
- normal successful enrichment uses `enrichment_status = 'done'`
- a successful interactive rerun uses `enrichment_status = 'done_verified'`
- an external security challenge uses `enrichment_status = 'blocked'`
- a security challenge that still reproduces during an interactive rerun uses `enrichment_status = 'blocked_verified'`

## Stage Breakdown

### Stage 1 : completed

Files changed:
- `hunter/db.py`
- `hunter/scraper.py`

Results:
- added enrichment columns
- added migration/backfill logic
- prepared LinkedIn rows for later enrichment

Verification goal:
- LinkedIn rows should have `enrichment_status = 'pending'`
- LinkedIn rows should have `apply_type = 'unknown'`
- historical LinkedIn `apply_url` values copied from `job_url` should be null

### Stage 2 : one-job enrichment worker

Implemented files:
- `hunter/enrich_linkedin.py`
- `hunter/linkedin_session.py`
- `hunter/url_utils.py`

Worker responsibilities:
- claim one pending LinkedIn row
- open `job_url` in Playwright using saved auth state
- expand description and store it
- prefer dedicated LinkedIn description selectors when they exist, but fall back to the visible page text anchored on `About the job` when LinkedIn serves obfuscated class names
- detect `Easy Apply` vs external `Apply`
- capture the external destination URL when present
- treat `Easy Apply` as a terminal classification even if LinkedIn hides the full description
- if LinkedIn does not expose a usable description but the job is external apply, fall back to the external page for the description
- if the external page does not expose a clean job-description block, fall back to broad visible page text from that site
- if the external page says the job is unavailable, fail it as `job_removed` instead of treating that page text as a successful enrichment
- save `apply_type`, `auto_apply_eligible`, `apply_url`, `apply_host`, `ats_type`, `enrichment_status`, `enriched_at`

Testing goal:
- run against one known LinkedIn row only
- verify the DB changed exactly as expected

Auth setup note:
- when saving Playwright auth state for LinkedIn, prefer `Sign in with email`
- Google SSO popups can be unreliable in automation-managed browsers
- auto relogin now treats LinkedIn login as two explicit UI states:
  - `welcome_back`: remembered account card and `Sign in using another account`
  - `login_form`: plain LinkedIn email/password form
- on `welcome_back`, Hunt only interacts with the remembered-account chooser or `Sign in using another account`
- on `login_form`, Hunt only fills the LinkedIn email/password inputs and clicks the LinkedIn submit button
- Hunt should not intentionally click third-party auth providers such as Google or Apple during unattended relogin
- on Linux/server deployments, installing the Python `playwright` package is not sufficient by itself
- after dependency install, also run `python -m playwright install chromium` so the browser binaries exist under the runtime user's Playwright cache
- if a manual test is interrupted and leaves a row stuck in `processing`, rerun that same job with `--force`
- if you want to explicitly re-check a blocked or flaky row in a visible browser, rerun that specific job with `--ui-verify`
- if you want a batch run to do a normal first pass and then automatically rerun only browser-fixable failures in a visible browser, use `--ui-verify-blocked`
- if older sparse `failed/unknown` rows need another pass with the newer Stage 2 logic, requeue them with `python scripts/requeue_linkedin_refresh_candidates.py`

### Stage 3 : batch enrichment and runner integration

Implemented files:
- `hunter/enrich_linkedin.py`
- `hunter/enrichment_policy.py`
- `hunter/db.py`
- `hunter/scraper.py`
- `hunter/runner.py`
- `review_app.py`
- `scripts/queue_health.py`

Implemented behavior:
- batch processing for pending and retry-due LinkedIn rows
- post-scrape enrichment inside `hunter/scraper.py`
- continuous discovery + enrichment inside `runner.py`
- blocked-row fallback support through `--ui-verify-blocked`
- retry scheduling with `next_enrichment_retry_at`
- stale `processing` recovery with `last_enrichment_started_at`
- backfill of retry scheduling for older retryable failed rows
- bounded retries using `ENRICHMENT_MAX_ATTEMPTS`
- newest pending rows are claimed before older backlog rows during post-scrape enrichment
- terminal failures like `job_removed` are recorded cleanly without being treated as actionable retry failures
- queue-health CLI visibility
- browser-facing review/control-plane app for manual queue inspection and requeue actions
- read-only queue tools avoid queue-maintenance side effects

Repo-level Stage 3 outcome:
- the Hunt repo now contains the runtime code needed for unattended Stage 3 behavior
- the intended `server2` deployment shape is now:
  - one service for timed scrape + enrich + blocked-row UI fallback
  - one service for the browser-facing review app
- the remaining work is deployment rollout on `server2` through `ansible_homelab`

Detailed plan:
- production / Ansible / `server2` layout : **`docs/C1_OPERATOR_WORKFLOW.md`** (**Production host (server2)**) and **`ansible_homelab/docs/2.01-job-agent-plan.md`**

Testing goal:
- process a small batch safely
- confirm the queue drains without corrupting rows
- blocked ATS pages should fail cleanly without storing anti-bot challenge text as the description
- for a larger staged run, `python hunter/enrich_linkedin.py --limit 100 --channel chrome --ui-verify-blocked` should do a normal first pass and then a second UI-verification pass only for blocked rows

Useful commands:
- run discovery and then enrich pending LinkedIn rows with the default configured batch size:
  `python hunter/scraper.py`
- run discovery and then enrich up to 100 pending LinkedIn rows right away:
  `python hunter/scraper.py --enrich-pending --enrich-limit 100 --channel chrome`
- run discovery and then do a second visible-browser pass for blocked rows:
  `python hunter/scraper.py --enrich-pending --enrich-limit 100 --channel chrome --ui-verify-blocked`
- for `server2`, the intended deployment is to keep that blocked-row UI fallback enabled, but run it on a separate virtual display such as `Xvfb :98` so it does not steal the main desktop foreground
- enrich existing pending LinkedIn rows already in the DB without doing a new discovery scrape:
  `python hunter/enrich_linkedin.py --limit 100 --channel chrome`

### Stage 3.2 : multi-source enrichment on top of the Stage 3 runtime

Implemented files:
- `hunter/enrichment_dispatch.py` : single dispatcher for enrichment (source priority, per-source auth, batch fan-out)
- `hunter/enrich_jobs.py` : CLI wrapper; calls `run_enrichment_round`
- `hunter/enrich_indeed.py`
- `hunter/db.py`
- `hunter/scraper.py`
- `hunter/runner.py`
- `review_app.py`
- `scripts/queue_health.py`
- `scripts/hunterctl.py` (legacy: `scripts/huntctl.py`)
- `tests/test_stage32.py`

Implemented behavior:
- reuse the same enrichment columns for LinkedIn and Indeed
- reuse the same retry scheduling, stale-processing recovery, and claim/update flow
- keep one jobs table and one review app
- dispatch post-scrape enrichment by source priority:
  - LinkedIn first
  - Indeed second
- if LinkedIn auth is missing after an auto-relogin attempt, **skip only the LinkedIn slice** for that run; **Indeed still runs** (Indeed does not use LinkedIn cookies)
- adding a new board later: append its `source` string to `db.ENRICHMENT_SOURCE_PRIORITY`, add a row to `enrichment_dispatch._REQUIRES_LINKEDIN_SESSION`, extend `_run_batch_for_source`, and implement `process_batch` (or equivalent) for that source
- mark newly discovered Indeed rows as `pending` so they enter the same queue model
- add an Indeed enrichment worker that:
  - opens the Indeed job page with HTTP + HTML parsing
  - extracts a usable description
  - resolves an external apply URL when one is discoverable
  - keeps `apply_url` pointed at the external destination rather than leaving it on an Indeed-hosted intermediate URL when redirect resolution succeeds
  - stores `apply_url`, `apply_host`, `ats_type`, `apply_type`, and `enrichment_status`
- add a shared browser runtime so supported sources can reuse one UI/browser fallback layer instead of duplicating Playwright setup
- allow Indeed to use a visible browser rerun for browser-fixable failures while still preferring the cheaper non-UI path first
- apply a **discovery lane title filter** during fetch for every board (`title_matches_search_lane` in `hunter/search_lanes.py`) : broad job-board results are trimmed so each row still matches the **same lane** as the query that produced it (**`engineering`** / **`product`** / **`data`**) using keyword sets aligned with **`hunter/config.py` `SEARCH_TERMS`**. **`scripts/cleanup_lane_mismatch_rows.py`** drops stored rows whose title does not match their stored `category` lane (all sources; optional `--source`).
- expand the review app with source-aware views:
  - source counts
  - source filters
  - source-aware requeue for supported workers

Stage 3.2 outcome:
- the existing runtime, review app, and service deployment shape stay intact
- LinkedIn continues to work as-is
- Indeed rows can move from pending to done/failed using the same operational model
- the review app is now a whole-job-table control plane with source-aware filtering
- later sources can be added behind the same queue/runtime model
- `--ui-verify-blocked` now means:
  - LinkedIn: rerun blocked/security-challenged rows in a visible browser
  - Indeed: rerun browser-fixable failures such as `description_not_found`, `rate_limited`, or similar page-shape issues in a visible browser
- LinkedIn `security_verification` rows remain blocked row-level failures, but they no longer hard-stop a whole backfill batch by themselves

## Command Reference

**Conventions for all `hunter` subcommands (legacy launcher: `hunt`) and for adding C2–C4 commands later:** **`docs/CLI_CONVENTIONS.md`**.

Short wrappers at the repo root (**canonical:** **`hunter.*`**; **`hunt.*`** is a legacy alias):
- Windows PowerShell: `.\hunter.ps1 <command>`
- Windows cmd: `hunter.cmd <command>`
- Linux/macOS: `./hunter.sh <command>`

Launcher note:
- the repo-root wrapper files are now thin shims
- the real launcher implementations live under:
  - `scripts/launchers/hunter.ps1`
  - `scripts/launchers/hunter.cmd`
  - `scripts/launchers/hunter.sh`
- on deployed Linux hosts, `./hunter.sh` now auto-targets `~/data/hunt/hunt.db` and `~/data/hunt/artifacts` when that runtime directory exists, so manual queue/auth commands line up with the `systemd` runtime

Common examples:
- **start / stop / restart** scheduled C1 on Linux (systemd timer + Xvfb):
  `./hunter.sh start`
  `./hunter.sh stop`
  `./hunter.sh restart`
- enrichment batch of **50** (all sources):
  `./hunter.sh enrich 50 --source all`
- queue health:
  `.\hunter.ps1 queue`
  `./hunter.sh queue`
- run multi-source enrichment directly:
  `.\hunter.ps1 enrich --source all --limit 25 --channel chrome`
  `./hunter.sh enrich --source all --limit 25 --channel chrome`
- run Indeed-only enrichment:
  `.\hunter.ps1 enrich --source indeed --limit 25`
  `./hunter.sh enrich --source indeed --limit 25`
- force one visible-browser rerun for a specific Indeed row:
  `.\hunter.ps1 enrich --source indeed --job-id 13143 --force --ui-verify`
  `./hunter.sh enrich --source indeed --job-id 13143 --force --ui-verify`
- list newest ready rows:
  `.\hunter.ps1 ready --limit 10`
  `./hunter.sh ready --limit 10`
- list jobs across sources:
  `.\hunter.ps1 jobs --source all --status ready --limit 10`
  `./hunter.sh jobs --source all --status ready --limit 10`
- list Indeed rows only:
  `.\hunter.ps1 jobs --source indeed --status all --limit 10`
  `./hunter.sh jobs --source indeed --status all --limit 10`
- preview stored rows whose title **does not match the row's category lane** (LinkedIn, Indeed, …):
  `./hunter.sh clean-lane-mismatch`
  `./hunter.sh cleanup-lane-mismatch`
  (legacy aliases: `clean-indeed`, `cleanup-indeed`)
- delete those rows:
  `./hunter.sh clean-lane-mismatch --apply`
  `./hunter.sh cleanup-lane-mismatch --apply`
- inspect one job:
  `.\hunter.ps1 job 13179`
  `./hunter.sh job 13179`
- run local review app:
  `.\hunter.ps1 review`
  `./hunter.sh review`
- run a controlled backfill in **25-row** chunks by default (checkpoint after each batch); pass a larger N for bigger chunks:
  `.\hunter.ps1 backfill --ui-verify-blocked`
  `./hunter.sh backfill --ui-verify-blocked`
- run a controlled backfill for Indeed only (same default batch size):
  `.\hunter.ps1 backfill --source indeed --ui-verify-blocked`
  `./hunter.sh backfill --source indeed --ui-verify-blocked`
- run a controlled backfill for all supported sources (same default batch size):
  `.\hunter.ps1 backfill --source all --ui-verify-blocked`
  `./hunter.sh backfill --source all --ui-verify-blocked`
- requeue the common retryable enrichment rows across all sources:
  `./hunter.sh retry`
  `./hunter.sh requeue-enrich --source all`
- backfill all sources with blocked-row UI verification and automatic continue (**default 25 rows** per batch; omit N or pass e.g. `100`):
  `DISPLAY=:98 ./hunter.sh backfill-all`
  `DISPLAY=:98 ./hunter.sh drain`
  `DISPLAY=:98 ./hunter.sh backfill 100 --source all --ui-verify-blocked --yes`
- backfill all with a custom batch size:
  `DISPLAY=:98 ./hunter.sh backfill-all 250`
  `DISPLAY=:98 ./hunter.sh drain 250`
- backfill all but stop after each batch for confirmation:
  `DISPLAY=:98 ./hunter.sh backfill-all --ask`
  `DISPLAY=:98 ./hunter.sh drain --ask`
- run a controlled backfill in custom chunk sizes:
  `.\hunter.ps1 backfill 250 --ui-verify-blocked`
  `./hunter.sh backfill 250 --ui-verify-blocked`
- run backfill for a selected set of job ids only:
  `.\hunter.ps1 backfill --source all --job-id 13143 --job-id 13073`
  `./hunter.sh backfill --source all --job-id 13143 --job-id 13073`
- save LinkedIn auth state on a Linux desktop session:
  `./hunter.sh auth-save --display :0`
- start one manual server scrape cycle:
  `./hunter.sh svc-start`
- follow live service logs on the server:
  `./hunter.sh svc-follow`
- stop the timer on the server:
  `./hunter.sh timer-stop`
  `./hunter.sh timer-disable`
- pause automatic scrape/enrich cycles on the server:
  `./hunter.sh auto-off`
- resume automatic scrape/enrich cycles on the server:
  `./hunter.sh auto-on` (legacy; prefer **`./hunter.sh start`**)
- check whether the automatic timer is paused or running:
  `./hunter.sh auto-status`

### Session setup

- save LinkedIn auth state:
  `python hunter/linkedin_session.py --save-storage-state --channel chrome`
- save LinkedIn auth state on the real Linux desktop session:
  `DISPLAY=:0 python hunter/linkedin_session.py --save-storage-state --channel chrome`
- check whether the saved LinkedIn auth state exists:
  `python hunter/linkedin_session.py --check`
- on `server2`, prefer the wrapper so auth refresh uses the same runtime DB as the review app and `/metrics`:
  `./hunter.sh auth-auto-relogin --channel chrome`
- if you want the relogin flow to open a visible browser on the real `server2` monitor:
  `DISPLAY=:0 ./hunter.sh auth-auto-relogin --headful --display :0 --channel chrome`
- if you want the relogin flow to open a visible browser on `server2`, run it on the Xvfb display:
  `DISPLAY=:98 ./hunter.sh auth-auto-relogin --headful --display :98 --channel chrome`
- direct Python auth commands on `server2` are only safe if `HUNT_DB_PATH` is exported first; otherwise they can write auth state to the repo-local DB instead of the runtime DB used by the deployed review app
- `--check` only confirms that the storage-state JSON exists; it does not prove the saved session still reaches the LinkedIn feed
- `--auto-relogin` now reuses the saved auth state first when it is still valid
- optional credential fallback for `--auto-relogin` is available when these env vars are present:
  `LINKEDIN_EMAIL`
  `LINKEDIN_PASSWORD`
  `LINKEDIN_AUTO_RELOGIN=true`
- multi-account rotation can also be configured with:
  `LINKEDIN_ACCOUNTS`
- if LinkedIn auth expires during enrichment, Hunt now pauses the LinkedIn lane without failing the current row
- when stored LinkedIn credentials are configured, Hunt now attempts one Playwright relogin before pausing the lane
- relogin action order is now:
  - classify the page as `welcome_back`, `login_form`, `login_gate`, `feed`, or `unknown`
  - if `welcome_back`, click the remembered-account card or `Sign in using another account`
  - if `login_form`, fill the LinkedIn email/password inputs and click the LinkedIn submit button
  - if the page is neither of those states, log the observed screen type and fail cleanly instead of clicking unrelated provider buttons
- if LinkedIn shows an account chooser during relogin, Hunt first tries chooser buttons/cards/email-text matches before it fills credentials
- if chooser selection is not available, Hunt clicks `Sign in using another account` / `Use a different account` and waits for the standard LinkedIn email/password form
- relogin debug logging can be enabled with:
  `LINKEDIN_RELOGIN_DEBUG=1`
- every auth run now also appends a persistent JSONL trace file at:
  `.state/linkedin_auth_trace.jsonl`
  or the path from:
  `LINKEDIN_AUTH_TRACE_PATH`
- debug logs now record:
  - screen classification
  - selector/button clicks
  - failed click attempts
  - filled email value
  - a redacted password placeholder such as `<redacted len=12>`
- the persistent auth trace now records per-run:
  - `run_start` / `run_end`
  - current URL and host
  - detected screen type
  - visible screen components such as buttons, links, inputs, labels, headings, and forms
  - clicked selectors
  - filled fields and values, with passwords redacted
- current observed `server2` LinkedIn relogin shape:
  - step 1 stays on `https://www.linkedin.com/login/?session_redirect=...` and renders the `Welcome back` chooser
  - step 2 after clicking `Sign in using another account` still keeps the same `linkedin.com/login` URL, but the DOM changes into a real email/password login form
  - that second screen can include a visible `Sign in with Apple` provider button, so submit detection must stay limited to the exact LinkedIn `Sign in` control
  - the observed successful server-side selectors were:
    - email: `input[type='text']`
    - password: `input[autocomplete='current-password']`
    - submit: `xpath=//button[normalize-space(.)='Sign in']`
  - a transient trace snapshot right after submit may show `Execution context was destroyed` if LinkedIn navigates immediately; use the later `/feed/` snapshot plus `run_end: success` as the authoritative success signal
  - if a relogin run reaches `/feed/` and ends with success but `/metrics` still shows `hunt_auth_available{source="linkedin"} 0`, the relogin worker and the review app are almost certainly pointed at different `HUNT_DB_PATH` values
  - the confirmed `server2` mismatch was:
    - direct shell relogin wrote to `/home/michael/hunt/hunt.db`
    - the deployed review app was reading `/home/michael/data/hunt/hunt.db`
    - rerunning auth through `./hunter.sh auth-auto-relogin ...` fixed `/metrics` immediately
- successful manual auth save or successful `--auto-relogin` marks LinkedIn auth available again in shared runtime state
- failures such as expired saved auth, automation-flagged accounts, all accounts blocked, or failed account rotation mark LinkedIn auth unavailable in shared runtime state
- the review app and `/metrics` both read that shared runtime auth state:
  - review app headline toggles between `LinkedIn auth ready` and `LinkedIn auth paused`
  - `/metrics` exposes `hunt_auth_available{source="linkedin"}` as `1` or `0`
- after logging in again and pressing Enter in the auth-save flow, the saved auth state is refreshed and the paused-auth flag is cleared
- cancelling `--save-storage-state` with `Ctrl+C` or closing the Playwright browser should now fail cleanly without a noisy cleanup traceback

### Stage 1 verification

- run the Stage 1 unit tests:
  `python -m unittest discover -s tests -p "test_stage1.py" -v`
- run a syntax check:
  `python -m compileall hunter tests`
- verify the live Stage 1 DB state:
  `python scripts/verify_stage1_db.py`

### Stage 2 verification

- run the Stage 2 unit tests:
  `python -m unittest discover -s tests -p "test_stage2.py" -v`
- debug LinkedIn-only description extraction without mutating the DB:
  `python scripts/debug_linkedin_description.py --job-id <ID>`
- on deployed Linux hosts, point that debug script at the runtime DB explicitly:
  `python scripts/debug_linkedin_description.py --db /home/michael/data/hunt/hunt.db --job-id <ID> --output ./tmp/linkedin_<ID>.txt`
- list pending LinkedIn rows:
  `python scripts/list_linkedin_enrichment_queue.py --status pending --limit 10`
- inspect one LinkedIn row:
  `python scripts/show_linkedin_job.py --job-id <ID>`
- verify one enriched LinkedIn row:
  `python scripts/verify_stage2_job.py --job-id <ID>`
- verify one enriched LinkedIn row with a specific expected apply type:
  `python scripts/verify_stage2_job.py --job-id <ID> --expect-type external_apply`

### Stage 3 verification

- run the Stage 3 unit tests:
  `python -m unittest discover -s tests -p "test_stage3.py" -v`
- run the Stage 3.2 unit tests:
  `python -m unittest discover -s tests -p "test_stage32.py" -v`
- run the full Stage 1 through Stage 3.2 suite:
  `python -m unittest discover -s tests -p "test_stage*.py" -v`
- inspect unattended queue health:
  `python scripts/queue_health.py`
- inspect unattended queue health as JSON:
  `python scripts/queue_health.py --json`
- on deployed Linux hosts, the shared browser/UI fallback used by LinkedIn and Indeed still requires:
  `python -m playwright install chromium`
- run a controlled LinkedIn-only backfill in chunks and stop for operator confirmation after each chunk:
  `python hunter/enrich_linkedin.py --limit 100 --channel chrome --ui-verify-blocked`
- run a controlled backfill across supported sources in chunks and stop for operator confirmation after each chunk:
  `python scripts/backfill_enrichment.py 100 --source all --ui-verify-blocked`
- run a controlled backfill for selected rows only:
  `python scripts/backfill_enrichment.py --source all --job-id 13143 --job-id 13073`
- browse the live review/control-plane app:
  `python review_app.py`
- smoke-test integrated discovery plus newest-first enrichment:
  `python hunter/scraper.py --enrich-pending --enrich-limit 5 --channel chrome`
- confirm the ready queue still shows the newest rows first after the smoke test:
  `python scripts/list_linkedin_enrichment_queue.py --status ready --limit 10`
- do one continuous-loop sanity check before deployment:
  `python hunter/runner.py`

### Requeue and refresh

- requeue older sparse LinkedIn failures for another Stage 2 pass:
  `python scripts/requeue_linkedin_refresh_candidates.py`
- bulk requeue failed/blocked enrichment rows across supported sources back to `pending`:
  `./hunter.sh requeue-enrich --source all`
- if you also want to requeue stale `processing` rows manually:
  `./hunter.sh requeue-enrich --source all --status failed --status blocked --status blocked_verified --status processing`
- if a deployment bug caused broad false negatives, requeue only the likely-bugged LinkedIn failures instead of all failed rows:
  `sqlite3 /home/michael/data/hunt/hunt.db "update jobs set enrichment_status='pending', last_enrichment_error=NULL, next_enrichment_retry_at=NULL, last_enrichment_started_at=NULL where source='linkedin' and enrichment_status='failed' and (last_enrichment_error like 'external_description_not_usable:%' or last_enrichment_error like 'external_description_not_found:%' or last_enrichment_error like 'apply_button_not_found:%' or last_enrichment_error like 'unexpected_error:%');"`
- rerun a specific row even if it is not currently pending:
  `python hunter/enrich_linkedin.py --job-id <ID> --channel chrome --force`
- re-check one blocked or flaky row in a visible browser:
  `python hunter/enrich_linkedin.py --job-id <ID> --channel chrome --ui-verify`

### Debugging notes from server2 rollout

- a saved LinkedIn session plus the Python Playwright package does not guarantee browser automation will run
- if Playwright reports `Executable doesn't exist`, install the browser binaries with:
  `python -m playwright install chromium`
- on `server2`, the live DB is expected at `/home/michael/data/hunt/hunt.db`, not inside the repo checkout
- if a manual LinkedIn-only debug command can see the full `About the job` text but `hunter/enrich_linkedin.py` still reports `description_not_found`, verify the deployed repo actually contains the latest extractor fallback code before requeueing large batches
- the same browser-binary requirement also applies to Indeed `--ui-verify` and `--ui-verify-blocked` runs because they use the shared Playwright browser runtime
- for Indeed rows, `apply_url` should resolve to the off-Indeed destination when possible; if manual checks only show an Indeed-hosted link, verify whether the row was enriched before the latest redirect-resolution logic was deployed

### Enrichment runs

- enrich one specific LinkedIn row:
  `python hunter/enrich_linkedin.py --job-id <ID> --channel chrome`
- enrich one specific LinkedIn row in a visible browser:
  `python hunter/enrich_linkedin.py --job-id <ID> --headful --channel chrome`
- enrich a batch of pending LinkedIn rows:
  `python hunter/enrich_linkedin.py --limit 100 --channel chrome`
- enrich a batch and then UI-verify only blocked rows:
  `python hunter/enrich_linkedin.py --limit 100 --channel chrome --ui-verify-blocked`
- enrich a batch of pending Indeed rows:
  `python hunter/enrich_indeed.py --limit 100`
- enrich a batch of pending Indeed rows and then rerun only browser-fixable failures visibly:
  `python hunter/enrich_indeed.py --limit 100 --channel chrome --ui-verify-blocked`
- enrich one specific Indeed row in a visible browser:
  `python hunter/enrich_indeed.py --job-id <ID> --force --channel chrome --ui-verify`
- enrich a multi-source batch with LinkedIn priority first:
  `python hunter/enrich_jobs.py --limit 100 --channel chrome --ui-verify-blocked`
- inspect Stage 3 queue health:
  `python scripts/queue_health.py`

### Discovery plus enrichment

- run discovery only:
  `python hunter/scraper.py --skip-enrichment`
- run discovery and then enrich pending LinkedIn rows:
  `python hunter/scraper.py`
- run discovery and then enrich up to 100 pending supported rows with LinkedIn priority first:
  `python hunter/scraper.py --enrich-pending --enrich-limit 100 --channel chrome`
- run discovery and then do a second UI pass for blocked rows:
  `python hunter/scraper.py --enrich-pending --enrich-limit 100 --channel chrome --ui-verify-blocked`
- run the continuous server loop:
  `python hunter/runner.py`
- start the browser-facing review/control-plane app locally:
  `python review_app.py`
- expose the review app with uvicorn explicitly if preferred:
  `uvicorn review_app:app --host 127.0.0.1 --port 8000`
- operator console in the review app (bulk requeue for `auth_expired` / `rate_limited`, quick links to `/health`, `/api/summary`, `/metrics`):
  open **`/ops`** in the browser (nav : **Ops**)

### Stage 4 : hardening and backfill

Stage 4 is the current phase after the completed Stage 1 through Stage 3.2 work. The initial Stage 4 runtime slice is now implemented; the remaining work is production validation, backlog drain, and tuning on `server2`.

Stage 4 goal:
- drain the existing enrichment backlog safely
- make hard failures easier to debug without attaching live browsers
- add operator-facing monitoring that is useful during unattended server runs
- tighten the `server2` deployment so backfill and unattended runtime use the same stable paths and service assumptions

Initial Stage 4 implementation now includes:
- failure-artifact capture for blocked/browser-fixable rows
  - relative artifact paths are now stored on the job row
  - artifacts are intended to live under the runtime artifact root, not the git repo
- machine-readable queue monitoring
  - `python scripts/queue_health.py --json`
  - review app `/metrics`
  - shared LinkedIn auth availability now comes from runtime SQLite state so auth tooling, the review app, and `/metrics` stay aligned
- review-surface visibility for artifacts
  - the job detail page now shows saved artifact paths and links for screenshot/HTML/text snapshots when present
  - the review app auth card now reflects the same shared LinkedIn auth ready/paused state used by unattended enrichment
- Stage 6 deployment wiring for artifact storage
  - Hunt runtime uses `HUNT_ARTIFACTS_DIR`
  - the review container mounts the same artifact directory read-only

Stage 4 workstreams:
- backlog drain and queue policy
  - finish controlled backfills for the remaining ready backlog
  - keep LinkedIn first in mixed-source runs, but continue supporting all-source backfill through the shared dispatcher
  - keep `security_verification` as a row-level blocked result rather than a batch hard-stop
  - review whether batch size, timeout, and UI-fallback defaults should change after observing real `server2` runs
- hard-failure artifacts
  - save a screenshot and lightweight HTML/text snapshot for browser-fixable or security-challenged failures
  - store artifacts under the Hunt runtime directory on `server2`, not inside the git repo
  - link or surface artifact paths in the review app and queue tooling so blocked rows are easier to inspect
- monitoring and operator visibility
  - add a machine-readable export path for queue health beyond plain CLI output
  - expose richer counts for:
    - ready backlog
    - blocked rows
    - stale processing
    - repeated auth/rate-limit/security failures
    - recent done rate by source
  - wire those outputs into the existing `server2` monitoring stack where useful
- `ansible_homelab` deployment follow-up
  - keep Stage 6 as the deployment home for Hunt runtime and review app
  - add any missing env vars for Stage 4 artifact directories and monitoring endpoints
  - document the expected `server2` manual-ops commands:
    - timer on/off
    - backfill all
    - UI backfill with `DISPLAY=:98`
    - queue/review checks
  - keep the current Xvfb + Playwright + review-container model rather than redesigning deployment

Recommended implementation order:
1. finish a controlled all-source backlog drain on `server2` and record what failure classes remain after the current Stage 3.2 code
2. add failure-artifact capture for blocked/security-challenged/browser-fixable rows
3. expose machine-readable queue-health/metrics output using the existing queue summary helpers
4. wire the new Stage 4 runtime knobs and docs into `ansible_homelab`
5. only after that, decide whether batch sizes, retry windows, or monitoring alerts need tuning

Stage 4 success criteria:
- a full controlled backfill can run to completion in production-sized batches
- blocked/security rows no longer force manual guesswork because artifacts exist
- operators can tell from one place whether the queue is healthy, stuck, or auth-challenged
- `server2` deployment docs and automation match the real command flow used during backfill and unattended runs

Remaining Stage 4 operator work:
- deploy the latest Hunt + `ansible_homelab` changes to `server2`
- complete the full backlog drain with the updated backfill flow
- tune alerting, retention, and batch defaults based on real `server2` runs

Current `server2` tuning note:
- the current all-source `100`-row backfill default is still aggressive for LinkedIn
- mixed-source batches can hit `rate_limited` before the overall backlog is normalized because the dispatcher still processes LinkedIn first
- until a larger safe batch size is proven, treat smaller LinkedIn-friendly batches such as `25` as the safer operator default for backlog drain
- if LinkedIn pressure is the blocker, it is reasonable to drain Indeed separately after the LinkedIn-sensitive portion settles down

C1 (Hunter) completion checklist:
- discovery quality is acceptable in production
  - especially for Indeed, where broad board matches should no longer flood the queue with unrelated retail/store jobs
- the backlog is drained or reduced to a normal steady-state queue
  - manual backfill should no longer be the dominant operating mode
- at least one real blocked/browser-fixable failure is observed end-to-end with saved artifacts
  - screenshot/HTML/text files exist
  - the review app links to them correctly
- Stage 6 deployment is reproducible without manual container cleanup
  - **C1 (Hunter)** runtime (`hunter/` package) and review app should update correctly from Ansible alone
- scheduled scrape runs and post-scrape enrichment behave predictably on `server2`
  - timer on/off flow is documented
  - batch size, retry timing, and UI-fallback defaults feel stable in practice

C1 sign-off runbook on `server2`:
1. deploy the latest Hunt repo and latest `ansible_homelab` Stage 6 changes
2. verify the deployed runtime shape and auth health
   - `systemctl cat hunt-scraper.service | grep HUNT_ARTIFACTS_DIR`
   - `curl -s https://agent-hunt-review.mshi.ca/metrics | head`
   - `cd ~/hunt && set -a && source .env && set +a && .venv/bin/python hunter/linkedin_session.py --auto-relogin --channel chrome`
   - if you need a visible browser for auth debugging:
     - `cd ~/hunt && DISPLAY=:98 ./hunter.sh auth-auto-relogin --headful --display :98 --channel chrome`
   - `curl -s https://agent-hunt-review.mshi.ca/metrics | grep 'hunt_auth_available{source="linkedin"}'`
3. requeue failed/blocked enrichment rows you want retried
   - `./hunter.sh retry`
   - `./hunter.sh requeue-enrich --source all`
4. drain the backlog manually first
   - safer current default:
     - `DISPLAY=:98 ./hunter.sh backfill-all 25`
   - if LinkedIn looks healthy and you want a more aggressive run:
     - `DISPLAY=:98 ./hunter.sh backfill-all`
   - `DISPLAY=:98 ./hunter.sh drain`
   - `DISPLAY=:98 ./hunter.sh backfill 100 --source all --ui-verify-blocked --yes`
   - if Indeed still needs additional cleanup after the LinkedIn-sensitive portion:
     - `DISPLAY=:98 ./hunter.sh backfill 100 --source indeed --ui-verify-blocked --yes`
5. confirm queue health after the manual drain
   - `./hunter.sh queue`
   - `./.venv/bin/python scripts/queue_health.py --json`
6. if a real blocked/browser-fixable row occurs, confirm the artifact path end to end
   - files exist under `/home/michael/data/hunt/artifacts`
   - the review app job page links to them
7. re-enable the unattended timer
   - `./hunter.sh start` (or legacy `./hunter.sh auto-on`)
   - `./hunter.sh auto-status`
8. observe at least one normal scheduled cycle
   - it should scrape and then run post-scrape enrichment up to the configured batch limit
9. only after those checks pass, treat C1 (Hunter) as operationally complete

Stage 4 non-goals:
- no C2 (Fletcher) resume tailoring work yet
- no C3 (Executioner) application submission work yet
- no attempt to bypass CAPTCHA or anti-bot systems

## Notes For Later Components

**C2 (Fletcher)** : resume tailoring (`fletcher/`)
- should consume enriched descriptions, not raw board snippets
- should only run after C1 (Hunter) marks a job ready

**C3 (Executioner)** : browser autofill and apply assistance (extension)
- should only open jobs where `apply_type = 'external_apply'`
- should not attempt LinkedIn Easy Apply jobs
- should prefer ATS URLs over board URLs

**C4 (Coordinator)** : orchestration and submit control (`coordinator/`)
- should fetch one explicit apply context for a chosen `job_id`
- should not re-decide resume selection if C2 has already selected a downstream resume
- should invoke C3 (Executioner) rather than absorb C3 behavior into orchestration prompts

## Important Constraints

- LinkedIn markup changes frequently
- browser enrichment is slower than board discovery
- not every external apply flow will resolve on the first try
- some jobs may redirect through tracking URLs before landing on the ATS
- a real external application URL may not exist for LinkedIn-hosted applications

## Verification Expectations

Every stage should be tested before moving to the next one.

The preferred verification style is:
- one command block that can be pasted and run at once
- DB output that clearly shows the changed fields
- no claim that a stage is done until the code and DB behavior are both verified
