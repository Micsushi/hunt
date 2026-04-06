# Component 3 : Browser Autofill Extension

## Goal

Build Component 3 as a Chrome extension that can autofill external job application forms.

Component 3 should work on its own.

That means it must support:
- manual use by the user with one remembered profile
- one remembered resume by default
- later handoff from Component 2 when a job-specific resume is available
- later use by OpenClaw as a tool, not as the owner of Component 3 behavior

The current first target is:
- `Workday`

Out of scope for the first milestone:
- LinkedIn Easy Apply
- generic direct company sites
- mandatory account creation flows
- OTP automation
- full autonomous submit decisions

## Core Product Shape

Component 3 is not the final decision-maker.

Its primary job is:
- detect supported application pages
- load the latest selected resume and candidate profile
- fill text fields, textareas, dropdowns, radio groups, and common uploads
- generate and store question answers when needed
- leave clear evidence and logs for later review

OpenClaw can later use Component 3 to reduce browser work, but C3 must remain useful even when:
- Component 1 is not involved
- Component 2 is not involved
- OpenClaw is not running

## How It Fits With Other Components

### Standalone mode

The user opens a supported job application page in Chrome and uses the extension directly.

Initial standalone assumptions:
- the user is already signed in when sign-in is required
- the active resume is the most recently provided resume
- the first default source resume can come from the repo resume flow such as `main.tex` plus its compiled PDF

### Component 1 handoff

Component 1 supplies:
- job metadata
- `apply_url`
- enriched description
- ATS type

Component 3 should still be usable without that handoff, but the normal queue-driven path should eventually use it.

### Component 2 handoff

Component 2 supplies the resume that Component 3 should upload for a specific job.

Important rule:
- Component 3 always uses the latest resume explicitly assigned to the current job
- when no job-specific resume exists, Component 3 falls back to the last provided default resume

### OpenClaw handoff

OpenClaw is later-stage orchestration.

OpenClaw may:
- open the target page
- decide whether to proceed
- trigger Component 3 autofill
- review output and decide whether to submit

Component 3 itself should not depend on OpenClaw to be useful.

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
- switch resume automatically when Component 2 produces a job-specific output

### Stage 6 : account and auth helpers

- detect signed-in vs signed-out state
- support login/account creation helpers
- leave OTP and verification as manual handoff first

### Stage 7 : OpenClaw integration

- expose Component 3 as a dependable tool layer
- let OpenClaw trigger fill actions and inspect results
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
apply_extension/
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

## Related Docs

- `docs/components/component3/design.md`
- `docs/roadmap.md`
- `docs/components/component1/README.md`
- `docs/components/component2/README.md`
