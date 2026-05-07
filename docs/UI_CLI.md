# UI CLI

The C0 operator CLI lives in `scripts/uictl.py`.
Use it through the repo-root launchers:

- Windows PowerShell: `.\ui.ps1`
- Windows cmd: `.\ui.cmd`
- Linux/macOS shell: `./ui.sh`

Get help:

```powershell
.\ui.ps1 --help
.\ui.ps1 serve --help
.\ui.ps1 build --help
```

```bash
./ui.sh --help
./ui.sh serve --help
./ui.sh build --help
```

## Commands

- `serve`: Build the frontend if needed and start the C0 control plane at `http://localhost:8000`.
  Pass `--build` to force a rebuild even if `frontend/dist/` already exists.
- `build`: Compile the React frontend (`frontend/` to `frontend/dist/`).

## Examples

```powershell
.\ui.ps1 serve
.\ui.ps1 serve --build
.\ui.ps1 build
```

```bash
./ui.sh serve
./ui.sh serve --build
./ui.sh build
```

## Notes

- The frontend build requires Node/npm on `PATH`. Run `npm install` in `frontend/` before the first build, or let `serve` handle it automatically.
- C0 serves the review app and control plane API. It does not run C1/C2: start those separately.
- Fletcher lives at `/fletcher`.
- Option B runs are queue-backed. Upload a `.tex` or text-based `.pdf`, submit the job description, and the run continues while the browser navigates elsewhere.
- The active Fletcher queue shows queued/running rows, move/cancel controls for queued rows, and log actions.
- `Fletcher history` shows previous Option B runs from the DB with job title, status, start/finish time, workspace, PDF, TeX, log actions, batch download, and delete controls.
- Completed Fletcher jobs open `/fletcher/reviews/{review_id}` for PDF-like resume diff, segment revert, manual edit, compile, PDF download, and TeX download.
- The Fletcher review inspector lists extracted keywords ordered by RAG tier and score when available. Clicking any resume block outlines it in green; clicking a changed segment also highlights that segment and enables segment revert.
- The legacy synchronous `/api/fletcher/tailor` endpoint still exists for compatibility, but the React page uses `/api/fletcher/tailor/jobs`.
- Settings are component-tabbed. C2 provider/runtime, notifications, prompt policy, and numeric guardrails live under `Settings` -> `C2 Fletcher`.
