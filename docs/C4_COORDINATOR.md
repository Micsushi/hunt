# C4 Coordinator

C4 is the orchestration and submit-control layer for Hunt. It decides whether a job is ready to apply for, creates the apply packet, hands browser fill work to an execution runtime, records evidence, and keeps final submit behind an explicit approval gate.

## Current Status

Implemented now:

- DB-backed state machine in `coordinator/service.py`.
- Tables and migrations for `orchestration_runs`, `orchestration_events`, and `submit_approvals`.
- Readiness decisions for missing jobs, manual-only jobs, Easy Apply exclusion, unsupported apply types, enrichment wait, missing resume, active runs, and manual-review holds.
- Apply context artifacts under the C4 runtime root.
- C3-compatible apply payloads with embedded PDF data URLs.
- CLI commands in `coordinator/cli.py`.
- `hunter` pass-through commands for common C4 operations.
- FastAPI wrapper in `coordinator/service_api.py`.
- C3 bridge endpoints: pending fills and inline fill-result postback.
- Public HTTP request-fill route: `POST /runs/{run_id}/request-fill`.
- Generic worker lease protocol for C3/OpenClaw/Hermes: claim, heartbeat, result, and stale-run recovery.
- One-shot OpenClaw/Hermes worker launcher in `coordinator/agent_worker.py`.
- Runtime prompt/result builders in `coordinator/agent_runtime.py`.
- PowerShell and Bash wrappers under `scripts/c4_*_worker.*`.
- API and CLI tests plus a Postgres-backed C4 smoke.

Not implemented or not proven yet:

- Real browser-backed C3 polling from the extension.
- Live OpenClaw or Hermes browser proof. The launcher can claim and prepare/execute a bounded agent turn, but tests do not launch external agents.
- Live C0 validation against a real run queue, approval queue, and event log.
- Live ATS proof with evidence from a browser session.

## State Machine

```text
ready job
  -> apply_prepared
  -> fill_requested
  -> awaiting_submit_approval
  -> submit_approved
  -> submitted
```

Manual-review branch:

```text
fill_requested or apply_prepared
  -> manual_review
  -> awaiting_submit_approval
  -> submit_approved
  -> submitted
```

Terminal states:

- `failed`
- `submit_denied`
- `submitted`

Global manual-review holds block the scheduler when the reason is an account or browser access problem, such as `login_required`, `captcha_challenge`, `otp_required`, or `security_challenge`.

## Readiness Gates

A job is ready only when all of these are true:

- Job exists.
- No active non-terminal run exists for that job.
- Job status is not already claimed, applied, failed, or skipped.
- `priority` is `0`.
- `enrichment_status` is `done` or `done_verified`.
- `apply_type` is `external_apply`.
- `auto_apply_eligible` is truthy.
- `apply_url` exists.
- A selected resume exists and `selected_resume_ready_for_c3` is truthy.

Easy Apply rows are intentionally blocked with reason `easy_apply_excluded`.

## Artifacts

C4 writes per-run artifacts under:

```text
<HUNT_COORDINATOR_ROOT>/runs/<run_id>/
```

Typical files:

- `apply_context.json`: snake_case C4 context.
- `c3_apply_context.json`: camelCase C3/browser payload.
- `fill_request.json`: fill request metadata.
- `fill_result.json`: raw browser or worker result.
- `browser_summary.json`: normalized fill result summary.
- `decisions.json`: C4 decision after fill.
- `review_resolution.json`: manual-review resolution when present.
- `final_status.json`: terminal status.

Submit approvals are written under:

```text
<HUNT_COORDINATOR_ROOT>/approvals/<job_id>/
```

## API

Current C4 service routes:

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

All routes require `Authorization: Bearer $HUNT_SERVICE_TOKEN` when a service token is configured.

Worker protocol:

```text
POST /workers/claim
  -> returns one active lease plus one fill payload, or no_pending_fills

POST /workers/{lease_id}/heartbeat
  -> extends the active lease

POST /workers/{lease_id}/result
  -> records the fill result, completes the lease, and moves the run forward

POST /maintenance/reconcile-stale
  -> moves timed-out worker-controlled runs to manual_review
```

Workers should never receive DB credentials. They use only these HTTP routes.

## CLI

Direct C4 CLI:

