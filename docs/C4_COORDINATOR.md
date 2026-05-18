# C4 Coordinator

C4 is the orchestration, scheduling, failure-logging, and submit-control layer for Hunt. It runs the pipeline that iterates ready jobs, calls C3 to fill each one, logs every failure in a structured format, queues novel failures for agent investigation, handles CAPTCHA escalation, gates final submit behind human approval, and exposes a Telegram interface for remote control.

C3 owns all browser interaction and field filling. C4 owns what happens between jobs and after a fill attempt completes.

## Current Status

Implemented:

- DB-backed state machine in `coordinator/service.py`.
- Tables and migrations for `orchestration_runs`, `orchestration_events`, `submit_approvals`, `orchestration_worker_leases`. Columns: `failure_code`, `failure_report_path`. Statuses: `investigation_queued`, `investigation_complete`.
- Readiness decisions for missing jobs, manual-only jobs, Easy Apply exclusion, unsupported apply types, enrichment wait, missing resume, active runs, and manual-review holds.
- Apply context artifacts under the C4 runtime root.
- C3-compatible apply payloads with embedded PDF data URLs.
- `allowSubmit` flag in fill requests: off by default, pass-through from `run.submit_allowed` into `fill_request.json` and `/c3/pending-fills` response.
- Structured failure report writer (`coordinator/failure_log.py`): per-run `failure_report.json` + append-only `logs/failures.jsonl`.
- `derive_failure_code`: maps C3 fill result + review flags to typed failure codes (`unknown_widget`, `captcha_*`, `login_required`, etc.).
- Investigation routing: C3 results with `unknown_widget` or `captcha_*` failure codes route to `investigation_queued` instead of `manual_review`.
- `queue_investigation()`, `record_investigation_result()`, `get_failure_log()` in service.
- Investigation result merges agent findings into `failure_report.json` and appends updated entry to `logs/failures.jsonl`.
- CAPTCHA escalation to Telegram when investigation result returns `captcha_blocked`.
- Pipeline scheduler (`coordinator/scheduler.py`): `SchedulerLoop` with tick/start/stop/status. Module-level singleton via `get_scheduler()`.
- Telegram bot (`coordinator/telegram.py`): push notifications (fill complete, manual review, investigation queued/complete, CAPTCHA), long-poll command handler, `register_handler` API. Silent no-op if not configured.
- Telegram command handlers wired in service API startup: `approve`, `deny`, `skip`, `investigate`, `status`.
- CLI commands in `coordinator/cli.py`: all existing commands plus `scheduler-tick`, `investigate`, `failure-log`, `claim-investigation`.
- FastAPI wrapper in `coordinator/service_api.py`.
- C3 bridge endpoints: pending fills and inline fill-result postback.
- Worker lease routes: `/workers/claim`, `/workers/claim-investigation`, heartbeat, result, reconcile-stale.
- Scheduler routes: `GET /scheduler/status`, `POST /scheduler/tick`, `POST /scheduler/start`, `POST /scheduler/stop`.
- Investigation routes: `POST /runs/{run_id}/investigate`.
- Failure log routes: `GET /failures`, `GET /runs/{run_id}/failure-report`.
- One-shot OpenClaw/Hermes investigation launcher in `coordinator/agent_worker.py`.
- Investigation prompt/result builders in `coordinator/agent_runtime.py` (investigation schema).
- PowerShell and Bash wrappers under `scripts/c4_*_worker.*`.
- API, CLI, agent runtime, worker protocol, and C3 bridge tests.

Not yet built:

- CAPTCHA browser extension check (code path to detect if extension is loaded and pass to it first).
- C0 UI: run detail, event log, artifacts, manual-review resolution, approval controls, investigation report viewer, scheduler status panel.

## Architecture

C4 is a mixture of hardcoded pipeline logic and bounded agent work.

**Hardcoded (no LLM):**
- Scheduler: iterate ready jobs, request C3 fill, record result, move on.
- State machine transitions.
- Failure log writes.
- CAPTCHA extension pass-through.
- Submit control flag.
- Telegram command handling.
- Investigation queue management.

