# C4 Long-Running Agent Orchestration Implementation Plan
> REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans.

Goal: Make C4 coordinate long-running Windows, WSL2, and Linux agents that apply to jobs with a strict human submit gate.

Architecture: Keep C4 as the durable state machine and source of truth. Treat C3, OpenClaw, and Hermes as pluggable worker runtimes that lease C4 fill requests, operate a browser, post structured evidence, and stop before final submit. The first useful milestone is one reliable browser-backed run on a safe fixture, then one live external ATS run with final submit still manual.

Tech Stack: Python, FastAPI, Postgres/SQLite, Docker Compose, Chrome/Playwright, C3 MV3 extension, optional OpenClaw, optional Hermes Agent, optional Browser Use cloud browser.

## Research Snapshot

Sources checked on 2026-05-05:

- OpenClaw GitHub: https://github.com/openclaw/openclaw
- OpenClaw install docs: https://docs.openclaw.ai/install
- OpenClaw browser docs: https://docs.openclaw.ai/tools/browser
- OpenClaw scheduled/background task docs: https://docs.openclaw.ai/automation/cron-jobs and https://docs.openclaw.ai/automation/tasks
- Browser Use OpenClaw integration: https://docs.browser-use.com/cloud/tutorials/integrations/openclaw
- Hermes GitHub: https://github.com/NousResearch/hermes-agent
- Hermes browser automation page: https://hermes-agent.ai/features/browser-automation
- Hermes security, tools, and cron docs: https://hermes-agent.nousresearch.com/docs/user-guide/security, https://hermes-agent.nousresearch.com/docs/user-guide/features/tools, https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
- Browser Use Hermes integration: https://docs.browser-use.com/cloud/tutorials/integrations/hermes-agent

OpenClaw findings:

- Install path supports macOS, Linux, and Windows, with WSL2 called more stable in the install docs.
- Runtime is Node-based. Current docs recommend Node 24 or Node 22.14+.
- It has a Gateway daemon, chat channels, skills, cron, background task tracking, and browser tooling.
- Browser tool can use an isolated OpenClaw-managed Chromium profile or attach to a real signed-in Chrome session.
- Browser control is CDP/Playwright-shaped and can point at Browser Use cloud browsers by remote CDP URL.
- Good fit: Windows/WSL2 local worker, attached browser sessions, isolated test browser lanes, operator-controlled personal automation.
- Risk: main-session tools can run with broad host access. Hunt should use a narrow worker prompt, explicit allowlists, and C4 leases instead of giving the agent direct DB credentials.

Hermes findings:

- Hermes README says it works on Linux, macOS, WSL2, and Termux. Native Windows is not supported.
- It is designed for long-lived agents with memory, skills, subagents, cron, gateway messaging, and multiple terminal backends.
- It has local, Docker, SSH, Modal, Daytona, Singularity, and Vercel Sandbox execution backends.
- Security docs include command approvals, hardline blocklists, user allowlists, DM pairing, and container isolation.
- Browser automation is Playwright-based and can use Browser Use cloud browsers.
- Cron supports scheduled delivery, no-agent script jobs, provider fallback, and credential pool rotation.
- Good fit: Linux/WSL2 long-running server worker, scheduled audit jobs, resilient gateway worker with strong sandboxing.
- Risk: no native Windows. Use WSL2 on Windows or reserve Hermes for Linux/server2.

Working recommendation:

- Keep C3 extension as the shortest path because it already matches C4's pending-fill bridge.
- Pilot OpenClaw first for Windows/WSL2 because it has a native/WSL2 story and explicit isolated vs attached browser profiles.
- Pilot Hermes first on Linux/WSL2/server2 because its long-running gateway, cron, and sandbox docs are stronger for server operation.
- Do not let either agent write directly to the database. They should use C4 HTTP endpoints only.

## Current Repo Inventory

Implemented:

