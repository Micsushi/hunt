from __future__ import annotations

import copy
import hashlib
import re

from .config import (
    DEFAULT_MAX_EXPERIENCE_BULLETS,
    DEFAULT_MAX_PROJECT_BULLETS,
    DEFAULT_MAX_TOTAL_BULLETS,
)
from .models import ExperienceEntry, ProjectEntry, ResumeDocument


def _normalize_words(text: str) -> set[str]:
    return {token.lower() for token in re.findall(r"[a-zA-Z][a-zA-Z0-9.+#/-]{2,}", text)}


def _slugify(value: str) -> str:
    cleaned = re.sub(r"\\href\{.*?\}\{(.*?)\}", r"\1", value or "")
    cleaned = re.sub(r"\\textbf\{(.*?)\}", r"\1", cleaned)
    return re.sub(r"[^a-zA-Z0-9]+", "_", cleaned).strip("_").lower()


def _stable_source_id(prefix: str, text: str) -> str:
    digest = hashlib.sha1((text or "").encode("utf-8")).hexdigest()[:10]
    return f"{prefix}_{digest}"


def _score_text(text: str, keywords: list[str], family: str) -> int:
    words = _normalize_words(text)
    score = 0
    for keyword in keywords:
        lowered = keyword.lower()
        if lowered in words or lowered in text.lower():
            score += 3
    family_bonus_terms = {
        "software": (
            "api",
            "backend",
            "frontend",
            "deploy",
            "kubernetes",
            "aws",
            "python",
            "kotlin",
        ),
        "pm": ("stakeholder", "agile", "planning", "roadmap", "alignment", "scrum"),
        "data": ("data", "analytics", "analysis", "forecast", "metrics", "python"),
        "general": (),
    }
    for token in family_bonus_terms.get(family, ()):
        if token in text.lower():
            score += 1
    return score


def _rewrite_bullet(text: str, must_haves: list[str]) -> str:  # noqa: ARG001
    """Clean the bullet text without injecting keywords.

    Keywords are only added when they genuinely appear in the bullet already
    (scoring handles selection); forced appending produces unnatural text.
    The must_haves parameter is kept for API compatibility but is intentionally
    not used to modify the bullet content.
    """
    normalized = text.strip()
    if not normalized:
        return normalized
    # Normalise trailing punctuation: ensure exactly one period.
    if normalized.endswith("."):
        return normalized
    return normalized + "."


def _clean_bullet(text: str) -> str:
    normalized = (text or "").strip()
    if not normalized:
        return normalized
    return normalized if normalized.endswith(".") else normalized + "."


def _prioritize(values: list[str], preferred: list[str]) -> list[str]:
    preferred_set = {item.lower() for item in preferred}
    deduped: list[str] = []
    seen: set[str] = set()
    for value in values:
        key = value.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(value)
    return sorted(deduped, key=lambda item: (item.lower() not in preferred_set, item.lower()))