**Agent work (LLM, bounded):**
- Novel ATS/UI investigation: when C3 reports an unknown widget or novel failure, an agent opens the page in p chrome, observes what blocked C3, and writes a structured investigation report. It does not fill or submit anything.
- CAPTCHA fallback: if no extension solved it, agent attempts to solve it. If agent fails, Telegram escalation to operator.

## State Machine

```text
ready job
  -> apply_prepared
  -> fill_requested
  -> [C3 fills]
  -> awaiting_submit_approval   (fill ok, no flags)
  -> submit_approved
  -> submitted
```

Manual-review branch:

```text
fill_requested
  -> manual_review              (C3 returns manual_review or review flags)
  -> awaiting_submit_approval
  -> submit_approved
  -> submitted
```

Investigation branch:

```text
fill_requested
  -> investigation_queued       (C3 returns unknown_widget or novel failure)
  -> investigation_complete     (agent posts report)
  -> failed                     (logged for code fix later)
```

Terminal states: `failed`, `submit_denied`, `submitted`.

Global manual-review holds block the scheduler when the reason is `login_required`, `captcha_challenge`, `otp_required`, or `security_challenge`.

## Readiness Gates

A job is ready only when:

- Job exists.
- No active non-terminal run exists for that job.
- Job status is not claimed, applied, failed, or skipped.
- `priority` is `0`.
- `enrichment_status` is `done` or `done_verified`.
- `apply_type` is `external_apply`.
- `auto_apply_eligible` is truthy.
- `apply_url` exists.
- A selected resume exists and `selected_resume_ready_for_c3` is truthy.

Easy Apply rows are blocked with reason `easy_apply_excluded`.

## Pipeline Scheduler

The scheduler is hardcoded Python, no LLM. It runs as a loop or cron tick:

1. Query all ready jobs.
2. For each: check no active run, create run, request C3 fill.
3. Wait for C3 result postback.
4. Route result: ok → awaiting_submit_approval, manual_review → manual_review, unknown_widget/novel → investigation_queued, failed → failed.
5. Write failure log entry for any non-ok result.
6. Move to next job.

Not yet built. See `coordinator/service.py` for state transitions to hook into.

## Failure Logging

Every non-ok fill result writes a structured failure report. Format:

```json
{
  "run_id": "...",
  "job_id": "...",
  "ats_type": "...",
  "apply_url": "...",
  "failure_code": "unknown_widget | captcha | login_required | missing_field | ...",
  "unknown_widget": {
    "selector": "...",
    "role": "...",
    "label": "...",
    "html_excerpt": "..."
  },
  "agent_findings": "",
  "suggested_fix_area": "",
  "screenshots": [],
  "html_snapshot": "",
  "investigation_status": "pending | complete | captcha_escalated | skipped",
  "timestamp": "..."
}
```

Reports are written under:

```text
<HUNT_COORDINATOR_ROOT>/runs/<run_id>/failure_report.json
```

All failure reports are also appended to a perma-log:

```text
<HUNT_COORDINATOR_ROOT>/logs/failures.jsonl
```

Not yet built. Report schema is defined; writer and perma-log not implemented.

## CAPTCHA Handling

Order of operations (all hardcoded except fallback):

1. Check if a CAPTCHA extension is loaded in the active browser profile. If yes, pass to it and wait for result.
2. If no extension or extension fails: launch investigation agent with CAPTCHA-specific prompt.
3. If agent fails: push Telegram prompt to operator. Operator replies with solve or skip.

CAPTCHA type is classified by C3 and included in the failure code: `captcha_hcaptcha`, `captcha_recaptcha`, `captcha_cloudflare`, `captcha_unknown`.

Not yet built.

## Submit Control

C3 will not click final submit unless `allowSubmit: true` is included in the fill payload. This is off by default.

C4 controls this flag per-run. Operator can enable it through:
- Telegram command: `allow-submit <run_id>`
- CLI: `python -m coordinator.cli approve-submit --run-id <id> --decision approve`
- C0 UI approval action.

C3 submit flag pass-through not yet built.

## Telegram Interface

Bidirectional. C4 pushes events; operator replies with commands.

C4 pushes:
- Fill complete, awaiting approval (with summary and approve/deny buttons).
- Manual review required (with reason and investigate/skip options).
- CAPTCHA challenge (with screenshot and solve/skip options).
- Investigation report ready (link to report).
- Scheduler status on request.

