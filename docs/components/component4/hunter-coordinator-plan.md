# Hunter -> Coordinator Planning Guide

This is the planning doc for the C1 (Hunter) -> C4 (Coordinator) seam.

Use this document when deciding:
- what C4 should consume from Hunter
- what C4 should persist itself
- how a job moves from enriched row to bounded apply run
- what should ship before `server2` deployment

Related docs:
- [README.md](./README.md)
- [design.md](./design.md)
- [hunter-coordinator-ops.md](./hunter-coordinator-ops.md)
- [hunter-coordinator-research.md](./hunter-coordinator-research.md)

## Why This Doc Exists

The repo already had:
- a high-level C4 stage plan in [README.md](./README.md)
- design notes and a partial checkpoint in [design.md](./design.md)
- a working local `coordinator/` runtime with schema, readiness, and state transitions

What was still missing was one planning document focused on the actual `hunter` -> `coordinator` boundary:
- exact fields C4 reads from `jobs`
- exact run states C4 owns
- exact artifacts and side effects created today
- recommended production shape on `server2`
- rollout order that keeps C1/C2/C3/C4 deployments separate

## Current Code-Backed Checkpoint

As of this doc, `coordinator/` already provides:
- readiness evaluation across C1 and C2 state in `coordinator/service.py`
- C4-owned tables in `coordinator/db.py`
- one shared apply-prep flow that writes:
  - `apply_context.json`
  - `c3_apply_context.json`
- fill request / fill result handling
- manual review routing
- submit approval and final submitted transitions
- scheduler helpers:
  - `pick-next`
  - `run`
  - `run-once`
- first-round scaffolding shipped in this repo pass:
  - expanded C4 tests around readiness, transitions, and scheduler guardrails
  - thin `hunterctl` pass-through commands for the current C4 CLI
  - broader JSON-schema coverage for payload contracts
  - optional `browser_lane` metadata recorded on apply-prep artifacts and runs

Important limit:
- this is still a local checkpoint, not a production-ready `server2` runtime

Still missing:
- live C3 bridge
- production browser-lane integration
- production service wiring and deployment validation outside repo defaults

## Ownership Boundary

### C1 (Hunter) owns

- discovery
- enrichment
- source classification
- `apply_url`
- `apply_type`
- `auto_apply_eligible`
- `ats_type`
- `priority`
- enriched job description

### C2 (Fletcher) owns

- selected resume choice for downstream apply work
- `selected_resume_version_id`
- `selected_resume_pdf_path`
- `selected_resume_tex_path`
- `selected_resume_ready_for_c3`
- latest resume concern flags and JD snapshot path

### C3 (Executioner) owns

- browser autofill behavior
- ATS-specific field handling
- upload behavior
- generated answer capture
- fill evidence

### C4 (Coordinator) owns

- ready-job gating
- orchestration runs
- orchestration event history
- manual-review routing
- explicit submit approvals
- final submit/not-submit decisions

Important rule:
- C4 consumes C1/C2/C3 contracts
- C4 does not rebuild resume-selection logic or ATS selectors inside prompts

## Canonical Ready Predicate

Current readiness comes from `OrchestrationService._decision_from_row()` in `coordinator/service.py`.

A job is ready only when all of the following are true:
- no open C4 run already exists for the job
- `jobs.status` is not already `claimed`, `applied`, `failed`, or `skipped`
- `priority = 0`
- `enrichment_status IN ('done', 'done_verified')`
- `apply_type = 'external_apply'`
- `auto_apply_eligible` is truthy
- `apply_url` is non-empty
- `selected_resume_ready_for_c3` is truthy
- `selected_resume_version_id` is non-empty
- `selected_resume_pdf_path` is non-empty

This is intentionally stricter than C2 readiness.
C2 may still generate resumes for jobs that are not ready for C4.

### Current readiness reason codes

These reason codes already exist and should be treated as part of the planning contract:
- `missing_job`
- `manual_review_hold`
- `active_run`
- `application_claimed`
- `already_applied`
- `application_terminal`
- `manual_only`
- `waiting_on_enrichment`
- `easy_apply_excluded`
- `unsupported_apply_type`
- `not_auto_apply_eligible`
- `missing_apply_url`
- `waiting_on_resume`
- `ready`

Planning rule:
- new UI, metrics, and operator docs should reuse these reasons instead of inventing new labels

