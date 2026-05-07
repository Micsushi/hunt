from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class LLMJsonResult(BaseModel):
    provider: str
    model: str
    content: str = ""
    parsed: dict | None = None
    success: bool = False
    error: str | None = None
    duration_ms: int | None = None
    raw_response: dict | str | None = None


class LLMProvider:
    name = "base"
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
        raise NotImplementedError
