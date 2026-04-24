# Hunt : React/TypeScript Frontend Plan

**Status**: Planning — not yet implemented  
**Target**: Replace SSR HTML in `backend/app.py` with a Vite + React 18 + TypeScript SPA while keeping the FastAPI backend and all existing JSON API routes intact.

---

## 0. Problem with the current UI

The current `backend/app.py` generates all HTML server-side as giant Python f-strings. Problems:

- No component reuse (everything copy-pasted between routes)
- Vanilla JS event delegation growing complex to maintain
- Clickable elements have no visible affordance or tooltip explaining what they do
- Status badges, priority flags, enrichment fields explained nowhere
- No way to add Fletcher / Executioner pages without more SSR bloat
- Hard to iterate on UX: changing a column means editing HTML in Python

---

## 1. Goals

1. Ship a proper SPA with React + TypeScript + CSS (same teal/beige color system)
2. Keep the existing FastAPI backend — no new server; all existing API routes (`/api/*`) stay unchanged
3. Serve the SPA from the same origin (`https://agent-hunt-review.mshi.ca`) via FastAPI static file mount + catch-all
4. Improve discoverability: every field, button, badge has a label or tooltip explaining it
5. Design the page/plugin system so Fletcher and Executioner pages can be added with minimal plumbing

---

## 2. Technology choices

| Concern | Choice | Reason |
|---|---|---|
| Build | Vite | Fast HMR, minimal config, first-class TS |
| UI framework | React 18 | Team familiarity, hooks, concurrent mode |
| Language | TypeScript | Type safety on API responses |
| Routing | React Router v6 | Client-side SPA routing |
| Data fetching | TanStack Query (React Query) | Caching, refetch, loading/error states |
| Styling | Plain CSS modules + CSS custom properties | Matches existing design tokens, no extra runtime |
| Global UI state | Zustand | Lightweight; for toast, selection bar |
| Icons | Heroicons (inline SVG) | No icon font loading |

No UI library (MUI, Chakra, etc.) — the existing design system is fine and worth keeping.

---

## 3. Directory layout

```
hunt/
├── frontend/                     ← NEW: SPA source
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx              ← ReactDOM.createRoot
│       ├── App.tsx               ← Router + Layout shell
│       ├── api/
│       │   ├── client.ts         ← base fetch wrapper (auth header, error)
│       │   ├── jobs.ts           ← typed wrappers for /api/jobs/*
│       │   ├── summary.ts        ← /api/summary, /health
│       │   └── ops.ts            ← /api/ops/*
│       ├── types/
│       │   ├── job.ts            ← Job, JobDetail interfaces
│       │   └── summary.ts        ← QueueSummary, AuthStatus interfaces
│       ├── hooks/
│       │   ├── useJobs.ts
│       │   ├── useSummary.ts
│       │   └── useJobDetail.ts
│       ├── store/
│       │   └── ui.ts             ← Zustand: toast, ops-token, selection
│       ├── components/
│       │   ├── Layout/           ← Shell + nav bar
│       │   ├── StatusBadge/      ← Enrichment status pill with tooltip
│       │   ├── Card/             ← Stat card (label + value)
│       │   ├── Toast/            ← Floating notification
│       │   ├── LoadingBar/       ← Top progress bar
│       │   ├── Table/            ← Generic sortable table
│       │   ├── Pagination/       ← Page nav
│       │   ├── Filters/          ← Source/status/search filter bar
│       │   ├── BulkBar/          ← Sticky selection action bar
│       │   └── FieldGrid/        ← Label+value detail grid
│       └── pages/
│           ├── Home/             ← Overview: stat cards + quick lists
│           ├── Jobs/             ← Jobs table with filters
│           ├── JobDetail/        ← Single job full detail
│           ├── Logs/             ← Replaces health-view: auth, events, audit
│           ├── Ops/              ← Requeue controls
│           └── _stubs/
│               ├── Fletcher/     ← Placeholder: resume upload + profile
│               └── Executioner/  ← Placeholder: extension settings
├── backend/
│   └── app.py                    ← MODIFIED: serve SPA + keep all API routes
└── ...
```

