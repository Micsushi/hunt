# Component 1 : Posting Discovery And Multi-Source Enrichment

## Goal

Complete Component 1 so the system can:
- discover new jobs continuously
- store the listing URL
- store the real external application URL when available
- store a usable job description
- classify LinkedIn Easy Apply jobs so they are never sent to later automation

LinkedIn is the priority source even if other sources remain enabled.

## Current State

Discovery already exists in `scraper/scraper.py`.
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
- Component 1 deploys through the current Hunt-focused Ansible step/stage
  - today that is the `job_agent` Stage 6 deployment in `ansible_homelab`
- Component 2 should deploy in its own later Ansible step/stage
- Component 3 should deploy in its own later Ansible step/stage
- Component 4 / OpenClaw integration should deploy in its own later Ansible step/stage

Do not treat Component 2 or Component 3 as extensions of the current Component 1 Stage 6 deploy.

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
- `scraper/db.py`
- `scraper/scraper.py`

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
- `scraper/enrich_linkedin.py`
- `scraper/linkedin_session.py`
- `scraper/url_utils.py`

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
- on Linux/server deployments, installing the Python `playwright` package is not sufficient by itself
- after dependency install, also run `python -m playwright install chromium` so the browser binaries exist under the runtime user's Playwright cache
- if a manual test is interrupted and leaves a row stuck in `processing`, rerun that same job with `--force`
- if you want to explicitly re-check a blocked or flaky row in a visible browser, rerun that specific job with `--ui-verify`
- if you want a batch run to do a normal first pass and then automatically rerun only browser-fixable failures in a visible browser, use `--ui-verify-blocked`
- if older sparse `failed/unknown` rows need another pass with the newer Stage 2 logic, requeue them with `python scripts/requeue_linkedin_refresh_candidates.py`

### Stage 3 : batch enrichment and runner integration

Implemented files:
- `scraper/enrich_linkedin.py`
- `scraper/enrichment_policy.py`
- `scraper/db.py`
- `scraper/scraper.py`
- `scraper/runner.py`
- `review_app.py`
- `scripts/queue_health.py`

Implemented behavior:
- batch processing for pending and retry-due LinkedIn rows
- post-scrape enrichment inside `scraper.py`
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
- see `docs/components/component1/stage3_server2_plan.md`

Testing goal:
- process a small batch safely
- confirm the queue drains without corrupting rows
- blocked ATS pages should fail cleanly without storing anti-bot challenge text as the description
- for a larger staged run, `python scraper/enrich_linkedin.py --limit 100 --channel chrome --ui-verify-blocked` should do a normal first pass and then a second UI-verification pass only for blocked rows

Useful commands:
- run discovery and then enrich pending LinkedIn rows with the default configured batch size:
  `python scraper/scraper.py`
- run discovery and then enrich up to 100 pending LinkedIn rows right away:
  `python scraper/scraper.py --enrich-pending --enrich-limit 100 --channel chrome`
- run discovery and then do a second visible-browser pass for blocked rows:
  `python scraper/scraper.py --enrich-pending --enrich-limit 100 --channel chrome --ui-verify-blocked`
- for `server2`, the intended deployment is to keep that blocked-row UI fallback enabled, but run it on a separate virtual display such as `Xvfb :98` so it does not steal the main desktop foreground
- enrich existing pending LinkedIn rows already in the DB without doing a new discovery scrape:
  `python scraper/enrich_linkedin.py --limit 100 --channel chrome`

### Stage 3.2 : multi-source enrichment on top of the Stage 3 runtime

Implemented files:
- `scraper/enrich_jobs.py`
- `scraper/enrich_indeed.py`
- `scraper/db.py`
- `scraper/scraper.py`
- `scraper/runner.py`
- `review_app.py`
- `scripts/queue_health.py`
- `scripts/huntctl.py`
- `tests/test_stage32.py`

Implemented behavior:
- reuse the same enrichment columns for LinkedIn and Indeed
- reuse the same retry scheduling, stale-processing recovery, and claim/update flow
- keep one jobs table and one review app
- dispatch post-scrape enrichment by source priority:
  - LinkedIn first
  - Indeed second
- mark newly discovered Indeed rows as `pending` so they enter the same queue model
- add an Indeed enrichment worker that:
  - opens the Indeed job page with HTTP + HTML parsing
  - extracts a usable description
  - resolves an external apply URL when one is discoverable
  - keeps `apply_url` pointed at the external destination rather than leaving it on an Indeed-hosted intermediate URL when redirect resolution succeeds
  - stores `apply_url`, `apply_host`, `ats_type`, `apply_type`, and `enrichment_status`
