import threading
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from backend.c3_operation_monitor import C3OperationMonitor
from backend.c3_watchdog import C3WatchdogPolicy


class FakeStore:
    def __init__(self, operation):
        self.operation = operation
        self.events = []

    def get(self, operation_id):
        assert operation_id == self.operation.operation_id
        return self.operation

    def append(self, operation_id, event_type, payload):
        self.events.append((event_type, payload))
        state = payload.get("state")
        if event_type == "operation.heartbeat":
            self.operation.heartbeat_seq = max(
                self.operation.heartbeat_seq + 1, payload["heartbeat_seq"]
            )
            self.operation.last_heartbeat_at = datetime.now(UTC)
        if event_type == "operation.progress":
            self.operation.progress_seq = max(
                self.operation.progress_seq + 1, payload["progress_seq"]
            )
            self.operation.last_progress_at = datetime.now(UTC)
        if state:
            self.operation.state = state
        if event_type == "operation.cancel_acknowledged":
            self.operation.cancel_acknowledged_at = datetime.now(UTC)
        if event_type == "operation.cancelled":
            self.operation.state = "cancelled"
            self.operation.terminal_reason = payload["terminal_reason"]
        if event_type == "operation.failed":
            self.operation.state = "failed"
            self.operation.terminal_reason = payload["terminal_reason"]
            self.operation.error = payload.get("error")
        if event_type == "operation.orphaned":
            self.operation.state = "orphaned"
            self.operation.terminal_reason = payload["terminal_reason"]
            self.operation.error = payload["error"]
        if "artifact_ids" in payload:
            self.operation.artifact_ids = payload["artifact_ids"]
        return payload

    def append_if_nonterminal(self, operation_id, event_type, payload, *, expected_states=None):
        if self.operation.terminal:
            return None
        if expected_states is not None and self.operation.state not in expected_states:
            return None
        return self.append(operation_id, event_type, payload)


class FakeOperation:
    def __init__(self, **values):
        self.__dict__.update(values)

    @property
    def terminal(self):
        return self.state in {"completed", "failed", "cancelled", "orphaned"}


def _operation(**patch):
    now = datetime.now(UTC)
    values = {
        "operation_id": "op-1",
        "state": "running",
        "heartbeat_seq": 1,
        "progress_seq": 1,
        "last_heartbeat_at": now,
        "last_progress_at": now,
        "deadline_at": now + timedelta(minutes=2),
        "phase": "field_action",
        "cancel_requested_at": None,
        "cancel_acknowledged_at": None,
        "cancel_pending_at": None,
        "cancel_failed_at": None,
        "cancel_attempt_id": "cancel-1",
        "cancel_attempt_count": 1,
        "cancellation_reason": "watchdog_timeout",
        "artifact_ids": [],
    }
    values.update(patch)
    return FakeOperation(**values)


def test_monitor_records_independent_heartbeat_and_semantic_progress():
    operation = _operation()
    store = FakeStore(operation)
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {
            "operationId": "op-1",
            "heartbeatSeq": 3,
            "progressSeq": 2,
            "phase": "field_action",
            "substep": "wait_for_options",
            "fieldKey": "source",
            "fieldLabel": "How did you hear about us?",
        },
        artifact_capture=lambda *_args: "",
        cancel_request=lambda *_args: None,
    )

    monitor.poll_once("op-1")
    monitor.shutdown()

    assert [event for event, _ in store.events[:2]] == [
        "operation.heartbeat",
        "operation.progress",
    ]
    assert store.events[1][1]["field"]["key"] == "source"


def test_monitor_discards_progress_when_operation_finishes_during_probe():
    operation = _operation()
    store = FakeStore(operation)
    captures = []

    def finish_then_return_progress(_operation):
        operation.state = "failed"
        operation.terminal_reason = "extension_command_failed"
        return {
            "operationId": "op-1",
            "heartbeatSeq": 99,
            "progressSeq": 99,
            "phase": "stale_phase",
        }

    monitor = C3OperationMonitor(
        store,
        progress_probe=finish_then_return_progress,
        artifact_capture=lambda current, reason: (
            captures.append((current.operation_id, reason)) or "artifact-terminal-race"
        ),
        cancel_request=lambda *_args: None,
        interval_seconds=60,
    )
    monitor.track("op-1")

    current = monitor.poll_once("op-1")
    monitor.shutdown()

    assert current.terminal is True
    assert captures == [("op-1", "operation_failed")]
    assert [event for event, _ in store.events] == ["operation.artifact_captured"]
    assert operation.heartbeat_seq == 1
    assert operation.progress_seq == 1
    assert "op-1" not in monitor._tracked


