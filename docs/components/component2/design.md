# C2 (Trapper) : Design Notes

## Purpose

This document captures the current recommended design for C2 (Trapper) based on the repo state and the user decisions locked in so far.

C2 (Trapper) should stay runnable on its own, but it is intended to sit in the larger production flow:

1. C1 scrape
2. C1 enrichment
3. C1 UI enrichment if needed
4. C2 resume generation
5. C3 browser autofill uses the selected resume when the job is actually ready for apply work
6. C4 orchestration later decides whether to invoke C3 and whether final submit should happen

## Core Invariants

The following rules should be treated as hard constraints.

- The OG resume is `main.tex`.
- The OG resume stays unchanged.
- The document order remains:
  - `Education`
  - `Experience`
  - `Projects`
  - `Technical Skills`
- No summary section is added.
- The visual LaTeX structure should remain recognizable and stable.
- Dates do not change.
- Titles do not change.
- Employers do not change.
- Education does not change.
- Contact information does not change.
- Experience and project bullets may change if they stay truthful.
- At least one experience entry should remain.
- The `Projects` section is optional if experience needs the space.
- One page is a hard gate.

## C1 (Hunter) Handoff

C2 (Trapper) should be able to run independently of C1 (Hunter), but the normal queue-driven path should consume C1 output.

Recommended automatic trigger:
- C2 queues a job when C1 enrichment reaches:
  - `done`
  - `done_verified`

C2 should not auto-run yet when C1 is still in:
- `pending`
- `processing`
- `blocked`
- `blocked_verified`

Important separation:
- `apply_type = external_apply` and `auto_apply_eligible = 1` matter for C3
- those fields should not block C2 from generating a resume
- C2 should support all job sources

Recommended downstream relationship:
- C1 is the source of truth for whether the JD is still waiting on headless or UI enrichment
- C2 is the source of truth for whether a usable one-page resume currently exists
- C3 should use the latest useful C2 result instead of generating a new resume inside the apply flow
- C4 or OpenClaw should normally request one explicit apply context for a `job_id` before invoking C3
- in the current C4 direction, that explicit handoff should come from one shared apply-prep command

## Inputs

### Required inputs

- the OG resume in `main.tex`
- a job record or ad hoc JD input
- a compile toolchain

### Grounding inputs

- candidate profile file
- bullet library file
- later curated base resumes by role family

### Optional model backends

- default: Ollama on `server2`
- later: Gemini or other API backends

## Role Family And Job Level

Initial role families:
- `software`
- `pm`
- `data`
- `general`
- `unknown`

Initial job-level buckets:
- `intern`
- `new_grad`
- `junior`
- `mid`
- `senior`
- `staff`
- `principal`
- `manager`
- `director`
- `unknown`

These should be used for:
- selecting the best base resume
- choosing which bullets to emphasize
- deciding when to fall back
- later UI filtering

## Resume Construction Strategy

Recommended strategy:

1. Start from the best available base:
   - matching family resume when one exists
   - otherwise the OG resume
2. Parse the starting LaTeX into a structured representation.
3. Use the JD plus candidate facts to decide:
   - which experience roles to keep
   - which bullets to keep
   - which projects to keep
   - which skills to emphasize
4. Rewrite or generate bullet text while preserving truth.
5. Render back into the same LaTeX structure.
6. Compile and enforce the one-page gate.

This means C2 should support both:
- selection from an existing bullet pool
- truthful generation when useful source facts exist but the exact wording does not yet

## Fallback Strategy

Fallback should happen only after a normal attempt has been evaluated.

Recommended fallback order:
1. tailored attempt from the chosen base
2. family base resume when the JD is too weak for trustworthy tailoring
3. OG resume if the job type cannot be classified well enough

Fallback should still:
- save all artifacts
- save the reason the fallback was used
- surface concern flags

## Concern Flags

Keep the flag set intentionally small.

Recommended initial flags:
- `weak_description`
- `low_confidence_match`
- `page_limit_failed`
- `insufficient_source_facts`
- `manual_review_recommended`

Flags should not automatically block the output unless the output itself is unusable.

## Proposed DB Shape

The cleanest likely structure is:

### On `jobs`

Keep latest-result fields only.

Suggested fields:
- `resume_status`
- `latest_resume_attempt_id`
- `latest_resume_version_id`
- `latest_resume_pdf_path`
- `latest_resume_tex_path`
- `latest_resume_keywords_path`
- `latest_resume_job_description_path`
- `latest_resume_family`
- `latest_resume_job_level`
- `latest_resume_model`
- `latest_resume_generated_at`
- `latest_resume_fallback_used`
- `latest_resume_flags`
- `selected_resume_version_id`
- `selected_resume_pdf_path`
- `selected_resume_tex_path`
- `selected_resume_selected_at`
- `selected_resume_ready_for_c3`

### In `resume_attempts`

Store full history.

