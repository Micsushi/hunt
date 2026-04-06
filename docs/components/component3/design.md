# Component 3 : Design Notes

## Purpose

This document captures the current recommended design for Component 3 based on the repo state and the user decisions locked in so far.

Component 3 should be independently useful before it is integrated into the full pipeline.

The intended long-term flow is still:

1. C1 discovery and enrichment
2. C2 resume generation
3. C3 autofill and upload
4. later orchestration by Component 4
5. OpenClaw as one likely first implementation of Component 4

But the first C3 milestone should work even when only these are available:
- one supported browser
- one candidate profile
- one remembered resume
- one supported ATS family

## Core Invariants

The following rules should be treated as current hard constraints.

- Component 3 is a Chrome extension first.
- Workday is the first supported ATS family.
- C3 must support manual use without C1, C2, or OpenClaw.
- C3 should fill directly by default instead of requiring a pre-fill approval screen.
- C3 should support both:
  - manual click-to-fill
  - auto-fill on page load
- Resume upload is part of the first meaningful milestone.
- The active resume is the latest resume explicitly provided to C3.
- Later, C2 may replace that active resume on a per-job basis.
- Only one candidate profile is required initially.
- `priority = 1` jobs remain manual-only and should not enter later queue-driven C3 automation.
- Generated answers may be used.
- Generated answers must be saved for later review.
- If grounding is weak, C3 should still produce a useful vague answer and flag it.
- The long dash character must be removed from generated output.
- OTP and similar verification remain manual handoff initially.
- Account creation/login support is later-stage, not first milestone.
- C4 should use C3 later, but C3 should not depend on C4.

## Product Shape

Recommended first product boundary:

- a Chrome extension with:
  - popup controls
  - options/settings page
  - content scripts for ATS-specific page interaction
  - a background/service worker for orchestration and storage

Recommended first use flow:

1. user opens a Workday application page
2. user is already signed in if sign-in is required
3. extension detects the page
4. extension chooses the active profile and resume
5. extension fills supported controls
6. extension uploads the selected resume
7. extension generates free-text answers when needed
8. extension records the answers and review flags
9. the user or later Component 4 decides whether to continue toward submit

Recommended later orchestration flow:

1. C4 selects a `job_id`
2. C4 calls one apply-prep command
3. the command reads the Hunt DB row
4. the command resolves:
   - `apply_url`
   - `selected_resume_version_id`
   - selected resume path
5. the command opens the target page
6. the command primes C3 with the resolved resume context
7. C4 then triggers C3 autofill
8. C4 inspects the result and decides whether to continue

## Separation From Other Components

### Component 1

C1 should be treated as the queue and apply-link source, not as a runtime dependency for the extension.

When available, C1 should provide:
- `job_id`
- `job_url`
- `apply_url`
- `title`
- `company`
- enriched description
- `ats_type`
- `priority`

Recommended C3 behavior:
- if a Hunt job context exists, use it
- otherwise allow ad hoc/manual page-only mode

### Component 2

C2 should be treated as the resume producer, not as a gate that prevents C3 from existing.

Initial fallback:
- use the latest manually provided default resume

Later automatic mode:
- C2 writes a job-specific resume output
- C3 is told which resume belongs to which job
- C3 uploads that job-specific resume when the matching `apply_url` is being used

Recommended normal queue-driven shape:
- C4 or OpenClaw fetches one explicit apply context for a `job_id`
- that context includes the selected `apply_url` and selected resume path together
- the shared apply-prep command primes C3 with that explicit resume context
- C3 consumes that explicit answer rather than recomputing selection logic during the fill run

### Component 4

Component 4 is a later orchestration layer.

Recommended relationship:
- C3 owns autofill behavior
- C4 decides whether to invoke C3 and whether to submit later

Recommended boundary:
- C4 should call a shared apply-prep interface instead of re-implementing DB lookup and resume resolution itself
- C3 should accept a resolved resume/job context rather than trying to infer orchestration intent from the page alone

This keeps C3 reusable:
- manually by the user
- by a future different orchestrator
- by tests and fixtures without a full agent stack

OpenClaw should be treated as one likely first implementation of C4, not as the definition of C3 itself.

## ATS Rollout Strategy

Recommended rollout order:

1. Workday
2. next single ATS family after Workday stabilizes
3. only later:
   - direct company sites
   - mixed custom flows

Why:
- named ATS families provide repeatable DOM patterns
- they are easier to fixture and regression test
- they reduce false generalization early

## Candidate Profile Direction

Initial profile shape should be intentionally simple.

Recommended first version:
- one canonical candidate profile
- editable fields for:
  - full name
  - email
  - phone
  - address/location
  - LinkedIn URL
  - GitHub URL
  - website/portfolio
  - work authorization defaults
  - relocation defaults
  - salary-flexibility defaults
  - reusable education facts
  - reusable experience facts
  - reusable project facts

Recommended future additions:
- multiple presets
- site-specific overrides
- answer preference toggles

## Resume Selection Strategy

Recommended rules:

1. if the current page is tied to a Hunt `job_id` and that job has a selected C2 resume, use that
2. otherwise use the latest manually provided default resume
3. record which resume was used for every attempt