Operator commands:
- `approve <run_id>` / `deny <run_id>`
- `skip <job_id>`
- `status` — pending approvals, active fills, manual review queue
- `investigate <run_id>` — manually trigger investigation agent
- `allow-submit <run_id>` — enable C3 submit for this run

Not yet built.

## Investigation Agent

When C4 queues a run for investigation, it launches an agent (Hermes or OpenClaw) with a bounded investigation prompt. The agent:

1. Opens the apply URL in p chrome.
2. Navigates to the page state where C3 failed.
3. Observes and documents the blocking element (selector, role, label, HTML, framework hints).
4. Takes a screenshot and HTML snapshot.
5. Writes `agent_findings` and `suggested_fix_area` in the failure report.
6. Posts the result back to C4.
7. Stops. Does not fill, submit, or modify any application data.

Reports accumulate in `logs/failures.jsonl`. Operator reviews them periodically and hands batches to another agent to write C3 fixes.

See `docs/C4_AGENT_WORKERS.md` for the investigation worker contract.

## C0 UI Requirements

The C0 coordinator page needs:

- Run list with status, ATS type, company, title, timestamp.
- Run detail: state history, event log, artifacts panel.
- Failure report viewer: inline display of `failure_report.json` with screenshots.
- Investigation status: pending / complete / agent findings summary.
- Manual review queue with resolution controls.
- Approval queue: approve / deny with confirmation.
- Submit control toggle per run.
- Scheduler status: running / paused / last tick / jobs queued.

Not yet built.

## Artifacts

Per-run artifacts under:

```text
<HUNT_COORDINATOR_ROOT>/runs/<run_id>/
```

Files:

- `apply_context.json`: C4 context.
- `c3_apply_context.json`: C3/browser payload.
- `fill_request.json`: fill request metadata.
- `fill_result.json`: raw C3 result.
- `failure_report.json`: structured failure report (when non-ok).
- `investigation/prompt.md`: agent investigation prompt.
- `investigation/claim.json`: agent lease claim.
- `investigation/result.json`: agent investigation result.
- `investigation/screenshots/`: screenshots from agent.
- `investigation/snapshot.html`: HTML snapshot from agent.
- `decisions.json`: C4 decision after fill.
- `final_status.json`: terminal status.

## API

Current routes:

- `GET /status`
- `POST /run`
- `GET /runs`
- `GET /runs/{run_id}`
- `POST /runs/{run_id}/request-fill`
- `POST /runs/{run_id}/approve`
- `POST /runs/{run_id}/fill-result`
- `GET /c3/pending-fills`
- `POST /c3/fill-result`
- `POST /workers/claim`
- `POST /workers/{lease_id}/heartbeat`
- `POST /workers/{lease_id}/result`
- `POST /maintenance/reconcile-stale`

Planned additions:

- `POST /scheduler/tick` — run one scheduler pass.
- `POST /scheduler/start` / `POST /scheduler/stop` — start/stop scheduler loop.
- `GET /failures` — query failure log.
- `POST /runs/{run_id}/investigate` — manually trigger investigation agent.
- `POST /telegram/webhook` — Telegram bot webhook.

All routes require `Authorization: Bearer $HUNT_SERVICE_TOKEN` when configured.

## CLI

Direct C4 CLI:

```powershell
python -m coordinator.cli summary
python -m coordinator.cli ready --job-id 123
python -m coordinator.cli apply-prep --job-id 123 --browser-lane isolated --embed-resume-data
python -m coordinator.cli request-fill --run-id run-123-abc
python -m coordinator.cli run-status --run-id run-123-abc
python -m coordinator.cli approve-submit --run-id run-123-abc --decision approve --approved-by operator
python -m coordinator.cli mark-submitted --run-id run-123-abc
python -m coordinator.cli reconcile-stale --fill-timeout-minutes 30
```

Hunter pass-through examples:

```powershell
.\hunter.ps1 c4-summary
.\hunter.ps1 c4-ready --job-id 123
.\hunter.ps1 apply-prep 123 --browser-lane isolated
.\hunter.ps1 c4-run-once --prepare-only
.\hunter.ps1 c4-runs
```

## Verification

Unit/API tests:

```powershell
python test.py c4
```

C4 smoke:

```powershell
python smoke.py c4
```
