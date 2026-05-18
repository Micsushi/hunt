# C4 Coordinator

C4 is the orchestration, scheduling, failure-logging, and submit-control layer for Hunt. It runs the pipeline that iterates ready jobs, calls C3 to fill each one, logs every failure in a structured format, queues novel failures for agent investigation, handles CAPTCHA escalation, gates final submit behind human approval, and exposes a Telegram interface for remote control.

C3 owns all browser interaction and field filling. C4 owns what happens between jobs and after a fill attempt completes.

## Current Status

### Built (complete)

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
- Telegram bot (`coordinator/telegram.py`): push notifications, long-poll command handler, `register_handler` API. Silent no-op if not configured.
- Telegram command handlers wired in service API startup: `approve`, `deny`, `skip`, `investigate`, `status`.
- Worker lease protocol: claim/heartbeat/result, `task_type="investigation"` path for agent workers.
- One-shot OpenClaw/Hermes investigation launcher in `coordinator/agent_worker.py`.
- Investigation prompt/result builders in `coordinator/agent_runtime.py`.
- CLI commands: all state-machine commands plus `scheduler-tick`, `investigate`, `failure-log`, `claim-investigation`.
- FastAPI wrapper in `coordinator/service_api.py` with all routes.
- C3 bridge endpoints: pending fills and inline fill-result postback.
- PowerShell and Bash wrappers under `scripts/c4_*_worker.*`.
- Full test suite: API, CLI, agent runtime, worker protocol, C3 bridge, failure log, scheduler, investigation routing.

All C4-only gaps are now implemented. See sections below for what remains blocked on other components.

### Not built — requires C3 changes

- CAPTCHA browser extension check: detecting whether a solver extension is loaded in the active browser profile before routing to agent fallback. C3 controls the browser; C4 has no visibility into extension state without C3 reporting it.
- C3 emitting `unknown_widget` failure code: C4 handles it when it arrives; C3 does not yet emit it with `selector/role/label/html_excerpt`.
- C3 structured failure payload: all C3 failure and manual_review results need a structured `failure_code`, field identifier, and HTML context. Currently C3 sends unstructured status strings.
- C3 gating final submit on `allowSubmit` flag: C4 sends the flag in every fill request; C3 ignores it currently.

### Not built — waiting on another component

- C0 UI: run list, run detail, event log, failure report viewer, investigation status, approval queue, scheduler status panel. C4 API is complete; the frontend does not exist yet.

### Belongs to Hermes/OpenClaw agent (outside this repo)

- Agent navigates to ATS page, observes blocking element, takes screenshot, captures HTML snapshot.
- Agent posts structured investigation result to C4's `/workers/{lease_id}/result`.
- Agent solves CAPTCHA (with capable model).
- C4's side is complete: it writes the prompt, issues the lease, and handles the result.

## Architecture

C4 is a mixture of hardcoded pipeline logic and bounded agent work.

**Hardcoded (no LLM):**
- Scheduler: iterate ready jobs, request C3 fill, record result, move on.
- State machine transitions.
- Failure log writes.
- CAPTCHA extension pass-through (not yet built — needs C3).
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
  -> investigation_queued       (C3 returns unknown_widget or captcha_*)
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
4. Route result: ok → awaiting_submit_approval, manual_review → manual_review, unknown_widget/captcha_* → investigation_queued, failed → failed.
5. Write failure log entry for any non-ok result.
6. Move to next job.

Implemented in `coordinator/scheduler.py`. Use `GET /scheduler/status`, `POST /scheduler/tick`, `POST /scheduler/start`, `POST /scheduler/stop`.

## Failure Logging

Every non-ok fill result writes a structured failure report. Format:

