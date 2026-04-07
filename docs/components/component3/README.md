# C3 (Executioner) : Browser Autofill Extension

## Goal

Build C3 (Executioner) as a Chrome extension that can autofill external job application forms.

C3 (Executioner) should work on its own.

That means it must support:
- manual use by the user with one remembered profile
- one remembered resume by default
- later handoff from C2 (Trapper) when a job-specific resume is available
- later use by OpenClaw as a tool, not as the owner of C3 (Executioner) behavior

The current first target is:
- `Workday`

Deployment note:
- C3 (Executioner) should deploy separately from the current C1 (Hunter) Hunt deployment
- C3 (Executioner) should also remain a separate Ansible step/stage from C2 (Trapper)
- current `server2` Stage 6 is for C1 (Hunter) only

Out of scope for the first milestone:
- LinkedIn Easy Apply
- generic direct company sites
- mandatory account creation flows
- OTP automation
- full autonomous submit decisions

## Core Product Shape

C3 (Executioner) is not the final decision-maker.

Its primary job is:
- detect supported application pages
- load the latest selected resume and candidate profile
- fill text fields, textareas, dropdowns, radio groups, and common uploads
- generate and store question answers when needed
- leave clear evidence and logs for later review

OpenClaw can later use C3 (Executioner) to reduce browser work, but C3 must remain useful even when:
- C1 (Hunter) is not involved
- C2 (Trapper) is not involved
- OpenClaw is not running

## How It Fits With Other Components

### Standalone mode

The user opens a supported job application page in Chrome and uses the extension directly.

Initial standalone assumptions:
- the user is already signed in when sign-in is required
- the active resume is the most recently provided resume
- the first default source resume can come from the repo resume flow such as `main.tex` plus its compiled PDF

### C1 (Hunter) handoff

C1 (Hunter) supplies:
- job metadata
- `apply_url`
- enriched description
- ATS type

C3 (Executioner) should still be usable without that handoff, but the normal queue-driven path should eventually use it.

### C2 (Trapper) handoff

C2 (Trapper) supplies the resume that C3 (Executioner) should upload for a specific job.

Important rule:
- C3 (Executioner) always uses the latest resume explicitly assigned to the current job
- when no job-specific resume exists, C3 (Executioner) falls back to the last provided default resume
- in the normal queue-driven path, C3 should receive one explicit apply context rather than guessing resume selection on its own
- the shared apply-prep command should prime C3 with that job's selected resume before fill actions run

### C4 (Coordinator) handoff

C4 (Coordinator) is the future orchestration layer.

In the current plan, OpenClaw belongs here rather than inside C3 (Executioner).

C4 (Coordinator) may:
- open the target page
- decide whether the job should proceed
- decide when to invoke C3 (Executioner)
- fetch the explicit apply context for the chosen job
- review output and decide whether to submit

Recommended interaction model:

1. C4 chooses a Hunt `job_id`
2. C4 calls one apply-prep command for that job
3. that command reads the DB row and resolves:
   - `apply_url`
   - selected resume metadata from C2
4. the current implementation writes:
   - one C4 apply-context artifact
   - one C3-ready payload artifact
5. later browser-opening and extension-priming steps should happen from C4 or OpenClaw using those artifacts
6. C3 then fills the page when triggered

Important detail:
- C4 should not hand-build resume-selection logic each time
- the shared command should resolve the selected resume from the DB contract
- a plain selected resume path is not enough for upload by itself:
  - the extension currently uploads from a cached file payload such as embedded resume data
  - queue-driven C4 flows therefore need to provide resume bytes or a C3-side cached copy, not just a filesystem path

C3 (Executioner) itself should not depend on C4 (Coordinator) to be useful.

### OpenClaw handoff

OpenClaw is later-stage orchestration.

Recommended placement:
- OpenClaw should be treated as the first planned implementation of C4 (Coordinator)

## Current User Decisions Locked In

- browser extension first
- Chrome only
- Workday first
- standalone/manual use is required
- autofill should support:
  - text inputs
  - textareas
  - dropdowns
  - radio groups
  - resume upload
- autofill should support:
  - auto-fill on page load
  - manual click-to-fill
  - settings toggles for behavior
- account creation is allowed later, but not part of the first milestone
- OTP flows are manual handoff for now
- SQLite remains the source of truth
- only one candidate profile is needed initially
- `priority = 1` jobs remain manual-only
- generated paragraph answers are allowed
- generated answers must be stored for later review
- the long dash character should be actively stripped from generated text
- low-confidence answers should still fill something useful, then be flagged for manual review
- review surfaces for applied jobs and artifacts should remain visible in the existing review app later, but actions should live in a separate C3 surface

## Proposed Stages

### Stage 0 : contract and scaffolding

- lock the standalone C3 boundaries
- document the data contract with C1 and C2
- define runtime artifact layout
- create the extension repo scaffold

### Stage 1 : local profile, resume, and settings storage

- one editable candidate profile
- one active default resume
- one active resume override per job later
- extension settings for:
  - auto-fill on page load
  - manual fill only
  - answer-generation policy
  - review flags

### Stage 2 : Workday manual autofill

- detect Workday application pages
- autofill common Workday fields
- upload the active resume
- support manual fill and optional page-load auto-fill

### Stage 3 : generated answers and review flags

- generate free-text answers from:
  - candidate facts
  - selected resume
  - job description when available
- strip banned punctuation such as the long dash
- store the exact question and answer pair
- mark low-confidence answers for later review

### Stage 4 : persistence and evidence

- save per-attempt artifacts
- save screenshots and HTML when OpenClaw uses C3
- keep append-only attempt history
- maintain a latest summary state on each job

### Stage 5 : C1 and C2 integration

- consume job records from Hunt
- use `apply_url` and `ats_type`
- switch resume automatically when C2 (Trapper) produces a job-specific output
- support an explicit apply-context handoff so the selected link and selected resume arrive together

### Stage 6 : account and auth helpers

- detect signed-in vs signed-out state
- support login/account creation helpers
- leave OTP and verification as manual handoff first

### Stage 7 : C4 (Coordinator) integration

- expose C3 (Executioner) as a dependable tool layer
- let a higher-level orchestrator trigger fill actions and inspect results
- support a one-command apply-prep flow that:
  - resolves the DB row
  - opens `apply_url`
  - primes C3 with the selected resume for that job
- keep submit decisions outside C3 when desired

## Recommended Defaults

Recommended initial defaults based on current user decisions:

- willing to relocate:
  - `yes`
- open to any location:
  - `yes`
- salary flexibility:
  - `yes`
- sponsorship required:
  - `no`

These are product defaults, not permanent hardcoding.
They should become toggles/settings later.

## Data Model Direction

Recommended model:

- append-only application attempts for history
- plus a current summary state on each job for quick inspection

This keeps:
- reliable history
- easy UI rendering
- safer retries

See `design.md` for the fuller proposal.

## File Layout

The initial C3 scaffold lives in:

```text
executioner/
  manifest.json
  README.md
  src/
    background/
    content/
    options/
    popup/
    shared/
  fixtures/
    workday/
```

This layout is only for extension source and test fixtures.

Runtime artifacts should live outside the repo.

Recommended future C4-facing helper shape:

- one command that accepts:
  - `job_id`
- and resolves:
  - `apply_url`
  - `selected_resume_version_id`
  - selected resume file path
  - any needed C3 page/session context

## Related Docs

- `docs/components/component3/design.md`
- `docs/components/component4/README.md`
- `docs/roadmap.md`
- `docs/components/component1/README.md`
- `docs/components/component2/README.md`
