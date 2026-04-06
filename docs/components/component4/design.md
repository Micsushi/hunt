# Component 4 : Design And Research Notes

## Purpose

This document turns the high-level Component 4 idea into an implementation plan.

It answers:
- what Component 4 should do first
- what should stay outside Component 4
- how OpenClaw most likely fits
- what browser-agent patterns are worth copying
- what concrete repo work should happen stage by stage

The current intended first implementation remains:
- OpenClaw on `server2`

But the important design choice is not "use OpenClaw everywhere."
It is:
- use OpenClaw for orchestration and policy
- keep deterministic browser execution in Component 3
- keep final submit behind an explicit gate

## Recommended Product Boundary

Component 4 should be the control plane for apply work.

It should decide:
- which job is eligible right now
- whether the job should proceed
- whether Component 3 should fill
- whether the run should stop for review
- whether final submit is allowed

It should not own:
- scraping
- enrichment
- resume generation
- ATS-specific field selectors
- low-level extension-side fill logic

That separation matters because browser agents are strongest when they handle:
- planning
- sequencing
- branching
- policy
- exception routing

They are weaker when asked to be the only source of truth for:
- queue state
- resume selection
- ATS DOM details
- final safety policy

## Research Takeaways

### 1. OpenClaw already gives you useful orchestration primitives

OpenClaw's browser docs describe an isolated managed browser profile and a `user` profile that can attach to an existing signed-in Chromium session. Its browser tool also supports deterministic tab control, snapshots, screenshots, and PDFs. Its background-task docs expose task listing, cancel, audit, and Task Flow inspection commands.

Implication for Hunt:
- C4 should treat OpenClaw as the orchestration runtime and browser-control surface
- C4 should persist durable run records instead of relying on transient prompt state
- signed-in-session work should be an explicit lane, not an accidental side effect

Recommended C4 browser lanes:
- managed `openclaw` profile for inspection, navigation, and isolated browser work
- attached signed-in profile only when account/session continuity matters

### 2. The best browser-agent pattern is hybrid, not pure-agentic

Stagehand's docs explicitly position the tool as being built on top of Playwright, with direct access to Playwright `page` and `context`. The practical lesson is broader than Stagehand itself:
- let the agent handle generalization and page understanding
- let deterministic browser code handle stable, repeatable actions

Implication for Hunt:
- OpenClaw should not be responsible for raw Workday field filling logic
- C3 should stay the ATS-specific execution engine
- C4 should ask for narrow actions such as:
  - prepare one job
  - trigger one fill run
  - inspect one result
  - approve or stop

### 3. Durable task records beat prompt-only handoffs

A recent OpenClaw community example described using GitHub Issues as the task bus between OpenClaw and a browser agent, with labels acting as state, comments storing results, and the issue history serving as an audit trail.

The exact GitHub-Issues implementation is not the key point.
The key point is:
- browser-agent orchestration gets much more reliable when every step has a durable task record, state machine, and audit log

Implication for Hunt:
- the Hunt DB and review surfaces should play this role directly
- C4 should add durable orchestration tables instead of hiding state inside prompts or chat history

### 4. Browser auth state and artifacts need first-class handling

Playwright's auth docs recommend saving authenticated browser state to the filesystem and explicitly warn that the state file is sensitive. Playwright's locator guidance also recommends user-facing locators over brittle CSS/XPath chains, and its tooling emphasizes traces and snapshots for debugging.

Implication for Hunt:
- any browser-session material used by C4 or C3 should live outside the repo checkout
- auth state must be treated as sensitive runtime data
- evidence capture should be normal, not exceptional
- stable ATS adapters should lean on deterministic selectors and evidence, not prompt guesses

## Recommended Architecture

### Roles

Component 1:
- decides job discovery and enrichment state
- owns `apply_url`, `apply_type`, `auto_apply_eligible`, `ats_type`

Component 2:
- decides which resume is selected for downstream use
- owns selected resume version/path

