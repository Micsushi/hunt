from fletcher.resume.models import (
    EducationEntry,
    EducationSection,
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
