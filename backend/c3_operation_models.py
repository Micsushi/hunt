from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

OperationState = Literal[
    "queued",
    "running",
    "slow",
    "suspected_stall",
    "stalled",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
    "orphaned",
]

NONTERMINAL_STATES = {
    "queued",
    "running",
    "slow",
    "suspected_stall",
    "stalled",
    "cancelling",
}
TERMINAL_STATES = {"completed", "failed", "cancelled", "orphaned"}

_ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "queued": {"running", "cancelling", "failed", "orphaned"},
    "running": {
        "slow",
        "suspected_stall",
        "stalled",
        "cancelling",
        "completed",
        "failed",
        "orphaned",
    },
    "slow": {
        "running",
        "suspected_stall",
        "stalled",
        "cancelling",
        "completed",
        "failed",
        "orphaned",
    },
    "suspected_stall": {
        "running",
        "slow",
        "stalled",
        "cancelling",
        "completed",
        "failed",
        "orphaned",
    },
    "stalled": {"cancelling", "failed", "orphaned"},
    "cancelling": {"cancelled", "failed", "orphaned"},
    "completed": set(),
    "failed": set(),
    "cancelled": set(),
    "orphaned": set(),
}

SUBMIT_CAPABILITIES = {"c3.final_submit", "final_submit", "submit"}


class InvalidOperationTransition(ValueError):
    def __init__(self, current: str, next_state: str):
        super().__init__(f"Invalid C3 operation transition: {current} -> {next_state}")
        self.current = current
        self.next_state = next_state


def validate_transition(current: str, next_state: str) -> str:
    if current == next_state:
        return next_state
    if current not in _ALLOWED_TRANSITIONS or next_state not in _ALLOWED_TRANSITIONS[current]:
        raise InvalidOperationTransition(current, next_state)
    return next_state


def utc_now() -> datetime:
    return datetime.now(UTC)


class _OperationModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @field_validator(
        "created_at",
        "updated_at",
        "deadline_at",
        "started_at",
        "finished_at",
        "last_heartbeat_at",
        "last_progress_at",
        "cancel_requested_at",
        "cancel_acknowledged_at",
        "cancel_attempted_at",
        "cancel_pending_at",
        "cancel_failed_at",
        "cancel_retry_after",
        "ts",
        check_fields=False,
    )
    @classmethod
    def _timestamps_are_utc_aware(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return value
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("operation timestamps must include a UTC offset")
        return value.astimezone(UTC)


class _SubmitPolicyModel(_OperationModel):
    allow_submit: bool = False
    capabilities: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _require_submit_capability(self):
        if self.allow_submit and not SUBMIT_CAPABILITIES.intersection(self.capabilities):
            raise ValueError("allow_submit requires an explicit submit capability")
        return self


class C3OperationRequest(_SubmitPolicyModel):
    command: str = Field(
        min_length=1,
        validation_alias=AliasChoices("command", "command_name"),
        serialization_alias="command_name",
    )
    command_id: str = Field(min_length=1)
    trace_id: str = Field(min_length=1)
    agent_id: str = Field(min_length=1)
    lane_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    lease_id: str = Field(min_length=1)
    browser_target_id: str = Field(min_length=1)
    target: dict[str, Any] = Field(default_factory=dict)
    command_payload: dict[str, Any] = Field(default_factory=dict)
    reason: str = Field(min_length=1)
    deadline_at: datetime | None = None
    deadline_seconds: int = Field(default=600, ge=1, le=86_400)
    actor: dict[str, Any] | None = None
    parent_operation_id: str = ""
    retry_count: int = Field(default=0, ge=0)

    @property
    def command_name(self) -> str:
        return self.command


class C3Operation(_SubmitPolicyModel):
    operation_id: str = Field(min_length=1)
    command_id: str = Field(min_length=1)
    trace_id: str = Field(min_length=1)
    agent_id: str = Field(min_length=1)
    lane_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    lease_id: str = Field(min_length=1)
    browser_target_id: str = Field(min_length=1)
    command: str = Field(
        min_length=1,
        validation_alias=AliasChoices("command", "command_name"),
        serialization_alias="command_name",
    )
    state: OperationState
    created_at: datetime
    updated_at: datetime
    deadline_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    heartbeat_seq: int = Field(default=0, ge=0)
    progress_seq: int = Field(default=0, ge=0)
    last_heartbeat_at: datetime | None = None
    last_progress_at: datetime | None = None
    phase: str = ""
    substep: str = ""
    field: dict[str, Any] = Field(default_factory=dict)
    driver: str = ""
    cancel_requested_at: datetime | None = None
    cancel_acknowledged_at: datetime | None = None
    cancel_attempt_id: str = ""
    cancel_attempt_count: int = Field(default=0, ge=0)
    cancel_attempted_at: datetime | None = None
    cancel_pending_at: datetime | None = None
    cancel_failed_at: datetime | None = None
    cancel_retry_after: datetime | None = None
    cancellation_reason: str = ""
    terminal_reason: str = ""
    terminal_event_id: str = ""
    terminal_event_type: str = ""
    terminal_event_seq: int = Field(default=0, ge=0)
    result: Any = None
    error: Any = None
    monitor_error: Any = None
    diagnosis_id: str = ""
    artifact_ids: list[str] = Field(default_factory=list)
    target: dict[str, Any] = Field(default_factory=dict)
    command_payload: dict[str, Any] = Field(default_factory=dict)
    actor: dict[str, Any] = Field(default_factory=dict)
    reason: str = ""
    mutates_page: bool = False
    parent_operation_id: str = ""
    retry_count: int = Field(default=0, ge=0)

    @property
    def command_name(self) -> str:
        return self.command

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL_STATES


class OperationEvent(_OperationModel):
    seq: int = Field(ge=1)
    event_id: str = ""
    event_type: str = Field(min_length=1)
    operation_id: str = Field(min_length=1)
    command_id: str = Field(min_length=1)
    trace_id: str = ""
    agent_id: str = Field(min_length=1)
    lane_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    lease_id: str = Field(min_length=1)
    browser_target_id: str = Field(min_length=1)
    ts: datetime
    component: str = "c3"
    actor: dict[str, Any] = Field(default_factory=dict)
    payload: dict[str, Any] = Field(default_factory=dict)
    redaction: dict[str, Any] = Field(default_factory=dict)
    prev_hash: str = ""
    hash: str = ""


class C3OperationActionRequest(_OperationModel):
    agent_id: str = Field(min_length=1)
    lease_id: str = Field(min_length=1)
    reason: str = ""
    redispatch: bool = False


class C3OperationRetryRequest(_OperationModel):
    agent_id: str = Field(min_length=1)
    lease_id: str = Field(min_length=1)
    reason: str = ""
    command_id: str = ""
    trace_id: str = ""
    deadline_at: datetime | None = None
    deadline_seconds: int | None = Field(default=None, ge=1, le=86_400)


OperationRequest = C3OperationRequest
Operation = C3Operation
