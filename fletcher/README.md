# fletcher

This directory is the repo home for **C2 (Fletcher)** : resume tailoring. See **`docs/NAMING.md`** for component IDs and code names.

## Version targets

| Version | Focus |
|---------|--------|
| **~v0.1 (shipped in repo)** | End-to-end pipeline, heuristic tailoring, optional Ollama for **classification + keywords only**, DB/artifacts, `fletch`, review-app structured diff + highlights, Ansible Stage 7. |
| **v1.0 (current goal)** | **LLM-driven resume generation** with prompts (bullet/skill work grounded in profile + library + JD), reliable backend (Ollama default), meet **locked decisions** in `docs/components/component2/README.md`, stable queue + one-page + C3/C4 handoff. |
| **v2.0 (deferred)** | Interactive editing: gap/coverage, user-selected keywords, constrained regen, scoped bullet edits — **Stages 9–12** in component2 README; tracked in **`docs/TODO.md`** (C2 v2.0). Not required for v1.0. |

## v0.1 runtime (what exists today)

- Parse / render **`main.tex`** (immutable OG resume), optional **family base** resumes under `fletcher/base_resumes/<family>/`.
- Heuristic **classification** and **keyword** extraction, optional **Ollama** refinement of **those two steps** when **`HUNT_RESUME_MODEL_BACKEND=ollama`**.
- **Heuristic** selection + bullet tailoring (candidate profile + bullet library), **LaTeX compile**, **one-page gate** with controlled retries.
- **SQLite**: `resume_attempts`, `resume_versions`, job latest/selected resume columns, **`get_apply_context`**.
- **Queue batch**: `python -m fletcher.cli generate-ready` (jobs with `enrichment_status` in `done` / `done_verified`).

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `HUNT_DB_PATH` | `<repo>/hunt.db` | Hunt SQLite DB (same as C1). |
| `HUNT_RESUME_ARTIFACTS_DIR` | `/home/michael/data/hunt/resumes` | Artifact root (attempts, PDFs, metadata). |
| `HUNT_RESUME_MODEL_BACKEND` | `heuristic` | `heuristic` or `ollama`. |
| `HUNT_RESUME_MODEL_NAME` | `deterministic-stage1` | Logged when backend is heuristic. |
| `HUNT_OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama HTTP API. |
| `HUNT_OLLAMA_MODEL` | `qwen3:8b` | Chat model for classification/keyword refinement. |
| `HUNT_OLLAMA_TIMEOUT_SEC` | `120` | Per-request timeout. |

Ollama failures **fall back** to the heuristic classification/keywords; see `metadata.json` **`llm_enrichment`** on each attempt.

### Operator entrypoints

- **`fletch run …`** delegates to **`python -m fletcher.cli …`**.
  - Example: `fletch run generate-job 123`
- Direct: **`python -m fletcher.cli init-db`**, **`generate-job`**, **`generate-ready`**, **`generate-ad-hoc`**, **`apply-context`**, **`parse-resume`**.

### Tests

```bash
fletch tests
```

Requires **`pdflatex`** (and optionally **`pdfinfo`**) on PATH for full pipeline tests.

### v1.0 implementation note

The main gap vs v1.0 is **LLM participation in tailoring** (Stages 4–5 logic), not more review chrome. See **`docs/TODO.md`** § C2 v1.0.
