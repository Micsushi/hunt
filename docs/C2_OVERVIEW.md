# C2 Fletcher: Overview

Updated: 2026-05-12

This document explains what C2 does, how it is structured, what is working,
and what still needs attention. It is written for a human operator or
developer working on the Hunt system.

## What C2 Is

C2 is the resume tailoring service for Hunt. It takes an enriched job posting,
extracts keywords, scores and selects resume bullets, rewrites where safe,
compiles a one-page PDF, and stores the result for C3 and C4 to use.

The safety model is simple:

- Source resume `main.tex` is never altered.
- Bullet rewriting must be grounded in truthful source facts only.
- One page is a hard gate. Over-page attempts are failures.
- Every attempt is saved to the DB for review.
- Easy Apply jobs do not block C2 from generating a resume.
- C2 must remain runnable from CLI without C0, C3, or C4.

## Code Structure

C2 lives in `fletcher/`. Key modules:

- `fletcher/ad_hoc_pipeline.py`: Option B pipeline. Takes a pasted JD and
  uploaded resume, creates a DB-backed queue row, runs generation.
- `fletcher/option_a_master.py`: Option A pipeline. Takes a C1 job plus
  `master_resume.yaml`, generates tailored resume, promotes results to job-linked
  resume attempts and versions.
- `fletcher/master_resume.yaml`: candidate master resume content used for Option A.
- `fletcher/classify.py`: role family and job level classification. Heuristic
  or Ollama-backed.
- `fletcher/keywords.py`: keyword extraction from job description. Heuristic
  or Ollama-backed with max 10 verbatim keywords.
- `fletcher/bullets.py`: bullet scoring and selection.
- `fletcher/rewrite.py`: bullet rewriting with grounding and page-fit checks.
- `fletcher/compile.py`: LaTeX to PDF compile with one-page gate and reduction retry.
- `fletcher/db.py`: C2 table writes (resume_attempts, resume_versions, fletcher_jobs).
- `fletcher/service.py`: FastAPI service on port 8002.
- `fletcher/providers/`: LLM provider abstraction. Supports Ollama, OpenAI,
  OpenRouter, Anthropic, Gemini, and heuristic paths.

Key frontend files:

- `frontend/src/pages/Fletcher/index.tsx`: queue/history page, file-drop, Option B.
- `frontend/src/pages/Fletcher/review/ResumeReviewWorkspace.tsx`: shared review
  workspace used by Fletcher reviews, job-selected resumes, and attempt-level reviews.

## Step 1: Wait For Enrichment

What happens:

- C2 waits for `enrichment_status = done` on the job before generating.
- For Option B, the operator provides a pasted JD directly, skipping this wait.
- Job description is read from the `jobs` table.

Tools used:

- `jobs` table (`enrichment_status`, `description`, `apply_url`, `ats_type`)

Status:

- C1 to C2 handoff field contract defined. Server2 live handoff not yet proven.

## Step 2: Classify The Job

What happens:

- C2 determines the role family: software, PM, data, or general.
- It determines the job level: junior, mid, senior, staff, or unknown.
- Classification is heuristic when Ollama is off or unavailable.

Tools used:

- `fletcher/classify.py`
- Ollama or heuristic path

Status:

- Heuristic classification working. Ollama classify/keywords path working.
- Provider routing exists for Ollama, OpenAI, OpenRouter, Anthropic, Gemini.

## Step 3: Extract Keywords

What happens:

- C2 extracts up to 10 keywords from the job description.
- Keywords are verbatim from the posting when Ollama is used.
- Heuristic path derives keywords from title tokens when Ollama is off.
- Keywords drive bullet scoring in the next step.

Tools used:

- `fletcher/keywords.py`
- Ollama or heuristic path

Status:

- Keyword extraction working for both paths.
- Keyword inspector UI separates already-supported, added-by-rewrite, and other
  keywords. High-confidence candidate chips show candidate bullet destinations.

## Step 4: Score And Select Bullets

What happens:

- C2 scores bullets from `main.tex` against extracted keywords.
- It selects the best-matching bullets for each section.
- Optional fields like Projects can be dropped when Experience needs space.
- At least one Experience role must remain.

Tools used:

- `fletcher/bullets.py`
- Source resume parser (`main.tex`)
- Section order: Education, Experience, Projects, Technical Skills

Status:

- Heuristic scoring and selection working.
- No force-injection. Unknown fields are skipped rather than guessed.

## Step 5: Rewrite Bullets

What happens:

