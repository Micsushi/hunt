# C2 (Trapper) : Resume Tailoring

## Goal

Generate a truthful, job-specific one-page resume from the original LaTeX resume in `main.tex`.

C2 (Trapper) should:
- preserve the existing section order from the original resume
- preserve the existing document structure and visual layout
- keep dates, titles, employers, education, and contact info immutable
- allow bullet rewriting, entry selection, project selection, and skill emphasis
- save every attempt to disk
- expose the latest useful result in the DB and web app

## Current Status

C2 (Trapper) now has an initial working local implementation under:
- `trapper/`

What exists now:
- parser and renderer code around `main.tex`
- initial job classification and keyword extraction
- local pipeline and CLI entrypoints
- DB helpers for resume attempts, resume versions, and selected downstream resume state
- prompt placeholders and JSON schemas
- candidate profile templates and bullet-library templates
- base-resume family placeholders

Deployment should happen only after the current C1 (Hunter) server rollout is stable on `server2`.
When deployment starts, C2 (Trapper) should be its own Ansible step/stage rather than being folded into the current C1 (Hunter) Hunt deployment.
C2 (Trapper) deployment should also stay separate from later C3 (Executioner) deployment.

## Locked Decisions

These decisions are now treated as the default C2 (Trapper) contract unless the user changes them later.

- The OG resume is `main.tex`.
- `main.tex` stays immutable.
- Section order stays:
  - `Education`
  - `Experience`
  - `Projects`
  - `Technical Skills`
- No summary section is added.
- The existing LaTeX layout should be preserved.
- Projects are optional when experience needs the space.
- At least one experience role should remain.
- C2 (Trapper) should generate a resume for all jobs, not just automation-eligible jobs.
- C2 (Trapper) should run automatically after C1 (Hunter) enrichment reaches a done state.
- If a job still needs UI enrichment, C2 (Trapper) should wait.
- Easy Apply matters for C3 (Executioner), not for whether C2 (Trapper) may generate a resume.
- One page is a hard gate. Over-one-page attempts are failures.
- Ollama is the planned production default backend.
- Gemini or another API backend is a later optional toggle.
- Every attempt should be saved.
- Limited concern flags are allowed.

## Terminology

Common shorthand is now documented in:
- `glossary.md`

Important terms used throughout the C2 (Trapper) docs:
- `C1`, `C2`, `C3`
- `S1`, `S2`, and later stage shorthands
- `JD`
- `OG resume`
- `base resume`
- `UI enrich`
- `role family`
- `job level`
- `attempt`
- `latest result`

## C2 (Trapper) Workflows

### Queue-driven workflow

This is the main automated path.

1. C1 marks a job enriched and ready for normal downstream work.
2. C2 claims the job only after C1 reaches a normal done state.
3. C2 classifies the job into a role family and job level.
4. C2 attempts to tailor a resume from the best starting point:
   - a role-family base resume when possible
   - otherwise the OG resume
5. C2 compiles the LaTeX output to PDF.
6. If the PDF exceeds one page, the attempt fails the one-page gate and retries with controlled reductions.
7. C2 stores all artifacts for the attempt.
8. The latest useful result is surfaced in the DB and later in the web app.

### Cross-component contract

The intended high-level contract is:

1. C1 owns job discovery, enrichment, and ready-for-downstream gating.
2. C2 owns resume generation for all jobs, not just later automation-eligible jobs.
3. C3 should only engage when the job is actually ready to apply and C2 has produced a usable one-page resume.

That means:
- C1 decides whether a job is still waiting on headless or UI enrichment.
- C2 should wait until C1 is done enough to provide the best available JD snapshot.
- C2 should still generate for jobs that will never be sent to C3, such as Easy Apply or manual-only cases.
- C3 should consume the latest useful C2 result, not trigger its own resume generation by default.
- C4 or OpenClaw should normally fetch one explicit apply context for a job instead of independently deciding which link and which resume to use.
- in the current C4 direction, that should happen through one shared apply-prep command
- the `trapper` CLI may still expose C2-local apply-context inspection, but that is not the shared C4 apply-prep seam
- that apply context should include:
  - the selected `apply_url`
  - the selected resume path
  - the selected resume version or attempt id
  - the best available JD snapshot path
  - any relevant concern flags

### Ad hoc workflow

This is the manual path for later UI work.

Supported future inputs should include:
1. select an existing DB job
2. paste a JD directly
3. upload a JD text file

