# C4 Hermes Worker Runbook

Goal: use Hermes Agent as a bounded Hunt C4 fill worker while C4 keeps the durable lease, result, and submit gate.

Shared worker contract: `docs/C4_AGENT_WORKERS.md`.

## Current Status

Implemented:

- `python -m coordinator.agent_worker --runtime hermes_local`
- `python -m coordinator.agent_worker --runtime hermes_server`
- PowerShell wrapper: `scripts/c4_hermes_worker.ps1`
- Bash wrapper: `scripts/c4_hermes_worker.sh`
- Prompt/result artifacts under `.runtime/c4-agent/<runtime>/<lease_id>/`

Not proven yet:

- A live Hermes-controlled browser filling a fixture or ATS page.

## Platform Notes

Research checked on 2026-05-05:

- Hermes CLI supports non-interactive one-shot mode with `hermes chat -q "Hello"` and `--toolsets`: https://hermes-agent.nousresearch.com/docs/user-guide/cli
- Hermes README states native Windows is not supported and Windows operators should use WSL2: https://github.com/NousResearch/hermes-agent
- Hermes browser automation supports Browserbase, Browser Use, Firecrawl, Camofox, local Chrome via CDP, and local `agent-browser`: https://hermes-agent.nousresearch.com/docs/user-guide/features/browser
- Hermes security docs cover approvals, hardline blocklists, and isolation boundaries: https://hermes-agent.nousresearch.com/docs/user-guide/security

Use Hermes on Linux, WSL2, or server2. For a Windows workstation, run the Hermes lane from WSL2.

## Runtime Choices

- `hermes_local`: local Linux/WSL2 worker.
- `hermes_server`: server2 or other Linux worker, preferably with Docker or SSH terminal backend.

## Claim and Prepare One Lease

Set the C4 service location and token:

```bash
export HUNT_COORDINATOR_BASE_URL="http://127.0.0.1:8003"
export HUNT_SERVICE_TOKEN="<token>"
```

Prepare one Hermes worker turn without launching Hermes:

```bash
RUNTIME=hermes_local ./scripts/c4_hermes_worker.sh
```

Review:

```text
.runtime/c4-agent/hermes_local/<lease_id>/prompt.md
.runtime/c4-agent/hermes_local/<lease_id>/claim.json
.runtime/c4-agent/hermes_local/<lease_id>/result_template.json
```

## Execute One Agent Turn

Only after reviewing the generated prompt:

```bash
RUNTIME=hermes_local ./scripts/c4_hermes_worker.sh --execute-agent
```

The launcher heartbeats while the external process is running. The agent prompt instructs Hermes to post exactly one result and stop.

## Safe Protocol Test

This proves the C4 lease/result path without browser automation:

```bash
RUNTIME=hermes_local ./scripts/c4_hermes_worker.sh --mock-result
```

Do not count `--mock-result` as browser proof.

## Guardrails

- No DB credentials go to Hermes.
- The prompt says to use the claimed `apply_url` only.
- The prompt says not to click final submit.
- The prompt says to stop after posting `/workers/{lease_id}/result`.
- Native Windows should use WSL2 for this lane.
