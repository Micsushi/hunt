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
- Local Windows Hermes install detected through `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe`; override with `HUNT_HERMES_COMMAND` if needed.

Not proven yet:

- A live Hermes-controlled browser filling a fixture or ATS page.

## Platform Notes

Research checked on 2026-05-05:

- Hermes CLI supports non-interactive one-shot mode with `hermes chat -q "Hello"` and `--toolsets`: https://hermes-agent.nousresearch.com/docs/user-guide/cli
- Hermes native Windows support is early beta; WSL2 remains the safer path for Hunt proof work: https://hermes-agent.nousresearch.com/docs/user-guide/windows-native
- Hermes browser automation supports Browserbase, Browser Use, Firecrawl, Camofox, local Chrome via CDP, and local `agent-browser`: https://hermes-agent.nousresearch.com/docs/user-guide/features/browser
- Hermes security docs cover approvals, hardline blocklists, and isolation boundaries: https://hermes-agent.nousresearch.com/docs/user-guide/security

Use Hermes on Linux, WSL2, or server2. For a Windows workstation, run the Hermes lane from WSL2 unless intentionally testing the native Windows beta.

## Local Windows Setup Notes

Current local setup:

- Hermes repo: `%LOCALAPPDATA%\hermes\hermes-agent`
- Hermes executable: `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe`
- Hermes config: `%USERPROFILE%\.hermes\config.yaml`
- Local provider: Hermes `custom` provider pointed at Ollama's OpenAI-compatible API: `http://localhost:11434/v1`
- Hunt provider value: `ollama`; C4 maps this to Hermes provider `custom`

Minimal Hermes local config:

```yaml
model:
  provider: custom
  default: gemma4:26b
  base_url: http://localhost:11434/v1
  api_key: ""
  context_length: 65536
```

If Hermes is installed elsewhere:

```powershell
$env:HUNT_HERMES_COMMAND = "C:\path\to\hermes.exe"
```

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

## LLM Provider Routing

Hermes worker model selection follows the shared Hunt LLM env contract:

```bash
export HUNT_LLM_PROVIDER=ollama
export HUNT_C4_LLM_PROVIDER=codex_oauth
export HUNT_C4_LLM_MODEL=gpt-5.3-codex
```

Precedence is `--llm-provider`, `HUNT_C4_LLM_PROVIDER`, `HUNT_LLM_PROVIDER`, then local Ollama. Hunt maps `codex` / `codex_oauth` to Hermes provider `openai-codex`. `anthropic`, `gemini`, and `openrouter` remain API-key or Hermes-configured provider lanes.
For local Ollama, Hunt maps `ollama` to Hermes provider `custom` because Hermes configures Ollama as an OpenAI-compatible custom endpoint.

Examples:

```bash
# Everyone local by default.
export HUNT_LLM_PROVIDER=ollama

# Only C4 Hermes uses ChatGPT/Codex OAuth.
export HUNT_C4_LLM_PROVIDER=codex_oauth
RUNTIME=hermes_local ./scripts/c4_hermes_worker.sh --execute-agent

# One-off override.
python -m coordinator.agent_worker --runtime hermes_local --llm-provider openrouter --llm-model openai/gpt-5.3-codex
```

PowerShell:

```powershell
.\scripts\c4_hermes_worker.ps1 -Runtime hermes_local -LlmProvider ollama -LlmModel gemma4:26b
```

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