def test_monitor_terminalizes_expired_queued_operation_without_cancel_dispatch():
    operation = _operation(
        state="queued",
        deadline_at=datetime.now(UTC) - timedelta(seconds=1),
        last_heartbeat_at=None,
        last_progress_at=None,
    )
    store = FakeStore(operation)
    cancels = []
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {},
        artifact_capture=lambda *_args: "artifact-queued-deadline",
        cancel_request=lambda *args: cancels.append(args),
        interval_seconds=60,
    )

    current = monitor.poll_once("op-1")
    monitor.shutdown()

    assert current.state == "failed"
    assert current.terminal_reason == "operation_queue_deadline_exceeded"
    assert cancels == []
    assert [event for event, _payload in store.events][0] == "operation.failed"


def test_monitor_discards_health_when_operation_finishes_during_probe():
    now = datetime.now(UTC)
    operation = _operation(
        last_heartbeat_at=now - timedelta(seconds=11),
        last_progress_at=now - timedelta(seconds=11),
    )
    store = FakeStore(operation)
    captures = []

    def finish_then_return_health(_operation):
        operation.state = "failed"
        operation.terminal_reason = "extension_command_failed"
        return {"reachable": False}

    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {},
        health_probe=finish_then_return_health,
        artifact_capture=lambda current, reason: (
            captures.append((current.operation_id, reason)) or "artifact-health-race"
        ),
        cancel_request=lambda *_args: None,
        interval_seconds=60,
    )
    monitor.track("op-1")

    current = monitor.poll_once("op-1")
    monitor.shutdown()

    assert current.terminal is True
    assert captures == [("op-1", "operation_failed")]
    assert "operation.health_probe_completed" not in [event for event, _ in store.events]
    assert "op-1" not in monitor._tracked


def test_monitor_stops_semantic_progress_when_heartbeat_races_with_terminal_state():
    operation = _operation()

    class TerminalAfterHeartbeatStore(FakeStore):
        def append(self, operation_id, event_type, payload):
            result = super().append(operation_id, event_type, payload)
            if event_type == "operation.heartbeat":
                self.operation.state = "failed"
                self.operation.terminal_reason = "extension_command_failed"
            return result

    store = TerminalAfterHeartbeatStore(operation)
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {
            "operationId": "op-1",
            "heartbeatSeq": 2,
            "progressSeq": 2,
            "phase": "stale_phase",
        },
        artifact_capture=lambda *_args: "",
        cancel_request=lambda *_args: None,
        interval_seconds=60,
    )
    monitor.track("op-1")

    monitor.poll_once("op-1")
    monitor.shutdown()

    assert [event for event, _ in store.events] == ["operation.heartbeat"]
    assert operation.progress_seq == 1
    assert "op-1" not in monitor._tracked


def test_monitor_watchdog_transition_loses_race_without_monitor_failure():
    now = datetime.now(UTC)
    operation = _operation(
        last_heartbeat_at=now - timedelta(seconds=11),
        last_progress_at=now - timedelta(seconds=11),
    )

    class TerminalDuringConditionalStore(FakeStore):
        def append_if_nonterminal(self, operation_id, event_type, payload, *, expected_states=None):
            if event_type == "operation.suspected_stall":
                self.operation.state = "failed"
                self.operation.terminal_reason = "extension_command_failed"
            return super().append_if_nonterminal(
                operation_id,
                event_type,
                payload,
                expected_states=expected_states,
            )

        def append(self, operation_id, event_type, payload):
            if event_type == "operation.suspected_stall":
                self.operation.state = "failed"
                self.operation.terminal_reason = "extension_command_failed"
                raise RuntimeError("terminal transition won watchdog race")
            return super().append(operation_id, event_type, payload)

    store = TerminalDuringConditionalStore(operation)
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {},
        health_probe=lambda _operation: {},
        artifact_capture=lambda *_args: "",
        cancel_request=lambda *_args: None,
        interval_seconds=60,
    )
    monitor.track("op-1")

    terminal = monitor._poll_tracked("op-1")
    monitor.shutdown()

    assert terminal is True
    assert store.events == []
    assert "op-1" not in monitor._tracked


