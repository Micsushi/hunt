# Component 1 : Posting Discovery And LinkedIn Enrichment

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
The discovery script can now optionally trigger a follow-up LinkedIn enrichment pass immediately after it writes rows to SQLite.

What Stage 1 changed:
- `job_url` now represents the discovered listing URL
- `apply_url` now represents the best-known external application URL
- new LinkedIn metadata columns were added for enrichment
- existing LinkedIn rows were marked `enrichment_status = 'pending'`
- old fake LinkedIn `apply_url` values that simply copied `job_url` were cleared

Why this matters:
- later automation must not confuse a LinkedIn listing page with an external ATS application URL
- `status` remains reserved for actual application lifecycle

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

Planned files:
- `scraper/enrich_linkedin.py`
- `scraper/linkedin_session.py`
- `scraper/url_utils.py`

Worker responsibilities:
- claim one pending LinkedIn row
- open `job_url` in Playwright using saved auth state
- expand description and store it
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
- if a manual test is interrupted and leaves a row stuck in `processing`, rerun that same job with `--force`
- if you want to explicitly re-check a blocked or flaky row in a visible browser, rerun that specific job with `--ui-verify`
- if you want a batch run to do a normal first pass and then automatically rerun blocked rows in a visible browser, use `--ui-verify-blocked`
- if older sparse `failed/unknown` rows need another pass with the newer Stage 2 logic, requeue them with `python scripts/requeue_linkedin_refresh_candidates.py`

### Stage 3 : batch enrichment and runner integration

Planned changes:
- batch processing already exists in `scraper/enrich_linkedin.py`
- `scraper/runner.py` now calls discovery and then a post-scrape LinkedIn enrichment pass each cycle
- `scraper/scraper.py` can now do the same thing for one-off manual runs
- add retry limits and backoff
- record failure categories like `auth_expired`, `layout_changed`, `rate_limited`, `job_removed`, `security_verification`

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
- enrich existing pending LinkedIn rows already in the DB without doing a new discovery scrape:
  `python scraper/enrich_linkedin.py --limit 100 --channel chrome`

## Command Reference

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
- list pending LinkedIn rows:
  `python scripts/list_linkedin_enrichment_queue.py --status pending --limit 10`
- inspect one LinkedIn row:
  `python scripts/show_linkedin_job.py --job-id <ID>`
- verify one enriched LinkedIn row:
  `python scripts/verify_stage2_job.py --job-id <ID>`
- verify one enriched LinkedIn row with a specific expected apply type:
  `python scripts/verify_stage2_job.py --job-id <ID> --expect-type external_apply`

### Requeue and refresh

- requeue older sparse LinkedIn failures for another Stage 2 pass:
  `python scripts/requeue_linkedin_refresh_candidates.py`
- rerun a specific row even if it is not currently pending:
  `python scraper/enrich_linkedin.py --job-id <ID> --channel chrome --force`
- re-check one blocked or flaky row in a visible browser:
  `python scraper/enrich_linkedin.py --job-id <ID> --channel chrome --ui-verify`

### Enrichment runs

- enrich one specific LinkedIn row:
  `python scraper/enrich_linkedin.py --job-id <ID> --channel chrome`
- enrich one specific LinkedIn row in a visible browser:
  `python scraper/enrich_linkedin.py --job-id <ID> --headful --channel chrome`
- enrich a batch of pending LinkedIn rows:
  `python scraper/enrich_linkedin.py --limit 100 --channel chrome`
- enrich a batch and then UI-verify only blocked rows:
  `python scraper/enrich_linkedin.py --limit 100 --channel chrome --ui-verify-blocked`

### Discovery plus enrichment

- run discovery only:
  `python scraper/scraper.py --skip-enrichment`
- run discovery and then enrich pending LinkedIn rows:
  `python scraper/scraper.py`
- run discovery and then enrich up to 100 pending LinkedIn rows:
  `python scraper/scraper.py --enrich-pending --enrich-limit 100 --channel chrome`
- run discovery and then do a second UI pass for blocked rows:
  `python scraper/scraper.py --enrich-pending --enrich-limit 100 --channel chrome --ui-verify-blocked`
- run the continuous server loop:
  `python scraper/runner.py`

### Stage 4 : hardening and backfill

Planned changes:
- backfill old LinkedIn rows in batches
- add screenshots or saved HTML for hard failures
- add monitoring counters and queue health checks
- document server setup for Playwright auth state and Chromium dependencies

Testing goal:
- complete a controlled backfill
- confirm failure handling and retry behavior

## Notes For Later Components

Component 2 : resume tailoring
- should consume enriched descriptions, not raw board snippets
- should only run after Component 1 marks a job ready

Component 3 : application automation
- should only open jobs where `apply_type = 'external_apply'`
- should not attempt LinkedIn Easy Apply jobs
- should prefer ATS URLs over board URLs

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
