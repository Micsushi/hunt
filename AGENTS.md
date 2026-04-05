# Hunt : Repo Instructions

## Project Goal

Build a fully automated job application system that runs continuously on a Linux server.

The long-term flow is:
- Component 1 : discover and enrich job postings
- Component 2 : tailor a LaTeX resume to each posting
- Component 3 : apply on external job sites using automation

Current focus:
- finish Component 1 first
- prioritize LinkedIn over every other source
- skip LinkedIn Easy Apply jobs entirely

## Repo Overview

This repo currently implements the discovery half of Component 1.

Main files:
- `scraper/scraper.py` : single-run scraper that discovers jobs and writes them to SQLite
- `scraper/runner.py` : loop runner for continuous scraping
- `scraper/db.py` : schema, migration, and DB helpers
- `scraper/config.py` : search terms, locations, watchlist, and run interval
- `agents/system_prompt.md` : agent contract for downstream application automation

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

## Business Rules

- `priority = 1` jobs are for manual application by the user only
- automation should only act on `priority = 0` jobs unless the user explicitly says otherwise
- LinkedIn Easy Apply jobs are not targets for automation
- if a LinkedIn job is detected as Easy Apply, classify it so later stages never try to use it
- Component 1 should discover and enrich jobs only : it should not submit applications

## Current Stage Plan

Stage 1 : completed
- added enrichment-ready DB columns
- updated scraper URL semantics
- marked historical LinkedIn rows as pending enrichment

Stage 2 : next
- add a one-job Playwright LinkedIn enrichment worker using a logged-in session
- extract full LinkedIn description
- detect `Easy Apply` vs external `Apply`
- save external application URL when present

Stage 3 : after Stage 2
- add batch enrichment
- integrate enrichment into `scraper/runner.py`
- add retry and failure handling

Stage 4 : after Stage 3
- backfill old LinkedIn jobs
- add monitoring and operational hardening

## What To Take Note Of

- LinkedIn is the most important source for this project right now
- LinkedIn is also the most brittle source and changes markup often
- browser-based enrichment is slower than discovery scraping
- external apply jobs are the main target
- Easy Apply jobs should be classified and excluded as early as possible
- downstream resume generation should use enriched descriptions, not shallow board metadata

## Docs

- System roadmap : `docs/roadmap.md`
- Component docs index : `docs/components/README.md`
- Component 1 plan : `docs/components/component1/README.md`
- Component 2 plan : `docs/components/component2/README.md`
- Component 3 plan : `docs/components/component3/README.md`
- Existing repo notes for other tools : `CLAUDE.md`
