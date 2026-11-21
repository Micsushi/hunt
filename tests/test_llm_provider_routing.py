from __future__ import annotations

from fletcher import config as fletcher_config


def test_component_provider_env_overrides_global(monkeypatch) -> None:
    monkeypatch.setenv("HUNT_LLM_PROVIDER", "local")
    monkeypatch.setenv("HUNT_C2_LLM_PROVIDER", "openrouter")

    assert fletcher_config.resume_llm_provider() == "openrouter"
