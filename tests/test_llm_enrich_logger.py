"""Tests for logger integration + keywords_to_preserve in llm_enrich."""

from __future__ import annotations

from unittest.mock import patch

from fletcher.llm.llm_enrich import (
    classify_keyword_routes_with_ollama,
    bucket_skill_keywords_with_ollama,
    enrich_with_ollama_if_enabled,
    filter_summary_keywords_with_ollama,
    generate_summary,
    rewrite_bullet_targeted,
    validate_skill_keywords_with_ollama,
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


def test_keyword_extract_prompt_prioritizes_stack_and_skips_noise():
    from fletcher.llm.llm_enrich import _build_user_prompt

    prompt = _build_user_prompt(
        "Data Analyst Internship",
        "Use SQL and Python. Co-op role with reports and dashboards.",
    )

    assert "Fill the 20 keyword slots in this priority order" in prompt
    assert "Do not include job titles, employment types" in prompt
    assert "Skip generic deliverables" in prompt


def test_summary_grounding_rejects_banned_tone():
    from fletcher.llm.llm_enrich import validate_summary_grounding

    result = validate_summary_grounding(
        "Eager to apply strong development skills in an AI internship.",
        "Skills: Python, Java",
        [],
    )

    assert result["accepted"] is False
    assert "banned_tone:eager" in result["reasons"]


def test_summary_prompt_uses_pm_positioning(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return '{"summary": "Product-oriented summary."}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        generate_summary(
            "Relevant evidence: user feedback, bug triage, stakeholder presentations.",
            "Product Manager",
            [],
            role_family="pm",
            job_level="manager",
        )

    assert "product-adjacent strengths" in captured[0]
    assert "Do not use a generic software-only summary" in captured[0]


def test_summary_validation_prompt_requires_rejecting_unsupported_claims(monkeypatch):
    from fletcher.llm.llm_enrich import validate_summary_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return '{"accepted": false, "reasons": ["unsupported claim"]}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        result = validate_summary_with_ollama(
            summary="Summary with unsupported domain claims.",
            candidate_context="Skills: Python, React",
            keywords=["signal flow diagrams"],
        )

    assert result["accepted"] is False
    assert "Reject the summary if it claims a domain, tool, platform" in captured[0]
    assert "better to reject the summary than allow a polished unsupported claim" in captured[0]
    assert "Classify each sentence" in captured[0]
    assert "If any sentence is unsupported" in captured[0]


