from __future__ import annotations

import time
from pathlib import Path

from . import config as _config
from .jobs.classifier import classify_job, slugify
from .resume.compiler import compile_tex
from .config import (
    DEFAULT_BULLET_LIBRARY_PATH,
    DEFAULT_CANDIDATE_PROFILE_PATH,
    DEFAULT_MODEL_BACKEND,
    DEFAULT_MODEL_NAME,
    DEFAULT_OG_RESUME_PATH,
    OLLAMA_MODEL_NAME,
    PROMPT_VERSION_TAG,
    resolve_base_resume_path,
)
from .db import (
    get_apply_context,
    get_job_context,
    init_resume_db,
    job_description_fingerprint,
    list_jobs_ready_for_resume,
    record_resume_attempt,
)
from .resume.generator import generate_tailored_resume
from .llm.llm_enrich import (
    enrich_with_ollama_if_enabled,
    generate_summary,
    rewrite_bullet_targeted,
)
from .jobs.keyword_extractor import extract_keywords
from .resume.parser import parse_resume_file
from .llm.rag import match_keywords_to_bullets
from .resume.renderer import render_resume_tex
from .resume.source_loader import load_bullet_library, load_candidate_profile
from .storage import build_attempt_dir, ensure_dir, file_hash, write_json, write_text


def _trim_resume_for_page_fit(doc, structured_output: dict) -> bool:
    if doc.projects:
        last_project = doc.projects[-1]
        if last_project.bullets:
            last_project.bullets.pop()
            for entry in reversed(structured_output.get("project_entries", [])):
                if entry.get("entry_id") == last_project.entry_id and entry.get("bullet_plan"):
                    entry["bullet_plan"].pop()
                    break
            if not last_project.bullets:
                doc.projects.pop()
                structured_output["project_entries"] = [
                    entry
                    for entry in structured_output.get("project_entries", [])
                    if entry.get("entry_id") != last_project.entry_id
                ]
            return True

    for entry in reversed(doc.experience):
        if len(entry.bullets) > 1:
            entry.bullets.pop()
            for structured_entry in reversed(structured_output.get("experience_entries", [])):
                if structured_entry.get("entry_id") == entry.entry_id and structured_entry.get(
                    "bullet_plan"
                ):
                    structured_entry["bullet_plan"].pop()
                    break
            return True

    if len(doc.experience) > 1:
        removed_entry = doc.experience.pop()
        structured_output["experience_entries"] = [
            entry
            for entry in structured_output.get("experience_entries", [])
            if entry.get("entry_id") != removed_entry.entry_id
        ]
        return True

    return False


def _compile_with_fit_retry(
    attempt_dir: Path, tailored_doc, structured_output: dict
) -> tuple[str, dict, str, list[dict]]:
    compile_history: list[dict] = []
    while True:
        structured_output_path = write_json(attempt_dir / "tailored_resume.json", structured_output)
        tex_path = write_text(attempt_dir / "output.tex", render_resume_tex(tailored_doc))
        compile_result = compile_tex(tex_path)
        compile_history.append(
            {
                "compile_status": compile_result["compile_status"],
                "page_count": compile_result["page_count"],
                "fits_one_page": compile_result["fits_one_page"],
            }
        )
        if compile_result["fits_one_page"]:
            return structured_output_path, compile_result, tex_path, compile_history
        if compile_result["compile_status"] != "ok":
            return structured_output_path, compile_result, tex_path, compile_history
        if compile_result["page_count"] is None or compile_result["page_count"] <= 1:
            return structured_output_path, compile_result, tex_path, compile_history
        if not _trim_resume_for_page_fit(tailored_doc, structured_output):
            return structured_output_path, compile_result, tex_path, compile_history


def generate_resume_for_job(
    job_id: int,
    *,
    db_path: str | Path | None = None,
    resume_path: str | Path = DEFAULT_OG_RESUME_PATH,
    candidate_profile_path: str | Path = DEFAULT_CANDIDATE_PROFILE_PATH,
    bullet_library_path: str | Path = DEFAULT_BULLET_LIBRARY_PATH,
) -> dict:
    init_resume_db(db_path)
    job = get_job_context(job_id, db_path)
    if not job:
        raise ValueError(f"Job {job_id} not found.")

    return _run_pipeline(
        title=job.get("title") or "",
        description=job.get("description") or "",
        company=job.get("company") or "",
        source_mode="queue",
        job_id=job_id,
        db_path=db_path,
        allow_downstream_selection=_job_is_ready_for_c3(job),
        resume_path=resume_path,
        candidate_profile_path=candidate_profile_path,
        bullet_library_path=bullet_library_path,
    )


