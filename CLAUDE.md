# Hunt — Job Scraper

Automated job scraper that feeds a SQLite DB for AI agents to apply on behalf of the user.

## Key Rules

- `priority = 1` jobs are for **manual application by the user only**. Never modify these with automation. They correspond to companies in `WATCHLIST` in `scraper/config.py`.
- AI agents only process `priority = 0` jobs.
- `job_url` is the sole dedup constraint — same company with a different URL is a legitimate new posting.
- `apply_url` is currently the same as `job_url`. It should eventually store the direct ATS link (`job_url_direct` from jobspy).

## How It Runs

- `scraper/runner.py` — infinite loop, runs `scrape()` every 10 minutes, handles SIGTERM gracefully
- `scraper/scraper.py` — single run entrypoint
- `hunt.service` — systemd unit for Ubuntu server (edit `User=` to match server username before deploying)
- DB path: project root `hunt.db`

## Agent Instructions

See `agents/system_prompt.md` for the full agent system prompt.
