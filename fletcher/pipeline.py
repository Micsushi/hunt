from __future__ import annotations

from pathlib import Path

from .classifier import classify_job, slugify
from .compiler import compile_tex
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
    list_jobs_ready_for_resume,
    record_resume_attempt,
)
from .generator import generate_tailored_resume
from .llm_enrich import enrich_with_ollama_if_enabled
from .keyword_extractor import extract_keywords
from .parser import parse_resume_file
from .renderer import render_resume_tex
from .source_loader import load_bullet_library, load_candidate_profile
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
    classification = classify_job(title=title, description=description)
    keywords = extract_keywords(title=title, description=description, classification=classification)
    classification, keywords, llm_meta = enrich_with_ollama_if_enabled(
        title=title, description=description, classification=classification, keywords=keywords
    )
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
    if llm_meta.get("prompt_text") or llm_meta.get("response_text"):
        if llm_meta.get("prompt_text"):
            write_text(attempt_dir / "ollama_prompt.txt", str(llm_meta.get("prompt_text") or ""))
        if llm_meta.get("response_text"):
            write_text(
                attempt_dir / "ollama_response.txt", str(llm_meta.get("response_text") or "")
            )
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
    }

    attempt_id = None
    version_id = None
    if source_mode == "queue":
        attempt_id, version_id = record_resume_attempt(job_id, attempt_payload, db_path)

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
