from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
import urllib.request
from collections import defaultdict
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from pathlib import Path
from typing import Any

from . import config as _config
from .config import DEFAULT_OG_RESUME_PATH
from .job_metadata_settings import load_c2_prompt_settings
from .jobs.classifier import classify_job, slugify
from .jobs.keyword_extractor import extract_keywords
from .jobs.keyword_policy import (
    KeywordKind,
    classify_keyword_policy,
    normalize_keyword,
)
from .jobs.title_inference import infer_title_from_description, normalize_title_candidate
from .keyword_check import partition_keywords
from .llm.llm_enrich import (
    analyze_job_fit_with_ollama,
    bucket_skill_keywords_with_ollama,
    capitalize_skill_phrase,
    extract_keywords_with_ollama,
    filter_summary_keywords_with_ollama,
    generate_summary,
    keyword_visible_in_text,
    restore_textbf_from_original,
    rewrite_bullet_targeted,
    validate_summary_grounding,
    validate_summary_with_ollama,
)
from .llm.rag import match_keywords_to_bullets, score_bullets_for_drop
from .pipeline import _compile_with_fit_retry
from .pipeline_logger import PipelineLogger
from .resume.compiler import compile_tex
from .resume.importer import ImportReport, parse_resume_upload
from .resume.parser import parse_resume_file
from .resume.renderer import render_resume_tex
from .resume.review_models import (
    ResumeReviewJobInfo,
    ResumeReviewLlmInfo,
    ResumeReviewPackage,
    ResumeReviewSourceInfo,
    ResumeReviewVersion,
    ResumeReviewVersionName,
    build_review_id,
)
from .resume.review_store import write_review_package
from .storage import build_attempt_dir, ensure_dir, write_json, write_text
from .text_normalize import repair_mojibake

BucketId = tuple[str, str]

SUMMARY_KEYWORD_LIMIT = 3
MIN_HIGH_RAG_MATCHES_FOR_REWRITE = 2
BULLET_ORDER_FIRST_SCORE_MULTIPLIER = 1.5
BULLET_ORDER_LAST_SCORE_MULTIPLIER = 1.0
BULLET_KEYWORD_RETENTION_MULTIPLIER = 2.0


class JobMismatchError(Exception):
    """Raised when the detected JD is not compatible with the requested role."""


def _description_hash(description: str) -> str:
    return hashlib.sha256((description or "").encode("utf-8")).hexdigest()


def _review_url(review_id: str, version: str, kind: str) -> str:
    return f"/api/fletcher/reviews/{review_id}/versions/{version}/{kind}"


def _provider_cloud_flag() -> bool:
    provider = _config.resume_llm_provider()
    return provider in {"openai", "openrouter", "anthropic", "gemini"}


def _write_starting_resume_artifacts(attempt_dir: Path, doc) -> dict[str, Any]:
    attempt_dir.mkdir(parents=True, exist_ok=True)
    tex_path = attempt_dir / "starting.tex"
    tex_path.write_text(render_resume_tex(doc), encoding="utf-8")
    compile_result = compile_tex(tex_path)
    return {
        "starting_tex_path": str(tex_path),
        "starting_pdf_path": compile_result.get("pdf_path"),
        "starting_compile_status": compile_result.get("compile_status"),
        "starting_fits_one_page": compile_result.get("fits_one_page"),
        "starting_page_count": compile_result.get("page_count"),
    }


def _make_review_package(
    *,
    attempt_dir: Path,
    original_doc,
    result: dict[str, Any],
    title: str,
    company: str,
    description: str,
    source_report: ImportReport,
    raw_keywords: list[str],
    present_keywords: list[str],
    missing_keywords: list[str],
    present_coverage: dict[str, list[int]] | None = None,
    rag_scores: list[dict[str, Any]] | None = None,
    used_keywords: list[dict[str, Any]] | None = None,
) -> tuple[str | None, str | None]:
    review_id = build_review_id(attempt_dir)
    versions: dict[ResumeReviewVersionName, ResumeReviewVersion] = {}

    def parse_generated(tex_path: str | None, fallback_doc):
        if tex_path and Path(tex_path).exists():
            try:
                return parse_resume_file(tex_path)
            except Exception:
                return copy.deepcopy(fallback_doc)
        return copy.deepcopy(fallback_doc)

    starting_doc = parse_generated(result.get("starting_tex_path"), original_doc)
    versions[ResumeReviewVersionName.STARTING] = ResumeReviewVersion(
        original=copy.deepcopy(starting_doc),
        generated=copy.deepcopy(starting_doc),
        current=copy.deepcopy(starting_doc),
        pdf_url=_review_url(review_id, "starting", "pdf"),
        tex_url=_review_url(review_id, "starting", "tex"),
        compile_status=result.get("starting_compile_status"),
    )
    generated_no_summary = parse_generated(result.get("tex_path"), original_doc)
    generated_no_summary.summary = ""
    versions[ResumeReviewVersionName.NO_SUMMARY] = ResumeReviewVersion(
        original=copy.deepcopy(original_doc),
        generated=copy.deepcopy(generated_no_summary),
        current=copy.deepcopy(generated_no_summary),
        pdf_url=_review_url(review_id, "no_summary", "pdf"),
        tex_url=_review_url(review_id, "no_summary", "tex"),
        compile_status=result.get("compile_status"),
    )
    if result.get("tex_path_summary") or result.get("pdf_path_summary"):
        generated_summary = parse_generated(result.get("tex_path_summary"), generated_no_summary)
        versions[ResumeReviewVersionName.WITH_SUMMARY] = ResumeReviewVersion(
            original=copy.deepcopy(original_doc),
            generated=copy.deepcopy(generated_summary),
            current=copy.deepcopy(generated_summary),
            pdf_url=_review_url(review_id, "with_summary", "pdf"),
            tex_url=_review_url(review_id, "with_summary", "tex"),
            compile_status=result.get("compile_status"),
        )

    provider = _config.resume_llm_provider()
    package = ResumeReviewPackage(
        review_id=review_id,
        source=ResumeReviewSourceInfo(
            input_kind=source_report.input_kind,
            input_filename=source_report.input_filename,
            import_status=source_report.import_status,  # type: ignore[arg-type]
            import_warnings=source_report.import_warnings,
        ),
        job=ResumeReviewJobInfo(
            title=title,
            company=company,
            role_family=str(result.get("role_family") or ""),
            job_level=str(result.get("job_level") or ""),
            description_hash=_description_hash(description),
        ),
        llm=ResumeReviewLlmInfo(
            provider=provider,
            model=_config.resume_llm_model() or _config.ollama_model_name(),
            cloud=_provider_cloud_flag(),
        ),
        keywords={
            "raw": list(raw_keywords or []),
            "present": list(present_keywords or []),
            "missing": list(missing_keywords or []),
            "used": list(used_keywords or []),
            "rag_scores": _review_keyword_scores(
                raw_keywords=raw_keywords,
                present_keywords=present_keywords,
                missing_keywords=missing_keywords,
                present_coverage=present_coverage,
                rag_scores=rag_scores,
                used_keywords=used_keywords,
                high_threshold=_config.RAG_HIGH_THRESHOLD,
            ),
        },
        versions=versions,
        log_url=f"/api/fletcher/reviews/{review_id}/log",
    )
    package_path = write_review_package(attempt_dir, package)
    return review_id, package_path


def _attach_review_package(
    payload: dict[str, Any],
    *,
    attempt_dir: Path,
    original_doc,
    title: str,
    company: str,
    description: str,
    source_report: ImportReport,
) -> dict[str, Any]:
    try:
        review_id, package_path = _make_review_package(
            attempt_dir=attempt_dir,
            original_doc=original_doc,
            result=payload,
            title=title,
            company=company,
            description=description,
            source_report=source_report,
            raw_keywords=list(payload.get("keywords") or []),
            present_keywords=list(payload.get("present_keywords") or []),
            missing_keywords=list(payload.get("missing_keywords") or []),
            present_coverage=dict(payload.get("present_coverage") or {}),
            rag_scores=list(payload.get("rag_scores") or []),
            used_keywords=list(payload.get("used_keywords") or []),
        )
        payload["review_id"] = review_id
        payload["review_url"] = f"/fletcher/reviews/{review_id}" if review_id else None
        payload["review_package_path"] = package_path
    except Exception as exc:
        payload["review_error"] = str(exc)
    return payload


def _review_keyword_scores(
    *,
    raw_keywords: list[str],
    present_keywords: list[str],
    missing_keywords: list[str],
    present_coverage: dict[str, list[int]] | None = None,
    rag_scores: list[dict[str, Any]] | None = None,
    used_keywords: list[dict[str, Any]] | None = None,
    high_threshold: float | None = None,
) -> list[dict[str, Any]]:
    min_score = _config.RAG_HIGH_THRESHOLD if high_threshold is None else high_threshold
    score_by_keyword: dict[str, dict[str, Any]] = {}
    for detail in rag_scores or []:
        keyword = str(detail.get("keyword") or "").strip()
        if not keyword:
            continue
        key = keyword.lower()
        score = float(detail.get("score") or 0.0)
        existing = score_by_keyword.get(key)
        if existing and float(existing.get("score") or 0.0) >= score:
            continue
        row = {
            "keyword": keyword,
            "tier": str(detail.get("tier") or "unranked"),
            "score": score,
            "bullet_idx": detail.get("bullet_idx"),
        }
        candidates = [
            candidate
            for candidate in list(detail.get("candidates") or [])
            if str(detail.get("tier") or "").lower() == "high"
            and float(candidate.get("score") or 0.0) >= min_score
        ]
        if candidates:
            row["candidates"] = candidates
        score_by_keyword[key] = row

    used_by_keyword: dict[str, dict[str, Any]] = {}
    for detail in used_keywords or []:
        keyword = str(detail.get("keyword") or "").strip()
        if not keyword:
            continue
        used_by_keyword[keyword.lower()] = dict(detail)

    present_l = {keyword.lower() for keyword in present_keywords}
    present_hits_by_keyword = {
        str(keyword).lower(): list(indices or [])
        for keyword, indices in (present_coverage or {}).items()
    }
    missing_l = {keyword.lower() for keyword in missing_keywords}
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for keyword in raw_keywords:
        item = str(keyword or "").strip()
        key = item.lower()
        if not item or key in seen:
            continue
        seen.add(key)
        row = dict(score_by_keyword.get(key) or {})
        used = used_by_keyword.get(key)
        row["keyword"] = row.get("keyword") or item
        if used:
            row["tier"] = row.get("tier") or "used"
            support_kind = str(used.get("support_kind") or "")
            row["status"] = "rewrite_used" if support_kind == "rewrite_added" else "supported"
            row["support_kind"] = support_kind or row["status"]
            row["used_bullet_idx"] = used.get("bullet_idx")
            row.setdefault("bullet_idx", used.get("bullet_idx"))
            row.setdefault("score", used.get("score", 1.0))
            if row["status"] == "supported":
                row["tier"] = "supported"
        elif key in present_l:
            row["tier"] = (
                row.get("tier") if row.get("tier") not in {None, "unranked"} else "present"
            )
            row["status"] = "present"
            row.setdefault("score", 1.0)
            candidates = [
                {"bullet_idx": idx, "score": 1.0}
                for idx in present_hits_by_keyword.get(key, [])
                if isinstance(idx, int)
            ]
            if candidates:
                row["candidates"] = candidates
        elif key in missing_l:
            row["tier"] = row.get("tier") or "unranked"
            row["status"] = "missing"
            row.setdefault("score", 0.0)
        else:
            row["tier"] = row.get("tier") or "unranked"
            row["status"] = "raw"
            row.setdefault("score", 0.0)
        rows.append(row)
    return rows


def _classification_needs_llm_fallback(classification: dict) -> bool:
    return (
        not classification
        or classification.get("role_family") in {None, "", "general", "unknown"}
        or classification.get("job_level") in {None, "", "unknown"}
        or "low_confidence_match" in set(classification.get("concern_flags") or [])
    )


def _default_target_title() -> str:
    return str(load_c2_prompt_settings().get("default_target_title") or "Target Role").strip()


