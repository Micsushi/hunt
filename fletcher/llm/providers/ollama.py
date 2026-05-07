from __future__ import annotations

import json
import time
from typing import Any

import httpx

from fletcher import config as _config

from .base import LLMJsonResult, LLMProvider


class OllamaProvider(LLMProvider):
    name = "ollama"
    cloud = False

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
        selected_model = model or _config.resume_llm_model() or _config.ollama_model_name()
        t0 = time.perf_counter()
        payload = {
            "model": selected_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "format": "json",
            "stream": False,
            "options": {"temperature": temperature},
            "keep_alive": _config.ollama_keep_alive_payload(),
        }
        try:
            response = httpx.post(
                f"{_config.ollama_host()}/api/chat",
                json=payload,
                timeout=timeout_sec or _config.ollama_timeout_sec(),
            )
            response.raise_for_status()
            raw = response.json()
            content = str((raw.get("message") or {}).get("content") or "")
            parsed = json.loads(content)
            return LLMJsonResult(
                provider=self.name,
                model=selected_model,
                content=content,
                parsed=parsed,
                success=True,
                duration_ms=int((time.perf_counter() - t0) * 1000),
                raw_response=raw,
            )
        except Exception as exc:
            return LLMJsonResult(
                provider=self.name,
                model=selected_model,
                success=False,
                error=str(exc),
                duration_ms=int((time.perf_counter() - t0) * 1000),
            )
