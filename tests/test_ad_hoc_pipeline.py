"""Tests for fletcher.ad_hoc_pipeline.run_ad_hoc_pipeline."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest


def test_import():
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    assert callable(run_ad_hoc_pipeline)


def test_rewrite_parallelism_respects_memory_guard(monkeypatch):
    import fletcher.ad_hoc_pipeline as mod
    from fletcher.pipeline_logger import PipelineLogger

    monkeypatch.setattr(mod._config, "BULLET_REWRITE_PARALLELISM", 2)
    monkeypatch.setattr(mod._config, "BULLET_REWRITE_MIN_AVAILABLE_MB", 4096)
    monkeypatch.setattr(mod._config, "BULLET_REWRITE_MAX_MEMORY_PCT", 85)
    monkeypatch.setattr(
        mod,
        "_memory_snapshot",
        lambda: {
            "known": True,
            "source": "cgroup",
            "used_mb": 7900,
            "limit_mb": 8192,
            "available_mb": 292,
            "used_pct": 96.4,
        },
    )

    assert mod._rewrite_worker_count(3, PipelineLogger()) == 1


def test_rewrite_parallelism_allows_configured_workers(monkeypatch):
    import fletcher.ad_hoc_pipeline as mod
    from fletcher.pipeline_logger import PipelineLogger

    monkeypatch.setattr(mod._config, "BULLET_REWRITE_PARALLELISM", 3)
    monkeypatch.setattr(mod._config, "BULLET_REWRITE_MIN_AVAILABLE_MB", 4096)
    monkeypatch.setattr(mod._config, "BULLET_REWRITE_MAX_MEMORY_PCT", 85)
    monkeypatch.setattr(
        mod,
        "_memory_snapshot",
        lambda: {
            "known": True,
            "source": "cgroup",
            "used_mb": 2048,
            "limit_mb": 16384,
            "available_mb": 14336,
            "used_pct": 12.5,
        },
    )

    assert mod._rewrite_worker_count(2, PipelineLogger()) == 2


def test_summary_evidence_uses_top_three_scored_bullets():
    import fletcher.ad_hoc_pipeline as mod

    bullets = ["first", "second", "third", "fourth"]
    sources = [
        {"bullet_id": "b1"},
        {"bullet_id": "b2"},
        {"bullet_id": "b3"},
        {"bullet_id": "b4"},
    ]
    scores = {"b1": 0.1, "b2": 0.9, "b3": 0.8, "b4": 0.7}

    assert mod._summary_evidence_bullets(bullets, sources, scores) == [
        "second",
        "third",
        "fourth",
    ]


def test_candidate_context_keeps_three_evidence_bullets():
    import fletcher.ad_hoc_pipeline as mod

    doc = _make_parsed_doc()
    context = mod._build_candidate_context(
        doc,
        evidence_bullets=["one", "two", "three", "four"],
    )

    assert "one | two | three" in context
    assert "four" not in context


def _make_parsed_doc():
    from fletcher.resume.models import (
        EducationEntry,
        EducationSection,
        ExperienceEntry,
        ProjectEntry,
        ResumeDocument,
        ResumeHeader,
        SkillsSection,
    )

    return ResumeDocument(
        source_path="test.tex",
        preamble=r"\documentclass{article}",
        header=ResumeHeader(name="Test User", contact_line="test@example.com"),
        education=EducationSection(
            entry=EducationEntry(entry_id="edu0", institution_and_degree="BSc CS", date_text="2020")
        ),
        experience=[
            ExperienceEntry(
                entry_id="exp0",
                title_company_location="SWE at Acme",
                date_text="2021-2024",
                bullets=["Built Python service.", "Improved SQL queries."],
            )
        ],
        projects=[
            ProjectEntry(
                entry_id="proj0",
                project_title="Side Project",
                date_or_link_text="2023",
                bullets=["Created React dashboard.", "Added FastAPI backend."],
            )
        ],
        skills=SkillsSection(languages=["Python"]),
    )


@pytest.fixture()
def base_mocks(monkeypatch):
    """Monkeypatch all external calls in ad_hoc_pipeline for unit tests."""
    import fletcher.ad_hoc_pipeline as mod

    monkeypatch.setattr(mod, "parse_resume_file", MagicMock(return_value=_make_parsed_doc()))
    monkeypatch.setattr(mod, "classify_job", MagicMock(return_value={}))
    monkeypatch.setattr(
        mod,
        "analyze_job_fit_with_ollama",
        MagicMock(return_value={"success": False, "title": ""}),
    )
    monkeypatch.setattr(mod, "classify_job_with_ollama", MagicMock(return_value={"success": False}))
    monkeypatch.setattr(
        mod,
        "filter_summary_keywords_with_ollama",
        MagicMock(return_value={"success": False, "included": [], "excluded": []}),
    )
    monkeypatch.setattr(
        mod,
        "validate_summary_with_ollama",
        MagicMock(return_value={"success": False, "accepted": True, "reasons": []}),
    )
    monkeypatch.setattr(
        mod,
        "bucket_skill_keywords_with_ollama",
        MagicMock(
            return_value={
                "success": False,
                "languages": [],
                "frameworks": [],
                "developer_tools": [],
                "ignored": [],
            }
        ),
    )
    monkeypatch.setattr(
        mod, "extract_keywords", MagicMock(return_value={"must_have_terms": ["Python", "MongoDB"]})
    )
    monkeypatch.setattr(
        mod,
        "enrich_with_ollama_if_enabled",
        MagicMock(return_value=({}, {"must_have_terms": ["Python", "MongoDB"]}, {})),
    )
    monkeypatch.setattr(
        mod,
        "partition_keywords",
        MagicMock(return_value=(["Python"], ["MongoDB"], {"Python": [0], "MongoDB": []})),
    )
    monkeypatch.setattr(
        mod,
        "match_keywords_to_bullets",
        MagicMock(
            return_value={
                "bullet_matches": [{"bullet_idx": 1, "keyword": "MongoDB", "score": 0.85}],
                "summary_keywords": [],
                "ignored_keywords": [],
                "scores": [],
                "rag_used": True,
            }
        ),
    )
    monkeypatch.setattr(
        mod,
        "rewrite_bullet_targeted",
        MagicMock(
            return_value={
                "bullet": "Improved MongoDB queries.",
                "success": True,
                "error": None,
                "keywords_used": ["MongoDB"],
                "keywords_skipped": [],
            }
        ),
    )
    monkeypatch.setattr(
        mod, "generate_summary", MagicMock(return_value={"summary": "", "success": False})
    )
    monkeypatch.setattr(
        mod,
        "validate_summary_grounding",
        MagicMock(return_value={"accepted": True, "reasons": []}),
    )
    monkeypatch.setattr(
        mod,
        "compile_tex",
        MagicMock(
            return_value={
                "compile_status": "ok",
                "fits_one_page": True,
                "page_count": 1,
                "pdf_path": "/tmp/output.pdf",
                "log_text": "",
            }
        ),
    )
    monkeypatch.setattr(mod, "score_bullets_for_drop", MagicMock(return_value=[0.9, 0.4, 0.7, 0.6]))
    monkeypatch.setattr(mod, "_summary_line_count", MagicMock(return_value=("ok", 4)))
    monkeypatch.setattr(mod, "ensure_dir", MagicMock(return_value=Path("/tmp/ad_hoc")))
    monkeypatch.setattr(mod, "build_attempt_dir", MagicMock(return_value=Path("/tmp/ad_hoc")))
    monkeypatch.setattr(mod, "write_json", MagicMock(return_value="/tmp/keywords.json"))
    monkeypatch.setattr(mod, "write_text", MagicMock(side_effect=lambda path, _content: str(path)))
    monkeypatch.setattr(mod._config, "RAG_ENABLED", True)
    return mod


def test_returns_expected_keys(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    result = run_ad_hoc_pipeline(title="SWE", description="Python MongoDB job", company="Acme")
    for key in (
        "pdf_path",
        "log_path",
        "keywords",
        "present_keywords",
        "missing_keywords",
        "attempt_dir",
    ):
        assert key in result, f"missing key: {key}"


def test_pdf_path_from_compile_result(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    result = run_ad_hoc_pipeline(title="SWE", description="job")
    assert result["pdf_path"] == "/tmp/output.pdf"


def test_log_path_set(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    result = run_ad_hoc_pipeline(title="SWE", description="job")
    assert Path(result["log_path"]) == Path("/tmp/ad_hoc/pipeline_log.txt")


def test_no_summary_pdf_when_summary_empty(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    result = run_ad_hoc_pipeline(title="SWE", description="job")
    assert result["pdf_path_summary"] is None


def test_summary_pdf_set_when_summary_generated(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.generate_summary.return_value = {"summary": "A great candidate.", "success": True}
    base_mocks.validate_summary_with_ollama.return_value = {
        "success": True,
        "accepted": True,
        "reasons": [],
    }

    base_mocks.compile_tex.side_effect = [
        {
            "compile_status": "ok",
            "fits_one_page": True,
            "page_count": 1,
            "pdf_path": "/tmp/out.pdf",
            "log_text": "",
        },
        {
            "compile_status": "ok",
            "fits_one_page": True,
            "page_count": 1,
            "pdf_path": "/tmp/out_summary.pdf",
            "log_text": "",
        },
    ]

    result = run_ad_hoc_pipeline(title="SWE", description="job")
    assert result["pdf_path_summary"] == "/tmp/out_summary.pdf"
    assert base_mocks.compile_tex.call_count == 2


def test_summary_context_includes_relevant_bullet_evidence(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [],
        "summary_keywords": ["backend services"],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    base_mocks.generate_summary.return_value = {"summary": "A great candidate.", "success": True}
    base_mocks.score_bullets_for_drop.return_value = [0.1, 0.9, 0.3, 0.2]

    run_ad_hoc_pipeline(title="SWE", description="job")

    candidate_context = base_mocks.generate_summary.call_args.args[0]
    assert "Relevant evidence:" in candidate_context
    assert "Improved SQL queries." in candidate_context


def test_keywords_partitioned_correctly(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    result = run_ad_hoc_pipeline(title="SWE", description="job")
    assert result["present_keywords"] == ["Python"]
    assert result["missing_keywords"] == ["MongoDB"]


def test_pipeline_uses_inferred_title_when_title_is_heading(base_mocks, monkeypatch):
    import fletcher.ad_hoc_pipeline as mod
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    monkeypatch.setattr(
        mod, "infer_title_from_description", lambda _description: "Software Engineer"
    )

    run_ad_hoc_pipeline(
        title="**About Us**",
        description="We are seeking a Software Engineer to join.",
    )

    assert base_mocks.classify_job.call_args.kwargs["title"] == "Software Engineer"
    assert base_mocks.extract_keywords.call_args.kwargs["title"] == "Software Engineer"


def test_rag_skipped_when_no_missing_keywords(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        ["Python", "MongoDB"],
        [],
        {"Python": [0], "MongoDB": [1]},
    )
    base_mocks.match_keywords_to_bullets.reset_mock()

    run_ad_hoc_pipeline(title="SWE", description="job")
    base_mocks.match_keywords_to_bullets.assert_not_called()


def test_rewrite_not_called_when_no_high_matches(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [],
        "summary_keywords": [],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    base_mocks.rewrite_bullet_targeted.reset_mock()

    run_ad_hoc_pipeline(title="SWE", description="job")
    base_mocks.rewrite_bullet_targeted.assert_not_called()


def test_one_high_rag_match_is_downgraded_to_summary(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        ["Azure DevOps", "React"],
        {"Azure DevOps": [], "React": []},
    )
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [
            {"bullet_idx": 1, "keyword": "Azure DevOps", "score": 0.9},
        ],
        "summary_keywords": [],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    base_mocks.generate_summary.return_value = {"summary": "Summary text.", "success": True}

    run_ad_hoc_pipeline(title="Software Developer", description="job")

    base_mocks.rewrite_bullet_targeted.assert_not_called()
    assert base_mocks.generate_summary.call_args.args[2] == ["Azure DevOps"]
    log_text = base_mocks.write_text.call_args.args[1]
    assert "rag_high_downgraded" in log_text
    assert "not_enough_high_matches_for_bullet_rewrite" in log_text


def test_two_high_rag_matches_are_rewritten(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        ["Azure DevOps", "React"],
        {"Azure DevOps": [], "React": []},
    )
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [
            {"bullet_idx": 1, "keyword": "Azure DevOps", "score": 0.9},
            {"bullet_idx": 2, "keyword": "React", "score": 0.88},
        ],
        "summary_keywords": [],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    base_mocks.generate_summary.return_value = {"summary": "Summary text.", "success": True}

    run_ad_hoc_pipeline(title="Software Developer", description="job")

    assert base_mocks.rewrite_bullet_targeted.call_count == 2
    log_text = base_mocks.write_text.call_args.args[1]
    assert "rag_high_downgraded" not in log_text


def test_compile_called_once_when_no_summary(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    run_ad_hoc_pipeline(title="SWE", description="job")
    assert base_mocks.compile_tex.call_count == 1


def test_compile_called_twice_when_summary_present(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.generate_summary.return_value = {"summary": "Great candidate.", "success": True}
    base_mocks.validate_summary_with_ollama.return_value = {
        "success": True,
        "accepted": True,
        "reasons": [],
    }
    run_ad_hoc_pipeline(title="SWE", description="job")
    assert base_mocks.compile_tex.call_count == 2


def test_summary_pdf_skipped_when_line_retry_fails(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.generate_summary.side_effect = [
        {"summary": "Too short.", "success": True},
        {"summary": "Still too short.", "success": True},
    ]
    base_mocks.validate_summary_with_ollama.return_value = {
        "success": True,
        "accepted": True,
        "reasons": [],
    }
    base_mocks._summary_line_count.return_value = ("ok", 2)

    result = run_ad_hoc_pipeline(title="SWE", description="job")

    assert result["pdf_path_summary"] is None
    assert result["llm_error"] == "summary_line_count_out_of_range"
    assert base_mocks.generate_summary.call_count == 2


def test_summary_pdf_accepted_when_line_check_unavailable(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.generate_summary.return_value = {"summary": "A great candidate.", "success": True}
    base_mocks.validate_summary_with_ollama.return_value = {
        "success": True,
        "accepted": True,
        "reasons": [],
    }
    base_mocks._summary_line_count.return_value = ("unavailable", None)
    base_mocks.compile_tex.side_effect = [
        {
            "compile_status": "ok",
            "fits_one_page": True,
            "page_count": 1,
            "pdf_path": "/tmp/out.pdf",
            "log_text": "",
        },
        {
            "compile_status": "ok",
            "fits_one_page": True,
            "page_count": 1,
            "pdf_path": "/tmp/out_summary.pdf",
            "log_text": "",
        },
    ]

    result = run_ad_hoc_pipeline(title="SWE", description="job")

    assert result["pdf_path_summary"] == "/tmp/out_summary.pdf"
    assert result["llm_error"] is None
    assert base_mocks.generate_summary.call_count == 1


def test_summary_pdf_skipped_when_line_check_fails(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.generate_summary.return_value = {"summary": "A great candidate.", "success": True}
    base_mocks.validate_summary_with_ollama.return_value = {
        "success": True,
        "accepted": True,
        "reasons": [],
    }
    base_mocks._summary_line_count.return_value = ("failed", None)

    result = run_ad_hoc_pipeline(title="SWE", description="job")

    assert result["pdf_path_summary"] is None
    assert result["llm_error"] == "summary_line_check_failed"
    assert base_mocks.generate_summary.call_count == 1


def test_rejected_keyword_does_not_flow_to_summary_generation(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.rewrite_bullet_targeted.return_value = {
        "bullet": "Improved SQL queries.",
        "success": False,
        "error": "rewrite_validation_failed",
        "duration_ms": 10,
        "keywords_used": [],
        "keywords_skipped": ["real-time threat intelligence"],
        "validation": {"accepted": False},
    }
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [
            {"bullet_idx": 1, "keyword": "real-time threat intelligence", "score": 0.85}
        ],
        "summary_keywords": ["Software Engineer"],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    base_mocks.generate_summary.return_value = {"summary": "Summary text.", "success": True}

    run_ad_hoc_pipeline(title="Software Engineer", description="job")

    assert "real-time threat intelligence" not in base_mocks.generate_summary.call_args.args[2]


def test_partial_rewrite_safe_keyword_gets_second_chance(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        ["React", "AI-driven platform", "TypeScript"],
        {"React": [], "AI-driven platform": [], "TypeScript": []},
    )
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [
            {"bullet_idx": 2, "keyword": "React", "score": 0.9},
            {"bullet_idx": 2, "keyword": "AI-driven platform", "score": 0.91},
            {"bullet_idx": 2, "keyword": "TypeScript", "score": 0.89},
        ],
        "summary_keywords": [],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    base_mocks.rewrite_bullet_targeted.side_effect = [
        {
            "bullet": "Created React dashboard.",
            "success": False,
            "error": "rewrite_validation_failed",
            "duration_ms": 1,
            "keywords_used": ["React"],
            "keywords_skipped": ["AI-driven platform"],
            "validation": {
                "accepted": False,
                "llm_validation": {"keywords_rejected": ["AI-driven platform"]},
            },
        },
        {
            "bullet": "Created a React/Next.js dashboard.",
            "success": True,
            "error": None,
            "duration_ms": 1,
            "keywords_used": ["React"],
            "keywords_skipped": [],
            "validation": {"accepted": True},
        },
    ]

    run_ad_hoc_pipeline(title="Software Engineer", description="React job")

    assert base_mocks.rewrite_bullet_targeted.call_count == 2
    assert base_mocks.rewrite_bullet_targeted.call_args_list[1].args[1] == ["React"]


def test_summary_keyword_fallback_caps_to_three_and_excludes_rejected_domains(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        [
            "unit",
            "integration",
            "end-to-end",
            "backend services",
            "real-time threat intelligence",
            "AI-driven platform",
            "XDR",
        ],
        {},
    )
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [
            {"bullet_idx": 1, "keyword": "real-time threat intelligence", "score": 0.9},
            {"bullet_idx": 2, "keyword": "AI-driven platform", "score": 0.9},
        ],
        "summary_keywords": [
            "unit",
            "integration",
            "end-to-end",
            "backend services",
            "XDR",
        ],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    base_mocks.rewrite_bullet_targeted.return_value = {
        "bullet": "original",
        "success": False,
        "error": "rewrite_validation_failed",
        "duration_ms": 1,
        "keywords_used": [],
        "keywords_skipped": ["real-time threat intelligence", "AI-driven platform"],
        "validation": {
            "accepted": False,
            "reasons": [
                "unsupported_domain_keyword:real-time threat intelligence",
                "unsupported_domain_keyword:AI-driven platform",
            ],
        },
    }
    base_mocks.generate_summary.return_value = {"summary": "Summary text.", "success": True}

    run_ad_hoc_pipeline(title="Software Engineer", description="job")

    summary_keywords = base_mocks.generate_summary.call_args.args[2]
    assert "unit" in summary_keywords
    assert "integration" in summary_keywords
    assert "real-time threat intelligence" not in summary_keywords
    assert "AI-driven platform" not in summary_keywords
    assert len(summary_keywords) == 3


def test_degree_keyword_flows_to_rag_if_extracted(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        ["Computer Engineering"],
        {"Computer Engineering": []},
    )
    base_mocks.rewrite_bullet_targeted.reset_mock()

    run_ad_hoc_pipeline(title="Software Development Intern", description="job")

    assert base_mocks.match_keywords_to_bullets.call_args.args[0] == ["Computer Engineering"]
    base_mocks.rewrite_bullet_targeted.assert_not_called()


def test_missing_keywords_flow_directly_to_rag(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        ["Product Manager", "China-based team", "CEO", "MBB", "Mandarin"],
        {},
    )
    run_ad_hoc_pipeline(title="Product Manager", description="job")

    assert base_mocks.match_keywords_to_bullets.call_args.args[0] == [
        "Product Manager",
        "China-based team",
        "CEO",
        "MBB",
        "Mandarin",
    ]


def test_all_extracted_missing_keywords_go_to_rag(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        ["React", "Product Manager", "China-based team", "A/B testing"],
        {},
    )

    run_ad_hoc_pipeline(title="Product Manager", description="job")

    rag_keywords = base_mocks.match_keywords_to_bullets.call_args.args[0]
    assert rag_keywords == ["React", "Product Manager", "China-based team", "A/B testing"]


def test_unknown_keyword_flows_to_rag_without_policy_router(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        ["component libraries"],
        {},
    )

    run_ad_hoc_pipeline(title="Full-Stack Application Developer", description="job")

    rag_keywords = base_mocks.match_keywords_to_bullets.call_args.args[0]
    assert rag_keywords == ["component libraries"]


def test_pipeline_no_longer_logs_keyword_cleanup(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        [
            "project coordination",
            "project metrics",
            "requirements",
            "dashboards",
            "analysis",
            "stakeholder communication",
            "planning",
            "process improvements",
            "Mandarin",
        ],
        {},
    )

    run_ad_hoc_pipeline(title="Associate Project Manager", description="job")

    log_text = base_mocks.write_text.call_args.args[1]
    assert "keyword_cleanup" not in log_text
    assert "keyword_policy_partition" not in log_text


def test_unknown_terms_flow_to_rag(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        ["term one", "term two"],
        {},
    )

    run_ad_hoc_pipeline(title="Data Analyst", description="job")

    assert base_mocks.match_keywords_to_bullets.call_args.args[0] == ["term one", "term two"]


def test_llm_policy_router_none_does_not_crash(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        ["project coordination"],
        {},
    )

    result = run_ad_hoc_pipeline(title="Associate Project Manager", description="job")

    assert result["compile_status"] == "ok"


def test_llm_job_fit_mismatch_aborts_without_fixed_role_terms(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.analyze_job_fit_with_ollama.return_value = {
        "success": True,
        "title": "Chief Something Officer",
        "role_family": "general",
        "job_level": "executive",
        "mismatch": True,
        "mismatch_reason": "executive role does not match supported tailoring target",
        "duration_ms": 1,
    }

    result = run_ad_hoc_pipeline(
        title="",
        description="Chief Something Officer role.",
    )

    assert result["compile_status"] == "failed"
    assert result["error_type"] == "JobMismatchError"
    assert base_mocks.enrich_with_ollama_if_enabled.call_count == 0


def test_llm_general_family_does_not_overwrite_specific_classification():
    from fletcher.ad_hoc_pipeline import _merge_llm_classification

    result = _merge_llm_classification(
        {
            "role_family": "infrastructure",
            "job_level": "mid",
            "confidence": 0.9,
            "reasons": [],
            "concern_flags": [],
        },
        {
            "success": True,
            "role_family": "general",
            "job_level": "mid",
            "confidence": 0.7,
            "reasons": [],
        },
    )

    assert result["role_family"] == "infrastructure"


def test_skill_bucket_output_drives_skill_additions(base_mocks):
    from fletcher.ad_hoc_pipeline import _add_keywords_to_skills

    doc = _make_parsed_doc()
    doc.experience[0].bullets.append("Built UnknownFutureDB reporting with SQL.")
    base_mocks.bucket_skill_keywords_with_ollama.return_value = {
        "success": True,
        "languages": ["SQL"],
        "frameworks": [],
        "developer_tools": ["UnknownFutureDB"],
        "ignored": ["data mining"],
    }

    added = _add_keywords_to_skills(
        doc,
        ["SQL", "data mining", "UnknownFutureDB"],
    )

    assert added == ["SQL", "UnknownFutureDB"]
    assert "data mining" not in doc.skills.languages


def test_skill_bucket_receives_all_skill_candidates_and_caps_total_additions(base_mocks):
    from fletcher.ad_hoc_pipeline import _add_keywords_to_skills

    doc = _make_parsed_doc()
    base_mocks.bucket_skill_keywords_with_ollama.return_value = {
        "success": True,
        "languages": ["PHP"],
        "frameworks": ["Angular"],
        "developer_tools": ["MySQL", "Linux scripting"],
        "ignored": [],
    }

    added = _add_keywords_to_skills(
        doc,
        ["PHP", "Angular", "MySQL", "Linux scripting", "project management", "Python"],
    )

    assert added == ["PHP", "Angular", "MySQL"]
    assert base_mocks.bucket_skill_keywords_with_ollama.call_args.kwargs["keywords"] == [
        "PHP",
        "Angular",
        "MySQL",
        "Linux scripting",
        "project management",
        "Python",
    ]


def test_skill_add_does_not_alias_go_golang(base_mocks):
    from fletcher.ad_hoc_pipeline import _add_keywords_to_skills

    doc = _make_parsed_doc()
    base_mocks.bucket_skill_keywords_with_ollama.return_value = {
        "success": True,
        "languages": ["Go", "Golang"],
        "frameworks": [],
        "developer_tools": [],
        "ignored": [],
    }

    added = _add_keywords_to_skills(doc, ["Go", "Golang"])

    assert added == ["Go", "Golang"]
    assert doc.skills.languages.count("Go") == 1
    assert "Golang" in doc.skills.languages


def test_summary_validation_visible_evidence_override_for_false_negative(base_mocks):
    from fletcher.ad_hoc_pipeline import PipelineLogger, _validate_summary_with_defense

    base_mocks.validate_summary_with_ollama.return_value = {
        "success": True,
        "accepted": False,
        "reasons": ["Next.js is not listed in the candidate evidence."],
    }
    base_mocks.validate_summary_grounding.return_value = {"accepted": True, "reasons": []}

    validation, mode = _validate_summary_with_defense(
        summary="Software developer with Next.js experience.",
        candidate_context="Built a responsive UI using Next.js and Framer Motion.",
        keywords=[],
        logger=PipelineLogger(),
    )

    assert validation["accepted"] is True
    assert mode == "deterministic_fast"
    base_mocks.validate_summary_with_ollama.assert_not_called()


def test_quality_terms_do_not_route_to_bullet_rewrite(base_mocks):
    from fletcher.ad_hoc_pipeline import _keyword_rewrite_eligible

    assert _keyword_rewrite_eligible("communication") is False


def test_slash_stack_keywords_are_split_before_partition(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.enrich_with_ollama_if_enabled.return_value = (
        {},
        {
            "must_have_terms": [
                "Java/Kotlin",
                "Docker/Kubernetes",
                "Spring Boot/Spring Cloud",
                "A/B testing",
            ]
        },
        {},
    )

    result = run_ad_hoc_pipeline(title="AI Developer Intern", description="job")

    assert result["keywords"] == [
        "Java",
        "Kotlin",
        "Docker",
        "Kubernetes",
        "Spring Boot",
        "Spring Cloud",
        "A/B testing",
    ]
    partition_keywords = base_mocks.partition_keywords.call_args.args[0]
    assert partition_keywords == result["keywords"]


def test_ci_cd_phrase_is_not_split():
    from fletcher.ad_hoc_pipeline import _normalize_extracted_keywords

    assert _normalize_extracted_keywords(["CI/CD pipelines", "A/B testing"]) == [
        "CI/CD pipelines",
        "A/B testing",
    ]


def test_popular_ide_keywords_are_removed_before_partition(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.enrich_with_ollama_if_enabled.return_value = (
        {},
        {"must_have_terms": ["Android Studio", "Xcode", "Swift", "Appium"]},
        {},
    )

    result = run_ad_hoc_pipeline(title="SDET", description="mobile testing job")

    partition_keywords = base_mocks.partition_keywords.call_args.args[0]
    assert partition_keywords == ["Swift", "Appium"]
    assert result["keywords"] == ["Swift", "Appium"]


def test_combined_job_fit_keywords_skip_separate_keyword_extract(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.analyze_job_fit_with_ollama.return_value = {
        "success": True,
        "title": "Full-Stack Application Developer",
        "role_family": "software",
        "job_level": "mid",
        "mismatch": False,
        "mismatch_reason": "",
        "jd_usable": True,
        "jd_usable_reason": "Detailed software role.",
        "keywords": ["C#", ".NET/Angular", "code reviews"],
        "duration_ms": 12,
    }

    result = run_ad_hoc_pipeline(title="", description="job")

    assert result["keywords"] == ["C#", ".NET", "Angular", "code reviews"]
    assert base_mocks.enrich_with_ollama_if_enabled.call_count == 0
    partition_keywords = base_mocks.partition_keywords.call_args.args[0]
    assert partition_keywords == result["keywords"]


def test_combined_job_fit_ignores_legacy_keyword_routes(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.analyze_job_fit_with_ollama.return_value = {
        "success": True,
        "title": "Backend Developer",
        "role_family": "software",
        "job_level": "mid",
        "mismatch": False,
        "mismatch_reason": "",
        "jd_usable": True,
        "jd_usable_reason": "Detailed role.",
        "keywords": ["RabbitMQ"],
        "keyword_routes": {
            "RabbitMQ": {
                "route": "skills_only",
                "kind": "tool",
                "reason": "named queueing tool",
            }
        },
        "duration_ms": 12,
    }
    base_mocks.partition_keywords.return_value = ([], ["RabbitMQ"], {"RabbitMQ": []})
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [],
        "summary_keywords": [],
        "ignored_keywords": [],
        "scores": [{"keyword": "RabbitMQ", "tier": "mid", "score": 0.74}],
        "rag_used": True,
    }

    run_ad_hoc_pipeline(title="", description="job")

def test_keyword_present_partition_includes_skills(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    parsed = _make_parsed_doc()
    parsed.skills.languages = ["Rust"]
    base_mocks.parse_resume_file.return_value = parsed
    base_mocks.analyze_job_fit_with_ollama.return_value = {
        "success": True,
        "title": "Software Developer",
        "role_family": "software",
        "job_level": "mid",
        "mismatch": False,
        "mismatch_reason": "",
        "jd_usable": True,
        "jd_usable_reason": "Detailed role.",
        "keywords": ["Rust"],
        "duration_ms": 12,
    }

    run_ad_hoc_pipeline(title="", description="job")

    surfaces = base_mocks.partition_keywords.call_args.args[1]
    assert "Rust" in surfaces


def test_skills_only_keywords_are_considered_for_skills(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    parsed = _make_parsed_doc()
    parsed.experience[0].bullets.append("Integrated RabbitMQ for queue-backed processing.")
    base_mocks.parse_resume_file.return_value = parsed
    base_mocks.analyze_job_fit_with_ollama.return_value = {
        "success": True,
        "title": "Software Developer",
        "role_family": "software",
        "job_level": "mid",
        "mismatch": False,
        "mismatch_reason": "",
        "jd_usable": True,
        "jd_usable_reason": "Detailed role.",
        "keywords": ["RabbitMQ"],
        "duration_ms": 12,
    }
    base_mocks.partition_keywords.return_value = (
        [],
        ["RabbitMQ"],
        {"RabbitMQ": []},
    )
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [],
        "summary_keywords": ["RabbitMQ"],
        "ignored_keywords": [],
        "scores": [{"keyword": "RabbitMQ", "tier": "mid", "score": 0.74, "bullet_idx": 4}],
        "rag_used": True,
    }
    base_mocks.bucket_skill_keywords_with_ollama.return_value = {
        "success": True,
        "languages": [],
        "frameworks": [],
        "developer_tools": ["RabbitMQ"],
        "ignored": [],
    }

    run_ad_hoc_pipeline(title="", description="job")

    log_text = base_mocks.write_text.call_args.args[1]
    assert "skills_keywords_added" in log_text
    assert "RabbitMQ" in log_text


def test_summary_variant_reuses_skill_enrichment(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    parsed = _make_parsed_doc()
    parsed.experience[0].bullets.append("Integrated RabbitMQ for queue-backed processing.")
    base_mocks.parse_resume_file.return_value = parsed
    base_mocks.analyze_job_fit_with_ollama.return_value = {
        "success": True,
        "title": "Software Developer",
        "role_family": "software",
        "job_level": "mid",
        "mismatch": False,
        "mismatch_reason": "",
        "jd_usable": True,
        "jd_usable_reason": "Detailed role.",
        "keywords": ["RabbitMQ"],
        "duration_ms": 12,
    }
    base_mocks.partition_keywords.return_value = (
        [],
        ["RabbitMQ"],
        {"RabbitMQ": []},
    )
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [],
        "summary_keywords": ["RabbitMQ"],
        "ignored_keywords": [],
        "scores": [{"keyword": "RabbitMQ", "tier": "mid", "score": 0.74, "bullet_idx": 4}],
        "rag_used": True,
    }
    base_mocks.generate_summary.return_value = {
        "summary": "Software developer summary.",
        "success": True,
    }
    base_mocks.validate_summary_with_ollama.return_value = {
        "success": True,
        "accepted": True,
        "reasons": [],
    }
    base_mocks.bucket_skill_keywords_with_ollama.return_value = {
        "success": True,
        "languages": [],
        "frameworks": [],
        "developer_tools": ["RabbitMQ"],
        "ignored": [],
    }

    run_ad_hoc_pipeline(title="", description="job")

    assert base_mocks.bucket_skill_keywords_with_ollama.call_count == 1
    log_text = base_mocks.write_text.call_args.args[1]
    assert "skills_keyword_reuse" in log_text


def test_medium_rag_named_keyword_can_flow_to_skills(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.enrich_with_ollama_if_enabled.return_value = (
        {},
        {"must_have_terms": ["Angular"]},
        {},
    )
    base_mocks.partition_keywords.return_value = (
        [],
        ["Angular"],
        {"Angular": []},
    )
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [],
        "summary_keywords": ["Angular"],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    base_mocks.bucket_skill_keywords_with_ollama.return_value = {
        "success": True,
        "languages": [],
        "frameworks": ["Angular"],
        "developer_tools": [],
        "ignored": [],
    }

    run_ad_hoc_pipeline(title="Frontend Developer", description="Angular job")

    assert base_mocks.bucket_skill_keywords_with_ollama.call_args.kwargs["keywords"] == ["Angular"]
    log_text = base_mocks.write_text.call_args.args[1]
    assert "skills_keywords_added" in log_text
    assert "Angular" in log_text


def test_low_rag_named_keyword_does_not_flow_to_skills(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.enrich_with_ollama_if_enabled.return_value = (
        {},
        {"must_have_terms": ["Snowflake"]},
        {},
    )
    base_mocks.partition_keywords.return_value = (
        [],
        ["Snowflake"],
        {"Snowflake": []},
    )
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [],
        "summary_keywords": [],
        "ignored_keywords": ["Snowflake"],
        "scores": [{"keyword": "Snowflake", "tier": "low", "score": 0.22, "bullet_idx": 1}],
        "rag_used": True,
    }
    base_mocks.bucket_skill_keywords_with_ollama.return_value = {
        "success": True,
        "languages": [],
        "frameworks": [],
        "developer_tools": ["Snowflake"],
        "ignored": [],
    }

    run_ad_hoc_pipeline(title="Data Engineer", description="Snowflake job")

    base_mocks.bucket_skill_keywords_with_ollama.assert_not_called()


def test_non_skill_medium_keywords_are_sent_to_skill_llm_for_rejection(base_mocks):
    from fletcher.ad_hoc_pipeline import _add_keywords_to_skills

    doc = _make_parsed_doc()
    base_mocks.bucket_skill_keywords_with_ollama.return_value = {
        "success": True,
        "languages": [],
        "frameworks": [],
        "developer_tools": [],
        "ignored": ["project management", "collaboration"],
    }

    added = _add_keywords_to_skills(doc, ["project management", "collaboration"])

    assert added == []
    assert base_mocks.bucket_skill_keywords_with_ollama.call_args.kwargs["keywords"] == [
        "project management",
        "collaboration",
    ]


def test_small_summary_keyword_set_uses_llm_filter(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        ["collaboration", "communication"],
        {"collaboration": [], "communication": []},
    )
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [],
        "summary_keywords": ["collaboration", "communication"],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }

    run_ad_hoc_pipeline(title="SWE", description="job")

    assert base_mocks.filter_summary_keywords_with_ollama.call_count == 1
    log_text = base_mocks.write_text.call_args.args[1]
    assert "deterministic_fast_path" not in log_text


def test_pipeline_summary_digest_logged(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        ["Python"],
        ["MongoDB"],
        {"Python": [0], "MongoDB": []},
    )

    run_ad_hoc_pipeline(title="SWE", description="job")

    log_text = base_mocks.write_text.call_args.args[1]
    assert "pipeline_debug_summary" in log_text
    assert "Keywords Found" in log_text
    assert "RAG Levels" in log_text
    assert "Bullet Rewrites" in log_text
    assert "Summary Keywords" in log_text
    assert "Dropped Bullets" in log_text


def test_pipeline_summary_digest_is_human_readable(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        ["Python"],
        ["MongoDB"],
        {"Python": [0], "MongoDB": []},
    )

    run_ad_hoc_pipeline(title="SWE", description="job")

    log_text = base_mocks.write_text.call_args.args[1]
    assert "== Pipeline Debug Summary ==" in log_text
    assert "Keywords Found" in log_text
    assert "RAG Levels" in log_text
    assert "Bullet Rewrites" in log_text
    assert "Summary Keywords" in log_text
    assert "Dropped Bullets" in log_text
    assert "  - Python" in log_text


def test_summary_banned_tone_retries_even_when_llm_validator_accepts(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline
    from fletcher.llm.llm_enrich import validate_summary_grounding

    base_mocks.validate_summary_grounding.side_effect = validate_summary_grounding
    base_mocks.generate_summary.side_effect = [
        {
            "summary": "Eager to apply strong development skills in an internship.",
            "success": True,
            "duration_ms": 1,
        },
        {
            "summary": "Software developer with supported backend delivery experience.",
            "success": True,
            "duration_ms": 1,
        },
    ]
    base_mocks.validate_summary_with_ollama.return_value = {
        "success": True,
        "accepted": True,
        "reasons": [],
    }

    run_ad_hoc_pipeline(title="SWE Intern", description="job")

    assert base_mocks.generate_summary.call_count >= 2


def test_single_keyword_rewrite_failure_does_not_retry(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        ["Azure DevOps"],
        {"Azure DevOps": []},
    )
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [
            {"bullet_idx": 1, "keyword": "Azure DevOps", "score": 0.9},
            {"bullet_idx": 1, "keyword": "Azure DevOps", "score": 0.89},
            {"bullet_idx": 1, "keyword": "Azure DevOps", "score": 0.88},
        ],
        "summary_keywords": [],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    base_mocks.rewrite_bullet_targeted.return_value = {
        "bullet": "Improved SQL queries.",
        "success": False,
        "error": "rewrite_validation_failed",
        "duration_ms": 1,
        "keywords_used": ["Azure DevOps"],
        "keywords_skipped": ["Azure DevOps"],
        "validation": {
            "accepted": False,
            "llm_validation": {"keywords_rejected": ["Azure DevOps"]},
        },
    }

    run_ad_hoc_pipeline(title="Software Development Intern", description="job")

    assert base_mocks.rewrite_bullet_targeted.call_count == 1


def test_claimed_presence_subset_gets_retry(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        ["data exploration", "Automate data pipelines"],
        {"data exploration": [], "Automate data pipelines": []},
    )
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [
            {"bullet_idx": 1, "keyword": "data exploration", "score": 0.9},
            {"bullet_idx": 1, "keyword": "Automate data pipelines", "score": 0.9},
            {"bullet_idx": 1, "keyword": "Automate data pipelines", "score": 0.89},
        ],
        "summary_keywords": [],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    base_mocks.rewrite_bullet_targeted.side_effect = [
        {
            "bullet": "Improved SQL queries.",
            "success": False,
            "error": "claimed_keyword_missing",
            "duration_ms": 1,
            "keywords_used": [],
            "keywords_skipped": ["data exploration", "Automate data pipelines"],
            "presence_supported_keywords": ["Automate data pipelines"],
        },
        {
            "bullet": "Improved SQL queries while automating data pipelines.",
            "success": True,
            "error": None,
            "duration_ms": 1,
            "keywords_used": ["Automate data pipelines"],
            "keywords_skipped": [],
            "validation": {"accepted": True},
        },
    ]

    run_ad_hoc_pipeline(title="Data Engineer Intern", description="job")

    assert base_mocks.rewrite_bullet_targeted.call_count == 2
    assert base_mocks.rewrite_bullet_targeted.call_args_list[1].args[1] == [
        "Automate data pipelines"
    ]


def test_rewrite_assignment_caps_keywords_and_uses_alternate_bullets():
    from fletcher.ad_hoc_pipeline import _select_rewrite_assignments

    matches = [
        {
            "keyword": "alpha",
            "bullet_idx": 0,
            "score": 0.95,
            "candidates": [{"bullet_idx": 0, "score": 0.95}, {"bullet_idx": 1, "score": 0.9}],
        },
        {
            "keyword": "beta",
            "bullet_idx": 0,
            "score": 0.94,
            "candidates": [{"bullet_idx": 0, "score": 0.94}, {"bullet_idx": 1, "score": 0.89}],
        },
        {
            "keyword": "gamma",
            "bullet_idx": 0,
            "score": 0.93,
            "candidates": [{"bullet_idx": 0, "score": 0.93}, {"bullet_idx": 1, "score": 0.92}],
        },
    ]

    assigned = _select_rewrite_assignments(matches, max_keywords_per_bullet=2)

    assert len(assigned[0]) == 2
    assert assigned[1] == ["gamma"]


def test_summary_retry_removes_keywords_named_in_validation_reasons(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.partition_keywords.return_value = (
        [],
        ["executive-ready insights", "strategic plans", "collaboration"],
        {},
    )
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [],
        "summary_keywords": ["executive-ready insights", "strategic plans", "collaboration"],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    base_mocks.generate_summary.side_effect = [
        {"summary": "Bad summary.", "success": True, "duration_ms": 1},
        {"summary": "Better summary.", "success": True, "duration_ms": 1},
    ]
    base_mocks.validate_summary_with_ollama.side_effect = [
        {
            "success": True,
            "accepted": False,
            "reasons": ["executive-ready insights and strategic plans unsupported"],
        },
        {"success": True, "accepted": True, "reasons": []},
    ]

    run_ad_hoc_pipeline(title="Product Manager", description="job")

    assert base_mocks.generate_summary.call_args_list[1].args[2] == ["collaboration"]


def test_bucket_below_floor_excluded(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    doc = _make_parsed_doc()
    doc.projects[0].bullets = ["Only one."]
    base_mocks.parse_resume_file.return_value = doc

    run_ad_hoc_pipeline(title="SWE", description="job")

    active_bullets = base_mocks.match_keywords_to_bullets.call_args.args[1]
    assert active_bullets == ["Built Python service.", "Improved SQL queries."]


def test_fit_to_page_drops_lowest_relevance_candidate(monkeypatch):
    import fletcher.ad_hoc_pipeline as mod
    from fletcher.pipeline_logger import PipelineLogger

    doc = _make_parsed_doc()
    doc.experience[0].bullets.append("Maintained CI pipeline.")
    active = [("exp", "exp0"), ("proj", "proj0")]
    _bullets, sources = mod._collect_active_bullets(doc, active)
    scores = {
        sources[0]["bullet_id"]: 0.9,
        sources[1]["bullet_id"]: 0.1,
        sources[2]["bullet_id"]: 0.7,
        sources[3]["bullet_id"]: 0.2,
        sources[4]["bullet_id"]: 0.8,
    }
    compile_results = [
        ({"compile_status": "ok", "fits_one_page": False, "page_count": 2}, "/tmp/out.tex"),
        ({"compile_status": "ok", "fits_one_page": True, "page_count": 1}, "/tmp/out.tex"),
    ]
    monkeypatch.setattr(mod, "_compile_doc", MagicMock(side_effect=compile_results))

    cr, _tex, removed = mod._fit_to_page(
        Path("/tmp"), doc, "output", sources, scores, PipelineLogger()
    )

    assert cr["fits_one_page"] is True
    assert removed is None
    assert doc.experience[0].bullets == ["Built Python service.", "Maintained CI pipeline."]


def test_bullet_order_boost_makes_first_bullet_harder_to_drop(monkeypatch):
    import fletcher.ad_hoc_pipeline as mod

    monkeypatch.setattr(mod, "score_bullets_for_drop", lambda _bullets, _keywords: [0.4, 0.4])
    sources = [
        {
            "bullet_id": "first",
            "original_local_idx": 0,
            "original_bullet_count": 2,
        },
        {
            "bullet_id": "last",
            "original_local_idx": 1,
            "original_bullet_count": 2,
        },
    ]

    scores = mod._score_sources(["First bullet.", "Last bullet."], sources, ["Python"])
    details = mod._score_details(["First bullet.", "Last bullet."], sources, ["Python"])

    assert scores["first"] == 0.6
    assert scores["last"] == 0.4
    assert details["first"]["score_order_multiplier"] == 1.5
    assert details["last"]["score_order_multiplier"] == 1.0


def test_fit_to_page_removes_bucket_at_floor(monkeypatch):
    import fletcher.ad_hoc_pipeline as mod
    from fletcher.pipeline_logger import PipelineLogger

    doc = _make_parsed_doc()
    active = [("exp", "exp0"), ("proj", "proj0")]
    _bullets, sources = mod._collect_active_bullets(doc, active)
    scores = {source["bullet_id"]: 0.5 for source in sources}
    monkeypatch.setattr(
        mod,
        "_compile_doc",
        MagicMock(
            return_value=(
                {"compile_status": "ok", "fits_one_page": False, "page_count": 2},
                "/tmp/out.tex",
            )
        ),
    )

    _cr, _tex, removed = mod._fit_to_page(
        Path("/tmp"), doc, "output", sources, scores, PipelineLogger()
    )

    assert removed == ("exp", "exp0")
    assert doc.experience == []
