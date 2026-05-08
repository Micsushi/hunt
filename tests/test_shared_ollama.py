import json

from shared.llm import ollama


class _JsonResponse:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self._payload


def test_chat_content_posts_json_payload(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["payload"] = json.loads(req.data.decode("utf-8"))
        captured["timeout"] = timeout
        return _JsonResponse({"message": {"content": '{"ok": true}'}})

    monkeypatch.setattr("shared.llm.ollama.urllib.request.urlopen", fake_urlopen)

    content = ollama.chat_content(
        host="http://ollama:11434/",
        model="gemma4:e4b",
        system="Return JSON.",
        user='Return {"ok": true}.',
        timeout_sec=12,
        keep_alive="-1",
        temperature=0.0,
    )

    assert content == '{"ok": true}'
    assert captured["url"] == "http://ollama:11434/api/chat"
    assert captured["timeout"] == 12
    assert captured["payload"]["keep_alive"] == -1
    assert captured["payload"]["options"]["temperature"] == 0.0
    assert captured["payload"]["messages"][0]["role"] == "system"


def test_embed_text_posts_embedding_payload(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["payload"] = json.loads(req.data.decode("utf-8"))
        captured["timeout"] = timeout
        return _JsonResponse({"embedding": [0.1, "0.2", 3]})

    monkeypatch.setattr("shared.llm.ollama.urllib.request.urlopen", fake_urlopen)

    embedding = ollama.embed_text(
        host="http://ollama:11434",
        model="mxbai-embed-large",
        text="Python services",
        timeout_sec=60,
        keep_alive="30m",
    )

    assert embedding == [0.1, 0.2, 3.0]
    assert captured["url"] == "http://ollama:11434/api/embeddings"
    assert captured["timeout"] == 60
    assert captured["payload"]["keep_alive"] == "30m"
    assert captured["payload"]["prompt"] == "Python services"
