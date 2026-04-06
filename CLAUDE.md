# Hunt : Job Scraper

Automated job scraper that feeds a SQLite DB for AI agents to apply on behalf of the user.

## Key Rules

- `priority = 1` jobs are for **manual application by the user only**. Never modify these with automation. They correspond to companies in `WATCHLIST` in `scraper/config.py`.
- AI agents only process `priority = 0` jobs.
- `job_url` is the listing URL and the current dedup constraint : same company with a different listing URL is still treated as a new posting.
- `apply_url` is the best-known external application URL. For LinkedIn jobs, it may stay null until the enrichment step resolves it.
- `status` is reserved for application lifecycle only : do not use it for enrichment state.
- LinkedIn Easy Apply jobs should be classified and excluded from later automation.

## How It Runs

- `scraper/runner.py` : infinite loop, runs `scrape()` every 10 minutes, handles SIGTERM gracefully
- `scraper/scraper.py` : single run entrypoint
- `tools/legacy/hunt.service` : older root-level systemd helper kept for reference
- DB path : project root `hunt.db`

## Current Focus

- Finish Component 1 first
- Prioritize LinkedIn enrichment
- Resolve full descriptions and external application URLs for LinkedIn jobs
- Skip LinkedIn Easy Apply jobs

## Agent Instructions

See `agents/system_prompt.md` for the full agent system prompt.
See `AGENTS.md`, `docs/roadmap.md`, and `docs/components/component1/README.md` for the current repo-local plan and URL semantics.
