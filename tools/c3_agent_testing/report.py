from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class LaneResult:
    agent_id: str
    lane_id: str
    session_id: str
    operation_id: str
    job_url: str
    classification: str
    operation_state: str
    terminal_reason: str
    lease_id: str
    operation_refresh_status: str = "not_requested"
    operation_refresh_error: str = ""
    command_id: str = ""
    trace_id: str = ""
    artifact_dir: str = ""
    artifact_ids: tuple[str, ...] = ()
    artifact_paths: tuple[str, ...] = ()
    event_ids: tuple[str, ...] = ()
    cancel_requested: bool = False
    cancel_acknowledged: bool = False
    submit_activated: bool = False
    focus_activated: bool = False
    error: str = ""
    failure_context_status: str = "not_requested"
    diagnosis_id: str = ""
    failure_scope: str = ""
    root_cause_code: str = ""
    failure_summary: str = ""
    causal_selector: str = ""
    causal_label: str = ""
    last_touched_selector: str = ""
    last_touched_label: str = ""
    expected_state: str = ""
    observed_state: str = ""
    confidence: str = "unknown"
    root_cause_unknown: bool = True
    failure_evidence_event_ids: tuple[str, ...] = ()
    failure_checkpoint_ids: tuple[str, ...] = ()
    failure_artifact_ids: tuple[str, ...] = ()
    failure_action_tail: tuple[dict[str, Any], ...] = ()
    failure_validation_tail: tuple[dict[str, Any], ...] = ()
    failure_navigation_tail: tuple[dict[str, Any], ...] = ()
    failure_artifact_summaries: tuple[dict[str, Any], ...] = ()
    failure_artifact_status: str = "idle"
    failure_source_event_sequence: int = 0
    failure_evidence_truncated: bool = False
    failure_response_evidence_truncated: bool = False
    validation_messages: tuple[str, ...] = ()
    credential_preparation: tuple[dict[str, Any], ...] = ()
    missing_evidence: tuple[str, ...] = ()
    live_inspection_required: bool = True
    next_safe_action: str = ""
    failure_context_error: str = ""
    failure_context_refresh_status: str = "not_requested"
    failure_context_refresh_error: str = ""


@dataclass(frozen=True)
class BatchReport:
    batch_id: str
    lanes: tuple[LaneResult, ...]
    started_at: str
    completed_at: str
    metadata: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)

    def write_json(self, path: str | Path) -> Path:
        output = Path(path)
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(output.suffix + ".tmp")
        temporary.write_text(
            json.dumps(self.as_dict(), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        temporary.replace(output)
        return output


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