## Current C4 State Model

### C4-owned tables

`coordinator/db.py` creates:
- `orchestration_runs`
- `orchestration_events`
- `submit_approvals`

### Run statuses

Non-terminal statuses:
- `apply_prepared`
- `fill_requested`
- `manual_review`
- `awaiting_submit_approval`
- `submit_approved`

Terminal statuses:
- `failed`
- `submit_denied`
- `submitted`

Scheduler guardrail:
- only one executing run should exist at a time
- current `pick_next_job()` blocks when a run is already in:
  - `apply_prepared`
  - `fill_requested`
  - `awaiting_submit_approval`
  - `submit_approved`

Global hold guardrail:
- `pick_next_job()` also blocks when any run is in `manual_review` for one of:
  - `auth_required`
  - `login_required`
  - `captcha_challenge`
  - `otp_required`
  - `verification_required`
  - `security_challenge`

## Current End-To-End Lifecycle

### 1. Apply prep

Command:

```text
python -m coordinator.cli apply-prep --job-id <ID>
hunter apply-prep <ID>
```

Side effects:
- evaluates readiness
- creates `orchestration_runs` row with `status = 'apply_prepared'`
- writes C4 artifact: `apply_context.json`
- writes C3 artifact: `c3_apply_context.json`
- moves `jobs.status` from `new` to `claimed` when possible
- appends `run_started` event

### 2. Fill request

Command:

```text
python -m coordinator.cli request-fill --run-id <RUN_ID>
```

Side effects:
- writes `fill_request.json`
- moves run to `fill_requested`
- appends `fill_requested` event

### 3. Fill result

Command:

```text
python -m coordinator.cli record-fill --run-id <RUN_ID> --result-json <PATH>
```

Side effects:
- writes `fill_result.json`
- writes `browser_summary.json`
- writes `decisions.json`
- derives review flags from result payload

Current routing:
- review flags present -> `manual_review`, keep job `claimed`
- fill status `failed` or `error` with no review flags -> run `failed`, job `failed`
- otherwise -> `awaiting_submit_approval`, keep job `claimed`

### 4. Manual review resolution

Command:

```text
python -m coordinator.cli resolve-review --run-id <RUN_ID> --decision continue|fail --approved-by <NAME>
```

Routing:
- `continue` -> `awaiting_submit_approval`, job stays `claimed`
- `fail` -> `failed`, job becomes `failed`

### 5. Submit approval

Command:

```text
python -m coordinator.cli approve-submit --run-id <RUN_ID> --decision approve|deny --approved-by <NAME>
```

Routing:
- `approve` -> `submit_approved`, job stays `claimed`
- `deny` -> `submit_denied`, job becomes `skipped`

### 6. Mark submitted

Command:

```text
python -m coordinator.cli mark-submitted --run-id <RUN_ID>
```

Side effects:
- writes `final_status.json`
- moves run to `submitted`
- moves job to `applied`
- appends `submitted` event

## Current Artifact Contract

Per-run artifacts live under:

```text
<runtime_root>/runs/<run_id>/
```

Current files:
- `apply_context.json`
- `c3_apply_context.json`
- `fill_request.json`
- `fill_result.json`
- `browser_summary.json`
- `decisions.json`
- `review_resolution.json`
- `final_status.json`

Submit approvals live under:

```text
<runtime_root>/approvals/<job_id>/
```

Planning rule:
- these artifacts are part of the operator and audit surface
- later integrations should append to them, not bypass them

## Apply Context Contract

Current C4 apply context includes:
- `run_id`
- `job_id`
- `title`
- `company`
- `source`
- `apply_url`
- `job_url`
- `ats_type`
- `apply_type`
- `auto_apply_eligible`
- `priority`
- `description`
- `selected_resume_version_id`
- `selected_resume_pdf_path`
- `selected_resume_tex_path`
- `selected_resume_ready_for_c3`
- `job_description_path`
- `concern_flags`
- `manual_review_flags`
- `source_mode`
- `apply_context_path`
- `c3_apply_context_path`