def generate_resume_for_ad_hoc(
    *,
    title: str,
    description: str,
    company: str = "",
    label: str | None = None,
    resume_path: str | Path = DEFAULT_OG_RESUME_PATH,
    candidate_profile_path: str | Path = DEFAULT_CANDIDATE_PROFILE_PATH,
    bullet_library_path: str | Path = DEFAULT_BULLET_LIBRARY_PATH,
) -> dict:
    return _run_pipeline(
        title=title,
        description=description,
        company=company,
        source_mode="ad_hoc",
        ad_hoc_label=label or slugify(f"{company}_{title}"),
        resume_path=resume_path,
        candidate_profile_path=candidate_profile_path,
        bullet_library_path=bullet_library_path,
    )


def generate_resumes_for_ready_jobs(
    *,
    db_path: str | Path | None = None,
    limit: int = 25,
    only_missing: bool = False,
    resume_path: str | Path = DEFAULT_OG_RESUME_PATH,
    candidate_profile_path: str | Path = DEFAULT_CANDIDATE_PROFILE_PATH,
    bullet_library_path: str | Path = DEFAULT_BULLET_LIBRARY_PATH,
) -> list[dict]:
    init_resume_db(db_path)
    rows = list_jobs_ready_for_resume(db_path=db_path, limit=limit, only_missing=only_missing)
    results: list[dict] = []
    for row in rows:
        results.append(
            generate_resume_for_job(
                int(row["id"]),
                db_path=db_path,
                resume_path=resume_path,
                candidate_profile_path=candidate_profile_path,
                bullet_library_path=bullet_library_path,
            )
        )
    return results


def _print_trace(trace: dict) -> None:
    """Print a clean human-readable summary of the full pipeline trace."""
    W = 70
    div = "=" * W
    thin = "-" * W

    def section(title: str) -> None:
        print(f"\n{div}")
        print(f"  {title}")
        print(div)

    def row(label: str, value: str) -> None:
        print(f"  {label:<28} {value}")

    print(f"\n{'=' * W}")
    print(f"  PIPELINE TRACE  |  job={trace.get('job_id')}  |  {trace.get('title')} @ {trace.get('company')}")
    print(f"  model: {trace.get('model')}  |  total: {trace.get('total_ms')}ms")
    print(f"{'=' * W}")

    # Step 1: keyword extraction
    step1 = trace.get("step1_keywords", {})
    section("STEP 1: JD -> LLM (keyword extraction)")
    row("job title sent:", step1.get("title_sent", ""))
    jd_preview = (step1.get("description_sent") or "")[:120].replace("\n", " ")
    row("jd preview:", jd_preview + "...")
    row("jd_usable:", str(step1.get("jd_usable")) + "  " + step1.get("jd_usable_reason", ""))
    row("duration:", f"{step1.get('duration_ms')}ms")
    kws = step1.get("keywords_returned", [])
    print(f"\n  keywords returned ({len(kws)}):")
    for i, kw in enumerate(kws, 1):
        print(f"    {i:>2}. {kw}")

    # Step 2: RAG matching
    step2 = trace.get("step2_rag", {})
    section("STEP 2: keywords -> RAG (bullet matching)")
    row("bullets in resume:", str(step2.get("bullet_count", 0)))
    row("thresholds:", f"high >= {step2.get('high_threshold')}  mid >= {step2.get('mid_threshold')}")
    scores = step2.get("scores", [])
    if scores:
        print(f"\n  {'keyword':<35} {'score':>6}  {'tier':<7}  nearest bullet")
        print(f"  {thin}")
        for s in scores:
            preview = (s.get("bullet_preview") or "")[:35]
            tier = s.get("tier", "")
            marker = "<<" if tier == "high" else ("~" if tier == "mid" else "")
            print(f"  {s['keyword']:<35} {s['score']:>6.3f}  {tier:<7}  {preview}  {marker}")
    print(f"\n  high -> rewrite bullet : {[m['keyword'] for m in step2.get('bullet_matches', [])]}")
    print(f"  mid  -> summary        : {step2.get('summary_keywords', [])}")
    print(f"  low  -> ignored        : {step2.get('ignored_keywords', [])}")

    # Step 3: bullet rewrites
    step3 = trace.get("step3_bullet_rewrites", [])
    section(f"STEP 3: high-score bullets -> LLM rewrite ({len(step3)} bullets)")
    if not step3:
        print("  (no high-score matches — no bullet rewrites)")
    for r in step3:
        status = "ok" if r.get("success") else "FAILED"
        print(f"\n  bullet[{r['bullet_idx']}]  keywords={r['keywords']}  [{status}]  {r.get('duration_ms')}ms")
        print(f"  {thin}")
        print(f"  BEFORE: {r.get('original', '')[:W-10]}")
        print(f"  AFTER : {r.get('rewritten', '')[:W-10]}")

    # Step 4: summary
    step4 = trace.get("step4_summary", {})
    section("STEP 4: candidate context + mid keywords -> LLM (summary)")
    row("keywords used:", str(step4.get("keywords_used", [])))
    row("context sent:", (step4.get("context_sent") or "")[:60] + "...")
    row("duration:", f"{step4.get('duration_ms')}ms")
    row("success:", str(step4.get("success")))
    summary_text = step4.get("summary", "")
    if summary_text:
        print(f"\n  summary:\n    {summary_text}")

    # Result
    section("RESULT")
    row("status:", trace.get("status", ""))
    row("compile:", trace.get("compile_status", ""))
    row("fits 1 page:", str(trace.get("fits_one_page")))
    row("pdf:", trace.get("pdf_path") or "(none)")
    print(f"{div}\n")


