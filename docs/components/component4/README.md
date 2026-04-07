# C4 (Coordinator) : Orchestration And Submit Control

## Goal

Build C4 (Coordinator) as the orchestration layer that coordinates C1 (Hunter), C2 (Trapper), and C3 (Executioner).

C4 (Coordinator) should decide:
- which jobs should proceed
- when a page should be opened
- when C3 (Executioner) should autofill
- when final submit is allowed
- when manual review or handoff is required

OpenClaw is the current most likely first implementation of C4 (Coordinator).

This document is the stage plan.
Implementation-oriented design notes and research-backed recommendations live in:
- `docs/components/component4/design.md`
- `docs/components/component4/implementation_checkpoint.md`

## Current Status

An initial local C4 (Coordinator) implementation now exists under:
- `coordinator/`

Current checkpoint:
- DB-backed readiness evaluation over C1 and C2 state
- one shared apply-prep flow that creates:
  - an orchestration run
  - `apply_context.json`
  - `c3_apply_context.json`
- fill-request, fill-result, review, and submit-gate state transitions

Still later:
- browser opening from the shared apply-prep command
- loading C3 context directly into a live Chrome extension session
- full OpenClaw/browser-lane integration on `server2`

## Operator CLI (convention)

C4 already surfaces **`hunt apply-prep <job_id>`** via **`huntctl`**. Additional coordinator commands (submit-gate, run status, drain orchestration queue) should follow the same pattern : new **`huntctl`** subparsers, documented here and in **`docs/CLI_CONVENTIONS.md`**. Prefer **`python -m coordinator.cli`** (or shared service modules) as the implementation target that **`huntctl`** invokes.

## Why C4 (Coordinator) Should Be Separate

C3 (Executioner) should remain the browser autofill engine.

If submit logic, job gating, and higher-level decision-making are mixed into C3 (Executioner), then:
- the extension becomes harder to test
- manual use becomes harder to reason about
- future orchestrators become tightly coupled to extension internals

Keeping C4 (Coordinator) separate gives cleaner ownership:
- C1 finds and enriches jobs
- C2 prepares resumes
- C3 fills forms and uploads the chosen resume
- C4 coordinates the end-to-end flow and decides when submit should happen

## Current Expected Shape

Recommended first C4 (Coordinator) implementation:
- OpenClaw on `server2`

Recommended role:
- inspect C1 and C2 state
- choose a ready job
- call one apply-prep command that resolves the DB row and primes C3
- trigger C3 when appropriate
- decide whether final submit should happen
- route blocked or suspicious flows to manual review

Important rule:
- C4 should consume the other components
- it should not redefine their internal contracts ad hoc

Recommended first execution style:
- OpenClaw owns job selection, sequencing, and policy decisions
- one shared Hunt apply-prep command resolves DB state and primes C3 (Executioner)
- C3 (Executioner) remains the deterministic browser autofill layer
- final submit remains a separate explicit decision point

That keeps browser-agent prompting narrow:
- choose one job
- fetch one explicit apply context
- trigger one bounded browser action
- inspect evidence
- either continue or hand off

## Inputs

From C1 (Hunter):
- job metadata
- `apply_url`
- ATS type
- enriched description
- priority/manual-only signals

From C2 (Trapper):
- selected resume version
- selected resume PDF path
- resume concern flags
- generation metadata

From C3 (Executioner):
- fill results
- generated answers used
- evidence paths
- manual-review flags
- page interaction summary

## Core Responsibilities

- queue selection and gating
- end-to-end sequencing across components
- calling the shared apply-prep command for one chosen job
- deciding whether autofill should run
- deciding whether final submit should run
- handling blocked/manual-review paths
- later notifications and summaries

Recommended data ownership:
- C4 owns orchestration runs, decisions, and submit approvals
- C4 does not become the source of truth for job discovery, resume generation, or ATS selectors

## Shared Apply-Prep Command

The recommended C4 interaction should not be:
- query DB manually
- build an ad hoc payload in OpenClaw prompt text
- hope C3 picks the right resume

The recommended interaction should be:

1. C4 chooses one `job_id`
2. C4 calls one apply-prep command
3. that command reads the DB row
4. that command resolves:
   - `apply_url`
   - selected resume version
   - selected resume path
5. the current implementation writes one explicit C4 context plus one C3-ready payload artifact
6. a later bridge can open the target page and load the C3 payload into the extension session
7. C4 then asks C3 to fill

Benefits:
- one source of truth for resume resolution
- less duplicated logic in OpenClaw prompts
- fewer mismatches between DB state and browser state

Current shared command shape:

```text
python -m coordinator.cli apply-prep --job-id <ID>
./hunt.sh apply-prep <ID>
```

Minimum resolved output:
- `job_id`
- `apply_url`
- `ats_type`
- selected resume version id
- selected resume path
- best available JD snapshot path
- relevant flags from C1/C2 that may affect apply behavior
- C3-ready context path or payload id
- orchestration run id

Current side effects:
- create one orchestration run record
- write one explicit apply-context artifact for C3
- write one C4 apply-context artifact for orchestration state

Later side effects:
- optionally open the target page in the intended browser lane
- optionally prime a live C3 extension session

## Out Of Scope For C4 (Coordinator)

