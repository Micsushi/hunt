# Component 4 Implementation Checkpoint

## Why This Exists

This note captures the current Component 4 thinking and partial repo work so the project can resume cleanly later without re-deriving the design.

It is a checkpoint, not a claim that C4 is fully production-ready yet.

## Research-Backed Direction

The current recommended C4 shape remains:
- OpenClaw or another higher-level runtime for orchestration and policy
- Component 3 as the deterministic browser execution layer
- final submit behind an explicit approval boundary

The main research conclusions have not changed:
- browser agents work best when they sequence and route, not when they become the only source of truth for queue state or ATS DOM details
- durable run records and event logs are better than prompt-only handoffs
- auth, anti-bot, and evidence artifacts need to be first-class runtime concerns
- the shared apply-prep boundary is still the cleanest seam between C4 and C3

Reference docs:
- `docs/components/component4/design.md`

## Stage-By-Stage Shape

### Stage 0

Lock contracts and persistence.

Current intended C4-owned DB objects:
- `orchestration_runs`
- `orchestration_events`
- `submit_approvals`

Current intended job lifecycle mapping:
- C4 reads the existing Hunt `jobs` row as the source of truth
- when a run starts, C4 claims the job by moving `jobs.status` from `new` to `claimed`
- when a run fails terminally, C4 marks the job `failed`
- when submit is denied, C4 marks the job `skipped`
- when submit completes, C4 marks the job `applied`

### Stage 1

Read-only readiness and audit.

Current ready predicate:
- no open C4 run already exists for the job
- `jobs.status` is not already `claimed`, `applied`, `failed`, or `skipped`
- `priority = 0`
- `enrichment_status in ('done', 'done_verified')`
- `apply_type = external_apply`
- `auto_apply_eligible = 1`
- `apply_url` is present
- C2 has a selected resume ready for C3

Current non-ready reason codes:
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

### Stage 2

Shared apply-prep.

Current intended artifacts per run:
- `runs/<run_id>/apply_context.json`
- `runs/<run_id>/c3_apply_context.json`

Current intended behavior:
- choose one ready job
- create one orchestration run
- claim the job
- write one explicit C4 context plus one C3-ready payload

### Stage 3

Intentional fill-only orchestration.

Current intended behavior:
- `request-fill` moves a run to `fill_requested`
- `record-fill` stores the browser result and evidence summary
- no autonomous submit occurs at this stage

### Stage 4

Manual-review routing.

Current review triggers to preserve:
- login required
- auth/security challenge
- CAPTCHA
- OTP / verification
- unsupported ATS step
- low-confidence answers
- missing required fields
- unexpected multi-page flow
- resume upload failure
- hostname drift / suspicious redirect

### Stage 5

Submit approval gate.

Current intended behavior:
- every submit decision is recorded in `submit_approvals`
- `approve-submit` does not itself submit
- `mark-submitted` is a separate final state transition

### Stage 6

Unattended scheduler guards.

Current intended guardrails:
- one active execution run at a time
- global stop-the-world hold when open manual-review runs indicate auth/anti-bot trouble
- LinkedIn-first picking when multiple jobs are ready

### Stage 7

Hardening later.

Still deferred:
- real OpenClaw trigger bridge
- dedicated operator UI for C4 review/submit actions
- full end-to-end tests across C1, C2, C3, and C4
- ATS-family tuning and wider rollout policy

## Current Repo Checkpoint

The current partial implementation now lives in `orchestration/`:
- `config.py`
- `context.py`
- `db.py`
- `models.py`
- `service.py`
- `cli.py`

What is present in code right now:
- DB creation/migration for C4 tables
- model objects for readiness, runs, events, approvals, and apply context
- readiness evaluation against the existing Hunt `jobs` row
- run creation via apply-prep
- artifact writing under a runtime root
- fill request + fill result recording
- manual-review routing
- submit approvals + submit completion
- scheduler `pick-next` and `run-once`

What has been verified so far:
- `python -m compileall orchestration`
- `python -m orchestration.cli init-db --db-path <temp.db> --runtime-root <tempdir>`

What is not finished yet:
- the Component 4 test suite has not been rewritten to match the new runtime
- `huntctl apply-prep` and the docs should consistently point at the shared C4 service rather than older helper scripts
- the docs still need a final "implemented commands" polish pass once tests are in place

## Resume Point

When continuing C4 work later, the clean next order is:

1. rewrite `tests/test_component4_cli.py` into stage-based tests against temp DB/runtime roots
2. add focused tests for:
   - readiness reasons
   - apply-prep artifacts
   - fill result routing
   - manual-review resolution
   - submit approval + submitted transitions
   - scheduler `pick-next` blocking behavior
3. keep `scripts/c3_apply_prep.py` only as a legacy C3-payload helper and avoid treating it as the shared apply-prep seam
4. expose more of the shared C4 commands through `scripts/huntctl.py` as needed
5. only then tighten the OpenClaw integration surface

## Practical Notes

- Per-command path overrides currently live on each CLI subcommand, so the working form is:
  - `python -m orchestration.cli init-db --db-path <DB> --runtime-root <ROOT>`
  - not global args before the subcommand
- the current runtime root default is local-repo-friendly for development; `server2` should still use an external runtime directory
- the current code is a useful checkpoint, but it should be treated as experimental until the C4 tests land
