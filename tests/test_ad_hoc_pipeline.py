"""Tests for fletcher.ad_hoc_pipeline.run_ad_hoc_pipeline."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest


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
def base_mocks(monkeypatch, tmp_path):
    """Monkeypatch all external calls in ad_hoc_pipeline for unit tests."""
    import fletcher.ad_hoc_pipeline as mod

    monkeypatch.setattr(mod, "parse_resume_file", MagicMock(return_value=_make_parsed_doc()))
    monkeypatch.setattr(mod, "classify_job", MagicMock(return_value={}))
    monkeypatch.setattr(
        mod,
        "analyze_job_fit_with_ollama",
        MagicMock(return_value={"success": False, "title": ""}),
    )
    monkeypatch.setattr(
        mod,
        "extract_keywords_with_ollama",
        MagicMock(return_value={"success": False, "keywords": []}),
    )
    monkeypatch.setattr(
        mod,
        "filter_summary_keywords_with_ollama",
        MagicMock(return_value={"success": False, "included": [], "excluded": []}),
        raising=False,
    )
    monkeypatch.setattr(
        mod,
        "validate_summary_with_ollama",
        MagicMock(return_value={"success": False, "accepted": True, "reasons": []}),
        raising=False,
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
        mod,
        "generate_summary",
        MagicMock(return_value={"summary": "", "success": False}),
        raising=False,
    )
    monkeypatch.setattr(
        mod,
        "validate_summary_grounding",
        MagicMock(return_value={"accepted": True, "reasons": []}),
        raising=False,
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
    from fletcher.resume import source_summary

    monkeypatch.setattr(source_summary, "compile_tex", mod.compile_tex)
    monkeypatch.setattr(mod, "score_bullets_for_drop", MagicMock(return_value=[0.9, 0.4, 0.7, 0.6]))
    monkeypatch.setattr(mod, "_summary_line_count", MagicMock(return_value=("ok", 4)))
    attempt_dir = tmp_path / "ad_hoc"
    attempt_dir.mkdir()
    monkeypatch.setattr(mod, "ensure_dir", MagicMock(return_value=attempt_dir))
    monkeypatch.setattr(mod, "build_attempt_dir", MagicMock(return_value=attempt_dir))
    monkeypatch.setattr(mod, "write_json", MagicMock(return_value="/tmp/keywords.json"))
    monkeypatch.setattr(mod, "write_text", MagicMock(side_effect=lambda path, _content: str(path)))
    monkeypatch.setattr(mod._config, "RAG_ENABLED", True)
    from fletcher.llm import llm_enrich

    for name in (
        "filter_summary_keywords_with_ollama",
        "generate_summary",
        "validate_summary_with_ollama",
        "validate_summary_grounding",
    ):
        monkeypatch.setattr(llm_enrich, name, getattr(mod, name))
    return mod


@pytest.mark.parametrize("scenario", ["no_source", "ready", "compile_failure"])
def test_summary_variant_preserves_the_primary_pdf(base_mocks, scenario):
    if scenario == "no_source":
        parsed = base_mocks.parse_resume_file.return_value
        parsed.experience[0].title_company_location = ""
        parsed.projects[0].project_title = ""
    ready = base_mocks.compile_tex.return_value
    summary = dict(ready, pdf_path="/tmp/out_summary.pdf")
    if scenario == "compile_failure":
        summary.update(compile_status="failed", fits_one_page=False, page_count=None, pdf_path=None)
    base_mocks.compile_tex.side_effect = [
        dict(ready, pdf_path="/tmp/starting.pdf"),
        dict(ready, pdf_path="/tmp/out.pdf"),
        summary,
    ]
    result = base_mocks.run_ad_hoc_pipeline(title="SWE", description="job")
    assert result["starting_pdf_path"] == "/tmp/starting.pdf"
    assert result["pdf_path"] == "/tmp/out.pdf"
    assert result["compile_status"] == "ok"
    assert result["llm_error"] is None
    assert result["pdf_path_summary"] == ("/tmp/out_summary.pdf" if scenario == "ready" else None)
    if scenario != "no_source":
        assert base_mocks.compile_tex.call_count == 3
    if scenario == "compile_failure":
        assert "could not be compiled" in result["summary_notice"]
        assert "generated no-summary PDF is available" in result["summary_notice"]


def test_option_b_projects_only_resume_runs_without_skills_section(base_mocks):
    from fletcher.resume.models import SkillsSection

    parsed = _make_parsed_doc()
    parsed.experience = []
    parsed.skills = SkillsSection()
    base_mocks.parse_resume_file.return_value = parsed
    base_mocks.partition_keywords.return_value = (
        ["Python"],
        ["FastAPI"],
        {"Python": [], "FastAPI": [0]},
    )
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [{"bullet_idx": 1, "keyword": "FastAPI", "score": 0.85}],
        "summary_keywords": [],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }

    events = []
    result = base_mocks.run_ad_hoc_pipeline(
        title="SWE",
        description="Python FastAPI job",
        progress_callback=lambda step, detail: events.append((step, detail)),
    )

    assert result["compile_status"] == "ok"
    structure = next(detail for step, detail in events if step == "resume_structure")
    assert "Experience" in structure["missing_optional_sections"]
    assert "Technical Skills" in structure["missing_optional_sections"]


def test_short_source_summary_is_preserved_without_padding_or_keyword_injection(base_mocks):
    base_mocks.parse_resume_file.return_value.summary = "Built Python service."
    base_mocks._summary_line_count.return_value = ("ok", 1)
    base_mocks.partition_keywords.return_value = (
        [],
        ["executive-ready insights", "strategic plans"],
        {},
    )
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [],
        "summary_keywords": ["executive-ready insights", "strategic plans"],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    result = base_mocks.run_ad_hoc_pipeline(title="Product Manager", description="job")
    summary = json.loads((Path(result["attempt_dir"]) / "source_summary.json").read_text())[
        "summary"
    ]
    assert "executive-ready insights" not in summary
    assert "strategic plans" not in summary
    assert summary == "Built Python service."
    assert result["pdf_path_summary"] is not None
    assert result["llm_error"] is None
    assert base_mocks.compile_tex.call_count == 3
    base_mocks._summary_line_count.assert_not_called()
    base_mocks.generate_summary.assert_not_called()
    base_mocks.validate_summary_with_ollama.assert_not_called()


@pytest.mark.parametrize("experience_count", [1, 2])
def test_single_bullet_entries_preserved_when_resume_fits(base_mocks, experience_count):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    doc = _make_parsed_doc()
    doc.experience[0].bullets = doc.experience[0].bullets[:experience_count]
    doc.projects[0].bullets = ["Only one."]
    base_mocks.parse_resume_file.return_value = doc

    result = run_ad_hoc_pipeline(title="SWE", description="job")

    active_bullets = base_mocks.match_keywords_to_bullets.call_args.args[1]
    assert active_bullets == doc.experience[0].bullets + ["Only one."]
    assert result["compile_status"] == "ok"
    assert result["fits_one_page"] is True
    output = next(
        call.args[1]
        for call in base_mocks.write_text.call_args_list
        if Path(call.args[0]).name == "output.tex"
    )
    assert "Side Project" in output
    assert output.count("Only one.") == 1


@pytest.mark.parametrize("bullets", [[], [" "]])
def test_empty_entries_still_excluded(base_mocks, bullets):
    doc = _make_parsed_doc()
    doc.projects[0].bullets = bullets
    base_mocks.parse_resume_file.return_value = doc

    result = base_mocks.run_ad_hoc_pipeline(title="SWE", description="job")

    assert result["compile_status"] == "ok"
    assert base_mocks.match_keywords_to_bullets.call_args.args[1] == doc.experience[0].bullets


def test_single_bullet_resume_reports_failure_when_no_entry_fits(base_mocks):
    doc = _make_parsed_doc()
    doc.experience[0].bullets = ["One experience statement."]
    doc.projects[0].bullets = ["One project statement."]
    base_mocks.parse_resume_file.return_value = doc
    base_mocks.compile_tex.return_value.update(fits_one_page=False, page_count=2)

    result = base_mocks.run_ad_hoc_pipeline(title="SWE", description="job")

    assert result["compile_status"] == "failed"
    assert result["fits_one_page"] is False
    assert result["pdf_path"] is None
    assert result["llm_error"] == "all_buckets_exhausted"
    assert doc.experience[0].bullets == ["One experience statement."]
    assert doc.projects[0].bullets == ["One project statement."]


@pytest.mark.parametrize("bullet_count", [1, 2])
def test_fit_to_page_removes_bucket_at_or_below_floor(monkeypatch, bullet_count):
    import fletcher.ad_hoc_pipeline as mod
    from fletcher.pipeline_logger import PipelineLogger

    doc = _make_parsed_doc()
    doc.experience[0].bullets = doc.experience[0].bullets[:bullet_count]
    doc.projects[0].bullets = doc.projects[0].bullets[:bullet_count]
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
