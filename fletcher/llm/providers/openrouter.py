from __future__ import annotations

from .remote_openai_like import OpenAICompatibleProvider


class OpenRouterProvider(OpenAICompatibleProvider):
    name = "openrouter"
    api_key_env = "HUNT_OPENROUTER_API_KEY"
    base_url = "https://openrouter.ai/api/v1"
    default_model = "openai/gpt-4.1-mini"
