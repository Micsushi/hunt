from __future__ import annotations

from .base import LLMJsonResult, LLMProvider


class HeuristicProvider(LLMProvider):
    name = "heuristic"
    cloud = False

    def generate_json(self, **kwargs) -> LLMJsonResult:
        return LLMJsonResult(
            provider=self.name,
            model=str(kwargs.get("model") or "deterministic"),
            success=False,
            error="heuristic provider does not call a chat model",
        )
