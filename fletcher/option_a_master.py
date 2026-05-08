from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from .jobs.classifier import classify_job
from .jobs.keyword_extractor import extract_keywords
from .llm.llm_enrich import analyze_job_fit_with_ollama, extract_keywords_with_ollama
from .resume.master import render_selected_master_resume


def _first_text_value(mapping: dict, keys: tuple[str, ...]) -> str:
    for key in keys:
        value = str(mapping.get(key) or "").strip()
        if value:
            return value
    return ""


def _missing_job_metadata_fields(title: str, classification: dict) -> list[str]:
    missing: list[str] = []
    if not str(title or "").strip():
        missing.append("title")
    if not str(classification.get("role_family") or "").strip():
        missing.append("role_family")
    if not str(classification.get("job_level") or "").strip():
        missing.append("job_level")
    return missing


def prepare_option_a_master_resume_source(
    job: dict,
    *,
    selection_overrides: dict[str, Any] | None = None,
) -> tuple[str, dict]:
    title = str(job.get("title") or "").strip()
    description = str(job.get("description") or "").strip()
    classification = classify_job(title=title, description=description)
    db_role_family = _first_text_value(
        job,
        ("role_family", "job_role_family", "latest_resume_role_family"),
    )
    db_job_level = _first_text_value(job, ("job_level", "level", "latest_resume_job_level"))
    if db_role_family:
        classification["role_family"] = db_role_family
    if db_job_level:
        classification["job_level"] = db_job_level

    job_fit = {"success": False, "skipped": True}
    missing = _missing_job_metadata_fields(title, classification)
    if missing:
        job_fit = analyze_job_fit_with_ollama(
            input_title=title,
            deterministic_title=title,
            description=description,
            missing_fields=missing,
            target_lane_policy="",
            unsupported_examples=[],
        )
        if job_fit.get("success"):
            if job_fit.get("title") and not title:
                title = str(job_fit.get("title") or "").strip()
            if job_fit.get("role_family"):
                classification["role_family"] = str(job_fit["role_family"])
            if job_fit.get("job_level"):
                classification["job_level"] = str(job_fit["job_level"])

    keywords = extract_keywords(title=title, description=description, classification=classification)
    keyword_result = extract_keywords_with_ollama(
        title=title,
        description=description,
        role_family=str(classification.get("role_family") or ""),
        job_level=str(classification.get("job_level") or ""),
    )
    if keyword_result.get("success"):
        keywords["must_have_terms"] = list(keyword_result.get("keywords") or [])
    raw_keywords = [
        str(item).strip() for item in keywords.get("must_have_terms", []) if str(item).strip()
    ]
    role_family = str(classification.get("role_family") or "general")
    tex, selection_report = render_selected_master_resume(
        title=title,
        keywords=raw_keywords,
        role_family=role_family,
        selection_overrides=selection_overrides,
    )
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".tex", prefix="option_a_master_")
    try:
        tmp.write(tex.encode("utf-8"))
        tmp.flush()
    finally:
        tmp.close()
    report = {
        "title": title,
        "role_family": role_family,
        "classification": classification,
        "keywords": raw_keywords,
        "job_fit": job_fit,
        "selection": selection_report,
        "resume_path": tmp.name,
    }
    Path(tmp.name).with_suffix(".selection.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    return tmp.name, report
