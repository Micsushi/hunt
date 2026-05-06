"""Tests for logger integration + keywords_to_preserve in llm_enrich."""

from __future__ import annotations

from unittest.mock import patch

from fletcher.llm.llm_enrich import (
    bucket_skill_keywords_with_ollama,
    classify_keyword_routes_with_ollama,
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
    assert result["presence_resolved_by_llm_validation"] is True


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


def test_summary_prompt_caps_jd_keywords_and_starts_from_candidate_facts(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return '{"summary": "Grounded summary."}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        generate_summary(
            "Relevant evidence: built Python services.",
            "Product Manager",
            ["strategy", "dashboards", "business cases", "forecasting models"],
        )

    assert "Candidate JD keywords to choose from. Pick at most 3" in captured[0]
    assert "strategy, dashboards, business cases, forecasting models" in captured[0]
    assert "Start from true candidate facts" in captured[0]


def test_keyword_extract_prompt_prioritizes_stack_and_skips_noise():
    from fletcher.llm.llm_enrich import _build_user_prompt

    prompt = _build_user_prompt(
        "Data Analyst Internship",
        "Use SQL and Python. Co-op role with reports and dashboards.",
    )

    assert "0 to 30 resume-tailoring keywords" in prompt
    assert "added to resume bullets" in prompt
    assert "handled separately by the pipeline" in prompt
    assert "Do not include job titles, role labels, seniority labels" in prompt
    assert "certifications" in prompt
    assert "AWS Certified" in prompt
    assert "education fields" in prompt
    assert "unsupported_target_role" in prompt
    assert "Android Studio" in prompt
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


def test_summary_validation_retries_compact_json_after_parse_failure(monkeypatch):
    from fletcher.llm.llm_enrich import validate_summary_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    calls: list[str] = []

    def fake_chat(prompt: str) -> str:
        calls.append(prompt)
        if len(calls) == 1:
            return '{"accepted": false, "reasons": ["unterminated'
        return '{"accepted": false, "reasons": ["too broad"]}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        result = validate_summary_with_ollama(
            summary="Too broad summary.",
            candidate_context="Skills: Python",
            keywords=["strategy"],
        )

    assert result["success"] is True
    assert result["accepted"] is False
    assert result["retry"] == "json_compact"
    assert len(calls) == 2
    assert "compact valid JSON" in calls[1]


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
        return (
            '{"additions": [{"keyword": "UnknownFutureDB", "category": "developer_tools"}], '
            '"ignored": ["analytical thinking"]}'
        )

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        bucket_skill_keywords_with_ollama(
            keywords=["UnknownFutureDB", "analytical thinking"],
            existing_skills={"languages": [], "frameworks": [], "developer_tools": []},
        )

    assert "concrete technical skill phrases such as Linux scripting" in captured[0]
    assert "makes sense beside the Existing skills" in captured[0]
    assert "Do not add IDEs or editors" in captured[0]
    assert "standalone deliverable nouns such as dashboards" in captured[0]
    assert "If uncertain, put it in ignored" in captured[0]
    assert "Choose at most 3 total additions" in captured[0]
    assert '"additions"' in captured[0]


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
        '{"additions": [{"keyword": "SQL", "category": "languages"}], "ignored": ["data mining"]}',
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
            '{"additions": [{"keyword": "AI-driven dashboard", "category": "developer_tools"}], '
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
            '{"additions": ['
            '{"keyword": "Bash", "category": "languages"}, '
            '{"keyword": "WebSockets", "category": "frameworks"}, '
            '{"keyword": "Linux scripting", "category": "developer_tools"}], '
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


