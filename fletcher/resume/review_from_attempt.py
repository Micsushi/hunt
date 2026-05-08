from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from fletcher.config import DEFAULT_OG_RESUME_PATH

from .compiler import compile_tex
from .parser import parse_resume_file
from .renderer import render_resume_tex
from .review_models import (
    ResumeReviewJobInfo,
    ResumeReviewLlmInfo,
    ResumeReviewPackage,
    ResumeReviewSourceInfo,
    ResumeReviewVersion,
    ResumeReviewVersionName,
    build_review_id,
)
from .review_store import write_review_package


def _read_json(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _description_hash(text: str | None) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def _version_url(review_id: str, version: str, kind: str) -> str:
    return f"/api/fletcher/reviews/{review_id}/versions/{version}/{kind}"


def create_review_package_from_attempt(
    *,
    attempt: dict[str, Any],
    job: dict[str, Any] | None = None,
    original_resume_path: str | Path = DEFAULT_OG_RESUME_PATH,
) -> ResumeReviewPackage:
    tex_path = Path(str(attempt.get("tex_path") or ""))
    if not tex_path.exists():
        raise FileNotFoundError("Attempt TeX artifact is missing.")
    attempt_dir = tex_path.parent
    review_id = build_review_id(f"{attempt_dir}:{attempt.get('id') or ''}")
    source_resume_path = Path(str(attempt.get("source_resume_path") or original_resume_path))
    if not source_resume_path.exists():
        source_resume_path = tex_path
    original = parse_resume_file(source_resume_path)
    generated = parse_resume_file(tex_path)
    starting_tex = attempt_dir / "starting.tex"
    starting_tex.write_text(render_resume_tex(original), encoding="utf-8")
    starting_compile = compile_tex(starting_tex)
    keywords = _read_json(attempt.get("keywords_path"))
    raw_keywords = keywords.get("must_have_terms") or keywords.get("raw") or []
    provider = str(attempt.get("model_backend") or "heuristic")
    package = ResumeReviewPackage(
        review_id=review_id,
        source=ResumeReviewSourceInfo(
            input_kind=str(attempt.get("source_resume_type") or "tex"),
            input_filename=Path(str(attempt.get("source_resume_path") or source_resume_path)).name,
            import_status="ok",
            import_warnings=[],
        ),
        job=ResumeReviewJobInfo(
            job_id=int(job["id"]) if job and job.get("id") is not None else attempt.get("job_id"),
            attempt_id=int(attempt["id"]) if attempt.get("id") is not None else None,
            title=str((job or {}).get("title") or ""),
            company=str((job or {}).get("company") or ""),
            role_family=str(attempt.get("role_family") or ""),
            job_level=str(attempt.get("job_level") or ""),
            description_hash=_description_hash((job or {}).get("description")),
        ),
        llm=ResumeReviewLlmInfo(
            provider=provider,
            model=str(attempt.get("model_name") or ""),
            cloud=provider in {"openai", "openrouter", "anthropic", "gemini"},
        ),
        keywords={
            "raw": [str(item) for item in raw_keywords],
            "present": [],
            "missing": [],
        },
        versions={
            ResumeReviewVersionName.STARTING: ResumeReviewVersion(
                original=original,
                generated=original,
                current=original,
                pdf_url=_version_url(review_id, "starting", "pdf"),
                tex_url=_version_url(review_id, "starting", "tex"),
                dirty=False,
                compiled_revision=0,
                compile_status=str(starting_compile.get("compile_status") or ""),
            ),
            ResumeReviewVersionName.NO_SUMMARY: ResumeReviewVersion(
                original=original,
                generated=generated,
                current=generated,
                pdf_url=_version_url(review_id, "no_summary", "pdf"),
                tex_url=_version_url(review_id, "no_summary", "tex"),
                dirty=False,
                compiled_revision=0,
                compile_status=str(attempt.get("status") or ""),
            ),
        },
        log_url=f"/api/fletcher/reviews/{review_id}/log",
    )
    summary_tex = attempt_dir / "output_summary.tex"
    if summary_tex.exists():
        generated_summary = parse_resume_file(summary_tex)
        package.versions[ResumeReviewVersionName.WITH_SUMMARY] = ResumeReviewVersion(
            original=original,
            generated=generated_summary,
            current=generated_summary,
            pdf_url=_version_url(review_id, "with_summary", "pdf"),
            tex_url=_version_url(review_id, "with_summary", "tex"),
            dirty=False,
            compiled_revision=0,
            compile_status=str(attempt.get("status") or ""),
        )
    write_review_package(attempt_dir, package)
    return package
