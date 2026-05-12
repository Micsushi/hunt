# C1 Hunter: Overview

Updated: 2026-05-12

This document explains what C1 does, how it is structured, what is working,
and what still needs attention. It is written for a human operator or
developer working on the Hunt system.

## What C1 Is

C1 is the discovery and enrichment service for Hunt. It finds job postings,
fetches full descriptions and external apply URLs, and classifies each job
so downstream automation knows whether to proceed.

The safety model is simple:

- LinkedIn Easy Apply jobs are classified and excluded from automation. They
  are never retried by C3 or C4.
- Terminal failures like removed jobs are recorded, not retried.
- Read-only queue tools never mutate queue state.
- C1 must remain runnable from terminal without C0, C2, C3, or C4.

## Code Structure

C1 lives in `hunter/`. Key modules:

- `hunter/scraper.py`: discovery entrypoint. JobSpy-backed LinkedIn + Indeed search.
- `hunter/search_lanes.py`: title keyword filter. Trims rows not matching lane.
- `hunter/enrich_linkedin.py`: LinkedIn Playwright enrichment, single-job worker.
- `hunter/enrich_indeed.py`: Indeed enrichment, HTTP path with browser fallback.
- `hunter/enrichment_dispatch.py`: source-aware enrichment queue, LinkedIn-first.
- `hunter/enrichment_policy.py`: batch retry and backoff policy.
- `hunter/linkedin_session.py`: LinkedIn auth state management and auto-relogin.
- `hunter/browser_runtime.py`: shared Playwright browser across sources.
- `hunter/user_config.py`: load/save/patch `hunt_user_config.json`. Thread-safe.
  Priority: env var > file > hardcoded default.
- `hunter/service.py`: FastAPI service on port 8001. Includes C1 config endpoints.
- `hunter/db.py`: C1 table writes (jobs, runtime_state, linkedin_accounts).

## Step 1: Discover Jobs

What happens:

- C1 runs JobSpy against configured search terms, locations, and sites.
- Results are title-filtered by `hunter/search_lanes.py` against the active lane.
- New rows are inserted into the `jobs` table with `status = new` and
  `enrichment_status = pending`.
- Duplicate job URLs are skipped. `job_url` is the dedupe key.

Tools used:

- JobSpy
- `hunter/scraper.py`
- `hunter/search_lanes.py`
- `jobs` table (discovery fields)

Status:

- LinkedIn and Indeed discovery working.
- Lane title filter tested and running.
- Legacy lane-mismatch rows can be purged with `hunter clean-lane-mismatch`.

## Step 2: Queue Enrichment

What happens:

- After discovery, C1 enqueues newly discovered rows for enrichment.
- LinkedIn rows are dispatched before Indeed rows within each batch.
- Batch size defaults to 25, LinkedIn-safe.
- Stale `processing` rows are recovered before the next batch starts.

Tools used:

- `hunter/enrichment_dispatch.py`
- `hunter/enrichment_policy.py`
- `jobs` table (`enrichment_status`)

Status:

- Source-aware LinkedIn-first dispatch working.
- Stale processing recovery working.
- Rate limiting risk on large batches. Keep batch size at 25 unless tested.

## Step 3: Enrich LinkedIn Jobs

What happens:

- C1 opens the LinkedIn job page in a Playwright browser.
- It extracts the full description and best-known external apply URL.
- It checks for Easy Apply and records `apply_type = easy_apply` or
  `apply_type = external_apply`.
- It captures `apply_host` and `ats_type` from the external apply URL.
- On block or failure it saves a screenshot, HTML, and text artifact.

Tools used:

- `hunter/enrich_linkedin.py`
- `hunter/linkedin_session.py`
- `hunter/browser_runtime.py`
- Playwright Chromium

Status:

- Working. Easy Apply detection and external apply URL capture working.
- LinkedIn auth state management and auto-relogin working.
- Failure artifact capture working (screenshot, HTML, text saved to DB fields).
- Headful rerun available via `ENRICHMENT_UI_VERIFY_BLOCKED=true` for blocked rows.
- Multi-account rotation working. 7-day blocked cooldown per account.

## Step 4: Enrich Indeed Jobs

What happens:

- C1 tries an HTTP fetch path first for Indeed job pages.
- If HTTP fails it falls back to a Playwright browser session.
- Description and apply URL are extracted and written to the `jobs` table.

Tools used:

- `hunter/enrich_indeed.py`
- `hunter/browser_runtime.py`
- HTTP client + Playwright fallback

Status:

- Working for the tested paths.
- Less battle-tested than LinkedIn enrichment.

## Step 5: Classify And Flag

What happens:

- `enrichment_status` is set to `done` when description is captured.
- `auto_apply_eligible` is set to 0 for Easy Apply and 1 for external apply.
- Watchlist jobs trigger a Discord alert if they match configured keywords.
- High enrichment failure rate triggers a Discord alert.

Tools used:

- `jobs` table enrichment fields
- `shared/notifications.py`
- `hunter/notifications.py`

Status:

- Classification working. Easy Apply exclusion working.
- Discord alerts working for priority jobs and failure rate thresholds.

## What Is Verified

- C1 CI passes. Full endpoint test coverage.
- LinkedIn and Indeed discovery and enrichment run against server2 production.
- Easy Apply detection and auto_apply_eligible exclusion confirmed working.
- Multi-account rotation and 7-day blocked cooldown confirmed.
- Failure artifact capture (screenshot, HTML, text) confirmed.
- Stale processing recovery confirmed.
- Discord alerts tested via `hunter test-discord` and Settings UI button.
- User config file load/save/patch working. Settings UI PATCH /config working.
- CLI covers 60+ subcommands. Windows + Linux standalone CLI validated.
- Windows local Docker deploy confirmed viable. Scheduler runs every 10 min.
- Auth state and artifacts bind-mounted to `.hunt-state/` / `.hunt-data/`.

## What Is Still Untested Or Risky

- Verify Easy Apply filtering with a real live easy_apply row in production DB.
  Code done, need a real row to run `hunter verify-easy-apply <id>`.
- First-run Windows deploy requires `auth-save` before scheduler can enrich.
- Xvfb headful recovery not available in Docker image. Xvfb not installed in
  `Dockerfile.hunter`.
- External UI access from Windows local requires Cloudflare Tunnel or ngrok.
- Steady-state timer validation: watch one full scrape + enrichment cycle and
  confirm queue counts stay stable.
- Ansible Stage 6 clean deploy reproducible without manual container repair.

## Human Commands

Run C1 CI:

```powershell
python ci.py c1
```

Trigger a discovery run:

```powershell
.\hunter.ps1 scrape
```

Run a batch enrichment:

```powershell
.\hunter.ps1 drain
```

Check queue health:

```powershell
.\hunter.ps1 queue
```

Retry failed rows:

```powershell
.\hunter.ps1 retry
```

Clean legacy lane-mismatch rows:

```powershell
.\hunter.ps1 clean-lane-mismatch --apply
```

Turn on auto-scrape scheduler:

```powershell
.\hunter.ps1 auto-on
.\hunter.ps1 auto-status
```