- `coordinator/service.py`: readiness, apply-prep, run creation, fill request, fill result recording, manual-review routing, submit approval, submit completion, scheduler pick/run-once.
- `coordinator/service_api.py`: status, run list/detail, run create, submit approval, path-based fill result, C3 pending fill, C3 inline fill result.
- `coordinator/cli.py`: direct C4 commands for the service methods.
- `scripts/hunterctl.py`: C4 pass-through commands.
- `tests/test_component4_cli.py`: CLI/state machine coverage.
- `tests/test_component4_service_api.py`: HTTP coverage.
- `tests/test_component4_c3_bridge.py`: C3 bridge coverage.
- `scripts/smoke_coordinator_e2e.sh`: Postgres-backed C4 smoke.
- `docs/C4_COORDINATOR.md`: current contract doc.

Important gaps:

- HTTP API lacks a clean `request_fill` route.
- C4 smoke mutates Postgres directly to simulate `fill_requested`; this should use the public API.
- No worker lease, heartbeat, or stale-run recovery.
- No live C3 browser polling proof.
- No OpenClaw worker prompt, skill, config, or smoke.
- No Hermes worker prompt, skill, config, or smoke.
- No C0 validation against a real C4 run queue and submit approval flow.

## Target Contract

C4 owns this loop:

```text
pick ready job
create apply packet
lease fill work to exactly one runtime lane
receive heartbeat and evidence
route to manual review when needed
wait for explicit submit approval
record submitted, denied, or failed terminal status
```

Worker runtimes own this loop:

```text
claim or poll one fill
open apply URL
fill known fields from C4 payload
upload selected resume
answer only grounded questions
stop at review/submit
post normalized result and evidence
```

Hard rules:

- No runtime receives DB credentials.
- No runtime submits without an approved C4 submit decision.
- One active fill per browser lane.
- Account, CAPTCHA, MFA, login, hostname drift, missing required fields, low-confidence answers, and unsupported ATS steps become manual review.
- Windows support means Hunt CLI/API works natively and agent runtimes work either native or WSL2. Hermes is WSL2/Linux only for Windows machines.

## Task 1: Freeze the Current C4 HTTP Contract

Files: modify `coordinator/service_api.py`, `tests/test_component4_service_api.py`, `scripts/smoke_coordinator_e2e.sh`, `docs/C4_COORDINATOR.md`.

- [x] Step 1: Add API test for request-fill.

```python
def test_request_fill_route_moves_run_to_fill_requested(self):
    with self.with_temp_context() as (path, runtime_root):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            f.write(b"%PDF-1.4 request-fill")
            f.flush()
            resume_path = f.name
        try:
            job_id = self.insert_ready_job(path, resume_path=resume_path)
            client = TestClient(app, raise_server_exceptions=False)
            run_resp = client.post("/run", headers=_auth(), json={"job_id": job_id})
            run_id = run_resp.json()["run_id"]
            fill_resp = client.post(f"/runs/{run_id}/request-fill", headers=_auth())
            pending_resp = client.get("/c3/pending-fills", headers=_auth())
        finally:
            if os.path.exists(resume_path):
                os.remove(resume_path)

    self.assertEqual(fill_resp.status_code, 200)
    self.assertEqual(fill_resp.json()["run"]["status"], "fill_requested")
    self.assertEqual(pending_resp.json()["fills"][0]["run_id"], run_id)
```

- [x] Step 2: Run expected fail.

```powershell
python -m pytest tests/test_component4_service_api.py -q
```

- [x] Step 3: Add route.

```python
@app.post("/runs/{run_id}/request-fill", dependencies=[Depends(require_service_token)])
def post_request_fill(run_id: str):
    svc = _get_service()
    from coordinator.service import OrchestrationError

    try:
        return svc.request_fill(run_id)
    except OrchestrationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
```

- [x] Step 4: Update `scripts/smoke_coordinator_e2e.sh` so it calls the new route instead of `UPDATE orchestration_runs SET status='fill_requested'`.

```bash
out=$(api -X POST "$BASE/runs/$RUN1/request-fill")
check_eq "POST /request-fill -> fill_requested" "fill_requested" "$(echo "$out" | json_field "['run']['status']")"
```

- [x] Step 5: Run tests.

```powershell
python test.py c4
python smoke.py c4 --dry-run
```

## Task 2: Add Worker Lease and Heartbeat Protocol

Files: modify `coordinator/db.py`, `coordinator/models.py`, `coordinator/service.py`, `coordinator/service_api.py`; create `tests/test_component4_worker_protocol.py`; update `docs/C4_COORDINATOR.md`.

