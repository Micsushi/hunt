# C4 Agent Workers

C4 uses agent workers (Hermes, OpenClaw) for two bounded tasks: investigating novel ATS failures that C3 cannot handle, and attempting CAPTCHA fallback when no extension is available. Agents do not fill application forms. C3 owns all fill work.

## When Agents Are Triggered

**Investigation trigger:** C3 returns `unknown_widget` or a novel failure code that C4 does not have a hardcoded handler for. C4 queues the run for investigation.

**CAPTCHA fallback trigger:** C3 reports a CAPTCHA failure code and no CAPTCHA extension is available or the extension failed. Agent attempts to solve it. If the agent fails, C4 escalates to Telegram.

Agents are never triggered for normal fill work. If C3 fills successfully, no agent is involved.

## Investigation Worker Contract

The agent receives a bounded investigation prompt containing:

- Job details: company, title, apply URL.
- C3 failure context: failure code, unknown widget details (selector, role, label, HTML excerpt).
- Instructions to observe the page and produce a structured report.
- The result endpoint to POST to when done.

The agent must:

1. Open only the claimed `apply_url`.
2. Navigate to the page state where C3 failed if possible.
3. Observe the blocking element: selector, role, label, HTML, framework hints.
4. Take at least one screenshot.
5. Capture an HTML snapshot of the relevant section.
6. Write `agent_findings` (freetext: what it observed) and `suggested_fix_area` (which part of C3 code would fix it).
7. POST the investigation result to C4.
8. Stop.

The agent must not:

- Fill any application field.
- Click any submit, apply, or complete button.
- Interact with Hunt's database.
- Browse unrelated pages, search for jobs, send messages, or email anyone.
- Invent findings. If the page state cannot be reached, report `inconclusive`.

## Investigation Result Schema

```json
{
  "status": "complete | inconclusive | access_blocked | captcha_blocked",
  "failure_code_confirmed": "unknown_widget | captcha_hcaptcha | ...",
  "page_observed": "URL of the page where the issue was found",
  "widget_details": {
    "selector": "CSS or ARIA selector",
    "role": "ARIA role or element type",
    "label": "visible label text",
    "html_excerpt": "relevant HTML snippet",
    "framework_hints": "React, Vue, Workday, Oracle, etc."
  },
  "agent_findings": "freetext: what the agent saw and why C3 likely failed",
  "suggested_fix_area": "e.g. generic V2 option collection, Workday listbox driver",
  "screenshots": ["path/to/screenshot.png"],
  "html_snapshot": "path/to/snapshot.html",
  "notes": ""
}
```

C4 merges these fields into the run's `failure_report.json` and appends to `logs/failures.jsonl`.

## CAPTCHA Worker Contract

The agent receives a CAPTCHA-specific prompt containing:

- The apply URL.
- CAPTCHA type (hCaptcha, reCAPTCHA, Cloudflare, unknown).
- A screenshot of the CAPTCHA if available.
- Instructions to attempt solving only the CAPTCHA and report result.

The agent must not fill any other fields or navigate beyond the CAPTCHA page.

If the agent cannot solve the CAPTCHA, it returns `status: failed` and C4 escalates to the operator via Telegram.

## Worker Lanes

- `openclaw_isolated`: OpenClaw isolated browser profile. First choice for investigation on Windows.
- `openclaw_attached`: OpenClaw attached user browser. Only after isolated proof.
- `hermes_local`: Hermes local or WSL2. Use for Linux/server2 investigation.
- `hermes_server`: Hermes server2/Linux worker.

## HTTP Contract

All routes require `Authorization: Bearer $HUNT_SERVICE_TOKEN` when configured.

Claim one investigation lease:

```http
POST /workers/claim
Content-Type: application/json

{
  "runtime_name": "openclaw_isolated",
  "browser_lane": "isolated",
  "lease_seconds": 600,
  "worker_metadata": {
    "launcher": "coordinator.agent_worker",
    "task": "investigation"
  }
}
```

Heartbeat:

```http
POST /workers/{lease_id}/heartbeat
Content-Type: application/json

{ "lease_seconds": 600 }
```

Post investigation result:

```http
POST /workers/{lease_id}/result
Content-Type: application/json

{
  "payload": {
    "status": "complete",
    "failure_code_confirmed": "unknown_widget",
    "page_observed": "https://example.com/apply/step2",
    "widget_details": { ... },
    "agent_findings": "...",
    "suggested_fix_area": "...",
    "screenshots": [],
    "html_snapshot": ""
  }
}
```

Reconcile stale:

```http
POST /maintenance/reconcile-stale
Content-Type: application/json

{ "fill_timeout_minutes": 30 }
```

## One-Shot Launcher

```powershell
python -m coordinator.agent_worker --runtime openclaw_isolated
python -m coordinator.agent_worker --runtime hermes_local
```

Artifacts written under:

```text
.runtime/c4-agent/<runtime>/<lease_id>/claim.json
.runtime/c4-agent/<runtime>/<lease_id>/prompt.md
.runtime/c4-agent/<runtime>/<lease_id>/result_template.json
```

Protocol-only test without launching a browser:

```powershell
python -m coordinator.agent_worker --runtime openclaw_isolated --mock-result
```

Execute with agent:

```powershell
python -m coordinator.agent_worker --runtime openclaw_isolated --execute-agent
python -m coordinator.agent_worker --runtime hermes_local --execute-agent
```

## Model Requirements

Investigation and CAPTCHA work requires a capable model. Local small models (under 30B) are not reliable for:

- Multi-step page navigation with state tracking.
- Accurate structural observation and reporting.
- Recognizing when to stop vs continue.

Recommended: GPT-4o via ChatGPT/Codex OAuth (no API billing with ChatGPT Plus subscription).

```powershell
$env:HUNT_C4_LLM_PROVIDER = "codex_oauth"
```

Local Ollama is suitable for testing the lease/heartbeat/result protocol only.

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

`no_pending_fills`: no investigation is queued. Trigger one manually with `POST /runs/{run_id}/investigate` or queue a test run.

`401`: export the same `HUNT_SERVICE_TOKEN` used by the C4 service.

`Worker lease has expired`: reconcile stale and claim again.

`openclaw` or `hermes` not found: install the runtime or run without `--execute-agent` to inspect artifacts only.

## Verification

```powershell
python test.py c4
python smoke.py c4
```
