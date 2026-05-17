from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from shared.storage import write_json_artifact

from . import config as coordinator_config
from .agent_runtime import (
    AgentRuntimeError,
    build_command_preview,
    build_result_template,
    build_runtime_command,
    build_worker_prompt,
    normalize_runtime_choice,
    runtime_choices,
)


class AgentWorkerError(RuntimeError):
    pass


def _json_bytes(payload: dict[str, Any] | None) -> bytes | None:
    if payload is None:
        return None
    return json.dumps(payload, sort_keys=True).encode("utf-8")


def http_json(
    *,
    method: str,
    url: str,
    token: str | None,
    payload: dict[str, Any] | None = None,
    timeout_seconds: int = 30,
) -> dict[str, Any]:
    data = _json_bytes(payload)
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise AgentWorkerError(f"{method} {url} failed with HTTP {exc.code}: {body}") from exc
    except URLError as exc:
        raise AgentWorkerError(f"{method} {url} failed: {exc}") from exc
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AgentWorkerError(f"{method} {url} did not return JSON: {raw[:200]}") from exc
    if not isinstance(parsed, dict):
        raise AgentWorkerError(f"{method} {url} returned non-object JSON.")
    return parsed


def claim_next_fill_http(
    *,
    base_url: str,
    token: str | None,
    runtime_name: str,
    browser_lane: str | None,
    lease_seconds: int,
    worker_metadata: dict[str, Any],
) -> dict[str, Any]:
    return http_json(
        method="POST",
        url=f"{base_url.rstrip('/')}/workers/claim",
        token=token,
        payload={
            "runtime_name": runtime_name,
            "browser_lane": browser_lane,
            "lease_seconds": lease_seconds,
            "worker_metadata": worker_metadata,
        },
    )


