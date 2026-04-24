# Hunt : Deployment

Canonical reference for server2 layout, Ansible structure, env vars, and paths. All other docs refer here — do not duplicate deployment details elsewhere.

Related target-v2 docs:
- API contracts: `docs/API_CONTRACTS.md`
- Settings/secrets: `docs/SETTINGS_AND_SECRETS.md`
- SQLite → Postgres migration: `docs/DB_MIGRATION_SQLITE_TO_POSTGRES.md`
- Ansible rollout: `ansible_homelab/docs/2.11-job-agent-v2-ansible-rollout.md`

## Environments

| Environment | OS | Purpose |
|---|---|---|
| Local (Windows) | Windows 11 | Development and local testing — test here before deploying |
| server2 (Linux) | Ubuntu/Debian | Production — runs C1 continuously |

All code must run on both. Use `pathlib` and env vars — no hardcoded paths or bash-only assumptions.

---

## server2 Layout

| Resource | Path |
|---|---|
| Repo checkout | `/home/michael/hunt` |
| Python venv | `/home/michael/hunt/.venv` |
| Activate venv | `source ~/hunt/.venv/bin/activate` |
| Live DB | `/home/michael/data/hunt/hunt.db` |
| Artifacts dir | `/home/michael/data/hunt/artifacts` |
| Empty fallback DB | `/home/michael/hunt/hunt.db` |

Runtime data lives **outside** the git checkout. The git tree is code only.

---

## Key Env Vars

| Var | Purpose | server2 value |
|---|---|---|
| `HUNT_DB_URL` | Postgres connection URL — primary DB var | `postgres://hunt:pass@localhost:5432/hunt` |
| `HUNT_DB_PATH` | SQLite path — **deprecated**, fallback only when `HUNT_DB_URL` absent | `/home/michael/data/hunt/hunt.db` |
| `HUNT_ARTIFACTS_DIR` | Artifacts root (PDFs, screenshots, context files) | `/home/michael/data/hunt/artifacts` |
| `HUNT_RESUME_MODEL_BACKEND` | C2 LLM backend | `ollama` |
| `HUNT_RESUME_LOG_LLM_IO` | Log LLM I/O | `1` |
| `HUNT_ADMIN_USERNAME` | C0 login username | `admin` unless overridden |
| `HUNT_ADMIN_PASSWORD` | C0 login password | set in `.env` |
| `REVIEW_OPS_TOKEN` | Optional legacy/API ops token; session auth also works | optional secret |
| `REVIEW_APP_PUBLIC_URL` | Public C0 hostname | e.g. `https://agent-hunt-review.mshi.ca` |
| `LINKEDIN_EMAIL` | LinkedIn auto-relogin (legacy single-account; prefer `linkedin_accounts` table) | set in `.env` |
| `LINKEDIN_PASSWORD` | LinkedIn auto-relogin (legacy single-account) | set in `.env` |
| `DISPLAY` | Virtual display for headful enrichment | `:98` (Xvfb) |
| `OLLAMA_BASE_URL` | Ollama API base for C2 LLM calls | `http://ollama:11434` |
| `HUNT_CREDENTIAL_KEY` | AES key for encrypting `linkedin_accounts.password_encrypted` | 32-byte hex, set in `.env` |
| `HUNT_SERVICE_TOKEN` | Bearer token for service-to-service auth between C0 backend and component APIs | secret, set in `.env` |

`hunterctl` auto-targets `~/data/hunt/hunt.db` when that path exists and `HUNT_DB_URL` is unset, so manual SQLite commands still work during transition.

---

## Ollama (C2 LLM backend on server2)

| Config | Value |
|---|---|
| Model | `gemma4:e4b` |
| Timeout | `300s` |
| Enable | `HUNT_RESUME_MODEL_BACKEND=ollama` in `.env` |
| Default without var | heuristic mode |

---

## Ansible Structure

Ansible repo: `C:\Users\sushi\Documents\Github\ansible_homelab`  
Full plan: `ansible_homelab/docs/2.01-job-agent-plan.md`

Each component deploys in its own stage — never fold a later component into an earlier stage.

| Component | Ansible stage |
|---|---|
| C1 (Hunter) | job_agent Stage 6 |
| C2 (Fletcher) | separate later stage (Stage 7) |
| C3 (Executioner) | separate later stage |
| C4 (Coordinator) / OpenClaw | separate later stage |

---

## Systemd Services (C1)

| Unit | Purpose |
|---|---|
| `hunt-scraper.timer` | Scheduled C1 discovery + enrichment (default every 10 min) |
| `hunt-scraper.service` | One C1 run (triggered by timer or manual start) |
| `hunt-xvfb.service` | Xvfb virtual display on `:98` for headful enrichment |
| C0 control-plane service | Separate from scraper; deploy flags in `ansible_homelab` |

Note: unit names still say `hunt-scraper` while running C1 Hunter — historical names, see `docs/NAMING.md`.

---

## Deploy Procedure (C1, server2)

Merge changes to `main` first, then from Ansible control machine:

