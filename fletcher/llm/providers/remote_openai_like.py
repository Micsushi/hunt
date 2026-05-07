from __future__ import annotations

import json
import time
from typing import Any

import httpx

from fletcher import config as _config

from .base import LLMJsonResult, LLMProvider


class OpenAICompatibleProvider(LLMProvider):
    cloud = True
    api_key_env = ""
    base_url = ""
    default_model = ""

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
        api_key = _config.resume_provider_api_key(self.name, self.api_key_env)
        selected_model = model or self.default_model
        if not api_key:
            return LLMJsonResult(
                provider=self.name,
                model=selected_model,
                success=False,
                error=f"{self.api_key_env} is required before sending resume content to {self.name}",
            )
        t0 = time.perf_counter()
        payload = {
            "model": selected_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": task_name, "schema": schema},
            },
        }
        try:
            response = httpx.post(
                f"{self.base_url}/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=timeout_sec or 120,
            )
            response.raise_for_status()
            raw = response.json()
            content = str(raw["choices"][0]["message"]["content"])
            parsed = json.loads(content)
            return LLMJsonResult(
                provider=self.name,
                model=selected_model,
                content=content,
                parsed=parsed,
                success=True,
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
