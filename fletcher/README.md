# fletcher

This directory is the repo home for **C2 (Fletcher)** : resume tailoring. See **`docs/NAMING.md`** for component IDs and code names.

## v0.1 (current)

End-to-end pipeline:

- Parse / render **`main.tex`** (immutable OG resume), optional **family base** resumes under `fletcher/base_resumes/<family>/`.
- Heuristic **classification** and **keyword** extraction, optional **Ollama** refinement of those two steps when **`HUNT_RESUME_MODEL_BACKEND=ollama`**.
- **Selection + bullet tailoring** (heuristic scoring, candidate profile + bullet library), **LaTeX compile**, **one-page gate** with controlled retries.
- **SQLite**: `resume_attempts`, `resume_versions`, job latest/selected resume columns, **`get_apply_context`** for downstream handoff.
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

- **`hunter tailor …`** (from repo root launchers) delegates to **`python -m fletcher.cli`** — see **`hunter tailor --help`**.
- Direct module: **`python -m fletcher.cli init-db`**, **`generate-job`**, **`generate-ready`**, **`generate-ad-hoc`**, **`apply-context`**, **`parse-resume`**.

### Tests

```bash
hunter tests c2
```

Requires **`pdflatex`** (and optionally **`pdfinfo`**) on PATH for full pipeline tests.

### Still planned (post–v0.1)

- Deeper LLM-driven bullet rewriting (beyond classify/keywords).
- Richer review UI flows dedicated to C2.
