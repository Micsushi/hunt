from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ValidationError

from fletcher import config as _config

from .providers.anthropic_provider import AnthropicProvider
from .providers.base import LLMJsonResult, LLMProvider
from .providers.codex_cli import CodexCliProvider
from .providers.gemini import GeminiProvider
from .providers.heuristic import HeuristicProvider
from .providers.ollama import OllamaProvider
from .providers.openai_provider import OpenAIProvider
from .providers.openrouter import OpenRouterProvider

PROVIDERS: dict[str, type[LLMProvider]] = {
    "heuristic": HeuristicProvider,
    "ollama": OllamaProvider,
    "openai": OpenAIProvider,
    "openrouter": OpenRouterProvider,
    "anthropic": AnthropicProvider,
    "gemini": GeminiProvider,
    "codex": CodexCliProvider,
}


def configured_provider_name(component: str = "c2") -> str:
    if component == "c3":
        return _config.c3_llm_provider()
    return _config.resume_llm_provider()


def configured_model(task_name: str | None = None, component: str = "c2") -> str:
    if component == "c3":
        return _config.c3_llm_model(task_name)
    return _config.resume_llm_model(task_name)


def _cloud_confirmed(component: str) -> bool:
    if component == "c3":
        return _config.c3_cloud_llm_confirmed()
    return _config.resume_cloud_llm_confirmed()


def get_provider(name: str | None = None, *, component: str = "c2") -> LLMProvider:
    provider_name = (name or configured_provider_name(component)).lower()
    cls = PROVIDERS.get(provider_name)
    if cls is None:
        raise ValueError(f"Unsupported Fletcher LLM provider: {provider_name}")
    provider = cls()
    if provider.cloud and not _cloud_confirmed(component):
        raise ValueError(
            f"HUNT_{component.upper()}_CLOUD_LLM_CONFIRM=1 or HUNT_CLOUD_LLM_CONFIRM=1 "
            f"is required before using {provider_name}."
        )
    return provider


def _validate_payload(
    schema_model: type[BaseModel] | None, parsed: dict | None
) -> tuple[bool, dict | None, str | None]:
    if schema_model is None or parsed is None:
        return (
            parsed is not None,
            parsed,
            None if parsed is not None else "provider returned no parsed JSON",
        )
    try:
        if hasattr(schema_model, "model_validate"):
            model = schema_model.model_validate(parsed)  # type: ignore[attr-defined]
            return True, model.model_dump(mode="json"), None  # type: ignore[attr-defined]
        model = schema_model.parse_obj(parsed)
        return True, model.dict(), None
    except ValidationError as exc:
        return False, parsed, str(exc)


def generate_json(
    *,
    task_name: str,
    system: str,
    user: str,
    schema: dict[str, Any],
    schema_model: type[BaseModel] | None = None,
    temperature: float = 0.2,
    timeout_sec: float | None = None,
    model: str | None = None,
    logger=None,
    component: str = "c2",
) -> LLMJsonResult:
    provider = get_provider(component=component)
    result = provider.generate_json(
        task_name=task_name,
        system=system,
        user=user,
        schema=schema,
        temperature=temperature,
        timeout_sec=timeout_sec,
        model=model or configured_model(task_name, component),
        logger=logger,
    )
    ok, parsed, error = _validate_payload(schema_model, result.parsed)
    if not ok:
        result.success = False
        result.error = error
    result.parsed = parsed
    return result
