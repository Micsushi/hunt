# Hunter -> Coordinator Ops Guide

This document covers runtime and operator planning for running C4 (Coordinator) against live C1/C2 data on Linux.

Use this doc for:
- `server2` deployment planning
- runtime path decisions
- monitoring and runbooks
- security and retention rules

Related docs:
- [hunter-coordinator-plan.md](./hunter-coordinator-plan.md)
- [hunter-coordinator-research.md](./hunter-coordinator-research.md)
- [design.md](./design.md)

## Recommended Production Layout

### DB path

Use the live Hunt DB:

```text
HUNT_DB_PATH=/home/michael/data/hunt/hunt.db
```

Do not point production C4 at:

```text
/home/michael/hunt/hunt.db
```

That path is the empty fallback DB used in older local flows.

### Runtime root

Set:

```text
HUNT_COORDINATOR_ROOT=/home/michael/data/hunt/coordinator
```

Backward-compatible alias accepted by code:

```text
HUNT_ORCHESTRATION_ROOT=/home/michael/data/hunt/coordinator
```

Why:
- repo defaults are fine for local work
- production artifacts should live outside checkout
- auth state, traces, screenshots, and resume data are sensitive

### Recommended directory shape

```text
/home/michael/data/hunt/
  hunt.db
  coordinator/
    runs/
    approvals/
    browser/
    auth/
    traces/
    screenshots/
    logs/
```

Notes:
- `runs/` and `approvals/` already match current C4 behavior
- `browser/`, `auth/`, `traces/`, and `screenshots/` are recommended additions for production ops

## Service Topology

Recommended split on `server2`:
- C1 discovery/enrichment service stays separate
- C4 coordinator service stays separate
- review/control-plane web app stays separate
- OpenClaw gateway or browser service stays separate

Do not bundle these into one long-lived monolith.

Benefits:
- cleaner restarts
- smaller blast radius
- easier permissions and secrets handling
- simpler rollback when only one component changes

## Runtime Rules

### Single active execution run

Keep one active C4 execution run at a time.

Why:
- current scheduler already assumes this
- SQLite WAL still allows only one writer at a time
- browser automation gets harder to debug with concurrent live runs
- login/captcha issues are often shared-dependency failures

### Local filesystem only

Keep Hunt DB and coordinator runtime on local storage on the same host.

Do not plan around:
- network-mounted SQLite DB
- split DB host with shared WAL over NFS

### Bounded automation

First production-safe C4 loop should allow:
- ready selection
- apply prep
- fill request
- fill result capture
- manual-review routing
- explicit submit approval

Do not allow initially:
- unattended final submit
- automatic retries on auth or anti-bot failures
- hidden background mutation outside run/event records

## Environment Checklist

Minimum env for C4 service:

```text
HUNT_DB_PATH=/home/michael/data/hunt/hunt.db
HUNT_COORDINATOR_ROOT=/home/michael/data/hunt/coordinator
```

If C4 uses OpenClaw:
- keep OpenClaw config and tokens outside repo
- keep browser/auth runtime under operator-owned home or data path
- keep loopback-only or tailnet-only access

If C4 touches C2 artifacts:
- ensure selected resume PDF paths remain valid on host
- ensure artifact cleanup does not delete active selected resume files

## Browser-Lane Ops

### Lane A: isolated automation lane

Recommended for:
- local validation
- deterministic browser runs
- safe page inspection
- extension integration testing

Operational rules:
- use dedicated profile/runtime path
- allow reset without affecting personal sessions
- store evidence here by default

### Lane B: signed-in operator lane

Recommended only when:
- login continuity matters
- session storage/auth state cannot be reproduced safely in isolated lane
- operator is intentionally approving attached-session behavior

Operational rules:
- attach explicitly
- record lane choice in run metadata once field exists
- stop and release control session cleanly after review

## Monitoring Plan

At minimum, monitor these signals:

### Readiness

Source:
- `python -m coordinator.cli summary`
- `python -m coordinator.cli ready-list`

