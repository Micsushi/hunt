from __future__ import annotations

import base64
import json
import mimetypes
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from hunter import db as hunter_db  # noqa: E402


class ApplyPrepNotReadyError(RuntimeError):
    def __init__(self, job_id: int, reason: str, flags: list[str] | None = None):
        self.job_id = job_id
        self.reason = reason
        self.flags = flags or []
        super().__init__(f"Job {job_id} is not ready for apply-prep: {reason}")


def _orchestration_runtime_root() -> Path:
    configured = os.getenv("HUNT_COORDINATOR_ROOT") or os.getenv("HUNT_ORCHESTRATION_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    if os.name == "nt":
        return (REPO_ROOT / ".runtime" / "coordinator").resolve()
    return Path("/home/michael/data/hunt/coordinator")


def _utc_now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def _write_json(path: Path, payload: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


def _next_apply_context_path(job_id: int) -> Path:
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return _orchestration_runtime_root() / "apply_contexts" / f"job_{job_id}_{timestamp}.json"


def _build_resume_data_url(pdf_path: str) -> str:
    if not pdf_path:
        return ""

    path = Path(pdf_path)
    if not path.exists() or not path.is_file():
        return ""

    mime_type = mimetypes.guess_type(path.name)[0] or "application/pdf"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _strip_latex(text: str) -> str:
    cleaned = text or ""
    replacements = {
        r"\textbf{": "",
        r"\href{": "",
        "}": "",
        "{": "",
        r"\\": " ",
    }
    for original, replacement in replacements.items():
        cleaned = cleaned.replace(original, replacement)
    return " ".join(cleaned.split())


def _build_resume_summary(tex_path: str) -> str:
    if not tex_path:
        return ""
    path = Path(tex_path)
    if not path.exists() or path.suffix.lower() != ".tex":
        return ""

    try:
        from fletcher.parser import parse_resume_file
    except Exception:
        return ""

    try:
        document = parse_resume_file(path)
    except Exception:
        return ""

    role_summaries = []
    for entry in document.experience[:2]:
        role_summaries.append(_strip_latex(entry.title_company_location))
    project_summaries = [_strip_latex(entry.project_title) for entry in document.projects[:1]]
    top_skills = (
        document.skills.languages[:3]
        + document.skills.frameworks[:3]
        + document.skills.developer_tools[:3]
    )

    summary_parts = []
    if role_summaries:
        summary_parts.append(f"Experience: {', '.join(role_summaries)}")
    if project_summaries:
        summary_parts.append(f"Projects: {', '.join(project_summaries)}")
    if top_skills:
        summary_parts.append(f"Skills: {', '.join(top_skills[:6])}")
    return " | ".join(summary_parts)


def _parse_resume_flags(raw_flags: Any) -> list[str]:
    if raw_flags is None:
        return []
    if isinstance(raw_flags, list):
        return [str(flag).strip() for flag in raw_flags if str(flag).strip()]
    if isinstance(raw_flags, str):
        stripped = raw_flags.strip()
        if not stripped:
            return []
        try:
            decoded = json.loads(stripped)
        except json.JSONDecodeError:
            return ["resume_flags:unparseable"]
        if isinstance(decoded, list):
            return [str(flag).strip() for flag in decoded if str(flag).strip()]
    return []


def _normalize_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y"}
    return False


def _get_job_context(job_id: int) -> dict[str, Any] | None:
    hunter_db.init_db(maintenance=False)
    return hunter_db.get_apply_context_for_job(job_id)


def get_ready_decision(job_id: int) -> dict[str, Any]:
    context = _get_job_context(job_id)
    if not context:
        return {
            "job_id": job_id,
            "ready": False,
            "reason": "job_not_found",
            "apply_url": None,
            "ats_type": None,
            "selected_resume_version_id": None,
            "selected_resume_pdf_path": None,
            "flags": ["job_not_found"],
        }

    flags: list[str] = []
    reason = "ready"
    checks = (
        (
            "enrichment_status",
            context.get("enrichment_status") in {"done", "done_verified"},
            "enrichment_incomplete",
        ),
        ("apply_type", context.get("apply_type") == "external_apply", "not_external_apply"),
        (
            "auto_apply_eligible",
            _normalize_bool(context.get("auto_apply_eligible")),
            "auto_apply_ineligible",
        ),
        ("priority", int(context.get("priority") or 0) == 0, "manual_only_priority"),
        (
            "selected_resume_ready_for_c3",
            _normalize_bool(context.get("selected_resume_ready_for_c3")),
            "resume_not_ready_for_c3",
        ),
        (
            "selected_resume_pdf_path",
            bool(context.get("selected_resume_pdf_path")),
            "missing_selected_resume_pdf",
        ),
        ("apply_url", bool(context.get("apply_url")), "missing_apply_url"),
    )
    for _field_name, passed, failure_code in checks:
        if not passed:
            flags.append(failure_code)
            if reason == "ready":
                reason = failure_code

    return {
        "job_id": int(context["job_id"]),
        "ready": not flags,
        "reason": reason,
        "apply_url": context.get("apply_url") or None,
        "ats_type": context.get("ats_type") or None,
        "selected_resume_version_id": context.get("selected_resume_version_id") or None,
        "selected_resume_pdf_path": context.get("selected_resume_pdf_path") or None,
        "flags": flags,
    }


def build_apply_prep_payload(
    job_id: int,
    *,
    embed_resume_data: bool = False,
    require_ready: bool = True,
    output_path: str | Path | None = None,
) -> dict[str, Any]:
    context = _get_job_context(job_id)
    if not context:
        raise SystemExit(f"Job {job_id} was not found.")

    ready = get_ready_decision(job_id)
    if require_ready and not ready["ready"]:
        raise ApplyPrepNotReadyError(job_id, ready["reason"], ready["flags"])

    concern_flags = _parse_resume_flags(context.get("latest_resume_flags"))
    if context.get("last_enrichment_error"):
        concern_flags.append(f"enrichment_error:{context['last_enrichment_error']}")
    if context.get("enrichment_status") not in {"done", "done_verified"}:
        concern_flags.append(f"enrichment_status:{context.get('enrichment_status') or 'unknown'}")
    concern_flags = list(dict.fromkeys(flag for flag in concern_flags if flag))

    payload = {
        "jobId": context["job_id"],
        "title": context.get("title") or "",
        "company": context.get("company") or "",
        "applyUrl": context.get("apply_url") or "",
        "jobUrl": context.get("job_url") or "",
        "sourceMode": "c4",
        "source": context.get("source") or "",
        "atsType": context.get("ats_type") or "unknown",
        "applyType": context.get("apply_type") or "unknown",
        "autoApplyEligible": int(context.get("auto_apply_eligible") or 0),
        "description": context.get("description") or "",
        "selectedResumeVersionId": context.get("selected_resume_version_id") or "",
        "selectedResumePath": context.get("selected_resume_pdf_path") or "",
        "selectedResumeTexPath": context.get("selected_resume_tex_path") or "",
        "selectedResumeSummary": _build_resume_summary(
            context.get("selected_resume_tex_path") or ""
        ),
        "selectedResumeReadyForC3": _normalize_bool(context.get("selected_resume_ready_for_c3")),
        "jdSnapshotPath": context.get("latest_resume_job_description_path") or "",
        "concernFlags": concern_flags,
        "primedAt": _utc_now_iso(),
        "applyContextPath": "",
    }

    if embed_resume_data:
        payload["selectedResumeDataUrl"] = _build_resume_data_url(
            context.get("selected_resume_pdf_path") or ""
        )
        payload["selectedResumeName"] = (
            Path(context["selected_resume_pdf_path"]).name
            if context.get("selected_resume_pdf_path")
            else ""
        )
        payload["selectedResumeMimeType"] = "application/pdf"

    final_output_path = (
        Path(output_path) if output_path else _next_apply_context_path(int(context["job_id"]))
    )
    payload["applyContextPath"] = str(_write_json(final_output_path, payload))
    return payload
