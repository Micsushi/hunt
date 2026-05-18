from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from shared.llm.config import normalize_provider

from . import config as coordinator_config


@dataclass(frozen=True)
class AgentRuntimeSpec:
    """One selectable external agent runtime lane for C4 fill work."""

    name: str
    label: str
    engine: str
    default_browser_lane: str
    default_agent_name: str | None = None
    default_toolsets: str | None = None
    platform_note: str = ""


RUNTIME_SPECS: dict[str, AgentRuntimeSpec] = {
    "openclaw_isolated": AgentRuntimeSpec(
        name="openclaw_isolated",
        label="OpenClaw isolated browser",
        engine="openclaw",
        default_browser_lane="isolated",
        default_agent_name="hunt-c4-worker",
        platform_note="Use OpenClaw sandbox/browser isolation for fixture and first live pilots.",
    ),
    "openclaw_attached": AgentRuntimeSpec(
        name="openclaw_attached",
        label="OpenClaw attached user browser",
        engine="openclaw",
        default_browser_lane="attached",
        default_agent_name="hunt-c4-worker",
        platform_note="Use only after isolated fixture runs pass; attached profiles may hold real sessions.",
    ),
    "hermes_local": AgentRuntimeSpec(
        name="hermes_local",
        label="Hermes local or WSL2 worker",
        engine="hermes",
        default_browser_lane="isolated",
        default_toolsets="web,terminal,skills",
        platform_note="Hermes native Windows is early beta; use WSL2 on Windows for first proof work.",
    ),
    "hermes_server": AgentRuntimeSpec(
        name="hermes_server",
        label="Hermes Linux/server worker",
        engine="hermes",
        default_browser_lane="isolated",
        default_toolsets="web,terminal,skills",
        platform_note="Prefer Linux/server2 with Docker or SSH terminal backend.",
    ),
}

RUNTIME_ALIASES = {
    "openclaw": "openclaw_isolated",
    "openclaw-local": "openclaw_isolated",
    "openclaw-isolated": "openclaw_isolated",
    "openclaw-attached": "openclaw_attached",
    "hermes": "hermes_local",
    "hermes-local": "hermes_local",
    "hermes-server": "hermes_server",
}

HERMES_PROVIDER_ALIASES = {
    "ollama": "custom",
    "codex": "openai-codex",
    "openai": "openai",
    "openrouter": "openrouter",
    "anthropic": "anthropic",
    "gemini": "gemini",
}


class AgentRuntimeError(ValueError):
    pass


def normalize_runtime_choice(value: str) -> AgentRuntimeSpec:
    key = (value or "").strip().lower().replace(" ", "_")
    key = RUNTIME_ALIASES.get(key, key)
    spec = RUNTIME_SPECS.get(key)
    if spec is None:
        choices = ", ".join(sorted([*RUNTIME_SPECS, *RUNTIME_ALIASES]))
        raise AgentRuntimeError(f"Unknown C4 agent runtime `{value}`. Valid choices: {choices}")
    return spec


def runtime_choices() -> list[str]:
    return sorted(RUNTIME_SPECS)


def hermes_provider_name(provider: str | None) -> str:
    normalized = normalize_provider(provider)
    return HERMES_PROVIDER_ALIASES.get(normalized, normalized)


def _json_for_prompt(payload: Any) -> str:
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False)


def build_result_template(claim: dict[str, Any]) -> dict[str, Any]:
    fill = claim.get("fill") or {}
    return {
        "status": "complete",
        "failure_code_confirmed": fill.get("failure_code", ""),
        "page_observed": fill.get("apply_url", ""),
        "widget_details": {
            "selector": "",
            "role": "",
            "label": "",
            "html_excerpt": "",
            "framework_hints": "",
        },
        "agent_findings": "",
        "suggested_fix_area": "",
        "screenshots": [],
        "html_snapshot": "",
        "notes": "",
    }


def _claim_summary(claim: dict[str, Any]) -> dict[str, Any]:
    lease = claim.get("lease") or {}
    fill = claim.get("fill") or {}
    c3_payload = fill.get("c3_payload") or {}
    return {
        "lease_id": lease.get("lease_id"),
        "runtime_name": lease.get("runtime_name"),
        "browser_lane": lease.get("browser_lane"),
        "run_id": fill.get("run_id"),
        "job_id": fill.get("job_id"),
        "ats_type": fill.get("ats_type"),
        "apply_url": fill.get("apply_url"),
        "company": c3_payload.get("company"),
        "title": c3_payload.get("title"),
        "selected_resume_version_id": c3_payload.get("selectedResumeVersionId"),
        "selected_resume_pdf_path": c3_payload.get("selectedResumePdfPath"),
    }


