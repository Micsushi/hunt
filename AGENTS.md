# Hunt : Repo Instructions

## Project Goal

Build a fully automated job application system that runs continuously on a Linux server.

The long-term flow is:
- **C1 (Hunter)** : discover and enrich job postings (`hunter/` package)
- **C2 (Trapper)** : tailor a LaTeX resume to each posting (`trapper/`)
- **C3 (Executioner)** : browser autofill and apply assistance (extension)
- **C4 (Coordinator)** : orchestration and submit control (`coordinator/`)

Canonical naming: **`docs/NAMING.md`**. The old **`scraper/`** package directory was renamed to **`hunter/`**; **`hunter/scraper.py`** is only the discovery entrypoint filename.

Current focus:
- C1 (Hunter) Stage 4 hardening, backlog drain, and deployment polish
- prioritize LinkedIn over every other source in enrichment dispatch
- classify LinkedIn Easy Apply during enrichment (`easy_apply`, `auto_apply_eligible = 0`) so later automation does not treat them as external-apply targets
- keep **C1 (Hunter)** deployment separate from later **C2 (Trapper)** and **C3 (Executioner)** deployment steps in Ansible

## Repo Overview

This repo currently implements **C1 (Hunter)** discovery plus multi-source enrichment with LinkedIn-first priority.

Main files:
- `hunter/scraper.py` : C1 (Hunter) discovery entrypoint (historical filename; discovers jobs and writes them to SQLite)
- `hunter/runner.py` : loop runner for continuous discovery/enrichment cycles
- `hunter/db.py` : schema, migration, and DB helpers
- `hunter/config.py` : search terms, locations, watchlist, and run interval
- `hunter/browser_runtime.py` : shared Playwright browser/context runtime for supported UI fallback flows
- `hunter/enrich_linkedin.py` : LinkedIn enrichment worker and batch runner
- `hunter/enrich_indeed.py` : Indeed enrichment worker and batch runner
- `hunter/enrichment_dispatch.py` : central enrichment routing by `jobs.source` (priority, per-source auth)
- `hunter/enrich_jobs.py` : CLI entrypoint; delegates to `enrichment_dispatch.run_enrichment_round`
- `hunter/enrichment_policy.py` : retry/backoff policy for unattended enrichment
- `hunter/linkedin_session.py` : LinkedIn Playwright auth-state management
- `hunter/url_utils.py` : URL normalization and ATS detection helpers
- `review_app.py` : browser-facing review/control-plane app for the live queue
- `agents/system_prompt.md` : agent contract for downstream apply/orchestration work

## Current Data Model Rules

- `job_url` is the listing URL where the job was discovered
- `apply_url` is the best-known external application URL
- for historical LinkedIn rows, mirrored `apply_url = job_url` values are cleared during migration because they are not real off-platform application links
- `job_url` remains the dedup key for now
- `status` is only for application lifecycle state like `new`, `claimed`, `applied`, `failed`, `skipped`
- LinkedIn enrichment state must not be stored in `status`

LinkedIn-specific enrichment columns:
- `apply_type` : `external_apply`, `easy_apply`, or `unknown`
- `auto_apply_eligible` : `1` only when the job uses external apply
- `enrichment_status` : `pending`, `processing`, `done`, or `failed`
- `enrichment_attempts` : retry counter
- `enriched_at` : timestamp of the last successful enrichment
- `last_enrichment_error` : last failure reason
- `apply_host` : hostname of the external destination
- `ats_type` : `greenhouse`, `lever`, `workday`, `ashby`, `smartrecruiters`, `jobvite`, `icims`, `bamboohr`, or `unknown`
- `last_enrichment_started_at` : timestamp of the current/last claim start for stale-processing recovery
- `next_enrichment_retry_at` : next unattended retry time for retryable failures

## Business Rules

- `priority = 1` jobs are for manual application by the user only
- automation should only act on `priority = 0` jobs unless the user explicitly says otherwise
- LinkedIn Easy Apply jobs are not targets for downstream apply automation
- if a LinkedIn job is detected as Easy Apply during enrichment, classify it (`apply_type`, `auto_apply_eligible`) so later stages never treat it like an external ATS apply
- C1 (Hunter) should discover and enrich jobs only : it should not submit applications

## Current Stage Plan

Stage 1 : completed
- added enrichment-ready DB columns
- updated C1 listing vs apply URL semantics (`job_url` vs `apply_url`)
- marked historical LinkedIn rows as pending enrichment

Stage 2 : completed
- added a one-job Playwright LinkedIn enrichment worker using a logged-in session
- extracts LinkedIn/external descriptions
- detects `Easy Apply` vs external `Apply`
- saves external application URL when present
- supports blocked/UI verification flows

Stage 3 : completed
- hardened batch enrichment for unattended server use
- finalized retry/backoff and terminal-state policy
- documented and supported the `server2` deployment/runtime model
- added a browser-facing review/control-plane service for manual review
- kept the flow ready for later C2 (Trapper)/C3 (Executioner) agents

Stage 3.2 : completed
- generalized the enrichment queue/runtime to support LinkedIn and Indeed
- added shared browser-runtime support for UI/browser fallback
- expanded the review app into a source-aware whole-job-table control plane

Current repo-side runtime notes:
- newly discovered pending LinkedIn rows are prioritized ahead of older backlog rows during post-scrape enrichment
- read-only queue tools and the review app should not mutate queue state during normal inspection
- terminal failures like `job_removed` should be recorded cleanly without being treated as retryable/actionable failures
- the intended `server2` deployment shape is two-part:
  - timed Hunt runtime for discovery + headless enrichment + blocked-row UI fallback
  - separate review/control-plane web app
- for `server2`, blocked-row UI fallback is intended to run on a separate virtual display such as `Xvfb :98`, not the main desktop foreground
- the current Ansible deployment split is:
  - C1 (Hunter) on `job_agent` Stage 6
  - later C2 (Trapper) in its own separate step/stage
  - later C3 (Executioner) in its own separate step/stage
  - later C4 (Coordinator) / OpenClaw integration in its own separate step/stage

Stage 4 : current
- backfill old and mixed-source backlog safely
- add monitoring and operational hardening
- save failure artifacts for blocked/browser-fixable rows

## What To Take Note Of

- LinkedIn is the most important source for this project right now
- LinkedIn is also the most brittle source and changes markup often
- browser-based enrichment is slower than discovery scraping
- external apply jobs are the main target
- Easy Apply jobs should be classified and excluded as early as possible
- downstream resume generation should use enriched descriptions, not shallow board metadata
- deployment/runtime context for `server2` lives in a separate repo:
  `C:\Users\sushi\Documents\Github\ansible_homelab`
- if the task involves service deployment, Cloudflare ingress, timers, or operator UI hosting on `server2`, read:
  `docs/components/component1/stage3_server2_plan.md`

## Docs

- System roadmap : `docs/roadmap.md`
- Component docs index : `docs/components/README.md`
- C1 (Hunter) plan : `docs/components/component1/README.md`
- C1 (Hunter) Stage 3 + server2 deployment plan : `docs/components/component1/stage3_server2_plan.md`
- C2 (Trapper) plan : `docs/components/component2/README.md`
- C3 (Executioner) plan : `docs/components/component3/README.md`
- C4 (Coordinator) plan : `docs/components/component4/README.md`
- Existing repo notes for other tools : `CLAUDE.md`
