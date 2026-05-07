from __future__ import annotations

import time
from typing import Any

import httpx

from fletcher import config as _config

from .base import LLMJsonResult, LLMProvider


class GeminiProvider(LLMProvider):
    name = "gemini"
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
        api_key = _config.resume_provider_api_key("gemini", "HUNT_GEMINI_API_KEY")
        selected_model = model or "gemini-1.5-flash"
        if not api_key:
            return LLMJsonResult(
                provider=self.name,
                model=selected_model,
                success=False,
                error="HUNT_GEMINI_API_KEY is required before cloud use",
            )
        t0 = time.perf_counter()
        payload = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "temperature": temperature,
                "response_mime_type": "application/json",
                "response_json_schema": schema,
            },
        }
        try:
            response = httpx.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{selected_model}:generateContent?key={api_key}",
                json=payload,
                timeout=timeout_sec or 120,
            )
            response.raise_for_status()
            raw = response.json()
            content = raw["candidates"][0]["content"]["parts"][0]["text"]
            import json

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
