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
- **Keywords** (`fletcher/keyword_extractor.py`): tiny **draft** from the job title when the backend is `heuristic`. With **`HUNT_RESUME_MODEL_BACKEND=ollama`**, the model returns **`jd_usable`** (is the scraped JD good enough to tailor from?), **`jd_usable_reason`**, and up to **10 grounded `keywords`** taken only from the title + description (no invented terms). That list becomes `must_have_terms` / `tools_and_technologies` for scoring and the review UI.
- **Heuristic** bullet scoring and selection (candidate profile + bullet library). Bullets are selected by relevance score — keywords are **never force-injected** into unrelated bullets.
- **LaTeX compile**, **one-page gate** with controlled retries.
- **SQLite**: `resume_attempts`, `resume_versions`, job latest/selected resume columns, **`get_apply_context`**.
- **Queue batch**: `python -m fletcher.cli generate-ready` (jobs with `enrichment_status` in `done` / `done_verified`). Jobs are **skipped** when there is already a resume attempt with **`jd_usable = 0`** (model said JD not usable) **and** the job `description` text is unchanged (SHA-256 fingerprint). Re-enrich or edit the description to retry. **`fletch run generate-job <job_id>`** still forces a new attempt.
- **LLM I/O logging**: prompt and response written to `ollama_prompt.txt` / `ollama_response.txt` in each attempt directory (on by default).
- **Review app**: per-attempt PDF/TeX/Keywords/LLM I/O links; keyword pills panel; LLM I/O viewer page at `/api/attempts/{id}/llm`.

### Candidate profile and bullet library

Copy the template to get started:

```bash
cp fletcher/templates/candidate_profile.template.md fletcher/candidate_profile.md
# Edit fletcher/candidate_profile.md with your real job history, projects, and skills.
# Run `fletch context` to see what Entry IDs C2 derives from your main.tex.
```

Both files are **gitignored** — they contain personal data. See the template for full instructions on Entry ID matching, role-family tags, and bullet format.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `HUNT_DB_PATH` | `<repo>/hunt.db` | Hunt SQLite DB (same as C1). |
| `HUNT_RESUME_ARTIFACTS_DIR` | `/home/michael/data/hunt/resumes` | Artifact root (attempts, PDFs, metadata). |
| `HUNT_RESUME_MODEL_BACKEND` | `heuristic` | `heuristic` (fast, no network) or `ollama`. |
| `HUNT_RESUME_MODEL_NAME` | `deterministic-stage1` | Logged when backend is heuristic. |
| `HUNT_OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama HTTP API base URL. |
| `HUNT_OLLAMA_MODEL` | `gemma2:9b` | Ollama chat model (run `ollama pull gemma2:9b` first). |
| `HUNT_OLLAMA_TIMEOUT_SEC` | `120` | Per-request timeout in seconds. |
| `HUNT_RESUME_LOG_LLM_IO` | `1` | Write prompt + response to attempt dir (`0` to disable). |
| `HUNT_RESUME_LOG_LLM_MAX_CHARS` | `120000` | Max chars captured from prompt/response. |

Ollama failures **fall back** to the heuristic classification/keywords; see `metadata.json` **`llm_enrichment`** on each attempt.

### Operator entrypoints

- **`fletch run …`** delegates to **`python -m fletcher.cli …`**.
  - Example: `fletch run generate-job 123`
- Direct: **`python -m fletcher.cli init-db`**, **`generate-job`**, **`generate-ready`**, **`generate-ad-hoc`**, **`apply-context`**, **`parse-resume`**.

### Review webapp (per-attempt)

Each attempt row in the job detail page now has direct links:

| Link | What it shows |
|------|---------------|
| **PDF** | The compiled one-page resume PDF for that attempt |
| **TeX** | The raw LaTeX source for that attempt |
| **Keywords** | The `keywords.json` extracted for that job |
| **LLM I/O** | Full Ollama prompt + raw response + timing metadata |

### Tests

```bash
fletch tests
```

Requires **`pdflatex`** (and optionally **`pdfinfo`**) on PATH for full pipeline tests. Unit tests mock `pdflatex` and run in ~5 seconds.

### v1.0 implementation note

The main gap vs v1.0 is **LLM participation in tailoring** (Stages 4–5 logic): using the LLM to rewrite/generate bullets grounded in the candidate profile, not only to refine classification/keywords. See **`docs/TODO.md`** § C2 v1.0.
