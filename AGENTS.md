# Hunt: Repo Instructions

## Goal

Build fully automated job-application system for continuous Linux-server operation.

Pipeline:

- `C1 (Hunter)`: discover and enrich jobs in `hunter/`
- `C2 (Fletcher)`: tailor LaTeX resume in `fletcher/`
- `C3 (Executioner)`: browser autofill/apply assist
- `C4 (Coordinator)`: orchestration and submit control in `coordinator/`

Canonical naming: `docs/NAMING.md`. Old `scraper/` package renamed to `hunter/`. `hunter/scraper.py` remains discovery entrypoint filename only. CLI contract: `docs/CLI_CONVENTIONS.md`.

## Current Focus

- Harden `C1 (Hunter)` Stage 4.
- Drain backlog safely.
- Polish deployment/ops.
- Prioritize LinkedIn above all other enrichment sources.
- Detect LinkedIn Easy Apply during enrichment and set `easy_apply`, `auto_apply_eligible = 0`.
- Keep C1 deployment separate from later C2/C3/C4 deployment work.

## Repo Map

- `hunter/scraper.py`: discovery entrypoint, writes jobs to SQLite
- `hunter/runner.py`: continuous loop runner
- `hunter/db.py`: schema, migrations, DB helpers
- `hunter/config.py`: terms, locations, watchlist, interval
- `hunter/browser_runtime.py`: shared Playwright runtime
- `hunter/enrich_linkedin.py`: LinkedIn enrichment
- `hunter/enrich_indeed.py`: Indeed enrichment
- `hunter/enrichment_dispatch.py`: source-based routing and priority
- `hunter/enrich_jobs.py`: CLI entrypoint for enrichment rounds
- `hunter/enrichment_policy.py`: retry/backoff policy
- `hunter/linkedin_session.py`: LinkedIn auth state
- `hunter/url_utils.py`: URL normalization and ATS detection
- `review_app.py`: queue review/control-plane app
- repo-root `hunter`: shim to `scripts/hunterctl.py`
- `agents/system_prompt.md`: downstream apply/orchestration contract

## Data Model Rules

- `job_url`: discovery/listing URL
- `apply_url`: best known external apply URL
- historical LinkedIn rows with mirrored `apply_url = job_url` must be cleared during migration
- `job_url` remains dedupe key for now
- `status`: application lifecycle only (`new`, `claimed`, `applied`, `failed`, `skipped`)
- LinkedIn enrichment state must not live in `status`

LinkedIn enrichment fields:

- `apply_type`: `external_apply`, `easy_apply`, `unknown`
- `auto_apply_eligible`: `1` only for external apply
- `enrichment_status`: `pending`, `processing`, `done`, `failed`
- `enrichment_attempts`: retry counter
- `enriched_at`: last successful enrichment time
- `last_enrichment_error`: last failure reason
- `apply_host`: external destination host
- `ats_type`: `greenhouse`, `lever`, `workday`, `ashby`, `smartrecruiters`, `jobvite`, `icims`, `bamboohr`, `unknown`
- `last_enrichment_started_at`: claim start for stale recovery
- `next_enrichment_retry_at`: next unattended retry time

## Business Rules

- `priority = 1`: manual apply only
- automation acts only on `priority = 0` unless user says otherwise
- LinkedIn Easy Apply is never downstream auto-apply target
- classify Easy Apply during enrichment so later stages never treat it as external ATS apply
- `C1 (Hunter)` only discovers and enriches; it does not submit applications

## Stage Snapshot

Stage 1 complete:

- added enrichment-ready DB columns
- split listing URL vs apply URL semantics
- marked historical LinkedIn rows pending enrichment

Stage 2 complete:

- added single-job Playwright LinkedIn enrichment worker
- extracts LinkedIn/external descriptions
- detects Easy Apply vs external Apply
- saves external apply URL
- supports blocked/UI verification flows

Stage 3 complete:

- hardened unattended batch enrichment
- finalized retry/backoff and terminal-state policy
- documented `server2` runtime
- added browser review/control-plane app
- kept path open for C2/C3 agents

Stage 3.2 complete:

- generalized queue/runtime for LinkedIn and Indeed
- added shared browser runtime
- expanded review app to source-aware whole-job table control plane

Stage 4 current:

- backfill old and mixed-source backlog safely
- add monitoring and ops hardening
- save failure artifacts for blocked/browser-fixable rows

## Runtime Notes

- newly discovered pending LinkedIn rows outrank old backlog rows in post-scrape enrichment
- read-only queue tools and review app must not mutate queue state during normal inspection
- terminal failures like `job_removed` should be recorded cleanly, not retried as actionable failures
- intended `server2` shape:
- timed Hunt runtime for discovery + headless enrichment + blocked-row UI fallback
- separate review/control-plane web app
- blocked-row UI fallback should run on separate virtual display like `Xvfb :98`, not main desktop foreground
- Ansible split:
- C1 on `job_agent` Stage 6
- C2 separate later step/stage
- C3 separate later step/stage
- C4/OpenClaw separate later step/stage

## C2 Constraints

- `ResumeDocument` has no `summary` field. Use bullets-only model in `fletcher/models.py`.
- To generate summary text, build context from `candidate_profile["experience_entries"]` and `candidate_profile["skills"]`, then call `generate_summary()` in `llm_enrich.py`.
- Live DB on server is `/home/michael/data/hunt/hunt.db`.
- `/home/michael/hunt/hunt.db` is empty fallback DB.
- Always set `HUNT_DB_PATH=/home/michael/data/hunt/hunt.db` in `.env` before Python commands.
- Run Python from venv: `source ~/hunt/.venv/bin/activate`.
- System Python lacks project deps.
- Ollama model on server is `gemma4:e4b`.
- Timeout is `300s`.
- Enable backend with `HUNT_RESUME_MODEL_BACKEND=ollama` in `.env`.
- Without that env var, backend defaults to heuristic mode.
- `candidate_profile` keys: `experience_entries`, `project_entries`, `skills` with `languages`, `frameworks`, `developer_tools`.
- No top-level `summary`, `targeting_notes`, or `name` fields in parsed structure.

## Keep In Mind

- LinkedIn is highest-value source.
- LinkedIn markup is brittle and changes often.
- Browser enrichment is slower than discovery scraping.
- External-apply jobs are main target.
- Exclude Easy Apply as early as possible.
- Resume generation should use enriched descriptions, not shallow board metadata.
- `server2` deployment context lives in `C:\Users\sushi\Documents\Github\ansible_homelab`.
- Hunt-side production pointers: `docs/C1_OPERATOR_WORKFLOW.md`, section `Production host (server2)`.
- Full Ansible plan: `ansible_homelab/docs/2.01-job-agent-plan.md`.
- If caveman skill is available, use it by default.

## Docs

- roadmap: `docs/roadmap.md`
- live fix tracker: `docs/TODO.md`
- glossary: `docs/GLOSSARY.md`
- docs index: `docs/components/README.md`
- C1 plan: `docs/components/component1/README.md`
- C2 plan: `docs/components/component2/README.md`
- C3 plan: `docs/components/component3/README.md`
- C4 plan: `docs/components/component4/README.md`
- short pointer for other AI tools: `CLAUDE.md`
