# C2 Option B Run History Implementation Plan
> REQUIRED SUB-SKILL: Inline execution in this session because the user asked to implement now.

Goal: Add a durable Option B Fletcher run history that shows previous runs with inferred job title, start time, review workspace, PDF, TeX, and log actions.

Architecture: Reuse the existing DB-backed `fletcher_jobs` table as the history store so runs persist across app restarts and project stop/start. Keep redeploy durability dependent on the deployment DB volume, matching the rest of Hunt state. Split the Fletcher UI into active queue and completed history sections while sharing the same queue item type and endpoints.

Tech Stack: FastAPI, SQLite/Postgres through `hunter.db_compat`, React, TanStack Query, CSS modules, pytest, ESLint, TypeScript.

## Task 1: Backend Metadata
Files: Modify `backend/app.py`, `tests/test_c0_control_api.py`.
- [x] Test: enqueue without explicit title and assert `input.title` is inferred from the description.
- [x] Code: call `infer_title_from_description()` in `/api/fletcher/tailor/jobs` when title is absent.
- [x] Verify: `.\.venv\Scripts\python.exe -m pytest tests\test_c0_control_api.py::C0ControlApiTests::test_fletcher_queue_infers_history_title -q`.

## Task 2: History UI
Files: Modify `frontend/src/pages/Fletcher/index.tsx`, `frontend/src/pages/Fletcher/Fletcher.module.css`.
- [x] Test: assert Fletcher UI contains `Fletcher history`, `Started`, `Open workspace`, `PDF`, `TeX`, and `Download log`.
- [x] Code: split jobs into active and history lists. Active list keeps move/cancel/status actions. History list shows title, started/created time, status, workspace/PDF/TeX/log actions.
- [x] Verify: `npm run typecheck`, `npm run lint`.

## Task 3: Full Verification and Docs
Files: Modify `tests/test_frontend_jobs_ui.py`, vault C2 plan, vault log.
- [x] Verify: `.\.venv\Scripts\python.exe ci.py all`.
- [x] Capture: update `C:\Users\sushi\Documents\agentsvault\Wiki\Projects\Hunt\c2-resume-review-diff-ui-plan.md`.
- [x] Capture: append `C:\Users\sushi\Documents\agentsvault\log.md`.

## Task 4: Batch History Downloads
Files: Modify `backend/app.py`, `frontend/src/api/control.ts`, `frontend/src/pages/Fletcher/index.tsx`, `frontend/src/pages/Fletcher/Fletcher.module.css`, `tests/test_c0_control_api.py`, `tests/test_frontend_jobs_ui.py`.
- [x] Test: batch download endpoint returns a ZIP containing selected log and no-summary PDF artifacts.
- [x] Code: add `POST /api/fletcher/tailor/jobs/batch-download` with `queue_item_ids` and artifact checkboxes for `log`, `no_summary_pdf`, `with_summary_pdf`, `no_summary_tex`, and `with_summary_tex`.
- [x] Code: add history row selection, select-all/clear controls, and artifact choices in the Fletcher history UI.
- [x] Code: clear only the Option B JD after enqueue while keeping the selected resume file in shared app state.
- [x] Verify: focused backend/UI tests and TypeScript typecheck.

## Completed Outcome

- Option B run history is backed by `fletcher_jobs`, not local browser state.
- The history view persists across app restarts and project stop/start when the DB persists.
- History rows expose workspace, PDF, TeX, view log, and download log actions.
- History rows can be selected for one ZIP download with operator-selected artifact types. The default artifact choices are logs plus no-summary resume PDFs.
- Successful Option B enqueue clears the job description so the next JD can be pasted, while the uploaded resume remains selected for the next run and survives same-session Hunt route changes.
- The jobs endpoint accepts `limit` so the UI can request a fuller history window.
- Verification: `.\.venv\Scripts\python.exe ci.py all` passed with 535 tests passing and 6 skipped.
