from __future__ import annotations

import copy
import re

from .config import DEFAULT_MAX_EXPERIENCE_BULLETS, DEFAULT_MAX_PROJECT_BULLETS, DEFAULT_MAX_TOTAL_BULLETS
from .models import ExperienceEntry, ProjectEntry, ResumeDocument


def _normalize_words(text: str) -> set[str]:
    return {
        token.lower()
        for token in re.findall(r"[a-zA-Z][a-zA-Z0-9.+#/-]{2,}", text)
    }


def _score_text(text: str, keywords: list[str], family: str) -> int:
    words = _normalize_words(text)
    score = 0
    for keyword in keywords:
        if keyword.lower() in words or keyword.lower() in text.lower():
            score += 3
    family_bonus_terms = {
        "software": ("api", "backend", "frontend", "deploy", "kubernetes", "aws", "python", "kotlin"),
        "pm": ("stakeholder", "agile", "planning", "roadmap", "alignment", "scrum"),
        "data": ("data", "analytics", "analysis", "forecast", "metrics", "python"),
        "general": (),
    }
    for token in family_bonus_terms.get(family, ()):
        if token in text.lower():
            score += 1
    return score


def _rewrite_bullet(text: str, must_haves: list[str]) -> str:
    normalized = text.strip()
    if not normalized:
        return normalized
    if normalized.endswith("."):
        normalized = normalized[:-1]
    if must_haves:
        top = must_haves[0]
        if top.lower() not in normalized.lower():
            normalized = f"{normalized}; aligned with {top}"
    return normalized + "."


def _pick_experience_entries(experience: list[ExperienceEntry], keywords: list[str], family: str) -> list[ExperienceEntry]:
    ranked = sorted(
        experience,
        key=lambda entry: _score_text(
            f"{entry.title_company_location} {' '.join(entry.bullets)}",
            keywords,
            family,
        ),
        reverse=True,
    )
    return ranked[: max(1, len(ranked))]


def _pick_projects(projects: list[ProjectEntry], keywords: list[str], family: str) -> list[ProjectEntry]:
    ranked = sorted(
        projects,
        key=lambda entry: _score_text(
            f"{entry.project_title} {' '.join(entry.bullets)}",
            keywords,
            family,
        ),
        reverse=True,
    )
    return ranked[:1] if ranked else []


def _prioritize(values: list[str], preferred: list[str]) -> list[str]:
    preferred_set = {item.lower() for item in preferred}
    return sorted(values, key=lambda item: (item.lower() not in preferred_set, item.lower()))


def generate_tailored_resume(
    base_resume: ResumeDocument,
    *,
    classification: dict,
    keywords: dict,
) -> tuple[ResumeDocument, dict]:
    doc = copy.deepcopy(base_resume)
    role_family = classification["role_family"]
    must_haves = keywords["must_have_terms"]

    chosen_experience = _pick_experience_entries(doc.experience, must_haves, role_family)
    exp_budget_remaining = DEFAULT_MAX_EXPERIENCE_BULLETS
    generated_experience = []
    for entry in chosen_experience:
        ranked_bullets = sorted(entry.bullets, key=lambda bullet: _score_text(bullet, must_haves, role_family), reverse=True)
        keep_count = min(len(ranked_bullets), max(2, min(3, exp_budget_remaining)))
        selected = [_rewrite_bullet(bullet, must_haves[:2]) for bullet in ranked_bullets[:keep_count]]
        exp_budget_remaining = max(0, exp_budget_remaining - len(selected))
        entry.bullets = selected
        generated_experience.append(entry)
    doc.experience = generated_experience or doc.experience[:1]

    project_budget = max(0, DEFAULT_MAX_TOTAL_BULLETS - sum(len(e.bullets) for e in doc.experience))
    selected_projects = _pick_projects(doc.projects, must_haves, role_family)
    if project_budget <= 0:
        doc.projects = []
    else:
        limited_projects = []
        for entry in selected_projects:
            ranked_bullets = sorted(entry.bullets, key=lambda bullet: _score_text(bullet, must_haves, role_family), reverse=True)
            keep_count = min(len(ranked_bullets), min(DEFAULT_MAX_PROJECT_BULLETS, project_budget))
            entry.bullets = [_rewrite_bullet(bullet, must_haves[:1]) for bullet in ranked_bullets[:keep_count]]
            project_budget -= len(entry.bullets)
            limited_projects.append(entry)
        doc.projects = limited_projects

    matched_skills = []
    all_skill_buckets = doc.skills.languages + doc.skills.frameworks + doc.skills.developer_tools
    for skill in all_skill_buckets:
        if any(keyword.lower() in skill.lower() or skill.lower() in keyword.lower() for keyword in must_haves):
            matched_skills.append(skill)
    doc.skills.languages = _prioritize(doc.skills.languages, matched_skills)
    doc.skills.frameworks = _prioritize(doc.skills.frameworks, matched_skills)
    doc.skills.developer_tools = _prioritize(doc.skills.developer_tools, matched_skills)

    structured = {
        "selected_base_resume": "original",
        "role_family": classification["role_family"],
        "job_level": classification["job_level"],
        "fallback_used": False,
        "section_order": doc.section_order,
        "education": {"keep_original": True},
        "experience_entries": [
            {
                "entry_id": entry.entry_id,
                "keep_header_original": True,
                "bullet_plan": [
                    {
                        "source_fact_id": f"{entry.entry_id}_bullet_{index + 1}",
                        "mode": "rewrite",
                        "text": bullet,
                    }
                    for index, bullet in enumerate(entry.bullets)
                ],
            }
            for entry in doc.experience
        ],
        "project_entries": [
            {
                "entry_id": entry.entry_id,
                "bullet_plan": [
                    {
                        "source_fact_id": f"{entry.entry_id}_bullet_{index + 1}",
                        "mode": "rewrite",
                        "text": bullet,
                    }
                    for index, bullet in enumerate(entry.bullets)
                ],
            }
            for entry in doc.projects
        ],
        "skills": {
            "languages": doc.skills.languages,
            "frameworks": doc.skills.frameworks,
            "developer_tools": doc.skills.developer_tools,
        },
        "concern_flags": list(dict.fromkeys(classification.get("concern_flags", []) + keywords.get("concern_flags", []))),
    }
    return doc, structured

