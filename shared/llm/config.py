from __future__ import annotations

import os
import shlex
from dataclasses import dataclass
from typing import Callable


PROVIDER_ALIASES = {
    "": "",
    "local": "ollama",
    "local_llm": "ollama",
    "local-llm": "ollama",
    "ollama": "ollama",
    "heuristic": "heuristic",
    "none": "heuristic",
    "openai": "openai",
    "openai_api": "openai",
    "openai-api": "openai",
    "openrouter": "openrouter",
    "openrouter_api": "openrouter",
    "openrouter-api": "openrouter",
    "anthropic": "anthropic",
    "claude": "anthropic",
    "claude_api": "anthropic",
    "claude-api": "anthropic",
    "gemini": "gemini",
    "gemini_api": "gemini",
    "gemini-api": "gemini",
    "codex": "codex",
    "codex oauth": "codex",
    "codex_oauth": "codex",
    "codex-oauth": "codex",
    "openai_codex": "codex",
    "openai-codex": "codex",
}

CLOUD_PROVIDERS = {"openai", "openrouter", "anthropic", "gemini", "codex"}


@dataclass(frozen=True)
class LLMProviderChoice:
    provider: str
    source: str


def normalize_provider(value: str | None) -> str:
    key = str(value or "").strip().lower()
    return PROVIDER_ALIASES.get(key, key)


def truthy(value: str | None, *, default: bool = False) -> bool:
    if value is None or not str(value).strip():
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _env(name: str) -> str:
    return os.getenv(name, "").strip()


def component_env(component: str, suffix: str) -> str:
    return f"HUNT_{component.upper()}_{suffix}"


def choose_provider(
    *,
    component: str,
    setting_lookup: Callable[[str], str] | None = None,
    setting_key: str = "llm_provider",
    legacy_env_names: tuple[str, ...] = (),
    legacy_default: str = "",
    default: str = "ollama",
) -> LLMProviderChoice:
    """Resolve one provider using component env, global env, settings, legacy envs, then default."""

    component_name = component.strip().upper()
    candidates: list[tuple[str, str]] = [
        (component_env(component_name, "LLM_PROVIDER"), _env(component_env(component_name, "LLM_PROVIDER"))),
        ("HUNT_LLM_PROVIDER", _env("HUNT_LLM_PROVIDER")),
    ]
    if setting_lookup is not None:
        candidates.append((f"{component.lower()}.{setting_key}", setting_lookup(setting_key)))
    for env_name in legacy_env_names:
        candidates.append((env_name, _env(env_name)))
    candidates.append(("legacy_default", legacy_default))
    candidates.append(("default", default))

    for source, value in candidates:
        provider = normalize_provider(value)
        if provider:
            return LLMProviderChoice(provider=provider, source=source)
    return LLMProviderChoice(provider=default, source="default")


def choose_model(
    *,
    component: str,
    task_name: str | None = None,
    setting_lookup: Callable[[str], str] | None = None,
    setting_key: str = "llm_model",
    legacy_env_names: tuple[str, ...] = (),
    default: str = "",
) -> str:
    component_name = component.strip().upper()
    candidates: list[str] = []
    if task_name:
        task_key = task_name.upper()
        candidates.extend(
            [
                _env(component_env(component_name, f"{task_key}_MODEL")),
                _env(f"HUNT_{task_key}_MODEL"),
            ]
        )
    candidates.extend(
        [
            _env(component_env(component_name, "LLM_MODEL")),
            _env("HUNT_LLM_MODEL"),
        ]
    )
    if setting_lookup is not None:
        if task_name:
            candidates.append(setting_lookup(f"{task_name.lower()}_model"))
        candidates.append(setting_lookup(setting_key))
    for env_name in legacy_env_names:
        candidates.append(_env(env_name))
    candidates.append(default)
    for value in candidates:
        if str(value or "").strip():
            return str(value).strip()
    return ""


def cloud_confirmed(
    *,
    component: str,
    setting_lookup: Callable[[str], str] | None = None,
    setting_key: str = "cloud_llm_confirm",
    legacy_env_names: tuple[str, ...] = (),
    default: bool = False,
) -> bool:
    component_name = component.strip().upper()
    candidates: list[str | None] = [
        _env(component_env(component_name, "CLOUD_LLM_CONFIRM")),
        _env("HUNT_CLOUD_LLM_CONFIRM"),
    ]
    if setting_lookup is not None:
        candidates.append(setting_lookup(setting_key))
    candidates.extend(_env(env_name) for env_name in legacy_env_names)
    for value in candidates:
        if value is not None and str(value).strip():
            return truthy(value)
    return default


def split_command(value: str, default: list[str]) -> list[str]:
    text = str(value or "").strip()
    if not text:
        return list(default)
    return shlex.split(text, posix=os.name != "nt")