def _merge_source_entries(
    candidate_entries: list[dict], library_entries: list[dict], *, project: bool = False
) -> list[dict]:
    merged: dict[str, dict] = {}
    key_name = "entry_id" if not project else "entry_id"

    def ensure(key: str, template: dict) -> dict:
        if key not in merged:
            merged[key] = copy.deepcopy(template)
        return merged[key]

    for entry in candidate_entries:
        key = entry.get("entry_id") or ""
        if not key:
            continue
        target = ensure(key, entry)
        if target is not entry:
            target.setdefault("bullet_candidates", []).extend(
                copy.deepcopy(entry.get("bullet_candidates", []))
            )
            target.setdefault("immutable_facts", []).extend(
                copy.deepcopy(entry.get("immutable_facts", []))
            )
            for field_name in (
                "company",
                "title",
                "location",
                "start_date",
                "end_date",
                "project_name",
                "url",
                "relevance_notes",
            ):
                if entry.get(field_name) and not target.get(field_name):
                    target[field_name] = entry.get(field_name)
            for field_name in (
                "role_family_tags",
                "job_level_tags",
                "technology_tags",
                "leadership_tags",
                "pm_tags",
                "data_tags",
            ):
                if field_name in entry:
                    target[field_name] = list(
                        dict.fromkeys(
                            (target.get(field_name, []) or []) + (entry.get(field_name, []) or [])
                        )
                    )

    for entry in library_entries:
        key = entry.get("source_entry_id") or ""
        if not key:
            continue
        template = {
            key_name: key,
            "company": entry.get("company", ""),
            "title": entry.get("title", ""),
            "location": "",
            "start_date": "",
            "end_date": "",
            "project_name": entry.get("project_name", ""),
            "url": "",
            "role_family_tags": entry.get("role_family_tags", []),
            "job_level_tags": entry.get("job_level_tags", []),
            "technology_tags": entry.get("technology_tags", []),
            "leadership_tags": [],
            "pm_tags": [],
            "data_tags": [],
            "immutable_facts": [],
            "bullet_candidates": copy.deepcopy(entry.get("bullet_candidates", [])),
            "relevance_notes": "",
        }
        target = ensure(key, template)
        target.setdefault("bullet_candidates", []).extend(
            copy.deepcopy(entry.get("bullet_candidates", []))
        )
        target["role_family_tags"] = list(
            dict.fromkeys(
                (target.get("role_family_tags", []) or [])
                + (entry.get("role_family_tags", []) or [])
            )
        )
        target["technology_tags"] = list(
            dict.fromkeys(
                (target.get("technology_tags", []) or []) + (entry.get("technology_tags", []) or [])
            )
        )
        target["job_level_tags"] = list(
            dict.fromkeys(
                (target.get("job_level_tags", []) or []) + (entry.get("job_level_tags", []) or [])
            )
        )
        if entry.get("company") and not target.get("company"):
            target["company"] = entry.get("company")
        if entry.get("title") and not target.get("title"):
            target["title"] = entry.get("title")
        if entry.get("project_name") and not target.get("project_name"):
            target["project_name"] = entry.get("project_name")

    return list(merged.values())


def _entry_matches_resume_entry(
    entry: ExperienceEntry | ProjectEntry, source_entry: dict, *, project: bool = False
) -> bool:
    source_ids = {
        source_entry.get("entry_id", ""),
        source_entry.get("source_entry_id", ""),
    }
    source_title = source_entry.get("project_name") if project else source_entry.get("title")
    source_company = source_entry.get("company", "")
    source_location = source_entry.get("location", "")
    source_ids.add(
        _slugify(" ".join(part for part in (source_title, source_company, source_location) if part))
    )

    entry_text = entry.project_title if project else entry.title_company_location
    entry_slug = _slugify(entry_text)
    source_ids = {value for value in source_ids if value}
    if entry.entry_id in source_ids or entry_slug in source_ids:
        return True
    return any(candidate in entry_slug or entry_slug in candidate for candidate in source_ids)


def _build_resume_like_experience(source_entry: dict) -> ExperienceEntry | None:
    entry_id = source_entry.get("entry_id") or source_entry.get("source_entry_id") or ""
    title = source_entry.get("title") or ""
    company = source_entry.get("company") or ""
    location = source_entry.get("location") or ""
    if not entry_id or not title or not company:
        return None

    date_bits = [source_entry.get("start_date") or "", source_entry.get("end_date") or ""]
    date_text = " - ".join(bit for bit in date_bits if bit) or "Dates unavailable"
    title_company_location = f"\\textbf{{{title}}}, {company}"
    if location:
        title_company_location += f" -- {location}"

    bullets = [
        candidate.get("text", "").strip()
        for candidate in source_entry.get("bullet_candidates", [])
        if candidate.get("text")
    ]
    if not bullets:
        return None

    return ExperienceEntry(
        entry_id=entry_id,
        title_company_location=title_company_location,
        date_text=date_text,
        bullets=bullets,
    )


def _build_resume_like_project(source_entry: dict) -> ProjectEntry | None:
    entry_id = source_entry.get("entry_id") or source_entry.get("source_entry_id") or ""
    project_name = source_entry.get("project_name") or ""
    if not entry_id or not project_name:
        return None

    bullets = [
        candidate.get("text", "").strip()
        for candidate in source_entry.get("bullet_candidates", [])
        if candidate.get("text")
    ]
    if not bullets:
        return None

    return ProjectEntry(
        entry_id=entry_id,
        project_title=f"\\textbf{{{project_name}}}",
        date_or_link_text=source_entry.get("url") or source_entry.get("relevance_notes") or "",
        bullets=bullets,
    )