def test_job_fit_prompt_treats_network_cloud_roles_as_supported(monkeypatch):
    from fletcher.llm.llm_enrich import analyze_job_fit_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured: list[str] = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return (
            '{"title": "Network Engineer", "role_family": "infrastructure", '
            '"job_level": "senior", "mismatch": false, '
            '"mismatch_reason": "", "unsupported_target_role": false, '
            '"unsupported_target_reason": "", "confidence": 0.9, '
            '"jd_usable": true, "jd_usable_reason": "Detailed infrastructure role.", '
            '"keywords": ["cloud infrastructure", "BGP", "firewalls"]}'
        )

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        result = analyze_job_fit_with_ollama(
            input_title="",
            deterministic_title="Network Engineer",
            description="Cloud infrastructure role with LAN/WAN, firewalls, BGP, and OSPF.",
            logger=_make_logger(),
        )

    assert result["mismatch"] is False
    assert result["role_family"] == "infrastructure"
    assert result["keywords"] == ["cloud infrastructure", "BGP", "firewalls"]
    assert result["jd_usable"] is True
    assert "network" in captured[0].lower()
    assert "cloud" in captured[0].lower()
    assert "computer" in captured[0].lower()
    assert "0 to 30 resume-tailoring keywords" in captured[0]


def test_job_fit_prompt_reports_unsupported_target_role(monkeypatch):
    from fletcher.llm.llm_enrich import analyze_job_fit_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value=(
            '{"title": "Package Engineer", "role_family": "general", '
            '"job_level": "mid", "mismatch": false, "mismatch_reason": "", '
            '"unsupported_target_role": true, '
            '"unsupported_target_reason": "Mechanical package engineering is outside the configured lane.", '
            '"confidence": 0.9, "jd_usable": true, "jd_usable_reason": "Detailed JD.", '
            '"keywords": ["pumps"]}'
        ),
    ):
        result = analyze_job_fit_with_ollama(
            input_title="",
            deterministic_title="Package Engineer",
            description="Mechanical package engineering for pumps and vessels.",
            logger=_make_logger(),
        )

    assert result["mismatch"] is False
    assert result["unsupported_target_role"] is True
    assert "Mechanical package" in result["unsupported_target_reason"]


def test_job_fit_filters_popular_ide_keywords(monkeypatch):
    from fletcher.llm.llm_enrich import analyze_job_fit_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value=(
            '{"title": "SDET", "role_family": "software", "job_level": "mid", '
            '"mismatch": false, "mismatch_reason": "", '
            '"unsupported_target_role": false, "unsupported_target_reason": "", '
            '"confidence": 0.9, "jd_usable": true, "jd_usable_reason": "Detailed role.", '
            '"keywords": ["Android Studio", "Xcode", "Swift", "Appium"]}'
        ),
    ):
        result = analyze_job_fit_with_ollama(
            input_title="",
            deterministic_title="SDET",
            description="Mobile testing role.",
            logger=_make_logger(),
        )

    assert result["keywords"] == ["Swift", "Appium"]


def test_job_fit_overrides_process_engineer_as_unsupported(monkeypatch):
    from fletcher.llm.llm_enrich import analyze_job_fit_with_ollama

    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")

    with patch(
        "fletcher.llm.llm_enrich._ollama_chat",
        return_value=(
            '{"title": "Process Engineer", "role_family": "general", '
            '"job_level": "mid", "mismatch": false, "mismatch_reason": "", '
            '"unsupported_target_role": false, "unsupported_target_reason": "", '
            '"confidence": 0.9, "jd_usable": true, "jd_usable_reason": "Detailed role.", '
            '"keywords": ["Aspen HYSYS", "HAZOPs", "Process Simulation"]}'
        ),
    ):
        result = analyze_job_fit_with_ollama(
            input_title="highly qualified intermediate Process Engineer",
            deterministic_title="Process Engineer",
            description="Process Engineer role using Aspen HYSYS, P&IDs, HAZOPs, and flare sizing.",
            logger=_make_logger(),
        )

    assert result["unsupported_target_role"] is True
    assert "outside Hunt" in result["unsupported_target_reason"]


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
    assert "Candidate resume context" not in captured[0]
    assert "Presented features" not in captured[0]
    assert "Do not use candidate resume evidence here" in captured[0]
    assert "post-extraction cleanup L-check" in captured[0]
    assert "standalone deliverables such as dashboards" in captured[0]
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
