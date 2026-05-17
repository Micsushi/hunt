# C4 OpenClaw Worker Runbook

Goal: use OpenClaw as a bounded C4 investigation worker when C3 reports a novel failure or unknown widget. OpenClaw observes the blocking page and produces a structured investigation report. It does not fill forms or submit applications.

Shared worker contract: `docs/C4_AGENT_WORKERS.md`.

## Current Status

Implemented:

- `python -m coordinator.agent_worker --runtime openclaw_isolated`
- `python -m coordinator.agent_worker --runtime openclaw_attached`
- PowerShell wrapper: `scripts/c4_openclaw_worker.ps1`
- Bash wrapper: `scripts/c4_openclaw_worker.sh`
- Prompt/result artifacts under `.runtime/c4-agent/<runtime>/<lease_id>/`

Not proven yet:

- A live OpenClaw investigation run against a real ATS failure page.

## Runtime Choices

- `openclaw_isolated`: first choice, isolated browser profile.
- `openclaw_attached`: only after isolated proof passes, for signed-in profile access.

## Setup Notes

- OpenClaw agent CLI: `openclaw agent --agent <id> --message <prompt> --local`
- OpenClaw sandbox: Docker, SSH, and OpenShell isolation, `openclaw sandbox explain/list/recreate`
- OpenClaw agents separated by workspace and agent id

Recommended before live work:

```powershell
openclaw doctor
openclaw agents list
openclaw sandbox explain --json
```

## Claim and Prepare One Investigation Lease

```powershell
$env:HUNT_COORDINATOR_BASE_URL = "http://127.0.0.1:8003"
$env:HUNT_SERVICE_TOKEN = "<token>"
```

Prepare artifacts without launching OpenClaw:

```powershell
.\scripts\c4_openclaw_worker.ps1 -Runtime openclaw_isolated
```

```bash
RUNTIME=openclaw_isolated ./scripts/c4_openclaw_worker.sh
```

Review generated artifacts:

```text
.runtime/c4-agent/openclaw_isolated/<lease_id>/prompt.md
.runtime/c4-agent/openclaw_isolated/<lease_id>/claim.json
.runtime/c4-agent/openclaw_isolated/<lease_id>/result_template.json
```

## Execute One Investigation Turn

Only after reviewing the prompt:

```powershell
.\scripts\c4_openclaw_worker.ps1 -Runtime openclaw_isolated -ExecuteAgent
```

```bash
RUNTIME=openclaw_isolated ./scripts/c4_openclaw_worker.sh --execute-agent
```

The launcher heartbeats while the external process runs. OpenClaw observes the failure page, documents findings, posts one investigation result, and stops.

## Safe Protocol Test

Proves the lease/result path without launching a browser:

```powershell
.\scripts\c4_openclaw_worker.ps1 -Runtime openclaw_isolated -MockResult
```

## LLM Provider

Investigation requires a capable model. Use ChatGPT/Codex OAuth:

```powershell
$env:HUNT_C4_LLM_PROVIDER = "codex_oauth"
```

## Guardrails

- No DB credentials go to OpenClaw.
- Agent opens only the investigation URL.
- Agent does not fill any application fields.
- Agent does not click submit, apply, or complete.
- Agent stops after posting one investigation result.
- Use `openclaw_isolated` before `openclaw_attached`.