- [x] Step 1: Add DB table.

```sql
CREATE TABLE IF NOT EXISTS orchestration_worker_leases (
    id TEXT PRIMARY KEY,
    orchestration_run_id TEXT NOT NULL,
    runtime_name TEXT NOT NULL,
    browser_lane TEXT,
    status TEXT NOT NULL,
    claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    heartbeat_at TEXT,
    expires_at TEXT NOT NULL,
    completed_at TEXT,
    worker_metadata_json TEXT DEFAULT '{}'
)
```

- [x] Step 2: Add tests.

Required test cases:

- `test_claim_pending_fill_creates_lease_and_hides_from_second_worker`: seed one `fill_requested` run, claim as `openclaw_isolated`, assert lease status `active`, assert a second claim returns no work.
- `test_heartbeat_extends_active_lease`: claim one run, call heartbeat, assert `heartbeat_at` changes and `expires_at` is later than the original value.
- `test_expired_lease_makes_fill_claimable_again`: backdate one active lease past `expires_at`, claim as `hermes_local`, assert the same run can be claimed again and the old lease is marked `timed_out`.
- `test_worker_result_completes_lease_and_records_fill_result`: claim one run, post an ok result, assert lease status `completed`, run status `awaiting_submit_approval`, and pending fills empty.

- [x] Step 3: Implement service methods.

```python
def claim_next_fill(
    self,
    *,
    runtime_name: str,
    browser_lane: str | None,
    lease_seconds: int = 900,
    worker_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]

def heartbeat_lease(self, lease_id: str, *, lease_seconds: int = 900) -> dict[str, Any]

def complete_lease_with_result(self, lease_id: str, payload: dict[str, Any]) -> dict[str, Any]
```

- [x] Step 4: Add HTTP routes.

```text
POST /workers/claim
POST /workers/{lease_id}/heartbeat
POST /workers/{lease_id}/result
```

- [x] Step 5: Run tests.

```powershell
python -m pytest tests/test_component4_worker_protocol.py tests/test_component4_service_api.py tests/test_component4_c3_bridge.py -q
```

## Task 3: Add Stale-Run Recovery

Files: modify `coordinator/service.py`, `coordinator/cli.py`, `coordinator/service_api.py`, `tests/test_component4_worker_protocol.py`, `docs/C4_COORDINATOR.md`.

- [x] Step 1: Add tests.

Required test cases:

- `test_reconcile_marks_expired_fill_requested_run_manual_review`: seed a `fill_requested` run older than `C4_FILL_TIMEOUT_MINUTES`, call reconcile, assert status `manual_review` and reason `worker_timeout`.
- `test_reconcile_leaves_awaiting_submit_approval_unchanged`: seed an `awaiting_submit_approval` run, call reconcile, assert status is still `awaiting_submit_approval`.

- [x] Step 2: Implement `reconcile_stale_runs()`.

Rules:

- Expired `fill_requested` with no active lease: `manual_review`, reason `worker_timeout`.
- Expired lease with heartbeat too old: mark lease `timed_out` and run `manual_review`.
- `awaiting_submit_approval` remains waiting until the operator decides.
- `submit_approved` older than configured window becomes `manual_review`, reason `submit_not_confirmed`.

- [x] Step 3: Add CLI/API.

```text
python -m coordinator.cli reconcile-stale --fill-timeout-minutes 30
POST /maintenance/reconcile-stale
```

- [x] Step 4: Run tests.

```powershell
python -m pytest tests/test_component4_worker_protocol.py tests/test_component4_cli.py -q
```

## Task 4: Make C3 Extension a Real Polling Worker

Files: modify `executioner/manifest.json`, `executioner/src/background.js`, `executioner/src/shared/api.js`, `executioner/src/shared/storage.js`, `executioner/src/ats/registry.js`, `tests/test_component3_stage1.py`; create `executioner/fixtures/generic_apply.html` and a browser smoke script.

- [ ] Step 1: Fix current C3 formatting first.

```powershell
python quality.py c3
```

- [ ] Step 2: Add settings model for backend URL, service token, polling flag, interval, and active lease id.

