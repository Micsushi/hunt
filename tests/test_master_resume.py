from __future__ import annotations

from pathlib import Path

from fletcher.resume.master import build_master_resume_document, parse_master_yaml
from fletcher.resume.master_importer import import_master_resume_yaml
from fletcher.resume.renderer import render_resume_tex

REPO_ROOT = Path(__file__).resolve().parent.parent
MAIN_TEX = REPO_ROOT / "main.tex"


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


def test_import_master_resume_yaml_from_template_tex_is_loadable():
    yaml_text = import_master_resume_yaml(MAIN_TEX)
    data = parse_master_yaml(yaml_text)

    assert data["header"]["name"] == "Your Name"
    assert data["education"]["date_text"] == r"Expected Graduation: \textbf{YYYY}"
    assert data["experience"][0]["id"] == "job1_company"
    assert data["experience"][0]["title"] == "Current Role"
    assert data["experience"][0]["company"] == "Company"
    assert data["experience"][0]["location"] == "City, Region"
    assert data["projects"][0]["url"] == "https://github.com/yourhandle/project-one"
    assert "Python" in data["skills"]["Languages"]

    doc, _ = build_master_resume_document(
        data,
        title="Software Engineer",
        keywords=["Python", "FastAPI"],
        role_family="software",
    )
    tex = render_resume_tex(doc)

    assert r"\section{Experience}" in tex
    assert "Current Role, Company -- City, Region" in tex
