# C4 OpenClaw Worker Runbook

Goal: use OpenClaw as a bounded Hunt C4 fill worker while C4 keeps the durable lease, result, and submit gate.

Shared worker contract: `docs/C4_AGENT_WORKERS.md`.

## Current Status

Implemented:

- `python -m coordinator.agent_worker --runtime openclaw_isolated`
- `python -m coordinator.agent_worker --runtime openclaw_attached`
- PowerShell wrapper: `scripts/c4_openclaw_worker.ps1`
- Bash wrapper: `scripts/c4_openclaw_worker.sh`
- Prompt/result artifacts under `.runtime/c4-agent/<runtime>/<lease_id>/`

Not proven yet:

- A live OpenClaw-controlled browser filling a fixture or ATS page.

## Runtime Choices

- `openclaw_isolated`: first choice for fixtures and first live proof.
- `openclaw_attached`: later choice for a signed-in browser profile after isolated proof passes.

## Setup Notes

Research checked on 2026-05-05:

- OpenClaw agent CLI supports local one-turn execution via `openclaw agent --agent <id> --message <prompt> --local`: https://docs.openclaw.ai/cli/agent
- OpenClaw sandbox docs cover Docker, SSH, and OpenShell isolation plus `openclaw sandbox explain/list/recreate`: https://docs.openclaw.ai/cli/sandbox
- OpenClaw agents can be separated by workspace and agent id: https://docs.openclaw.ai/cli/agents

Recommended before live work:

```powershell
openclaw doctor
openclaw agents list
openclaw sandbox explain --json
```

## Claim and Prepare One Lease

Set the C4 service location and token:

```powershell
$env:HUNT_COORDINATOR_BASE_URL = "http://127.0.0.1:8003"
$env:HUNT_SERVICE_TOKEN = "<token>"
```

Prepare one OpenClaw worker turn without launching OpenClaw:

```powershell
.\scripts\c4_openclaw_worker.ps1 -Runtime openclaw_isolated
```

Bash equivalent:

```bash
RUNTIME=openclaw_isolated ./scripts/c4_openclaw_worker.sh
```

Review:

```text
.runtime/c4-agent/openclaw_isolated/<lease_id>/prompt.md
.runtime/c4-agent/openclaw_isolated/<lease_id>/claim.json
.runtime/c4-agent/openclaw_isolated/<lease_id>/result_template.json
```

## Execute One Agent Turn

Only after reviewing the generated prompt:

```powershell
.\scripts\c4_openclaw_worker.ps1 -Runtime openclaw_isolated -ExecuteAgent
```

Bash equivalent:

```bash
RUNTIME=openclaw_isolated ./scripts/c4_openclaw_worker.sh --execute-agent
```

The launcher heartbeats while the external process is running. The agent prompt instructs OpenClaw to post exactly one result and stop.

## Safe Protocol Test

This proves the C4 lease/result path without browser automation:

```powershell
.\scripts\c4_openclaw_worker.ps1 -Runtime openclaw_isolated -MockResult
```

Do not count `-MockResult` as browser proof.

## Guardrails

- No DB credentials go to OpenClaw.
- The prompt says to use the claimed `apply_url` only.
- The prompt says not to click final submit.
- The prompt says to stop after posting `/workers/{lease_id}/result`.
- Use `openclaw_isolated` before `openclaw_attached`.