- [ ] Step 3: Add MV3 `chrome.alarms` polling.

Required behavior:

- One active lease at a time.
- Claim from C4.
- Open/focus apply tab.
- Fill page through existing adapter.
- Post result to C4.
- Clear active lease.

- [ ] Step 4: Add Playwright persistent-context smoke for local fixture.

```powershell
python smoke.py c3
```

- [ ] Step 5: Run tests.

```powershell
python quality.py c3
python test.py c3
```

## Task 5: OpenClaw Worker Pilot

Files: create `docs/C4_OPENCLAW_RUNBOOK.md`, `coordinator/agents/openclaw/HUNT_C4_WORKER.md`, `scripts/c4_openclaw_smoke.ps1`, `scripts/c4_openclaw_smoke.sh`; update `docs/C4_COORDINATOR.md`.

Checkpoint implemented on 2026-05-05: shared runtime launcher exists as `coordinator/agent_worker.py`; OpenClaw worker notes exist in `coordinator/agents/openclaw/HUNT_C4_WORKER.md`; wrapper scripts exist as `scripts/c4_openclaw_worker.ps1` and `scripts/c4_openclaw_worker.sh`; runbook exists as `docs/C4_OPENCLAW_RUNBOOK.md`. Remaining pilot gap: launch OpenClaw against a safe browser fixture and record evidence.

- [ ] Step 1: Document install and minimum config.

Windows native and WSL2/Linux commands:

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
openclaw doctor
openclaw browser --browser-profile openclaw status
```

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw doctor
openclaw browser --browser-profile openclaw status
```

- [ ] Step 2: Define two browser lanes.

```json
{
  "browser": {
    "enabled": true,
    "defaultProfile": "openclaw",
    "profiles": {
      "openclaw": { "cdpPort": 18800 },
      "user": { "driver": "existing-session", "attachOnly": true }
    }
  }
}
```

- [ ] Step 3: Write the worker instruction file.

Required worker behavior:

- Claim one C4 fill by HTTP.
- Use only the claimed payload.
- Navigate to `applyUrl`.
- Fill known fields.
- Upload resume from `selectedResumeDataUrl` when possible.
- Stop before final submit.
- Post `status`, `finalUrl`, `resumeUploadOk`, `generatedAnswersUsed`, `missingRequiredFields`, `lowConfidenceAnswers`, `manualReviewFlags`, and `evidence`.

- [ ] Step 4: Add fixture smoke.

```powershell
.\scripts\c4_openclaw_smoke.ps1 -BaseUrl http://127.0.0.1:18080 -Runtime openclaw_isolated
```

```bash
./scripts/c4_openclaw_smoke.sh --base-url http://127.0.0.1:18080 --runtime openclaw_isolated
```

- [ ] Step 5: Record pilot result in docs.

Success criteria:

- One local fixture claim.
- Browser evidence captured.
- C4 run reaches `awaiting_submit_approval`.
- No direct DB access from OpenClaw.

## Task 6: Hermes Worker Pilot

Files: create `docs/C4_HERMES_RUNBOOK.md`, `coordinator/agents/hermes/HUNT_C4_WORKER.md`, `scripts/c4_hermes_smoke.sh`; update `docs/C4_COORDINATOR.md`.

Checkpoint implemented on 2026-05-05: shared runtime launcher exists as `coordinator/agent_worker.py`; Hermes worker notes exist in `coordinator/agents/hermes/HUNT_C4_WORKER.md`; wrapper scripts exist as `scripts/c4_hermes_worker.ps1` and `scripts/c4_hermes_worker.sh`; runbook exists as `docs/C4_HERMES_RUNBOOK.md`. Remaining pilot gap: launch Hermes from Linux/WSL2 against a safe browser fixture and record evidence.

- [ ] Step 1: Document supported platforms.

Use Linux or WSL2 on Windows:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
hermes doctor
hermes setup tools
```

- [ ] Step 2: Configure runtime backend.

Preferred for server worker:

```yaml
terminal:
  backend: docker
  container_persistent: true
  docker_forward_env: []
```

Alternative for server2:

```yaml
terminal:
  backend: ssh
