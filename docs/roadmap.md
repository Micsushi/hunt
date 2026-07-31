# Hunt : Roadmap

Automated job application pipeline. Discover -> Enrich -> Tailor resume -> Autofill -> Submit.

## Components

| ID  | Name        | Code                     | Version      | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------- | ------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C0  | Frontend    | `frontend/` + `backend/` | 0.2          | Mostly done. React SPA, FastAPI gateway, settings/accounts, logs, jobs, and active C1-C2 surfaces exist. Remaining work is smoke validation, polish, and a few UX gaps. |
| C1  | Hunter      | `hunter/`                | 0.1          | About 95% done. Discovery/enrichment, service API, SQLite/Postgres compat, account/auth handling, settings UI, alerts, local Docker persistence, CLI, UI controls, server2 production cycle validation, and tests exist. Main remaining gap is live Easy Apply proof on a real matching row.                                                                                                                                                                                                                                                                        |
| C2  | Fletcher    | `fletcher/`              | 0.1 -> 1.0   | About 90% done. Option B review workflow and Option A master-resume/job-linked workflow exist with DB-backed queue/history, upload persistence, PDF import/export, shared review workspace, manual edits, segment revert, compile, logs, provider/settings support, milestone progress, restart recovery, job-linked resume persistence, starting artifacts, keyword inspector, and tests. Remaining gaps are real server2 C1 -> C2 proof, final generation-quality tuning, keyword-list-only targeting, section-level regeneration, and provider model evaluation. |
| C3  | Executioner | `executioner/`           | v3 planned   | V2 was removed from `main` and preserved on `codex/c3-v2-backup-20260730`. V3 is fully staged for implementation but no runtime exists yet. |
| C4  | Coordinator | `coordinator/`           | paused       | On hold as of 2026-07-30. Source is retained, but active deployment, UI, polling, smoke, and agent-worker paths are disabled. |

## Current Operator Snapshot

This is your current confidence view (subjective, as of 2026-05-08):

- C0: mostly done
- C1 / Hunter: about 95% done
- C2 / Fletcher: about 90% done
- C3: v3 planned, not implemented
- C4: paused and outside the active product scope

## Current Priority

1. Lock in C0 with local smoke coverage, doc accuracy, and UI/runtime polish
2. Validate C1 on server2: scrape, enrich, artifacts, queue drain, steady scheduler
3. Validate C2 usable operator flow on real jobs: C1 handoff, profile grounding, and better LLM/provider quality
4. Implement the approved C3 v3 stage plan
5. Keep deployment and smoke-test docs aligned with the active C0 through C2 runtime

## Cross-Component Interactions

All component API calls are routed through the C0 backend (API gateway). Components do not call each other directly.

```text
Browser (SPA)
  <-> REST
C0 Backend (FastAPI : API gateway)
  |- reads/writes Postgres directly (jobs, resumes, orchestration, settings)
  |- calls C1 API -> trigger scrape, trigger enrich, get queue, reauth LinkedIn
  |- calls C2 API -> trigger generation, one-off file-drop generate, get status
  `- reports C3 v3 as planned and unavailable
```

Current gateway routes live under `/api/gateway/*`. Older planned `/api/c1/*`, `/api/c2/*`, and `/api/c4/*` aliases can still be added later if the frontend contract wants shorter paths.

**C3 rule:** C3 v3 will own its local loop, run without C4, and never receive DB credentials.

**Active flow:** operators run C1 and C2 directly. C3 v3 is not yet runnable; C4 is not deployed.

| Deployed     | What works                                                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C0 + DB only | Browse jobs, approve/reject, view resumes                                                                                                                                                                                                                                      |
| + C1         | Jobs populate DB through CLI/service; production cycle, scheduler, auth/runtime handling, UI controls, and tests are largely proven. Remaining proof is a real Easy Apply row verification.                                                                                    |
| + C2         | Option B pasted-JD workflow and Option A job-linked master-resume workflow work through C0. Review, progress, history, artifacts, provider settings, and job-linked resume persistence are in place. Production C1 -> C2 smoke and final quality tuning still need validation. |
| + C3 | Not available until the planned v3 stages are implemented and accepted |

## Deployment Split

Local and host-native runtime deploys now use `python deploy.py ...`, which wraps `docker-compose.pipeline.yml` with stable service-bundle targets.

Server2 deployment automation lives outside this repo, but Hunt now documents the Windows operator path in `docs/SERVER2_DEPLOY.md` and exposes a repo-local wrapper at `scripts/deploy_server2.ps1`. Keep the underlying deployment logic in `ansible_homelab`.

## Principles

- Standalone-first: C1 and C2 remain independently runnable; C3 v3 must become independently runnable.
- C0 backend: single API gateway : frontend never calls component services directly
- LinkedIn: highest-priority source
- Easy Apply: classified and excluded at C1; never reaches C3 external-apply work
- `priority = 1`: manual-only always
- Submit: always separate explicit decision from fill
- CAPTCHA/anti-bot bypass is allowed for this personal-use project
- Detect CAPTCHA, bot detection, MFA, or access-control challenges and either attempt configured bypass or surface manual intervention when needed
- Windows (local) + Linux (server2): both required

## Component Docs

The C4 documents are retained as paused reference material only.