def _skill_addition_limit() -> int:
    return int(load_c2_prompt_settings().get("skill_addition_limit") or 0)


def _missing_job_metadata_fields(title: str, classification: dict) -> list[str]:
    missing = []
    if not (title or "").strip():
        missing.append("title")
    if classification.get("role_family") in (None, "", "general", "unknown"):
        missing.append("role_family")
    if classification.get("job_level") in (None, "", "unknown"):
        missing.append("job_level")
    return missing


def _merge_llm_classification(base: dict, llm_result: dict) -> dict:
    if not llm_result.get("success"):
        return base
    merged = dict(base)
    llm_family = llm_result.get("role_family")
    current_family = merged.get("role_family")
    if llm_family and not (
        llm_family == "general" and current_family not in {None, "", "general", "unknown"}
    ):
        merged["role_family"] = llm_family
    merged["job_level"] = llm_result.get("job_level") or merged.get("job_level")
    merged["confidence"] = round(float(llm_result.get("confidence") or 0.7), 2)
    reasons = list(merged.get("reasons") or [])
    reasons.extend(f"llm:{reason}" for reason in llm_result.get("reasons", [])[:4])
    merged["reasons"] = reasons[:24]
    flags = [
        flag for flag in list(merged.get("concern_flags") or []) if flag != "low_confidence_match"
    ]
    merged["concern_flags"] = flags
    return merged


def _text_hash(text: str) -> str:
    return hashlib.sha1((text or "").encode("utf-8")).hexdigest()[:12]


def _resolve_job_title(title: str, description: str) -> str:
    normalized = normalize_title_candidate(title)
    if normalized:
        return normalized
    inferred = infer_title_from_description(description)
    return inferred or title or ""


def _title_from_keywords(raw_keywords: list[str]) -> str:
    for keyword in raw_keywords:
        policy = classify_keyword_policy(keyword)
        if policy.kind.value == "role_title":
            normalized = normalize_title_candidate(keyword)
            if normalized:
                return normalized
    return ""


def _get_entries(doc, kind: str):
    return doc.experience if kind == "exp" else doc.projects


def _find_entry(doc, kind: str, entry_id: str):
    for entry in _get_entries(doc, kind):
        if entry.entry_id == entry_id:
            return entry
    return None


def _filter_doc_to_active_buckets(doc, active_bucket_ids: list[BucketId]) -> None:
    active = set(active_bucket_ids)
    doc.experience = [entry for entry in doc.experience if ("exp", entry.entry_id) in active]
    doc.projects = [entry for entry in doc.projects if ("proj", entry.entry_id) in active]


def _collect_active_bullets(doc, active_bucket_ids: list[BucketId]) -> tuple[list[str], list[dict]]:
    active = set(active_bucket_ids)
    bullets: list[str] = []
    sources: list[dict] = []
    for kind, entries in (("exp", doc.experience), ("proj", doc.projects)):
        for entry in entries:
            bucket = (kind, entry.entry_id)
            if bucket not in active:
                continue
            for idx, bullet in enumerate(entry.bullets):
                h = _text_hash(bullet)
                source = {
                    "bullet_id": f"{kind}_{entry.entry_id}_{idx}_{h}",
                    "kind": kind,
                    "entry_id": entry.entry_id,
                    "original_local_idx": idx,
                    "original_bullet_count": len(entry.bullets),
                    "text_hash": h,
                    "text": bullet,
                }
                bullets.append(bullet)
                sources.append(source)
    return bullets, sources


def _source_ref(source: dict) -> tuple[str, str, int]:
    return (
        str(source.get("kind") or ""),
        str(source.get("entry_id") or ""),
        int(source.get("original_local_idx") or 0),
    )


def _remove_bullet_from_doc(doc, source: dict) -> bool:
    entry = _find_entry(doc, source["kind"], source["entry_id"])
    if entry is None:
        return False

    for idx, bullet in enumerate(entry.bullets):
        if _text_hash(bullet) == source["text_hash"]:
            entry.bullets.pop(idx)
            return True

    fallback_idx = int(source.get("original_local_idx") or 0)
    if 0 <= fallback_idx < len(entry.bullets):
        entry.bullets.pop(fallback_idx)
        return True
    return False


def _remove_bucket_from_doc(doc, kind: str, entry_id: str) -> bool:
    entries = _get_entries(doc, kind)
    before = len(entries)
    entries[:] = [entry for entry in entries if entry.entry_id != entry_id]
    return len(entries) != before


def _score_sources(
    bullets: list[str],
    sources: list[dict],
    raw_keywords: list[str],
    classification: dict | None = None,
    rag_scores: list[dict] | None = None,
    job_title: str = "",
    rewritten_refs: set[tuple[str, str, int]] | None = None,
) -> dict[str, float]:
    base_scores = score_bullets_for_drop(bullets, raw_keywords)
    title_scores = score_bullets_for_drop(bullets, [job_title]) if job_title.strip() else []
    contribution = _coverage_contribution_scores(sources, rag_scores or [])
    scores: dict[str, float] = {}
    for idx, source in enumerate(sources):
        base = base_scores[idx] if idx < len(base_scores) else 0.0
        contrib = contribution.get(source["bullet_id"], 0.0)
        title_bonus = (title_scores[idx] * 0.12) if idx < len(title_scores) else 0.0
        order_multiplier = _bullet_order_score_multiplier(source)
        retention_multiplier = _keyword_retention_score_multiplier(
            bullets[idx] if idx < len(bullets) else source.get("text", ""),
            source,
            raw_keywords,
            rewritten_refs,
        )
        scores[source["bullet_id"]] = round(
            min(max(base, contrib) + title_bonus, 1.0) * order_multiplier * retention_multiplier,
            4,
        )
    return scores


def _score_details(
    bullets: list[str],
    sources: list[dict],
    raw_keywords: list[str],
    classification: dict | None = None,
    rag_scores: list[dict] | None = None,
    job_title: str = "",
    rewritten_refs: set[tuple[str, str, int]] | None = None,
) -> dict[str, dict[str, Any]]:
    base_scores = score_bullets_for_drop(bullets, raw_keywords)
    title_scores = score_bullets_for_drop(bullets, [job_title]) if job_title.strip() else []
    contribution = _coverage_contribution_scores(sources, rag_scores or [])
    details: dict[str, dict[str, Any]] = {}
    for idx, source in enumerate(sources):
        base = base_scores[idx] if idx < len(base_scores) else 0.0
        contrib = contribution.get(source["bullet_id"], 0.0)
        title_bonus = (title_scores[idx] * 0.12) if idx < len(title_scores) else 0.0
        order_multiplier = _bullet_order_score_multiplier(source)
        pre_order = min(max(base, contrib) + title_bonus, 1.0)
        text = bullets[idx] if idx < len(bullets) else source.get("text", "")
        retention_multiplier = _keyword_retention_score_multiplier(
            text,
            source,
            raw_keywords,
            rewritten_refs,
        )
        details[source["bullet_id"]] = {
            "score_base": round(base, 4),
            "score_bonus": round(max(0.0, contrib - base), 4),
            "score_title_bonus": round(title_bonus, 4),
            "score_order_multiplier": round(order_multiplier, 4),
            "score_keyword_retention_multiplier": round(retention_multiplier, 4),
            "score_keyword_retention_reasons": _keyword_retention_reasons(
                text,
                source,
                raw_keywords,
                rewritten_refs,
            ),
            "score_final": round(pre_order * order_multiplier * retention_multiplier, 4),
        }
    return details


def _keyword_retention_reasons(
    bullet: str,
    source: dict,
    raw_keywords: list[str],
    rewritten_refs: set[tuple[str, str, int]] | None = None,
) -> list[str]:
    reasons: list[str] = []
    if rewritten_refs and _source_ref(source) in rewritten_refs:
        reasons.append("rewritten")
    matched = [
        keyword
        for keyword in _dedupe([str(keyword).strip() for keyword in raw_keywords])
        if keyword and keyword_visible_in_text(keyword, bullet)
    ]
    if matched:
        reasons.append("visible_keyword")
    return reasons


def _keyword_retention_score_multiplier(
    bullet: str,
    source: dict,
    raw_keywords: list[str],
    rewritten_refs: set[tuple[str, str, int]] | None = None,
) -> float:
    if _keyword_retention_reasons(bullet, source, raw_keywords, rewritten_refs):
        return BULLET_KEYWORD_RETENTION_MULTIPLIER
    return 1.0


def _bullet_order_score_multiplier(source: dict) -> float:
    """Give earlier bullets a configurable retention boost within their own bucket."""
    count = int(source.get("original_bullet_count") or 0)
    idx = int(source.get("original_local_idx") or 0)
    if count <= 1:
        return BULLET_ORDER_FIRST_SCORE_MULTIPLIER
    clamped_idx = max(0, min(idx, count - 1))
    progress = clamped_idx / max(1, count - 1)
    spread = BULLET_ORDER_FIRST_SCORE_MULTIPLIER - BULLET_ORDER_LAST_SCORE_MULTIPLIER
    return BULLET_ORDER_FIRST_SCORE_MULTIPLIER - (spread * progress)


def _coverage_contribution_scores(
    sources: list[dict], rag_scores: list[dict] | None
) -> dict[str, float]:
    """Protect bullets that uniquely or strongly cover at least one keyword."""
    if not sources or not rag_scores:
        return {}
    by_idx = {
        int(source.get("rag_idx", idx)): source["bullet_id"] for idx, source in enumerate(sources)
    }
    by_text = {
        str(source.get("text") or "").strip(): source["bullet_id"]
        for source in sources
        if str(source.get("text") or "").strip()
    }
    contribution: dict[str, float] = {}
    for detail in rag_scores or []:
        candidates = detail.get("candidates") or [
            {
                "bullet_idx": detail.get("bullet_idx"),
                "bullet_text": detail.get("bullet_text"),
                "score": detail.get("score"),
            }
        ]
        for rank, candidate in enumerate(candidates[:3]):
            bullet_id = None
            text = str(candidate.get("bullet_text") or "").strip()
            if text:
                bullet_id = by_text.get(text)
            idx = candidate.get("bullet_idx")
            if bullet_id is None and isinstance(idx, int):
                bullet_id = by_idx.get(idx)
            if bullet_id is None:
                continue
            score = float(candidate.get("score") or 0.0)
            if score <= 0:
                continue
            rank_bonus = 0.05 if rank == 0 else 0.02
            contribution[bullet_id] = max(
                contribution.get(bullet_id, 0.0), min(score + rank_bonus, 1.0)
            )
    return contribution


def _annotate_rag_indices(sources: list[dict]) -> list[dict]:
    for idx, source in enumerate(sources):
        source.setdefault("rag_idx", idx)
    return sources


def _filter_sources_present_in_doc(doc, sources: list[dict]) -> list[dict]:
    live_hashes: dict[tuple[str, str], set[str]] = {}
    for kind, entries in (("exp", doc.experience), ("proj", doc.projects)):
        for entry in entries:
            live_hashes[(kind, entry.entry_id)] = {_text_hash(bullet) for bullet in entry.bullets}
    return [
        source
        for source in sources
        if source.get("text_hash")
        in live_hashes.get((source.get("kind"), source.get("entry_id")), set())
    ]


_RAG_TIER_RANK = {"error": 0, "low": 0, "mid": 1, "high": 2}


def _rag_keyword_tiers(match_result: dict) -> dict[str, str]:
    tiers: dict[str, str] = {}

    def remember(keyword: str, tier: str) -> None:
        key = str(keyword or "").strip().lower()
        if not key:
            return
        current = tiers.get(key)
        if current is None or _RAG_TIER_RANK.get(tier, 0) > _RAG_TIER_RANK.get(current, 0):
            tiers[key] = tier

    for detail in match_result.get("scores") or []:
        remember(str(detail.get("keyword") or ""), str(detail.get("tier") or "low"))
    for match in match_result.get("bullet_matches") or []:
        remember(str(match.get("keyword") or ""), "high")
    for keyword in match_result.get("summary_keywords") or []:
        remember(str(keyword or ""), "mid")
    for keyword in match_result.get("ignored_keywords") or []:
        remember(str(keyword or ""), "low")
    return tiers


