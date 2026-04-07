# Hunt : automated job search and apply pipeline

**C1 (Hunter)** discovers and enriches postings into SQLite; later **C2 (Trapper)**, **C3 (Executioner)**, and **C4 (Coordinator)** build on the same system. See **`docs/NAMING.md`** for IDs, code names, and folder map. The **`hunter`** package is C1; **`hunter/scraper.py`** is only the discovery script path.

## Key Rules

- `priority = 1` jobs are for **manual application by the user only**. Never modify these with automation. They correspond to companies in `WATCHLIST` in `hunter/config.py`.
- AI agents only process `priority = 0` jobs.
- `job_url` is the listing URL and the current dedup constraint : same company with a different listing URL is still treated as a new posting.
- `apply_url` is the best-known external application URL. For LinkedIn jobs, it may stay null until the enrichment step resolves it.
- `status` is reserved for application lifecycle only : do not use it for enrichment state.
- LinkedIn Easy Apply jobs should be **classified** during enrichment (`easy_apply`, `auto_apply_eligible = 0`) so **later automation** does not treat them as external ATS applies.

## How It Runs

- `hunter/runner.py` : infinite loop, runs `scrape()` every 10 minutes, handles SIGTERM gracefully
- `hunter/scraper.py` : single run entrypoint
- `tools/legacy/hunt.service` : older root-level systemd helper kept for reference
- DB path : project root `hunt.db` by default; production uses `HUNT_DB_PATH` (see `hunter/config.py`)
- **Operator CLI** : repo-root **`hunt` / `hunter`** launchers → **`scripts/huntctl.py`** (`start`, `restart`, `enrich N`, …). See **`docs/CLI_CONVENTIONS.md`** and **`docs/C1_OPERATOR_WORKFLOW.md`**.

## Current Focus

- Finish C1 (Hunter) first
- Prioritize LinkedIn enrichment
- Resolve full descriptions and external application URLs for LinkedIn jobs
- Classify Easy Apply rows for downstream gating

## Agent Instructions

See `agents/system_prompt.md` for the full agent system prompt.
See `AGENTS.md`, `docs/NAMING.md`, `docs/CLI_CONVENTIONS.md`, `docs/roadmap.md`, and `docs/components/component1/README.md` for the current repo-local plan and URL semantics.
