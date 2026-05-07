"""Tests for logger integration + keywords_to_preserve in llm_enrich."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from fletcher.llm.llm_enrich import (
    bucket_skill_keywords_with_ollama,
    enrich_with_ollama_if_enabled,
    filter_summary_keywords_with_ollama,
    generate_summary,
    rewrite_bullet_targeted,
)
from fletcher.pipeline_logger import PipelineLogger


def _make_logger() -> PipelineLogger:
    return PipelineLogger()


def test_pipeline_logger_prints_debug_summary_readably(capsys):
    logger = PipelineLogger()

    logger.step(
        "pipeline_debug_summary",
        keywords_found=["Python"],
        keyword_partition={"present": [], "missing": ["Python"]},
        policy_routes={"rewrite": ["Python"], "summary_only": [], "skills_only": [], "ignored": []},
        rag_levels={"high": ["Python"], "medium": [], "low_count": 0, "rag_used": True},
        bullet_rewrites=[],
        summary_keywords_used=[],
        summary_keywords_excluded=[],
        dropped_bullets=[],
        rewrite_attempts=None,
        summary_line_checks=[],
    )

    out = capsys.readouterr().out
    assert "== Pipeline Debug Summary ==" in out
    assert "Keywords Found:" in out
    assert "keywords_found=['Python']" not in out


def test_pipeline_debug_summary_separates_rag_metadata(capsys):
    logger = PipelineLogger()

    logger.step(
        "pipeline_debug_summary",
        keywords_found=["Python"],
        keyword_partition={"present": [], "missing": ["Python"]},
        policy_routes={"rewrite": ["Python"], "summary_only": [], "skills_only": [], "ignored": []},
        rag_levels={"high": [], "medium": ["Python"], "low_count": 2, "rag_used": True},
        bullet_rewrites=[],
        summary_keywords_used=[],
        summary_keywords_excluded=[],
        dropped_bullets=[
            {
                "bullet_id": "b1",
                "kind": "exp",
                "entry_id": "e1",
                "score": 0.42,
                "stem": "output_summary",
                "reason": "page_fit_lowest_score",
                "text": "Dropped bullet text.",
            }
        ],
        rewrite_attempts=None,
        summary_line_checks=[],
    )

    out = capsys.readouterr().out
    medium_section = out.split("  Medium:", maxsplit=1)[1].split("  Low Count:", maxsplit=1)[0]
    assert "low_count" not in medium_section
    assert "  Low Count: 2" in out
    assert "  RAG Used: True" in out
    assert "reason=page_fit_lowest_score" in out
    assert "text: Dropped bullet text." in out


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


def test_rewrite_repair_success_uses_repair_validation(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    validations = [
        {
            "accepted": False,
            "keywords_supported": [],
            "keywords_rejected": ["cloud platforms"],
            "reason": "too broad",
        },
        {
            "accepted": True,
            "keywords_supported": ["cloud platforms"],
            "keywords_rejected": [],
            "reason": "supported",
        },
    ]

    monkeypatch.setattr(
        "fletcher.llm.llm_enrich.validate_rewrite_with_ollama",
        lambda **_kwargs: validations.pop(0),
    )
    monkeypatch.setattr(
        "fletcher.llm.llm_enrich.repair_rewrite_with_ollama",
        lambda **_kwargs: {
            "success": True,
            "bullet": "Built on cloud platforms using Vercel and Supabase.",
            "keywords_used": ["cloud platforms"],
            "keywords_skipped": [],
            "duration_ms": 1,
        },
    )

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value=(
            '{"bullet": "Built on broad cloud platforms.", '
            '"keywords_used": ["cloud platforms"], "keywords_skipped": []}'
        ),
    ):
        result = rewrite_bullet_targeted(
            "Built on Vercel and Supabase.",
            ["cloud platforms"],
            logger=_make_logger(),
        )

    assert result["success"] is True
    assert result["initial_validation"]["accepted"] is False
    assert result["validation"]["accepted"] is True


def test_claimed_keyword_missing_uses_llm_validation_before_repair(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    repair_called = {"value": False}

    monkeypatch.setattr(
        "fletcher.llm.llm_enrich.repair_rewrite_with_ollama",
        lambda **_kwargs: (
            repair_called.update(value=True)
            or {
                "success": True,
                "bullet": "Optimized full stack development scalability for 10,000+ concurrent users by engineering a full-stack architecture on Vercel and Supabase.",
                "keywords_used": ["full stack development"],
                "keywords_skipped": [],
                "duration_ms": 1,
            }
        ),
    )
    monkeypatch.setattr(
        "fletcher.llm.llm_enrich.validate_rewrite_with_ollama",
        lambda **_kwargs: {
            "accepted": True,
            "keywords_supported": ["full stack development"],
            "keywords_rejected": [],
            "reason": "same architecture context",
        },
    )

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value=(
            '{"bullet": "Optimized system scalability to support 10,000+ concurrent users by engineering a full-stack architecture on Vercel and Supabase.", '
            '"keywords_used": ["full stack development"], "keywords_skipped": []}'
        ),
    ):
        result = rewrite_bullet_targeted(
            "Optimized system scalability to support \\textbf{10,000+} concurrent users by engineering a full-stack architecture on Vercel and Supabase.",
            ["full stack development"],
            logger=_make_logger(),
        )

    assert repair_called["value"] is False
    assert result["success"] is True
    assert result["keywords_used"] == ["full stack development"]
    assert "claimed_keyword_presence" not in result
    assert "presence_resolved_by_llm_validation" not in result


def test_rewrite_outcome_removes_used_from_skipped(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        "fletcher.llm.llm_enrich.validate_rewrite_with_ollama",
        lambda **_kwargs: {
            "accepted": True,
            "keywords_supported": ["Azure DevOps"],
            "keywords_rejected": [],
            "reason": "supported",
        },
    )

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value=(
            '{"bullet": "Improved delivery with Azure DevOps.", '
            '"keywords_used": ["Azure DevOps"], "keywords_skipped": ["Azure DevOps"]}'
        ),
    ):
        result = rewrite_bullet_targeted("Improved delivery.", ["Azure DevOps"])

    assert result["success"] is True
    assert result["keywords_used"] == ["Azure DevOps"]
    assert result["keywords_skipped"] == []


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
        return_value='{"summary": "Great candidate.", "keywords_used": [], "retry_reason": ""}',
    ) as chat:
        logger = _make_logger()
        result = generate_summary("context", "Engineer", [], logger=logger)
    assert result["success"] is True
    chat.assert_called_once()
    assert chat.call_args.kwargs["temperature"] == 0.0
    log = logger.get_log_text()
    assert "generate_summary" in log
    assert "success=True" in log


def test_summary_prompt_includes_existing_summary_and_line_feedback(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str, **_kwargs) -> str:
        captured.append(prompt)
        return '{"summary": "Adjusted summary.", "keywords_used": ["Python"], "retry_reason": "expanded summary"}'

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
    assert result["keywords_used"] == ["Python"]
    assert result["retry_reason"] == "expanded summary"
    assert "Existing resume summary for context:\nExisting summary." in captured[0]
    assert "Retry/length feedback to address:\nMake it longer." in captured[0]


def test_summary_prompt_bans_junior_tone(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str, **_kwargs) -> str:
        captured.append(prompt)
        return '{"summary": "Software developer with backend experience."}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        generate_summary("context", "Software Engineer", ["backend services"])

    assert "No filler" in captured[0]
    assert "motivated" in captured[0].lower()
    assert "eager" in captured[0].lower()
    assert "Do not use banned phrases or variants" in captured[0]
    assert "State what the candidate does, not what they want" in captured[0]


def test_summary_prompt_caps_jd_keywords_and_starts_from_candidate_facts(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str, **_kwargs) -> str:
        captured.append(prompt)
        return '{"summary": "Grounded summary.", "keywords_used": ["strategy"], "retry_reason": ""}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        generate_summary(
            "Relevant evidence: built Python services.",
            "Product Manager",
            ["strategy", "dashboards", "business cases", "forecasting models"],
        )

    assert "Optional job description keywords, max 3" in captured[0]
    assert "strategy, dashboards, business cases, forecasting models" in captured[0]
    assert "Start with candidate facts" in captured[0]
    assert "Do not copy word for word from Candidate background" in captured[0]
    assert "Good summary example" in captured[0]
    assert "keywords_used" in captured[0]
    assert "keyword_use_reason" in captured[0]
    assert "retry_reason" in captured[0]


def test_keyword_extract_prompt_prioritizes_stack_and_skips_noise():
    from fletcher.llm.llm_enrich import _build_user_prompt

    prompt = _build_user_prompt(
        "Data Analyst Internship",
        "Use SQL and Python. Co-op role with reports and dashboards.",
    )

    assert "0 to 30 resume bullet keywords" in prompt
    assert "Keep policy:" in prompt
    assert "Ignore policy:" in prompt
    assert "Every keyword must be 1 to 3 words" in prompt
    assert "job titles, role labels, seniority" in prompt
    assert "blocked keywords" in prompt
    assert "unsupported_target_role" not in prompt
    assert "vague nouns" in prompt


def test_keyword_extract_prompt_hard_bans_actual_titles_and_labels():
    from fletcher.llm.llm_enrich import _build_user_prompt

    prompt = _build_user_prompt(
        "Full Stack Developer Intern",
        "Full Stack Developer role using backend engineering and web-based development.",
    )

    assert (
        "Never return the actual job title, role title, seniority label, employment type, "
        "degree, or major as a keyword."
    ) in prompt
    assert "backend engineering" in prompt
    assert "web-based development" in prompt


def test_jd_prompt_excerpt_includes_late_requirement_sections():
    from fletcher.llm.llm_enrich import build_jd_prompt_excerpt

    description = (
        "Company overview. " * 400
        + "\nRequirements\nLate requirement: medication administration and charting.\n"
        + "Closing details. " * 80
    )

    excerpt = build_jd_prompt_excerpt(description, 1800)

    assert "Company overview" in excerpt
    assert "Late requirement: medication administration and charting" in excerpt
    assert len(excerpt) <= 1800


def test_summary_grounding_is_prompt_validation_compatibility_wrapper():
    from fletcher.llm.llm_enrich import validate_summary_grounding

    result = validate_summary_grounding(
        "Eager to apply strong development skills in an AI internship.",
        "Skills: Python, Java",
        [],
    )

    assert result == {"accepted": True, "reasons": []}


def test_summary_prompt_uses_pm_positioning(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str, **_kwargs) -> str:
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

    assert "Role family: pm" in captured[0]
    assert "Job level: manager" in captured[0]
    assert "Target role context" in captured[0]


def test_summary_prompt_uses_generic_role_context_without_hardcoded_special_cases(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str, **_kwargs) -> str:
        captured.append(prompt)
        return '{"summary": "Data-focused analyst summary."}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        generate_summary(
            "Relevant evidence: SQL dashboards, Python analysis, stakeholder reports.",
            "Pricing Strategy Analyst Intern",
            ["SQL", "forecasting"],
            role_family="data",
            job_level="intern",
        )

    prompt = captured[0]
    assert "Position the candidate for the exact job title and level." in prompt
    assert "Role family: data" in prompt
    assert "Job level: intern" in prompt
    assert "technical analyst or data-focused analyst" not in prompt
    assert "student or intern-level framing" not in prompt


def test_summary_validation_prompt_requires_rejecting_awkward_claims(monkeypatch):
    from fletcher.llm.llm_enrich import validate_summary_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return '{"accepted": false, "reasons": ["awkward claim"]}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        result = validate_summary_with_ollama(
            summary="Summary with awkward domain claims.",
            candidate_context="Skills: Python, React",
            keywords=["signal flow diagrams"],
        )

    assert result["accepted"] is False
    assert "forced domain/tool claims" in captured[0]
    assert "copied bullet phrasing" in captured[0]
    assert "awkward keyword stuffing" in captured[0]


def test_summary_validation_does_not_retry_validator_json_failure(monkeypatch):
    from fletcher.llm.llm_enrich import validate_summary_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    calls: list[str] = []

    def fake_chat(prompt: str) -> str:
        calls.append(prompt)
        return '{"accepted": false, "reasons": ["unterminated'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        result = validate_summary_with_ollama(
            summary="Too broad summary.",
            candidate_context="Skills: Python",
            keywords=["strategy"],
        )

    assert result["success"] is False
    assert result["accepted"] is True
    assert "retry" not in result
    assert len(calls) == 1


def test_rewrite_validation_prompt_allows_contextual_framing(monkeypatch):
    from fletcher.llm.llm_enrich import validate_rewrite_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return (
            '{"accepted": true, "keywords_supported": ["advanced analytics"], '
            '"keywords_rejected": [], "reason": "same observability context"}'
        )

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        result = validate_rewrite_with_ollama(
            original="Configured Datadog metrics and alerts.",
            rewritten="Configured Datadog metrics and advanced analytics for alerts.",
            requested_keywords=["advanced analytics"],
        )

    assert result["accepted"] is True
    assert "same work context" in captured[0]
    assert "does not need to appear explicitly" in captured[0]
    assert "Data-domain terms such as" not in captured[0]


def test_skill_bucket_prompt_allows_concrete_technical_skill_phrases(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return '{"additions": {"UnknownFutureDB": "developer_tools"}, "ignored": ["analytical thinking"]}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        bucket_skill_keywords_with_ollama(
            keywords=["UnknownFutureDB", "analytical thinking"],
            existing_skills={"languages": [], "frameworks": [], "developer_tools": []},
            job_title="Data Platform Engineer",
        )

    assert "Job title: Data Platform Engineer" in captured[0]
    assert "Skill addition policy:" in captured[0]
    assert "one specific Existing skills category" in captured[0]
    assert "blocked keywords" in captured[0]
    assert "Category must be exactly one of the existing categories: languages, frameworks, developer_tools" in captured[0]
    assert "Choose 0 to 3 total additions" in captured[0]
    assert '{"additions": {"keyword one": "category", "keyword two": "category"}' in captured[0]
    assert "keyword-to-category pairs" in captured[0]


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


def test_summary_filter_prompt_never_includes_role_titles(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return '{"included": ["Python"], "excluded": ["Full Stack Developer"], "reason": "ok"}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        filter_summary_keywords_with_ollama(
            keywords=["Full Stack Developer", "Python"],
            candidate_context="Built Python services.",
            job_title="Full Stack Developer",
            logger=_make_logger(),
        )

    assert "Summary keyword policy:" in captured[0]
    assert "role labels" in captured[0]


def test_skill_bucket_retries_missing_required_keys(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    responses = [
        '{"developer_tools": ["SQL"]}',
        '{"additions": {"SQL": "languages"}, "ignored": ["data mining"]}',
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


def test_skill_bucket_can_ignore_standalone_dashboard_and_ide(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value=(
            '{"additions": {"AI-driven dashboard": "developer_tools"}, '
            '"ignored": ["dashboards", "Android Studio"]}'
        ),
    ):
        result = bucket_skill_keywords_with_ollama(
            keywords=["dashboards", "AI-driven dashboard", "Android Studio"],
            existing_skills={
                "languages": ["Python"],
                "frameworks": ["React"],
                "developer_tools": [],
            },
            logger=_make_logger(),
        )

    assert result["developer_tools"] == ["AI-driven dashboard"]
    assert result["ignored"] == ["dashboards", "Android Studio"]


def test_skill_bucket_discards_invalid_terms_without_retry(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value=(
            '{"additions": {'
            '"Bash": "languages", '
            '"WebSockets": "frameworks", '
            '"Linux scripting": "developer_tools"}, '
            '"ignored": []}'
        ),
    ) as chat:
        result = bucket_skill_keywords_with_ollama(
            keywords=["WebSockets", "Linux scripting"],
            existing_skills={"languages": ["Bash"], "frameworks": [], "developer_tools": []},
            logger=_make_logger(),
        )

    assert chat.call_count == 1
    assert result["success"] is True
    assert result["languages"] == []
    assert result["frameworks"] == ["WebSockets"]
    assert result["developer_tools"] == ["Linux scripting"]
    assert result["ignored"] == []


def test_skill_bucket_uses_existing_skill_categories(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return '{"additions": {"Snowflake": "data_platforms"}, "ignored": []}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        result = bucket_skill_keywords_with_ollama(
            keywords=["Snowflake"],
            existing_skills={"languages": ["Python"], "data_platforms": []},
            logger=_make_logger(),
        )

    assert "languages, data_platforms" in captured[0]
    assert result["data_platforms"] == ["Snowflake"]


def test_skill_bucket_uses_configured_skill_addition_limit(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        "fletcher.llm.llm_enrich.load_c2_prompt_settings",
        lambda: {
            "skill_addition_limit": 1,
            "job_metadata_min_confidence": 0.8,
            "skill_addition_policy": "Add only configured skills.",
        },
    )
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return '{"additions": {"Python": "languages", "React": "frameworks"}, "ignored": []}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        result = bucket_skill_keywords_with_ollama(
            keywords=["Python", "React"],
            existing_skills={"languages": [], "frameworks": [], "developer_tools": []},
            logger=_make_logger(),
        )

    assert "Choose 0 to 1 total additions" in captured[0]
    assert result["languages"] == ["Python"]
    assert result["frameworks"] == []


def test_job_fit_prompt_is_generic_without_target_lane_policy(monkeypatch):
    from fletcher.llm.llm_enrich import analyze_job_fit_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return (
            '{"title": "Registered Nurse", "role_family": "healthcare", '
            '"job_level": "mid", "mismatch": false, '
            '"mismatch_reason": "", "unsupported_target_role": false, '
            '"unsupported_target_reason": "", "confidence": 0.9, '
            '"jd_usable": true, "jd_usable_reason": "Detailed role."}'
        )

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        result = analyze_job_fit_with_ollama(
            input_title="",
            deterministic_title="Registered Nurse",
            description="Patient care role with triage, charting, and care coordination.",
            logger=_make_logger(),
        )

    assert result["mismatch"] is False
    assert result["role_family"] == ""
    assert result["jd_usable"] is True
    assert "no target-lane policy was supplied" in captured[0].lower()
    assert "civil" not in captured[0].lower()
    assert "mechanical" not in captured[0].lower()
    assert "0 to 30" not in captured[0]
    assert "Only accepted answer format" in captured[0]


def test_job_metadata_accepts_configured_custom_values(monkeypatch):
    from fletcher.llm.llm_enrich import analyze_job_fit_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value=(
            '{"title": "Registered Nurse", "role_family": "healthcare", '
            '"job_level": "licensed", "mismatch": false, "mismatch_reason": "", '
            '"unsupported_target_role": false, "unsupported_target_reason": "", '
            '"confidence": 0.9, "jd_usable": true, "jd_usable_reason": "Detailed role."}'
        ),
    ):
        result = analyze_job_fit_with_ollama(
            input_title="",
            deterministic_title="Registered Nurse",
            description="Patient care role.",
            role_family_values=["software", "healthcare"],
            job_level_values=["mid", "licensed"],
            logger=_make_logger(),
        )

    assert result["role_family"] == "healthcare"
    assert result["job_level"] == "licensed"


def test_job_fit_prompt_uses_injected_target_lane_policy(monkeypatch):
    from fletcher.llm.llm_enrich import analyze_job_fit_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return (
            '{"title": "Package Engineer", "role_family": "general", '
            '"job_level": "mid", "mismatch": false, "mismatch_reason": "", '
            '"unsupported_target_role": true, '
            '"unsupported_target_reason": "Outside supplied lane.", '
            '"confidence": 0.9, "jd_usable": true, "jd_usable_reason": "Detailed JD."}'
        )

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        result = analyze_job_fit_with_ollama(
            input_title="",
            deterministic_title="Package Engineer",
            description="Mechanical package engineering for pumps and vessels.",
            target_lane_policy="Configured queue lane only.",
            unsupported_examples=["example outside lane"],
            logger=_make_logger(),
        )

    assert result["mismatch"] is False
    assert result["unsupported_target_role"] is True
    assert "Outside supplied lane" in result["unsupported_target_reason"]
    assert "Configured queue lane only" in captured[0]
    assert "example outside lane" in captured[0]


def test_job_metadata_prompt_uses_3000_char_excerpt(monkeypatch):
    from fletcher.llm.llm_enrich import analyze_job_fit_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return (
            '{"title": "Software Engineer", "role_family": "software", '
            '"job_level": "mid", "mismatch": false, "mismatch_reason": "", '
            '"unsupported_target_role": false, "unsupported_target_reason": "", '
            '"confidence": 0.9, "jd_usable": true, "jd_usable_reason": ""}'
        )

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        analyze_job_fit_with_ollama(
            input_title="",
            deterministic_title="",
            description=("A" * 3000) + "TAIL_SHOULD_NOT_APPEAR",
            missing_fields=["title", "role_family", "job_level"],
            logger=_make_logger(),
        )

    assert "Fill missing job metadata" in captured[0]
    excerpt = captured[0].split("Job description excerpt:\n", 1)[1].split("\nNo target-lane", 1)[0]
    assert len(excerpt) == 3000
    assert "TAIL_SHOULD_NOT_APPEAR" not in captured[0]


def test_job_metadata_prompt_uses_configured_char_limit_and_confidence(monkeypatch):
    from fletcher.llm.llm_enrich import analyze_job_fit_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        "fletcher.llm.llm_enrich.load_c2_prompt_settings",
        lambda: {
            "job_metadata_prompt_max_chars": 12,
            "job_metadata_min_confidence": 0.95,
        },
    )
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return (
            '{"title": "Guess", "role_family": "software", '
            '"job_level": "mid", "mismatch": false, "mismatch_reason": "", '
            '"unsupported_target_role": false, "unsupported_target_reason": "", '
            '"confidence": 0.9, "jd_usable": true, "jd_usable_reason": ""}'
        )

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        result = analyze_job_fit_with_ollama(
            input_title="",
            deterministic_title="",
            description="ABCDEFGHIJKLTAIL",
            missing_fields=["title", "role_family", "job_level"],
            logger=_make_logger(),
        )

    assert "at least 0.95 confident" in captured[0]
    assert "ABCDEFGHIJKL" in captured[0]
    assert "TAIL" not in captured[0]
    assert result["title"] == ""
    assert result["role_family"] == ""


def test_job_metadata_ignores_low_confidence_fields(monkeypatch):
    from fletcher.llm.llm_enrich import analyze_job_fit_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value=(
            '{"title": "Guess", "role_family": "software", "job_level": "senior", '
            '"mismatch": false, "mismatch_reason": "", '
            '"unsupported_target_role": false, "unsupported_target_reason": "", '
            '"confidence": 0.7, "jd_usable": true, "jd_usable_reason": ""}'
        ),
    ):
        result = analyze_job_fit_with_ollama(
            input_title="",
            deterministic_title="",
            description="Vague posting.",
            missing_fields=["title", "role_family", "job_level"],
            logger=_make_logger(),
        )

    assert result["confidence"] == 0.7
    assert result["title"] == ""
    assert result["role_family"] == ""
    assert result["job_level"] == ""


def test_extract_keywords_filters_popular_ide_keywords(monkeypatch):
    from fletcher.llm.llm_enrich import extract_keywords_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value='{"keywords": ["Android Studio", "Xcode", "Swift", "Appium"]}',
    ):
        result = extract_keywords_with_ollama(
            title="SDET",
            description="Mobile testing role.",
            logger=_make_logger(),
        )

    assert result["keywords"] == ["Swift", "Appium"]


def test_keyword_extract_uses_configured_keyword_limits(monkeypatch):
    from fletcher.llm.llm_enrich import extract_keywords_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        "fletcher.llm.llm_enrich.load_c2_prompt_settings",
        lambda: {
            "keyword_selection_max_keywords": 2,
            "keyword_selection_min_words": 2,
            "keyword_selection_max_words": 4,
            "job_metadata_min_confidence": 0.6,
            "keyword_keep_policy": "Keep configured terms.",
            "keyword_ignore_policy": "Ignore configured noise.",
            "blocked_keywords": [],
        },
    )
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return '{"keywords": ["one", "two", "three"]}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        result = extract_keywords_with_ollama(
            title="Role",
            description="Use one two three.",
            logger=_make_logger(),
        )

    assert "0 to 2 resume bullet keywords" in captured[0]
    assert "Every keyword must be 2 to 4 words" in captured[0]
    assert "not 0.6 confident" in captured[0]
    assert result["keywords"] == ["one", "two"]


def test_extract_keywords_does_not_post_filter_titles(monkeypatch):
    from fletcher.llm.llm_enrich import extract_keywords_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value='{"keywords": ["RabbitMQ", "Software Engineer"]}',
    ):
        result = extract_keywords_with_ollama(
            title="Backend Developer",
            description="Backend role using RabbitMQ.",
            logger=_make_logger(),
        )

    assert result["keywords"] == ["RabbitMQ", "Software Engineer"]
    assert "removed_keywords" not in result


def test_extract_keywords_ignores_legacy_keyword_routes(monkeypatch):
    from fletcher.llm.llm_enrich import extract_keywords_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value=(
            "{"
            '"keywords": ["AI models", "complex systems integration", "analytical"], '
            '"keyword_routes": ['
            '{"keyword": "AI models", "route": "rewrite", "kind": "technology", "reason": "AI concept"},'
            '{"keyword": "complex systems integration", "route": "rewrite", "kind": "workflow", "reason": "workflow"},'
            '{"keyword": "analytical", "route": "summary", "kind": "quality_trait", "reason": "quality"}]}'
        ),
    ):
        result = extract_keywords_with_ollama(
            title="AI Developer",
            description="AI developer role.",
            logger=_make_logger(),
        )

    assert result["keywords"] == ["AI models", "complex systems integration", "analytical"]
    assert "keyword_routes" not in result


def test_job_fit_without_policy_forces_unsupported_false(monkeypatch):
    from fletcher.llm.llm_enrich import analyze_job_fit_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value=(
            '{"title": "Process Engineer", "role_family": "general", '
            '"job_level": "mid", "mismatch": false, "mismatch_reason": "", '
            '"unsupported_target_role": true, "unsupported_target_reason": "Model tried to apply a lane.", '
            '"confidence": 0.9, "jd_usable": true, "jd_usable_reason": "Detailed role."}'
        ),
    ):
        result = analyze_job_fit_with_ollama(
            input_title="highly qualified intermediate Process Engineer",
            deterministic_title="Process Engineer",
            description="Process Engineer role using Aspen HYSYS, P&IDs, HAZOPs, and flare sizing.",
            logger=_make_logger(),
        )

    assert result["unsupported_target_role"] is False
    assert result["unsupported_target_reason"] == ""


def test_low_rag_unsupported_target_check_can_block_outside_lane(monkeypatch):
    from fletcher.llm.llm_enrich import check_low_rag_unsupported_target_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value=(
            '{"unsupported_target_role": true, '
            '"reason": "Process engineering role is outside the target lane."}'
        ),
    ) as chat:
        result = check_low_rag_unsupported_target_with_ollama(
            title="Process Engineer",
            description="Use Aspen HYSYS, P&IDs, HAZOPs, and flare sizing.",
            keywords=["Aspen HYSYS", "P&IDs"],
            rag_scores=[{"keyword": "Aspen HYSYS", "tier": "mid", "score": 0.64}],
            target_lane_policy="Configured queue lane.",
            unsupported_examples=["process engineering"],
            logger=_make_logger(),
        )

    assert result["success"] is True
    assert result["unsupported_target_role"] is True
    assert "do not decide whether tailoring should continue" in chat.call_args.args[0]
    assert "queued job is outside the target lane" in chat.call_args.args[0]
    assert "Configured queue lane" in chat.call_args.args[0]


def test_low_rag_unsupported_target_check_skips_llm_without_policy(monkeypatch):
    from fletcher.llm.llm_enrich import check_low_rag_unsupported_target_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")

    with patch("fletcher.llm.llm_enrich._ollama_chat") as chat:
        result = check_low_rag_unsupported_target_with_ollama(
            title="Process Engineer",
            description="Use Aspen HYSYS.",
            keywords=["Aspen HYSYS"],
            rag_scores=[{"keyword": "Aspen HYSYS", "tier": "mid", "score": 0.64}],
            target_lane_policy="",
            logger=_make_logger(),
        )

    assert result == {
        "unsupported_target_role": False,
        "reason": "",
        "success": True,
        "error": None,
        "duration_ms": 0,
    }
    chat.assert_not_called()


def test_low_rag_prompt_requires_target_lane_policy():
    from fletcher.llm.prompt_templates import build_low_rag_unsupported_target_prompt

    with pytest.raises(ValueError, match="target_lane_policy is required"):
        build_low_rag_unsupported_target_prompt(
            title="Process Engineer",
            description="Use Aspen HYSYS.",
            keywords=["Aspen HYSYS"],
            compact_scores=[{"keyword": "Aspen HYSYS", "tier": "mid", "score": 0.64}],
            target_lane_policy="",
        )


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
