# Hunt: Repo Instructions

## Goal

Build fully automated job-application pipeline for continuous Linux-server operation.

Components:

- `C0 (Frontend)`: operator dashboard — `frontend/` (React SPA, `hunt-frontend` container) + `backend/` (FastAPI API gateway, `hunt-backend` container). Backend calls DB directly and proxies all component API calls. Frontend never calls component services directly.
- `C1 (Hunter)`: discover and enrich jobs — `hunter/` — container `hunt-hunter`. Exposes service API for UI-triggered scrapes and enrichment. Manages LinkedIn accounts from `linkedin_accounts` table.
- `C2 (Fletcher)`: tailor LaTeX resume — `fletcher/` — container `hunt-fletcher`. Exposes service API for generation; supports one-off file-drop generation triggered from C0 UI.
- `C3 (Executioner)`: browser autofill Chrome extension — `executioner/` — runs on operator's local machine only, no server container. Polls C0 backend for fill requests in pipeline mode. Posts fill results to C0; backend/C4 update DB state.
- `C4 (Coordinator)`: orchestration and submit control — `coordinator/` — container `hunt-coordinator`. Queues fill requests for C3; exposes submit approval API.
- `Postgres`: shared DB for all components. `hunt-backend` + `hunt-hunter` + `hunt-fletcher` + `hunt-coordinator` all connect via `HUNT_DB_URL`.
- `Ollama`: LLM backend for C2 — single container, one model (`gemma4:e4b`).

Canonical naming: `docs/NAMING.md`. Old `scraper/` package renamed to `hunter/`. `hunter/scraper.py` remains discovery entrypoint filename only. CLI contract: `docs/CLI_CONVENTIONS.md`.

**Any-combination rule:** the system works with any subset of components deployed. C0 + DB is the required base. Each additional component enables more features without breaking what's already working.

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

Full schema: `docs/DATA_MODEL.md`.

- `job_url`: listing URL — dedupe key
- `apply_url`: best known external apply URL
- `status`: lifecycle only (`new`, `claimed`, `applied`, `failed`, `skipped`) — never enrichment state
- `apply_type`: `external_apply`, `easy_apply`, `unknown`
- `auto_apply_eligible`: `1` only for `external_apply`
- `enrichment_status`: `pending`, `processing`, `done`, `failed`
- `ats_type`: `greenhouse`, `lever`, `workday`, `ashby`, `smartrecruiters`, `jobvite`, `icims`, `bamboohr`, `unknown`

## Business Rules

- `priority = 1`: manual only
- automation: `priority = 0` only
- Easy Apply: never downstream auto-apply target
- classify Easy Apply at C1 — later stages never see it as external ATS
- C1: discover + enrich only — no submit

## Runtime Rules

- new LinkedIn rows outrank old backlog in post-scrape enrichment queue
- read-only tools: no queue mutation
- C0 mutating endpoints: require web session or `REVIEW_OPS_TOKEN`
- `job_removed` and similar terminal failures: record, don't retry
- deployment details: `docs/deployment.md`

## C2 Constraints

- `ResumeDocument`: no `summary` field — bullets-only model (`fletcher/models.py`)
- summary text: build from `candidate_profile["experience_entries"]` + `["skills"]`, call `generate_summary()` in `llm_enrich.py`
- DB: `HUNT_DB_URL` (Postgres); `HUNT_DB_PATH` SQLite fallback local dev only
- venv: `source ~/hunt/.venv/bin/activate` — system Python lacks deps
- Ollama model: `gemma4:e4b`, timeout `300s`
- `OLLAMA_BASE_URL`: `http://ollama:11434` in container; `http://localhost:11434` locally
- enable LLM: `HUNT_RESUME_MODEL_BACKEND=ollama` — else heuristic mode
- `candidate_profile` keys: `experience_entries`, `project_entries`, `skills` (`languages`, `frameworks`, `developer_tools`)
- no top-level `summary`, `targeting_notes`, or `name` in parsed structure