def test_monitor_captures_once_and_requests_cancel_at_stall_boundary():
    now = datetime.now(UTC)
    operation = _operation(
        last_heartbeat_at=now - timedelta(seconds=31),
        last_progress_at=now - timedelta(seconds=31),
    )
    store = FakeStore(operation)
    captures = []
    cancels = []
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {},
        artifact_capture=lambda operation, reason: captures.append(reason) or "artifact-1",
        cancel_request=lambda operation_id, reason: cancels.append((operation_id, reason)),
        watchdog=C3WatchdogPolicy(),
    )

    monitor.poll_once("op-1")
    monitor.poll_once("op-1")
    monitor.shutdown()

    assert captures == ["operation_heartbeat_missing"]
    assert cancels[0] == ("op-1", "operation_heartbeat_missing")
    assert operation.artifact_ids == ["artifact-1"]


def test_monitor_waits_for_extension_unwind_before_cancel_terminal():
    operation = _operation(state="cancelling")
    store = FakeStore(operation)
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {
            "operationId": "op-1",
            "heartbeatSeq": 2,
            "progressSeq": 1,
            "cancelAcknowledgedAt": 1234,
        },
        artifact_capture=lambda *_args: "",
        cancel_request=lambda *_args: None,
    )

    monitor.poll_once("op-1")
    monitor.shutdown()

    assert [event for event, _ in store.events][-2:] == [
        "operation.cancel_acknowledged",
        "operation.cancelled",
    ]
    assert operation.terminal_reason == "watchdog_timeout"


def test_monitor_ignores_progress_from_superseding_operation():
    operation = _operation()
    store = FakeStore(operation)
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {
            "operationId": "op-new",
            "heartbeatSeq": 99,
            "progressSeq": 99,
        },
        artifact_capture=lambda *_args: "",
        cancel_request=lambda *_args: None,
    )

    monitor.poll_once("op-1")
    monitor.shutdown()

    assert store.events[0] == (
        "operation.stale_progress_ignored",
        {"reported_operation_id": "op-new"},
    )
    assert operation.heartbeat_seq == 1


def test_monitor_detects_cancel_request_that_never_unwinds():
    operation = _operation(
        state="cancelling",
        cancel_pending_at=datetime.now(UTC) - timedelta(seconds=11),
    )
    store = FakeStore(operation)
    captures = []
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {"operationId": "op-1"},
        artifact_capture=lambda _operation, reason: captures.append(reason) or "artifact-cancel",
        cancel_request=lambda *_args: None,
        cancel_ack_timeout_seconds=10,
    )

    monitor.poll_once("op-1")
    monitor.shutdown()

    assert "operation.cancel_failed" in [event for event, _ in store.events]
    assert captures == ["cancel_acknowledgement_timeout"]


def test_monitor_enforces_queued_deadline_without_invalid_stalled_transition():
    now = datetime.now(UTC)
    operation = _operation(
        state="queued",
        last_heartbeat_at=None,
        last_progress_at=None,
        deadline_at=now - timedelta(seconds=1),
    )
    store = FakeStore(operation)
    captures = []
    cancellations = []
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {},
        artifact_capture=lambda current, reason: (
            captures.append((current.operation_id, reason)) or "artifact-queued-deadline"
        ),
        cancel_request=lambda operation_id, reason: cancellations.append((operation_id, reason)),
        interval_seconds=60,
    )

    monitor.poll_once(operation.operation_id)
    monitor.shutdown()

    assert "operation.stalled" not in [event for event, _ in store.events]
    assert operation.state == "failed"
    assert operation.terminal_reason == "operation_queue_deadline_exceeded"
    assert captures == [("op-1", "operation_failed")]
    assert cancellations == []


def test_monitor_orphans_cancel_failure_after_bounded_reconciliation_window():
    operation = _operation(
        state="cancelling",
        cancel_failed_at=datetime.now(UTC) - timedelta(seconds=6),
        monitor_error={"reason_code": "cancel_bridge_timeout"},
    )
    store = FakeStore(operation)
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {"operationId": "op-1"},
        artifact_capture=lambda *_args: "artifact-cancel",
        cancel_request=lambda *_args: None,
        cancel_reconcile_timeout_seconds=5,
    )
    monitor.track("op-1")

    terminal = monitor.poll_once("op-1")
    monitor.shutdown()

    assert terminal.state == "orphaned"
    assert terminal.terminal_reason == "control_plane_cancel_unreconciled"
    assert terminal.error == {"reason_code": "control_plane_cancel_unreconciled"}
    assert "operation.orphaned" in [event for event, _ in store.events]
    assert "op-1" not in monitor._tracked