- Selected bullets that match keywords but are weak can be rewritten.
- Rewrites are grounded in source facts only. No fabrication.
- No-keyword rewrites preserve the original bullet.
- High-only candidate rule and page-fit retention multiplier apply.
- Rewrite safety flags are set when confidence is low.

Tools used:

- `fletcher/rewrite.py`
- LLM provider or heuristic path
- Concern flags: `weak_description`, `low_confidence_match`,
  `insufficient_source_facts`, `manual_review_recommended`

Status:

- Rewrite safety implemented. Page-fit retention multiplier working.
- Full LLM-driven rewriting path needs more production hardening with real
  candidate profile data.

## Step 6: Compile To PDF

What happens:

- C2 renders the selected and rewritten bullets into LaTeX.
- It compiles the LaTeX to PDF using the local TeX installation.
- If the output exceeds one page, it runs a controlled reduction retry.
- Attempts that fail the one-page gate are flagged as failures.

Tools used:

- `fletcher/compile.py`
- LaTeX compiler
- `resume_attempts` and `resume_versions` tables

Status:

- Compile and one-page gate working.
- Starting PDF, no-summary PDF, and with-summary PDF artifact paths working.

## Step 7: Persist And Hand Off

What happens:

- C2 writes the attempt and version to `resume_attempts` and `resume_versions`.
- It sets `selected_resume_ready_for_c3 = 1` on the job row when a version is
  selected for downstream use.
- C3 and C4 read these fields. They do not re-run resume selection logic.

Tools used:

- `fletcher/db.py`
- `jobs` table fields: `selected_resume_version_id`, `selected_resume_pdf_path`,
  `selected_resume_tex_path`, `selected_resume_selected_at`,
  `selected_resume_ready_for_c3`, `latest_resume_flags`

Status:

- Persistence and handoff fields working.
- Live C1 to C2 to C3 end-to-end not yet proven on server2.

## Step 8: Review Workspace

What happens:

- The operator can open any completed attempt in the review workspace.
- The workspace shows a PDF-like preview, PR-style diffs, and segment/block
  revert controls.
- Manual block edits are supported with local draft undo/redo and save.
- Completed rows can be downloaded as PDF, TeX, or log files.

Tools used:

- `frontend/src/pages/Fletcher/review/ResumeReviewWorkspace.tsx`
- `review_package.json` as review source of truth
- `ResumeDocument` JSON for no_summary and with_summary variants

Status:

- Review workspace working. Diff, revert, manual edit, and download confirmed.

## What Is Verified

- C2 CI passes. Pipeline, Ollama/classification, queue recovery, master resume,
  review workspace, C0 gateway, and frontend behavior tests pass.
- Option B web path: pasted JD plus TeX or text-based PDF creates a DB-backed
  queue row and processes to completion.
- Option A web path: C1 job data plus master_resume.yaml generates a tailored
  resume and promotes results into job-linked attempts/versions.
- Queue/history: persistent uploads, logs, finished history, search, newest-first
  ordering, compact rows, delete, selectable batch ZIP downloads.
- Review workspace: PDF-like preview, PR-style diffs, segment/block revert,
  manual edit, local undo/redo, save, compile, PDF/TeX/log downloads.
- Keyword inspector: separates already-supported, added-by-rewrite, and other
  keywords. High-confidence candidate chips show destinations.
- Rewrite safety: no-keyword rewrites preserve original bullet. Page-fit
  retention multiplier working.
- Postgres compat wired through shared DB path.

## What Is Still Untested Or Risky

- Candidate profile content and quality: `fletcher/master_resume.yaml` and
  `fletcher/candidate_profile.md` need real job history before LLM can surface
  better bullets. Without them, output quality is limited.
- Live server2 C1 to C2 smoke with real enriched job data not yet run.
- Provider model evaluation: OpenRouter free-model and Google/Gemini free-tier
  not yet evaluated.
- Section-level regeneration without rerunning the whole resume.
- Raw keyword-list-only targeting without a full job description.
- Auto-run generation for eligible C1 jobs without manual trigger.
- Multi-account OpenRouter rate-limit workaround not decided.

## Human Commands

Run C2 CI:

```powershell
python ci.py c2
```

Generate a resume for a job (Option A):

```powershell
.\hunter.ps1 fletch generate <job_id>
```

Start the Fletcher service:

```powershell
uvicorn fletcher.service:app --port 8002
```

Show resume attempt context from main.tex:

```powershell
.\hunter.ps1 fletch context
```

Open the Fletcher review UI (requires C0 running):

```
http://localhost:8000/fletcher
```
