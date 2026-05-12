# C0 Operator Dashboard: Overview

Updated: 2026-05-12

This document explains what C0 is, how it is structured, what is working,
and what still needs attention. It is written for a human operator or
developer working on the Hunt system.

## What C0 Is

C0 is the operator control plane for Hunt. It consists of a React SPA served
by nginx and a FastAPI backend that acts as an API gateway. The frontend
never calls component services directly. All data flows through the backend.

C0 stays usable for browse, review, and settings even when C1, C2, C3, and
C4 are not running. Those sections simply show as unavailable.

The safety model is simple:

- Frontend calls backend only, never component services directly.
- Auth is session-based with an httponly cookie. Single admin model.
- Component availability is checked by the backend health endpoint, not assumed.
- C0 is convenience and control plane, not required for C1/C2/C3 terminal workflows.

## Code Structure

C0 lives in two folders:

- `frontend/` - Vite + React 18 + TypeScript SPA. CSS Modules with custom
  properties. TanStack Query v5 for data fetching. Zustand for UI state.
  React Router v6 for routing.
- `backend/` - FastAPI app. Serves the compiled frontend, owns all `/api/*`
  routes, and proxies to component services via the gateway.

Key backend files:

- `backend/app.py`: main FastAPI app, all `/api/*` route registration.
- `backend/auth_session.py`: session create/validate/delete/purge.
- `backend/gateway.py`: gateway router mounted at `/api/gateway/*`.
- `backend/db_compat.py`: shared DB connection factory.

Key frontend files:

- `frontend/src/api/client.ts`: base API client with auth and 401 redirect.
- `frontend/src/store/ui.ts`: Zustand store for toasts and row selection.
- `frontend/src/pages/`: one folder per SPA page.

## Pages

| Route | Page | Purpose |
|---|---|---|
| `/` | Home | Stat cards, jump strip, three quick lists |
| `/jobs` | Jobs | Sortable table, filters, keyboard nav, bulk ops |
| `/jobs/:id` | Job detail | Per-job metadata, enrichment, resume tabs |
| `/logs` | Logs | Auth card, queue stats, failure breakdown, audit log |
| `/ops` | Ops | Requeue controls, bulk ops, stale reset |
| `/fletcher` | Fletcher | Resume file-drop, queue history, review workspace |
| `/executioner` | Executioner | C3 settings, pending fills, apply attempt history |
| `/coordinator` | Coordinator | Pending runs, manual review queue, submit approval |
| `/settings` | Settings | Per-component settings, LinkedIn account management |
| `/status` | Status | Live health indicators for each component service |
| `/login` | Login | Session auth entry point |

## Backend API Areas

C0 backend routes cover four areas:

**DB Direct Routes** - read and write shared tables without calling a component
service. These work even when C1/C2/C3/C4 are offline.

- `GET /api/jobs`, `GET /api/jobs/:id` - job list and detail.
- `GET /api/summary/...`, `GET /api/summary/timeline` - overview chart data.
- `GET /api/logs` - structured log query with service/level/time filters.
- `GET /api/settings`, `POST /api/settings` - component_settings table.
- `GET /api/linkedin/accounts`, `POST /api/linkedin/accounts` - account list.
- `GET /api/c3/pending-fills`, `POST /api/c3/fill-result` - C3 bridge.
- `GET /api/system/status` - health check for all component services.

**Gateway Routes** - proxy to component service APIs with the service token.
Mounted at `/api/gateway/*`. Returns 503 if the target service is unreachable.

- `/api/gateway/c1/*` - forwards to C1 service at `C1_API_URL`.
- `/api/gateway/c2/*` - forwards to C2 service at `C2_API_URL`.
- `/api/gateway/c4/*` - forwards to C4 service at `C4_API_URL`.

**Fletcher Queue Routes** - C0 owns the browser-facing Fletcher queue and
review routes. Queue rows are DB-backed in `fletcher_jobs`. Processing
continues across page navigation and second browser tabs.

**Auth Routes** - `/auth/login`, `/auth/logout`, `/auth/me`.

## Component Contract

C0 backend reads and writes all shared tables directly: `jobs`,
`resume_attempts`, `resume_versions`, `orchestration_runs`,
`orchestration_events`, `submit_approvals`, `review_sessions`,
`runtime_state`, `component_settings`, `linkedin_accounts`.

C0 backend calls component service APIs:

- `C1_API_URL` - trigger scrape, trigger enrich, get queue health, trigger reauth.
- `C2_API_URL` - trigger generation, one-off file-drop, get generation status.
- `C4_API_URL` - trigger pipeline run, get run list, submit approval actions.
- C3 has no inbound API. C3 polls `GET /api/c3/pending-fills` and posts back
  via `POST /api/c3/fill-result`. C0 queues fill requests written by C4.

## What Is Verified

- SPA scaffold compiles cleanly. TypeScript and Vite build pass.
- Session auth flow works for login, logout, and protected routes.
- All SPA pages render without crashing against stubbed or empty data.
- Gateway proxy routes mount and forward correctly.
- Fletcher queue and review workspace work in browser against local backend.
- Summary and timeline endpoints work for both SQLite and Postgres via db_compat.
- Logs endpoint accepts service/level/time filters.
- Jobs API supports category and ats_type filter slices.
- C0 startup and static file serving work with `ui serve` and `ui build`.
- `scripts/smoke_c0_pipeline_container.sh` local compose smoke runs.

## What Is Still Untested Or Risky

- End-to-end test with real DB from server2 production data.
- BulkBar bulk ops against a live backend with real queue rows.
- Job detail tab routing on reload (URL hash / query param preservation).
- Responsive layout below 1200px.
- C3 heartbeat and extension version status from real extension postback.
- Credential encryption entry and full edit/deactivate flows in Settings.
- Server2 C0 smoke against production Postgres and live component URLs.
- Logs are synthesized from summary and audit tables until dedicated log storage exists.

## Human Commands

Build the frontend:

```powershell
python -m hunter.cli ui build
```

Start local dev server:

```powershell
python -m hunter.cli ui serve
```

Run the C0 compose smoke:

```bash
bash scripts/smoke_c0_pipeline_container.sh
```

Check system health (requires backend running):

```
GET http://localhost:8000/api/system/status
```