That path should still produce the same artifact set:
- job-description snapshot
- structured model output
- rendered `.tex`
- compile logs
- final `.pdf`

## Fallback Rules

If C2 cannot produce a trustworthy tailored result from the JD:

1. try a role-family base resume if the job type is clear
2. otherwise use the OG resume
3. still save the failed attempt and its flags

If the JD is weak, sparse, or noisy:
- C2 should still attempt classification and tailoring first
- if that attempt is not usable, C2 falls back

## Recommended Data Model

The most likely clean shape is:

- latest-result columns on `jobs`
- one `resume_attempts` history table for every saved attempt

This keeps:
- fast access to the current best result
- complete historical traceability
- clean artifact-to-job mapping

The detailed proposal lives in:
- `docs/components/component2/design.md`

## Concern Flags

Keep the initial flag set intentionally small:
- `weak_description`
- `low_confidence_match`
- `page_limit_failed`
- `insufficient_source_facts`
- `manual_review_recommended`

These flags should mark uncertainty without blocking normal operation unless the output is unusable.

## Base Resume Families

Initial family buckets:
- `software`
- `pm`
- `data`
- `general`

The OG resume remains the source of truth.

Family-specific base resumes are planned as curated variants, not replacements for the OG resume.

## Candidate Facts And Bullet Library

C2 (Trapper) should be grounded by:
- the OG resume
- a candidate profile file
- a bullet-library file
- later generated or curated family-specific base resumes

Starter templates now live under:
- `trapper/templates/candidate_profile.template.md`
- `trapper/templates/bullet_library.template.md`
- `trapper/templates/ad_hoc_job_description.template.md`

## Initial Repo Layout

C2 (Trapper) now has a dedicated repo home:

- `trapper/README.md`
- `trapper/base_resumes/`
- `trapper/prompts/`
- `trapper/schemas/`
- `trapper/templates/`

Runtime artifacts should not live inside the git checkout on `server2`.

Recommended runtime root:
- `/home/michael/data/hunt/resumes`

## Proposed Stages

### Stage 0 : terminology, structure, and storage contract

- lock the C2 vocabulary
- define runtime directories
- define DB latest-result fields and attempt-history shape

### Stage 1 : parser and renderer around `main.tex`

- parse the OG resume into structured data
- preserve enough structure to render back into the same LaTeX layout
- verify round-trip rendering

### Stage 2 : candidate profile and bullet library

- add user-maintained factual source files
- support more roles and more bullet candidates than appear in `main.tex`
- keep everything grounded in truthful source material
- require durable IDs for:
  - experience entries
  - project entries
  - immutable facts
  - bullet candidates
  - generated-but-reviewed draft bullets
- capture skill evidence, not just raw skill names
- prepare the factual source material later used to curate family-specific base resumes

### Stage 3 : job classification and keyword extraction

- detect role family
- detect job level
- extract must-have and nice-to-have requirements
- flag weak or noisy JDs
- recommend the best starting base resume family for Stage 4

### Stage 4 : resume selection and rewrite plan

- pick the starting base resume
- choose which experience entries and projects to keep
- rewrite or generate bullets while staying truthful
- preserve section order and overall structure

### Stage 5 : compile and one-page gate

- compile LaTeX to PDF
- reject outputs longer than one page
- retry with controlled reductions

### Stage 6 : persistence, selection, and latest-result wiring

- save all attempt artifacts
- store immutable resume version metadata for every artifact set
- distinguish:
  - latest generated result
  - latest useful result
  - selected resume for downstream application use
- update latest-result fields on the job row
- prepare the data for web review and later C3 handoff
- make the selected downstream apply context easy for C4 or OpenClaw to fetch in one step
- make it easy for the shared apply-prep command to prime C3 with the selected resume for that job

### Stage 7 : queue-driven automation

- auto-run after C1 reaches a done state
- skip jobs still waiting on UI enrichment
- support all job sources

### Stage 8 : review UI and ad hoc generation

- view the latest PDF in browser
- expose the generated LaTeX
- allow manual generation from DB jobs or pasted JDs
- add diff views later as a nice-to-have

## Verification Priorities

Early tests should focus on:
- schema validation
- parser and renderer stability
- resume selection logic
- one-page enforcement
- artifact writing

## Related Docs

- `docs/components/component2/design.md`
- `glossary.md`
- `docs/components/component3/README.md`
