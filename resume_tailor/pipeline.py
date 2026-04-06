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
)
from .db import (
    get_apply_context,
    get_job_context,
    init_resume_db,
    list_jobs_ready_for_resume,
    record_resume_attempt,
)
from .generator import generate_tailored_resume
from .keyword_extractor import extract_keywords
from .parser import parse_resume_file
from .renderer import render_resume_tex
from .source_loader import load_bullet_library, load_candidate_profile
from .storage import build_attempt_dir, ensure_dir, file_hash, write_json, write_text


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
    resume_path: str | Path,
    candidate_profile_path: str | Path,
    bullet_library_path: str | Path,
) -> dict:
    parsed_resume = parse_resume_file(resume_path)
    classification = classify_job(title=title, description=description)
    keywords = extract_keywords(title=title, description=description, classification=classification)
    candidate_profile = load_candidate_profile(candidate_profile_path)
    bullet_library = load_bullet_library(bullet_library_path)

    tailored_doc, structured_output = generate_tailored_resume(
        parsed_resume,
        classification=classification,
        keywords=keywords,
    )

    fallback_used = False
    concern_flags = list(dict.fromkeys(structured_output["concern_flags"]))
    if classification["weak_description"]:
        fallback_used = True
        structured_output["fallback_used"] = True

    attempt_dir = ensure_dir(build_attempt_dir(job_id=job_id, role_family=classification["role_family"], ad_hoc_label=ad_hoc_label))
    job_description_path = write_text(attempt_dir / "job_description.txt", description or "")
    role_classification_path = write_json(attempt_dir / "role_classification.json", classification)
    keywords_path = write_json(attempt_dir / "keywords.json", keywords)
    write_json(attempt_dir / "source_material.json", {
        "candidate_profile": candidate_profile,
        "bullet_library": bullet_library,
    })
    structured_output_path = write_json(attempt_dir / "tailored_resume.json", structured_output)
    tex_path = write_text(attempt_dir / "output.tex", render_resume_tex(tailored_doc))

    compile_result = compile_tex(tex_path)
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
        "model_backend": DEFAULT_MODEL_BACKEND,
        "model_name": DEFAULT_MODEL_NAME,
        "source_resume_path": str(Path(resume_path)),
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
        is_selected_for_c3 = job_id is not None
    else:
        if "page_limit_failed" not in concern_flags:
            concern_flags.append("page_limit_failed")

    attempt_payload = {
        "attempt_type": source_mode,
        "status": status,
        "latest_result_kind": latest_result_kind,
        "role_family": classification["role_family"],
        "job_level": classification["job_level"],
        "base_resume_name": "original",
        "source_resume_type": "original",
        "source_resume_path": str(Path(resume_path)),
        "fallback_used": fallback_used,
        "model_backend": DEFAULT_MODEL_BACKEND,
        "model_name": DEFAULT_MODEL_NAME,
        "prompt_version": "stage0_stage1_deterministic_v1",
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