def _run_pipeline(
    *,
    title: str,
    description: str,
    company: str,
    source_mode: str,
    job_id: int | None = None,
    db_path: str | Path | None = None,
    ad_hoc_label: str | None = None,
    allow_downstream_selection: bool = False,
    resume_path: str | Path,
    candidate_profile_path: str | Path,
    bullet_library_path: str | Path,
) -> dict:
    _t_pipeline_start = time.perf_counter()
    classification = classify_job(title=title, description=description)
    keywords = extract_keywords(title=title, description=description, classification=classification)
    classification, keywords, llm_meta = enrich_with_ollama_if_enabled(
        title=title, description=description, classification=classification, keywords=keywords
    )
    desc_fingerprint = job_description_fingerprint(description)
    llm_meta["job_description_hash"] = desc_fingerprint
    model_name = OLLAMA_MODEL_NAME if DEFAULT_MODEL_BACKEND == "ollama" else DEFAULT_MODEL_NAME
    if llm_meta.get("ollama_enriched"):
        prompt_version = f"{PROMPT_VERSION_TAG}_ollama"
    elif DEFAULT_MODEL_BACKEND == "ollama":
        prompt_version = f"{PROMPT_VERSION_TAG}_ollama_fallback"
    else:
        prompt_version = f"{PROMPT_VERSION_TAG}_heuristic"
    candidate_profile = load_candidate_profile(candidate_profile_path)
    bullet_library = load_bullet_library(bullet_library_path)
    base_resume_name, selected_resume_path = resolve_base_resume_path(classification["role_family"])
    if Path(resume_path) != Path(DEFAULT_OG_RESUME_PATH):
        base_resume_name = "custom"
        selected_resume_path = Path(resume_path)
    parsed_resume = parse_resume_file(selected_resume_path)

    tailored_doc, structured_output = generate_tailored_resume(
        parsed_resume,
        classification=classification,
        keywords=keywords,
        candidate_profile=candidate_profile,
        bullet_library=bullet_library,
        selected_base_resume=base_resume_name,
    )

    # --- LLM rewrite passes ---
    all_selected_bullets: list[str] = [
        b for entry in tailored_doc.experience for b in entry.bullets
    ] + [b for entry in tailored_doc.projects for b in entry.bullets]

    raw_kws = keywords.get("must_have_terms", [])

    # Build pipeline trace (written to attempt_dir at the end).
    trace: dict = {
        "job_id": job_id,
        "title": title,
        "company": company,
        "model": OLLAMA_MODEL_NAME if DEFAULT_MODEL_BACKEND == "ollama" else DEFAULT_MODEL_NAME,
        "step1_keywords": {
            "title_sent": title,
            "description_sent": (description or "")[:500],
            "jd_usable": llm_meta.get("jd_usable"),
            "jd_usable_reason": llm_meta.get("jd_usable_reason", ""),
            "keywords_returned": raw_kws,
            "duration_ms": llm_meta.get("duration_ms"),
        },
        "step2_rag": {},
        "step3_bullet_rewrites": [],
        "step4_summary": {},
        "status": None,
        "compile_status": None,
        "fits_one_page": None,
        "pdf_path": None,
        "total_ms": None,
    }

    # Step 2: RAG keyword-to-bullet matching (in-memory cosine sim against selected bullets).
    kw_match: dict = {
        "bullet_matches": [], "summary_keywords": [],
        "ignored_keywords": list(raw_kws), "scores": [], "rag_used": False,
    }
    if _config.RAG_ENABLED and raw_kws and all_selected_bullets:
        try:
            kw_match = match_keywords_to_bullets(raw_kws, all_selected_bullets)
        except Exception:
            pass

    trace["step2_rag"] = {
        "bullet_count": len(all_selected_bullets),
        "bullets": all_selected_bullets,
        "high_threshold": _config.RAG_HIGH_THRESHOLD,
        "mid_threshold": _config.RAG_MID_THRESHOLD,
        "scores": kw_match.get("scores", []),
        "bullet_matches": kw_match.get("bullet_matches", []),
        "summary_keywords": kw_match.get("summary_keywords", []),
        "ignored_keywords": kw_match.get("ignored_keywords", []),
        "rag_used": kw_match.get("rag_used", False),
    }

    # Step 3: Targeted bullet rewrites — one LLM call per bullet that has high-score keywords.
    bullet_rewrites: list[dict] = []
    if kw_match["bullet_matches"]:
        from collections import defaultdict
        by_bullet: dict[int, list[str]] = defaultdict(list)
        for m in kw_match["bullet_matches"]:
            by_bullet[m["bullet_idx"]].append(m["keyword"])

        for bullet_idx, kws in sorted(by_bullet.items()):
            original = all_selected_bullets[bullet_idx]
            result = rewrite_bullet_targeted(original, kws)
            bullet_rewrites.append({
                "bullet_idx": bullet_idx,
                "original": original,
                "rewritten": result["bullet"],
                "keywords": kws,
                "success": result["success"],
                "duration_ms": result["duration_ms"],
                "error": result["error"],
            })
            if result["success"]:
                idx = 0
                found = False
                for entry in tailored_doc.experience:
                    for j in range(len(entry.bullets)):
                        if idx == bullet_idx:
                            entry.bullets[j] = result["bullet"]
                            found = True
                            break
                        idx += 1
                    if found:
                        break
                if not found:
                    for entry in tailored_doc.projects:
                        for j in range(len(entry.bullets)):
                            if idx == bullet_idx:
                                entry.bullets[j] = result["bullet"]
                                found = True
                                break
                            idx += 1
                        if found:
                            break

    trace["step3_bullet_rewrites"] = bullet_rewrites

    # Sync rewritten bullet texts back into structured_output so tailored_resume.json
    # and the review UI match the PDF/TeX (structured_output is written by _compile_with_fit_retry).
    for s_entry, t_entry in zip(
        structured_output.get("experience_entries") or [], tailored_doc.experience
    ):
        plan = s_entry.get("bullet_plan") or []
        for k, t_bullet in enumerate(t_entry.bullets):
            if k < len(plan):
                plan[k]["text"] = t_bullet
    for s_entry, t_entry in zip(
        structured_output.get("project_entries") or [], tailored_doc.projects
    ):
        plan = s_entry.get("bullet_plan") or []
        for k, t_bullet in enumerate(t_entry.bullets):
            if k < len(plan):
                plan[k]["text"] = t_bullet

    # Step 4: Generate summary from candidate context + mid-tier keywords.
    exp_lines = [
        f"{e.get('title', '')} at {e.get('company', '')}"
        for e in (candidate_profile.get("experience_entries") or [])[:3]
        if e.get("title") and e.get("company")
    ]
    skill_names = [
        s.get("name", "")
        for bucket in ("languages", "frameworks", "developer_tools")
        for s in (candidate_profile.get("skills", {}).get(bucket) or [])
        if s.get("name")
    ][:8]
    candidate_context = ""
    if exp_lines:
        candidate_context += "Experience: " + "; ".join(exp_lines) + ". "
    if skill_names:
        candidate_context += "Skills: " + ", ".join(skill_names) + "."

    summary_rewrite_meta: dict = {}
    if candidate_context:
        summary_result = generate_summary(
            candidate_context,
            title,
            kw_match["summary_keywords"],
        )
        summary_rewrite_meta = summary_result

    trace["step4_summary"] = {
        "context_sent": candidate_context,
        "keywords_used": kw_match.get("summary_keywords", []),
        "summary": summary_rewrite_meta.get("summary", ""),
        "success": summary_rewrite_meta.get("success", False),
        "duration_ms": summary_rewrite_meta.get("duration_ms"),
        "error": summary_rewrite_meta.get("error"),
    }
    # --- end LLM rewrite passes ---

    fallback_used = False
    concern_flags = list(dict.fromkeys(structured_output["concern_flags"]))
    if classification["weak_description"]:
        fallback_used = True
        structured_output["fallback_used"] = True

    attempt_dir = ensure_dir(
        build_attempt_dir(
            job_id=job_id, role_family=classification["role_family"], ad_hoc_label=ad_hoc_label
        )
    )
    # Always persist LLM I/O + timing when available (prompt may exist even on timeouts).
    if llm_meta:
        write_json(attempt_dir / "llm_enrichment.json", llm_meta)
        if llm_meta.get("prompt_text") is not None:
            write_text(attempt_dir / "ollama_prompt.txt", str(llm_meta.get("prompt_text") or ""))
        if llm_meta.get("response_text") is not None:
            write_text(
                attempt_dir / "ollama_response.txt", str(llm_meta.get("response_text") or "")
            )
    # Always write summary (even if empty - webapp always shows the card).
    write_json(attempt_dir / "summary_rewrite.json", {
        "summary": summary_rewrite_meta.get("summary", ""),
        "success": summary_rewrite_meta.get("success", False),
        "duration_ms": summary_rewrite_meta.get("duration_ms"),
        "error": summary_rewrite_meta.get("error"),
        "keywords_used": kw_match.get("summary_keywords", []),
    })
    if bullet_rewrites:
        write_json(attempt_dir / "bullet_rewrite.json", {
            "rewrites": bullet_rewrites,
            "total_rewrites": len(bullet_rewrites),
            "successful_rewrites": sum(1 for r in bullet_rewrites if r["success"]),
            "total_duration_ms": sum(r["duration_ms"] or 0 for r in bullet_rewrites),
        })
    # Write keyword matching detail for inspection.
    write_json(attempt_dir / "keyword_distribution.json", kw_match)

    job_description_path = write_text(attempt_dir / "job_description.txt", description or "")
    role_classification_path = write_json(attempt_dir / "role_classification.json", classification)
    keywords_path = write_json(attempt_dir / "keywords.json", keywords)
    write_json(
        attempt_dir / "source_material.json",
        {
            "candidate_profile": candidate_profile,
            "bullet_library": bullet_library,
        },
    )
    structured_output_path, compile_result, tex_path, compile_history = _compile_with_fit_retry(
        attempt_dir,
        tailored_doc,
        structured_output,
    )
    compile_log_path = write_text(attempt_dir / "compile.log", compile_result["log_text"])
    metadata = {
        "job_id": job_id,
        "source_mode": source_mode,
        "title": title,
        "company": company,
        "classification": classification,
        "keywords": keywords,
        "fallback_used": fallback_used,
        "compile_status": compile_result["compile_status"],
        "page_count": compile_result["page_count"],
        "fits_one_page": compile_result["fits_one_page"],
        "page_fit_retry_count": max(0, len(compile_history) - 1),
        "compile_history": compile_history,
        "model_backend": DEFAULT_MODEL_BACKEND,
        "model_name": model_name,
        "llm_enrichment": llm_meta,
        "job_description_hash": desc_fingerprint,
        "selected_base_resume": base_resume_name,
        "source_resume_path": str(Path(selected_resume_path)),
        "role_classification_path": role_classification_path,
    }
    metadata_path = write_json(attempt_dir / "metadata.json", metadata)

    status = "failed"
    latest_result_kind = "latest_generated"
    is_latest_useful = False
    is_selected_for_c3 = False
    pdf_path = compile_result["pdf_path"]

    if compile_result["fits_one_page"]:
        status = "done_with_flags" if concern_flags else "done"
        latest_result_kind = "latest_useful"
        is_latest_useful = True
        is_selected_for_c3 = job_id is not None and allow_downstream_selection
    else:
        if "page_limit_failed" not in concern_flags:
            concern_flags.append("page_limit_failed")

    jd_usable_db = None
    jd_usable_reason_db = None
    if llm_meta.get("ollama_enriched") and isinstance(llm_meta.get("jd_usable"), bool):
        jd_usable_db = llm_meta["jd_usable"]
        jd_usable_reason_db = llm_meta.get("jd_usable_reason")

    attempt_payload = {
        "attempt_type": source_mode,
        "status": status,
        "latest_result_kind": latest_result_kind,
        "role_family": classification["role_family"],
        "job_level": classification["job_level"],
        "base_resume_name": base_resume_name,
        "source_resume_type": "family_base"
        if base_resume_name not in {"original", "custom"}
        else ("custom" if base_resume_name == "custom" else "original"),
        "source_resume_path": str(Path(selected_resume_path)),
        "fallback_used": fallback_used,
        "model_backend": DEFAULT_MODEL_BACKEND,
        "model_name": model_name,
        "prompt_version": prompt_version,
        "concern_flags": list(dict.fromkeys(concern_flags)),
        "job_description_path": job_description_path,
        "keywords_path": keywords_path,
        "structured_output_path": structured_output_path,
        "tex_path": tex_path,
        "pdf_path": pdf_path,
        "compile_log_path": compile_log_path,
        "metadata_path": metadata_path,
        "content_hash": file_hash(Path(tex_path)),
        "is_latest_useful": is_latest_useful,
        "is_selected_for_c3": is_selected_for_c3,
        "clear_existing_selection": source_mode == "queue" and not allow_downstream_selection,
        "jd_usable": jd_usable_db,
        "jd_usable_reason": jd_usable_reason_db,
        "job_description_hash": desc_fingerprint,
    }

    attempt_id = None
    version_id = None
    if source_mode == "queue":
        attempt_id, version_id = record_resume_attempt(job_id, attempt_payload, db_path)

    # Finalise and write pipeline trace.
    trace["status"] = status
    trace["compile_status"] = compile_result["compile_status"]
    trace["fits_one_page"] = compile_result["fits_one_page"]
    trace["pdf_path"] = pdf_path
    trace["total_ms"] = int((time.perf_counter() - _t_pipeline_start) * 1000)
    write_json(attempt_dir / "pipeline_trace.json", trace)
    if _config.LOG_LLM_IO:
        _print_trace(trace)

    result = {
        "job_id": job_id,
        "attempt_id": attempt_id,
        "resume_version_id": version_id,
        "attempt_dir": str(attempt_dir),
        "status": status,
        "compile_status": compile_result["compile_status"],
        "page_count": compile_result["page_count"],
        "fits_one_page": compile_result["fits_one_page"],
        "selected_for_c3": is_selected_for_c3,
        "pdf_path": pdf_path,
        "tex_path": tex_path,
        "metadata_path": metadata_path,
        "summary_rewrite_path": str(attempt_dir / "summary_rewrite.json"),
        "bullet_rewrite_path": str(attempt_dir / "bullet_rewrite.json") if bullet_rewrites else None,
        "pipeline_trace_path": str(attempt_dir / "pipeline_trace.json"),
        "apply_context": get_apply_context(job_id, db_path) if job_id is not None else None,
    }
    write_json(attempt_dir / "result.json", result)
    return result


def _job_is_ready_for_c3(job: dict) -> bool:
    enrichment_status = (job.get("enrichment_status") or "").strip().lower()
    apply_type = (job.get("apply_type") or "").strip().lower()
    apply_url = (job.get("apply_url") or "").strip()
    priority = int(job.get("priority") or 0)
    auto_apply_eligible = int(job.get("auto_apply_eligible") or 0)

    return (
        enrichment_status in {"done", "done_verified"}
        and apply_type == "external_apply"
        and auto_apply_eligible == 1
        and priority == 0
        and bool(apply_url)
    )
