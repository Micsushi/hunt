from __future__ import annotations

import base64
import json
import mimetypes
from pathlib import Path
from typing import Any, Mapping

from .models import utc_now_iso


_MANUAL_REVIEW_SEED_FLAGS = {
    "manual_review_recommended",
}


def _string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_flag_list(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, tuple):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return [text]
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed if str(item).strip()]
        return [str(parsed).strip()] if str(parsed).strip() else []
    return [str(value).strip()] if str(value).strip() else []


def _dedupe(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def build_resume_data_url(pdf_path: str | None) -> str:
    if not pdf_path:
        return ""

    path = Path(pdf_path)
    if not path.exists() or not path.is_file():
        return ""

    mime_type = mimetypes.guess_type(path.name)[0] or "application/pdf"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def derive_concern_flags(job: Mapping[str, Any]) -> list[str]:
    flags = list(_normalize_flag_list(job.get("latest_resume_flags")))

    enrichment_status = _string_or_none(job.get("enrichment_status"))
    if enrichment_status and enrichment_status not in {"done", "done_verified"}:
        flags.append(f"enrichment_status:{enrichment_status}")

    last_enrichment_error = _string_or_none(job.get("last_enrichment_error"))
    if last_enrichment_error:
        flags.append(f"enrichment_error:{last_enrichment_error}")

    return _dedupe(flags)


def derive_manual_review_flags(job: Mapping[str, Any]) -> list[str]:
    return _dedupe(
        [
            flag
            for flag in derive_concern_flags(job)
            if flag in _MANUAL_REVIEW_SEED_FLAGS
        ]
    )


def build_apply_context_payload(
    job: Mapping[str, Any],
    *,
    run_id: str,
    source_mode: str = "c4",
    created_at: str | None = None,
    apply_context_path: str | None = None,
    c3_apply_context_path: str | None = None,
) -> dict[str, Any]:
    concern_flags = derive_concern_flags(job)
    manual_review_flags = derive_manual_review_flags(job)
    created_at = created_at or utc_now_iso()

    return {
        "run_id": run_id,
        "job_id": int(job["job_id"]),
        "title": _string_or_none(job.get("title")),
        "company": _string_or_none(job.get("company")),
        "source": _string_or_none(job.get("source")),
        "apply_url": _string_or_none(job.get("apply_url")),
        "job_url": _string_or_none(job.get("job_url")),
        "ats_type": _string_or_none(job.get("ats_type")) or "unknown",
        "apply_type": _string_or_none(job.get("apply_type")) or "unknown",
        "auto_apply_eligible": int(job.get("auto_apply_eligible") or 0),
        "priority": int(job.get("priority") or 0),
        "description": _string_or_none(job.get("description")),
        "selected_resume_version_id": _string_or_none(job.get("selected_resume_version_id")),
        "selected_resume_pdf_path": _string_or_none(job.get("selected_resume_pdf_path")),
        "selected_resume_tex_path": _string_or_none(job.get("selected_resume_tex_path")),
        "selected_resume_ready_for_c3": bool(job.get("selected_resume_ready_for_c3")),
        "job_description_path": _string_or_none(job.get("latest_resume_job_description_path")),
        "concern_flags": concern_flags,
        "manual_review_flags": manual_review_flags,
        "source_mode": source_mode,
        "apply_context_path": apply_context_path,
        "c3_apply_context_path": c3_apply_context_path,
        "created_at": created_at,
    }


def build_c3_apply_payload(
    job: Mapping[str, Any],
    *,
    source_mode: str = "c4",
    primed_at: str | None = None,
    embed_resume_data: bool = False,
) -> dict[str, Any]:
    primed_at = primed_at or utc_now_iso()
    selected_resume_path = _string_or_none(job.get("selected_resume_pdf_path")) or ""

    payload = {
        "jobId": str(job["job_id"]),
        "title": _string_or_none(job.get("title")) or "",
        "company": _string_or_none(job.get("company")) or "",
        "applyUrl": _string_or_none(job.get("apply_url")) or "",
        "jobUrl": _string_or_none(job.get("job_url")) or "",
        "sourceMode": source_mode,
        "source": _string_or_none(job.get("source")) or "",
        "atsType": _string_or_none(job.get("ats_type")) or "unknown",
        "applyType": _string_or_none(job.get("apply_type")) or "unknown",
        "autoApplyEligible": int(job.get("auto_apply_eligible") or 0),
        "description": _string_or_none(job.get("description")) or "",
        "selectedResumeVersionId": _string_or_none(job.get("selected_resume_version_id")) or "",
        "selectedResumePath": selected_resume_path,
        "selectedResumeTexPath": _string_or_none(job.get("selected_resume_tex_path")) or "",
        "selectedResumeReadyForC3": bool(job.get("selected_resume_ready_for_c3")),
        "jdSnapshotPath": _string_or_none(job.get("latest_resume_job_description_path")) or "",
        "concernFlags": derive_concern_flags(job),
        "primedAt": primed_at,
    }

    if embed_resume_data:
        payload["selectedResumeDataUrl"] = build_resume_data_url(selected_resume_path)
        payload["selectedResumeName"] = Path(selected_resume_path).name if selected_resume_path else ""
        payload["selectedResumeMimeType"] = "application/pdf"

    return payload