def build_worker_prompt(
    *,
    base_url: str,
    claim: dict[str, Any],
    token_env_var: str = "HUNT_SERVICE_TOKEN",
    claim_path: str | Path | None = None,
    result_template_path: str | Path | None = None,
) -> str:
    lease = claim.get("lease") or {}
    lease_id = lease.get("lease_id")
    summary = _claim_summary(claim)
    claim_ref = str(claim_path) if claim_path else "the Claim JSON block below"
    result_ref = (
        str(result_template_path) if result_template_path else "the Result Template block below"
    )
    claim_block = "" if claim_path else f"\nClaim JSON:\n```json\n{_json_for_prompt(claim)}\n```\n"
    template = build_result_template(claim)
    template_block = (
        ""
        if result_template_path
        else f"\nResult Template:\n```json\n{_json_for_prompt(template)}\n```\n"
    )
    result_endpoint = f"{base_url.rstrip('/')}/workers/{lease_id}/result"
    heartbeat_endpoint = f"{base_url.rstrip('/')}/workers/{lease_id}/heartbeat"

    return f"""# Hunt C4 Investigation Worker

You are operating exactly one Hunt C4 investigation lease. A C3 automated fill attempt failed on this page. Your job is to observe what blocked it and produce a structured investigation report. You do not fill forms or submit applications.

Lease summary:
```json
{_json_for_prompt(summary)}
```

Inputs:
- Full claim payload: {claim_ref}
- Result template: {result_ref}
- Service token: read the bearer token from environment variable `{token_env_var}`. Do not print, store, or reveal the token.

Your task:
1. Open only the claimed `apply_url` in your browser.
2. Navigate to the page state where C3 failed if possible. The claim payload includes the failure code and any widget details C3 captured.
3. Observe the blocking element: its selector, ARIA role, visible label, HTML structure, and any JavaScript framework indicators (React, Vue, Workday, Oracle, etc.).
4. Take at least one screenshot of the blocking element or page state.
5. Capture an HTML snapshot of the relevant section.
6. Write `agent_findings`: freetext description of what you observed and why C3 likely failed.
7. Write `suggested_fix_area`: which part of the C3 codebase would need a new driver or fix (e.g. "generic V2 option collection", "Workday listbox driver", "Oracle segmented button group").
8. Heartbeat while working by POSTing JSON to `{heartbeat_endpoint}` with body `{{"lease_seconds": 600}}`.
9. Finish by POSTing JSON to `{result_endpoint}` with body `{{"payload": <result object>}}`.
10. Stop.

Hard stops:
- Do not fill any application field.
- Do not click any submit, apply, next, or complete button.
- Do not interact with Hunt's database.
- Do not browse unrelated pages, search for other jobs, send messages, or email anyone.
- Do not invent findings. If the page state cannot be reached, set `status` to `inconclusive` and explain why in `agent_findings`.

Result requirements:
- `status`: `complete` when you observed the page and produced findings; `inconclusive` when the page state could not be reached; `access_blocked` when login/MFA/CAPTCHA blocked access; `captcha_blocked` for CAPTCHA specifically.
- `failure_code_confirmed`: confirm or correct the failure code from the claim.
- `page_observed`: the URL of the page where you found the issue.
- `widget_details`: selector, role, label, html_excerpt, framework_hints.
- `agent_findings`: freetext of what you saw.
- `suggested_fix_area`: which C3 component to fix.
- `screenshots`: list of screenshot file paths.
- `html_snapshot`: path to HTML snapshot file.

After posting the result, stop. Do not claim another lease or continue to another job.
{claim_block}{template_block}"""


def build_captcha_result_template(claim: dict[str, Any]) -> dict[str, Any]:
    fill = claim.get("fill") or {}
    return {
        "status": "solved",
        "captcha_type": fill.get("failure_code", "captcha_unknown"),
        "page_observed": fill.get("apply_url", ""),
        "method_used": "",
        "screenshots": [],
        "notes": "",
    }