```bash
# Full refresh
ansible-playbook -i inventory.local playbooks/job_agent/main.yml

# After Hunt code change only
ansible-playbook -i inventory.local playbooks/job_agent/main.yml --tags stage6

# After deploy: reload systemd if units changed
sudo systemctl daemon-reload && sudo systemctl restart hunt-scraper.timer hunt-xvfb.service
```

---

## Playwright Setup

Installing the Python `playwright` package alone is not enough on Linux. Also run:

```bash
python -m playwright install chromium
```

This must be run as the runtime user so browser binaries exist in the correct Playwright cache.

---

## Smoke Test After Deploy

Run on server2 as the deploy user:

1. **Units active**: `systemctl is-active hunt-xvfb hunt-scraper.timer`
2. **Env vars present**: `systemctl cat hunt-scraper.service | grep -E 'HUNT_|REVIEW_APP_PUBLIC'`
3. **One-shot scrape**: `sudo systemctl start hunt-scraper.service` then `journalctl -u hunt-scraper.service -n 80 --no-pager`
4. **C0 control plane**: open `https://<hunt_review_hostname>` — queue loads, `/health` returns OK
5. **Metrics**: `docker exec hunt_review curl -sS http://127.0.0.1:8000/metrics | head`
6. **Queue JSON**: `./hunter.sh queue --json | head -c 2000`

---

## Headful / Xvfb (Linux server)

Normal enrichment passes run headless. When `--ui-verify-blocked` is on, blocked rows get a visible-browser rerun. On a headless server:

```bash
DISPLAY=:98 ./hunter.sh drain
```

`Xvfb :98` is managed by `hunt-xvfb.service`. Do not run headful enrichment on the main desktop foreground.

---

## Container Architecture (target)

Pipeline model: one shared Postgres DB, one shared artifact volume, four worker containers picking up jobs by status. Each container is independently deployable and runnable on its own; C4 wires them into a full pipeline.

### Architecture overview

```
┌─────────────────────────────────────────────────┐
│                   Postgres DB                    │
│  jobs · resume_attempts · resume_versions        │
│  orchestration_runs · orchestration_events       │
│  submit_approvals · review_sessions · runtime_state │
└──────┬──────────────┬──────────────┬─────────────┘
       │              │              │
  ┌────▼────┐   ┌─────▼─────┐  ┌────▼────┐
  │ C1      │   │ C2        │  │ C4      │
  │ Hunter  │   │ Fletcher  │  │ Coord.  │
  │ :scrape │   │ :8001 UI  │  │ :8002   │
  └─────────┘   └───────────┘  └────┬────┘
                                     │ apply context (file/API)
                                ┌────▼────┐
                                │ C3      │
                                │ Execut. │
                                │ (no DB) │
                                └─────────┘
       ┌────────────────────────────────────────┐
       │  C0 : control plane  :8000             │
       │  reads all tables, serves frontend SPA │
       └────────────────────────────────────────┘
             shared artifact volume mounted by C0, C1, C2, C4
```

### Container definitions

#### C0 : control plane (`backend/` + `frontend/dist/`)

| Property | Value |
|---|---|
| Image | `hunt-control-plane` |
| Port | `8000` |
| DB access | read + write (`review_sessions`) |
| Artifact access | read (serves PDFs, screenshots) |
| Standalone | yes — browse queue, review resumes, approve submits |

Required env vars:

```
HUNT_DB_URL           # postgres://...
HUNT_ARTIFACTS_DIR    # /data/artifacts
HUNT_ADMIN_USERNAME
HUNT_ADMIN_PASSWORD
REVIEW_APP_PUBLIC_URL
REVIEW_OPS_TOKEN      # optional
```

#### C1 : Hunter (`hunter/`)

| Property | Value |
|---|---|
| Image | `hunt-hunter` |
| Port | none — worker process |
| DB access | read + write (`jobs`, `runtime_state`) |
| Artifact access | write (failure screenshots/HTML) |
| Standalone | yes — scrapes and enriches, populates jobs table |
| Special deps | Playwright/Chromium, Xvfb on Linux, LinkedIn session |

Required env vars:

```
HUNT_DB_URL
HUNT_ARTIFACTS_DIR
LINKEDIN_EMAIL
LINKEDIN_PASSWORD
DISPLAY             # :98 on Linux with Xvfb
```

Standalone start: `hunter drain` (enrichment) or `hunter scrape` (discovery).

#### C2 : Fletcher (`fletcher/`)

| Property | Value |
|---|---|
| Image | `hunt-fletcher` |
| Port | `8001` (own UI for drop-and-process) |
| DB access | read (`jobs.description`, `jobs.apply_url`), write (resume fields) |
| Artifact access | write (PDFs, TeX, keywords JSON) |
| Standalone | yes — UI accepts job_id or raw JD; no coordinator needed |
| Special deps | LaTeX toolchain (tectonic/pdflatex), Ollama |

Required env vars:

```
HUNT_DB_URL
HUNT_ARTIFACTS_DIR
HUNT_RESUME_MODEL_BACKEND   # ollama or heuristic
OLLAMA_BASE_URL             # http://ollama:11434
```