def _build_bullet_candidates_for_entry(
    entry: ExperienceEntry | ProjectEntry,
    matched_source_entries: list[dict],
    must_haves: list[str],
    role_family: str,
    *,
    project: bool = False,
) -> list[dict]:
    candidates: list[dict] = []
    for bullet in entry.bullets:
        candidates.append(
            {
                "text": _rewrite_bullet(bullet, must_haves[: 2 if not project else 1]),
                "prior_text": bullet,
                "source_fact_id": _stable_source_id(f"og_{entry.entry_id}", bullet),
                "mode": "rewrite",
                "score": _score_text(bullet, must_haves, role_family),
            }
        )

    for source_entry in matched_source_entries:
        for bullet in source_entry.get("bullet_candidates", []):
            text = bullet.get("text", "").strip()
            if not text:
                continue
            candidates.append(
                {
                    "text": _clean_bullet(text),
                    "source_fact_id": (
                        (
                            bullet.get("supported_fact_ids")
                            or [
                                bullet.get("bullet_id")
                                or _stable_source_id(f"src_{entry.entry_id}", text)
                            ]
                        )[0]
                    ),
                    "mode": "reuse",
                    "score": _score_text(
                        " ".join(
                            [
                                text,
                                " ".join(bullet.get("relevance_tags", [])),
                                " ".join(source_entry.get("role_family_tags", [])),
                                " ".join(source_entry.get("technology_tags", [])),
                            ]
                        ),
                        must_haves,
                        role_family,
                    )
                    + 2,
                }
            )

    deduped: list[dict] = []
    seen_text: set[str] = set()
    for candidate in sorted(candidates, key=lambda item: item["score"], reverse=True):
        key = candidate["text"].lower()
        if key in seen_text:
            continue
        seen_text.add(key)
        deduped.append(candidate)
    return deduped


def _bullet_plan_item(candidate: dict) -> dict:
    text = candidate["text"]
    prior = candidate.get("prior_text")
    original = (prior if prior is not None else text) or ""
    if isinstance(original, str):
        original = original.strip()
    return {
        "source_fact_id": candidate["source_fact_id"],
        "mode": candidate["mode"],
        "text": text,
        "original_text": original if original else text,
    }


def _select_bullets(candidates: list[dict], *, max_count: int, min_count: int = 1) -> list[dict]:
    if not candidates or max_count <= 0:
        return []
    keep_count = min(len(candidates), max_count)
    keep_count = max(min_count if len(candidates) >= min_count else 1, keep_count)
    return candidates[:keep_count]


def _gather_source_skills(candidate_profile: dict, bullet_library: dict) -> dict[str, list[dict]]:
    skills = {
        "languages": [],
        "frameworks": [],
        "developer_tools": [],
    }
    for source in (candidate_profile, bullet_library):
        for bucket_name in skills:
            skills[bucket_name].extend(copy.deepcopy(source.get("skills", {}).get(bucket_name, [])))
    return skills


def _augment_skill_bucket(
    existing_values: list[str],
    source_skills: list[dict],
    *,
    must_haves: list[str],
    role_family: str,
) -> list[str]:
    preferred: list[str] = []
    merged = list(existing_values)
    for skill in source_skills:
        name = (skill.get("name") or "").strip()
        if not name:
            continue
        if any(
            keyword.lower() in name.lower() or name.lower() in keyword.lower()
            for keyword in must_haves
        ):
            preferred.append(name)
        if role_family in (skill.get("related_role_families") or []):
            preferred.append(name)
        if name.lower() not in {value.lower() for value in merged}:
            merged.append(name)
    for value in existing_values:
        if any(
            keyword.lower() in value.lower() or value.lower() in keyword.lower()
            for keyword in must_haves
        ):
            preferred.append(value)
    return _prioritize(merged, preferred)