def _rag_kept_keyword(keyword: str, tiers: dict[str, str]) -> bool:
    return tiers.get(str(keyword or "").strip().lower()) in {"high", "mid"}


def _rag_keywords_by_tier(keywords: list[str], tiers: dict[str, str], tier: str) -> list[str]:
    return [
        keyword for keyword in keywords if tiers.get(str(keyword or "").strip().lower()) == tier
    ]


def _keyword_present(keyword: str, doc) -> bool:
    haystack = " ".join(
        [b for entry in doc.experience for b in entry.bullets]
        + [b for entry in doc.projects for b in entry.bullets]
    )
    return keyword_visible_in_text(keyword, haystack)


_SLASH_KEYWORDS_TO_KEEP = {"a/b testing", "ci/cd", "pl/sql"}


def _split_slash_keyword(keyword: str) -> list[str]:
    item = str(keyword or "").strip()
    if "/" not in item:
        return [item] if item else []
    lower_item = item.lower()
    if lower_item in _SLASH_KEYWORDS_TO_KEEP or "ci/cd" in lower_item or "web/app" in lower_item:
        return [item]
    parts = [part.strip() for part in item.split("/") if part.strip()]
    if len(parts) < 2:
        return [item] if item else []
    if not all(len(part.split()) <= 3 for part in parts):
        return [item]
    if not all(re.search(r"[A-Z0-9+#.]", part) for part in parts):
        return [item]
    return parts


def _normalize_extracted_keywords(keywords: list[str]) -> list[str]:
    out: list[str] = []
    for keyword in keywords:
        out.extend(_split_slash_keyword(keyword))
    settings = load_c2_prompt_settings()
    blocked_keywords = {
        normalize_keyword(str(keyword))
        for keyword in settings.get("blocked_keywords", [])
        if str(keyword).strip()
    }
    return _dedupe(
        [keyword for keyword in out if normalize_keyword(keyword) not in blocked_keywords]
    )


def _keyword_match_surfaces(doc, all_bullets: list[str]) -> list[str]:
    skills = (
        list(doc.skills.languages) + list(doc.skills.frameworks) + list(doc.skills.developer_tools)
    )
    return list(all_bullets) + _dedupe(
        [str(skill).strip() for skill in skills if str(skill).strip()]
    )


def _skill_validation_context(doc) -> str:
    bullets = [b for entry in doc.experience for b in entry.bullets] + [
        b for entry in doc.projects for b in entry.bullets
    ]
    skill_names = (
        list(doc.skills.languages) + list(doc.skills.frameworks) + list(doc.skills.developer_tools)
    )
    return " ".join(bullets[:18] + skill_names)


def _existing_skill_keys(existing_skills: dict[str, list[str]]) -> set[str]:
    return {
        normalize_keyword(str(value))
        for values in existing_skills.values()
        for value in values
        if normalize_keyword(str(value))
    }


def _has_existing_skills_section_values(doc) -> bool:
    return bool(
        list(doc.skills.languages)
        or list(doc.skills.frameworks)
        or list(doc.skills.developer_tools)
    )


def _add_keywords_to_skills(
    doc,
    keywords: list[str],
    *,
    job_title: str = "",
    logger: PipelineLogger | None = None,
) -> list[str]:
    added: list[str] = []
    if not _has_existing_skills_section_values(doc):
        if logger:
            logger.step("skill_bucket_skipped", reason="no_existing_skills_section_values")
        return []
    existing_skills = {
        "languages": list(doc.skills.languages),
        "frameworks": list(doc.skills.frameworks),
        "developer_tools": list(doc.skills.developer_tools),
    }
    existing = _existing_skill_keys(existing_skills)
    skill_candidates = _normalize_extracted_keywords(_dedupe(keywords))
    if not skill_candidates:
        return []
    skill_addition_limit = _skill_addition_limit()
    if skill_addition_limit <= 0:
        if logger:
            logger.step("skill_bucket_skipped", reason="skill_addition_limit_zero")
        return []
    if logger:
        _log_ollama_runtime(logger, "before_skill_bucket")
    bucketed = bucket_skill_keywords_with_ollama(
        keywords=skill_candidates,
        existing_skills=existing_skills,
        job_title=job_title,
        logger=logger,
    )
    if not bucketed.get("success"):
        return []
    proposed: list[str] = []
    for bucket in ("languages", "frameworks", "developer_tools"):
        proposed.extend(_normalize_extracted_keywords(list(bucketed.get(bucket, []) or [])))
    proposed = _dedupe([keyword for keyword in proposed if keyword.strip()])
    if not proposed:
        return []
    accepted = {keyword.lower() for keyword in proposed[:skill_addition_limit]}
    for bucket in ("languages", "frameworks", "developer_tools"):
        for keyword in _normalize_extracted_keywords(list(bucketed.get(bucket, []) or [])):
            key = str(keyword).strip().lower()
            skill_key = normalize_keyword(keyword)
            if not key or skill_key in existing:
                continue
            if key not in accepted:
                continue
            if len(added) >= skill_addition_limit:
                return added
            display_keyword = capitalize_skill_phrase(str(keyword).strip())
            getattr(doc.skills, bucket).append(display_keyword)
            existing.add(skill_key)
            added.append(display_keyword)
    return added