The `frontend/dist/` build output (ignored by git or checked in) is mounted by FastAPI.

---

## 4. Page inventory

### 4.1 Home (`/`)

**Replaces**: current `/` overview  
**Content**:
- Row of stat cards: Total, Pending, Enriched, Failed, Blocked, LinkedIn auth status (each card is clickable, navigates to `/jobs?status=X`)
- "Jump into queue" pill strip (same as current) but cards are interactive
- Three small lists: Ready now / Blocked / Failed — each row shows company, title, enrichment badge, links
- Info blurb explaining what each status means (collapsible)

### 4.2 Jobs (`/jobs`)

**Replaces**: current `/jobs`  
**Content**:
- **Sticky search + filter bar** at top: free-text search, source toggle (All / LinkedIn / Indeed), status filter chips (All / Ready / Pending / Processing / Done / Failed / Blocked), sort dropdown, direction toggle
- **Results table**: sortable columns (ID, Source, Company, Title, Enrichment status, Apply type, Attempts, Next retry, Last error, Note, Tag). Every column header has a tooltip explaining what the field means.
- **Per-row checkbox** + sticky **bulk action bar** (appears when ≥1 row selected): requeue, set status, delete
- **Pagination** strip
- **Advanced panel** (collapsed by default): bulk requeue by current filters, CSV/JSON export
- Keyboard: `j`/`k` to move rows, `Enter` to open

### 4.3 Job Detail (`/jobs/:id`)

**Replaces**: current `/jobs/{job_id}`  
**Content**:
- Header: job title, company, enrichment status badge (with tooltip), priority badge if set
- External links: "View listing" / "Apply" as clearly labeled buttons (not just "listing | apply" text)
- Tabs or collapsible sections:
  - **Overview**: all metadata fields in a labeled grid (each field has a descriptive label + the raw value)
  - **Description**: job description text in a readable panel
  - **Enrichment**: enrichment status timeline, error details, retry schedule, failure artifacts (screenshot/HTML/text previews)
  - **Resume (C2)**: AI summary, keyword pills (must-have / nice-to-have / tools), resume history cards with download links
- **Actions panel**: Requeue, Set priority (run next), Set operator notes/tag — visible with clear labels and confirmation for destructive ops

### 4.4 Logs (`/logs`)

**Replaces**: current `/health-view`  
**Content**:
- LinkedIn auth status card (big, color-coded: green=ready / red=paused) with action hint when paused
- Queue summary table (all status counts)
- Activity stats (24h window)
- Failure breakdown table (error code → count, each error code has tooltip)
- Runtime state timeline (recent `runtime_state` rows) — expandable rows showing full JSON value
- Review audit log (last 25 writes)
- systemd/journalctl cheat sheet (collapsed)
- Monitoring endpoints quick links

### 4.5 Ops (`/ops`)

**Replaces**: current `/ops`  
**Content**:
- Requeue by error code: buttons for common cases (auth_expired, rate_limited by source), showing current count next to each button
- Stale processing reset: single button + count
- Bulk filter requeue: select target statuses → dry run / run
- API reference: quick copy of POST endpoint patterns

### 4.6 Fletcher stub (`/fletcher`) — future

Not functional. Shows a card: "Resume tailoring (C2 Fletcher) — coming soon". Slots:
- Upload resume (`.tex` or `.pdf`)
- Set candidate profile text
- Set bullet library
- Trigger pipeline for a job ID
- View results

### 4.7 Executioner stub (`/executioner`) — future

Not functional. Shows a card: "Chrome extension settings (C3 Executioner) — coming soon". Slots:
- ATS settings (Workday, Greenhouse, Lever, etc.)
- Profile fields configuration
- Extension status

---

## 5. API changes to `backend/app.py`

Minimal changes — the existing API surface is reused as-is.

### 5.1 New API endpoints needed

| Endpoint | Purpose |
|---|---|
| `GET /api/logs` | Returns `runtime_state` rows + audit entries + activity stats in one call (avoids three round trips on the Logs page) |

Everything else already exists.

### 5.2 Static file serving

