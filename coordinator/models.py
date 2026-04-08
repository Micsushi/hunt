from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any


def utc_now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def _json_list(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, tuple):
        return [str(item) for item in value if str(item).strip()]
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return [text]
        if isinstance(parsed, list):
            return [str(item) for item in parsed if str(item).strip()]
        return [str(parsed)] if str(parsed).strip() else []
    return [str(value)] if str(value).strip() else []


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(slots=True)
class ReadyJobDecision:
    job_id: int
    ready: bool
    reason: str
    source: str | None = None
    title: str | None = None
    company: str | None = None
    apply_url: str | None = None
    ats_type: str | None = None
    selected_resume_version_id: str | None = None
    selected_resume_pdf_path: str | None = None
    blocking_run_id: str | None = None
    manual_review_reason: str | None = None
    flags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ApplyContext:
    run_id: str
    job_id: int
    title: str | None = None
    company: str | None = None
    source: str | None = None
    apply_url: str | None = None
    job_url: str | None = None
    ats_type: str | None = None
    apply_type: str | None = None
    auto_apply_eligible: int = 0
    priority: int = 0
    description: str | None = None
    selected_resume_version_id: str | None = None
    selected_resume_pdf_path: str | None = None
    selected_resume_tex_path: str | None = None
    selected_resume_ready_for_c3: bool = False
    job_description_path: str | None = None
    concern_flags: list[str] = field(default_factory=list)
    manual_review_flags: list[str] = field(default_factory=list)
    source_mode: str = "c4"
    apply_context_path: str | None = None
    c3_apply_context_path: str | None = None
    created_at: str = field(default_factory=utc_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class OrchestrationRun:
    run_id: str
    job_id: int
    status: str
    source_runtime: str = "manual"
    job_source: str | None = None
    job_title: str | None = None
    company: str | None = None
    selected_resume_version_id: str | None = None
    selected_resume_pdf_path: str | None = None
    selected_resume_tex_path: str | None = None
    apply_url: str | None = None
    ats_type: str | None = None
    apply_context_path: str | None = None
    c3_apply_context_path: str | None = None
    fill_result_path: str | None = None
    browser_summary_path: str | None = None
    decision_path: str | None = None
    final_status_path: str | None = None
    manual_review_required: bool = False
    manual_review_reason: str | None = None
    manual_review_flags: list[str] = field(default_factory=list)
    submit_allowed: bool = False
    submit_approval_id: str | None = None
    started_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)
    completed_at: str | None = None

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> OrchestrationRun:
        return cls(
            run_id=str(row["id"]),
            job_id=int(row["job_id"]),
            status=str(row["status"]),
            source_runtime=str(row["source_runtime"]),
            job_source=row["job_source"],
            job_title=row["job_title"],
            company=row["company"],
            selected_resume_version_id=row["selected_resume_version_id"],
            selected_resume_pdf_path=row["selected_resume_pdf_path"],
            selected_resume_tex_path=row["selected_resume_tex_path"],
            apply_url=row["apply_url"],
            ats_type=row["ats_type"],
            apply_context_path=row["apply_context_path"],
            c3_apply_context_path=row["c3_apply_context_path"],
            fill_result_path=row["fill_result_path"],
            browser_summary_path=row["browser_summary_path"],
            decision_path=row["decision_path"],
            final_status_path=row["final_status_path"],
            manual_review_required=_bool(row["manual_review_required"]),
            manual_review_reason=row["manual_review_reason"],
            manual_review_flags=_json_list(row["manual_review_flags_json"]),
            submit_allowed=_bool(row["submit_allowed"]),
            submit_approval_id=row["submit_approval_id"],
            started_at=str(row["started_at"]),
            updated_at=str(row["updated_at"]),
            completed_at=row["completed_at"],
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class OrchestrationEvent:
    event_id: int | None
    run_id: str
    event_type: str
    step_name: str
    payload_json: str | None = None
    payload_path: str | None = None
    created_at: str = field(default_factory=utc_now_iso)

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> OrchestrationEvent:
        return cls(
            event_id=int(row["id"]),
            run_id=str(row["orchestration_run_id"]),
            event_type=str(row["event_type"]),
            step_name=str(row["step_name"]),
            payload_json=row["payload_json"],
            payload_path=row["payload_path"],
            created_at=str(row["created_at"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class SubmitApproval:
    approval_id: str
    job_id: int
    run_id: str
    approval_mode: str
    approved_by: str
    decision: str
    reason: str | None = None
    artifact_path: str | None = None
    created_at: str = field(default_factory=utc_now_iso)

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> SubmitApproval:
        return cls(
            approval_id=str(row["id"]),
            job_id=int(row["job_id"]),
            run_id=str(row["orchestration_run_id"]),
            approval_mode=str(row["approval_mode"]),
            approved_by=str(row["approved_by"]),
            decision=str(row["decision"]),
            reason=row["reason"],
            artifact_path=row["artifact_path"],
            created_at=str(row["created_at"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