In the OpenClaw path, this should normally come from a single explicit apply-context handoff rather than from extension-side guessing.

Recommended later C4 flow:

- C4 should pass `job_id`
- shared apply-prep logic should resolve the selected resume from the DB
- C3 should be updated with that resolved resume before fill starts

Recommended storage concept:
- one latest default resume pointer
- optional per-job resume pointer
- append-only resume history metadata

The actual resume file artifacts should live outside the repo.

## Generated Answer Policy

Generated answers may be created from:
- candidate profile facts
- selected resume facts
- job description when available

Recommended output policy:
- prefer short, credible answers
- allow mild exaggeration only within believable bounds
- never claim false credentials or impossible experience
- remove the long dash character before save/fill

Recommended failure policy:
- if confidence is weak, still fill a vague answer
- store:
  - the exact question
  - the exact final answer
  - a confidence or review flag

## Proposed DB Shape

Recommended high-level shape:

### On `jobs`

Store only the latest application summary fields.

Suggested future fields:
- `apply_stage`
- `apply_status`
- `latest_application_attempt_id`
- `apply_job_context_source`
- `selected_resume_version_id`
- `latest_application_resume_path`
- `latest_application_started_at`
- `latest_application_submitted_at`
- `latest_application_review_flag`
- `latest_application_evidence_path`

These should remain separate from enrichment fields.

### In `application_attempts`

Store full history.

Suggested fields:
- `id`
- `job_id`
- `source_mode`
- `status`
- `ats_type`
- `apply_url`
- `resume_path`
- `profile_version`
- `settings_snapshot_path`
- `page_snapshot_path`
- `html_path`
- `screenshot_path`
- `started_at`
- `completed_at`
- `submitted_at`
- `manual_review_required`
- `manual_review_reason`
- `summary_json_path`

### In `application_question_answers`

Store generated and reused answers.

Suggested fields:
- `id`
- `application_attempt_id`
- `job_id`
- `question_hash`
- `question_text`
- `answer_text`
- `answer_source`
- `confidence`
- `manual_review_required`
- `created_at`

### In `resume_versions`

Track which resume exists and where it came from.

Suggested fields:
- `id`
- `job_id`
- `source_type`
- `label`
- `tex_path`
- `pdf_path`
- `created_at`
- `is_default`
- `is_active`

The exact schema can move, but append-only history plus latest summary is the recommended default.

## Runtime Storage Layout

Generated artifacts should live outside the repo.

Recommended root on `server2`:
- `/home/michael/data/hunt/apply`

Recommended layout:

```text
/home/michael/data/hunt/apply/
  profiles/
    default_profile.json
  resumes/
    default/
      <timestamp>/
        resume.pdf
        metadata.json
    jobs/
      <job_id>/
        <timestamp>/
          resume.pdf
          metadata.json
  attempts/
    <job_id_or_ad_hoc>/
      <timestamp>/
        attempt.json
        page.html
        screenshot.png
        generated_answers.json
        settings_snapshot.json
```

Why this shape:
- keeps repo clean
- works with SQLite path references
- supports both ad hoc and queue-driven runs

Recommended future ephemeral context:
- a small per-job apply context written by the shared apply-prep command
- enough for C3 to know:
  - current `job_id`
  - selected resume path
  - selected resume version id
  - apply URL origin
  - source mode such as manual or C4

## Extension Repo Layout

The repo scaffold for C3 should live in:

```text
apply_extension/
  manifest.json
  README.md
  src/
    background/
      index.js
    content/
      ats/
        workday.js
      bootstrap.js
    options/
      options.html
      options.js
    popup/
      popup.html
      popup.js
    shared/
      settings.js
      storage.js
      sanitization.js
  fixtures/
    workday/
      README.md
```

This source tree is for:
- extension code
- ATS adapters
- local fixtures

It is not the runtime artifact store.

## First Milestone Definition

The first meaningful C3 milestone should be considered complete when:

- Chrome extension loads locally
- popup and options pages exist
- Workday page detection works on one real test target
- extension can fill:
  - text inputs
  - textareas
  - dropdowns
  - radio groups
- extension can upload the active resume
- extension can run in:
  - manual trigger mode
  - optional page-load auto-fill mode
- extension stores generated question/answer pairs
- extension strips the long dash from generated output

That milestone does not require:
- account creation
- OTP handling
- generic multi-ATS support
- Component 4 integration

## Separate Review Surface

Recommended product split:

- existing review app:
  - read-only or broad project inspection surface
- future C3 app/surface:
  - C3 actions and focused operational controls

The existing review app should eventually be able to display:
- latest application state
- screenshots
- evidence links

But it should not be the first place where C3 actions are implemented.

## Recommended Implementation Order

1. lock docs and repo scaffold
2. add local profile/settings/resume storage model
3. build extension popup and options shell
4. implement Workday detection and manual autofill
5. implement upload and generated-answer logging
6. implement append-only attempt recording
7. add Hunt job context and per-job resume selection
8. add separate C3 review/action surface
9. add login/account helpers
10. add Component 4 integration only after the extension is dependable