Watch:
- `ready_count`
- counts by reason
- `easy_apply_excluded`
- `waiting_on_resume`
- `waiting_on_enrichment`

### Scheduler guardrails

Watch:
- `active_run_id`
- `global_hold.blocked`
- hold reasons

### Run outcomes

Watch:
- counts by run status
- count of `manual_review`
- count of `failed`
- count of `submit_denied`
- count of `submitted`

### Artifact health

Watch:
- disk usage under coordinator runtime root
- growth of traces/screenshots
- missing artifact files for non-terminal runs

### Stale state

Watch for:
- jobs left `claimed` with no open orchestration run
- runs left in `apply_prepared` or `fill_requested` beyond expected SLA
- repeated `hostname_drift`
- repeated `resume_upload_failure`

## Suggested Operator Commands

Current useful commands:

```text
python -m coordinator.cli summary
python -m coordinator.cli ready-list --only-ready
python -m coordinator.cli runs --status manual_review
python -m coordinator.cli run-status --run-id <RUN_ID>
python -m coordinator.cli events --run-id <RUN_ID>
```

Planning recommendation:
- expose the most common C4 reads through `hunterctl` only after parser/tests/docs are in place

## Runbooks

### No ready jobs

Symptoms:
- `pick-next` returns `idle`
- summary shows `ready_count = 0`

Check:
- enrichment backlog
- missing selected resume fields
- manual-only rows
- easy-apply exclusion counts

Likely fix path:
- repair upstream C1 or C2 state
- do not force C4 mutation first

### Active run stuck

Symptoms:
- `pick-next` returns `active_run_in_progress`
- same run remains in `apply_prepared` or `fill_requested`

Check:
- `run-status`
- whether C3 bridge actually consumed `fill_request.json`
- browser process or OpenClaw task health

Likely fix path:
- capture current artifacts
- stop live browser control cleanly
- decide whether to resume, fail, or requeue

### Global manual-review hold

Symptoms:
- `pick-next` returns `global_manual_review_hold`
- blocking reasons include auth/captcha/login/otp/security

Check:
- newest run in `manual_review`
- screenshots and browser summary
- whether login/session expired for shared dependency

Likely fix path:
- repair login state manually
- clear hold only after explicit review resolution

### Missing resume path

Symptoms:
- readiness reason `waiting_on_resume`
- selected resume fields missing or stale

Likely fix path:
- rerun C2 selection or repair selected artifact paths
- do not let C4 guess a fallback file during live apply work

### Hostname drift

Symptoms:
- fill result generates `hostname_drift`

Likely causes:
- redirected ATS handoff
- broken apply link
- unexpected login wall or interstitial

Likely fix path:
- review evidence
- decide whether new host is legitimate and supported
- update C1/C3 rules if pattern proves real

## Security Rules

Treat these as sensitive:
- browser auth state
- cookies/local storage/session captures
- selected resume PDFs
- generated answers
- screenshots
- HTML snapshots
- traces

Rules:
- keep them outside repo checkout
- avoid world-readable permissions
- avoid copying into issue trackers or chat without redaction
- keep gateway/browser control loopback-only unless remote access is intentional and protected

## Retention Rules

Recommended first policy:
- keep all artifacts for active and recent runs
- keep failed/manual-review evidence longer than success cases
- expire bulky trace/screenshot bundles on a schedule
- keep approval records and final status artifacts longer than raw browser captures

Need explicit policy before unattended pilot:
- retention window for success artifacts
- retention window for manual-review failures
- redaction policy for exported debug bundles

## Deployment Gates Before `server2`

Do not deploy C4 continuously until all of these are true:
- C4 tests cover readiness reasons and state transitions
- runtime root is moved outside repo checkout
- operator can inspect run/event/artifact state quickly
- one C3 bridge exists and is documented
- auth/captcha hold behavior is documented
- rollback plan exists

## Practical Note On SQLite Version

Local `python3` in this workspace reports SQLite `3.45.1`.

Implication:
- do not assume newest SQLite WAL fixes are present on `server2`
- keep single-writer guardrails
- keep transactions short
- validate server runtime version explicitly during deployment prep
