# C2 (Fletcher) : Runbook

Operational how-to for resume generation. For server2 layout: `docs/deployment.md`. For feature status and what's broken: `README.md`.

## CLI

`fletch <cmd>` or `python -m fletcher.cli <cmd>`

These commands are primary test path for C2. UI is optional.

| Command | What it does |
|---|---|
| `fletch context` | Show Entry IDs derived from `main.tex` (use to match candidate profile) |
| `fletch generate <job_id>` | Generate resume for one job |
| `fletch generate-ready` | Queue-driven: generate for all C1-done jobs without a resume |
| `fletch status <job_id>` | Show latest attempt status for a job |
| `ui serve` | Open the C0 control plane (preferred; includes C2 tabs) |

## Setup

1. Copy template and fill in real history:
   ```bash
   cp fletcher/templates/candidate_profile.template.md fletcher/candidate_profile.md
   cp fletcher/templates/bullet_library.template.md fletcher/bullet_library.md
   ```
2. Run `fletch context` to get Entry IDs from `main.tex` — use these in `candidate_profile.md` to match bullets to entries.
3. Set env vars (see `docs/deployment.md`):
   - `HUNT_DB_PATH`
   - `HUNT_RESUME_MODEL_BACKEND=ollama` (or omit for heuristic)
   - `HUNT_RESUME_LOG_LLM_IO=1`

## Backends

| Backend | How to enable | What it does |
|---|---|---|
| Heuristic | default (no env var) | title-token keywords, scoring-based bullet selection |
| Ollama | `HUNT_RESUME_MODEL_BACKEND=ollama` | `jd_usable` check + grounded keyword extraction (max 10) |

Server2 Ollama model: `gemma4:e4b`, timeout: `300s`.

## Reviewing Output

Control plane (`ui serve`; legacy alias: `hunter review`):
- Per-job attempt history with PDF/TeX/Keywords/LLM I/O links
- `/api/attempts/<id>/llm` — full Ollama prompt, raw response, timing
- `/api/attempts/<id>/pdf` — generated PDF
- Structured diff panel showing bullet changes

## Artifact Layout

Runtime artifacts live **outside** the git checkout:
- Server2: `/home/michael/data/hunt/resumes/`
- Local: set `HUNT_ARTIFACTS_DIR` or rely on default

Each attempt produces: `job_description.txt`, `keywords.json`, `structured_output.json`, `output.tex`, `output.pdf`, `compile.log`, `metadata.json`

## Recovery

**Attempt failed (page limit):**
- Inspect `compile.log` via the control plane
- Re-run with `fletch generate <job_id>` — pipeline retries with controlled reduction

**JD not usable (`jd_usable = 0`):**
- Check `jd_usable_reason` in the control-plane LLM I/O viewer
- Weak/sparse JD falls back to heuristic path automatically

**Re-generate after filling candidate profile:**
```bash
fletch generate <job_id>
```
