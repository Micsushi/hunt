# Hunt : Roadmap

Automated job application pipeline. Discover → Enrich → Tailor resume → Autofill → Submit.

## Components

| ID | Name | Code | Version | Status |
|---|---|---|---|---|
| C0 | Frontend | `frontend/` + `backend/` | 0.2 | SPA live for core browse/ops; backend gateway routes mounted under `/api/gateway/*`; settings/accounts/C2/C4 UI polish pending |
| C1 | Hunter | `hunter/` | 0.1 | Discovery/enrichment service exists; Postgres compat exists; real server2 C1 cycle and auth/account polish pending |
| C2 | Fletcher | `fletcher/` | 0.1 → 1.0 | Service and pipeline exist; webpage workflow, real profile, and LLM tailoring polish pending |
| C3 | Executioner | `executioner/` | 0.0 | Local Workday extension exists; live C0/C4 polling bridge and ATS expansion pending |
| C4 | Coordinator | `coordinator/` | 0.0 | Local Postgres e2e smoke and server2 API-level bridge validated; live C3 browser session and approval UI pending |

## Current Priority

1. C1 server2 production validation: scrape, enrich, artifacts, queue drain, steady scheduler
2. C0 operator polish: clear health/status, C1 controls, settings, LinkedIn accounts
3. C2 v1.0: webpage workflow, candidate profile, LLM/API-key support, C1 -> C2 server2 handoff
4. C3 hardening: ATS adapter structure, required-field detection, safe LLM-assisted answers, live postback
5. C4 polish: live C3 browser bridge, approval UI, request-fill HTTP endpoint, guardrails
6. Deployment polish: Windows/Linux local smoke, server2 smoke path, docs kept in sync

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

Current gateway routes live under `/api/gateway/*`. Older planned `/api/c1/*`, `/api/c2/*`, and `/api/c4/*` aliases can still be added later if the frontend contract wants shorter paths.

**C3 write-back rule:** C3 never receives DB credentials. It polls C0 for fill requests and posts fill results back to C0. Backend/C4 own DB writes for job/run lifecycle state.

**Any-combination rule:** the pipeline works with any subset of components deployed. C4 is optional automation — without it, operators manually trigger C1/C2/C3 steps from the UI or CLI.

| Deployed | What works |
|---|---|
| C0 + DB only | Browse jobs, approve/reject, view resumes |
| + C1 | Jobs populate DB through CLI/service; UI trigger controls still need polish |
| + C2 | Service can generate; file-drop webpage workflow still needs polish |
| + C3 (local) | Workday extension exists; live pipeline polling/postback still needs validation |
| + C4 | API can prepare runs and bridge pending fills; live browser fill + approval UI still pending |

## Deployment Split

Local container work currently uses `docker-compose.pipeline.yml`.

Server2 deployment automation lives outside this repo. Keep this repo focused on service code, smoke scripts, and human-readable runtime docs.

## Principles

- Standalone-first: each component runnable alone. C0 + DB: required base. C4 only intentionally coupled.
- C0 backend: single API gateway — frontend never calls component services directly
- LinkedIn: highest-priority source
- Easy Apply: classified + excluded at C1 — never reaches C3/C4
- `priority = 1`: manual-only always
- Submit: always separate explicit decision from fill
- No CAPTCHA/anti-bot bypass
- Detect CAPTCHA, bot detection, MFA, or access-control challenges and stop for manual action
- Windows (local) + Linux (server2): both required

## Component Docs

Read `docs/TODO.md` for the live polish backlog by component.