def test_cancel_reconciliation_deadline_does_not_slide_after_redispatch_failure():
    operation = _operation(
        state="cancelling",
        cancel_requested_at=datetime.now(UTC) - timedelta(seconds=31),
        cancel_failed_at=datetime.now(UTC),
        cancel_attempt_count=7,
        monitor_error={"reason_code": "cancel_bridge_timeout"},
    )
    store = FakeStore(operation)
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {"operationId": "op-1"},
        artifact_capture=lambda *_args: "artifact-cancel",
        cancel_request=lambda *_args: None,
        cancel_reconcile_timeout_seconds=30,
    )

    terminal = monitor.poll_once("op-1")
    monitor.shutdown()

    assert terminal.state == "orphaned"
    assert terminal.error == {"reason_code": "control_plane_cancel_unreconciled"}


def test_monitor_evaluates_watchdog_when_progress_probe_hangs():
    blocker = threading.Event()
    operation = _operation(
        last_heartbeat_at=datetime.now(UTC) - timedelta(seconds=31),
        last_progress_at=datetime.now(UTC) - timedelta(seconds=31),
    )
    store = FakeStore(operation)
    cancels = []
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: blocker.wait(60) or {},
        artifact_capture=lambda *_args: "artifact-hung",
        cancel_request=lambda operation_id, reason: cancels.append((operation_id, reason)),
        probe_timeout_seconds=0.02,
    )

    started = time.monotonic()
    monitor.poll_once("op-1")
    elapsed = time.monotonic() - started
    monitor.shutdown(wait=False)
    blocker.set()

    assert elapsed < 0.25
    assert cancels == [("op-1", "operation_heartbeat_missing")]
    assert "operation.health_probe_failed" in [event for event, _ in store.events]


def test_monitor_globally_bounds_hung_probe_admission():
    blocker = threading.Event()
    started = []
    started_lock = threading.Lock()

    def hang(operation):
        with started_lock:
            started.append(operation.operation_id)
        blocker.wait(60)
        return {}

    monitor = C3OperationMonitor(
        None,
        progress_probe=hang,
        artifact_capture=lambda *_args: "",
        cancel_request=lambda *_args: None,
        probe_timeout_seconds=0.01,
        probe_workers=2,
        interval_seconds=60,
    )

    try:
        for index in range(20):
            monitor._bounded_progress_probe(SimpleNamespace(operation_id=f"op-{index}"))

        assert len(started) == 2
        assert len(monitor._pending_probes) == 2
        blocker.set()
        time.sleep(0.05)
        assert monitor._pending_probes == {}
    finally:
        blocker.set()
        monitor.shutdown(wait=False)


def test_monitor_captures_terminal_failure_and_cancel_bridge_failure():
    failed = _operation(state="failed", terminal_reason="extension_command_failed")
    failed_store = FakeStore(failed)
    captures = []
    failed_monitor = C3OperationMonitor(
        failed_store,
        progress_probe=lambda _operation: {},
        artifact_capture=lambda _operation, reason: captures.append(reason) or "artifact-failed",
        cancel_request=lambda *_args: None,
    )
    failed_monitor.poll_once("op-1")
    failed_monitor.shutdown()

    cancelling = _operation(
        state="cancelling",
        cancel_failed_at=datetime.now(UTC),
        error={"reason_code": "cancel_bridge_timeout"},
    )
    cancelling_store = FakeStore(cancelling)
    cancel_monitor = C3OperationMonitor(
        cancelling_store,
        progress_probe=lambda _operation: {},
        artifact_capture=lambda _operation, reason: (
            captures.append(reason) or "artifact-cancel-failed"
        ),
        cancel_request=lambda *_args: None,
    )
    cancel_monitor.poll_once("op-1")
    cancel_monitor.shutdown()

    assert captures == ["operation_failed", "cancel_bridge_timeout"]


def test_monitor_rate_limits_slow_checkpoints():
    operation = _operation(
        state="slow",
        last_progress_at=datetime.now(UTC) - timedelta(seconds=50),
    )
    store = FakeStore(operation)
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {},
        artifact_capture=lambda *_args: "",
        cancel_request=lambda *_args: None,
        checkpoint_cooldown_seconds=60,
    )

    monitor.poll_once("op-1")
    monitor.poll_once("op-1")
    monitor.shutdown()

    assert [event for event, _ in store.events].count("operation.checkpoint") == 1


def test_monitor_runs_independent_health_probe_at_suspected_stall():
    operation = _operation(
        last_heartbeat_at=datetime.now(UTC) - timedelta(seconds=11),
        last_progress_at=datetime.now(UTC) - timedelta(seconds=11),
    )
    store = FakeStore(operation)
    probes = []
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {},
        health_probe=lambda current: probes.append(current.operation_id) or {"reachable": True},
        artifact_capture=lambda *_args: "",
        cancel_request=lambda *_args: None,
    )

    monitor.poll_once("op-1")
    monitor.shutdown()

    assert probes == ["op-1"]
    assert "operation.health_probe_completed" in [event for event, _ in store.events]


