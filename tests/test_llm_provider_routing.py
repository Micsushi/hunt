from __future__ import annotations

from fletcher import config as fletcher_config
from shared.llm.config import choose_provider, normalize_provider


def test_provider_aliases_normalize_user_facing_names() -> None:
    assert normalize_provider("local") == "ollama"
    assert normalize_provider("codex oauth") == "codex"
    assert normalize_provider("codex_oauth") == "codex"
    assert normalize_provider("claude_api") == "anthropic"
    assert normalize_provider("gemini-api") == "gemini"
    assert normalize_provider("openrouter_api") == "openrouter"


def test_global_provider_env_feeds_c2(monkeypatch) -> None:
    monkeypatch.setenv("HUNT_LLM_PROVIDER", "local")
    monkeypatch.delenv("HUNT_C2_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("HUNT_RESUME_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("HUNT_RESUME_MODEL_BACKEND", raising=False)

    assert fletcher_config.resume_llm_provider() == "ollama"


def test_component_provider_env_overrides_global(monkeypatch) -> None:
    monkeypatch.setenv("HUNT_LLM_PROVIDER", "local")
    monkeypatch.setenv("HUNT_C2_LLM_PROVIDER", "openrouter")

    assert fletcher_config.resume_llm_provider() == "openrouter"


def test_choose_provider_precedence(monkeypatch) -> None:
    monkeypatch.setenv("HUNT_LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("HUNT_C2_LLM_PROVIDER", "codex_oauth")

    choice = choose_provider(component="c2", default="ollama")

    assert choice.provider == "codex"
    assert choice.source == "HUNT_C2_LLM_PROVIDER"
