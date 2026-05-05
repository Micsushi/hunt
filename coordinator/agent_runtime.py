from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


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
        platform_note="Hermes native Windows is unsupported; use WSL2 on Windows.",
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


def _json_for_prompt(payload: Any) -> str:
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False)


def build_result_template(claim: dict[str, Any]) -> dict[str, Any]:
    fill = claim.get("fill") or {}
    return {
        "status": "ok",
        "resumeUploadOk": None,
        "generatedAnswersUsed": False,
        "finalUrl": fill.get("apply_url"),
        "missingRequiredFields": [],
        "lowConfidenceAnswers": [],
        "manualReviewFlags": [],
        "evidence": {
            "notes": "",
            "screenshots": [],
            "htmlSnapshots": [],
            "stoppedBeforeSubmit": True,
        },
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

    return f"""# Hunt C4 Bounded Fill Worker

You are operating exactly one Hunt C4 worker lease. C4 is the source of truth; you are the browser/runtime worker for this lease only.

Lease summary:
```json
{_json_for_prompt(summary)}
```

Inputs:
- Full claim payload: {claim_ref}
- Result template: {result_ref}
- Service token: read the bearer token from environment variable `{token_env_var}`. Do not print, store, or reveal the token.

Allowed actions:
- Use the browser/runtime tools needed to open only the claimed `apply_url`.
- Fill application fields using the claim payload, selected resume, candidate/profile context already present in the payload, and grounded facts only.
- Upload the selected resume when possible.
- Heartbeat while working by POSTing JSON to `{heartbeat_endpoint}` with body `{{"lease_seconds": 900}}`.
- Finish by POSTing JSON to `{result_endpoint}` with body `{{"payload": <result object>}}`.

Hard stops:
- Do not click any final submit/apply/complete button.
- Stop on a review page, final submit page, payment page, CAPTCHA, MFA, OTP, account lock, login problem, hostname drift, or any unsupported destructive action.
- Do not inspect or modify Hunt's database.
- Do not browse unrelated jobs, search for other openings, send messages, email anyone, or modify files outside the worker artifact folder.
- Do not invent claims about the candidate. If a required answer is missing or low confidence, leave it unresolved and add a manual review flag.

Result requirements:
- Use `status` = `ok` only when the form is filled as far as safely possible and you stopped before final submit.
- Use `manual_review` when the operator needs to intervene.
- Use `failed` for unrecoverable worker/runtime errors.
- Always include `finalUrl`, `resumeUploadOk`, `generatedAnswersUsed`, `missingRequiredFields`, `lowConfidenceAnswers`, `manualReviewFlags`, and `evidence.stoppedBeforeSubmit`.

After posting the result, stop. Do not continue to another job or claim another lease.
{claim_block}{template_block}"""


def build_runtime_command(
    *,
    runtime_name: str,
    prompt: str,
    agent_name: str | None = None,
    toolsets: str | None = None,
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
        command = ["hermes", "chat", "-q", prompt]
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
        return {
            "powershell": f'hermes chat -q (Get-Content -Raw "{prompt}") --toolsets "{selected_toolsets}"',
            "bash": f'hermes chat -q "$(cat \'{prompt}\')" --toolsets "{selected_toolsets}"',
        }
    raise AgentRuntimeError(f"Runtime `{spec.name}` has no command preview.")