```powershell
python -m coordinator.cli summary
python -m coordinator.cli ready --job-id 123
python -m coordinator.cli apply-prep --job-id 123 --browser-lane isolated --embed-resume-data
python -m coordinator.cli request-fill --run-id run-123-abc
python -m coordinator.cli claim-worker --runtime-name openclaw_isolated --browser-lane isolated
python -m coordinator.cli heartbeat-worker --lease-id lease-123 --lease-seconds 900
python -m coordinator.cli complete-worker --lease-id lease-123 --result-json fill_result.json
python -m coordinator.cli reconcile-stale --fill-timeout-minutes 30
python -m coordinator.cli run-status --run-id run-123-abc
python -m coordinator.cli approve-submit --run-id run-123-abc --decision approve --approved-by operator
python -m coordinator.cli mark-submitted --run-id run-123-abc
```

Hunter pass-through examples:

```powershell
.\hunter.ps1 c4-summary
.\hunter.ps1 c4-ready --job-id 123
.\hunter.ps1 apply-prep 123 --browser-lane isolated
.\hunter.ps1 c4-run-once --prepare-only
.\hunter.ps1 c4-runs
```

## Long-Running Agent Direction

C4 should remain the source of truth. Browser/agent runtimes should be workers that consume C4 fill requests and post normalized results back.

Supported runtime lanes to build toward:

- `c3_extension`: current Chrome extension bridge.
- `openclaw_isolated`: OpenClaw-managed isolated browser profile.
- `openclaw_attached`: OpenClaw attached user browser profile for logged-in sessions.
- `hermes_local`: Hermes local or WSL2 worker.
- `hermes_server`: Hermes Linux worker with container or SSH backend.

The submit decision stays human-gated for all lanes until a separate narrow allowlist is designed and tested.

## OpenClaw and Hermes Launcher

The shared launcher claims one C4 worker lease, writes artifacts, and stops unless explicitly told to launch the external agent:

```powershell
python -m coordinator.agent_worker --runtime openclaw_isolated --base-url http://127.0.0.1:8003
python -m coordinator.agent_worker --runtime hermes_local --base-url http://127.0.0.1:8003
```

Artifacts are written under:

```text
.runtime/c4-agent/<runtime>/<lease_id>/
```

Files:

- `claim.json`: full C4 lease and fill payload.
- `prompt.md`: bounded prompt for the selected agent.
- `result_template.json`: normalized result shape to post back.

Detailed worker contract:

- `docs/C4_AGENT_WORKERS.md`: shared C3/OpenClaw/Hermes lease lifecycle, HTTP payloads, result schema, guardrails, wrappers, and troubleshooting.
- `docs/C4_OPENCLAW_RUNBOOK.md`: OpenClaw-specific setup and pilot lane guidance.
- `docs/C4_HERMES_RUNBOOK.md`: Hermes-specific setup and WSL2/Linux guidance.

Wrapper examples:

```powershell
.\scripts\c4_openclaw_worker.ps1 -Runtime openclaw_isolated
.\scripts\c4_hermes_worker.ps1 -Runtime hermes_local
```

```bash
RUNTIME=openclaw_isolated ./scripts/c4_openclaw_worker.sh
RUNTIME=hermes_local ./scripts/c4_hermes_worker.sh
```

Safe protocol test without launching a browser or external agent:

```powershell
python -m coordinator.agent_worker --runtime openclaw_isolated --mock-result
```

External agent execution is opt-in:

```powershell
python -m coordinator.agent_worker --runtime openclaw_isolated --execute-agent
python -m coordinator.agent_worker --runtime hermes_local --execute-agent
```

Current runtime research checked on 2026-05-05:

- OpenClaw CLI docs show `openclaw agent --agent ops --message "Run locally" --local`, plus `--json` and gateway/local behavior: https://docs.openclaw.ai/cli/agent
- OpenClaw sandbox docs describe Docker, SSH, and OpenShell sandbox runtimes plus `openclaw sandbox explain/list/recreate`: https://docs.openclaw.ai/cli/sandbox
- Hermes CLI docs show non-interactive mode as `hermes chat -q "Hello"` and toolset selection with `--toolsets`: https://hermes-agent.nousresearch.com/docs/user-guide/cli
- Hermes README states native Windows is not supported and recommends WSL2 for Windows users: https://github.com/NousResearch/hermes-agent
- Hermes browser docs describe local Chrome/CDP, local `agent-browser`, and Browserbase/Browser Use/Firecrawl/Camofox options: https://hermes-agent.nousresearch.com/docs/user-guide/features/browser

## Verification

Unit/API tests:

```powershell
python test.py c4
```

C4 smoke:

```powershell
python smoke.py c4
```

Dry-run smoke command rendering:

```powershell
python smoke.py c4 --dry-run
```