def _dedupe(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        key = value.lower()
        if key and key not in seen:
            seen.add(key)
            result.append(value)
    return result


def _validation_reasons(result: dict[str, Any]) -> list[str]:
    validation = result.get("validation") or {}
    reasons = list(validation.get("reasons") or [])
    for keyword in validation.get("keywords_rejected") or []:
        reasons.append(f"llm_rejected_keyword:{keyword}")
    llm_validation = validation.get("llm_validation") or {}
    for keyword in llm_validation.get("keywords_rejected") or []:
        reasons.append(f"llm_rejected_keyword:{keyword}")
    return reasons


def _summary_keyword_supported(
    keyword: str,
    candidate_context: str,
    validation_reasons: list[str],
) -> bool:
    key = (keyword or "").strip().lower()
    if not key:
        return False
    for reason in validation_reasons:
        prefix, _sep, value = str(reason).partition(":")
        if (
            prefix
            in {
                "unsupported_domain_keyword",
                "unsupported_summary_domain",
                "llm_rejected_keyword",
            }
            and value.lower() == key
        ):
            return False
    return keyword_visible_in_text(keyword, candidate_context)


def _filter_summary_keywords(
    base_keywords: list[str],
    skipped_keywords: list[str],
    candidate_context: str,
    validation_reasons: list[str],
) -> tuple[list[str], list[str]]:
    # If the LLM summary-keyword filter is unavailable, keep the signals in the
    # safer summary lane and let summary generation/validation decide support.
    included = _dedupe(list(base_keywords) + list(skipped_keywords))[:SUMMARY_KEYWORD_LIMIT]
    included_l = {keyword.lower() for keyword in included}
    excluded = [
        keyword
        for keyword in _dedupe(list(base_keywords) + list(skipped_keywords))
        if keyword.lower() not in included_l
    ]
    return included, excluded


def _keywords_rejected_by_summary_validation(
    validation: dict[str, Any], keywords: list[str]
) -> list[str]:
    reasons = " ".join(str(reason) for reason in validation.get("reasons") or []).lower()
    rejected: list[str] = []
    for keyword in keywords:
        key = str(keyword).strip().lower()
        if key and key in reasons:
            rejected.append(keyword)
    return _dedupe(rejected)


def _summary_validation_retry_feedback(validation: dict[str, Any]) -> tuple[str, str]:
    reasons = [str(reason) for reason in validation.get("reasons") or []]
    banned = []
    for reason in reasons:
        if reason.startswith("banned_tone:"):
            phrase = reason.split(":", maxsplit=1)[1].strip()
            if phrase:
                banned.append(phrase)
    if banned:
        unique_banned = _dedupe(banned)
        banned_text = ", ".join(unique_banned)
        feedback = (
            f"Remove banned tone: {banned_text}. "
            "Do not use seeking/apply/excited/eager/motivated phrasing. "
            "State capability directly."
        )
        return feedback, f"Remove banned tone: {banned_text}."
    return (
        "Revise to remove awkward domain claims and junior-sounding filler. "
        "Use only role/process keywords that fit the candidate background.",
        "",
    )


def _summary_filter_needs_llm(keywords: list[str]) -> bool:
    """Use model judgment whenever there are summary keywords to choose from."""
    cleaned = _dedupe([keyword for keyword in keywords if keyword.strip()])
    return bool(cleaned)


def _keyword_rewrite_eligible(keyword: str) -> bool:
    key = (keyword or "").strip().lower()
    if not key:
        return False
    policy = classify_keyword_policy(keyword)
    if policy.kind in {
        KeywordKind.QUALITY,
        KeywordKind.ROLE_TITLE,
        KeywordKind.EDUCATION,
        KeywordKind.LOGISTICS,
        KeywordKind.ORG_METADATA,
        KeywordKind.LANGUAGE_REQUIREMENT,
    }:
        return False
    return True


def _select_rewrite_assignments(
    matches: list[dict],
    *,
    max_keywords_per_bullet: int = 2,
    high_threshold: float | None = None,
) -> dict[int, list[str]]:
    """Globally assign high RAG keywords while capping each bullet's rewrite load."""
    min_score = _config.RAG_HIGH_THRESHOLD if high_threshold is None else high_threshold
    by_keyword: dict[str, list[dict]] = {}
    for match in matches:
        keyword = str(match.get("keyword") or "").strip()
        idx = match.get("bullet_idx")
        if not keyword or not isinstance(idx, int):
            continue
        options: list[dict] = []
        for candidate in match.get("candidates") or []:
            c_idx = candidate.get("bullet_idx")
            score = float(candidate.get("score") or 0.0)
            if isinstance(c_idx, int) and score >= min_score:
                options.append(
                    {
                        **match,
                        "bullet_idx": c_idx,
                        "score": score,
                    }
                )
        if not options and float(match.get("score") or 0.0) >= min_score:
            options = [match]
        if options:
            by_keyword.setdefault(keyword.lower(), []).extend(options)

    candidates: list[dict] = []
    for options in by_keyword.values():
        options.sort(key=lambda item: float(item.get("score") or 0.0), reverse=True)
        best_score = float(options[0].get("score") or 0.0) if options else 0.0
        for option in options[:4]:
            score = float(option.get("score") or 0.0)
            candidates.append(
                {
                    **option,
                    "score": score,
                    "regret": max(0.0, best_score - score),
                }
            )

    assigned_keywords: set[str] = set()
    bullet_load: dict[int, int] = defaultdict(int)
    selected: dict[int, list[str]] = defaultdict(list)
    candidates.sort(key=lambda item: (item["score"] - item["regret"], item["score"]), reverse=True)
    for candidate in candidates:
        keyword = str(candidate.get("keyword") or "").strip()
        key = keyword.lower()
        idx = candidate.get("bullet_idx")
        if not keyword or key in assigned_keywords or not isinstance(idx, int):
            continue
        if bullet_load[idx] >= max_keywords_per_bullet:
            continue
        selected[idx].append(keyword)
        bullet_load[idx] += 1
        assigned_keywords.add(key)
    return dict(selected)


def _compile_doc(attempt_dir: Path, doc, stem: str) -> tuple[dict, str]:
    tex_path = write_text(attempt_dir / f"{stem}.tex", render_resume_tex(doc))
    return compile_tex(tex_path), tex_path


def _page_needs_drop(compile_result: dict) -> bool:
    if compile_result.get("fits_one_page"):
        return False
    if compile_result.get("compile_status") != "ok":
        return False
    page_count = compile_result.get("page_count")
    return page_count is not None and page_count > 1


def _fit_to_page(
    attempt_dir: Path,
    doc,
    stem: str,
    bullet_sources: list[dict],
    scores_by_bullet_id: dict[str, float],
    logger: PipelineLogger,
    *,
    floor: int = 2,
) -> tuple[dict, str, BucketId | None]:
    source_by_id = {source["bullet_id"]: source for source in bullet_sources}
    source_order = {source["bullet_id"]: idx for idx, source in enumerate(bullet_sources)}
    per_bucket: dict[BucketId, list[str]] = {}
    for source in bullet_sources:
        bucket = (source["kind"], source["entry_id"])
        per_bucket.setdefault(bucket, []).append(source["bullet_id"])

    flagged: list[BucketId] = []
    while True:
        logger.step("compile_start", stem=stem)
        compile_result, tex_path = _compile_doc(attempt_dir, doc, stem)
        logger.step(
            "compile_done",
            stem=stem,
            status=compile_result.get("compile_status"),
            page_count=compile_result.get("page_count"),
            fits_one_page=compile_result.get("fits_one_page"),
        )
        if not _page_needs_drop(compile_result):
            return compile_result, tex_path, None

        candidates: list[str] = []
        for bucket, bullet_ids in per_bucket.items():
            remaining = [bid for bid in bullet_ids if bid in source_by_id]
            per_bucket[bucket] = remaining
            if not remaining or bucket in flagged:
                continue
            if len(remaining) > floor:
                candidates.append(
                    min(
                        remaining,
                        key=lambda bid: (
                            scores_by_bullet_id.get(bid, 0.0),
                            source_order.get(bid, 0),
                        ),
                    )
                )
            elif len(remaining) == floor:
                flagged.append(bucket)
                logger.step("bucket_floor_reached", stem=stem, kind=bucket[0], entry_id=bucket[1])

        if not candidates:
            if flagged:
                bucket = flagged[0]
                _remove_bucket_from_doc(doc, bucket[0], bucket[1])
                logger.step("bucket_removed", stem=stem, kind=bucket[0], entry_id=bucket[1])
                return compile_result, tex_path, bucket
            return compile_result, tex_path, None

        candidates.sort(
            key=lambda bid: (scores_by_bullet_id.get(bid, 0.0), source_order.get(bid, 0))
        )
        removed_any = False
        for bullet_id in candidates:
            source = source_by_id.get(bullet_id)
            if source is None:
                continue
            if _remove_bullet_from_doc(doc, source):
                per_bucket[(source["kind"], source["entry_id"])].remove(bullet_id)
                source_by_id.pop(bullet_id, None)
                logger.step(
                    "bullet_drop",
                    stem=stem,
                    bullet_id=bullet_id,
                    kind=source["kind"],
                    entry_id=source["entry_id"],
                    score=scores_by_bullet_id.get(bullet_id, 0.0),
                    reason="page_fit_lowest_score",
                    text=source.get("text"),
                )
                removed_any = True
                break

        if not removed_any:
            if flagged:
                bucket = flagged[0]
                _remove_bucket_from_doc(doc, bucket[0], bucket[1])
                logger.step("bucket_removed", stem=stem, kind=bucket[0], entry_id=bucket[1])
                return compile_result, tex_path, bucket
            return compile_result, tex_path, None


def _summary_line_count(pdf_path: str | None) -> tuple[str, int | None]:
    """Return rendered summary line check status and count.

    Status values:
    - ok: summary section was found and counted
    - unavailable: pdftotext is not installed, so local validation cannot run
    - missing_pdf, failed, missing_summary: validation ran or should have run but failed
    """
    if not pdf_path:
        return "missing_pdf", None
    pdftotext = shutil.which("pdftotext")
    if not pdftotext:
        return "unavailable", None
    try:
        result = subprocess.run(
            [pdftotext, "-layout", str(pdf_path), "-"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return "failed", None
    if result.returncode != 0:
        return "failed", None
    lines = [line.rstrip() for line in result.stdout.splitlines()]
    in_summary = False
    summary_lines: list[str] = []
    section_names = {"Education", "Experience", "Projects", "Technical Skills"}
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped == "Summary":
            in_summary = True
            continue
        if in_summary and stripped in section_names:
            break
        if in_summary:
            summary_lines.append(stripped)
    return ("ok", len(summary_lines)) if in_summary else ("missing_summary", None)


def _summary_line_check_accepts(status: str, line_count: int | None) -> bool:
    return status == "unavailable" or (status == "ok" and line_count in {4, 5})


def _summary_line_check_retries(status: str, line_count: int | None) -> bool:
    return status == "ok" and line_count not in {4, 5}


def _summary_evidence_bullets(
    bullets: list[str],
    sources: list[dict],
    scores: dict[str, float],
    *,
    limit: int = 3,
) -> list[str]:
    ranked = sorted(
        zip(bullets, sources, strict=False),
        key=lambda pair: scores.get(pair[1]["bullet_id"], 0.0),
        reverse=True,
    )
    return [bullet for bullet, _source in ranked[:limit]]


def _build_candidate_context(doc, evidence_bullets: list[str] | None = None) -> str:
    parts: list[str] = []
    if doc.summary:
        parts.append(f"Existing resume summary: {doc.summary}")
    exp_lines = [entry.title_company_location for entry in doc.experience[:3]]
    if exp_lines:
        parts.append("Experience: " + "; ".join(exp_lines))
    skill_names = (
        list(doc.skills.languages[:6])
        + list(doc.skills.frameworks[:6])
        + list(doc.skills.developer_tools[:6])
    )
    if skill_names:
        parts.append("Skills: " + ", ".join(_dedupe(skill_names)[:12]))
    if evidence_bullets:
        parts.append("Relevant evidence: " + " | ".join(evidence_bullets[:3]))
    return ". ".join(parts)


def _read_int_file(paths: tuple[str, ...]) -> int | None:
    for raw_path in paths:
        try:
            text = Path(raw_path).read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if not text or text == "max":
            continue
        try:
            value = int(text)
        except ValueError:
            continue
        if value > 0:
            return value
    return None


def _linux_meminfo_bytes(path: str = "/proc/meminfo") -> tuple[int | None, int | None, str]:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return None, None, "unknown"
    values: dict[str, int] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, raw_value = line.split(":", 1)
        parts = raw_value.strip().split()
        if not parts:
            continue
        try:
            kb = int(parts[0])
        except ValueError:
            continue
        values[key] = kb * 1024
    total = values.get("MemTotal")
    available = values.get("MemAvailable")
    if total is None or available is None:
        return None, None, "unknown"
    return max(0, total - available), total, "meminfo"


def _read_cgroup_stat_value(paths: tuple[str, ...], key: str) -> int | None:
    for raw_path in paths:
        try:
            text = Path(raw_path).read_text(encoding="utf-8")
        except OSError:
            continue
        for line in text.splitlines():
            parts = line.split()
            if len(parts) != 2 or parts[0] != key:
                continue
            try:
                value = int(parts[1])
            except ValueError:
                continue
            if value >= 0:
                return value
    return None


def _cgroup_memory_bytes() -> tuple[int | None, int | None, str]:
    current = _read_int_file(
        (
            "/sys/fs/cgroup/memory.current",
            "/sys/fs/cgroup/memory/memory.usage_in_bytes",
        )
    )
    limit = _read_int_file(
        (
            "/sys/fs/cgroup/memory.max",
            "/sys/fs/cgroup/memory/memory.limit_in_bytes",
        )
    )
    if current is None or limit is None or limit <= 0 or limit > 1 << 60:
        return None, None, "unknown"
    inactive_file = _read_cgroup_stat_value(
        (
            "/sys/fs/cgroup/memory.stat",
            "/sys/fs/cgroup/memory/memory.stat",
        ),
        "inactive_file",
    )
    used = current
    source = "cgroup"
    if inactive_file is not None:
        used = max(0, current - inactive_file)
        source = "cgroup_working_set"
    return used, limit, source


def _host_memory_bytes() -> tuple[int | None, int | None, str]:
    if os.name == "nt":
        try:
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = MEMORYSTATUSEX()
            status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                used = int(status.ullTotalPhys - status.ullAvailPhys)
                return used, int(status.ullTotalPhys), "windows"
        except Exception:
            return None, None, "unknown"

    used, total, source = _linux_meminfo_bytes()
    if used is not None and total is not None:
        return used, total, source

    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        phys_pages = os.sysconf("SC_PHYS_PAGES")
        available_pages = os.sysconf("SC_AVPHYS_PAGES")
        total = int(page_size * phys_pages)
        available = int(page_size * available_pages)
        return total - available, total, "host"
    except (OSError, ValueError, AttributeError):
        return None, None, "unknown"


def _memory_snapshot() -> dict[str, Any]:
    used, limit, source = _cgroup_memory_bytes()
    if used is None or limit is None:
        used, limit, source = _host_memory_bytes()
    if used is None or limit is None or limit <= 0:
        return {
            "source": source,
            "known": False,
            "used_mb": None,
            "limit_mb": None,
            "available_mb": None,
            "used_pct": None,
        }
    available = max(0, limit - used)
    return {
        "source": source,
        "known": True,
        "used_mb": round(used / 1024 / 1024, 1),
        "limit_mb": round(limit / 1024 / 1024, 1),
        "available_mb": round(available / 1024 / 1024, 1),
        "used_pct": round((used / limit) * 100, 1),
    }


def _safe_ollama_mb(value: Any) -> float | None:
    try:
        return round(float(value) / 1024 / 1024, 1)
    except (TypeError, ValueError):
        return None


def _ollama_runtime_snapshot() -> dict[str, Any]:
    configured = {
        "num_parallel": _config.OLLAMA_NUM_PARALLEL or None,
        "context_length": _config.OLLAMA_CONTEXT_LENGTH or None,
        "flash_attention": _config.OLLAMA_FLASH_ATTENTION or None,
        "kv_cache_type": _config.OLLAMA_KV_CACHE_TYPE or None,
        "keep_alive": _config.OLLAMA_KEEP_ALIVE,
    }
    if _config.resume_llm_provider() != "ollama":
        return {"enabled": False, "configured": configured}
    try:
        req = urllib.request.Request(f"{_config.ollama_host()}/api/ps", method="GET")
        with urllib.request.urlopen(req, timeout=2) as resp:
            body = json.load(resp)
        raw_models = body.get("models") if isinstance(body, dict) else []
        models = []
        for item in raw_models or []:
            if not isinstance(item, dict):
                continue
            models.append(
                {
                    "name": item.get("name") or item.get("model"),
                    "processor": item.get("processor"),
                    "size_mb": _safe_ollama_mb(item.get("size")),
                    "size_vram_mb": _safe_ollama_mb(item.get("size_vram")),
                }
            )
    except Exception as exc:
        return {
            "enabled": True,
            "reachable": False,
            "host": _config.ollama_host(),
            "configured": configured,
            "error": (str(exc) or exc.__class__.__name__)[:200],
        }
    return {
        "enabled": True,
        "reachable": True,
        "host": _config.ollama_host(),
        "configured": configured,
        "loaded_count": len(models),
        "models": models,
    }


def _log_ollama_runtime(logger: PipelineLogger, stage: str) -> None:
    logger.step("ollama_runtime", stage=stage, ollama=_ollama_runtime_snapshot())


def _memory_allows_parallel(snapshot: dict[str, Any]) -> tuple[bool, str]:
    if not snapshot.get("known"):
        return True, "memory_unknown"
    available_mb = float(snapshot.get("available_mb") or 0)
    used_pct = float(snapshot.get("used_pct") or 0)
    if available_mb < _config.bullet_rewrite_runtime()["min_available_mb"]:
        return False, "low_available_memory"
    if used_pct >= _config.bullet_rewrite_runtime()["max_memory_pct"]:
        return False, "high_memory_usage"
    return True, "ok"


def _rewrite_worker_count(task_count: int, logger: PipelineLogger) -> int:
    requested = max(1, int(_config.bullet_rewrite_runtime()["parallelism"]))
    if task_count <= 1 or requested <= 1:
        logger.step(
            "bullet_rewrite_parallel_config",
            requested_workers=requested,
            active_workers=1,
            task_count=task_count,
            enabled=False,
            reason="serial_or_single_task",
            memory=_memory_snapshot(),
            ollama=_ollama_runtime_snapshot(),
        )
        return 1
    snapshot = _memory_snapshot()
    ok, reason = _memory_allows_parallel(snapshot)
    active_workers = min(requested, task_count) if ok else 1
    logger.step(
        "bullet_rewrite_parallel_config",
        requested_workers=requested,
        active_workers=active_workers,
        task_count=task_count,
        enabled=active_workers > 1,
        reason=reason,
        memory=snapshot,
        ollama=_ollama_runtime_snapshot(),
    )
    return active_workers


def _rewrite_bullet_job(
    *,
    original_text: str,
    source: dict[str, Any],
    kws_to_add: list[str],
    kws_to_preserve: list[str],
    logger: PipelineLogger,
) -> dict[str, Any]:
    result = rewrite_bullet_targeted(
        original_text,
        kws_to_add,
        keywords_to_preserve=kws_to_preserve,
        logger=logger,
    )
    validation_reasons = _validation_reasons(result)
    skipped_candidates: list[str] = []

    first_skipped = list(result.get("keywords_skipped") or [])
    retry_keywords = list(
        result.get("keywords_used") or result.get("presence_supported_keywords") or []
    )
    retry_is_proper_subset = (
        len(kws_to_add) > 1
        and bool(retry_keywords)
        and {kw.lower() for kw in retry_keywords} < {kw.lower() for kw in kws_to_add}
    )
    if not result["success"] and retry_is_proper_subset:
        retry_result = rewrite_bullet_targeted(
            original_text,
            retry_keywords,
            keywords_to_preserve=kws_to_preserve,
            logger=logger,
        )
        validation_reasons.extend(_validation_reasons(retry_result))
        logger.step(
            "bullet_rewrite_retry_done",
            bullet_id=source["bullet_id"],
            retry_keywords=retry_keywords,
            success=retry_result["success"],
            duration_ms=retry_result.get("duration_ms"),
            error=retry_result.get("error"),
            validation=retry_result.get("validation"),
            keywords_used=retry_result.get("keywords_used"),
            keywords_skipped=retry_result.get("keywords_skipped"),
            rewritten=retry_result["bullet"][:120] if retry_result["success"] else None,
        )
        if retry_result["success"]:
            result = retry_result
            retry_used_l = {kw.lower() for kw in list(retry_result.get("keywords_used") or [])}
            skipped_candidates.extend(
                [kw for kw in first_skipped if kw.lower() not in retry_used_l]
            )
        else:
            result = {
                **retry_result,
                "keywords_used": [],
                "keywords_skipped": _dedupe(
                    first_skipped + list(retry_result.get("keywords_skipped") or [])
                ),
            }

    return {
        "source": source,
        "result": result,
        "validation_reasons": validation_reasons,
        "skipped_candidates": skipped_candidates + list(result.get("keywords_skipped") or []),
    }


def _apply_rewrite_result(doc, job_result: dict[str, Any]) -> bool:
    source = job_result["source"]
    result = job_result["result"]
    if not result["success"]:
        return False
    entry = _find_entry(doc, source["kind"], source["entry_id"])
    if entry is None:
        return False
    for idx, bullet in enumerate(entry.bullets):
        if _text_hash(bullet) == source["text_hash"]:
            entry.bullets[idx] = restore_textbf_from_original(
                source.get("text", bullet), result["bullet"]
            )
            return True
    return False


def _log_rewrite_done(logger: PipelineLogger, job_result: dict[str, Any]) -> None:
    source = job_result["source"]
    result = job_result["result"]
    logger.step(
        "bullet_rewrite_done",
        bullet_id=source["bullet_id"],
        success=result["success"],
        duration_ms=result.get("duration_ms"),
        error=result.get("error"),
        validation=result.get("validation"),
        keywords_used=result.get("keywords_used"),
        keywords_skipped=result.get("keywords_skipped"),
        rewritten=result["bullet"][:120] if result["success"] else None,
    )


def _run_iteration(
    *,
    parsed,
    active_bucket_ids: list[BucketId],
    raw_keywords: list[str],
    present_kws: list[str],
    missing_kws: list[str],
    title: str,
    classification: dict,
    attempt_dir: Path,
    logger: PipelineLogger,
) -> tuple[dict[str, Any] | None, BucketId | None]:
    doc = copy.deepcopy(parsed)
    existing_summary = doc.summary
    _filter_doc_to_active_buckets(doc, active_bucket_ids)
    doc.summary = ""

    active_bullets, active_sources = _collect_active_bullets(doc, active_bucket_ids)
    _annotate_rag_indices(active_sources)
    logger.step(
        "active_buckets",
        count=len(active_bucket_ids),
        buckets=[f"{kind}:{entry_id}" for kind, entry_id in active_bucket_ids],
    )
    rag_candidate_kws = _dedupe(missing_kws)

    kw_match: dict = {
        "bullet_matches": [],
        "summary_keywords": [],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": False,
    }
    rag_tiers: dict[str, str] = {}
    if _config.RAG_ENABLED and rag_candidate_kws and active_bullets:
        t_rag = time.perf_counter()
        logger.step(
            "rag_start",
            missing_keyword_count=len(rag_candidate_kws),
            candidate_keyword_count=len(rag_candidate_kws),
            bullet_count=len(active_bullets),
        )
        try:
            rag_result = match_keywords_to_bullets(rag_candidate_kws, active_bullets)
            rag_tiers = _rag_keyword_tiers(rag_result)
            rag_candidate_lookup = {keyword.lower() for keyword in rag_candidate_kws}
            rewrite_matches = [
                match
                for match in rag_result.get("bullet_matches", [])
                if str(match.get("keyword") or "").strip().lower() in rag_candidate_lookup
            ]
            mid_keywords = _rag_keywords_by_tier(rag_candidate_kws, rag_tiers, "mid")
            low_or_error = [
                str(detail.get("keyword") or "")
                for detail in rag_result.get("scores", [])
                if str(detail.get("tier") or "") in {"low", "error"}
            ]
            low_or_error.extend(
                str(keyword or "") for keyword in rag_result.get("ignored_keywords", [])
            )
            kw_match = {
                "bullet_matches": rewrite_matches,
                "summary_keywords": _dedupe(mid_keywords),
                "ignored_keywords": _dedupe(low_or_error),
                "scores": list(rag_result.get("scores", [])),
                "rag_used": True,
            }
            high_keywords = [
                str(match.get("keyword") or "")
                for match in kw_match.get("bullet_matches", [])
                if str(match.get("keyword") or "").strip()
            ]
            if 0 < len(high_keywords) < MIN_HIGH_RAG_MATCHES_FOR_REWRITE:
                kw_match["summary_keywords"] = _dedupe(
                    list(kw_match.get("summary_keywords", [])) + high_keywords
                )
                kw_match["bullet_matches"] = []
                logger.step(
                    "rag_high_downgraded",
                    high_keyword_count=len(high_keywords),
                    min_required=MIN_HIGH_RAG_MATCHES_FOR_REWRITE,
                    keywords=high_keywords,
                    reason="not_enough_high_matches_for_bullet_rewrite",
                )
            kw_match["summary_keywords"] = _dedupe(list(kw_match.get("summary_keywords", [])))
            kw_match["ignored_keywords"] = _dedupe(list(kw_match.get("ignored_keywords", [])))
        except Exception as exc:
            logger.step("rag_skipped", reason=str(exc))
        logger.step(
            "rag_complete",
            high=len(kw_match.get("bullet_matches", [])),
            mid=len(kw_match.get("summary_keywords", [])),
            low=len(kw_match.get("ignored_keywords", [])),
            rag_used=kw_match.get("rag_used", False),
            high_keywords=[m["keyword"] for m in kw_match.get("bullet_matches", [])],
            mid_keywords=kw_match.get("summary_keywords", []),
            elapsed_ms=int((time.perf_counter() - t_rag) * 1000),
        )
    else:
        logger.step("rag_skipped", reason="disabled or no missing keywords")

    skipped_candidates: list[str] = []
    keywords_used: list[str] = []
    used_keyword_matches: list[dict[str, Any]] = []
    rewritten_refs: set[tuple[str, str, int]] = set()
    validation_reasons: list[str] = []
    rewrite_count = 0
    rewrite_ok = 0
    if kw_match.get("bullet_matches"):
        rewrite_matches: list[dict] = []
        for match in kw_match["bullet_matches"]:
            keyword = match["keyword"]
            if not _keyword_rewrite_eligible(keyword):
                kw_match.setdefault("summary_keywords", []).append(keyword)
                logger.step(
                    "rewrite_keyword_skipped",
                    keyword=keyword,
                    reason="not_rewrite_actionable",
                    bullet_idx=match.get("bullet_idx"),
                )
                continue
            rewrite_matches.append(match)

        by_bullet = _select_rewrite_assignments(
            rewrite_matches,
            max_keywords_per_bullet=2,
            high_threshold=_config.RAG_HIGH_THRESHOLD,
        )
        rewrite_tasks: list[dict[str, Any]] = []
        for bullet_idx, kws_to_add in sorted(by_bullet.items()):
            if bullet_idx >= len(active_bullets):
                continue
            original_text = active_bullets[bullet_idx]
            source = active_sources[bullet_idx]
            kws_to_preserve = [k for k in present_kws if k.lower() in original_text.lower()]
            rewrite_tasks.append(
                {
                    "original_text": original_text,
                    "source": source,
                    "kws_to_add": kws_to_add,
                    "kws_to_preserve": kws_to_preserve,
                }
            )

        active_workers = _rewrite_worker_count(len(rewrite_tasks), logger)

        def handle_job_result(job_result: dict[str, Any]) -> None:
            nonlocal rewrite_count, rewrite_ok
            rewrite_count += 1
            result = job_result["result"]
            validation_reasons.extend(job_result.get("validation_reasons") or [])
            keywords_used.extend(result.get("keywords_used") or [])
            source = job_result["source"]
            for keyword in result.get("keywords_used") or []:
                original_text = str(source.get("text") or "")
                rewritten_text = str(result.get("bullet") or source.get("text") or "")
                originally_visible = keyword_visible_in_text(keyword, original_text)
                rewritten_visible = keyword_visible_in_text(keyword, rewritten_text)
                support_kind = (
                    "rewrite_added"
                    if rewritten_visible and not originally_visible
                    else "already_supported"
                    if originally_visible
                    else "semantic_supported"
                )
                used_keyword_matches.append(
                    {
                        "keyword": keyword,
                        "bullet_idx": source.get("rag_idx"),
                        "bullet_id": source.get("bullet_id"),
                        "bullet_text": rewritten_text,
                        "support_kind": support_kind,
                    }
                )
            skipped_candidates.extend(job_result.get("skipped_candidates") or [])
            _log_rewrite_done(logger, job_result)
            if _apply_rewrite_result(doc, job_result):
                rewritten_refs.add(_source_ref(source))
                rewrite_ok += 1

        def run_serial(tasks: list[dict[str, Any]]) -> None:
            for task in tasks:
                source = task["source"]
                logger.step(
                    "bullet_rewrite_start",
                    bullet_id=source["bullet_id"],
                    keywords=task["kws_to_add"],
                    original=task["original_text"][:120],
                )
                handle_job_result(_rewrite_bullet_job(logger=logger, **task))

        if active_workers <= 1:
            run_serial(rewrite_tasks)
        else:
            remaining_serial: list[dict[str, Any]] = []
            next_task_idx = 0
            active_futures: dict[Future[dict[str, Any]], dict[str, Any]] = {}

            def submit_next(executor: ThreadPoolExecutor) -> bool:
                nonlocal next_task_idx
                if next_task_idx >= len(rewrite_tasks):
                    return False
                task = rewrite_tasks[next_task_idx]
                next_task_idx += 1
                source = task["source"]
                logger.step(
                    "bullet_rewrite_start",
                    bullet_id=source["bullet_id"],
                    keywords=task["kws_to_add"],
                    original=task["original_text"][:120],
                )
                future = executor.submit(_rewrite_bullet_job, logger=logger, **task)
                active_futures[future] = task
                return True

            with ThreadPoolExecutor(max_workers=active_workers) as executor:
                for _ in range(active_workers):
                    if not submit_next(executor):
                        break

                stop_submitting_parallel = False
                while active_futures:
                    done, _pending = wait(active_futures, return_when=FIRST_COMPLETED)
                    for future in done:
                        task = active_futures.pop(future)
                        try:
                            handle_job_result(future.result())
                        except Exception as exc:
                            job_result = {
                                "source": task["source"],
                                "result": {
                                    "success": False,
                                    "bullet": task["original_text"],
                                    "keywords_used": [],
                                    "keywords_skipped": task["kws_to_add"],
                                    "error": str(exc),
                                    "duration_ms": None,
                                },
                                "validation_reasons": [],
                                "skipped_candidates": task["kws_to_add"],
                            }
                            handle_job_result(job_result)
                        snapshot = _memory_snapshot()
                        ok, reason = _memory_allows_parallel(snapshot)
                        logger.step(
                            "bullet_rewrite_parallel_memory",
                            active_workers=len(active_futures),
                            remaining_tasks=len(rewrite_tasks) - next_task_idx,
                            memory=snapshot,
                            ollama=_ollama_runtime_snapshot(),
                            status=reason,
                        )
                        if not ok:
                            stop_submitting_parallel = True
                    if stop_submitting_parallel:
                        remaining_serial = rewrite_tasks[next_task_idx:]
                        next_task_idx = len(rewrite_tasks)
                        continue
                    while len(active_futures) < active_workers and submit_next(executor):
                        pass

            if remaining_serial:
                logger.step(
                    "bullet_rewrite_parallel_fallback",
                    remaining=len(remaining_serial),
                    reason="memory_guard",
                    memory=_memory_snapshot(),
                )
                run_serial(remaining_serial)

    logger.step(
        "bullet_rewrites_summary",
        total=rewrite_count,
        successful=rewrite_ok,
        keywords_used=_dedupe(keywords_used),
        used_keyword_matches=used_keyword_matches,
    )
    _log_ollama_runtime(logger, "after_bullet_rewrites")
    logger.step("rewrite_validation_summary", rejected_keywords=_dedupe(skipped_candidates))

    bullets_for_score, sources_for_score = _collect_active_bullets(doc, active_bucket_ids)
    _annotate_rag_indices(sources_for_score)
    scores = _score_sources(
        bullets_for_score,
        sources_for_score,
        raw_keywords,
        classification,
        kw_match.get("scores", []),
        job_title=title,
        rewritten_refs=rewritten_refs,
    )
    logger.step(
        "bullet_scores",
        scores=scores,
        details=_score_details(
            bullets_for_score,
            sources_for_score,
            raw_keywords,
            classification,
            kw_match.get("scores", []),
            job_title=title,
            rewritten_refs=rewritten_refs,
        ),
    )
    evidence_bullets = _summary_evidence_bullets(bullets_for_score, sources_for_score, scores)
    logger.step("summary_evidence", bullets=evidence_bullets)

    candidate_context = _build_candidate_context(doc, evidence_bullets=evidence_bullets)
    skipped_to_summary = [
        kw
        for kw in _dedupe(skipped_candidates)
        if not _keyword_present(kw, doc)
        and _summary_keyword_supported(kw, candidate_context, validation_reasons)
    ]
    base_summary_keywords = _dedupe(list(kw_match.get("summary_keywords", [])))
    summary_filter_candidates = _dedupe(base_summary_keywords + skipped_to_summary)
    if _summary_filter_needs_llm(summary_filter_candidates):
        summary_filter = filter_summary_keywords_with_ollama(
            keywords=summary_filter_candidates,
            candidate_context=candidate_context,
            job_title=title or _default_target_title(),
            logger=logger,
        )
    else:
        summary_filter = {"success": False, "error": "no_summary_keywords"}
    if summary_filter.get("success"):
        mid_keywords = _dedupe(list(summary_filter.get("included") or []))[:SUMMARY_KEYWORD_LIMIT]
        included_l = {keyword.lower() for keyword in mid_keywords}
        excluded_summary_keywords = [
            keyword
            for keyword in _dedupe(
                list(summary_filter.get("excluded") or []) + summary_filter_candidates
            )
            if keyword.lower() not in included_l
        ]
    else:
        mid_keywords, excluded_summary_keywords = _filter_summary_keywords(
            base_summary_keywords,
            skipped_to_summary,
            candidate_context,
            validation_reasons,
        )
    logger.step("keywords_skipped_to_summary", keywords=skipped_to_summary)
    logger.step(
        "summary_keyword_filter",
        base_keywords=base_summary_keywords,
        included=mid_keywords,
        excluded=excluded_summary_keywords,
        mode="llm"
        if summary_filter.get("success")
        else str(summary_filter.get("error") or "deterministic_fallback"),
    )

    summary_meta: dict = {}
    if candidate_context:
        _log_ollama_runtime(logger, "before_summary")
        logger.step("summary_start", keyword_count=len(mid_keywords), keywords=mid_keywords)
        summary_meta = generate_summary(
            candidate_context,
            title or _default_target_title(),
            mid_keywords,
            existing_summary=existing_summary,
            role_family=str(classification.get("role_family") or ""),
            job_level=str(classification.get("job_level") or ""),
            logger=logger,
        )
        logger.step(
            "summary_done",
            success=summary_meta.get("success"),
            duration_ms=summary_meta.get("duration_ms"),
            error=summary_meta.get("error"),
            summary=summary_meta.get("summary", "")[:200] if summary_meta.get("success") else None,
            keywords_used=summary_meta.get("keywords_used") or [],
            retry_reason=summary_meta.get("retry_reason") or "",
            keyword_use_reason=summary_meta.get("keyword_use_reason") or "",
        )
        if summary_meta.get("summary"):
            summary_validation, _summary_validation_mode = _validate_summary_with_defense(
                summary=summary_meta["summary"],
                candidate_context=candidate_context,
                keywords=mid_keywords,
                logger=logger,
            )
            if not summary_validation["accepted"]:
                feedback, retry_reason_fallback = _summary_validation_retry_feedback(
                    summary_validation
                )
                retry_keywords = [
                    keyword
                    for keyword in mid_keywords
                    if keyword
                    not in _keywords_rejected_by_summary_validation(
                        summary_validation, mid_keywords
                    )
                ]
                logger.step(
                    "summary_validation_retry_start",
                    reasons=summary_validation.get("reasons"),
                    feedback=feedback,
                    keywords=retry_keywords,
                )
                retry_meta = generate_summary(
                    candidate_context,
                    title or _default_target_title(),
                    retry_keywords,
                    existing_summary=existing_summary,
                    line_feedback=feedback,
                    role_family=str(classification.get("role_family") or ""),
                    job_level=str(classification.get("job_level") or ""),
                    logger=logger,
                )
                if retry_reason_fallback and not retry_meta.get("retry_reason"):
                    retry_meta["retry_reason"] = retry_reason_fallback
                retry_validation, retry_validation_mode = _validate_summary_with_defense(
                    summary=retry_meta.get("summary", ""),
                    candidate_context=candidate_context,
                    keywords=retry_keywords,
                    logger=logger,
                )
                logger.step(
                    "summary_validation_retry_done",
                    success=retry_meta.get("success"),
                    duration_ms=retry_meta.get("duration_ms"),
                    error=retry_meta.get("error"),
                    accepted=retry_validation.get("accepted"),
                    reasons=retry_validation.get("reasons"),
                    mode=retry_validation_mode,
                    keywords_used=retry_meta.get("keywords_used") or [],
                    retry_reason=retry_meta.get("retry_reason") or "",
                    keyword_use_reason=retry_meta.get("keyword_use_reason") or "",
                )
                if retry_meta.get("summary") and retry_validation["accepted"]:
                    summary_meta = retry_meta
                    mid_keywords = retry_keywords
                else:
                    summary_meta = {
                        "summary": "",
                        "success": False,
                        "error": "summary_validation_failed",
                    }
    else:
        logger.step("summary_skipped", reason="no candidate context from parsed experience")

    doc_ns = copy.deepcopy(doc)
    doc_ns.summary = ""
    rag_supported_summary_skill_kws = [
        keyword
        for keyword in _dedupe(
            mid_keywords
            + excluded_summary_keywords
            + skipped_to_summary
            + list(kw_match.get("summary_keywords", []))
        )
        if _rag_kept_keyword(keyword, rag_tiers)
    ]
    no_summary_skill_keywords = _dedupe(rag_supported_summary_skill_kws)
    no_summary_skills_added = _add_keywords_to_skills(
        doc_ns,
        no_summary_skill_keywords,
        job_title=title or _default_target_title(),
        logger=logger,
    )
    logger.step(
        "skills_keywords_added",
        version="no_summary",
        keywords=no_summary_skills_added,
    )
    cr_ns, tex_ns, removed = _fit_to_page(
        attempt_dir, doc_ns, "output", sources_for_score, scores, logger
    )
    if removed:
        return None, removed

    pdf_summary: str | None = None
    tex_summary: str | None = None
    summary_error = summary_meta.get("error")
    _generated_summary = summary_meta.get("summary", "")
    if _generated_summary:
        doc_s = copy.deepcopy(doc_ns)
        doc_s.summary = _generated_summary
        summary_unused_keywords = [
            keyword
            for keyword in _dedupe(mid_keywords + excluded_summary_keywords)
            if not keyword_visible_in_text(keyword, _generated_summary)
        ]
        logger.step(
            "skills_keyword_reuse",
            version="with_summary",
            candidate_count=len(summary_unused_keywords),
            reason="summary variant inherits no-summary skill enrichment",
        )
        summary_sources = _filter_sources_present_in_doc(doc_s, sources_for_score)
        summary_bullets = [str(source.get("text") or "") for source in summary_sources]
        summary_scores = _score_sources(
            summary_bullets,
            summary_sources,
            raw_keywords,
            classification,
            kw_match.get("scores", []),
            job_title=title,
            rewritten_refs=rewritten_refs,
        )
        cr_s, tex_s, removed = _fit_to_page(
            attempt_dir,
            doc_s,
            "output_summary",
            summary_sources,
            summary_scores,
            logger,
        )
        if removed:
            return None, removed
        line_status, line_count = _summary_line_count(cr_s.get("pdf_path"))
        logger.step(
            "summary_line_check",
            status=line_status,
            line_count=line_count,
            target_min=4,
            target_max=5,
        )
        if _summary_line_check_accepts(line_status, line_count):
            pdf_summary = cr_s.get("pdf_path")
            tex_summary = tex_s
        elif _summary_line_check_retries(line_status, line_count):
            feedback = f"The current rendered summary is {line_count} lines; revise it to render as 4-5 lines."
            logger.step("summary_retry_start", line_count=line_count, feedback=feedback)
            retry_meta = generate_summary(
                candidate_context,
                title or _default_target_title(),
                mid_keywords,
                existing_summary=existing_summary,
                line_feedback=feedback,
                role_family=str(classification.get("role_family") or ""),
                job_level=str(classification.get("job_level") or ""),
                logger=logger,
            )
            logger.step(
                "summary_retry_done",
                success=retry_meta.get("success"),
                duration_ms=retry_meta.get("duration_ms"),
                error=retry_meta.get("error"),
            )
            if retry_meta.get("summary"):
                retry_validation, _retry_validation_mode = _validate_summary_with_defense(
                    summary=retry_meta["summary"],
                    candidate_context=candidate_context,
                    keywords=mid_keywords,
                    logger=logger,
                    retry="line_count",
                )
                if not retry_validation["accepted"]:
                    summary_error = "summary_validation_failed"
                    logger.step(
                        "summary_generation_error",
                        error=summary_error,
                        reasons=retry_validation.get("reasons"),
                    )
                else:
                    doc_s.summary = retry_meta["summary"]
                    retry_sources = _filter_sources_present_in_doc(doc_s, summary_sources)
                    retry_bullets = [str(source.get("text") or "") for source in retry_sources]
                    retry_scores = _score_sources(
                        retry_bullets,
                        retry_sources,
                        raw_keywords,
                        classification,
                        kw_match.get("scores", []),
                        job_title=title,
                        rewritten_refs=rewritten_refs,
                    )
                    cr_s, tex_s, removed = _fit_to_page(
                        attempt_dir,
                        doc_s,
                        "output_summary",
                        retry_sources,
                        retry_scores,
                        logger,
                    )
                    if removed:
                        return None, removed
                    line_status, line_count = _summary_line_count(cr_s.get("pdf_path"))
                    logger.step(
                        "summary_line_check",
                        status=line_status,
                        line_count=line_count,
                        target_min=4,
                        target_max=5,
                    )
                    if _summary_line_check_accepts(line_status, line_count):
                        pdf_summary = cr_s.get("pdf_path")
                        tex_summary = tex_s
                        summary_meta = retry_meta
                    elif _summary_line_check_retries(line_status, line_count):
                        summary_error = "summary_line_count_out_of_range"
                        logger.step(
                            "summary_generation_error", error=summary_error, line_count=line_count
                        )
                    else:
                        summary_error = f"summary_line_check_{line_status}"
                        logger.step(
                            "summary_generation_error",
                            error=summary_error,
                            line_check_status=line_status,
                        )
            else:
                summary_error = retry_meta.get("error") or "summary_line_count_out_of_range"
                logger.step("summary_generation_error", error=summary_error)
        else:
            summary_error = f"summary_line_check_{line_status}"
            logger.step(
                "summary_generation_error",
                error=summary_error,
                line_check_status=line_status,
            )
    else:
        logger.step("compile_summary_skipped", reason="no summary generated")

    return (
        {
            "pdf_path": cr_ns.get("pdf_path"),
            "tex_path": tex_ns,
            "pdf_path_summary": pdf_summary,
            "tex_path_summary": tex_summary,
            "compile_status": cr_ns.get("compile_status"),
            "fits_one_page": cr_ns.get("fits_one_page"),
            "summary_error": summary_error,
            "kw_match": kw_match,
            "used_keywords": used_keyword_matches,
        },
        None,
    )


def _collect_scores_for_doc(
    doc,
    active_bucket_ids: list[BucketId],
    raw_keywords: list[str],
    classification: dict | None = None,
    rag_scores: list[dict] | None = None,
):
    bullets, sources = _collect_active_bullets(doc, active_bucket_ids)
    _annotate_rag_indices(sources)
    return sources, _score_sources(bullets, sources, raw_keywords, classification, rag_scores)


def _latest_step_detail(logger: PipelineLogger, name: str) -> dict[str, Any]:
    for entry in reversed(getattr(logger, "_entries", [])):
        if entry.kind == "step" and entry.name == name:
            return dict(entry.detail)
    return {}


def _all_step_details(logger: PipelineLogger, name: str) -> list[dict[str, Any]]:
    return [
        dict(entry.detail)
        for entry in getattr(logger, "_entries", [])
        if entry.kind == "step" and entry.name == name
    ]


def _log_pipeline_debug_summary(
    logger: PipelineLogger,
    *,
    raw_keywords: list[str],
    present_kws: list[str],
    missing_kws: list[str],
) -> None:
    rag = _latest_step_detail(logger, "rag_complete")
    summary_filter = _latest_step_detail(logger, "summary_keyword_filter")
    starts = {
        detail.get("bullet_id"): detail
        for detail in _all_step_details(logger, "bullet_rewrite_start")
    }
    rewrites: list[dict[str, Any]] = []
    for detail in _all_step_details(logger, "bullet_rewrite_done"):
        if not detail.get("success"):
            continue
        start = starts.get(detail.get("bullet_id"), {})
        rewrites.append(
            {
                "bullet_id": detail.get("bullet_id"),
                "keywords": detail.get("keywords_used") or [],
                "before": start.get("original"),
                "after": detail.get("rewritten"),
            }
        )
    dropped = [
        {
            "bullet_id": detail.get("bullet_id"),
            "kind": detail.get("kind"),
            "entry_id": detail.get("entry_id"),
            "score": detail.get("score"),
            "stem": detail.get("stem"),
            "reason": detail.get("reason"),
            "text": detail.get("text"),
        }
        for detail in _all_step_details(logger, "bullet_drop")
    ]
    logger.step(
        "pipeline_debug_summary",
        keywords_found=raw_keywords,
        keyword_partition={"present": present_kws, "missing": missing_kws},
        rag_levels={
            "high": rag.get("high_keywords", []),
            "medium": rag.get("mid_keywords", []),
            "low_count": rag.get("low"),
            "rag_used": rag.get("rag_used", False),
        },
        bullet_rewrites=rewrites,
        summary_keywords_used=summary_filter.get("included", []),
        summary_keywords_excluded=summary_filter.get("excluded", []),
        dropped_bullets=dropped,
        rewrite_attempts=_latest_step_detail(logger, "bullet_rewrites_summary"),
        summary_line_checks=_all_step_details(logger, "summary_line_check"),
    )


def _summary_tool_terms(summary: str) -> list[str]:
    terms: list[str] = []
    for token in re.findall(r"\b[A-Za-z][A-Za-z0-9.+#/-]{1,}\b", summary or ""):
        if (
            any(ch in token for ch in ".+#/-")
            or any(ch.isupper() for ch in token[1:])
            or token.isupper()
        ):
            terms.append(token)
    return _dedupe(terms)


def _summary_visible_rejection_overrides(
    *,
    summary: str,
    candidate_context: str,
    reasons: list[str],
) -> list[str]:
    unsupported_markers = (
        "not listed",
        "not present",
        "not in",
        "not supported",
        "unsupported",
        "no evidence",
    )
    visible_terms = [
        term
        for term in _summary_tool_terms(summary)
        if keyword_visible_in_text(term, candidate_context)
    ]
    overrides: list[str] = []
    for reason in reasons:
        reason_l = str(reason).lower()
        if not any(marker in reason_l for marker in unsupported_markers):
            continue
        matching_terms = [
            term
            for term in visible_terms
            if keyword_visible_in_text(term, reason) or term.lower() in reason_l
        ]
        if matching_terms:
            overrides.append(f"visible_evidence_override:{', '.join(matching_terms)}")
    return _dedupe(overrides)


def _summary_validation_needs_llm(
    *,
    summary: str,
    keywords: list[str],
    grounding: dict[str, Any],
) -> bool:
    return bool(summary.strip()) and bool(grounding.get("accepted"))


def _validate_summary_with_defense(
    *,
    summary: str,
    candidate_context: str,
    keywords: list[str],
    logger: PipelineLogger,
    retry: str | None = None,
) -> tuple[dict[str, Any], str]:
    grounding = validate_summary_grounding(summary, candidate_context, keywords)
    if not _summary_validation_needs_llm(summary=summary, keywords=keywords, grounding=grounding):
        summary_validation = {
            "accepted": grounding["accepted"],
            "reasons": _dedupe(list(grounding.get("reasons") or [])),
        }
        detail = {
            "accepted": summary_validation.get("accepted"),
            "reasons": summary_validation.get("reasons"),
            "mode": "deterministic_fast",
        }
        if retry:
            detail["retry"] = retry
        logger.step("summary_validation", **detail)
        return summary_validation, "deterministic_fast"

    summary_validation = validate_summary_with_ollama(
        summary=summary,
        candidate_context=candidate_context,
        keywords=keywords,
        logger=logger,
    )
    mode = "llm"
    if summary_validation.get("success"):
        reasons = list(summary_validation.get("reasons") or [])
        llm_accepted = bool(summary_validation.get("accepted"))
        overrides = _summary_visible_rejection_overrides(
            summary=summary,
            candidate_context=candidate_context,
            reasons=[str(reason) for reason in reasons],
        )
        if overrides and not llm_accepted:
            llm_accepted = True
            mode = "llm_visible_override"
            reasons.extend(overrides)
        if not grounding["accepted"]:
            reasons.extend(grounding["reasons"])
        summary_validation = {
            **summary_validation,
            "accepted": llm_accepted and grounding["accepted"],
            "reasons": _dedupe([str(reason) for reason in reasons]),
        }
    else:
        reasons = list(grounding.get("reasons") or [])
        reasons.append("summary_validation_llm_unavailable")
        summary_validation = {"accepted": False, "reasons": _dedupe(reasons)}
        mode = "llm_unavailable"
    detail = {
        "accepted": summary_validation.get("accepted"),
        "reasons": summary_validation.get("reasons"),
        "mode": mode,
    }
    if retry:
        detail["retry"] = retry
    logger.step("summary_validation", **detail)
    return summary_validation, mode


def run_ad_hoc_pipeline(
    *,
    title: str,
    description: str,
    company: str = "",
    label: str | None = None,
    resume_path: str | Path = DEFAULT_OG_RESUME_PATH,
    progress_callback: Callable[[str, dict[str, Any]], None] | None = None,
) -> dict:
    """Clean Option B pipeline: JD + resume -> keyword inject -> compile 2 versions."""
    title = repair_mojibake(title)
    description = repair_mojibake(description)
    company = repair_mojibake(company)
    logger = PipelineLogger(on_step=progress_callback)
    t_start = time.perf_counter()
    resolved_title = _resolve_job_title(title, description)

    logger.step(
        "config",
        model_backend=_config.resume_llm_provider(),
        ollama_host=_config.ollama_host(),
        ollama_model=_config.ollama_model_name(),
        ollama_timeout_sec=_config.ollama_timeout_sec(),
        rag_enabled=_config.RAG_ENABLED,
        input_title=title or "(empty)",
        title=resolved_title or "(empty)",
        description_len=len(description or ""),
    )
    _log_ollama_runtime(logger, "after_job_fit")

    logger.step("parse_resume", path=str(resume_path))
    if Path(resume_path).suffix.lower() == ".pdf":
        parsed, source_report = parse_resume_upload(resume_path)
    else:
        parsed = parse_resume_file(resume_path)
        source_report = ImportReport("tex", Path(resume_path).name)
    if source_report.import_warnings:
        logger.step(
            "resume_import_warning",
            status=source_report.import_status,
            warnings=source_report.import_warnings,
        )

    all_bullets = [b for entry in parsed.experience for b in entry.bullets] + [
        b for entry in parsed.projects for b in entry.bullets
    ]
    logger.step(
        "bullets_loaded",
        count=len(all_bullets),
        exp_entries=len(parsed.experience),
        project_entries=len(parsed.projects),
    )
    skill_categories = [
        label
        for label, values in (
            parsed.skills.categories
            or {
                "Languages": parsed.skills.languages,
                "Frameworks": parsed.skills.frameworks,
                "Developer Tools": parsed.skills.developer_tools,
            }
        ).items()
        if values
    ]
    missing_optional_sections = []
    if not parsed.experience:
        missing_optional_sections.append("Experience")
    if not parsed.projects:
        missing_optional_sections.append("Projects")
    if not skill_categories:
        missing_optional_sections.append("Technical Skills")
    logger.step(
        "resume_structure",
        summary_present=bool(parsed.summary.strip()),
        experience_entries=len(parsed.experience),
        project_entries=len(parsed.projects),
        skill_categories=skill_categories,
        missing_optional_sections=missing_optional_sections,
    )

    classification = classify_job(title=resolved_title, description=description)
    missing_metadata = _missing_job_metadata_fields(resolved_title, classification)
    job_fit = {"success": False, "skipped": not bool(missing_metadata)}
    if missing_metadata:
        job_fit = analyze_job_fit_with_ollama(
            input_title=title,
            deterministic_title=resolved_title,
            description=description,
            missing_fields=missing_metadata,
            target_lane_policy="",
            unsupported_examples=[],
            logger=logger,
        )
        if job_fit.get("success"):
            if not resolved_title and job_fit.get("title"):
                resolved_title = normalize_title_candidate(str(job_fit["title"])) or str(
                    job_fit["title"]
                )
            classification = _merge_llm_classification(classification, job_fit)
            logger.step(
                "job_metadata_filled_with_llm",
                missing_fields=missing_metadata,
                title=resolved_title,
                role_family=classification.get("role_family"),
                job_level=classification.get("job_level"),
                mismatch=job_fit.get("mismatch"),
                mismatch_reason=job_fit.get("mismatch_reason"),
                unsupported_target_role=job_fit.get("unsupported_target_role"),
                unsupported_target_reason=job_fit.get("unsupported_target_reason"),
                duration_ms=job_fit.get("duration_ms"),
            )
    else:
        logger.step("job_metadata_llm_skipped", reason="title_role_family_job_level_present")
    logger.step(
        "classify_done",
        role_family=classification.get("role_family"),
        job_level=classification.get("job_level"),
        weak_description=classification.get("weak_description"),
    )
    mismatch_reason = (
        str(job_fit.get("mismatch_reason") or "job does not match requested role")
        if job_fit.get("success") and job_fit.get("mismatch")
        else None
    )
    if mismatch_reason:
        logger.step(
            "job_mismatch_ignored_for_option_b",
            reason=mismatch_reason,
            behavior="continue_tailoring_user_provided_jd",
        )

    keywords_dict = extract_keywords(
        title=resolved_title, description=description, classification=classification
    )
    logger.step(
        "heuristic_keywords",
        count=len(keywords_dict.get("must_have_terms", [])),
        keywords=keywords_dict.get("must_have_terms", []),
    )

    logger.step(
        "llm_keyword_extract_start",
        backend=_config.resume_llm_provider(),
        model=_config.ollama_model_name(),
        host=_config.ollama_host(),
    )
    keyword_result = extract_keywords_with_ollama(
        title=resolved_title,
        description=description,
        role_family=str(classification.get("role_family") or ""),
        job_level=str(classification.get("job_level") or ""),
        logger=logger,
    )
    if keyword_result.get("success"):
        jd_usable = job_fit.get("jd_usable") if isinstance(job_fit.get("jd_usable"), bool) else True
        terms = list(keyword_result.get("keywords") or []) if jd_usable else []
        keywords_dict = dict(keywords_dict)
        keywords_dict["must_have_terms"] = terms
        keywords_dict["nice_to_have_terms"] = []
        keywords_dict["tools_and_technologies"] = list(terms)
        keywords_dict["domain_terms"] = []
        classification = dict(classification)
        classification["weak_description"] = not jd_usable
        flags = list(classification.get("concern_flags") or [])
        if jd_usable:
            flags = [flag for flag in flags if flag != "weak_description"]
        elif "weak_description" not in flags:
            flags.append("weak_description")
        classification["concern_flags"] = flags
        reason = str(job_fit.get("jd_usable_reason") or "").strip()
        if reason:
            reasons = list(classification.get("reasons") or [])
            reasons.append(f"jd_usable_model: {reason[:200]}")
            classification["reasons"] = reasons[:24]
        llm_meta = {
            "ollama_enriched": True,
            "source": "keyword_extract",
            "jd_usable": jd_usable,
            "jd_usable_reason": reason,
            "duration_ms": keyword_result.get("duration_ms"),
            "error": keyword_result.get("error"),
            "description_len": len(description or ""),
            "prompt_excerpt_len": keyword_result.get("prompt_excerpt_len"),
        }
    else:
        llm_meta = {
            "ollama_enriched": False,
            "source": "keyword_extract",
            "jd_usable": job_fit.get("jd_usable")
            if isinstance(job_fit.get("jd_usable"), bool)
            else None,
            "jd_usable_reason": str(job_fit.get("jd_usable_reason") or "").strip(),
            "duration_ms": keyword_result.get("duration_ms"),
            "error": keyword_result.get("error"),
            "description_len": len(description or ""),
            "prompt_excerpt_len": keyword_result.get("prompt_excerpt_len"),
        }
    raw_keywords: list[str] = _normalize_extracted_keywords(
        keywords_dict.get("must_have_terms", [])
    )
    keywords_dict["must_have_terms"] = raw_keywords
    if not resolved_title:
        keyword_title = _title_from_keywords(raw_keywords)
        if keyword_title:
            resolved_title = keyword_title
            classification = classify_job(title=resolved_title, description=description)
            logger.step(
                "title_recovered_from_keywords",
                title=resolved_title,
                role_family=classification.get("role_family"),
                job_level=classification.get("job_level"),
            )
    logger.step(
        "keywords_extracted",
        count=len(raw_keywords),
        keywords=raw_keywords,
        ollama_enriched=llm_meta.get("ollama_enriched"),
        source=llm_meta.get("source") or "keyword_extract",
        jd_usable=llm_meta.get("jd_usable"),
        jd_usable_reason=llm_meta.get("jd_usable_reason"),
        duration_ms=llm_meta.get("duration_ms"),
        error=llm_meta.get("error"),
    )

    ad_hoc_label = label or slugify(f"{company}_{resolved_title}") or "ad_hoc"
    attempt_dir = ensure_dir(
        build_attempt_dir(job_id=None, role_family="ad_hoc", ad_hoc_label=ad_hoc_label)
    )
    starting_artifacts = _write_starting_resume_artifacts(attempt_dir, parsed)
    logger.step(
        "starting_resume_compiled",
        status=starting_artifacts.get("starting_compile_status"),
        page_count=starting_artifacts.get("starting_page_count"),
        fits_one_page=starting_artifacts.get("starting_fits_one_page"),
    )

    ollama_failed = (
        _config.resume_llm_provider() == "ollama"
        and not llm_meta.get("ollama_enriched")
        and bool(llm_meta.get("error"))
    )
    if ollama_failed:
        ollama_error_msg = str(llm_meta["error"])
        logger.step(
            "ollama_error",
            error=ollama_error_msg,
            model=_config.ollama_model_name(),
            host=_config.ollama_host(),
        )
        doc_orig = copy.deepcopy(parsed)
        doc_orig.summary = ""
        so_orig: dict = {"experience_entries": [], "project_entries": []}
        logger.step("compile_start", stem="output", note="original resume; LLM unavailable")
        _, cr_orig, tex_orig, _ = _compile_with_fit_retry(
            attempt_dir, doc_orig, so_orig, stem="output"
        )
        logger.step(
            "compile_done",
            stem="output",
            status=cr_orig.get("compile_status"),
            page_count=cr_orig.get("page_count"),
            fits_one_page=cr_orig.get("fits_one_page"),
        )
        total_ms = int((time.perf_counter() - t_start) * 1000)
        logger.step("done", total_ms=total_ms, note="original resume returned; LLM unavailable")
        log_path = write_text(attempt_dir / "pipeline_log.txt", logger.get_log_text())
        payload = {
            "attempt_dir": str(attempt_dir),
            "pdf_path": cr_orig.get("pdf_path"),
            "tex_path": tex_orig,
            "pdf_path_summary": None,
            "tex_path_summary": None,
            "log_path": log_path,
            "compile_status": cr_orig.get("compile_status"),
            "fits_one_page": cr_orig.get("fits_one_page"),
            "role_family": classification.get("role_family"),
            "job_level": classification.get("job_level"),
            "keywords": [],
            "present_keywords": [],
            "missing_keywords": [],
            "llm_error": ollama_error_msg,
            **starting_artifacts,
        }
        return _attach_review_package(
            payload,
            attempt_dir=attempt_dir,
            original_doc=parsed,
            title=resolved_title,
            company=company,
            description=description,
            source_report=source_report,
        )

    keyword_surfaces = _keyword_match_surfaces(parsed, all_bullets)
    present_kws, missing_kws, coverage = partition_keywords(raw_keywords, keyword_surfaces)
    logger.step(
        "keyword_partition",
        present_count=len(present_kws),
        missing_count=len(missing_kws),
        coverage=coverage,
        present=present_kws,
        missing=missing_kws,
    )

    active_bucket_ids: list[BucketId] = []
    for kind, entries in (("exp", parsed.experience), ("proj", parsed.projects)):
        for entry in entries:
            if len(entry.bullets) < 2:
                logger.step(
                    "bucket_excluded_below_floor",
                    kind=kind,
                    entry_id=entry.entry_id,
                    bullet_count=len(entry.bullets),
                )
                continue
            active_bucket_ids.append((kind, entry.entry_id))

    if not active_bucket_ids:
        logger.step("error", error="all_buckets_exhausted")
        log_path = write_text(attempt_dir / "pipeline_log.txt", logger.get_log_text())
        payload = {
            "attempt_dir": str(attempt_dir),
            "pdf_path": None,
            "tex_path": None,
            "pdf_path_summary": None,
            "tex_path_summary": None,
            "log_path": log_path,
            "compile_status": "failed",
            "fits_one_page": False,
            "role_family": classification.get("role_family"),
            "job_level": classification.get("job_level"),
            "keywords": raw_keywords,
            "present_keywords": present_kws,
            "missing_keywords": missing_kws,
            "llm_error": "all_buckets_exhausted",
            **starting_artifacts,
        }
        return _attach_review_package(
            payload,
            attempt_dir=attempt_dir,
            original_doc=parsed,
            title=resolved_title,
            company=company,
            description=description,
            source_report=source_report,
        )

    write_json(
        attempt_dir / "keywords.json",
        {"raw": raw_keywords, "present": present_kws, "missing": missing_kws, "coverage": coverage},
    )

    result: dict[str, Any] | None = None
    max_restarts = max(0, len(active_bucket_ids) - 1)
    for restart_idx in range(max_restarts + 1):
        iteration_result, removed = _run_iteration(
            parsed=parsed,
            active_bucket_ids=active_bucket_ids,
            raw_keywords=raw_keywords,
            present_kws=present_kws,
            missing_kws=missing_kws,
            title=resolved_title,
            classification=classification,
            attempt_dir=attempt_dir,
            logger=logger,
        )
        if removed is None:
            result = iteration_result
            break
        active_bucket_ids = [bucket for bucket in active_bucket_ids if bucket != removed]
        logger.step(
            "restart",
            restart_num=restart_idx + 1,
            removed_bucket=f"{removed[0]}:{removed[1]}",
            remaining_buckets=[f"{kind}:{entry_id}" for kind, entry_id in active_bucket_ids],
        )
        if not active_bucket_ids:
            result = None
            break

    _log_pipeline_debug_summary(
        logger,
        raw_keywords=raw_keywords,
        present_kws=present_kws,
        missing_kws=missing_kws,
    )
    total_ms = int((time.perf_counter() - t_start) * 1000)
    logger.step("done", total_ms=total_ms)
    log_path = write_text(attempt_dir / "pipeline_log.txt", logger.get_log_text())

    if result is None:
        payload = {
            "attempt_dir": str(attempt_dir),
            "pdf_path": None,
            "tex_path": None,
            "pdf_path_summary": None,
            "tex_path_summary": None,
            "log_path": log_path,
            "compile_status": "failed",
            "fits_one_page": False,
            "role_family": classification.get("role_family"),
            "job_level": classification.get("job_level"),
            "keywords": raw_keywords,
            "present_keywords": present_kws,
            "missing_keywords": missing_kws,
            "llm_error": "all_buckets_exhausted",
            **starting_artifacts,
        }
        return _attach_review_package(
            payload,
            attempt_dir=attempt_dir,
            original_doc=parsed,
            title=resolved_title,
            company=company,
            description=description,
            source_report=source_report,
        )

    payload = {
        "attempt_dir": str(attempt_dir),
        "pdf_path": result.get("pdf_path"),
        "tex_path": result.get("tex_path"),
        "pdf_path_summary": result.get("pdf_path_summary"),
        "tex_path_summary": result.get("tex_path_summary"),
        "log_path": log_path,
        "compile_status": result.get("compile_status"),
        "fits_one_page": result.get("fits_one_page"),
        "role_family": classification.get("role_family"),
        "job_level": classification.get("job_level"),
        "keywords": raw_keywords,
        "present_keywords": present_kws,
        "missing_keywords": missing_kws,
        "present_coverage": coverage,
        "rag_scores": list((result.get("kw_match") or {}).get("scores") or []),
        "used_keywords": list(result.get("used_keywords") or []),
        "llm_error": result.get("summary_error"),
        **starting_artifacts,
    }
    return _attach_review_package(
        payload,
        attempt_dir=attempt_dir,
        original_doc=parsed,
        title=resolved_title,
        company=company,
        description=description,
        source_report=source_report,
    )