```python
from fastapi.staticfiles import StaticFiles

# Mount built SPA assets (JS/CSS bundles)
FRONTEND_DIST = Path(__file__).parent / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="spa-assets")

# Catch-all: serve index.html for any non-API, non-asset path
@app.get("/{full_path:path}", response_class=HTMLResponse)
def spa_shell(full_path: str):
    index = FRONTEND_DIST / "index.html"
    if index.exists():
        return HTMLResponse(index.read_text())
    raise HTTPException(status_code=503, detail="Frontend not built. Run: cd frontend && npm run build")
```

The existing HTML routes (`/`, `/jobs`, `/health-view`, `/ops`) will be **removed** once the SPA is in place. During the transition period they can coexist with the catch-all having lower priority.

### 5.3 CORS

During local development Vite runs on `localhost:5173` while FastAPI is on `localhost:8000`. Add:

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # dev only; prod serves from same origin
    allow_methods=["*"],
    allow_headers=["*"],
)
```

---

## 6. Auth token handling

`REVIEW_OPS_TOKEN` must be sent as `X-Review-Ops-Token` or `Authorization: Bearer …` on mutating requests.

In the SPA: Zustand store holds the token. On first load the SPA reads it from `localStorage`. A settings drawer (or env-aware injection) lets the user set it once per session. All mutating API calls in `client.ts` add the header automatically when the token is set.

---

## 7. Plugin / extension points for future pages

Each component folder registers itself via an optional plugin manifest:

```ts
// src/pages/Fletcher/index.tsx (example future page)
export const fletcherPlugin = {
  path: "/fletcher",
  navLabel: "Fletcher",
  navIcon: <DocumentIcon />,
  element: <FletcherPage />,
};
```

`App.tsx` imports all plugins from `src/pages/*/index.tsx` and registers their routes and nav items. Adding a new component means: create the folder, export the manifest, done — no changes to `App.tsx` needed once the loader pattern is in place.

---

## 8. UX improvements over current UI

| Current problem | Fix |
|---|---|
| Status badges have no tooltip | Add `title` attribute and `?` icon with popover |
| "listing \| apply" links not labeled | Buttons: "View listing ↗" / "Apply ↗" |
| Priority badge says "Run next" but can't be clicked | Clearly labeled "Set run-next" toggle button in actions |
| Filter chips have no count | Status chips show `(n)` count from summary |
| No explanation of what "enrichment" means | Inline help text in Logs and Job Detail |
| Audit log hard to read (raw JSON) | Formatted diff view with action labels |
| Ops page has no count next to buttons | Counts pulled from `/api/summary` shown inline |
| Runtime state rows are unreadable JSON | Pretty-printed expandable JSON viewer |

---

## 9. Implementation steps (ordered)

### Phase 1: Scaffold (non-breaking)
1. Create `frontend/` with Vite + React + TypeScript scaffold
2. Set up `vite.config.ts` with API proxy to `localhost:8000` for dev
3. Create base CSS variables matching current design tokens
4. Implement `Layout` (nav bar shell, loading bar, toast)
5. Implement `api/client.ts` (base fetch with token injection + error handling)

### Phase 2: Core data layer
6. Implement TypeScript interfaces for `Job`, `JobDetail`, `QueueSummary`
7. Implement typed API wrappers: `api/jobs.ts`, `api/summary.ts`, `api/ops.ts`
8. Implement React Query hooks: `useJobs`, `useSummary`, `useJobDetail`
9. Implement Zustand store (toast, ops-token, selection state)

### Phase 3: Home + Jobs pages
10. Implement `StatusBadge` component (pill with tooltip)
11. Implement `Card` component (stat card)
12. Implement `Home` page (stat cards + quick lists + pill strip)
13. Implement `Filters` component (search, source, status, sort)
14. Implement `Table` component (sortable, checkbox column)
15. Implement `BulkBar` (sticky bottom action bar)
16. Implement `Pagination` component
17. Implement `Jobs` page (wires Filters + Table + BulkBar + Pagination)

### Phase 4: Job detail page
18. Implement `FieldGrid` component (label + value pairs)
19. Implement `Jobs/JobDetail` page (tabs: Overview / Description / Enrichment / Resume)
20. Add artifact preview links (screenshot, HTML snapshot)
21. Add resume history cards (download PDF/TeX)

### Phase 5: Logs + Ops pages
22. Add `GET /api/logs` endpoint to backend (runtime state + audit + activity in one call)
23. Implement `Logs` page (auth card, queue tables, runtime state, audit)
24. Implement `Ops` page (requeue buttons with counts, stale reset, bulk panel)

### Phase 6: Future stubs
25. Implement `Fletcher` stub page (placeholder layout)
26. Implement `Executioner` stub page (placeholder layout)
27. Implement plugin loader pattern in `App.tsx`

### Phase 7: Backend switchover
28. Add `StaticFiles` mount + catch-all route to `backend/app.py`
29. Add CORS middleware (dev origins only)
30. Build SPA (`npm run build`), verify it works at prod URL
31. Remove old SSR routes from `backend/app.py` (keep API routes)
32. Update `ui serve` CLI command to note that a build is needed

### Phase 8: Polish
33. Keyboard navigation (`j`/`k`/`Enter`) in Jobs table
34. Session-persist filters (`sessionStorage`)
35. Auto-refresh Logs page every 30s
36. Mobile responsive check
37. Tooltips and help text for every non-obvious field

---

## 10. Files to create (Phase 1–3 start)

```
frontend/
  package.json
  tsconfig.json
  vite.config.ts
  index.html
  src/
    main.tsx
    App.tsx
    styles/
      global.css       ← CSS custom properties + resets
      tokens.css       ← design tokens (same as current :root vars)
    api/
      client.ts
      jobs.ts
      summary.ts
      ops.ts
    types/
      job.ts
      summary.ts
    hooks/
      useJobs.ts
      useSummary.ts
      useJobDetail.ts
    store/
      ui.ts
    components/
      Layout/index.tsx + Layout.module.css
      StatusBadge/index.tsx + StatusBadge.module.css
      Card/index.tsx + Card.module.css
      Toast/index.tsx + Toast.module.css
      LoadingBar/index.tsx
      Table/index.tsx + Table.module.css
      Pagination/index.tsx
      Filters/index.tsx + Filters.module.css
      BulkBar/index.tsx + BulkBar.module.css
      FieldGrid/index.tsx + FieldGrid.module.css
    pages/
      Home/index.tsx
      Jobs/index.tsx
      Jobs/JobDetail.tsx
      Logs/index.tsx
      Ops/index.tsx
      _stubs/Fletcher/index.tsx
      _stubs/Executioner/index.tsx
```

---

## 11. What stays the same

- All `/api/*` endpoints in `backend/app.py` — untouched
- `/health` JSON endpoint — untouched
- `/metrics` Prometheus endpoint — untouched
- `REVIEW_OPS_TOKEN` auth mechanism — same header, now sent by JS client
- Production URL (`https://agent-hunt-review.mshi.ca`) — unchanged
- `ui serve` CLI command — starts FastAPI on the same port

---

## 12. What changes

- `backend/app.py` gains: `StaticFiles` mount, CORS middleware, catch-all SPA route, `GET /api/logs`
- Old SSR HTML routes (`/`, `/jobs`, `/health-view`, `/ops`, `/jobs/{id}`) removed after SPA is verified
- `frontend/dist/` added to `.gitignore` (or committed for server deploy — TBD based on Ansible setup)
- `package.json` / `frontend/` added to repo — Ansible deploy step will need `npm ci && npm run build` before starting the review container

---

## 13. Open questions (resolve before Phase 7)

1. **Build artifact in git or built on deploy?** Current Ansible deploy uses Docker — easiest to build in Docker at image build time. Alternatively check in `dist/` (simpler but noisy commits).
2. **`ui serve` command**: should it auto-build if `dist/` is missing? Or just error with instructions?
3. **Ops token UX**: inject from server via `<meta>` tag in `index.html` template, or require manual entry in UI? Current approach (hidden `<input>`) works in SSR but not in SPA.
