from __future__ import annotations

import json
import time
from typing import Any

import httpx

from fletcher import config as _config

from .base import LLMJsonResult, LLMProvider


class AnthropicProvider(LLMProvider):
    name = "anthropic"
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
        api_key = _config.resume_provider_api_key("anthropic", "HUNT_ANTHROPIC_API_KEY")
        selected_model = model or "claude-3-5-haiku-latest"
        if not api_key:
            return LLMJsonResult(
                provider=self.name,
                model=selected_model,
                success=False,
                error="HUNT_ANTHROPIC_API_KEY is required before cloud use",
            )
        t0 = time.perf_counter()
        tool_name = f"{task_name}_json"
        payload = {
            "model": selected_model,
            "system": system,
            "messages": [{"role": "user", "content": user}],
            "max_tokens": 2048,
            "temperature": temperature,
            "tools": [{"name": tool_name, "description": task_name, "input_schema": schema}],
            "tool_choice": {"type": "tool", "name": tool_name},
        }
        try:
            response = httpx.post(
                "https://api.anthropic.com/v1/messages",
                json=payload,
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                },
                timeout=timeout_sec or 120,
            )
            response.raise_for_status()
            raw = response.json()
            parsed = None
            for part in raw.get("content", []):
                if part.get("type") == "tool_use":
                    parsed = part.get("input")
                    break
            return LLMJsonResult(
                provider=self.name,
                model=selected_model,
                parsed=parsed,
                content=json.dumps(parsed or {}),
                success=parsed is not None,
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