Component 3:
- owns ATS-specific browser autofill and evidence capture

Component 4:
- owns sequencing, gating, routing, and submit policy

### First-class C4 objects

Recommended new persistence shape:

- `orchestration_runs`
  - one row per end-to-end C4 attempt on a job
- `orchestration_events`
  - append-only event log for state transitions and decisions
- `submit_approvals`
  - explicit approval records for final submit decisions

Recommended `orchestration_runs` fields:
- `id`
- `job_id`
- `status`
- `source_runtime`
- `selected_resume_version_id`
- `apply_url`
- `ats_type`
- `apply_context_path`
- `manual_review_required`
- `manual_review_reason`
- `submit_allowed`
- `submit_approval_id`
- `started_at`
- `completed_at`

Recommended `orchestration_events` fields:
- `id`
- `orchestration_run_id`
- `event_type`
- `step_name`
- `payload_path`
- `created_at`

Recommended `submit_approvals` fields:
- `id`
- `job_id`
- `orchestration_run_id`
- `approval_mode`
- `approved_by`
- `decision`
- `reason`
- `created_at`

## Shared Interfaces To Build

### 1. Ready-job selector

Component 4 needs one canonical ready predicate.

Recommended initial rule:
- C1 enrichment is `done` or equivalent normal verified-done state
- `apply_type = external_apply`
- `auto_apply_eligible = 1`
- `priority = 0`
- C2 has a selected resume ready for C3
- the job is not already claimed by an active apply/orchestration run
- the job is not under a manual-review or cooldown hold

### 2. Shared apply-prep command

This should be the main boundary between orchestration and execution.

Recommended interface:

```text
hunt apply-prep --job-id <ID>
```

Recommended responsibilities:
- read the job row
- resolve the downstream-selected resume from C2 state
- confirm the job is still C4-eligible
- write an explicit apply-context artifact
- optionally open the target URL in the intended browser lane
- return machine-readable context for C3 or OpenClaw

Recommended output payload:
- `job_id`
- `title`
- `company`
- `apply_url`
- `ats_type`
- `selected_resume_version_id`
- `selected_resume_pdf_path`
- `job_description_path`
- `source_mode`
- `manual_review_flags`
- `apply_context_path`

### 3. Intentional fill trigger

Recommended interface direction:

```text
hunt apply-run --job-id <ID> --mode fill-only
```

or:
- OpenClaw calls C3 through a stable extension-side tool/API after apply-prep has primed context

Important rule:
- first meaningful C4 automation should stop at filled-and-reviewed, not auto-submit

## Browser-Lane Strategy

Recommended first lanes:

### Lane A : isolated automation lane

Use:
- OpenClaw managed browser profile
- C3 test/dev work
- navigation and read-only validation

Why:
- cleaner isolation
- less risk to personal sessions
- easier to reset

### Lane B : signed-in operator lane

Use only when:
- existing logged-in state matters
- browser automation must continue in a real signed-in context
- the user/operator is intentionally allowing attached-session behavior

Why:
- job sites and ATS flows often depend on account continuity
- auth friction should be explicit in architecture

Important policy:
- C4 should know which lane it is using and record that choice

## Review And Submit Policy

### First production-safe policy

Allow:
- ready-queue selection
- apply-prep
- fill
- evidence capture
- explicit review routing

Do not allow yet:
- unattended final submit

### Review triggers

Recommended initial manual-review triggers:
- login required
- CAPTCHA, OTP, or anti-bot challenge
- unsupported ATS page or step
- changed page structure
- required field still missing after fill
- answer confidence below threshold
- resume upload mismatch
- suspicious redirect or hostname drift

### Submit gate

Submit should be a separate decision step.

Recommended first rule:
- every final submit requires explicit approval

Later, if the system earns trust, you can add:
- ATS-family allowlists
- company-level exceptions
- confidence thresholds
- bounded unattended submit for narrow known-good flows

## Recommended Stage Plan

### Stage 0 : lock the contract