Standalone start: `hunter ui serve` (C0 shows fletcher status) or direct flask/fastapi UI on 8001.
Manual trigger: `fletch run generate-job <job_id>`.

#### C3 : Executioner (`executioner/`)

| Property | Value |
|---|---|
| Image | `hunt-executioner` |
| Port | none — invoked by C4 or manually |
| DB access | **none** — context is injected via file |
| Artifact access | write (fill result JSON, evidence screenshots) |
| Standalone | yes — takes `c3_apply_context.json` as input, fills form |
| Special deps | Chrome extension, Playwright or CDP bridge |

Required env vars:

```
HUNT_ARTIFACTS_DIR    # for writing fill results
# No DB vars needed
```

Standalone invocation: provide `c3_apply_context.json` (contains apply_url + resume bytes).
Context is always current in-memory state; coordinator swaps in new resume before calling C3.

#### C4 : Coordinator (`coordinator/`)

| Property | Value |
|---|---|
| Image | `hunt-coordinator` |
| Port | `8002` (submit approval API) |
| DB access | read (`jobs`), write (`orchestration_runs`, `orchestration_events`, `submit_approvals`) |
| Artifact access | write (apply context, decision artifacts) |
| Standalone | only meaningful as orchestrator — requires C1 to have populated jobs |
| Calls | C2 API or CLI to trigger tailoring; C3 via apply-context file + CDP bridge |

Required env vars:

```
HUNT_DB_URL
HUNT_ARTIFACTS_DIR
FLETCHER_API_URL      # http://fletcher:8001  (or empty to use CLI)
C3_BRIDGE_URL         # CDP/WS URL for executioner
```

Standalone start: `hunter coord run` — picks up `enrichment_status=done, resume ready` jobs in order.

---

### Postgres migration (SQLite → Postgres)

Single database, all tables in `public` schema. No schema-per-component split needed — this is a pipeline, not independent microservices with isolated data.

**Migration steps (per component, in order):**

1. **Update `HUNT_DB_PATH` → `HUNT_DB_URL`** across all Python modules. SQLAlchemy/asyncpg handles both; swap the driver prefix.
2. **C1 first** — `hunter/db.py` schema → Postgres DDL. Test scrape + enrichment cycle.
3. **C0** — `backend/app.py` reads same tables; just changes connection. Test control plane.
4. **C2** — `fletcher/db.py` resume fields. Test generate-job cycle.
5. **C4** — `coordinator/db.py` orchestration tables. Test full coord run.
6. C3 has no DB — no migration needed.

**Env var rename** (do all at once when switching):

```
HUNT_DB_PATH   →   HUNT_DB_URL   (postgres://user:pass@host:5432/hunt)
```

Keep backward compat shim in config: if `HUNT_DB_URL` is absent, fall back to `HUNT_DB_PATH` as SQLite file.

---

### Artifact storage

Artifacts (PDFs, TeX, screenshots, JSON context files) are the only shared-filesystem dependency between containers.

| Phase | Strategy |
|---|---|
| Current (systemd) | Shared path at `HUNT_ARTIFACTS_DIR` on host |
| Container (near-term) | Named Docker volume `hunt-artifacts` mounted by C0, C1, C2, C4 |
| Long-term | Supabase Storage (S3-compatible); containers write via SDK, paths become bucket keys |

C3 receives resume bytes embedded in the apply context JSON — no direct artifact volume access needed.

---

### Docker Compose (minimal, local dev)

```yaml
version: "3.9"
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: hunt
      POSTGRES_USER: hunt
      POSTGRES_PASSWORD: hunt
    volumes: [pgdata:/var/lib/postgresql/data]
    ports: ["5432:5432"]

  ollama:
    image: ollama/ollama
    volumes: [ollama_data:/root/.ollama]
    ports: ["11434:11434"]

  control-plane:     # C0
    build: { context: ., dockerfile: Dockerfile.review }
    env_file: .env
    ports: ["8000:8000"]
    volumes: [hunt_artifacts:/data/artifacts]
    depends_on: [db]

  hunter:            # C1
    build: { context: ., dockerfile: Dockerfile.hunter }
    env_file: .env
    volumes: [hunt_artifacts:/data/artifacts]
    depends_on: [db]
    profiles: [pipeline]   # not started by default in dev

  fletcher:          # C2
    build: { context: ., dockerfile: Dockerfile.fletcher }
    env_file: .env
    ports: ["8001:8001"]
    volumes: [hunt_artifacts:/data/artifacts]
    depends_on: [db, ollama]
    profiles: [pipeline]

  coordinator:       # C4
    build: { context: ., dockerfile: Dockerfile.coordinator }
    env_file: .env
    ports: ["8002:8002"]
    volumes: [hunt_artifacts:/data/artifacts]
    depends_on: [db, fletcher]
    profiles: [pipeline]

volumes:
  pgdata:
  ollama_data:
  hunt_artifacts:
```

C3 (Executioner) runs on the operator's local machine or a dedicated desktop node with Chrome — not in the compose stack.

Start just the control plane: `docker compose up control-plane`
Start full pipeline: `docker compose --profile pipeline up`