def generate_tailored_resume(
    base_resume: ResumeDocument,
    *,
    classification: dict,
    keywords: dict,
    candidate_profile: dict | None = None,
    bullet_library: dict | None = None,
    selected_base_resume: str = "original",
) -> tuple[ResumeDocument, dict]:
    doc = copy.deepcopy(base_resume)
    role_family = classification["role_family"]
    must_haves = keywords["must_have_terms"]
    candidate_profile = candidate_profile or {}
    bullet_library = bullet_library or {}

    source_experience_entries = _merge_source_entries(
        candidate_profile.get("experience_entries", []),
        bullet_library.get("experience_entries", []),
    )
    source_project_entries = _merge_source_entries(
        candidate_profile.get("project_entries", []),
        bullet_library.get("project_entries", []),
        project=True,
    )

    experience_records: list[dict] = []
    matched_source_ids: set[str] = set()
    used_source_material = False

    for entry in doc.experience:
        matched_entries = [
            source_entry
            for source_entry in source_experience_entries
            if _entry_matches_resume_entry(entry, source_entry)
        ]
        matched_source_ids.update(
            value
            for source_entry in matched_entries
            for value in (source_entry.get("entry_id"), source_entry.get("source_entry_id"))
            if value
        )
        bullet_candidates = _build_bullet_candidates_for_entry(
            entry,
            matched_entries,
            must_haves,
            role_family,
        )
        experience_records.append(
            {
                "entry": entry,
                "bullet_candidates": bullet_candidates,
                "score": _score_text(
                    f"{entry.title_company_location} {' '.join(candidate['text'] for candidate in bullet_candidates)}",
                    must_haves,
                    role_family,
                ),
            }
        )
        if matched_entries and any(candidate["mode"] == "reuse" for candidate in bullet_candidates):
            used_source_material = True

    for source_entry in source_experience_entries:
        source_id = source_entry.get("entry_id") or source_entry.get("source_entry_id")
        if not source_id or source_id in matched_source_ids:
            continue
        supplemental_entry = _build_resume_like_experience(source_entry)
        if supplemental_entry is None:
            continue
        bullet_candidates = _build_bullet_candidates_for_entry(
            supplemental_entry,
            [source_entry],
            must_haves,
            role_family,
        )
        experience_records.append(
            {
                "entry": supplemental_entry,
                "bullet_candidates": bullet_candidates,
                "score": _score_text(
                    f"{supplemental_entry.title_company_location} {' '.join(candidate['text'] for candidate in bullet_candidates)}",
                    must_haves,
                    role_family,
                )
                + 1,
            }
        )
        used_source_material = True

    ranked_experience = sorted(experience_records, key=lambda item: item["score"], reverse=True)
    exp_budget_remaining = DEFAULT_MAX_EXPERIENCE_BULLETS
    selected_experience: list[ExperienceEntry] = []
    structured_experience: list[dict] = []
    for record in ranked_experience:
        if exp_budget_remaining <= 0:
            break
        max_count = min(3, exp_budget_remaining)
        chosen_bullets = _select_bullets(
            record["bullet_candidates"], max_count=max_count, min_count=1
        )
        if not chosen_bullets:
            continue
        entry = copy.deepcopy(record["entry"])
        entry.bullets = [bullet["text"] for bullet in chosen_bullets]
        selected_experience.append(entry)
        structured_experience.append(
            {
                "entry_id": entry.entry_id,
                "keep_header_original": True,
                "bullet_plan": [_bullet_plan_item(bullet) for bullet in chosen_bullets],
            }
        )
        exp_budget_remaining = max(0, exp_budget_remaining - len(chosen_bullets))

    if not selected_experience:
        fallback_entry = copy.deepcopy(doc.experience[:1])[0]
        selected_experience = [fallback_entry]
        structured_experience = [
            {
                "entry_id": fallback_entry.entry_id,
                "keep_header_original": True,
                "bullet_plan": [
                    _bullet_plan_item(
                        {
                            "source_fact_id": _stable_source_id(
                                f"og_{fallback_entry.entry_id}", bullet
                            ),
                            "mode": "rewrite",
                            "text": _rewrite_bullet(bullet, must_haves[:2]),
                            "prior_text": bullet,
                        }
                    )
                    for bullet in fallback_entry.bullets[
                        : max(1, min(2, len(fallback_entry.bullets)))
                    ]
                ],
            }
        ]
        selected_experience[0].bullets = [
            item["text"] for item in structured_experience[0]["bullet_plan"]
        ]

    doc.experience = selected_experience

    project_records: list[dict] = []
    matched_project_source_ids: set[str] = set()
    for entry in doc.projects:
        matched_entries = [
            source_entry
            for source_entry in source_project_entries
            if _entry_matches_resume_entry(entry, source_entry, project=True)
        ]
        matched_project_source_ids.update(
            value
            for source_entry in matched_entries
            for value in (source_entry.get("entry_id"), source_entry.get("source_entry_id"))
            if value
        )
        bullet_candidates = _build_bullet_candidates_for_entry(
            entry,
            matched_entries,
            must_haves,
            role_family,
            project=True,
        )
        project_records.append(
            {
                "entry": entry,
                "bullet_candidates": bullet_candidates,
                "score": _score_text(
                    f"{entry.project_title} {' '.join(candidate['text'] for candidate in bullet_candidates)}",
                    must_haves,
                    role_family,
                ),
            }
        )
        if matched_entries and any(candidate["mode"] == "reuse" for candidate in bullet_candidates):
            used_source_material = True

    for source_entry in source_project_entries:
        source_id = source_entry.get("entry_id") or source_entry.get("source_entry_id")
        if not source_id or source_id in matched_project_source_ids:
            continue
        supplemental_entry = _build_resume_like_project(source_entry)
        if supplemental_entry is None:
            continue
        bullet_candidates = _build_bullet_candidates_for_entry(
            supplemental_entry,
            [source_entry],
            must_haves,
            role_family,
            project=True,
        )
        project_records.append(
            {
                "entry": supplemental_entry,
                "bullet_candidates": bullet_candidates,
                "score": _score_text(
                    f"{supplemental_entry.project_title} {' '.join(candidate['text'] for candidate in bullet_candidates)}",
                    must_haves,
                    role_family,
                )
                + 1,
            }
        )
        used_source_material = True

    project_budget = max(
        0, DEFAULT_MAX_TOTAL_BULLETS - sum(len(entry.bullets) for entry in doc.experience)
    )
    selected_projects: list[ProjectEntry] = []
    structured_projects: list[dict] = []
    if project_budget > 0:
        for record in sorted(project_records, key=lambda item: item["score"], reverse=True):
            if project_budget <= 0 or len(selected_projects) >= 2:
                break
            chosen_bullets = _select_bullets(
                record["bullet_candidates"],
                max_count=min(DEFAULT_MAX_PROJECT_BULLETS, project_budget),
                min_count=1,
            )
            if not chosen_bullets:
                continue
            entry = copy.deepcopy(record["entry"])
            entry.bullets = [bullet["text"] for bullet in chosen_bullets]
            selected_projects.append(entry)
            structured_projects.append(
                {
                    "entry_id": entry.entry_id,
                    "bullet_plan": [_bullet_plan_item(bullet) for bullet in chosen_bullets],
                }
            )
            project_budget -= len(chosen_bullets)
    doc.projects = selected_projects

    source_skills = _gather_source_skills(candidate_profile, bullet_library)
    doc.skills.languages = _augment_skill_bucket(
        doc.skills.languages,
        source_skills["languages"],
        must_haves=must_haves,
        role_family=role_family,
    )
    doc.skills.frameworks = _augment_skill_bucket(
        doc.skills.frameworks,
        source_skills["frameworks"],
        must_haves=must_haves,
        role_family=role_family,
    )
    doc.skills.developer_tools = _augment_skill_bucket(
        doc.skills.developer_tools,
        source_skills["developer_tools"],
        must_haves=must_haves,
        role_family=role_family,
    )

    concern_flags = list(
        dict.fromkeys(classification.get("concern_flags", []) + keywords.get("concern_flags", []))
    )
    if classification.get("weak_description") and not used_source_material:
        concern_flags.append("insufficient_source_facts")
        concern_flags.append("manual_review_recommended")

    structured = {
        "selected_base_resume": selected_base_resume,
        "role_family": classification["role_family"],
        "job_level": classification["job_level"],
        "fallback_used": False,
        "section_order": doc.section_order,
        "education": {"keep_original": True},
        "experience_entries": structured_experience,
        "project_entries": structured_projects,
        "skills": {
            "languages": doc.skills.languages,
            "frameworks": doc.skills.frameworks,
            "developer_tools": doc.skills.developer_tools,
        },
        "concern_flags": list(dict.fromkeys(concern_flags)),
    }
    return doc, structured
