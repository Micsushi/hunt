# Component 2 : Design Notes

## Purpose

This document captures the current recommended design for Component 2 based on the repo state and the user decisions locked in so far.

Component 2 should stay runnable on its own, but it is intended to sit in the larger production flow:

1. C1 scrape
2. C1 enrichment
3. C1 UI enrichment if needed
4. C2 resume generation
5. C3 application automation only when the job is actually eligible to apply

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

## Component 1 Handoff

Component 2 should be able to run independently of Component 1, but the normal queue-driven path should consume C1 output.

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
- `latest_resume_pdf_path`
- `latest_resume_tex_path`
- `latest_resume_family`
- `latest_resume_job_level`
- `latest_resume_model`
- `latest_resume_generated_at`
- `latest_resume_fallback_used`
- `latest_resume_flags`

### In `resume_attempts`

Store full history.

Suggested fields:
- `id`
- `job_id`
- `attempt_type`
- `status`
- `role_family`
- `job_level`
- `base_resume_name`
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

The exact schema can still move, but the latest-on-job plus history-table split is the recommended default.

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

The DB should point to the latest useful artifact paths rather than requiring the web app to discover them by scanning folders.

## Repo Layout

The repo scaffold for C2 now lives in:

```text
resume_tailor/
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

Component 2 should reuse the `server2` patterns already established for Hunt:

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
3. create the candidate profile and bullet library ingestion layer
4. implement role-family and job-level classification
5. implement keyword extraction
6. implement the rewrite and selection loop
7. implement compile and page-limit enforcement
8. save attempts and latest-result DB state
9. add queue-driven automation
10. add the ad hoc/manual UI path