- add a shared browser runtime so supported sources can reuse one UI/browser fallback layer instead of duplicating Playwright setup
- allow Indeed to use a visible browser rerun for browser-fixable failures while still preferring the cheaper non-UI path first
- apply an Indeed-only category-aware title gate during discovery so broad Indeed matches like retail/cashier/store-associate rows are dropped before they enter the queue
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

Short wrappers are now available at the repo root:
- Windows PowerShell:
  `.\hunt.ps1 <command>`
- Windows cmd:
  `hunt.cmd <command>`
- Linux/macOS:
  `./hunt.sh <command>`

Launcher note:
- the repo-root wrapper files are now thin shims
- the real launcher implementations live under:
  - `scripts/launchers/hunt.ps1`
  - `scripts/launchers/hunt.cmd`
  - `scripts/launchers/hunt.sh`

Common examples:
- queue health:
  `.\hunt.ps1 queue`
  `./hunt.sh queue`
- run multi-source enrichment directly:
  `.\hunt.ps1 enrich --source all --limit 25 --channel chrome`
  `./hunt.sh enrich --source all --limit 25 --channel chrome`
- run Indeed-only enrichment:
  `.\hunt.ps1 enrich --source indeed --limit 25`
  `./hunt.sh enrich --source indeed --limit 25`
- force one visible-browser rerun for a specific Indeed row:
  `.\hunt.ps1 enrich --source indeed --job-id 13143 --force --ui-verify`
  `./hunt.sh enrich --source indeed --job-id 13143 --force --ui-verify`
- list newest ready rows:
  `.\hunt.ps1 ready --limit 10`
  `./hunt.sh ready --limit 10`
- list jobs across sources:
  `.\hunt.ps1 jobs --source all --status ready --limit 10`
  `./hunt.sh jobs --source all --status ready --limit 10`
- list Indeed rows only:
  `.\hunt.ps1 jobs --source indeed --status all --limit 10`
  `./hunt.sh jobs --source indeed --status all --limit 10`
- preview currently stored irrelevant Indeed rows using the current title filter:
  `./hunt.sh clean-indeed`
  `./hunt.sh cleanup-indeed`
- delete currently stored irrelevant Indeed rows:
  `./hunt.sh clean-indeed --apply`
  `./hunt.sh cleanup-indeed --apply`
- inspect one job:
  `.\hunt.ps1 job 13179`
  `./hunt.sh job 13179`
- run local review app:
  `.\hunt.ps1 review`
  `./hunt.sh review`
- run a controlled backfill in 100-row chunks with a checkpoint after each batch:
  `.\hunt.ps1 backfill --ui-verify-blocked`
  `./hunt.sh backfill --ui-verify-blocked`
- run a controlled backfill for Indeed only in 100-row chunks:
  `.\hunt.ps1 backfill --source indeed --ui-verify-blocked`
  `./hunt.sh backfill --source indeed --ui-verify-blocked`
- run a controlled backfill for all supported sources in 100-row chunks:
  `.\hunt.ps1 backfill --source all --ui-verify-blocked`
  `./hunt.sh backfill --source all --ui-verify-blocked`
- requeue the common retryable enrichment rows across all sources:
  `./hunt.sh retry`
  `./hunt.sh requeue-enrich --source all`
- backfill all sources in 100-row batches with blocked-row UI verification and automatic continue:
  `DISPLAY=:98 ./hunt.sh backfill-all`
  `DISPLAY=:98 ./hunt.sh drain`
  `DISPLAY=:98 ./hunt.sh backfill 100 --source all --ui-verify-blocked --yes`
- backfill all with a custom batch size:
  `DISPLAY=:98 ./hunt.sh backfill-all 250`
  `DISPLAY=:98 ./hunt.sh drain 250`
- backfill all but stop after each batch for confirmation:
  `DISPLAY=:98 ./hunt.sh backfill-all --ask`
  `DISPLAY=:98 ./hunt.sh drain --ask`
- run a controlled backfill in custom chunk sizes:
  `.\hunt.ps1 backfill 250 --ui-verify-blocked`
  `./hunt.sh backfill 250 --ui-verify-blocked`
- run backfill for a selected set of job ids only:
  `.\hunt.ps1 backfill --source all --job-id 13143 --job-id 13073`
  `./hunt.sh backfill --source all --job-id 13143 --job-id 13073`
- save LinkedIn auth state on a Linux desktop session:
  `./hunt.sh auth-save --display :0`
- start one manual server scrape cycle:
  `./hunt.sh svc-start`
- follow live service logs on the server:
  `./hunt.sh svc-follow`
- stop the timer on the server:
  `./hunt.sh timer-stop`
  `./hunt.sh timer-disable`
