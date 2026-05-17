# C4 Hermes Worker Runbook

Goal: use Hermes Agent as a bounded C4 investigation worker when C3 reports a novel failure or unknown widget. Hermes observes the blocking page and produces a structured investigation report. It does not fill forms or submit applications.

Preferred for Linux, WSL2, and server2. Use OpenClaw first for Windows-local investigation.

Shared worker contract: `docs/C4_AGENT_WORKERS.md`.

## Current Status

Implemented:

- `python -m coordinator.agent_worker --runtime hermes_local`
- `python -m coordinator.agent_worker --runtime hermes_server`
- PowerShell wrapper: `scripts/c4_hermes_worker.ps1`
- Bash wrapper: `scripts/c4_hermes_worker.sh`
- Prompt/result artifacts under `.runtime/c4-agent/<runtime>/<lease_id>/`
- Local Windows Hermes install: `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe`; override with `HUNT_HERMES_COMMAND`.

Not proven yet:

- A live Hermes investigation run against a real ATS failure page.

## Platform Notes

- Hermes native Windows is early beta. Use WSL2 on Windows for first proof work.
- For server2/Linux: `hermes_server` with Docker or SSH terminal backend.
- Hermes browser backends: local Chrome CDP, `agent-browser`, Browserbase, Browser Use, Firecrawl, Camofox.

## Local Windows Setup

- Hermes executable: `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe`
- Hermes config: `%USERPROFILE%\.hermes\config.yaml`

Minimal local config for Ollama (protocol testing only):

```yaml
model:
  provider: custom
  default: gemma4:26b
  base_url: http://localhost:11434/v1
  api_key: ""
  context_length: 65536
```

For investigation work use a capable model, not local Ollama. Set `HUNT_C4_LLM_PROVIDER=codex_oauth`.

If Hermes is installed elsewhere:

```powershell
$env:HUNT_HERMES_COMMAND = "C:\path\to\hermes.exe"
```

## Runtime Choices

- `hermes_local`: local Linux/WSL2 worker.
- `hermes_server`: server2/Linux, preferably with Docker or SSH backend.

## Claim and Prepare One Investigation Lease

```bash
export HUNT_COORDINATOR_BASE_URL="http://127.0.0.1:8003"
export HUNT_SERVICE_TOKEN="<token>"
```

Prepare artifacts without launching Hermes:

```bash
RUNTIME=hermes_local ./scripts/c4_hermes_worker.sh
```

Review generated artifacts:

```text
.runtime/c4-agent/hermes_local/<lease_id>/prompt.md
.runtime/c4-agent/hermes_local/<lease_id>/claim.json
.runtime/c4-agent/hermes_local/<lease_id>/result_template.json
```

## Execute One Investigation Turn

Only after reviewing the prompt:

```bash
RUNTIME=hermes_local ./scripts/c4_hermes_worker.sh --execute-agent
```

The launcher heartbeats while Hermes runs. Hermes observes the failure page, documents findings, posts one investigation result, and stops.

## LLM Provider Routing

Investigation requires a capable model. Recommended: Codex OAuth (ChatGPT subscription).

```bash
export HUNT_C4_LLM_PROVIDER=codex_oauth
RUNTIME=hermes_local ./scripts/c4_hermes_worker.sh --execute-agent
```

Hunt maps `codex_oauth` → Hermes provider `openai-codex`. For local Ollama (protocol testing only), Hunt maps `ollama` → Hermes provider `custom`.

```bash
# Protocol testing only, not investigation.
export HUNT_LLM_PROVIDER=ollama
RUNTIME=hermes_local ./scripts/c4_hermes_worker.sh --mock-result
```

## Safe Protocol Test

Proves the lease/result path without launching a browser:

```bash
RUNTIME=hermes_local ./scripts/c4_hermes_worker.sh --mock-result
```

## Guardrails

- No DB credentials go to Hermes.
- Agent opens only the investigation URL.
- Agent does not fill any application fields.
- Agent does not click submit, apply, or complete.
- Agent stops after posting one investigation result.
- Use WSL2 on Windows for this lane until native Windows beta is proven.