Repo work:
- finalize this design direction
- define C4-owned DB objects
- define the ready-job predicate
- define initial review and submit policy

Output:
- docs locked
- schema plan ready

### Stage 1 : read-only readiness and audit surface

Repo work:
- add read-only C4 readiness queries
- expose why jobs are ready, blocked, excluded, or waiting
- show excluded Easy Apply and manual-only jobs clearly

Output:
- operator can inspect C4 readiness before C4 mutates anything

### Stage 2 : implement apply-prep

Repo work:
- add the `hunt apply-prep --job-id <ID>` command
- emit a machine-readable apply context
- persist one orchestration run entry when invoked

Output:
- C4 can fetch one explicit answer for one job

### Stage 3 : integrate bounded C3 fill

Repo work:
- let C4 trigger C3 intentionally
- capture fill result plus evidence paths
- record event history on the orchestration run

Output:
- one controlled end-to-end fill flow with no autonomous submit

### Stage 4 : review routing

Repo work:
- encode review-trigger rules
- add manual-review states and reasons to orchestration records
- surface those states in review tooling

Output:
- C4 routes questionable runs to humans instead of continuing blindly

### Stage 5 : submit approvals

Repo work:
- add submit approval persistence
- make submit a distinct command or action
- log exactly why submit was or was not allowed

Output:
- final submit becomes reviewable and auditable

### Stage 6 : unattended scheduler

Repo work:
- add bounded pick-next-job logic
- add concurrency guardrails
- add retry and cooldown policy
- add summary outputs and notifications

Output:
- C4 can run continuously without becoming an uncontrolled queue-drainer

### Stage 7 : hardening and ATS expansion

Repo work:
- improve metrics and artifact review
- tune policy by ATS
- expand beyond the first stable ATS family only after evidence quality is good

Output:
- C4 scales by explicit policy and adapters, not by increasingly vague prompts

## What I Would Build First

If the goal is to make real progress without overcommitting:

1. Stage 0 docs and schema decisions
2. Stage 1 read-only readiness view
3. Stage 2 apply-prep command
4. Stage 3 fill-only orchestration with no submit

That sequence gives you:
- a durable contract
- observable job readiness
- one clean integration point for OpenClaw
- a safe first end-to-end browser loop

It also postpones the riskiest part:
- unattended submit

## Deployment Direction

Component 4 should stay a separate deployment step in `ansible_homelab`.

Recommended first deployment shape on `server2`:
- separate OpenClaw runtime or service lane
- separate C4 env/config
- runtime storage outside the git checkout
- no coupling to the current Component 1 timer unit

Recommended runtime storage root:
- `/home/michael/data/hunt/orchestration`

Possible layout:

```text
/home/michael/data/hunt/orchestration/
  runs/
    <run_id>/
      apply_context.json
      decisions.json
      browser_summary.json
      final_status.json
  approvals/
    <job_id>/
      <timestamp>.json
```

## Open Questions To Settle Later

- whether OpenClaw should call a local Hunt CLI, local API, or both
- how C3 should expose its trigger surface to C4
- whether C4 state should live entirely in the Hunt DB or partly in an OpenClaw-side store
- whether initial review actions belong in the existing review app or a later dedicated C4/C3 control surface

The recommended default for now:
- Hunt DB plus local CLI/API contracts

## Research References

- OpenClaw browser docs: `https://docs.openclaw.ai/tools/browser`
- OpenClaw background tasks docs: `https://docs.openclaw.ai/automation/tasks`
- Stagehand Playwright interoperability: `https://docs.stagehand.dev/v2/best-practices/playwright-interop`
- Playwright auth docs: `https://playwright.dev/docs/auth`
- Playwright locator/best-practice docs:
  - `https://playwright.dev/docs/locators`
  - `https://playwright.dev/docs/best-practices`
- BrowserClaw task-bus example:
  - `https://www.reddit.com/user/Last_Net_9807/comments/1rqyb9w/i_built_a_bridge_between_my_ai_assistant_and_a/`
