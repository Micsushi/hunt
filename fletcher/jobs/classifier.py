from __future__ import annotations

import re

ROLE_PATTERNS = {
    "pm": (
        "product manager",
        "project manager",
        "program manager",
        "scrum master",
        "business analyst",
        "product owner",
    ),
    "data": (
        "data analyst",
        "data scientist",
        "data engineer",
        "machine learning",
        "analytics",
        "bi analyst",
    ),
    "software": (
        "software engineer",
        "software developer",
        "backend",
        "frontend",
        "fullstack",
        "full-stack",
        "devops",
        "platform engineer",
        "sre",
    ),
}

LEVEL_PATTERNS = {
    "intern": ("intern", "internship", "co-op", "coop"),
    "new_grad": ("new grad", "new graduate", "graduate program"),
    "junior": ("junior", "associate", "entry level", "entry-level"),
    "mid": ("intermediate",),
    "senior": ("senior", "sr.", "sr "),
    "staff": ("staff",),
    "principal": ("principal",),
    "manager": ("manager",),
    "director": ("director",),
}

WEAK_DESCRIPTION_THRESHOLD = 120


def classify_job(*, title: str, description: str | None) -> dict:
    text = f"{title}\n{description or ''}".lower()
    role_scores: dict[str, int] = {}
    reasons: list[str] = []

    for family, patterns in ROLE_PATTERNS.items():
        score = sum(1 for pattern in patterns if pattern in text)
        role_scores[family] = score
        if score:
            reasons.append(f"{family}_signals={score}")

    best_family = max(role_scores, key=role_scores.get) if role_scores else "general"
    if role_scores.get(best_family, 0) == 0:
        best_family = "general"

    job_level = "unknown"
    for level, patterns in LEVEL_PATTERNS.items():
        if any(pattern in text for pattern in patterns):
            job_level = level
            reasons.append(f"level={level}")
            break

    description_text = (description or "").strip()
    weak_description = len(description_text) < WEAK_DESCRIPTION_THRESHOLD
    confidence = 0.45 if weak_description else 0.75
    if best_family != "general":
        confidence += 0.1
    if job_level != "unknown":
        confidence += 0.05
    confidence = min(confidence, 0.95)

    concern_flags = []
    if weak_description:
        concern_flags.append("weak_description")
    if confidence < 0.6:
        concern_flags.append("low_confidence_match")

    return {
        "role_family": best_family,
        "job_level": job_level,
        "confidence": round(confidence, 2),
        "weak_description": weak_description,
        "recommended_base_resume": best_family if best_family != "unknown" else "original",
        "reasons": reasons,
        "concern_flags": concern_flags,
    }


def slugify(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_").lower() or "item"
