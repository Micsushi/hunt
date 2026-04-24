# C0 (Frontend) : Runbook

Local dev, build, and testing commands. For server2 deploy: `docs/deployment.md`. For what's implemented: `README.md`.

## Prerequisites

- Node.js 18+ (check: `node --version`)
- npm 9+ (check: `npm --version`)
- Python venv active with hunt deps (for running the backend)
- `HUNT_ADMIN_PASSWORD` set in `.env` (or exported)

## Local Dev (Hot-Reload)

Start both processes - backend in one terminal, Vite dev server in another:

**Terminal 1 - FastAPI backend:**
```bash
# Preferred
ui serve

# Or directly:
python -m backend.app
```
Backend listens on `http://127.0.0.1:8000`.

**Terminal 2 - Vite dev server:**
```bash
cd frontend
npm install        # first time only
npm run dev
```
Frontend dev server on `http://localhost:5173`. Vite proxies `/api`, `/auth`, `/health`, `/metrics` to port 8000 automatically - no CORS issues.

Open `http://localhost:5173` in browser.

For current testing, only `backend/app.py` + accessible DB/artifact files are required. C1/C2/C3/C4 services do not need to be running unless you are explicitly testing a UI feature that triggers one of those runtimes.

## Build (Production)

```bash
# via ui CLI (recommended):
ui build

# Or directly:
cd frontend
npm run build
```

Output goes to `frontend/dist/`. The backend serves this at `http://127.0.0.1:8000` when `ui serve` runs.

`ui serve` auto-builds if `frontend/dist/index.html` is missing.

## Testing Against a Real DB

The frontend needs real data to test properly. Options:

### Option A : copy DB from server2 (recommended)

```bash
# Pull DB from server2 to local (replace with your actual server hostname/path):
scp user@server2:/home/michael/data/hunt/hunt.db ./hunt.db

# Point hunt at it:
# Windows - set in .env or PowerShell:
$env:HUNT_DB_PATH = "C:\Users\sushi\Documents\Github\hunt\hunt.db"

# Then start the C0 control plane:
ui serve
```

### Option B : seed a local DB with test data

```bash
# Run one discovery scrape locally (writes to hunt.db):
hunter scrape

# Or manually insert a few test rows via sqlite3 / DB Browser for SQLite
```

### Option C : port-forward server2 backend directly

If you only need to see the UI against live data without local backend:
```bash
# SSH tunnel - maps local 8000 to server2's control-plane port:
ssh -L 8000:localhost:8000 user@server2

# Then visit http://localhost:5173 with Vite dev server running
# Vite proxies port 5173 → 8000 (tunneled to server2)
```

## Environment Variables

| Var | Default | Purpose |
|---|---|---|
| `HUNT_ADMIN_USERNAME` | `admin` | Login username |
| `HUNT_ADMIN_PASSWORD` | (required) | Login password - app warns on startup if empty |
| `HUNT_DB_PATH` | `hunt.db` in repo root | Path to SQLite DB |
| `HUNT_CORS_ORIGINS` | `http://localhost:5173` | Allowed CORS origins for Vite dev proxy |

Set these in `.env` at repo root (already gitignored).

## Common Dev Tasks

| Task | Command |
|---|---|
| Install deps | `cd frontend && npm install` |
| Start dev server | `cd frontend && npm run dev` |
| Build for production | `ui build` |
| TypeScript type check only | `cd frontend && npx tsc -b --noEmit` |
| Preview production build | `cd frontend && npm run preview` |
| Add a npm package | `cd frontend && npm install <pkg>` |

## Troubleshooting

**Login fails with 403 / no session cookie:**
- Check `HUNT_ADMIN_PASSWORD` is set
- Check backend is running on port 8000
- Check browser is hitting the Vite proxy (port 5173), not the backend directly

**API calls return 401 after login:**
- Cookie may not be sent - ensure frontend runs on `localhost:5173` (same host as proxy target)
- Check `SameSite=lax` is not blocked by browser when mixing http/https

**`dist/` out of date after code changes:**
```bash
ui build
```
Or use `npm run dev` instead - dev server always serves latest source.

**TypeScript build errors:**
```bash
cd frontend && npx tsc -b
```
Fix all errors before `ui build` will succeed.

**`npm install` fails on Windows:**
- Ensure Node 18+ is on PATH
- Try: `npm install --legacy-peer-deps`

## File Structure

```
frontend/
  index.html            # Vite entry point
  package.json          # deps: react, react-router, tanstack-query, zustand
  vite.config.ts        # proxy config, path alias @/, output to dist/
  tsconfig.json         # references app + node tsconfigs
  src/
    declarations.d.ts   # CSS module + .css type stubs
    main.tsx            # QueryClient, BrowserRouter, StrictMode
    App.tsx             # Routes + AuthGuard
    api/                # API client functions (auth, jobs, summary, ops)
    store/              # Zustand stores (ui.ts)
    hooks/              # React Query hooks
    types/              # TypeScript types (job.ts, summary.ts)
    components/         # Shared: Layout, StatusBadge, Filters, BulkBar, Pagination, Card, Toast
    pages/              # Route pages: Home, Jobs, Logs, Ops, Login, _stubs/
    styles/             # tokens.css (design tokens), global.css
  dist/                 # compiled output — gitignored, built by ui build
```
