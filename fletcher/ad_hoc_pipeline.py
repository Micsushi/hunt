from __future__ import annotations

import copy
import time
from pathlib import Path

from . import config as _config
from .config import DEFAULT_OG_RESUME_PATH
from .jobs.classifier import classify_job, slugify
from .jobs.keyword_extractor import extract_keywords
from .keyword_check import partition_keywords
from .llm.llm_enrich import enrich_with_ollama_if_enabled, generate_summary, rewrite_bullet_targeted
from .llm.rag import match_keywords_to_bullets
from .pipeline import _compile_with_fit_retry
from .pipeline_logger import PipelineLogger
from .resume.parser import parse_resume_file
from .storage import build_attempt_dir, ensure_dir, write_json, write_text


def run_ad_hoc_pipeline(
    *,
    title: str,
    description: str,
    company: str = "",
    label: str | None = None,
    resume_path: str | Path = DEFAULT_OG_RESUME_PATH,
) -> dict:
    """Clean Option B pipeline: JD + resume -> keyword inject -> compile 2 versions.

    No candidate_profile or bullet_library. All original bullets kept as-is.
    Returns pdf_path, pdf_path_summary, log_path and keyword metadata.
    """
    logger = PipelineLogger()
    t_start = time.perf_counter()

    # 0. Log runtime config so logs are self-contained
    logger.step(
        "config",
        model_backend=_config.DEFAULT_MODEL_BACKEND,
        ollama_host=_config.OLLAMA_HOST,
        ollama_model=_config.OLLAMA_MODEL_NAME,
        ollama_timeout_sec=_config.OLLAMA_TIMEOUT_SEC,
        rag_enabled=_config.RAG_ENABLED,
        title=title or "(empty)",
        description_len=len(description or ""),
    )

    # 1. Parse resume — keep ALL bullets
    logger.step("parse_resume", path=str(resume_path))
    parsed = parse_resume_file(resume_path)

    all_bullets: list[str] = []
    bullet_sources: list[dict] = []
    for ei, entry in enumerate(parsed.experience):
        for bi, bullet in enumerate(entry.bullets):
            all_bullets.append(bullet)
            bullet_sources.append({"kind": "exp", "entry_idx": ei, "bullet_idx": bi})
    for pi, entry in enumerate(parsed.projects):
        for bi, bullet in enumerate(entry.bullets):
            all_bullets.append(bullet)
            bullet_sources.append({"kind": "proj", "entry_idx": pi, "bullet_idx": bi})

    logger.step(
        "bullets_loaded",
        count=len(all_bullets),
        exp_entries=len(parsed.experience),
        project_entries=len(parsed.projects),
    )

    # 2. LLM: JD -> keywords
    classification = classify_job(title=title, description=description)
    logger.step(
        "classify_done",
        role_family=classification.get("role_family"),
        job_level=classification.get("job_level"),
        weak_description=classification.get("weak_description"),
    )

    keywords_dict = extract_keywords(
        title=title, description=description, classification=classification
    )
    logger.step(
        "heuristic_keywords",
        count=len(keywords_dict.get("must_have_terms", [])),
        keywords=keywords_dict.get("must_have_terms", []),
    )

    logger.step(
        "llm_keyword_extract_start",
        backend=_config.DEFAULT_MODEL_BACKEND,
        model=_config.OLLAMA_MODEL_NAME,
        host=_config.OLLAMA_HOST,
    )
    classification, keywords_dict, llm_meta = enrich_with_ollama_if_enabled(
        title=title,
        description=description,
        classification=classification,
        keywords=keywords_dict,
        logger=logger,
    )
    raw_keywords: list[str] = keywords_dict.get("must_have_terms", [])
    logger.step(
        "keywords_extracted",
        count=len(raw_keywords),
        keywords=raw_keywords,
        ollama_enriched=llm_meta.get("ollama_enriched"),
        jd_usable=llm_meta.get("jd_usable"),
        jd_usable_reason=llm_meta.get("jd_usable_reason"),
        duration_ms=llm_meta.get("duration_ms"),
        error=llm_meta.get("error"),
    )

    # If Ollama was expected but unreachable/errored, return original resume unchanged.
    ollama_failed = (
        _config.DEFAULT_MODEL_BACKEND == "ollama"
        and not llm_meta.get("ollama_enriched")
        and bool(llm_meta.get("error"))
    )
    if ollama_failed:
        ollama_error_msg = str(llm_meta["error"])
        logger.step(
            "ollama_error",
            error=ollama_error_msg,
            model=_config.OLLAMA_MODEL_NAME,
            host=_config.OLLAMA_HOST,
        )
        ad_hoc_label = label or slugify(f"{company}_{title}") or "ad_hoc"
        attempt_dir = ensure_dir(
            build_attempt_dir(job_id=None, role_family="ad_hoc", ad_hoc_label=ad_hoc_label)
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
        return {
            "attempt_dir": str(attempt_dir),
            "pdf_path": cr_orig.get("pdf_path"),
            "tex_path": tex_orig,
            "pdf_path_summary": None,
            "tex_path_summary": None,
            "log_path": log_path,
            "compile_status": cr_orig.get("compile_status"),
            "fits_one_page": cr_orig.get("fits_one_page"),
            "keywords": [],
            "present_keywords": [],
            "missing_keywords": [],
            "llm_error": ollama_error_msg,
        }

    # 3. Partition: present vs missing
    present_kws, missing_kws, coverage = partition_keywords(raw_keywords, all_bullets)
    logger.step(
        "keyword_partition",
        present_count=len(present_kws),
        missing_count=len(missing_kws),
        coverage_pct=round(coverage * 100, 1) if coverage is not None else None,
        present=present_kws,
        missing=missing_kws,
    )

    # 4. RAG: match only MISSING keywords to bullets
    kw_match: dict = {
        "bullet_matches": [],
        "summary_keywords": list(missing_kws),
        "ignored_keywords": [],
        "scores": [],
        "rag_used": False,
    }
    if _config.RAG_ENABLED and missing_kws and all_bullets:
        logger.step(
            "rag_start", missing_keyword_count=len(missing_kws), bullet_count=len(all_bullets)
        )
        try:
            kw_match = match_keywords_to_bullets(missing_kws, all_bullets)
            kw_match["rag_used"] = True
        except Exception as exc:
            logger.step("rag_skipped", reason=str(exc))

    high_matches = kw_match.get("bullet_matches", [])
    logger.step(
        "rag_complete",
        high=len(high_matches),
        mid=len(kw_match["summary_keywords"]),
        low=len(kw_match.get("ignored_keywords", [])),
        rag_used=kw_match.get("rag_used", False),
        high_keywords=[m["keyword"] for m in high_matches],
        mid_keywords=kw_match.get("summary_keywords", []),
    )

    # 5. LLM bullet rewrites for high-tier matches
    doc = copy.deepcopy(parsed)
    doc.summary = ""

    rewrite_count = 0
    rewrite_ok = 0
    if kw_match["bullet_matches"]:
        from collections import defaultdict

        by_bullet: dict[int, list[str]] = defaultdict(list)
        for m in kw_match["bullet_matches"]:
            by_bullet[m["bullet_idx"]].append(m["keyword"])

        for bullet_idx, kws_to_add in sorted(by_bullet.items()):
            original_text = all_bullets[bullet_idx]
            kws_to_preserve = [k for k in present_kws if k.lower() in original_text.lower()]
            logger.step(
                "bullet_rewrite_start",
                bullet_idx=bullet_idx,
                keywords=kws_to_add,
                original=original_text[:120],
            )
            result = rewrite_bullet_targeted(
                original_text,
                kws_to_add,
                keywords_to_preserve=kws_to_preserve,
                logger=logger,
            )
            rewrite_count += 1
            logger.step(
                "bullet_rewrite_done",
                bullet_idx=bullet_idx,
                success=result["success"],
                duration_ms=result.get("duration_ms"),
                error=result.get("error"),
                rewritten=result["bullet"][:120] if result["success"] else None,
            )
            if result["success"]:
                rewrite_ok += 1
                src = bullet_sources[bullet_idx]
                if src["kind"] == "exp":
                    doc.experience[src["entry_idx"]].bullets[src["bullet_idx"]] = result["bullet"]
                else:
                    doc.projects[src["entry_idx"]].bullets[src["bullet_idx"]] = result["bullet"]

    if rewrite_count:
        logger.step("bullet_rewrites_summary", total=rewrite_count, successful=rewrite_ok)

    # 6. LLM summary from mid-tier keywords
    exp_lines = [e.title_company_location for e in doc.experience[:3]]
    candidate_context = "; ".join(exp_lines)
    summary_meta: dict = {}
    if candidate_context:
        logger.step(
            "summary_start",
            keyword_count=len(kw_match["summary_keywords"]),
            keywords=kw_match["summary_keywords"],
        )
        summary_meta = generate_summary(
            candidate_context,
            title or "Software Engineer",
            kw_match["summary_keywords"],
            logger=logger,
        )
        logger.step(
            "summary_done",
            success=summary_meta.get("success"),
            duration_ms=summary_meta.get("duration_ms"),
            error=summary_meta.get("error"),
            summary=summary_meta.get("summary", "")[:200] if summary_meta.get("success") else None,
        )
    else:
        logger.step("summary_skipped", reason="no candidate context from parsed experience")

    # 7. Build attempt dir
    ad_hoc_label = label or slugify(f"{company}_{title}") or "ad_hoc"
    attempt_dir = ensure_dir(
        build_attempt_dir(job_id=None, role_family="ad_hoc", ad_hoc_label=ad_hoc_label)
    )

    write_json(
        attempt_dir / "keywords.json",
        {
            "raw": raw_keywords,
            "present": present_kws,
            "missing": missing_kws,
            "coverage": coverage,
            "kw_match": kw_match,
        },
    )

    # 8. Compile no-summary version
    logger.step("compile_start", stem="output")
    doc_ns = copy.deepcopy(doc)
    so_ns: dict = {"experience_entries": [], "project_entries": []}
    _, cr_ns, tex_ns, _ = _compile_with_fit_retry(attempt_dir, doc_ns, so_ns, stem="output")
    logger.step(
        "compile_done",
        stem="output",
        status=cr_ns.get("compile_status"),
        page_count=cr_ns.get("page_count"),
        fits_one_page=cr_ns.get("fits_one_page"),
    )

    # 9. Compile with-summary version (if summary generated)
    pdf_summary: str | None = None
    tex_summary: str | None = None
    _generated_summary = summary_meta.get("summary", "")
    if _generated_summary:
        logger.step("compile_start", stem="output_summary")
        doc_s = copy.deepcopy(doc)
        doc_s.summary = _generated_summary
        so_s: dict = {"experience_entries": [], "project_entries": []}
        _, cr_s, tex_s, _ = _compile_with_fit_retry(attempt_dir, doc_s, so_s, stem="output_summary")
        logger.step(
            "compile_done",
            stem="output_summary",
            status=cr_s.get("compile_status"),
            page_count=cr_s.get("page_count"),
            fits_one_page=cr_s.get("fits_one_page"),
        )
        pdf_summary = cr_s.get("pdf_path")
        tex_summary = tex_s
    else:
        logger.step("compile_summary_skipped", reason="no summary generated")

    # 10. Write log
    total_ms = int((time.perf_counter() - t_start) * 1000)
    logger.step("done", total_ms=total_ms)
    log_text = logger.get_log_text()
    log_path = write_text(attempt_dir / "pipeline_log.txt", log_text)

    return {
        "attempt_dir": str(attempt_dir),
        "pdf_path": cr_ns.get("pdf_path"),
        "tex_path": tex_ns,
        "pdf_path_summary": pdf_summary,
        "tex_path_summary": tex_summary,
        "log_path": log_path,
        "compile_status": cr_ns.get("compile_status"),
        "fits_one_page": cr_ns.get("fits_one_page"),
        "keywords": raw_keywords,
        "present_keywords": present_kws,
        "missing_keywords": missing_kws,
        "llm_error": None,
    }
