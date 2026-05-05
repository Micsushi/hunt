"""Tests for logger integration + keywords_to_preserve in llm_enrich."""

from __future__ import annotations

from unittest.mock import patch

from fletcher.llm.llm_enrich import (
    enrich_with_ollama_if_enabled,
    generate_summary,
    rewrite_bullet_targeted,
)
from fletcher.pipeline_logger import PipelineLogger


def _make_logger() -> PipelineLogger:
    return PipelineLogger()


# ── rewrite_bullet_targeted ──────────────────────────────────────────────────


def test_rewrite_no_logger_when_backend_not_ollama(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "none")
    logger = _make_logger()
    result = rewrite_bullet_targeted("bullet text", ["Python"], logger=logger)
    assert result["bullet"] == "bullet text"
    assert result["success"] is False
    assert logger.get_log_text().count("[LLM") == 0


def test_rewrite_logger_called_on_success(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        "fletcher.llm.llm_enrich.validate_rewrite_with_ollama",
        lambda **_kwargs: {
            "accepted": True,
            "keywords_supported": ["Python"],
            "keywords_rejected": [],
            "reason": "",
        },
    )
    mock_response = (
        '{"bullet": "Rewrote with Python.", "keywords_used": ["Python"], "keywords_skipped": []}'
    )
    with patch("fletcher.llm.llm_enrich._ollama_chat", return_value=mock_response):
        logger = _make_logger()
        result = rewrite_bullet_targeted("Original bullet.", ["Python"], logger=logger)
    assert result["success"] is True
    assert result["bullet"] == "Rewrote with Python."
    assert result["keywords_used"] == ["Python"]
    assert result["keywords_skipped"] == []
    log = logger.get_log_text()
    assert "rewrite_bullet" in log
    assert "success=True" in log


def test_rewrite_preserve_keywords_in_prompt(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        "fletcher.llm.llm_enrich.validate_rewrite_with_ollama",
        lambda **_kwargs: {
            "accepted": False,
            "keywords_supported": [],
            "keywords_rejected": ["MongoDB"],
            "reason": "",
        },
    )
    captured_prompts: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured_prompts.append(prompt)
        return '{"bullet": "same", "keywords_used": [], "keywords_skipped": ["MongoDB"]}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        rewrite_bullet_targeted("Used SQL.", ["MongoDB"], keywords_to_preserve=["SQL"], logger=None)

    assert captured_prompts
    assert "Keywords already in this bullet that must stay: SQL" in captured_prompts[0]


def test_rewrite_no_preserve_line_when_empty(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        "fletcher.llm.llm_enrich.validate_rewrite_with_ollama",
        lambda **_kwargs: {
            "accepted": False,
            "keywords_supported": [],
            "keywords_rejected": ["MongoDB"],
            "reason": "",
        },
    )
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return '{"bullet": "same", "keywords_used": [], "keywords_skipped": ["MongoDB"]}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        rewrite_bullet_targeted("Used SQL.", ["MongoDB"], keywords_to_preserve=[], logger=None)

    assert "must stay" not in captured[0]


def test_rewrite_logger_called_on_failure(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    with patch("fletcher.llm.llm_enrich._ollama_chat", side_effect=ConnectionRefusedError("down")):
        logger = _make_logger()
        result = rewrite_bullet_targeted("bullet", ["kw"], logger=logger)
    assert result["success"] is False
    assert result["keywords_used"] == []
    assert result["keywords_skipped"] == ["kw"]
    log = logger.get_log_text()
    assert "success=False" in log
    assert "ERROR:" in log


# ── generate_summary ─────────────────────────────────────────────────────────


def test_summary_no_logger_when_backend_not_ollama(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "none")
    logger = _make_logger()
    result = generate_summary("context", "Engineer", ["Python"], logger=logger)
    assert result["success"] is False
    assert logger.get_log_text().count("[LLM") == 0


def test_summary_logger_called_on_success(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value='{"summary": "Great candidate."}',
    ):
        logger = _make_logger()
        result = generate_summary("context", "Engineer", [], logger=logger)
    assert result["success"] is True
    log = logger.get_log_text()
    assert "generate_summary" in log
    assert "success=True" in log


def test_summary_prompt_includes_existing_summary_and_line_feedback(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return '{"summary": "Adjusted summary."}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        result = generate_summary(
            "context",
            "Engineer",
            ["Python"],
            existing_summary="Existing summary.",
            line_feedback="Make it longer.",
            logger=None,
        )

    assert result["success"] is True
    assert "Existing resume summary for context: Existing summary." in captured[0]
    assert "Length adjustment needed: Make it longer." in captured[0]


def test_summary_prompt_bans_junior_tone(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return '{"summary": "Software developer with backend experience."}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        generate_summary("context", "Software Engineer", ["backend services"])

    assert "Do not use junior-sounding filler" in captured[0]
    assert "motivated" in captured[0].lower()
    assert "eager" in captured[0].lower()


def test_pipeline_logger_event_ids_are_monotonic():
    logger = PipelineLogger()
    logger.step("a")
    logger.step("b")
    text = logger.get_log_text()

    assert "event_id: 1" in text
    assert "event_id: 2" in text


def test_summary_logger_on_failure(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    with patch("fletcher.llm.llm_enrich._ollama_chat", side_effect=TimeoutError("timeout")):
        logger = _make_logger()
        result = generate_summary("context", "Engineer", [], logger=logger)
    assert result["success"] is False
    log = logger.get_log_text()
    assert "success=False" in log


# ── enrich_with_ollama_if_enabled ────────────────────────────────────────────


def test_enrich_logger_called_on_success(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.LOG_LLM_IO", False)
    resp = '{"jd_usable": true, "jd_usable_reason": "good", "keywords": ["Python"]}'
    with patch("fletcher.llm.llm_enrich._ollama_chat", return_value=resp):
        logger = _make_logger()
        _, kw, meta = enrich_with_ollama_if_enabled(
            title="SWE", description="Python job", classification={}, keywords={}, logger=logger
        )
    assert meta["ollama_enriched"] is True
    assert "Python" in kw.get("must_have_terms", [])
    log = logger.get_log_text()
    assert "keyword_extract" in log
    assert "success=True" in log


def test_enrich_logger_on_failure(monkeypatch):
    import urllib.error

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        side_effect=urllib.error.URLError("connection refused"),
    ):
        logger = _make_logger()
        _, _, meta = enrich_with_ollama_if_enabled(
            title="SWE", description="job", classification={}, keywords={}, logger=logger
        )
    assert meta["ollama_enriched"] is False
    log = logger.get_log_text()
    assert "success=False" in log


def test_enrich_no_logger_when_backend_not_ollama(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "none")
    logger = _make_logger()
    _, _, meta = enrich_with_ollama_if_enabled(
        title="x", description="x", classification={}, keywords={}, logger=logger
    )
    assert meta["ollama_enriched"] is False
    assert logger.get_log_text().count("[LLM") == 0
