# Hunt : Roadmap

Automated job application pipeline. Discover -> Enrich -> Tailor resume -> Autofill -> Submit.

## Components

| ID | Name | Code | Version | Status |
|---|---|---|---|---|
| C0 | Frontend | `frontend/` + `backend/` | 0.2 | Mostly done. React SPA, FastAPI gateway, settings/accounts, logs, jobs, and C2/C3/C4 surfaces exist. Remaining work is smoke validation, polish, and a few UX gaps. |
| C1 | Hunter | `hunter/` | 0.1 | Roughly 70% done. Discovery/enrichment, service API, SQLite/Postgres compat, and tests exist. Biggest remaining gap is real production validation plus auth/account/runtime polish. |
| C2 | Fletcher | `fletcher/` | 0.1 -> 1.0 | Roughly 30% working. Core service and resume pipeline exist, but the full UI workflow, real profile grounding, and stronger LLM tailoring are still incomplete. |
| C3 | Executioner | `executioner/` | 0.0 | Not meaningfully tested end to end yet. Local extension code and an initial Workday path exist, but live polling, fill, and postback validation are still pending. |
| C4 | Coordinator | `coordinator/` | 0.0 | Early scaffold only. Some API-level and smoke-test pieces exist, but the full orchestrator flow is not implemented or validated enough to treat as real end-to-end automation. |

## Current Operator Snapshot

This is your current confidence view (subjective, as of 2026-05-01):

- C0: mostly done
- C1: about 70% done
- C2: about 30% working
- C3: not tested end to end yet
- C4: not really implemented end to end yet

## Current Priority

1. Lock in C0 with local smoke coverage, doc accuracy, and UI/runtime polish
2. Validate C1 on server2: scrape, enrich, artifacts, queue drain, steady scheduler
3. Move C2 from partial pipeline to usable operator flow: webpage workflow, real profile, better LLM support
4. Prove C3 basics end to end before expanding ATS support
5. Treat C4 as early-stage scaffolding until a real browser-backed run completes end to end
6. Keep deployment and smoke-test docs aligned with what is actually working

## Cross-Component Interactions

All component API calls are routed through the C0 backend (API gateway). Components do not call each other directly.

```text
Browser (SPA)
  <-> REST
C0 Backend (FastAPI : API gateway)
  |- reads/writes Postgres directly (jobs, resumes, orchestration, settings)
  |- calls C1 API -> trigger scrape, trigger enrich, get queue, reauth LinkedIn
  |- calls C2 API -> trigger generation, one-off file-drop generate, get status
  |- exposes     -> C3 polls for pending fill requests (no inbound needed)
  `- calls C4 API -> trigger pipeline run, get run status
```

Current gateway routes live under `/api/gateway/*`. Older planned `/api/c1/*`, `/api/c2/*`, and `/api/c4/*` aliases can still be added later if the frontend contract wants shorter paths.

**C3 write-back rule:** C3 never receives DB credentials. It polls C0 for fill requests and posts fill results back to C0. Backend/C4 own DB writes for job/run lifecycle state.

**Any-combination rule:** the pipeline works with any subset of components deployed. C4 is optional automation : without it, operators manually trigger C1/C2/C3 steps from the UI or CLI.

| Deployed | What works |
|---|---|
| C0 + DB only | Browse jobs, approve/reject, view resumes |
| + C1 | Jobs populate DB through CLI/service; this is the most real path after C0, but still needs production validation and auth/runtime polish |
| + C2 | Service can generate, but the full operator workflow is still incomplete |
| + C3 (local) | Extension code exists, but live pipeline polling/postback is still unproven |
| + C4 | Some API and smoke-test scaffolding exists, but this should not yet be treated as a finished orchestration layer |

## Deployment Split

Local container work currently uses `docker-compose.pipeline.yml`.

Server2 deployment automation lives outside this repo. Keep this repo focused on service code, smoke scripts, and human-readable runtime docs.

## Principles

- Standalone-first: each component runnable alone. C0 + DB: required base. C4 only intentionally coupled.
- C0 backend: single API gateway : frontend never calls component services directly
- LinkedIn: highest-priority source
- Easy Apply: classified + excluded at C1 : never reaches C3/C4
- `priority = 1`: manual-only always
- Submit: always separate explicit decision from fill
- CAPTCHA/anti-bot bypass is allowed for this personal-use project
- Detect CAPTCHA, bot detection, MFA, or access-control challenges and either attempt configured bypass or surface manual intervention when needed
- Windows (local) + Linux (server2): both required

## Component Docs

Read `docs/TODO.md` for the live polish backlog by component.
