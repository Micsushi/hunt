# Fletch CLI

The C2 (Fletcher) operator CLI lives in `scripts/fletchctl.py`.
Use it through the repo-root launchers:

- Windows PowerShell: `.\fletch.ps1`
- Windows cmd: `.\fletch.cmd`
- Linux/macOS shell: `./fletch.sh`

Get help:

```powershell
.\fletch.ps1 --help
.\fletch.ps1 job --help
.\fletch.ps1 ready --help
```

```bash
./fletch.sh --help
./fletch.sh job --help
./fletch.sh ready --help
```

## Commands

- `init-db`: Initialize C2 tables/columns in a Hunt SQLite DB. Pass `--db <path>` to target a specific DB.
- `job <id>`: Generate a resume for one job by id.
- `ready`: Batch-generate resumes for all `done`/`done_verified` jobs missing a resume.
- `ad-hoc`: Generate a resume from a pasted job description (no DB job required).
- `context <id>`: Print the C2 apply context for one job.
- `parse`: Parse `main.tex` (or `--resume`) to JSON and optionally round-trip to TeX.
- `test-job <id>`: Run the full pipeline on one job and print timing + LLM output.
- `option-b-smoke`: Select enriched jobs, call the deployed Option B API, and save PDFs/logs for review.
- `index`: Manage the RAG vector index (`build`, `status`, `clear`, `query`).
- `tests`: Run C2 unit tests.
- `run`: Pass-through to `python -m fletcher.cli` with arbitrary args.

## Examples

```powershell
.\fletch.ps1 init-db
.\fletch.ps1 job 123
.\fletch.ps1 ready --limit 10
.\fletch.ps1 ad-hoc --title "SWE" --company "Acme" --jd-file jd.txt
.\fletch.ps1 option-b-smoke --count 3 --db-url "postgresql://hunt:hunt@127.0.0.1:15432/hunt"
.\fletch.ps1 index status
.\fletch.ps1 index build
```

```bash
./fletch.sh init-db
./fletch.sh job 123
./fletch.sh ready --limit 10
./fletch.sh index status
```

## Notes

- C2 reads from and writes to the same SQLite DB as C1. Point both at the same `HUNT_DB_PATH`.
- Fletcher prompt policy and numeric prompt limits are edited in the Settings tab and persisted in
  `component_settings`; see `docs/C2_SETTINGS.md`.
- Resume artifacts land in `HUNT_RESUME_ARTIFACTS_DIR` (defaults to `.runtime/resumes/` on Windows,
  `/home/michael/data/hunt/resumes` on Linux).
- The `test-job` and `ad-hoc` commands require the ollama backend for full LLM output; the
  heuristic backend works without it.
- `option-b-smoke` is the preferred CLI path for testing the current Option B UI/API flow. It logs in to
  the review app, posts enriched job descriptions to `/api/fletcher/tailor`, saves returned PDFs/logs under
  `.runtime/option-b-smokes/`, and captures a `docker logs hunt-review-1 --tail 300` snapshot per job.
  When testing the Docker stack from the host, pass `--db-url "postgresql://hunt:hunt@127.0.0.1:15432/hunt"`
  so the smoke command selects jobs from the compose Postgres database.
