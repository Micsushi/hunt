from __future__ import annotations

import json
import subprocess
import time
from typing import Any

from fletcher import config as _config
from shared.llm import config as llm_config

from .base import LLMJsonResult, LLMProvider


def _extract_json_object(text: str) -> dict | None:
    stripped = text.strip()
    if not stripped:
        return None
    try:
        parsed = json.loads(stripped)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(stripped[start : end + 1])
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


class CodexCliProvider(LLMProvider):
    name = "codex"
    cloud = True

    def generate_json(
        self,
        *,
        task_name: str,
        system: str,
        user: str,
        schema: dict[str, Any],
        temperature: float = 0.2,
        timeout_sec: float | None = None,
        model: str | None = None,
        logger=None,
    ) -> LLMJsonResult:
        command = llm_config.split_command(
            _config.resume_runtime_setting("codex_command", "HUNT_CODEX_COMMAND", ""),
            ["codex"],
        )
        args = llm_config.split_command(
            _config.resume_runtime_setting("codex_args", "HUNT_CODEX_ARGS", ""),
            ["exec", "--sandbox", "read-only", "--ask-for-approval", "never"],
        )
        selected_model = model or _config.resume_runtime_setting(
            "codex_model", "HUNT_CODEX_MODEL", "gpt-5.3-codex"
        )
        if selected_model:
            args.extend(["--model", selected_model])
        prompt = (
            f"{system}\n\n"
            "Return JSON only. Do not edit files, run commands, or include markdown fences.\n"
            f"Task name: {task_name}\n"
            f"JSON schema:\n{json.dumps(schema, sort_keys=True)}\n\n"
            f"User input:\n{user}"
        )
        t0 = time.perf_counter()
        try:
            completed = subprocess.run(
                [*command, *args, prompt],
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout_sec or 300,
            )
            content = completed.stdout.strip()
            if completed.returncode != 0:
                return LLMJsonResult(
                    provider=self.name,
                    model=selected_model,
                    content=content,
                    success=False,
                    error=(completed.stderr or content or "codex command failed").strip(),
                    duration_ms=int((time.perf_counter() - t0) * 1000),
                )
            parsed = _extract_json_object(content)
            return LLMJsonResult(
                provider=self.name,
                model=selected_model,
                content=content,
                parsed=parsed,
                success=parsed is not None,
                error=None if parsed is not None else "codex returned no JSON object",
                duration_ms=int((time.perf_counter() - t0) * 1000),
            )
        except Exception as exc:
            return LLMJsonResult(
                provider=self.name,
                model=selected_model,
                success=False,
                error=str(exc),
                duration_ms=int((time.perf_counter() - t0) * 1000),
            )
