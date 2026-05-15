from __future__ import annotations

from c3_answering.pipeline import provider_status
from coordinator.agent_runtime import build_runtime_command, hermes_provider_name
from fletcher import config as fletcher_config
from shared.llm.config import choose_provider, normalize_provider


def test_provider_aliases_normalize_user_facing_names() -> None:
    assert normalize_provider("local") == "ollama"
    assert normalize_provider("codex oauth") == "codex"
    assert normalize_provider("codex_oauth") == "codex"
    assert normalize_provider("claude_api") == "anthropic"
    assert normalize_provider("gemini-api") == "gemini"
    assert normalize_provider("openrouter_api") == "openrouter"


def test_global_provider_env_feeds_c2_and_c3(monkeypatch) -> None:
    monkeypatch.setenv("HUNT_LLM_PROVIDER", "local")
    monkeypatch.delenv("HUNT_C2_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("HUNT_C3_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("HUNT_RESUME_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("HUNT_RESUME_MODEL_BACKEND", raising=False)

    assert fletcher_config.resume_llm_provider() == "ollama"
    assert fletcher_config.c3_llm_provider() == "ollama"


def test_component_provider_env_overrides_global(monkeypatch) -> None:
    monkeypatch.setenv("HUNT_LLM_PROVIDER", "local")
    monkeypatch.setenv("HUNT_C2_LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("HUNT_C3_LLM_PROVIDER", "gemini_api")

    assert fletcher_config.resume_llm_provider() == "openrouter"
    assert fletcher_config.c3_llm_provider() == "gemini"


def test_c3_cloud_provider_status_uses_c3_confirm(monkeypatch) -> None:
    monkeypatch.setenv("HUNT_LLM_PROVIDER", "local")
    monkeypatch.setenv("HUNT_C3_LLM_PROVIDER", "claude_api")
    monkeypatch.delenv("HUNT_C3_CLOUD_LLM_CONFIRM", raising=False)
    monkeypatch.delenv("HUNT_CLOUD_LLM_CONFIRM", raising=False)

    status = provider_status()

    assert status.provider == "anthropic"
    assert status.cloud is True
    assert status.ready is False
    assert "cloud" in status.reason.lower()


def test_c4_hermes_provider_maps_codex_oauth() -> None:
    command = build_runtime_command(
        runtime_name="hermes_local",
        prompt="hello",
        llm_provider="codex_oauth",
        llm_model="gpt-5.3-codex",
    )

    assert hermes_provider_name("codex_oauth") == "openai-codex"
    assert hermes_provider_name("local") == "custom"
    assert "--provider" in command
    assert "openai-codex" in command
    assert "--model" in command
    assert "gpt-5.3-codex" in command


def test_choose_provider_precedence(monkeypatch) -> None:
    monkeypatch.setenv("HUNT_LLM_PROVIDER", "openrouter")
    monkeypatch.setenv("HUNT_C4_LLM_PROVIDER", "codex_oauth")

    choice = choose_provider(component="c4", default="ollama")

    assert choice.provider == "codex"
    assert choice.source == "HUNT_C4_LLM_PROVIDER"
