from __future__ import annotations

from .remote_openai_like import OpenAICompatibleProvider


class OpenAIProvider(OpenAICompatibleProvider):
    name = "openai"
    api_key_env = "HUNT_OPENAI_API_KEY"
    base_url = "https://api.openai.com/v1"
    default_model = "gpt-4.1-mini"
