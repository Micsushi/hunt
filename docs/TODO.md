# Hunt : TODO

In-flight work only. See `docs/roadmap.md` for component status.

---

## Architecture Migration

Full migration from SQLite/systemd/monolith → Postgres/containers/microservices. Ordered by dependency.

---

### Phase 1 : DB Schema Extensions (prerequisite for everything)

New tables needed before any service APIs or C0 gateway wiring can work.

- [ ] **`component_settings` table** — `(component, key, value, value_type, secret, updated_at, updated_by)`
  - Add DDL to `hunter/db.py` migrations
  - Add DDL to Postgres schema
  - Verify C0 backend reads/writes it
- [ ] **`linkedin_accounts` table**
  - Add DDL to `hunter/db.py` migrations
  - Add DDL to Postgres schema
  - Wire `HUNT_CREDENTIAL_KEY` AES encryption for `password_encrypted`
- [ ] **Run schema migrations** locally against SQLite, confirm no breakage
- [ ] **Seed one `component_settings` row per component** in test/dev setup for smoke testing

---

### Phase 2 : SQLite → Postgres Migration


#### 2a : Code changes (can run on local first)

- [ ] **`hunter/db.py`** — switch DB connection to `HUNT_DB_URL` (asyncpg/psycopg2); keep SQLite fallback when `HUNT_DB_URL` absent
- [ ] **`backend/app.py`** — same `HUNT_DB_URL` switch
- [ ] **`fletcher/db.py`** — same
- [ ] **`coordinator/db.py`** — same
- [ ] **Config shim** — if `HUNT_DB_URL` absent, fall back to `HUNT_DB_PATH` (SQLite). Central in `hunter/config.py` or shared util.
- [ ] **Test locally** — run C1 scrape + enrichment cycle against local Postgres instance
- [ ] **Test C0** — browse queue, ops page, settings page against Postgres

#### 2b : server2 data migration (run once, after 2a confirmed)

- [ ] Freeze `hunt-scraper.timer` + C0 write actions
- [ ] SQLite backup: `sqlite3 hunt.db ".backup 'hunt-YYYYMMDD.db'"`
- [ ] Provision Postgres via Ansible (Stage 6 — see Phase 5)
- [ ] Apply schema DDL to Postgres
- [ ] Copy table data (script or `pgloader`)
- [ ] Validate row counts for all 9 tables
- [ ] Spot-check: latest LinkedIn job, artifact paths, C0 queue load
- [ ] Point server services at `HUNT_DB_URL`
- [ ] Start C0 read-only first, then C1, then C2, C4
- [ ] Re-enable scheduler

---

### Phase 3 : Component Service APIs

Each component needs an HTTP service alongside its existing CLI. C0 gateway calls these.

#### 3a : C1 Hunter service API


- [ ] FastAPI app in `hunter/` (e.g. `hunter/service.py`)
- [ ] `GET /status` — health + db check
- [ ] `GET /queue` — return queue health JSON (existing `queue_health.py` logic)
- [ ] `POST /scrape` — trigger one discovery run (accepts `terms`, `locations`)
- [ ] `POST /enrich` — trigger one enrichment batch (accepts `limit`, `source`)
- [ ] `POST /accounts/{id}/reauth` — trigger LinkedIn re-auth for account
- [ ] `HUNT_SERVICE_TOKEN` bearer auth on all endpoints
- [ ] Local test: call each endpoint via curl with correct token

#### 3b : C2 Fletcher service API


- [ ] FastAPI app in `fletcher/` (e.g. `fletcher/service.py`)
- [ ] `GET /status` — health check
- [ ] `POST /generate` — trigger generation for `job_id`
- [ ] `POST /generate-once` — multipart upload: JD file + optional `job_id`
- [ ] `GET /attempts/{id}` — attempt detail + artifact links
- [ ] `HUNT_SERVICE_TOKEN` auth on all endpoints
- [ ] Local test: `POST /generate-once` with a real JD file

#### 3c : C4 Coordinator service API


- [ ] FastAPI app in `coordinator/` (e.g. `coordinator/service.py`)
- [ ] `GET /status` — health check
- [ ] `POST /run` — start orchestration run (`job_id`, optional `mode`, `browser_lane`)
- [ ] `GET /runs` — list recent runs
- [ ] `GET /runs/{id}` — single run detail
- [ ] `POST /runs/{id}/approve` — record submit approval
- [ ] `POST /runs/{id}/fill-result` — internal: C0 forwards C3 fill result here
- [ ] `HUNT_SERVICE_TOKEN` auth on all endpoints

---

### Phase 4 : C0 Gateway Wiring

`backend/app.py` implements all `/api/*` routes. Frontend never calls components directly.


#### 4a : Status + settings endpoints

- [ ] `GET /api/status` — ping each configured service URL, return `{hunter, fletcher, executioner, coordinator}` online map; heartbeat for C3 from last-poll timestamp
- [ ] `GET /api/settings/{component}` — read from `component_settings` table; redact `secret=1` values
- [ ] `PUT /api/settings/{component}` — write to `component_settings`; validate key/type per component schema

#### 4b : LinkedIn accounts endpoints

- [ ] `GET /api/linkedin/accounts` — list accounts (redact `password_encrypted`)
- [ ] `POST /api/linkedin/accounts` — add new account (encrypt password with `HUNT_CREDENTIAL_KEY`)
- [ ] `PATCH /api/linkedin/accounts/{id}` — update `active`, `display_name`, status fields
- [ ] `POST /api/linkedin/accounts/{id}/reauth` — forward to C1 `POST /accounts/{id}/reauth`