Suggested fields:
- `id`
- `job_id`
- `attempt_type`
- `status`
- `latest_result_kind`
- `role_family`
- `job_level`
- `base_resume_name`
- `source_resume_type`
- `source_resume_path`
- `fallback_used`
- `model_backend`
- `model_name`
- `prompt_version`
- `concern_flags`
- `job_description_path`
- `keywords_path`
- `structured_output_path`
- `tex_path`
- `pdf_path`
- `compile_log_path`
- `metadata_path`
- `created_at`

### In `resume_versions`

Store immutable output identity for downstream use.

Suggested fields:
- `id`
- `job_id`
- `resume_attempt_id`
- `source_type`
- `label`
- `pdf_path`
- `tex_path`
- `content_hash`
- `created_at`
- `is_latest_generated`
- `is_latest_useful`
- `is_selected_for_c3`

The exact schema can still move, but the latest-on-job plus history-table split is the recommended default.

## C2 To C3 Handoff

C2 (Trapper) should not leave C3 (Executioner) guessing which file to upload.

Recommended contract:

- every saved output gets an immutable `resume_version`
- one output may be marked as:
  - latest generated
  - latest useful
  - selected for C3
- C3 should consume:
  - `selected_resume_version_id`
  - `selected_resume_pdf_path`
  - `selected_resume_ready_for_c3`

Recommended normal downstream flow:
- C4 or OpenClaw fetches one explicit apply context for the chosen `job_id`
- in the current plan, that is the shared apply-prep command
- that apply context bundles:
  - `apply_url` from C1
  - selected resume path from C2
  - selected resume version or attempt id
  - best available JD snapshot path
  - relevant flags that may affect apply behavior
- C3 receives that explicit answer and is primed with the selected resume rather than recomputing selection logic during the fill run

Recommended behavior:

1. C2 may generate several attempts for one job
2. only one resume version should be selected for downstream apply use at a time
3. C3 should upload the selected resume, not merely the latest generated file
4. C4 may later change which selected resume to use, but C3 should still receive one explicit answer

## Runtime Storage Layout

Generated artifacts should live outside the repo.

Recommended root on `server2`:
- `/home/michael/data/hunt/resumes`

Recommended layout:

```text
/home/michael/data/hunt/resumes/
  attempts/
    <job_id>/
      <timestamp>_<family>/
        job_description.txt
        role_classification.json
        keywords.json
        tailored_resume.json
        output.tex
        compile.log
        output.pdf
        metadata.json
  ad_hoc/
    <timestamp>_<slug>/
      job_description.txt
      output.tex
      compile.log
      output.pdf
      metadata.json
```

The DB should point to the selected and latest-useful artifact paths rather than requiring the web app to discover them by scanning folders.

## Repo Layout

The repo scaffold for C2 now lives in:

```text
trapper/
  base_resumes/
  prompts/
  schemas/
  templates/
```

That repo layout is for:
- prompts
- schemas
- templates
- curated source files

It is not the runtime artifact location.

## Candidate Profile And Bullet Library

The candidate profile should be editable by the user and optimized for truth and reuse.

Recommended authoring format:
- Markdown first

Why:
- easy for the user to edit
- easy to diff in git
- easy to turn into structured data later

The bullet library should:
- store more roles than the OG resume currently shows
- store more bullet candidates than any one-page resume can hold
- track role-family tags and technology tags
- support both selection and later truthful rewrites

Stage 2 should also standardize provenance IDs so later stages can point back to exact source material.

Recommended ID families:
- `exp_<slug>` for experience entries
- `proj_<slug>` for project entries
- `fact_<slug>` for immutable or supporting facts
- `bullet_<slug>` for bullet candidates
- `draft_<slug>` for reviewed generated drafts
- `skill_<slug>` for skill evidence rows

Those IDs should be stable enough that:
- Stage 3 and Stage 4 can cite source material directly
- a generated resume bullet can be traced back to its supporting facts
- later review UI can show where a bullet came from

## Web App Expectations

The later review/control-plane surface should support:
- queue-driven resume inspection
- latest PDF preview in browser when possible
- `.tex` source inspection
- concern-flag visibility
- retry or regenerate actions
- ad hoc generation from:
  - existing DB job
  - pasted JD
  - uploaded JD text file

Nice-to-have later:
- visual diff between OG/base/tailored output

## Deployment Notes

C2 (Trapper) should reuse the `server2` patterns already established for Hunt:

- unattended worker lane:
  - systemd, similar to the current Hunt runtime lane
- operator UI lane:
  - Docker container plus Cloudflare Tunnel, similar to `hunt-review`
- model backend:
  - local Ollama first

Recommended Linux packages for later deployment:
- TeX Live packages for compilation
- `poppler-utils` for `pdfinfo`

## Recommended Implementation Order

1. lock the C2 data contract and artifact layout
2. create the parser and renderer around `main.tex`
3. create the candidate profile and bullet library ingestion layer with stable provenance IDs
4. implement role-family and job-level classification
5. implement keyword extraction
6. implement the rewrite and selection loop
7. implement compile and page-limit enforcement
8. save attempts and latest-result DB state
9. add queue-driven automation
10. add the ad hoc/manual UI path