```

- [ ] Step 3: Add Hermes worker instruction file with same C4 lease protocol as OpenClaw.

- [ ] Step 4: Add fixture smoke.

```bash
./scripts/c4_hermes_smoke.sh --base-url http://127.0.0.1:18080 --runtime hermes_local
```

- [ ] Step 5: Record pilot result in docs.

Success criteria:

- One local fixture claim.
- C4 run reaches `awaiting_submit_approval`.
- Hermes uses HTTP only, no DB credentials.
- Native Windows is documented as unsupported; Windows machines use WSL2.

## Task 7: Long-Running Scheduler and Caps

Files: modify `coordinator/service.py`, `coordinator/cli.py`, `coordinator/service_api.py`, `schema/postgres_schema.sql`, `tests/test_component4_worker_protocol.py`, `docs/C4_COORDINATOR.md`.

- [ ] Step 1: Add settings.

```text
C4_MAX_ACTIVE_RUNS=1
C4_DAILY_APPLICATION_CAP=10
C4_PER_COMPANY_DAILY_CAP=1
C4_QUIET_HOURS_LOCAL=22:00-07:00
C4_FILL_TIMEOUT_MINUTES=30
C4_SUBMIT_CONFIRM_TIMEOUT_MINUTES=120
```

- [ ] Step 2: Enforce caps in `pick_next_job()`.

- [ ] Step 3: Add run reasons.

```text
daily_cap_reached
company_cap_reached
quiet_hours
active_run_in_progress
global_manual_review_hold
no_ready_jobs
```

- [ ] Step 4: Add CLI command.

```powershell
python -m coordinator.cli daemon --interval-seconds 300 --runtime openclaw_isolated
```

- [ ] Step 5: Add Linux systemd and Windows Task Scheduler runbooks after daemon tests pass.

## Task 8: C0 Operator Validation

Files: modify frontend C4 pages and backend gateway only where tests prove a gap; update `tests/test_frontend_jobs_ui.py` and C0 API tests.

- [ ] Step 1: Validate C4 pages against a real run:

```text
run queue
run detail
event log
approval queue
manual review reason
worker heartbeat/lease status
```

- [ ] Step 2: Add missing gateway routes for new C4 APIs.

- [ ] Step 3: Add frontend tests for route presence and API calls.

```powershell
python test.py c0
```

## Task 9: Live ATS Proof

Files: update `docs/C4_COORDINATOR.md`, `docs/C1_LOCAL_RUNBOOK.md`, `docs/TODO.md`, and smoke scripts as needed.

- [ ] Step 1: Run local fixture through C3.
- [ ] Step 2: Run local fixture through OpenClaw isolated browser.
- [ ] Step 3: Run local fixture through Hermes WSL2/Linux.
- [ ] Step 4: Pick one real external apply URL that is safe to stop at review.
- [ ] Step 5: Confirm final submit gate blocks submission.
- [ ] Step 6: Approve or deny in C4 and verify artifacts.

Evidence required:

- Screenshot or HTML evidence.
- `fill_result.json`.
- `browser_summary.json`.
- `decisions.json`.
- C4 event log.
- Operator decision.

## Final Verification

Run this before claiming C4 work is complete:

```powershell
python test.py c4
python test.py c3
python test.py c0
python quality.py c4
python quality.py c3
python smoke.py c4
```

For runtime pilots:

```powershell
python smoke.py c4 --existing
.\scripts\c4_openclaw_smoke.ps1 -BaseUrl http://127.0.0.1:18080 -Runtime openclaw_isolated
```

```bash
python smoke.py c4 --existing
./scripts/c4_openclaw_smoke.sh --base-url http://127.0.0.1:18080 --runtime openclaw_isolated
./scripts/c4_hermes_smoke.sh --base-url http://127.0.0.1:18080 --runtime hermes_local
```

## Execution Handoff

Preferred execution path: inline execution for Tasks 1 to 3 because the current C4 API and state machine are tightly coupled.

Use subagent-driven development only after Task 3 if splitting into independent tracks:

- Agent 1: C3 polling worker and fixture smoke.
- Agent 2: OpenClaw runbook and smoke.
- Agent 3: Hermes runbook and smoke.
- Agent 4: C0 operator validation.
