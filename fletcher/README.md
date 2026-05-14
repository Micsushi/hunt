# fletcher

This directory is the repo home for **C2 (Fletcher)** : resume tailoring. See **`docs/NAMING.md`** for component IDs and code names.

## Version targets

| Version                           | Focus                                                                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **~v0.1 (shipped in repo)**       | End-to-end pipeline, heuristic tailoring, optional Ollama for classification, keywords, rewrite/summary checks, DB/artifacts, `fletch`, review-app structured diff + highlights, Ansible Stage 7.          |
| **v1 review workspace (current)** | DB-backed Option B queue, persistent run history, PDF/TeX import/export, full review workspace, structured resume editing, segment revert, manual block edit, compile, and shared job/attempt review flow. |
| **v2.0 (deferred)**               | Rich interactive tailoring: gap/coverage, user-selected keywords, constrained regen, scoped AI edits, and deeper provider routing.                                                                         |

## Runtime (what exists today)

- Parse / render **`main.tex`** (immutable OG resume), optional **family base** resumes under `fletcher/base_resumes/<family>/`.
- **Keywords** (`fletcher/keyword_extractor.py`): tiny draft from the job title when the backend is `heuristic`. With Ollama or another configured provider, Fletcher can fill metadata, judge JD usability, extract grounded keywords, rewrite bullets, validate rewrites, restore original inline `\textbf{...}` formatting for surviving rewritten phrases, normalize added Technical Skills phrases so their first letter is capitalized, and generate/validate summaries.
- **Heuristic** bullet scoring and selection (candidate profile + bullet library). Bullets are selected by relevance score. Keywords are never force-injected into unrelated bullets.
- **LaTeX compile**, **one-page gate** with controlled retries.
- **SQLite/Postgres**: `resume_attempts`, `resume_versions`, job latest/selected resume columns, `get_apply_context`, and DB-compatible C2 queue storage.
- **Fletcher queue and history**: DB-backed `fletcher_jobs` stores background Option B resume runs, status, input, result URLs, queue log path, review ID, and history metadata. Runs persist across app restarts and project stop/start as long as the DB persists.
- **History actions**: completed Option B runs are ordered by latest finish time, searchable in the UI, selectable, downloadable as one ZIP containing chosen artifacts such as logs, no-summary PDFs, with-summary PDFs, and TeX files, and deletable from the DB-backed history list.
- **Queue batch**: `python -m fletcher.cli generate-ready` (jobs with `enrichment_status` in `done` / `done_verified`). Jobs are skipped when there is already a resume attempt with `jd_usable = 0` and the job `description` text is unchanged (SHA-256 fingerprint). Re-enrich or edit the description to retry. `fletch run generate-job <job_id>` still forces a new attempt.
- **LLM I/O logging**: prompt and response are written to attempt directories when enabled.
- **Review app**: per-attempt PDF/TeX/Keywords/LLM I/O links, keyword pills panel, LLM I/O viewer page at `/api/attempts/{id}/llm`, and Fletcher review workspace at `/fletcher/reviews/{review_id}`.
- **Review workspace**: `review_package.json` preserves original, generated, and current editable `ResumeDocument` JSON for `no_summary` and `with_summary` versions. The UI shows a PDF-like resume surface with PR-style inline diffs, segment revert, block edit, draft undo/redo, undo-all, explicit save, compile, logs, keyword/RAG score inspection, and PDF/TeX downloads. Inline LaTeX formatting such as `\textbf{...}` and `\href{...}{...}` is rendered as bold text and links in the workspace.
- **PDF upload import**: text-based PDFs are imported through `pdfminer.six` into the canonical Hunt resume template. Scanned/image-only PDFs are not supported.
- **Master resume import**: `import-master` converts a template-compatible `main.tex` into the structured `master_resume.yaml` format for review before replacing the Option A source.
- **Provider abstraction**: `fletcher/llm/client.py` and `fletcher/llm/providers/*` normalize heuristic, Ollama, OpenAI, OpenRouter, Anthropic, and Gemini JSON calls. Cloud providers fail closed unless explicitly configured and confirmed.

### Candidate profile and bullet library

