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
- if older sparse `failed/unknown` rows need another pass with the newer Stage 2 logic, requeue them with `python scripts/requeue_linkedin_refresh_candidates.py`

### Stage 3 : batch enrichment and runner integration

Planned changes:
- batch processing already exists in `scraper/enrich_linkedin.py`
- integrate enrichment after discovery inside `scraper/runner.py`
- add retry limits and backoff
- record failure categories like `auth_expired`, `layout_changed`, `rate_limited`, `job_removed`, `security_verification`

Testing goal:
- process a small batch safely
- confirm the queue drains without corrupting rows
- blocked ATS pages should fail cleanly without storing anti-bot challenge text as the description

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