- pause automatic scrape/enrich cycles on the server:
  `./hunt.sh auto-off`
- resume automatic scrape/enrich cycles on the server:
  `./hunt.sh auto-on`
- check whether the automatic timer is paused or running:
  `./hunt.sh auto-status`

### Session setup

- save LinkedIn auth state:
  `python scraper/linkedin_session.py --save-storage-state --channel chrome`
- check whether the saved LinkedIn auth state exists:
  `python scraper/linkedin_session.py --check`

### Stage 1 verification

- run the Stage 1 unit tests:
  `python -m unittest discover -s tests -p "test_stage1.py" -v`
- run a syntax check:
  `python -m compileall scraper tests`
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
  `python scraper/enrich_linkedin.py --limit 100 --channel chrome --ui-verify-blocked`
- run a controlled backfill across supported sources in chunks and stop for operator confirmation after each chunk:
  `python scripts/backfill_enrichment.py 100 --source all --ui-verify-blocked`
- run a controlled backfill for selected rows only:
  `python scripts/backfill_enrichment.py --source all --job-id 13143 --job-id 13073`
- browse the live review/control-plane app:
  `python review_app.py`
- smoke-test integrated discovery plus newest-first enrichment:
  `python scraper/scraper.py --enrich-pending --enrich-limit 5 --channel chrome`
- confirm the ready queue still shows the newest rows first after the smoke test:
  `python scripts/list_linkedin_enrichment_queue.py --status ready --limit 10`
- do one continuous-loop sanity check before deployment:
  `python scraper/runner.py`

### Requeue and refresh

- requeue older sparse LinkedIn failures for another Stage 2 pass:
  `python scripts/requeue_linkedin_refresh_candidates.py`
- bulk requeue failed/blocked enrichment rows across supported sources back to `pending`:
  `./hunt.sh requeue-enrich --source all`
- if you also want to requeue stale `processing` rows manually:
  `./hunt.sh requeue-enrich --source all --status failed --status blocked --status blocked_verified --status processing`
- if a deployment bug caused broad false negatives, requeue only the likely-bugged LinkedIn failures instead of all failed rows:
  `sqlite3 /home/michael/data/hunt/hunt.db "update jobs set enrichment_status='pending', last_enrichment_error=NULL, next_enrichment_retry_at=NULL, last_enrichment_started_at=NULL where source='linkedin' and enrichment_status='failed' and (last_enrichment_error like 'external_description_not_usable:%' or last_enrichment_error like 'external_description_not_found:%' or last_enrichment_error like 'apply_button_not_found:%' or last_enrichment_error like 'unexpected_error:%');"`
- rerun a specific row even if it is not currently pending:
  `python scraper/enrich_linkedin.py --job-id <ID> --channel chrome --force`
- re-check one blocked or flaky row in a visible browser:
  `python scraper/enrich_linkedin.py --job-id <ID> --channel chrome --ui-verify`

### Debugging notes from server2 rollout

- a saved LinkedIn session plus the Python Playwright package does not guarantee browser automation will run
- if Playwright reports `Executable doesn't exist`, install the browser binaries with:
  `python -m playwright install chromium`
- on `server2`, the live DB is expected at `/home/michael/data/hunt/hunt.db`, not inside the repo checkout
- if a manual LinkedIn-only debug command can see the full `About the job` text but `scraper/enrich_linkedin.py` still reports `description_not_found`, verify the deployed repo actually contains the latest extractor fallback code before requeueing large batches
- the same browser-binary requirement also applies to Indeed `--ui-verify` and `--ui-verify-blocked` runs because they use the shared Playwright browser runtime
- for Indeed rows, `apply_url` should resolve to the off-Indeed destination when possible; if manual checks only show an Indeed-hosted link, verify whether the row was enriched before the latest redirect-resolution logic was deployed

### Enrichment runs

- enrich one specific LinkedIn row:
  `python scraper/enrich_linkedin.py --job-id <ID> --channel chrome`
- enrich one specific LinkedIn row in a visible browser:
  `python scraper/enrich_linkedin.py --job-id <ID> --headful --channel chrome`
- enrich a batch of pending LinkedIn rows:
  `python scraper/enrich_linkedin.py --limit 100 --channel chrome`
- enrich a batch and then UI-verify only blocked rows:
  `python scraper/enrich_linkedin.py --limit 100 --channel chrome --ui-verify-blocked`
- enrich a batch of pending Indeed rows:
  `python scraper/enrich_indeed.py --limit 100`
- enrich a batch of pending Indeed rows and then rerun only browser-fixable failures visibly:
  `python scraper/enrich_indeed.py --limit 100 --channel chrome --ui-verify-blocked`
