from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


@dataclass(slots=True)
class ReadyJobDecision:
    job_id: int
    ready: bool
    reason: str
    apply_url: str | None = None
    ats_type: str | None = None
    selected_resume_version_id: int | None = None
    selected_resume_pdf_path: str | None = None
    flags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ApplyContext:
    job_id: int
    title: str | None = None
    company: str | None = None
    apply_url: str | None = None
    ats_type: str | None = None
    selected_resume_version_id: int | None = None
    selected_resume_pdf_path: str | None = None
    job_description_path: str | None = None
    source_mode: str = "c4"
    manual_review_flags: list[str] = field(default_factory=list)
    apply_context_path: str | None = None
    created_at: str = field(default_factory=utc_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class OrchestrationRun:
    run_id: str
    job_id: int
    status: str
    source_runtime: str = "manual"
    selected_resume_version_id: int | None = None
    apply_url: str | None = None
    ats_type: str | None = None
    apply_context_path: str | None = None
    manual_review_required: bool = False
    manual_review_reason: str | None = None
    submit_allowed: bool = False
    submit_approval_id: str | None = None
    started_at: str = field(default_factory=utc_now_iso)
    completed_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
