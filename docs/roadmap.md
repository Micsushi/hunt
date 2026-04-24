# Hunt : Roadmap

Automated job application pipeline. Discover → Enrich → Tailor resume → Autofill → Submit.

## Components

| ID | Name | Code | Version | Status |
|---|---|---|---|---|
| C0 | Frontend | `frontend/` + `backend/` | 0.2 | SPA live — stub pages for C2/C3/C4; gateway API calls not yet wired |
| C1 | Hunter | `hunter/` | 0.1 | Stage 4 ops — server2 validation pending |
| C2 | Fletcher | `fletcher/` | 0.1 → 1.0 | LLM tailoring + candidate profile needed for v1.0 |
| C3 | Executioner | `executioner/` | 0.0 | Local only — Workday fill works, not deployed |
| C4 | Coordinator | `coordinator/` | 0.0 | Local checkpoint — not deployed, tests are placeholder |

## Current Priority

1. C1 server2 production validation (backlog drain, steady-state timer, Ansible Stage 6)
2. C2 v1.0 — fill candidate profile, wire LLM tailoring, validate C1→C2 handoff on server2
3. SQLite → Postgres migration (start with C1 schema, then C0, C2, C4)
4. Container architecture — Dockerfiles for C1, C2, C4; nginx container for C0 frontend
5. C0 gateway wiring — backend calls C1/C2/C4 service APIs from UI actions
6. C3 hardening — Workday flows, resume upload gap, backend result write-back
7. C4 tests + live C3 bridge + submit approval UI

## Cross-Component Interactions

All component API calls are routed through the C0 backend (API gateway). Components do not call each other directly.

```
Browser (SPA)
  ↕ REST
C0 Backend (FastAPI — API gateway)
  ├── reads/writes Postgres directly (jobs, resumes, orchestration, settings)
  ├── calls C1 API  → trigger scrape, trigger enrich, get queue, reauth LinkedIn
  ├── calls C2 API  → trigger generation, one-off file-drop generate, get status
  ├── exposes       → C3 polls for pending fill requests (no inbound needed)
  └── calls C4 API  → trigger pipeline run, get run status
```

**C3 write-back rule:** C3 never receives DB credentials. It polls C0 for fill requests and posts fill results back to C0. Backend/C4 own DB writes for job/run lifecycle state.

**Any-combination rule:** the pipeline works with any subset of components deployed. C4 is optional automation — without it, operators manually trigger C1/C2/C3 steps from the UI or CLI.

| Deployed | What works |
|---|---|
| C0 + DB only | Browse jobs, approve/reject, view resumes |
| + C1 | Trigger scrapes from UI; jobs populate DB |
| + C2 | File-drop one-off generation; resume tabs in job detail |
| + C3 (local) | Apply to jobs; backend receives fill results and updates status |
| + C4 | Full automated pipeline with human submit approval |

## Deployment Split

Each component deploys in its own container and Ansible stage. Never fold a later component into an earlier stage. See `docs/deployment.md`.

## Principles

- Standalone-first: every component must be runnable and testable on its own. C0 + DB is the base layer; all other components are optional. C4 is the only intentionally coupled component.
- C0 backend is the single API gateway — frontend never calls component services directly
- LinkedIn is highest-priority source
- LinkedIn Easy Apply is classified and excluded at C1 — never reaches C3/C4
- `priority = 1` jobs are always manual-only
- Submit is always a separate explicit decision from fill
- Do not attempt CAPTCHA/anti-bot bypass
- All code runs on both Windows (local dev) and Linux (server2)

## Component Docs

Read these to find the next thing to work on — feature status, bugs, what's in progress:

- `docs/components/component0/README.md`
- `docs/components/component1/README.md`
- `docs/components/component2/README.md`
- `docs/components/component3/README.md`
- `docs/components/component4/README.md`
- `docs/API_CONTRACTS.md`
- `docs/SETTINGS_AND_SECRETS.md`
- `docs/DB_MIGRATION_SQLITE_TO_POSTGRES.md`