Copy the template to get started:

```bash
cp fletcher/templates/candidate_profile.template.md fletcher/candidate_profile.md
# Edit fletcher/candidate_profile.md with your real job history, projects, and skills.
# Run `fletch context` to see what Entry IDs C2 derives from your main.tex.
```

Both files are **gitignored**. They contain personal data. See the template for full instructions on Entry ID matching, role-family tags, and bullet format.

### Environment variables

| Variable                                                                                             | Default                           | Purpose                                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `HUNT_DB_PATH`                                                                                       | `<repo>/hunt.db`                  | Hunt SQLite DB (same as C1).                                                                                                     |
| `HUNT_RESUME_ARTIFACTS_DIR`                                                                          | `/home/michael/data/hunt/resumes` | Artifact root (attempts, PDFs, metadata, queue uploads, queue logs, review packages).                                            |
| `HUNT_RESUME_MODEL_BACKEND`                                                                          | `heuristic`                       | Backward-compatible selector: `heuristic` or `ollama`.                                                                           |
| `HUNT_RESUME_LLM_PROVIDER`                                                                           | `HUNT_RESUME_MODEL_BACKEND`       | Provider abstraction value: `heuristic`, `ollama`, `openai`, `openrouter`, `anthropic`, or `gemini`.                             |
| `HUNT_RESUME_LLM_MODEL`                                                                              | unset                             | Generic provider model override.                                                                                                 |
| `HUNT_RESUME_CLOUD_LLM_CONFIRM`                                                                      | unset                             | Must be `1` before cloud providers send resume content off-machine.                                                              |
| `HUNT_OPENAI_API_KEY` / `HUNT_OPENROUTER_API_KEY` / `HUNT_ANTHROPIC_API_KEY` / `HUNT_GEMINI_API_KEY` | unset                             | Cloud provider credentials. These can also be stored as redacted C2 secret settings from the Settings page.                      |
| `HUNT_RESUME_MODEL_NAME`                                                                             | `deterministic-stage1`            | Logged when backend is heuristic.                                                                                                |
| `HUNT_OLLAMA_HOST`                                                                                   | `http://127.0.0.1:11434`          | Ollama HTTP API base URL.                                                                                                        |
| `HUNT_OLLAMA_MODEL`                                                                                  | `gemma4:e4b`                      | Ollama chat model.                                                                                                               |
| `HUNT_OLLAMA_TIMEOUT_SEC`                                                                            | `120`                             | Per-request timeout in seconds.                                                                                                  |
| `HUNT_OLLAMA_KEEP_ALIVE`                                                                             | `-1`                              | How long Ollama should keep chat and embedding models loaded after a request (`-1` keeps them loaded until the container stops). |
| `HUNT_OLLAMA_NUM_PARALLEL`                                                                           | unset                             | Expected Ollama request parallelism value to include in C2 runtime logs.                                                         |
| `HUNT_OLLAMA_CONTEXT_LENGTH`                                                                         | unset                             | Expected Ollama context length value to include in C2 runtime logs.                                                              |
| `HUNT_OLLAMA_FLASH_ATTENTION`                                                                        | unset                             | Expected Ollama flash-attention setting to include in C2 runtime logs.                                                           |
| `HUNT_OLLAMA_KV_CACHE_TYPE`                                                                          | unset                             | Expected Ollama KV-cache type to include in C2 runtime logs.                                                                     |
| `HUNT_RESUME_LOG_LLM_IO`                                                                             | `1`                               | Write prompt + response to attempt dir (`0` to disable).                                                                         |
| `HUNT_RESUME_LOG_LLM_MAX_CHARS`                                                                      | `120000`                          | Max chars captured from prompt/response.                                                                                         |

The Settings page also exposes C2 component settings for provider, model, cloud confirmation, redacted provider API keys, Ollama host/model/timeout/keep-alive, rewrite parallelism/memory guards, prompt policy, keyword limits, and summary/rewrite guardrails. UI settings override environment fallbacks through `component_settings`.

### Operator entrypoints

- `fletch run ...` delegates to `python -m fletcher.cli ...`.
  - Example: `fletch run generate-job 123`
