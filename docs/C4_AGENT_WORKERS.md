# C4 Agent Workers

This is the operator contract for C3, OpenClaw, and Hermes workers.

C4 owns the job/run state, leases, evidence, manual-review routing, and final submit gate. Workers own exactly one browser fill attempt at a time.

## Proven vs Not Proven

Proven:

- C4 can create a run, request fill, lease the fill to one worker, receive heartbeats, record a result, recover stale leases, and keep submit human-gated.
- `python test.py c4` covers the worker lease API and the OpenClaw/Hermes prompt launcher.
- `python smoke.py c4` covers the Postgres-backed C4 API flow without direct DB mutation.

Not proven yet:

- Live C3 extension polling and filling a browser page.
- Live OpenClaw browser fill.
- Live Hermes browser fill.
- Live ATS proof with screenshot/HTML evidence.

## Worker Lanes

Use these runtime names in C4:

- `c3_extension`: Chrome extension bridge.
- `openclaw_isolated`: OpenClaw with an isolated browser profile. Use this first.
- `openclaw_attached`: OpenClaw attached to a signed-in user browser. Use only after isolated proof.
- `hermes_local`: Hermes on Linux or WSL2.
- `hermes_server`: Hermes on server2/Linux, preferably with Docker or SSH backend.

Hermes is not a native Windows lane. On Windows, use WSL2 for Hermes.

## Safe Worker Lifecycle

```text
run is apply_prepared
  -> operator or scheduler requests fill
  -> worker claims exactly one fill
  -> worker opens only the claimed apply URL
  -> worker heartbeats while active
  -> worker fills only grounded fields
  -> worker stops before final submit
  -> worker posts one normalized result
  -> C4 decides awaiting_submit_approval, manual_review, or failed
```

Hard rules:

- No worker gets DB credentials.
- No worker claims a second lease after finishing one result.
- No worker clicks final submit.
- No worker browses unrelated jobs, messages people, sends email, or edits Hunt data outside the worker artifact folder.
- CAPTCHA, MFA, OTP, login trouble, account lock, hostname drift, unsupported page state, low-confidence required answers, and missing required fields become manual review.

## HTTP Contract

All routes require `Authorization: Bearer $HUNT_SERVICE_TOKEN` when `HUNT_SERVICE_TOKEN` is configured.

Request fill:

```http
POST /runs/{run_id}/request-fill
```

Claim one fill:

```http
POST /workers/claim
Content-Type: application/json

{
  "runtime_name": "openclaw_isolated",
  "browser_lane": "isolated",
  "lease_seconds": 900,
  "worker_metadata": {
    "launcher": "coordinator.agent_worker"
  }
}
```

Heartbeat:

```http
POST /workers/{lease_id}/heartbeat
Content-Type: application/json

{
  "lease_seconds": 900
}
```

Complete with result:

```http
POST /workers/{lease_id}/result
Content-Type: application/json

{
  "payload": {
    "status": "ok",
    "resumeUploadOk": true,
    "generatedAnswersUsed": false,
    "finalUrl": "https://example.com/apply/review",
    "missingRequiredFields": [],
    "lowConfidenceAnswers": [],
    "manualReviewFlags": [],
    "evidence": {
      "stoppedBeforeSubmit": true,
      "notes": "",
      "screenshots": [],
      "htmlSnapshots": []
    }
  }
}
```

Reconcile stale work:

```http
POST /maintenance/reconcile-stale
Content-Type: application/json

{
  "fill_timeout_minutes": 30,
  "submit_confirm_timeout_minutes": 120
}
```

## Result Statuses

Use `ok` when the fill reached a safe review/submit page or went as far as safely possible without intervention.

Use `manual_review` when the operator must intervene, including login, CAPTCHA, MFA, missing required fields, unsupported widgets, hostname drift, or low-confidence required answers.

Use `failed` for runtime or browser failures that cannot be recovered by the worker.

C4 will route:

- `ok` with no review flags: `awaiting_submit_approval`
- `manual_review` or any review flags: `manual_review`
- `failed`: `failed`

## One-Shot Launcher

The launcher claims one lease and writes artifacts. It does not launch OpenClaw or Hermes unless `--execute-agent` is present.

```powershell
python -m coordinator.agent_worker --runtime openclaw_isolated
python -m coordinator.agent_worker --runtime hermes_local
```

Artifacts:

```text
.runtime/c4-agent/<runtime>/<lease_id>/claim.json
.runtime/c4-agent/<runtime>/<lease_id>/prompt.md
.runtime/c4-agent/<runtime>/<lease_id>/result_template.json
```

Safe protocol-only completion:

```powershell
python -m coordinator.agent_worker --runtime openclaw_isolated --mock-result
```

External agent execution:

```powershell
python -m coordinator.agent_worker --runtime openclaw_isolated --execute-agent
```

## Wrapper Commands

OpenClaw:

```powershell
.\scripts\c4_openclaw_worker.ps1 -Runtime openclaw_isolated
.\scripts\c4_openclaw_worker.ps1 -Runtime openclaw_isolated -ExecuteAgent
```

```bash
RUNTIME=openclaw_isolated ./scripts/c4_openclaw_worker.sh
RUNTIME=openclaw_isolated ./scripts/c4_openclaw_worker.sh --execute-agent
```

Hermes:

```powershell
.\scripts\c4_hermes_worker.ps1 -Runtime hermes_local
```

```bash
RUNTIME=hermes_local ./scripts/c4_hermes_worker.sh
RUNTIME=hermes_local ./scripts/c4_hermes_worker.sh --execute-agent
```

## Troubleshooting

`no_pending_fills`: create or pick a run, then call `request-fill`.

`401`: export the same `HUNT_SERVICE_TOKEN` used by the C4 service.

`Worker lease has expired`: do not reuse the old prompt. Reconcile stale work and claim again.

`openclaw` or `hermes` command not found: install the runtime or run without `--execute-agent` to inspect artifacts only.

Native Windows plus Hermes: use WSL2. Hermes is not documented as native Windows-supported.

## Verification

Code-level verification:

```powershell
python test.py c4
python quality.py c4
python quality.py shared
```

Postgres/API smoke:

```powershell
python smoke.py c4
```

The smoke does not launch OpenClaw, Hermes, or a browser worker.
