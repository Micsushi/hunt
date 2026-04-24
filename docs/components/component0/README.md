# C0 (Frontend) : Operator Dashboard

Code lives in `frontend/` plus `backend/`. Built with Vite + React 18 + TypeScript plus FastAPI backend. CLI: `ui serve` (local), `ui build` (compile only). Legacy aliases: `hunter review`, `hunter build-ui`.

## Goal

Single-page application for the operator to inspect the job queue, trigger enrichment ops, monitor logs, and eventually manage Fletcher and Executioner settings. All data comes from the FastAPI backend (`backend/app.py`) via REST.

## Locked Decisions

- Vite + React 18 + TypeScript - no framework switch without full rewrite
- CSS Modules + CSS custom properties - no CSS-in-JS
- TanStack Query v5 for data fetching + caching
- Zustand for global UI state (toasts, row selection)
- React Router v6 for client-side routing
- Session-based auth: SQLite `review_sessions` table, `hunt_session` httponly cookie, 7-day TTL
- Credentials via env vars: `HUNT_ADMIN_USERNAME` (default `admin`), `HUNT_ADMIN_PASSWORD` (required)
- `frontend/dist/` is the compiled output - not committed to git, compiled on deploy
- `ui serve` auto-builds if `frontend/dist/index.html` is missing
- `ui build` is the explicit compile command
- Multi-user / proper auth deferred to v0.4 - current single-admin model is designed to extend cleanly
- C0 stays usable for inspection and DB-backed ops even when C1/C2/C3/C4 runtimes are not running
- C0 is convenience/control-plane UI, not required for C1/C2/C3 terminal workflows

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
| `/fletcher` | Fletcher (stub) | Future: resume upload and tailoring UI |
| `/executioner` | Executioner (stub) | Future: Chrome extension settings |
| `/login` | Login | Session auth entry point |

## Component Contract

**C0 reads from:**
- `/api/summary` - queue counts, activity stats, runtime state, LinkedIn auth
- `/api/jobs` - job list with filter/sort/pagination
- `/api/jobs/{id}` - single job detail
- `/api/jobs/{id}/attempts` - resume attempt history
- `/api/jobs/count` - filtered count (for bulk dry-run display)
- `/api/logs` - auth failures, runtime events, audit entries
- `/api/ops/*` - requeue, set_status, delete, bulk ops

**Current standalone behavior:** `backend/app.py` reads shared DB/artifact state directly. Queue browsing and most current ops work without live C1/C2/C3/C4 services running; if a future UI action invokes a component runtime, that runtime must be available for that action only.

**C0 does not:** require C1/C2/C3/C4 to be running for basic browse/review, run enrichment itself, or make routing decisions on behalf of other components.

## Related

- `runbook.md` : local dev, build, deploy, testing commands
- `backend/app.py` : FastAPI backend that serves C0 and owns all `/api/*` routes
- `backend/auth_session.py` : session management
- `docs/DATA_MODEL.md` : field reference for what the API returns