def build_captcha_prompt(
    *,
    base_url: str,
    claim: dict[str, Any],
    token_env_var: str = "HUNT_SERVICE_TOKEN",
    claim_path: str | Path | None = None,
    result_template_path: str | Path | None = None,
) -> str:
    lease = claim.get("lease") or {}
    lease_id = lease.get("lease_id")
    summary = _claim_summary(claim)
    fill = claim.get("fill") or {}
    captcha_type = fill.get("failure_code", "captcha_unknown")
    claim_ref = str(claim_path) if claim_path else "the Claim JSON block below"
    result_ref = (
        str(result_template_path) if result_template_path else "the Result Template block below"
    )
    claim_block = "" if claim_path else f"\nClaim JSON:\n```json\n{_json_for_prompt(claim)}\n```\n"
    template = build_captcha_result_template(claim)
    template_block = (
        ""
        if result_template_path
        else f"\nResult Template:\n```json\n{_json_for_prompt(template)}\n```\n"
    )
    result_endpoint = f"{base_url.rstrip('/')}/workers/{lease_id}/result"
    heartbeat_endpoint = f"{base_url.rstrip('/')}/workers/{lease_id}/heartbeat"

    return f"""# Hunt C4 CAPTCHA Worker

You are operating exactly one Hunt C4 CAPTCHA lease. A C3 automated fill attempt was blocked by a CAPTCHA on this page. Your job is to solve only the CAPTCHA and report the result. You do not fill application forms or submit applications.

Lease summary:
```json
{_json_for_prompt(summary)}
```

CAPTCHA type: {captcha_type}

Inputs:
- Full claim payload: {claim_ref}
- Result template: {result_ref}
- Service token: read the bearer token from environment variable `{token_env_var}`. Do not print, store, or reveal the token.

Your task:
1. Open only the claimed `apply_url` in your browser.
2. Navigate to the CAPTCHA challenge.
3. Attempt to solve the CAPTCHA ({captcha_type}).
4. Take a screenshot before and after your attempt.
5. Heartbeat while working by POSTing JSON to `{heartbeat_endpoint}` with body `{{"lease_seconds": 600}}`.
6. Finish by POSTing JSON to `{result_endpoint}` with body `{{"payload": <result object>}}`.
7. Stop.

Hard stops:
- Do not fill any application field.
- Do not click any submit, apply, next, or complete button.
- Do not interact with Hunt's database.
- Do not browse unrelated pages, search for other jobs, send messages, or email anyone.

Result requirements:
- `status`: `solved` if the CAPTCHA was solved successfully; `failed` if you could not solve it; `inconclusive` if the CAPTCHA was not present or the page state could not be reached.
- `captcha_type`: confirm or correct the CAPTCHA type.
- `page_observed`: the URL where you found the CAPTCHA.
- `method_used`: brief description of the approach used (e.g. "audio challenge", "image selection", "token injection").
- `screenshots`: list of screenshot file paths.
- `notes`: any additional context.

After posting the result, stop. Do not claim another lease or continue to another page.
{claim_block}{template_block}"""


def build_runtime_command(
    *,
    runtime_name: str,
    prompt: str,
    agent_name: str | None = None,
    toolsets: str | None = None,
    llm_provider: str | None = None,
    llm_model: str | None = None,
) -> list[str]:
    spec = normalize_runtime_choice(runtime_name)
    if spec.engine == "openclaw":
        return [
            "openclaw",
            "agent",
            "--agent",
            agent_name or spec.default_agent_name or "hunt-c4-worker",
            "--message",
            prompt,
            "--local",
        ]
    if spec.engine == "hermes":
        command = [
            coordinator_config.hermes_command(),
            "chat",
            "-q",
            prompt,
            "--quiet",
            "--ignore-rules",
            "--max-turns",
            coordinator_config.hermes_max_turns(),
        ]
        selected_provider = hermes_provider_name(llm_provider)
        if selected_provider:
            command.extend(["--provider", selected_provider])
        if llm_model:
            command.extend(["--model", llm_model])
        selected_toolsets = toolsets or spec.default_toolsets
        if selected_toolsets:
            command.extend(["--toolsets", selected_toolsets])
        return command
    raise AgentRuntimeError(f"Runtime `{spec.name}` has no command builder.")


def build_command_preview(
    *,
    runtime_name: str,
    prompt_path: str | Path,
    agent_name: str | None = None,
    toolsets: str | None = None,
    llm_provider: str | None = None,
    llm_model: str | None = None,
) -> dict[str, str]:
    spec = normalize_runtime_choice(runtime_name)
    prompt = str(prompt_path)
    if spec.engine == "openclaw":
        agent = agent_name or spec.default_agent_name or "hunt-c4-worker"
        return {
            "powershell": f'openclaw agent --agent {agent} --message (Get-Content -Raw "{prompt}") --local',
            "bash": f"openclaw agent --agent {agent} --message \"$(cat '{prompt}')\" --local",
        }
    if spec.engine == "hermes":
        selected_toolsets = toolsets or spec.default_toolsets or "web,terminal,skills"
        hermes = coordinator_config.hermes_command()
        max_turns = coordinator_config.hermes_max_turns()
        provider_args = ""
        selected_provider = hermes_provider_name(llm_provider)
        if selected_provider:
            provider_args += f' --provider "{selected_provider}"'
        if llm_model:
            provider_args += f' --model "{llm_model}"'
        return {
            "powershell": f'& "{hermes}" chat -q (Get-Content -Raw "{prompt}") --quiet --ignore-rules --max-turns {max_turns}{provider_args} --toolsets "{selected_toolsets}"',
            "bash": f'"{hermes}" chat -q "$(cat \'{prompt}\')" --quiet --ignore-rules --max-turns {max_turns}{provider_args} --toolsets "{selected_toolsets}"',
        }
    raise AgentRuntimeError(f"Runtime `{spec.name}` has no command preview.")