```json
{
  "run_id": "...",
  "job_id": "...",
  "ats_type": "...",
  "apply_url": "...",
  "failure_code": "unknown_widget | captcha_* | login_required | missing_field | ...",
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

Implemented in `coordinator/failure_log.py`.

## CAPTCHA Handling

Order of operations (all hardcoded except fallback):

1. Check if a CAPTCHA extension is loaded in the active browser profile. **Not yet built — requires C3 to report extension state.**
2. If no extension or extension fails: launch investigation agent with CAPTCHA-specific prompt. **Agent prompt built** (`build_captcha_prompt` in `coordinator/agent_runtime.py`).
3. If agent fails: push Telegram prompt to operator. Operator replies with solve or skip. **Built** — `notify_captcha` fires when investigation result returns `captcha_blocked`.

CAPTCHA type is classified by C3 and included in the failure code: `captcha_hcaptcha`, `captcha_recaptcha`, `captcha_cloudflare`, `captcha_unknown`.

## Submit Control

C3 will not click final submit unless `allowSubmit: true` is included in the fill payload. Off by default.

C4 sends `allow_submit` in every fill request (`fill_request.json` and `/c3/pending-fills` response), derived from `run.submit_allowed`.

C4 enables per-run via:
- CLI: `python -m coordinator.cli approve-submit --run-id <id> --decision approve`
- API: `POST /runs/{run_id}/approve`
- Telegram command: `allow-submit <run_id>` — built, wired in service_api startup
- C0 UI approval action — **not yet built**

C3 must check `allowSubmit` before clicking final submit — **not yet built in C3**.

## Telegram Interface

Bidirectional. C4 pushes events; operator replies with commands.

**Push notifications (all wired):**
- Fill complete, awaiting approval — fires on `awaiting_submit_approval` transition.
- Manual review required — fires on `manual_review` transition (fill result and reconcile-stale paths).
- Investigation queued — fires on `investigation_queued` transition and on manual `queue_investigation`.
- Investigation complete — fires from `record_investigation_result`.
- CAPTCHA challenge — fires when investigation result returns `captcha_blocked`.

**Wired commands (service_api startup):**
- `approve <run_id>` / `deny <run_id>`
- `skip <job_id>`
- `investigate <run_id>`
- `allow-submit <run_id>`
- `status`

## Investigation Agent

When C4 queues a run for investigation, it launches an agent (Hermes or OpenClaw) with a bounded investigation prompt. The agent:

1. Opens the apply URL in p chrome.
2. Navigates to the page state where C3 failed.
3. Observes and documents the blocking element (selector, role, label, HTML, framework hints).
4. Takes a screenshot and HTML snapshot.
5. Writes `agent_findings` and `suggested_fix_area` in the failure report.
6. Posts the result back to C4.
7. Stops. Does not fill, submit, or modify any application data.

C4's side is complete: prompt written, lease issued, result received and merged into `failure_report.json`. The actual agent execution is Hermes or OpenClaw running as a separate process.

Reports accumulate in `logs/failures.jsonl`. Operator reviews them periodically and hands batches to another agent to write C3 fixes.

See `docs/C4_AGENT_WORKERS.md` for the investigation worker contract.

## C0 UI Requirements

The C0 coordinator page needs (not yet built):

- Run list with status, ATS type, company, title, timestamp.
- Run detail: state history, event log, artifacts panel.
- Failure report viewer: inline display of `failure_report.json` with screenshots.
- Investigation status: pending / complete / agent findings summary.
- Manual review queue with resolution controls.
- Approval queue: approve / deny with confirmation.
- Submit control toggle per run.
- Scheduler status: running / paused / last tick / jobs queued.

## Artifacts

Per-run artifacts under:

```text
<HUNT_COORDINATOR_ROOT>/runs/<run_id>/
```

Files:

- `apply_context.json`: C4 context.
- `c3_apply_context.json`: C3/browser payload.
- `fill_request.json`: fill request metadata (includes `allow_submit` flag).
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

All routes require `Authorization: Bearer $HUNT_SERVICE_TOKEN` when configured.

```
GET  /status
POST /run
GET  /runs
GET  /runs/{run_id}
POST /runs/{run_id}/request-fill
POST /runs/{run_id}/approve
POST /runs/{run_id}/fill-result
POST /runs/{run_id}/investigate
GET  /runs/{run_id}/failure-report
GET  /c3/pending-fills
POST /c3/fill-result
POST /workers/claim
POST /workers/claim-investigation
POST /workers/{lease_id}/heartbeat
POST /workers/{lease_id}/result
POST /maintenance/reconcile-stale
GET  /failures
GET  /scheduler/status
POST /scheduler/tick
POST /scheduler/start
POST /scheduler/stop
```

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
python -m coordinator.cli scheduler-tick
python -m coordinator.cli investigate --run-id run-123-abc
python -m coordinator.cli failure-log --limit 50
python -m coordinator.cli claim-investigation --runtime-name hermes_local
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
