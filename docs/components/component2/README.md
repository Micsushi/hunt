# C2 (Fletcher) : Resume Tailoring

Code lives in `fletcher/`. CLI: `fletch <cmd>` (delegates to `python -m fletcher.cli`). See `docs/CLI_CONVENTIONS.md`.

## Goal

Generate a truthful, job-specific one-page resume from `main.tex` for every enriched job. Pass selected resume + metadata to C3/C4 for downstream apply.

## Locked Decisions

- Source resume is `main.tex` — immutable
- Section order locked: Education → Experience → Projects → Technical Skills
- No summary section
- One page is a hard gate — over-page attempts are failures
- Every attempt is saved (`resume_attempts` table)
- C2 generates for all jobs, not just automation-eligible ones
- C2 waits for C1 `enrichment_status = done` before generating
- Easy Apply status does not block C2 resume generation
- Projects optional when experience needs space; at least one experience role must remain
- Ollama is the planned production backend; heuristic is fallback
- Bullet rewriting must be grounded in truthful source facts only
- `main.tex`, dates, titles, employers, education, contact info are never altered
- C2 must remain runnable and testable from CLI without C0/C3/C4
- Deployment: separate Ansible stage from C1/C3/C4 — see `docs/deployment.md`

## Feature Status

### Done (~v0.1)

- [x] `main.tex` parser and round-trip renderer
- [x] Job classification — role family (software/pm/data/general) + job level — heuristic
- [x] Keyword extraction — heuristic (title tokens) when Ollama off
- [x] Ollama path: `jd_usable` check + grounded keywords (max 10, verbatim from posting)
- [x] Heuristic bullet scoring and selection (no force-injection)
- [x] LaTeX → PDF compile
- [x] One-page gate with controlled reduction retry
- [x] `resume_attempts` + `resume_versions` persistence
- [x] Selected resume DB wiring (`selected_resume_*` fields) for C3/C4 handoff
- [x] LLM I/O logging on by default (`HUNT_RESUME_LOG_LLM_IO=1`)
- [x] C0 control plane: per-attempt PDF/TeX/Keywords/LLM I/O links
- [x] C0 control plane: LLM I/O viewer (`/api/attempts/{id}/llm`)
- [x] Candidate profile template + bullet library template (`fletcher/templates/`)
- [x] Ansible Stage 7 deploy structure
- [x] `fletch context` — show Entry IDs derived from `main.tex`

### In Progress (v1.0 target)

- [ ] **Fill in `fletcher/candidate_profile.md`** with real job history — C2 can't surface better bullets without it
- [ ] **LLM prompt-driven tailoring** — prompted bullet/section rewriting grounded in candidate profile + bullet library; wire Ollama for generation (not just classify/keywords); clear fallback when model fails
- [ ] **Curate family base resumes** (`fletcher/base_resumes/`) for software/pm/data/general
- [ ] **Production hardening on server2** — queue-driven `generate-ready` with real JDs; validate `C1 done → C2 runs`
- [ ] **End-to-end C1→C2 handoff validation** on server2
- [ ] **Document operator smoke test** for v1.0 deploy

v1.0 is done when: candidate profile filled, LLM tailoring meets locked decisions in practice, handoff fields trusted by C3/C4.

### Deferred (v2.0 — do not start until v1.0 signed off)

- [ ] JD coverage/gap report (`coverage_report.json`)
- [ ] User intent capture — per-job term selections, hints
- [ ] Constrained regeneration with lineage tracking
- [ ] Scoped bullet AI edit by stable entry ID
- [ ] Interactive review UI (Stages 9–12 in this doc's old version)

### Bugs / Known Issues

- [!] **Candidate profile empty** — until filled, LLM and heuristic paths only have `main.tex` bullets to work from; output quality is limited
- [!] **LLM tailoring not wired** — Ollama used only for classify/keywords at v0.1; full generation path doesn't exist yet

## Concern Flags

Small intentional set — marks uncertainty without blocking generation:
- `weak_description`
- `low_confidence_match`
- `page_limit_failed`
- `insufficient_source_facts`
- `manual_review_recommended`

## Component Contract

**C2 receives from C1:** `enrichment_status = done`, enriched `description`, `job_url`, `apply_url`, `ats_type`

**C2 hands off to C3/C4:**
- `selected_resume_version_id`
- `selected_resume_pdf_path`, `selected_resume_tex_path`
- `selected_resume_selected_at`
- `selected_resume_ready_for_c3 = 1`
- `latest_resume_flags` (concern flags)

C3 and C4 consume these fields — they do not re-run resume selection logic.

**Standalone behavior:** C2 can be run from terminal against shared DB/job data without UI or C4. Review UI is optional for inspecting outputs, not required for generation.

## Related

- `runbook.md` : operational how-to (generate, queue, review)
- `design.md` : data model, runtime layout, implementation notes
- `docs/deployment.md` : server2 paths, Ollama config, env vars
- `docs/DATA_MODEL.md` : full resume_attempts / resume_versions schema
- `fletcher/` : implementation
- `fletcher/prompts/README.md` : prompt templates
