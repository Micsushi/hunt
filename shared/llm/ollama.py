from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class OllamaChatResponse:
    content: str
    raw_response: dict[str, Any]


def keep_alive_payload(value: str | int) -> str | int:
    text = str(value).strip()
    if text in {"-1", "0"} or text.isdigit():
        return int(text)
    return text


def post_json(
    url: str,
    payload: dict[str, Any],
    *,
    timeout_sec: float,
) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        body = json.load(resp)
    if not isinstance(body, dict):
        raise ValueError("Ollama returned a non-object JSON response")
    return body


def chat(
    *,
    host: str,
    model: str,
    messages: list[dict[str, str]],
    timeout_sec: float,
    keep_alive: str | int,
    temperature: float = 0.1,
    response_format: str = "json",
) -> OllamaChatResponse:
    payload = {
        "model": model,
        "format": response_format,
        "stream": False,
        "keep_alive": keep_alive_payload(keep_alive),
        "options": {"temperature": temperature},
        "messages": messages,
    }
    raw = post_json(f"{host.rstrip('/')}/api/chat", payload, timeout_sec=timeout_sec)
    message = raw.get("message") or {}
    if not isinstance(message, dict):
        raise ValueError("Ollama chat response missing message object")
    return OllamaChatResponse(
        content=str(message.get("content") or "").strip(),
        raw_response=raw,
    )


def chat_content(
    *,
    host: str,
    model: str,
    system: str,
    user: str,
    timeout_sec: float,
    keep_alive: str | int,
    temperature: float = 0.1,
    response_format: str = "json",
) -> str:
    return chat(
        host=host,
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        timeout_sec=timeout_sec,
        keep_alive=keep_alive,
        temperature=temperature,
        response_format=response_format,
    ).content


def embed_text(
    *,
    host: str,
    model: str,
    text: str,
    timeout_sec: float,
    keep_alive: str | int,
    max_chars: int = 2000,
) -> list[float]:
    payload = {
        "model": model,
        "prompt": text.strip()[:max_chars],
        "keep_alive": keep_alive_payload(keep_alive),
    }
    raw = post_json(f"{host.rstrip('/')}/api/embeddings", payload, timeout_sec=timeout_sec)
    embedding = raw.get("embedding")
    if not isinstance(embedding, list):
        raise ValueError("Ollama embedding response missing embedding array")
    return [float(value) for value in embedding]