def test_failure_bundle_capture_is_bounded_when_diagnostics_hang():
    blocker = threading.Event()
    operation = _operation(
        last_heartbeat_at=datetime.now(UTC) - timedelta(seconds=21),
        last_progress_at=datetime.now(UTC) - timedelta(seconds=21),
    )
    store = FakeStore(operation)
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {},
        artifact_capture=lambda *_args: blocker.wait(60) and "artifact-late",
        cancel_request=lambda *_args: None,
        artifact_timeout_seconds=0.02,
    )

    started = time.monotonic()
    monitor.poll_once("op-1")
    elapsed = time.monotonic() - started
    monitor.shutdown(wait=False)

    assert elapsed < 0.25
    failures = [
        payload for event, payload in store.events if event == "operation.artifact_capture_failed"
    ]
    assert failures[-1]["error"]["message"] == "artifact_capture_timeout"
    blocker.set()
    time.sleep(0.05)
    assert "operation.artifact_captured" in [event for event, _ in store.events]
    assert operation.artifact_ids == ["artifact-late"]


def test_artifact_timeout_cannot_race_with_late_success_commit():
    blocker = threading.Event()
    operation = _operation()
    store = FakeStore(operation)
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {},
        artifact_capture=lambda *_args: blocker.wait(2) and "artifact-race",
        cancel_request=lambda *_args: None,
        artifact_timeout_seconds=0.02,
        interval_seconds=60,
    )

    monitor._capture_once(operation, "failed")
    blocker.set()
    time.sleep(0.05)
    monitor.shutdown(wait=False)

    event_types = [event for event, _ in store.events]
    assert event_types.count("operation.artifact_capture_failed") == 1
    assert event_types.count("operation.artifact_captured") == 1


def test_partial_artifact_result_is_linked_and_keeps_partial_status_event():
    operation = _operation(state="failed", terminal_reason="failed")
    store = FakeStore(operation)
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {},
        artifact_capture=lambda *_args: {
            "artifact_id": "artifact-partial",
            "artifact_status": "partial",
        },
        artifact_validator=lambda *_args: True,
        cancel_request=lambda *_args: None,
    )

    monitor._capture_once(operation, "failed")
    monitor.shutdown()

    event_types = [event for event, _ in store.events]
    assert "operation.artifact_captured" in event_types
    assert event_types[-1] == "operation.artifact_capture_partial"
    assert operation.artifact_ids == ["artifact-partial"]


def test_late_artifact_is_validated_and_does_not_change_terminal_cause():
    blocker = threading.Event()
    operation = _operation(
        state="failed",
        terminal_reason="extension_command_failed",
        error={"reason_code": "ui_commit_failed"},
    )
    store = FakeStore(operation)
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {},
        artifact_capture=lambda *_args: blocker.wait(2) and "artifact-late",
        artifact_validator=lambda _operation, artifact_id: artifact_id == "artifact-late",
        cancel_request=lambda *_args: None,
        artifact_timeout_seconds=0.02,
    )

    monitor._capture_once(operation, "ui_commit_failed")
    blocker.set()
    deadline = time.monotonic() + 1
    while "artifact-late" not in operation.artifact_ids and time.monotonic() < deadline:
        time.sleep(0.01)
    monitor.shutdown()

    assert operation.artifact_ids == ["artifact-late"]
    assert operation.state == "failed"
    assert operation.terminal_reason == "extension_command_failed"
    assert operation.error == {"reason_code": "ui_commit_failed"}


def test_invalid_late_artifact_is_not_linked():
    blocker = threading.Event()
    operation = _operation(state="failed", terminal_reason="failed")
    store = FakeStore(operation)
    monitor = C3OperationMonitor(
        store,
        progress_probe=lambda _operation: {},
        artifact_capture=lambda *_args: blocker.wait(2) and "artifact-invalid",
        artifact_validator=lambda *_args: False,
        cancel_request=lambda *_args: None,
        artifact_timeout_seconds=0.02,
    )

    monitor._capture_once(operation, "failed")
    blocker.set()
    time.sleep(0.05)
    monitor.shutdown()

    assert operation.artifact_ids == []
    failures = [
        payload for event, payload in store.events if event == "operation.artifact_capture_failed"
    ]
    assert any(
        payload.get("error", {}).get("message") == "artifact_manifest_invalid"
        for payload in failures
    )
