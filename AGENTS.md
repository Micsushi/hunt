# Hunt: Repo Instructions

## Goal

Build fully automated job-application system for continuous Linux-server operation.

Pipeline:

- `C0 (Frontend)`: operator dashboard SPA in `frontend/` with backend in `backend/`
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
- `backend/app.py`: C0 control-plane backend for dashboard and `/api/*` routes
- repo-root `hunter`: shim to `scripts/hunterctl.py`
- `agents/system_prompt.md`: downstream apply/orchestration contract

## Data Model Rules

Full schema with all fields, types, valid values, and owning component: `docs/DATA_MODEL.md`.

Key semantics:
- `job_url`: discovery/listing URL — dedupe key
- `apply_url`: best known external apply URL
- `status`: application lifecycle only (`new`, `claimed`, `applied`, `failed`, `skipped`) — never enrichment state
- `apply_type`: `external_apply`, `easy_apply`, `unknown`
- `auto_apply_eligible`: `1` only for `external_apply`
- `enrichment_status`: `pending`, `processing`, `done`, `failed`
- `ats_type`: `greenhouse`, `lever`, `workday`, `ashby`, `smartrecruiters`, `jobvite`, `icims`, `bamboohr`, `unknown`

## Business Rules

- `priority = 1`: manual apply only
- automation acts only on `priority = 0` unless user says otherwise
- LinkedIn Easy Apply is never downstream auto-apply target
- classify Easy Apply during enrichment so later stages never treat it as external ATS apply
- `C1 (Hunter)` only discovers and enriches; it does not submit applications

## Runtime Rules

- newly discovered pending LinkedIn rows outrank old backlog rows in post-scrape enrichment
- read-only queue tools and control plane must not mutate queue state during normal inspection
- C0 mutating control-plane endpoints require a valid web session or `REVIEW_OPS_TOKEN`
- terminal failures like `job_removed` must be recorded cleanly, not retried as actionable failures
- deployment details (server2 shape, Ansible stages, env vars, paths): `docs/deployment.md`

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

## Doc Maintenance

When specs change (new DB fields, business rules, component boundaries, CLI contracts): update this file and the relevant component doc before marking work done.

When new stylistic/workflow preferences are established: add here under Keep In Mind, then compress with caveman skill.

## Cross-Platform

All code must run on Windows (local dev) and Linux (server2). Test locally on Windows before deploying. Never hard-code Linux paths or shell assumptions into Python — use `pathlib`, `os.path`, env vars.

## Keep In Mind

- LinkedIn is highest-value source; markup is brittle and changes often.
- Browser enrichment is slower than discovery scraping.
- External-apply jobs are main target — exclude Easy Apply as early as possible.
- Resume generation must use enriched descriptions, not shallow board metadata.
- Build and test each component so it can run on its own. C0 should stay usable against `backend/app.py` + DB without other component services running; C1/C2/C3 should keep standalone terminal-driven paths; C4 is the only intentionally coupled component because it orchestrates the others.
- All code must run on both Windows (local dev/test) and Linux (server2 production). Use `pathlib`, env vars — no hardcoded paths or bash-only assumptions.
- Deployment details live in `docs/deployment.md` — do not duplicate in component docs.
- If caveman skill is available, use it by default.
- CLI commands must be short (e.g. `./hunter.sh drain`, not `python -m hunter.backfill_enrichment`) but support args where needed (e.g. `./hunter.sh drain 25 --source linkedin`). Applies to all new hunterctl/hunter.sh commands.

## Docs

Project-level (brief, high-level only):
- `docs/roadmap.md` : priorities, version table, component summary
- `docs/deployment.md` : all server2/Ansible/env/path details — canonical source, all other docs refer here
- `docs/DATA_MODEL.md` : full DB schema, field meanings, valid values, owning component
- `docs/GLOSSARY.md` : shared terms
- `docs/NAMING.md` : C1–C4 IDs, code names, folder map
- `docs/CLI_CONVENTIONS.md` : operator CLI conventions

Component-level (detailed — read these to find next thing to work on):
- `docs/components/component0/README.md` : C0 feature status (working / in-progress / bugs)
- `docs/components/component0/runbook.md` : C0 local dev, build, testing
- `docs/components/component1/README.md` : C1 feature status (working / in-progress / bugs)
- `docs/components/component1/runbook.md` : C1 operational how-to (start, drain, recover)
- `docs/components/component2/README.md` : C2 feature status
- `docs/components/component2/runbook.md` : C2 operational how-to
- `docs/components/component3/README.md` : C3 feature status
- `docs/components/component3/runbook.md` : C3 operational how-to
- `docs/components/component4/README.md` : C4 feature status
- `docs/components/component4/runbook.md` : C4 operational how-to
