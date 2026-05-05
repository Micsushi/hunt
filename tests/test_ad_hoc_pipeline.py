"""Tests for fletcher.ad_hoc_pipeline.run_ad_hoc_pipeline."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest


def test_import():
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    assert callable(run_ad_hoc_pipeline)


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
                bullets=["Created React dashboard."],
            )
        ],
        skills=SkillsSection(languages=["Python"]),
    )


def _compile_ok(pdf: str = "/tmp/output.pdf"):
    return (
        "so_path",
        {"compile_status": "ok", "fits_one_page": True, "page_count": 1, "pdf_path": pdf},
        "/tmp/out.tex",
        [],
    )


@pytest.fixture()
def base_mocks(monkeypatch):
    """Monkeypatch all external calls in ad_hoc_pipeline for unit tests."""
    import fletcher.ad_hoc_pipeline as mod

    monkeypatch.setattr(mod, "parse_resume_file", MagicMock(return_value=_make_parsed_doc()))
    monkeypatch.setattr(mod, "classify_job", MagicMock(return_value={}))
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
            return_value={"bullet": "Improved MongoDB queries.", "success": True, "error": None}
        ),
    )
    monkeypatch.setattr(
        mod, "generate_summary", MagicMock(return_value={"summary": "", "success": False})
    )
    monkeypatch.setattr(mod, "_compile_with_fit_retry", MagicMock(return_value=_compile_ok()))
    monkeypatch.setattr(mod, "ensure_dir", MagicMock(return_value=Path("/tmp/ad_hoc")))
    monkeypatch.setattr(mod, "build_attempt_dir", MagicMock(return_value=Path("/tmp/ad_hoc")))
    monkeypatch.setattr(mod, "write_json", MagicMock(return_value="/tmp/keywords.json"))
    monkeypatch.setattr(mod, "write_text", MagicMock(return_value="/tmp/pipeline_log.txt"))
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
    assert result["log_path"] == "/tmp/pipeline_log.txt"


def test_no_summary_pdf_when_summary_empty(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    result = run_ad_hoc_pipeline(title="SWE", description="job")
    assert result["pdf_path_summary"] is None


def test_summary_pdf_set_when_summary_generated(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.generate_summary.return_value = {"summary": "A great candidate.", "success": True}

    call_count = [0]

    def compile_side_effect(*args, **kwargs):
        call_count[0] += 1
        pdf = "/tmp/out_summary.pdf" if call_count[0] == 2 else "/tmp/out.pdf"
        return (
            "so",
            {"compile_status": "ok", "fits_one_page": True, "page_count": 1, "pdf_path": pdf},
            "/tmp/t.tex",
            [],
        )

    base_mocks._compile_with_fit_retry.side_effect = compile_side_effect

    result = run_ad_hoc_pipeline(title="SWE", description="job")
    assert result["pdf_path_summary"] == "/tmp/out_summary.pdf"
    assert call_count[0] == 2


def test_keywords_partitioned_correctly(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    result = run_ad_hoc_pipeline(title="SWE", description="job")
    assert result["present_keywords"] == ["Python"]
    assert result["missing_keywords"] == ["MongoDB"]


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


def test_compile_called_once_when_no_summary(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    run_ad_hoc_pipeline(title="SWE", description="job")
    assert base_mocks._compile_with_fit_retry.call_count == 1


def test_compile_called_twice_when_summary_present(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.generate_summary.return_value = {"summary": "Great candidate.", "success": True}
    run_ad_hoc_pipeline(title="SWE", description="job")
    assert base_mocks._compile_with_fit_retry.call_count == 2