def test_skill_bucket_prompt_requires_canonical_named_skills(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return (
            '{"languages": [], "frameworks": [], '
            '"developer_tools": ["UnknownFutureDB"], "ignored": ["analytical thinking"]}'
        )

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        bucket_skill_keywords_with_ollama(
            keywords=["UnknownFutureDB", "analytical thinking"],
            existing_skills={"languages": [], "frameworks": [], "developer_tools": []},
        )

    assert "canonical named skill" in captured[0]
    assert "If uncertain, put it in ignored" in captured[0]
    assert "Return all four keys" in captured[0]


def test_summary_filter_retries_unrequested_terms(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    responses = [
        '{"included": ["Data Visualization"], "excluded": ["Backend"], "reason": "bad"}',
        '{"included": ["data mining"], "excluded": ["predictive modeling"], "reason": "ok"}',
    ]

    with patch("fletcher.llm.llm_enrich._ollama_chat", side_effect=responses) as chat:
        result = filter_summary_keywords_with_ollama(
            keywords=["data mining", "predictive modeling"],
            candidate_context="Python data optimization and forecasting.",
            job_title="Data Scientist",
            logger=_make_logger(),
        )

    assert chat.call_count == 2
    assert result["success"] is True
    assert result["included"] == ["data mining"]
    assert result["excluded"] == ["predictive modeling"]


def test_skill_bucket_retries_missing_required_keys(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    responses = [
        '{"developer_tools": ["SQL"]}',
        '{"languages": ["SQL"], "frameworks": [], "developer_tools": [], "ignored": ["data mining"]}',
    ]

    with patch("fletcher.llm.llm_enrich._ollama_chat", side_effect=responses) as chat:
        result = bucket_skill_keywords_with_ollama(
            keywords=["SQL", "data mining"],
            existing_skills={"languages": [], "frameworks": [], "developer_tools": []},
            logger=_make_logger(),
        )

    assert chat.call_count == 2
    assert result["success"] is True
    assert result["languages"] == ["SQL"]
    assert result["ignored"] == ["data mining"]


def test_skill_validation_rejects_concepts_not_named_skills(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return '{"accepted": ["SQL"], "rejected": ["data mining"], "reason": "concept"}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        result = validate_skill_keywords_with_ollama(
            proposed_keywords=["SQL", "data mining"],
            existing_skills={"languages": [], "frameworks": [], "developer_tools": []},
            candidate_context="Used SQL and Python for data workflows.",
            logger=_make_logger(),
        )

    assert result["success"] is True
    assert result["accepted"] == ["SQL"]
    assert result["rejected"] == ["data mining"]
    assert "Reject broad concepts" in captured[0]
    assert "candidate evidence" in captured[0]


def test_pipeline_logger_event_ids_are_monotonic():
    logger = PipelineLogger()
    logger.step("a")
    logger.step("b")
    text = logger.get_log_text()

    assert "event_id=1" in text
    assert "event_id=2" in text
    assert "------" in text
    assert "delta=" in text


def test_summary_logger_on_failure(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    with patch("fletcher.llm.llm_enrich._ollama_chat", side_effect=TimeoutError("timeout")):
        logger = _make_logger()
        result = generate_summary("context", "Engineer", [], logger=logger)
    assert result["success"] is False
    log = logger.get_log_text()
    assert "success=False" in log


def test_keyword_router_calls_llm_for_ambiguous_terms(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return (
            '{"routes": ['
            '{"keyword": "project coordination", "route": "summary", '
            '"kind": "process", "reason": "PM coordination signal"}, '
            '{"keyword": "project metrics", "route": "summary", '
            '"kind": "process", "reason": "PM reporting signal"}'
            "]}"
        )

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        routes = classify_keyword_routes_with_ollama(
            keywords=["project coordination", "project metrics"],
            job_title="Associate Project Manager",
            resume_context="Presented features to stakeholders and led design discussions.",
            role_family="pm",
            job_level="intern",
            logger=_make_logger(),
        )

    assert "project coordination" in captured[0]
    assert routes["project coordination"]["route"] == "summary"
    assert routes["project metrics"]["kind"] == "process"


def test_keyword_router_discards_malformed_routes(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value=(
            '{"routes": ['
            '{"keyword": "project coordination", "route": "delete", '
            '"kind": "process", "reason": "bad route"}, '
            '{"keyword": "project metrics", "route": "summary", '
            '"kind": "process", "reason": "good route"}'
            "]}"
        ),
    ):
        routes = classify_keyword_routes_with_ollama(
            keywords=["project coordination", "project metrics"],
            job_title="Associate Project Manager",
            resume_context="stakeholder communication",
            role_family="pm",
            job_level="intern",
        )

    assert "project coordination" not in routes
    assert routes["project metrics"]["route"] == "summary"


# ── enrich_with_ollama_if_enabled ────────────────────────────────────────────


def test_keyword_router_parse_failure_logs_once_as_failure(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    logger = _make_logger()

    with patch("fletcher.llm.llm_enrich._ollama_chat", return_value='{"routes": ['):
        routes = classify_keyword_routes_with_ollama(
            keywords=["project coordination"],
            job_title="Associate Project Manager",
            resume_context="stakeholder communication",
            role_family="pm",
            job_level="intern",
            logger=logger,
        )

    log_text = logger.get_log_text()
    assert routes == {}
    assert log_text.count("keyword_policy_route") == 1
    assert "success=False" in log_text
    assert "success=True" not in log_text


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
