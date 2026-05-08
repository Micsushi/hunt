from __future__ import annotations

from fletcher.resume.master import build_master_resume_document, parse_master_yaml
from fletcher.resume.renderer import render_resume_tex


def test_master_yaml_loader_parses_resume_content_and_inline_latex():
    data = parse_master_yaml(
        r"""
header:
  name: "Michael Shi"
  contact: "Edmonton | \href{mailto:test@example.com}{test@example.com}"
summaries:
  software: "Software summary with \textbf{Python}."
education:
  institution_and_degree: "\textbf{University}, BSc"
  date_text: "2026"
  bullets:
    - "\textbf{Awards:} Dean's Honor Roll"
experience:
  - id: "exp_one"
    title: "Developer"
    company: "Acme"
    location: "Edmonton"
    dates: "2025"
    bullets:
      - text: "Built Python automation that reduced review time by \textbf{85\%}."
projects:
  - id: "proj_one"
    name: "Tool"
    url: "https://example.com"
    bullets:
      - text: "Built a FastAPI tool."
skills:
  Languages:
    - Python
"""
    )

    assert data["header"]["name"] == "Michael Shi"
    assert data["experience"][0]["bullets"][0]["text"].endswith(r"\textbf{85\%}.")
    assert data["skills"]["Languages"] == ["Python"]


def test_master_selector_prefers_earlier_entries_when_scores_are_close(monkeypatch):
    from fletcher.resume import master as master_mod

    monkeypatch.setattr(
        master_mod, "score_bullets_for_drop", lambda bullets, signals: [0.5] * len(bullets)
    )
    data = {
        "header": {"name": "A", "contact": "a@example.com"},
        "summaries": {"software": "Software summary"},
        "education": {"institution_and_degree": "School", "date_text": "2026", "bullets": []},
        "selection": {
            "min_experience": 2,
            "max_experience": 2,
            "min_projects": 1,
            "max_projects": 1,
            "max_bullets_per_experience": 1,
            "max_bullets_per_project": 1,
            "experience_position_bonus": 0.2,
            "project_position_bonus": 0.2,
            "bullet_position_bonus": 0.2,
        },
        "experience": [
            {
                "id": "first",
                "title": "First",
                "company": "A",
                "dates": "Now",
                "bullets": [{"text": "First bullet"}, {"text": "Second bullet"}],
            },
            {
                "id": "second",
                "title": "Second",
                "company": "B",
                "dates": "Before",
                "bullets": [{"text": "Later bullet"}],
            },
            {
                "id": "third",
                "title": "Third",
                "company": "C",
                "dates": "Before",
                "bullets": [{"text": "Third bullet"}],
            },
        ],
        "projects": [
            {"id": "proj_first", "name": "Project A", "bullets": [{"text": "Project bullet"}]},
            {"id": "proj_second", "name": "Project B", "bullets": [{"text": "Project bullet"}]},
        ],
        "skills": {"Languages": ["Python", "Go"]},
    }

    doc, report = build_master_resume_document(
        data, title="Software Engineer", keywords=["Python"], role_family="software"
    )

    assert [entry.entry_id for entry in doc.experience] == ["first", "second"]
    assert [entry.entry_id for entry in doc.projects] == ["proj_first"]
    assert doc.experience[0].bullets == ["First bullet"]
    assert report["experience"][0]["id"] == "first"


def test_renderer_outputs_flexible_skill_categories():
    data = {
        "header": {"name": "A", "contact": "a@example.com"},
        "summaries": {"software": ""},
        "education": {"institution_and_degree": "School", "date_text": "2026", "bullets": []},
        "selection": {
            "min_experience": 0,
            "max_experience": 0,
            "min_projects": 0,
            "max_projects": 0,
        },
        "experience": [],
        "projects": [],
        "skills": {"Cloud": ["AWS"], "Languages": ["Python"]},
    }

    doc, _ = build_master_resume_document(
        data, title="Cloud Engineer", keywords=["AWS"], role_family="software"
    )
    tex = render_resume_tex(doc)

    assert r"\textbf{Cloud:} AWS" in tex
    assert r"\textbf{Languages:} Python" in tex


def test_master_selector_keeps_all_master_skills(monkeypatch):
    from fletcher.resume import master as master_mod

    monkeypatch.setattr(
        master_mod, "score_bullets_for_drop", lambda bullets, signals: [0.7] * len(bullets)
    )
    data = {
        "header": {"name": "A", "contact": "a@example.com"},
        "summaries": {"software": ""},
        "education": {"institution_and_degree": "School", "date_text": "2026", "bullets": []},
        "selection": {
            "min_experience": 1,
            "max_experience": 1,
            "min_projects": 0,
            "max_projects": 0,
            "max_bullets_per_experience": 1,
        },
        "experience": [
            {
                "id": "first",
                "title": "Developer",
                "company": "A",
                "dates": "Now",
                "bullets": [{"text": "Built Python services."}],
            },
        ],
        "projects": [],
        "skills": {"Languages": ["Python", "Kotlin", "TypeScript"]},
    }

    doc, _ = build_master_resume_document(
        data, title="Software Engineer", keywords=["Python"], role_family="software"
    )

    assert doc.skills.categories["Languages"] == ["Python", "Kotlin", "TypeScript"]