Current C3 payload includes:
- `jobId`
- `title`
- `company`
- `applyUrl`
- `jobUrl`
- `sourceMode`
- `source`
- `atsType`
- `applyType`
- `autoApplyEligible`
- `description`
- `selectedResumeVersionId`
- `selectedResumePath`
- `selectedResumeTexPath`
- `selectedResumeReadyForC3`
- `jdSnapshotPath`
- `concernFlags`
- optional embedded resume bytes when `--embed-resume-data` is used

Planning rule:
- C4/OpenClaw should consume these files as the source of truth
- prompts should reference run ids and artifact paths, not reconstruct payloads from raw DB fields

## Recommended Production Shape

### Runtime topology

Recommended `server2` shape:
- C1 remains its own timer-driven runtime
- C4 remains a separate deployment step and service
- C4 reads the same Hunt DB as C1/C2
- C4 runtime artifacts live outside repo checkout
- C4 triggers C3 through one stable bridge

Recommended first C4 automation scope:
- pick ready job
- prepare apply context
- request fill
- record fill result
- stop at review or submit approval

Not yet recommended:
- unattended final submit
- multiple concurrent execution runs
- prompt-only job selection without durable DB state

### Browser lanes

Recommended lane split:
- lane A: isolated automation lane
- lane B: signed-in operator lane

Lane A use cases:
- read-only checks
- deterministic testing
- isolated browser automation
- controlled C3 bridge experiments

Lane B use cases:
- auth/session continuity
- account-bound flows
- explicit operator-assisted review

Planning rule:
- lane choice should become a recorded part of each run
- global attach to a personal browser should never be an accidental default

## Proposed Rollout Order

### Phase 0: contract freeze

Ship:
- this planning doc
- ops doc
- research notes
- README links

Exit criteria:
- repo has one canonical Hunter -> Coordinator story
- reason codes and run statuses are documented once

### Phase 1: test and validate local checkpoint

Ship:
- rewritten C4 tests
- fixture DB coverage for readiness reasons
- apply-prep artifact tests
- fill-result routing tests
- manual-review and submit-gate tests

Exit criteria:
- current local code is trustworthy as contract surface

### Phase 2: add C3 bridge without submit automation

Ship:
- one stable C3 trigger mechanism
- run metadata recording for chosen browser lane
- evidence capture on every bounded fill run

Exit criteria:
- C4 can request fill and record results without prompt-built glue

### Phase 3: `server2` pilot, fill-only

Ship:
- separate service deployment
- separate runtime root
- monitoring for queue readiness, active run, and global hold
- operator runbook for blocked rows

Exit criteria:
- unattended queue selection is bounded and reviewable
- submit still explicit

### Phase 4: review-gated submit

Ship:
- stable approval surface
- operator workflow for approve/deny
- final status evidence

Exit criteria:
- submit decisions are explicit and auditable

### Phase 5: narrow unattended submit, if ever

Only consider after:
- ATS-family allowlists
- stable fill success evidence
- low drift rates
- high-confidence review history

Default planning stance:
- do not promise this stage yet

## Open Decisions

These are the planning questions still worth deciding before production rollout:

### C3 trigger surface

Need one canonical answer:
- local HTTP bridge
- file watcher / poller
- extension relay
- OpenClaw browser profile only

Recommendation:
- pick one small stable surface first and document it as the only supported path

### Review UI location

Need to decide whether initial review actions belong in:
- existing control plane
- a small C4-only operator page
- CLI only for first pilot

Recommendation:
- start with CLI plus artifacts
- add UI only after the state machine settles

### Artifact retention and redaction

Need to define:
- how long to keep traces/screenshots/HTML
- whether generated answers and uploaded resume bytes are stored long term
- what gets scrubbed before sharing logs

### Stale run recovery

Need a policy for:
- `jobs.status = claimed` with no active run
- runs stuck in `fill_requested`
- browser sessions left attached after failure

Recommendation:
- define explicit age thresholds and operator repair commands before unattended pilot

## Non-Goals

This planning pass does not make C4 responsible for:
- bypassing CAPTCHA or anti-bot systems
- replacing C3 ATS adapters with prompt guesses
- selecting resumes outside C2's chosen downstream selection
- merging C1 and C4 into one always-on monolith

## Decision Summary

If planning gets noisy, return to these defaults:
- C4 is control plane, not form-filler
- shared apply-prep is canonical seam
- one active execution run at a time
- submit remains separate from fill success
- production runtime lives outside repo checkout
- browser lane choice is explicit, recorded, and bounded
