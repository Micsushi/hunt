from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

TERMINAL_OPERATION_STATES = {"completed", "failed", "cancelled", "orphaned"}


@dataclass(frozen=True)
class C3WatchdogDecision:
    state: str
    reason_code: str
    actions: tuple[str, ...] = ()
    heartbeat_age_seconds: float = 0
    progress_age_seconds: float = 0


class C3WatchdogPolicy:
    def __init__(
        self,
        *,
        suspected_stall_seconds: float = 10,
        bundle_seconds: float = 20,
        stalled_seconds: float = 30,
        slow_progress_seconds: float = 45,
    ) -> None:
        self.suspected_stall_seconds = suspected_stall_seconds
        self.bundle_seconds = bundle_seconds
        self.stalled_seconds = stalled_seconds
        self.slow_progress_seconds = slow_progress_seconds

    def evaluate(
        self, operation: dict[str, Any] | Any, *, now: datetime | None = None
    ) -> C3WatchdogDecision:
        current_time = _utc(now or datetime.now(UTC))
        state = str(_value(operation, "state") or "running")
        if state in TERMINAL_OPERATION_STATES:
            return C3WatchdogDecision(state, "operation_terminal")

        heartbeat_at = _datetime(_value(operation, "last_heartbeat_at"))
        progress_at = _datetime(_value(operation, "last_progress_at"))
        deadline_at = _datetime(_value(operation, "deadline_at"))
        heartbeat_age = _age_seconds(current_time, heartbeat_at)
        progress_age = _age_seconds(current_time, progress_at)

        if deadline_at is not None and current_time >= deadline_at:
            if state == "queued":
                return C3WatchdogDecision(
                    "failed",
                    "operation_queue_deadline_exceeded",
                    ("fail_queued",),
                    heartbeat_age,
                    progress_age,
                )
            return C3WatchdogDecision(
                "stalled",
                "operation_deadline_exceeded",
                ("capture_failure_bundle", "request_cancel"),
                heartbeat_age,
                progress_age,
            )
        if state == "queued":
            return C3WatchdogDecision(state, "operation_queued")
        if heartbeat_age >= self.stalled_seconds:
            return C3WatchdogDecision(
                "stalled",
                "operation_heartbeat_missing",
                ("health_probe", "capture_failure_bundle", "request_cancel"),
                heartbeat_age,
                progress_age,
            )
        if heartbeat_age >= self.bundle_seconds:
            return C3WatchdogDecision(
                "suspected_stall",
                "operation_heartbeat_missing",
                ("health_probe", "capture_failure_bundle"),
                heartbeat_age,
                progress_age,
            )
        if heartbeat_age >= self.suspected_stall_seconds:
            return C3WatchdogDecision(
                "suspected_stall",
                "operation_heartbeat_missing",
                ("health_probe",),
                heartbeat_age,
                progress_age,
            )
        if progress_age >= self.slow_progress_seconds:
            return C3WatchdogDecision(
                "slow",
                "operation_semantic_progress_slow",
                ("capture_checkpoint",),
                heartbeat_age,
                progress_age,
            )
        return C3WatchdogDecision(
            "running",
            "operation_healthy",
            (),
            heartbeat_age,
            progress_age,
        )


def _value(operation: dict[str, Any] | Any, name: str) -> Any:
    if isinstance(operation, dict):
        return operation.get(name)
    return getattr(operation, name, None)


def _datetime(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return _utc(value)
    text = str(value).strip().replace("Z", "+00:00")
    try:
        return _utc(datetime.fromisoformat(text))
    except ValueError:
        return None


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _age_seconds(now: datetime, timestamp: datetime | None) -> float:
    if timestamp is None:
        return float("inf")
    return max(0.0, (now - timestamp).total_seconds())
