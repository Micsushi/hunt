# Local Dev Modes Stage Findings

Temporary repo notes for implementation. Summarize/move at end.

## Stage 1: DB-backed C0 blockers

Status: complete.

Findings:
- Initial repo worktree was clean.
- Repo does not contain `docs/superpowers/plans/2026-05-01-local-dev-modes.md`; active staged plan source is vault page `Wiki/Projects/Hunt/local-dev-modes-plan.md`.
- Need tests for auth session DB routing and job boolean JSON normalization before implementation.
- Red test results:
  - `tests/test_local_dev_modes.py`: auth session test failed because `backend/auth_session.py` used `sqlite3.connect`.
  - `tests/test_local_dev_modes.py`: job JSON test failed because `_job_json` did not exist.
- C0 container smoke initially failed because `Dockerfile.review` builds frontend and existing TypeScript errors blocked image build:
  - `JobDetail.tsx` cast to `Record<string, unknown>`.
  - `description_source` missing from patchable job fields.
- Fixes:
  - `backend/auth_session.py` now uses `hunter.db_compat.get_connection()`.
  - `schema/postgres_schema.sql` now includes `review_sessions` and `idx_sessions_expires`.
  - `backend/app.py` normalizes job boolean fields to `0`/`1`/`null` for JSON responses.
  - `docker-compose.pipeline.yml` now has local profiles `db`, `c0`, `c1c2`, `all`; C0 no longer depends on C1/C2/C4.
  - Frontend TS blocker fixed in job detail typing.
- Verification:
  - `.venv/Scripts/python.exe -m pytest tests/test_db_compat.py tests/test_new_tables.py tests/test_local_dev_modes.py -q`: 30 passed.
  - `docker compose -f docker-compose.pipeline.yml config --profiles`: `all`, `c0`, `c1c2`, `db`, `pipeline`.
  - `cd frontend && npm run typecheck`: exit 0.
  - `docker compose -f docker-compose.pipeline.yml --profile c0 up -d --build`: built and started Postgres + C0.
  - `docker compose ps`: only `hunt-postgres-1` and `hunt-review-1` running.
  - `curl.exe` login returned `HTTP/1.1 200 OK`; `/auth/me` returned authenticated admin.
  - `SELECT COUNT(*) FROM review_sessions;`: 1.

## Stage 2: layered frontend commands

Status: complete.

Findings:
- Added `scripts/dev-mode.ps1` as Windows launcher for modes `ui`, `db`, `c0`, `c1c2`, `all`.
- Added npm scripts:
  - `dev`
  - `dev:db`
  - `dev:c0`
  - `dev:c1c2`
  - `dev:all`
  - `vite:raw`
- Used `powershell.exe -NoProfile` in npm scripts so WSL/Git Bash invoking Windows npm can still resolve the shell.
- Vite proxy now reads `VITE_BACKEND_URL`, defaulting to `http://127.0.0.1:8000`.
- Verification:
  - `cd frontend && npm run typecheck`: exit 0.
  - PowerShell AST parse for `scripts/dev-mode.ps1`: OK.
  - PowerShell JSON parse confirmed package scripts present.
  - `timeout 12s npm run dev`: Vite ready at `http://localhost:5173/`, timeout killed long-running server with exit 124 as expected.

## Stage 3: UI-only mock mode

Status: complete.

Findings:
- Added `frontend/src/mocks/data.ts` and `frontend/src/mocks/client.ts`.
- `VITE_MOCK_BACKEND=true` now intercepts shared API client `get/post/patch/delete`.
- Raw fetch helpers are handled:
  - `auth.login()` returns immediately in mock mode.
  - `tailorResume()` returns a fake resume text `Blob` in mock mode.
- App skips auth fetch in mock mode and shows fixed mock banner.
- Jobs CSV/JSON exports use data URLs in mock mode; real backend links remain for DB-backed modes.
- Resume/artifact mock fixture paths are null so backend artifact links stay hidden unless real backend data exists.
- Build type gap found: `ImportMeta.env` needed Vite client type reference in `frontend/src/declarations.d.ts`.
- Verification:
  - `cd frontend && npm run typecheck`: exit 0.
  - Playwright route smoke against `npm run dev`: `/`, `/jobs`, `/jobs/1`, `/logs`, `/ops`, `/fletcher`, `/executioner`, `/coordinator` all HTTP 200.
  - Playwright export check: CSV and JSON hrefs are `data:` URLs in mock mode.
  - `cd frontend && npm run build`: exit 0. Vite chunk-size warning only.

## Stage 4: C1/C2 local service mode

Status: complete.

Findings:
- `docker compose -f docker-compose.pipeline.yml --profile c1c2 up -d --build` starts only:
  - `hunt-postgres-1`
  - `hunt-review-1`
  - `hunt-hunter-1`
  - `hunt-fletcher-1`
- It does not start coordinator/C4 or frontend containers.
- C0 remains usable when C4 is absent; `/api/gateway/c4/status` returns service unavailable instead of preventing startup.
- C1 gateway status and queue work through C0.
- C2 gateway status works through C0.
- First real resume download smoke reached Fletcher but failed with `tool_missing`: `pdflatex not found`.
- Added LaTeX runtime packages to both `Dockerfile.review` and `Dockerfile.fletcher`.
- Second smoke failed on `fontawesome5.sty` missing; added `texlive-fonts-extra`.
- Tradeoff: `texlive-fonts-extra` is large. It downloaded about 624 MB and made the LaTeX layer heavy, but it is required by the current base resume template icons.
- Final real resume smoke posted `fletcher/base_resumes/software/main.tex` through C0 `/api/fletcher/tailor` and received a real PDF.
- Verification:
  - `docker compose -f docker-compose.pipeline.yml ps`: Postgres, review, hunter, and fletcher only.
  - C0 login: `{"status":"ok","username":"admin"}`.
  - C1 status: `{"service":"c1-hunter", ...}`.
  - C1 queue: `{"pending":0,"ready":0}`.
  - C2 status: `{"service":"c2-fletcher","generate_running":false}`.
  - C4 status: `{"detail":"Service unavailable: http://coordinator:8003/status"}`.
  - `/api/fletcher/tailor`: `HTTP 200`, 42 KB PDF, `file` reports `PDF document, version 1.7`.