## Doc Maintenance

Specs change (DB fields, rules, component boundaries, CLI contracts): update this file + relevant component doc before marking done.

New style/workflow preferences: add to Keep In Mind, compress with caveman skill.

## Cross-Platform

Windows (local) + Linux (server2). Test locally first. `pathlib` + env vars — no hardcoded paths or shell assumptions.

## Keep In Mind

- LinkedIn: highest-value source. Markup brittle, changes often.
- Browser enrichment slower than discovery. Exclude Easy Apply at C1 — never reaches C3/C4.
- Resume generation: enriched descriptions only, not board metadata.
- C0 backend: API gateway. Frontend never calls component APIs. All routes through `backend/app.py`.
- Each component runnable alone. C0 + DB: required base. Others optional. C4 only intentionally coupled.
- C3: Chrome extension, operator's machine only. No server container. Polls C0 for fill requests. No direct DB credentials or DB writes; posts results to C0.
- `component_settings`: per-component settings, managed via C0 UI. `linkedin_accounts`: C1 credentials, managed via C0 UI.
- DB: Postgres, `HUNT_DB_URL`. `HUNT_DB_PATH`: SQLite dev fallback only. New code uses `HUNT_DB_URL`.
- Service auth: `HUNT_SERVICE_TOKEN` bearer token on all C0↔component calls. C3 uses same token to call C0. C3 must never receive `HUNT_DB_URL`.
- Cross-platform: `pathlib` + env vars. No hardcoded paths or bash-only assumptions.
- Deployment details: `docs/deployment.md`. Don't duplicate in component docs.
- API contracts: `docs/API_CONTRACTS.md`. Settings/secrets: `docs/SETTINGS_AND_SECRETS.md`. Postgres migration: `docs/DB_MIGRATION_SQLITE_TO_POSTGRES.md`.
- Caveman skill: use by default.
- CLI: short verbs + optional args (`./hunter.sh drain 25 --source linkedin`). Never `python -m ...` for operator commands.

## Docs

Project-level (brief, high-level only):
- `docs/roadmap.md` : priorities, version table, component summary
- `docs/deployment.md` : all server2/Ansible/env/path details — canonical source, all other docs refer here
- `docs/DATA_MODEL.md` : full DB schema, field meanings, valid values, owning component
- `docs/API_CONTRACTS.md` : C0 gateway + component service API contract
- `docs/SETTINGS_AND_SECRETS.md` : component settings, LinkedIn accounts, tokens, secret handling
- `docs/DB_MIGRATION_SQLITE_TO_POSTGRES.md` : SQLite to Postgres migration plan
- `docs/GLOSSARY.md` : shared terms
- `docs/NAMING.md` : C1–C4 IDs, code names, folder map
- `docs/CLI_CONVENTIONS.md` : operator CLI conventions

Component-level (detailed — read these to find next thing to work on):
- `docs/components/component0/README.md` : C0 feature status (working / in-progress / bugs)
- `docs/components/component0/runbook.md` : C0 local dev, build, testing
- `docs/components/component1/README.md` : C1 feature status (working / in-progress / bugs)
- `docs/components/component1/api.md` : C1 service API
- `docs/components/component1/runbook.md` : C1 operational how-to (start, drain, recover)
- `docs/components/component2/README.md` : C2 feature status
- `docs/components/component2/api.md` : C2 service API
- `docs/components/component2/runbook.md` : C2 operational how-to
- `docs/components/component3/README.md` : C3 feature status
- `docs/components/component3/backend-contract.md` : C3 polling/result contract
- `docs/components/component3/runbook.md` : C3 operational how-to
- `docs/components/component4/README.md` : C4 feature status
- `docs/components/component4/api.md` : C4 service API
- `docs/components/component4/runbook.md` : C4 operational how-to