C4 (Coordinator) should not own:
- scraping logic
- resume generation logic
- ATS DOM selector logic
- low-level browser extension field mapping

Those responsibilities belong to C1 (Hunter), C2 (Trapper), and C3 (Executioner) respectively.

## Proposed Stages

### Stage 0 : contracts, schema, and policy boundaries

What to do:
- lock the C4 boundary against C1, C2, and C3
- define the minimum ready-to-apply contract
- define which actions are always allowed versus approval-gated
- add C4-owned persistence for orchestration runs and decisions

Recommended deliverables:
- `docs/components/component4/design.md`
- one C4 state model, likely:
  - `orchestration_runs`
  - `orchestration_events`
  - `submit_approvals`
- one ready-job predicate based on existing C1/C2 state

Minimum ready predicate:
- C1 enrichment is in a normal done state
- `apply_type = external_apply`
- `auto_apply_eligible = 1`
- `priority = 0`
- C2 has a selected resume ready for C3
- no active manual-review hold exists

Exit criteria:
- the repo has one documented definition of "ready for C4"
- C4 persistence is separate from enrichment and application-attempt history

### Stage 1 : read-only orchestration view

What to do:
- build a read-only view of downstream readiness
- show why a job is ready, blocked, or excluded
- make it easy to audit why LinkedIn Easy Apply and manual-only rows are excluded

Recommended output:
- CLI or API summary of:
  - ready jobs
  - waiting-on-C2 jobs
  - excluded Easy Apply jobs
  - manual-only jobs
  - blocked/manual-review jobs

Exit criteria:
- an operator can inspect C4 readiness without mutating queue state
- the review surface can explain "why this job is not proceeding"

### Stage 2 : shared apply-prep command

What to do:
- implement the single job-resolution command C4 will call
- resolve the selected resume and apply URL from DB state
- emit one explicit apply context for C3

Inputs:
- `job_id`

Resolved outputs:
- `apply_url`
- `ats_type`
- selected resume version id
- selected resume file path
- JD snapshot path
- C3-ready context path or payload id

Exit criteria:
- OpenClaw does not need to hand-build a browser payload from raw DB fields
- C3 can be primed from one explicit apply-prep result

### Stage 3 : intentional C3 invocation

What to do:
- let C4 choose one job
- run apply-prep
- trigger C3 fill in a bounded, explicit way
- save evidence and the result summary

Recommended first policy:
- fill only
- no autonomous submit yet

Exit criteria:
- one orchestration run can move a job from ready state to filled-with-evidence
- C4 captures whether the result is:
  - success and reviewable
  - blocked
  - suspicious
  - failed

### Stage 4 : manual-review routing

What to do:
- define review-trigger conditions
- route questionable flows away from unattended continuation
- expose the exact reason for handoff

Recommended initial review triggers:
- login required
- CAPTCHA / OTP / verification
- unsupported ATS step
- low-confidence generated answers
- unexpected multi-page flow
- missing required fields after fill
- resume upload failure

Exit criteria:
- manual-review routing is explicit and auditable
- C4 never silently continues through a suspicious browser flow

### Stage 5 : submit policy and approval gate

What to do:
- define the policy for when final submit is allowed
- separate autofill success from submit permission
- record who or what approved the final submit decision

Recommended first policy:
- require explicit operator approval for every submit
- allow fill and evidence capture without submit

Later policy options:
- per-ATS allowlist
- per-company denylist
- confidence/risk threshold rules
- bounded unattended submit for narrow known-good flows

Exit criteria:
- submit is a first-class state transition, not a side effect
- every submit attempt is tied to an approval record

### Stage 6 : unattended orchestration runs

What to do:
- let OpenClaw or another runtime pick from the ready queue on a schedule
- enforce concurrency, retry, and per-run limits
- write summaries and notifications

Recommended first unattended guardrails:
- one active apply run at a time
- max jobs per cycle
- retry budget per job
- cooldown after auth or anti-bot trouble
- stop-the-world behavior for broken shared dependencies

Exit criteria:
- C4 can run continuously without blindly draining the queue
- operators get enough summary state to trust or pause the system

### Stage 7 : operational hardening and wider ATS coverage

What to do:
- expand beyond the first stable ATS family only after Workday-style flows are dependable
- improve review surfaces, metrics, and artifacts
- tune policy per ATS family

Exit criteria:
- C4 decisions remain inspectable as ATS coverage grows
- growth happens by adapter and policy expansion, not by prompt sprawl

## Deployment Direction

C4 (Coordinator) should deploy separately from C1 (Hunter), C2 (Trapper), and C3 (Executioner).

For now that likely means:
- OpenClaw on `server2`
- separate deployment/runtime docs
- separate operator controls from the C3 extension itself

Recommended server shape:
- separate OpenClaw runtime on `server2`
- separate C4-facing config and secrets from C1 (Hunter) timers
- separate operator controls from the C3 extension UI
- separate deployment step in `ansible_homelab`

Recommended first runtime responsibilities on `server2`:
- read ready jobs from Hunt state
- run one bounded orchestration task at a time
- persist orchestration records outside the repo checkout
- expose enough logs and artifacts for later review

## Related Docs

- `docs/components/component3/README.md`
- `docs/components/component3/design.md`
- `docs/components/component2/design.md`
- `docs/components/component4/design.md`
- `docs/roadmap.md`
