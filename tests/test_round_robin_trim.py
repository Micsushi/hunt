"""Tests for _trim_one_bullet_per_entry round-robin page-fit trim."""

from __future__ import annotations

from fletcher.pipeline import _trim_one_bullet_per_entry
from fletcher.resume.models import (
    EducationEntry,
    EducationSection,
    ExperienceEntry,
    ProjectEntry,
    ResumeDocument,
    ResumeHeader,
    SkillsSection,
)


def _make_doc(
    exp_bullets: list[list[str]],
    proj_bullets: list[list[str]],
) -> ResumeDocument:
    exp = [
        ExperienceEntry(
            entry_id=f"exp{i}",
            title_company_location=f"Job {i}",
            date_text="2020-2024",
            bullets=list(b),
        )
        for i, b in enumerate(exp_bullets)
    ]
    proj = [
        ProjectEntry(
            entry_id=f"proj{i}",
            project_title=f"Project {i}",
            date_or_link_text="2023",
            bullets=list(b),
        )
        for i, b in enumerate(proj_bullets)
    ]
    return ResumeDocument(
        source_path="test.tex",
        preamble="",
        header=ResumeHeader(name="Test", contact_line="email@test.com"),
        education=EducationSection(
            entry=EducationEntry(entry_id="edu0", institution_and_degree="BSc", date_text="2020")
        ),
        experience=exp,
        projects=proj,
        skills=SkillsSection(),
    )


def _make_so(doc: ResumeDocument) -> dict:
    return {
        "experience_entries": [
            {"entry_id": e.entry_id, "bullet_plan": list(e.bullets)} for e in doc.experience
        ],
        "project_entries": [
            {"entry_id": p.entry_id, "bullet_plan": list(p.bullets)} for p in doc.projects
        ],
    }


class TestTrimOneBulletPerEntry:
    def test_removes_one_bullet_from_each_project(self):
        doc = _make_doc(exp_bullets=[["a", "b"]], proj_bullets=[["x", "y", "z"], ["p", "q"]])
        so = _make_so(doc)
        result = _trim_one_bullet_per_entry(doc, so)
        assert result is True
        assert len(doc.projects[0].bullets) == 2
        assert len(doc.projects[1].bullets) == 1

    def test_removes_one_bullet_from_each_experience(self):
        doc = _make_doc(exp_bullets=[["a", "b", "c"], ["d", "e"]], proj_bullets=[])
        so = _make_so(doc)
        result = _trim_one_bullet_per_entry(doc, so)
        assert result is True
        assert len(doc.experience[0].bullets) == 2
        assert len(doc.experience[1].bullets) == 1

    def test_projects_trimmed_before_experience(self):
        doc = _make_doc(
            exp_bullets=[["a", "b", "c"]],
            proj_bullets=[["x", "y"]],
        )
        so = _make_so(doc)
        _trim_one_bullet_per_entry(doc, so)
        assert len(doc.projects[0].bullets) == 1
        assert len(doc.experience[0].bullets) == 2

    def test_does_not_trim_single_bullet_entries(self):
        doc = _make_doc(
            exp_bullets=[["only one"]],
            proj_bullets=[["only one"]],
        )
        so = _make_so(doc)
        result = _trim_one_bullet_per_entry(doc, so)
        assert result is True  # falls through to entry removal
        assert len(doc.projects) == 0  # project removed as last resort

    def test_last_resort_removes_project_entry(self):
        doc = _make_doc(
            exp_bullets=[["a"], ["b"]],
            proj_bullets=[["x"]],
        )
        so = _make_so(doc)
        result = _trim_one_bullet_per_entry(doc, so)
        assert result is True
        assert len(doc.projects) == 0

    def test_last_resort_removes_experience_entry_if_no_projects(self):
        doc = _make_doc(
            exp_bullets=[["a"], ["b"], ["c"]],
            proj_bullets=[],
        )
        so = _make_so(doc)
        result = _trim_one_bullet_per_entry(doc, so)
        assert result is True
        assert len(doc.experience) == 2

    def test_returns_false_when_nothing_can_be_trimmed(self):
        doc = _make_doc(
            exp_bullets=[["only"]],
            proj_bullets=[],
        )
        so = _make_so(doc)
        result = _trim_one_bullet_per_entry(doc, so)
        assert result is False

    def test_structured_output_synced_on_trim(self):
        doc = _make_doc(exp_bullets=[["a", "b"]], proj_bullets=[])
        so = _make_so(doc)
        _trim_one_bullet_per_entry(doc, so)
        exp_so = so["experience_entries"][0]["bullet_plan"]
        assert len(exp_so) == 1

    def test_multiple_rounds_eventually_drain(self):
        doc = _make_doc(exp_bullets=[["a", "b", "c"]], proj_bullets=[["x", "y"]])
        so = _make_so(doc)
        for _ in range(10):
            if not _trim_one_bullet_per_entry(doc, so):
                break
        total = sum(len(e.bullets) for e in doc.experience) + sum(
            len(p.bullets) for p in doc.projects
        )
        assert total <= 2
