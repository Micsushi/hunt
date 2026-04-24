# C0 (Frontend) : Operator Dashboard

Code lives in `frontend/` plus `backend/`. Two containers: `hunt-frontend` (nginx serving compiled SPA) and `hunt-backend` (FastAPI). CLI: `ui serve` (local dev), `ui build` (compile only). Legacy aliases: `hunter review`, `hunter build-ui`.

## Goal

SPA for operator: inspect queue, trigger component actions, manage settings/LinkedIn accounts, review resumes, approve submits. All data via FastAPI backend REST.

Backend: API gateway — DB direct + calls component service APIs. Frontend never calls component services directly.

## Locked Decisions

- Vite + React 18 + TypeScript — no framework switch without full rewrite
- CSS Modules + CSS custom properties — no CSS-in-JS
- TanStack Query v5 for data fetching + caching
- Zustand for global UI state (toasts, row selection)
- React Router v6 for client-side routing
- Session-based auth: `review_sessions` table, `hunt_session` httponly cookie, 7-day TTL
- Credentials via env vars: `HUNT_ADMIN_USERNAME` (default `admin`), `HUNT_ADMIN_PASSWORD` (required)
- `frontend/dist/` is the compiled output — not committed to git, compiled on deploy
- `ui serve` auto-builds if `frontend/dist/index.html` is missing
- `ui build` is the explicit compile command
- Multi-user / proper auth deferred to v0.4 — current single-admin model is designed to extend cleanly
- C0 stays usable for browse/review/settings even when C1/C2/C3/C4 services are not running — those actions simply show as unavailable
- C0 is convenience/control-plane UI, not required for C1/C2/C3 terminal workflows
- Backend calls component service APIs; frontend never calls component services directly
- Component availability is determined by a `/api/status` endpoint that health-checks each configured service URL

## Feature Status

### Done

- [x] Vite scaffold: `frontend/package.json`, `tsconfig`, `vite.config.ts`
- [x] CSS design tokens matching existing beige/teal system (`src/styles/tokens.css`)
- [x] API client layer with `credentials: 'include'`, 401 redirect (`src/api/client.ts`)
- [x] Auth API: `fetchAuthStatus`, `login`, `logout` (`src/api/auth.ts`)
- [x] Zustand UI store: toasts (auto-dismiss 3.5s), row selection (`src/store/ui.ts`)
- [x] React Query hooks: `useSummary`, `useJobs`, `useJobDetail`, `useLogs`
- [x] Layout with sticky nav, username display, sign-out, Health/Metrics links
- [x] Login page - centered form, form-encoded POST to `/auth/login`
- [x] Home page - 6 stat cards, jump strip, three quick lists (ready/blocked/failed)
- [x] Jobs page - sortable table, URL-synced filters, keyboard nav (j/k/Enter), sessionStorage persistence, CSV/JSON export links, bulk ops panel
- [x] Job detail page - 4 tabs: Overview, Description, Enrichment, Resume
- [x] Logs page - LinkedIn auth card, queue summary, activity stats, failure breakdown, runtime state, audit log, auto-refreshes 30s
- [x] Ops page - requeue buttons with live counts, stale reset, bulk requeue by status
- [x] Fletcher stub page with plugin manifest
- [x] Executioner stub page with plugin manifest
- [x] Session auth backend: `backend/auth_session.py` (create/validate/delete/purge)
- [x] FastAPI: CORS middleware, StaticFiles mount, `/auth/login|logout|me`, `require_auth` dependency, SPA catch-all
- [x] `ui build` CLI command
- [x] Auto-build on `ui serve` if dist missing
- [x] `.gitignore` entries for `frontend/dist/` and `frontend/node_modules/`
- [x] TypeScript compiles clean (tsc -b passes, Vite build passes)

### In Progress / Needs Work

- [ ] **End-to-end test with real DB** - run locally against a copy of hunt.db from server2
- [ ] **BulkBar bulk ops** - verify requeue/set_status/delete API calls work against live backend
- [ ] **Job detail tab routing** - confirm URL hash or query param preserves active tab on reload
- [ ] **Responsive layout** - untested below 1200px

### Bugs / Known Issues

None confirmed yet - not tested against live data.

## Pages

| Route | Page | Purpose |
|---|---|---|
| `/` | Home | Stat cards + quick lists |
| `/jobs` | Jobs | Full queue table with filters and bulk ops |
| `/jobs/:id` | Job detail | Per-job metadata, enrichment, resume history |
| `/logs` | Logs | Auth status, queue stats, error breakdown, audit log |
| `/ops` | Ops | Requeue controls, bulk ops |
| `/fletcher` | Fletcher | Resume file-drop (one-off generation), generation history, C2 settings — stub until C2 service wired |
| `/executioner` | Executioner | C3 settings (pulled from DB, pushed to extension), apply attempt history — stub until C3 wired |
| `/coordinator` | Coordinator | Pending runs, manual review queue, submit approval — stub until C4 wired |
| `/settings` | Settings | Per-component settings (reads/writes `component_settings` table), LinkedIn account management |
| `/status` | Status | Live health indicators for each component service |
| `/login` | Login | Session auth entry point |

## Component Contract

**C0 backend reads/writes DB directly:**
- All `jobs`, `resume_attempts`, `resume_versions`, `orchestration_runs`, `orchestration_events`, `submit_approvals`, `review_sessions`, `runtime_state`, `component_settings`, `linkedin_accounts`

**C0 backend calls component service APIs:**
- `C1_API_URL` — trigger scrape, trigger enrich, get queue health, trigger LinkedIn re-auth
- `C2_API_URL` — trigger generation for job_id, one-off file-drop generation, get generation status
- `C4_API_URL` — trigger pipeline run, get run list, submit approval actions
- C3 has no inbound API — C3 polls `GET /api/c3/pending-fills`; backend queues fill requests written by C4

**`/api/status` response shape:**
```json
{
  "hunter":      { "online": true/false },
  "fletcher":    { "online": true/false },
  "executioner": { "online": true/false },
  "coordinator": { "online": true/false }
}
```
If a component URL is not configured, it reports `online: false`. UI grays out that section.

**C0 does not:** require any component service to be running for browse/review/settings operations.

## Related

- `runbook.md` : local dev, build, deploy, testing commands
- `backend/app.py` : FastAPI backend that serves C0 and owns all `/api/*` routes
- `backend/auth_session.py` : session management
- `docs/API_CONTRACTS.md` : C0 gateway and component service API shapes
- `docs/SETTINGS_AND_SECRETS.md` : settings, tokens, LinkedIn account storage
- `docs/DATA_MODEL.md` : field reference for what the API returns