- Direct: `python -m fletcher.cli init-db`, `generate-job`, `generate-ready`, `generate-ad-hoc`, `apply-context`, `parse-resume`.
  - Example import: `python -m fletcher.cli import-master --resume path/to/main.tex --output .runtime/imported_master_resume.yaml`

### Review webapp (per-attempt)

Each attempt row in the job detail page now has direct links:

| Link         | What it shows                                           |
| ------------ | ------------------------------------------------------- |
| **PDF**      | The compiled one-page resume PDF for that attempt       |
| **TeX**      | The raw LaTeX source for that attempt                   |
| **Keywords** | The `keywords.json` extracted for that job              |
| **LLM I/O**  | Full prompt + raw response + timing metadata            |
| **Review**   | Shared review workspace backed by `review_package.json` |

### Fletcher review workspace

The `/fletcher` page is queue-backed for Option B. Submitting a job description plus `.tex` or text-based `.pdf` resume creates a background run through `/api/fletcher/tailor/jobs`, so processing continues while the browser navigates elsewhere. The page shows active queue cards and a `Fletcher history` section backed by the same DB rows. Completed runs can open `/fletcher/reviews/{review_id}`, download PDF/TeX, or view/download logs.

After a successful Option B enqueue, the UI clears the job description and keeps the selected resume file in shared app state so multiple JDs can be queued against the same source resume, even after navigating to another Hunt page and back in the same browser session. The history section is ordered by latest finish time and supports searching, selecting multiple completed rows, choosing artifact types, downloading a ZIP, and deleting finished history entries. The default batch choices are logs and no-summary resume PDFs.

The legacy synchronous `POST /api/fletcher/tailor` endpoint remains for compatibility and returns base64 artifacts plus `review_id`/`review`, but the React UI uses the queue path.

Queue API:

- `POST /api/fletcher/tailor/jobs` enqueues a background Option B run. Multipart uploads persist under the runtime root and the title is inferred from the description when omitted.
- `GET /api/fletcher/tailor/jobs?limit=100` returns active queue rows and project-local history.
- `GET /api/fletcher/tailor/jobs/{queue_item_id}` returns one queue row.
- `PATCH /api/fletcher/tailor/jobs/{queue_item_id}` edits queued input before the worker claims it.
- `POST /api/fletcher/tailor/jobs/{queue_item_id}/move` reorders queued rows.
- `POST /api/fletcher/tailor/jobs/{queue_item_id}/cancel` cancels queued rows and requests cancellation for running rows.
- `DELETE /api/fletcher/tailor/jobs/{queue_item_id}` deletes a finished history row. Active queued/running rows must be cancelled or finished first.
- `GET /api/fletcher/tailor/jobs/{queue_item_id}/log` views the queue/pipeline log; `?download=1` downloads it.
- `POST /api/fletcher/tailor/jobs/batch-download` returns a ZIP for selected history queue IDs and artifact types.

Review API:

- `GET /api/fletcher/reviews/{review_id}` returns the review package.
- `PATCH /api/fletcher/reviews/{review_id}/versions/{version}` saves the current structured resume document.
- `POST /api/fletcher/reviews/{review_id}/versions/{version}/compile` renders TeX and PDF from the current document.
- `POST /api/fletcher/reviews/{review_id}/versions/{version}/revert` resets a version to `original` or `generated`.
- `GET /api/fletcher/reviews/{review_id}/versions/{version}/pdf|tex` downloads the active artifact.
- `GET /api/fletcher/reviews/{review_id}/log` returns the pipeline log for the review package.

### Tests

```bash
fletch tests
```

Requires `pdflatex` and optionally `pdfinfo` on PATH for full pipeline tests. Unit tests mock `pdflatex` where possible.

### Current gaps

- Queue progress is polling-based and coarse. Live per-step streaming is deferred.
- Running job cancellation is best-effort.
- PDF import supports text PDFs only. Scanned/image-only PDFs need OCR or manual conversion later.
- The provider abstraction exists, but C2 pipeline migration is incremental: some lower-level paths still use the older `llm_enrich.py` compatibility layer.
