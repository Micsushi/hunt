from fletcher.resume.models import (
    EducationEntry,
    EducationSection,
    ExperienceEntry,
    ProjectEntry,
    ResumeDocument,
    ResumeHeader,
    SkillsSection,
)
from fletcher.resume.renderer import render_resume_tex


def test_skills_escape_latex_special_characters():
    doc = ResumeDocument(
        source_path="test.tex",
        preamble=r"\documentclass{article}",
        header=ResumeHeader(name="Test User", contact_line="test@example.com"),
        education=EducationSection(
            entry=EducationEntry(entry_id="edu", institution_and_degree="BSc CS", date_text="2020")
        ),
        skills=SkillsSection(
            languages=["C#", "C++"],
            frameworks=["ASP.NET"],
            developer_tools=["Git"],
        ),
    )

    tex = render_resume_tex(doc)

    assert "C\\#" in tex
    assert "C#" not in tex


def test_skill_category_labels_escape_latex_special_characters():
    doc = ResumeDocument(
        source_path="test.tex",
        preamble=r"\documentclass{article}",
        header=ResumeHeader(name="Test User", contact_line="test@example.com"),
        education=EducationSection(
            entry=EducationEntry(entry_id="edu", institution_and_degree="BSc CS", date_text="2020")
        ),
        skills=SkillsSection(categories={"Cloud & Data": ["AWS"], "Languages": ["Python"]}),
    )

    tex = render_resume_tex(doc)

    assert r"\textbf{Cloud \& Data:} AWS" in tex
    assert r"\textbf{Cloud & Data:}" not in tex


def test_structured_headers_escape_latex_special_characters_without_breaking_inline_latex():
    doc = ResumeDocument(
        source_path="test.tex",
        preamble=r"\documentclass{article}",
        header=ResumeHeader(name="A&B User", contact_line=r"\href{https://example.com}{A&B}"),
        education=EducationSection(
            entry=EducationEntry(
                entry_id="edu",
                institution_and_degree=r"\textbf{Cloud & Data}, BSc",
                date_text=r"Expected: \textbf{Sep 2026}",
            )
        ),
        experience=[
            ExperienceEntry(
                entry_id="exp",
                title_company_location="R&D Engineer, A&B Labs",
                date_text="2024 - 2025",
                bullets=["Built C# tools for 85% coverage."],
            )
        ],
        projects=[
            ProjectEntry(
                entry_id="proj",
                project_title=r"\textbf{Cloud & Data Tool}",
                date_or_link_text=r"\href{https://example.com}{Repo & Demo}",
                bullets=["Shipped AWS & Python automation."],
            )
        ],
        skills=SkillsSection(),
    )

    tex = render_resume_tex(doc)

    assert r"\textbf{A\&B User}" in tex
    assert r"\href{https://example.com}{A\&B}" in tex
    assert r"\textbf{Cloud \& Data}, BSc" in tex
    assert r"R\&D Engineer, A\&B Labs" in tex
    assert r"\textbf{Cloud \& Data Tool}" in tex
    assert r"\href{https://example.com}{Repo \& Demo}" in tex