def post_worker_result_http(
    *,
    base_url: str,
    token: str | None,
    lease_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return http_json(
        method="POST",
        url=f"{base_url.rstrip('/')}/workers/{lease_id}/result",
        token=token,
        payload={"payload": payload},
    )


def post_worker_heartbeat_http(
    *,
    base_url: str,
    token: str | None,
    lease_id: str,
    lease_seconds: int,
) -> dict[str, Any]:
    return http_json(
        method="POST",
        url=f"{base_url.rstrip('/')}/workers/{lease_id}/heartbeat",
        token=token,
        payload={"lease_seconds": lease_seconds},
        timeout_seconds=10,
    )


def write_worker_artifacts(
    *,
    out_dir: str | Path,
    runtime_name: str,
    base_url: str,
    claim: dict[str, Any],
    token_env_var: str = "HUNT_SERVICE_TOKEN",
    agent_name: str | None = None,
    toolsets: str | None = None,
    llm_provider: str | None = None,
    llm_model: str | None = None,
) -> dict[str, Any]:
    lease = claim.get("lease") or {}
    lease_id = lease.get("lease_id")
    if not lease_id:
        raise AgentWorkerError("Claim response did not include lease.lease_id.")
    root = Path(out_dir) / runtime_name / str(lease_id)
    root.mkdir(parents=True, exist_ok=True)

    claim_path = write_json_artifact(root / "claim.json", claim)
    result_template = build_result_template(claim)
    result_template_path = write_json_artifact(root / "result_template.json", result_template)
    prompt = build_worker_prompt(
        base_url=base_url,
        claim=claim,
        token_env_var=token_env_var,
        claim_path=claim_path,
        result_template_path=result_template_path,
    )
    prompt_path = root / "prompt.md"
    prompt_path.write_text(prompt, encoding="utf-8")
    command_preview = build_command_preview(
        runtime_name=runtime_name,
        prompt_path=prompt_path,
        agent_name=agent_name,
        toolsets=toolsets,
        llm_provider=llm_provider,
        llm_model=llm_model,
    )
    return {
        "artifact_dir": str(root),
        "claim_path": str(claim_path),
        "prompt_path": str(prompt_path),
        "result_template_path": str(result_template_path),
        "command_preview": command_preview,
    }


def run_external_agent_with_heartbeat(
    *,
    command: list[str],
    base_url: str,
    token: str | None,
    lease_id: str,
    lease_seconds: int,
) -> dict[str, Any]:
    stop = threading.Event()
    heartbeat_errors: list[str] = []
    heartbeat_count = 0
    interval_seconds = max(30, min(300, lease_seconds // 3))

    def heartbeat_loop() -> None:
        nonlocal heartbeat_count
        while not stop.wait(interval_seconds):
            try:
                post_worker_heartbeat_http(
                    base_url=base_url,
                    token=token,
                    lease_id=lease_id,
                    lease_seconds=lease_seconds,
                )
                heartbeat_count += 1
            except AgentWorkerError as exc:
                heartbeat_errors.append(str(exc))

    thread = threading.Thread(target=heartbeat_loop, daemon=True)
    thread.start()
    started_at = time.time()
    error: str | None = None
    exit_code: int | None = None
    try:
        env = os.environ.copy()
        env.setdefault("HERMES_DISABLE_WINDOWS_UTF8", "1")
        env.setdefault("TERM", "xterm-256color")
        completed = subprocess.run(command, check=False, env=env)
        exit_code = completed.returncode
    except FileNotFoundError as exc:
        error = str(exc)
    finally:
        stop.set()
        thread.join(timeout=2)
    return {
        "exit_code": exit_code,
        "error": error,
        "duration_seconds": round(time.time() - started_at, 3),
        "heartbeats_sent": heartbeat_count,
        "heartbeat_errors": heartbeat_errors[-3:],
    }


def _mock_result_payload(claim: dict[str, Any]) -> dict[str, Any]:
    payload = build_result_template(claim)
    payload["status"] = "complete"
    payload["agent_findings"] = "C4 agent worker mock result; no browser was launched."
    payload["notes"] = "mock"
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m coordinator.agent_worker",
        description="Claim one C4 fill lease and prepare an OpenClaw or Hermes worker turn.",
    )
    parser.add_argument("--runtime", required=True, help=f"Runtime: {', '.join(runtime_choices())}")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("HUNT_COORDINATOR_BASE_URL", "http://127.0.0.1:8003"),
        help="C4 service base URL.",
    )
    parser.add_argument(
        "--service-token",
        default=os.environ.get("HUNT_SERVICE_TOKEN"),
        help="C4 bearer token. Prefer HUNT_SERVICE_TOKEN instead of passing this flag.",
    )
    parser.add_argument(
        "--service-token-env",
        default="HUNT_SERVICE_TOKEN",
        help="Environment variable name the agent prompt should use for the bearer token.",
    )
    parser.add_argument("--browser-lane", choices=["isolated", "attached"], default=None)
    parser.add_argument("--lease-seconds", type=int, default=900)
    parser.add_argument("--out-dir", default=".runtime/c4-agent")
    parser.add_argument("--agent-name", default=None, help="OpenClaw agent id override.")
    parser.add_argument("--toolsets", default=None, help="Hermes toolsets override.")
    parser.add_argument(
        "--llm-provider",
        default=None,
        help="LLM provider override for the runtime. Defaults to HUNT_C4_LLM_PROVIDER, then HUNT_LLM_PROVIDER, then local Ollama.",
    )
    parser.add_argument(
        "--llm-model",
        default=None,
        help="LLM model override for the runtime. Defaults to HUNT_C4_LLM_MODEL, then HUNT_LLM_MODEL.",
    )
    parser.add_argument(
        "--execute-agent",
        action="store_true",
        help="Actually launch the selected external agent for this one prompt.",
    )
    parser.add_argument(
        "--mock-result",
        action="store_true",
        help="Post a safe mock result to C4 after claiming. Does not launch a browser or agent.",
    )
    return parser


def run_once(args: argparse.Namespace) -> dict[str, Any]:
    if args.mock_result and args.execute_agent:
        raise AgentWorkerError("--mock-result and --execute-agent cannot be combined.")
    try:
        spec = normalize_runtime_choice(args.runtime)
    except AgentRuntimeError as exc:
        raise AgentWorkerError(str(exc)) from exc

    browser_lane = args.browser_lane or spec.default_browser_lane
    llm_provider = getattr(args, "llm_provider", None) or coordinator_config.c4_llm_provider()
    llm_model = getattr(args, "llm_model", None) or coordinator_config.c4_llm_model()
    metadata = {
        "launcher": "coordinator.agent_worker",
        "platform": platform.platform(),
        "python": platform.python_version(),
        "execute_agent": bool(args.execute_agent),
        "mock_result": bool(args.mock_result),
        "llm_provider": llm_provider,
        "llm_model": llm_model,
    }
    claim = claim_next_fill_http(
        base_url=args.base_url,
        token=args.service_token,
        runtime_name=spec.name,
        browser_lane=browser_lane,
        lease_seconds=args.lease_seconds,
        worker_metadata=metadata,
    )
    if not claim.get("claimed"):
        return {
            "claimed": False,
            "runtime": spec.name,
            "reason": claim.get("reason", "no_pending_fills"),
        }

    artifacts = write_worker_artifacts(
        out_dir=args.out_dir,
        runtime_name=spec.name,
        base_url=args.base_url,
        claim=claim,
        token_env_var=args.service_token_env,
        agent_name=args.agent_name,
        toolsets=args.toolsets,
        llm_provider=llm_provider,
        llm_model=llm_model,
    )
    lease_id = claim["lease"]["lease_id"]
    result: dict[str, Any] = {
        "claimed": True,
        "runtime": spec.name,
        "browser_lane": browser_lane,
        "lease": claim["lease"],
        "fill": claim["fill"],
        "artifacts": artifacts,
        "platform_note": spec.platform_note,
        "llm_provider": llm_provider,
        "llm_model": llm_model,
        "agent_executed": False,
    }

    if args.mock_result:
        posted = post_worker_result_http(
            base_url=args.base_url,
            token=args.service_token,
            lease_id=lease_id,
            payload=_mock_result_payload(claim),
        )
        result["mock_result_posted"] = True
        result["mock_result_status"] = posted.get("run", {}).get("status")
        result["posted_result"] = posted

    if args.execute_agent:
        prompt = Path(artifacts["prompt_path"]).read_text(encoding="utf-8")
        command = build_runtime_command(
            runtime_name=spec.name,
            prompt=prompt,
            agent_name=args.agent_name,
            toolsets=args.toolsets,
            llm_provider=llm_provider,
            llm_model=llm_model,
        )
        redacted_command = list(command)
        for index, part in enumerate(redacted_command[:-1]):
            if part in {"--message", "-q"}:
                redacted_command[index + 1] = "<prompt omitted>"
        result["agent_executed"] = True
        result["agent_command"] = redacted_command
        result["agent_process"] = run_external_agent_with_heartbeat(
            command=command,
            base_url=args.base_url,
            token=args.service_token,
            lease_id=lease_id,
            lease_seconds=args.lease_seconds,
        )

    return result


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        payload = run_once(args)
    except AgentWorkerError as exc:
        print(json.dumps({"error": str(exc)}, indent=2, sort_keys=True), file=sys.stderr)
        return 1
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