#### 4c : C1 gateway routes

- [ ] `POST /api/c1/scrape` — forward to C1 service `POST /scrape` with `HUNT_SERVICE_TOKEN`
- [ ] `POST /api/c1/enrich` — forward to C1 service `POST /enrich`
- [ ] Wire frontend Ops page "Trigger Scrape" / "Trigger Enrich" buttons to these routes

#### 4d : C2 gateway routes

- [ ] `POST /api/c2/generate` — forward to C2 service `POST /generate`
- [ ] `POST /api/c2/generate-once` — stream multipart to C2 `POST /generate-once`
- [ ] Wire Fletcher page file-drop UI to `/api/c2/generate-once`
- [ ] Wire job detail Resume tab "Generate" button to `/api/c2/generate`

#### 4e : C3 polling + result routes

- [ ] `GET /api/c3/pending-fills` — reads fill requests from DB queue (written by C4); update C3 last-seen heartbeat
- [ ] `POST /api/c3/fill-results` — receive fill result from C3; update `jobs`, `orchestration_runs`, `orchestration_events` via C4 or directly
- [ ] Ensure `HUNT_SERVICE_TOKEN` required on both (C3 uses same token)

#### 4f : C4 gateway routes

- [ ] `POST /api/c4/runs` — forward to C4 `POST /run`
- [ ] `GET /api/c4/runs` — forward to C4 `GET /runs`
- [ ] `GET /api/c4/runs/{id}` — forward to C4 `GET /runs/{id}`
- [ ] `POST /api/c4/runs/{id}/approve` — forward to C4 `POST /runs/{id}/approve`
- [ ] Wire Coordinator page to these routes

---

### Phase 5 : Container Dockerfiles + Compose


- [ ] **`Dockerfile.backend`** — FastAPI C0 backend (`backend/`)
- [ ] **`Dockerfile.frontend`** — multi-stage: `node` build → `nginx` serve `frontend/dist/`
- [ ] **`Dockerfile.hunter`** — C1, includes Playwright/Chromium install
- [ ] **`Dockerfile.fletcher`** — C2, includes LaTeX toolchain (tectonic)
- [ ] **`Dockerfile.coordinator`** — C4
- [ ] **`docker-compose.yml`** — compose for postgres, ollama, control-plane, hunter, fletcher, coordinator profiles (postgres, ollama, control-plane, hunter, fletcher, coordinator profiles)
- [ ] **Local smoke test**: `docker compose up control-plane` — C0 + Postgres starts, queue loads
- [ ] **Pipeline smoke test**: `docker compose --profile pipeline up` — all containers start

---

### Phase 6 : Ansible v2 Stages


- [ ] **Stage 6 task files** (behind `deploy_hunt_v2: true` flag):
  - `playbooks/tasks/hunt_postgres.yml` — Postgres volume, container, user/db health
  - `playbooks/tasks/hunt_backend.yml` — build/deploy backend image, env, Traefik route
  - `playbooks/tasks/hunt_frontend.yml` — build SPA, nginx image/container
- [ ] **Stage 7**: `playbooks/tasks/hunt_hunter.yml` — C1 service API + scheduler container
- [ ] **Stage 8**: `playbooks/tasks/hunt_fletcher.yml` + Ollama container
- [ ] **Stage 9**: `playbooks/tasks/hunt_coordinator.yml`
- [ ] **Migration helper**: `playbooks/tasks/hunt_migration.yml` — SQLite backup/import/validate
- [ ] Add vault vars: `vault_hunt_db_password`, `vault_hunt_admin_password`, `vault_hunt_service_token`, `vault_hunt_credential_key`
- [ ] Deploy behind flag: `deploy_hunt_v2: false` until validated locally

---

### Phase 7 : C2 v1.0 (parallel with above)


- [ ] **Fill `fletcher/candidate_profile.md`** with real job history
- [ ] **Wire LLM tailoring** — Ollama for bullet/section rewriting grounded in candidate profile + bullet library; fallback when model fails
- [ ] **Curate base resumes** (`fletcher/base_resumes/`) for software/pm/data/general families
- [ ] **Production validation on server2** — queue-driven `generate-ready` with real JDs
- [ ] **C1→C2 handoff validation** on server2

---

### Phase 8 : C3 Hardening


- [ ] **Pipeline polling** — C3 polls `GET /api/c3/pending-fills`; picks up fill requests from C4 queue
- [ ] **Fill result post-back** — C3 posts to `POST /api/c3/fill-results`; test full round-trip
- [ ] **Resume upload fix** — embed `resume_bytes` (base64 PDF) in apply context; remove raw filesystem path dependency
- [ ] **Stronger answer grounding** — answers derived from selected resume facts
- [ ] **Workday flow hardening** — manual fill, auto-fill-on-load, generated answers, evidence persistence
- [ ] **C4 trigger surface** — validate import context → fill → result → evidence cycle

---

### Phase 9 : C4 Tests + Live C3 Bridge


- [ ] **Validate apply-prep against real DB rows** on server2
- [ ] **Wire live C3 bridge** — load apply context into live extension session, trigger fill
- [ ] **Validate fill-request → fill-result transitions** end-to-end
- [ ] **Validate submit approval + final-status artifact writing**
- [ ] **Unattended guardrails** — one active run limit, retry budgets, cooldown after auth trouble
- [ ] **Real test suite** — replace placeholder tests with actual predicate + transition tests

---

## Active

_(add in-flight items here as they come up — remove when done)_