- enrich one specific Indeed row in a visible browser:
  `python scraper/enrich_indeed.py --job-id <ID> --force --channel chrome --ui-verify`
- enrich a multi-source batch with LinkedIn priority first:
  `python scraper/enrich_jobs.py --limit 100 --channel chrome --ui-verify-blocked`
- inspect Stage 3 queue health:
  `python scripts/queue_health.py`

### Discovery plus enrichment

- run discovery only:
  `python scraper/scraper.py --skip-enrichment`
- run discovery and then enrich pending LinkedIn rows:
  `python scraper/scraper.py`
- run discovery and then enrich up to 100 pending supported rows with LinkedIn priority first:
  `python scraper/scraper.py --enrich-pending --enrich-limit 100 --channel chrome`
- run discovery and then do a second UI pass for blocked rows:
  `python scraper/scraper.py --enrich-pending --enrich-limit 100 --channel chrome --ui-verify-blocked`
- run the continuous server loop:
  `python scraper/runner.py`
- start the browser-facing review/control-plane app locally:
  `python review_app.py`
- expose the review app with uvicorn explicitly if preferred:
  `uvicorn review_app:app --host 127.0.0.1 --port 8000`

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
- review-surface visibility for artifacts
  - the job detail page now shows saved artifact paths and links for screenshot/HTML/text snapshots when present
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

Component 1 completion checklist:
- discovery quality is acceptable in production
  - especially for Indeed, where broad board matches should no longer flood the queue with unrelated retail/store jobs
- the backlog is drained or reduced to a normal steady-state queue
  - manual backfill should no longer be the dominant operating mode
- at least one real blocked/browser-fixable failure is observed end-to-end with saved artifacts
  - screenshot/HTML/text files exist
  - the review app links to them correctly
- Stage 6 deployment is reproducible without manual container cleanup
  - scraper runtime and review app should update correctly from Ansible alone
- scheduled scrape runs and post-scrape enrichment behave predictably on `server2`
  - timer on/off flow is documented
  - batch size, retry timing, and UI-fallback defaults feel stable in practice

C1 sign-off runbook on `server2`:
1. deploy the latest Hunt repo and latest `ansible_homelab` Stage 6 changes
2. verify the deployed runtime shape
   - `systemctl cat hunt-scraper.service | grep HUNT_ARTIFACTS_DIR`
   - `curl -s https://agent-hunt-review.mshi.ca/metrics | head`
3. requeue failed/blocked enrichment rows you want retried
   - `./hunt.sh retry`
   - `./hunt.sh requeue-enrich --source all`
4. drain the backlog manually first
   - safer current default:
     - `DISPLAY=:98 ./hunt.sh backfill-all 25`
   - if LinkedIn looks healthy and you want a more aggressive run:
     - `DISPLAY=:98 ./hunt.sh backfill-all`
   - `DISPLAY=:98 ./hunt.sh drain`
   - `DISPLAY=:98 ./hunt.sh backfill 100 --source all --ui-verify-blocked --yes`
   - if Indeed still needs additional cleanup after the LinkedIn-sensitive portion:
     - `DISPLAY=:98 ./hunt.sh backfill 100 --source indeed --ui-verify-blocked --yes`
5. confirm queue health after the manual drain
   - `./hunt.sh queue`
   - `./.venv/bin/python scripts/queue_health.py --json`
6. if a real blocked/browser-fixable row occurs, confirm the artifact path end to end
   - files exist under `/home/michael/data/hunt/artifacts`
   - the review app job page links to them
7. re-enable the unattended timer
   - `./hunt.sh auto-on`
   - `./hunt.sh auto-status`
8. observe at least one normal scheduled cycle
   - it should scrape and then run post-scrape enrichment up to the configured batch limit
9. only after those checks pass, treat Component 1 as operationally complete

Stage 4 non-goals:
- no Component 2 resume tailoring work yet
- no Component 3 application submission work yet
- no attempt to bypass CAPTCHA or anti-bot systems

## Notes For Later Components

Component 2 : resume tailoring
- should consume enriched descriptions, not raw board snippets
- should only run after Component 1 marks a job ready

Component 3 : browser autofill and apply assistance
- should only open jobs where `apply_type = 'external_apply'`
- should not attempt LinkedIn Easy Apply jobs
- should prefer ATS URLs over board URLs

Component 4 : orchestration and submit control
- should fetch one explicit apply context for a chosen `job_id`
- should not re-decide resume selection if C2 has already selected a downstream resume
- should invoke Component 3 rather than absorb C3 behavior into orchestration prompts

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
