import hashlib
import threading
import time
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from tools.c3_agent_testing.classifier import classify_operation
from tools.c3_agent_testing.planner import plan_lanes, read_job_csv
from tools.c3_agent_testing.runner import (
    C3BatchSupervisor,
    ResumeOperationIdentityError,
    _artifact_paths,
    _is_cancel_backoff_active,
    _validate_lanes,
    _validate_operation_identity,
)
from tools.hunt_mcp.client import HuntBackendError


class FakeMcpClient:
    def __init__(self, states: dict[str, str], calls: list[tuple], lock: threading.Lock):
        self.states = states
        self.calls = calls
        self.lock = lock
        self.wait_count: dict[str, int] = {}
        self.closed = 0

    def _call(self, name: str, payload: dict):
        with self.lock:
            self.calls.append((name, payload.get("session_id"), payload.copy()))

    def bootstrap_lane(self, payload: dict):
        self._call("bootstrap", payload)
        return {"lease": {"lease": {"lease_id": f"lease_{payload['session_id']}"}}}

    def page_walk(self, payload: dict):
        self._call("start", payload)
        return {"operation_id": f"op_{payload['session_id']}"}

    def heartbeat_lease(self, payload: dict):
        self._call("heartbeat", payload)
        return {"ok": True}

    def wait_for_operation_event(self, payload: dict):
        operation_id = payload["operation_id"]
        session_id = operation_id.removeprefix("op_")
        self._call("wait", {**payload, "session_id": session_id})
        self.wait_count[session_id] = self.wait_count.get(session_id, 0) + 1
        if self.states[session_id] == "stalled":
            time.sleep(0.03)
        return {
            "operation": {
                "operation_id": operation_id,
                "session_id": session_id,
                "state": self.states[session_id],
                "terminal_reason": "fixture",
                "result": {"review_ready": True} if self.states[session_id] == "completed" else {},
            },
            "events": [],
            "terminal": True,
            "timed_out": False,
        }

    def get_c3_operation(self, payload: dict):
        operation_id = payload["operation_id"]
        session_id = operation_id.removeprefix("op_")
        return {
            "operation_id": operation_id,
            "session_id": session_id,
            "state": self.states[session_id],
            "terminal_reason": "fixture",
            "result": {"review_ready": True} if self.states[session_id] == "completed" else {},
        }

    def get_session_log(self, payload: dict):
        self._call("session_log", payload)
        return {"found": False, "events": []}

    def get_c3_failure_context(self, payload: dict):
        self._call(
            "failure_context",
            {**payload, "session_id": payload["operation_id"].removeprefix("op_")},
        )
        return {
            "failure_context": {
                "diagnosis_id": f"diagnosis-{payload['operation_id']}",
                "operation_id": payload["operation_id"],
                "failure_scope": "field",
                "root_cause_code": "ui_commit_failed",
                "summary": "The selected value did not commit.",
                "causal_element": {
                    "selector": "button[data-automation-id='sourcePrompt']",
                    "label": "How did you hear about us?",
                },
                "last_touched_element": {"selector": "button#next", "label": "Next"},
                "expected_state": "Selected value is committed.",
                "observed_state": "Value remained empty.",
                "confidence": "proven",
                "root_cause_unknown": False,
                "evidence_event_ids": ["evt-cause"],
                "checkpoint_ids": ["checkpoint-cause"],
                "artifact_ids": ["artifact-cause"],
                "artifact_status": "completed",
                "source_event_sequence": 42,
                "evidence_truncated": False,
                "validation_messages": ["Source is required."],
                "credential_preparation": [
                    {
                        "source": "profile:accountPassword",
                        "selector": "input[type='password']",
                        "ok": True,
                        "changed": True,
                    }
                ],
                "missing_evidence": [],
                "live_inspection_required": False,
                "next_safe_action": "fix_source_commit_driver",
            }
        }

    def close(self):
        self.closed += 1

    def cancel_c3_operation(self, payload: dict):
        self._call(
            "cancel",
            {**payload, "session_id": payload["operation_id"].removeprefix("op_")},
        )
        return {
            "operation": {
                "operation_id": payload["operation_id"],
                "state": "cancelled",
                "terminal_reason": "fixture_cancelled",
            }
        }

    def finish_lane(self, payload: dict):
        self._call("finish", payload)
        return {"ok": True}

    def fail_lane(self, payload: dict):
        self._call("fail", payload)
        return {"ok": True}


def _exact_runtime(lane):
    return {
        "extension_id": "abcdefghijklmnopabcdefghijklmnop",
        "tab_id": lane.index,
        "target_id": f"target-{lane.index}",
        "debug_port": lane.port,
        "resolved_url": lane.job.url,
    }


def test_classifier_uses_stable_failure_taxonomy():
    assert (
        classify_operation({"state": "completed", "result": {"review_ready": True}})
        == "review_ready"
    )
    assert classify_operation({"state": "stalled"}) == "operation_stalled"
    assert (
        classify_operation({"state": "failed", "terminal_reason": "auth_no_captcha_gate"})
        == "site_auth_gate"
    )
    assert classify_operation({"state": "failed", "terminal_reason": "http_410"}) == "job_expired"
    assert (
        classify_operation({"state": "failed", "terminal_reason": "cdp_connect_failed"})
        == "bridge_unreachable"
    )


def test_classifier_recognizes_nested_page_walk_review_evidence_only():
    assert (
        classify_operation(
            {
                "state": "completed",
                "terminal_reason": "browser_execution_completed",
                "result": {
                    "pageWalk": {
                        "stoppedReason": "final_submit_visible",
                        "pageKind": "review",
                        "hasSubmit": True,
                    }
                },
            }
        )
        == "review_ready"
    )
    assert classify_operation({"state": "completed", "result": {}}) == "fill_failed"


def test_supervisor_runs_five_isolated_lanes_without_stall_blocking_others():
    jobs = read_job_csv(Path("wd_test_jobs.csv"))[:5]
    lanes = plan_lanes(
        jobs,
        batch_id="runner-test",
        ports=range(9811, 9816),
        artifact_root=Path("logs/runner-test"),
    )
    states = {lane.session_id: "completed" for lane in lanes}
    states[lanes[1].session_id] = "stalled"
    calls: list[tuple] = []
    lock = threading.Lock()
    shared = FakeMcpClient(states, calls, lock)
    supervisor = C3BatchSupervisor(
        client_factory=lambda: shared,
        prepare_lane=_exact_runtime,
    )

    report = supervisor.run(lanes, max_concurrency=5)

    assert len(report.lanes) == 5
    assert {item.agent_id for item in report.lanes} == {lane.agent_id for lane in lanes}
    assert {item.classification for item in report.lanes} == {
        "review_ready",
        "operation_stalled",
    }
    stalled = next(item for item in report.lanes if item.classification == "operation_stalled")
    assert stalled.cancel_requested is True
    assert all(item.submit_activated is False for item in report.lanes)
    assert len({item.session_id for item in report.lanes}) == 5
    assert sum(1 for name, _, _ in calls if name == "bootstrap") == 5
    assert sum(1 for name, _, _ in calls if name == "start") == 5
    assert sum(1 for name, _, _ in calls if name == "finish") == 4
    assert sum(1 for name, _, _ in calls if name == "fail") == 1
    assert all(item.failure_context_status == "available" for item in report.lanes)
    assert all(item.root_cause_code == "ui_commit_failed" for item in report.lanes)
    assert all(item.causal_label == "How did you hear about us?" for item in report.lanes)
    assert all(item.live_inspection_required is False for item in report.lanes)
    assert all(item.failure_artifact_status == "completed" for item in report.lanes)
    assert all(item.failure_source_event_sequence == 42 for item in report.lanes)
    assert all(
        item.credential_preparation
        == (
            {
                "source": "profile:accountPassword",
                "selector": "input[type='password']",
                "ok": True,
                "changed": True,
            },
        )
        for item in report.lanes
    )
    assert all(item.failure_evidence_truncated is False for item in report.lanes)
    assert sum(1 for name, _, _ in calls if name == "failure_context") == 5
    assert sum(1 for name, _, _ in calls if name == "cancel") == 1
    assert sum(1 for name, _, _ in calls if name == "heartbeat") == 0
    assert shared.closed == 5
    start_payloads = [payload for name, _, payload in calls if name == "start"]
    assert all(payload["browser_target_id"] == payload["session_id"] for payload in start_payloads)
    assert all(payload["target"]["tab_id"] for payload in start_payloads)
    assert all(payload["target"]["url"] for payload in start_payloads)
    assert all(payload["command_payload"] == {"pageWalk": True} for payload in start_payloads)
    wait_payloads = [payload for name, _, payload in calls if name == "wait"]
    assert all(payload["agent_id"] and payload["lease_id"] for payload in wait_payloads)


def test_supervisor_rejects_duplicate_session_or_target_before_mutation():
    jobs = read_job_csv(Path("wd_test_jobs.csv"))[:2]
    lanes = plan_lanes(
        jobs,
        batch_id="duplicate-test",
        ports=[9821, 9822],
        artifact_root=Path("logs/duplicate-test"),
    )
    lanes[1] = replace(
        lanes[1],
        session_id=lanes[0].session_id,
        browser_target_id=lanes[0].browser_target_id,
    )
    calls: list[tuple] = []
    supervisor = C3BatchSupervisor(
        client_factory=lambda: FakeMcpClient({}, calls, threading.Lock()),
        prepare_lane=lambda lane: {},
    )

    try:
        supervisor.run(lanes, max_concurrency=2)
    except ValueError as error:
        assert str(error) == "duplicate_lane_identity"
    else:
        raise AssertionError("duplicate lane identity was accepted")

    assert calls == []


def test_supervisor_bootstrap_pins_runtime_tab_and_resolved_url():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="runtime-target-test",
        ports=[9820],
        artifact_root=Path("logs/runtime-target-test"),
    )[0]
    calls: list[tuple] = []
    lock = threading.Lock()
    client = FakeMcpClient({lane.session_id: "completed"}, calls, lock)
    resolved_url = "https://runtime.example/jobs/redirected/apply"

    C3BatchSupervisor(
        client_factory=lambda: client,
        prepare_lane=lambda _lane: {
            "extension_id": "abcdefghijklmnopabcdefghijklmnop",
            "debug_port": lane.port,
            "tab_id": 712,
            "target_id": "target-712",
            "resolved_url": resolved_url,
        },
    ).run([lane], max_concurrency=1)

    bootstrap = next(payload for name, _, payload in calls if name == "bootstrap")
    assert bootstrap["tab_id"] == 712
    assert bootstrap["metadata"]["target_id"] == "target-712"
    assert bootstrap["job_url"] == resolved_url
    assert bootstrap["metadata"]["planned_job_url"] == lane.job.url


def test_supervisor_bootstrap_sends_exact_target_id_at_top_level_for_hardened_client():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="bootstrap-target-pin",
        ports=[9821],
        artifact_root=Path("logs/bootstrap-target-pin"),
    )[0]
    calls: list[tuple] = []

    class ExactTargetClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "completed"}, calls, threading.Lock())

        def bootstrap_lane(self, payload):
            assert payload["target_id"] == "target-1"
            assert payload["metadata"]["target_id"] == payload["target_id"]
            return super().bootstrap_lane(payload)

    result = (
        C3BatchSupervisor(
            client_factory=ExactTargetClient,
            prepare_lane=_exact_runtime,
        )
        .run([lane], max_concurrency=1)
        .lanes[0]
    )

    assert result.operation_state == "completed"


def test_bootstrap_failure_before_operation_reports_missing_control_plane_evidence():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="bootstrap-evidence",
        ports=[9822],
        artifact_root=Path("logs/bootstrap-evidence"),
    )[0]

    class BootstrapRaisesClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "running"}, [], threading.Lock())

        def bootstrap_lane(self, payload):
            assert payload["target_id"] == "target-1"
            raise RuntimeError("bootstrap transport failed")

    result = (
        C3BatchSupervisor(
            client_factory=BootstrapRaisesClient,
            prepare_lane=_exact_runtime,
        )
        .run([lane], max_concurrency=1)
        .lanes[0]
    )

    assert result.operation_id == ""
    assert result.root_cause_unknown is True
    assert result.live_inspection_required is True
    assert result.missing_evidence == (
        "operation_not_started",
        "control_plane_bootstrap",
    )


@pytest.mark.parametrize(
    "runtime, expected_error",
    [
        (
            {
                "extension_id": "abcdefghijklmnopabcdefghijklmnop",
                "debug_port": 9820,
                "resolved_url": "https://runtime.example/jobs/apply",
            },
            "runtime_tab_id_required",
        ),
        (
            {
                "extension_id": "abcdefghijklmnopabcdefghijklmnop",
                "debug_port": 9820,
                "tab_id": 712,
            },
            "runtime_resolved_url_required",
        ),
        (
            {
                "extension_id": "abcdefghijklmnopabcdefghijklmnop",
                "debug_port": 9999,
                "tab_id": 712,
                "resolved_url": "https://runtime.example/jobs/apply",
            },
            "runtime_debug_port_mismatch",
        ),
        (
            {
                "extension_id": "abcdefghijklmnopabcdefghijklmnop",
                "debug_port": 9820,
                "tab_id": 712,
                "resolved_url": "about:blank",
            },
            "runtime_resolved_url_required",
        ),
    ],
)
def test_supervisor_fails_closed_when_exact_runtime_target_is_incomplete(
    runtime: dict, expected_error: str
):
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="runtime-target-required",
        ports=[9820],
        artifact_root=Path("logs/runtime-target-required"),
    )[0]
    calls: list[tuple] = []
    report = C3BatchSupervisor(
        client_factory=lambda: FakeMcpClient(
            {lane.session_id: "completed"}, calls, threading.Lock()
        ),
        prepare_lane=lambda _lane: runtime,
    ).run([lane], max_concurrency=1)

    assert expected_error in report.lanes[0].error
    assert not [call for call in calls if call[0] == "bootstrap"]


def test_supervisor_rejects_every_shared_lane_identity_or_storage_location():
    lanes = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:2],
        batch_id="all-identity-test",
        ports=[9823, 9824],
        artifact_root=Path("logs/all-identity-test"),
    )

    for field in (
        "index",
        "port",
        "profile",
        "agent_id",
        "lane_id",
        "session_id",
        "browser_target_id",
        "artifact_dir",
    ):
        duplicate = [lanes[0], replace(lanes[1], **{field: getattr(lanes[0], field)})]
        try:
            _validate_lanes(duplicate)
        except ValueError as error:
            assert str(error) == "duplicate_lane_identity"
        else:
            raise AssertionError(f"duplicate {field} was accepted")

    mixed_batch = [lanes[0], replace(lanes[1], batch_id="other-batch")]
    try:
        _validate_lanes(mixed_batch)
    except ValueError as error:
        assert str(error) == "mixed_batch_identity"
    else:
        raise AssertionError("mixed batch ids were accepted")


def test_supervisor_rejects_empty_browser_target_identity_before_mutation():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="empty-target-test",
        ports=[9825],
        artifact_root=Path("logs/empty-target-test"),
    )[0]

    with pytest.raises(ValueError, match="lane_identity_required"):
        _validate_lanes([replace(lane, browser_target_id="")])


def test_supervisor_waits_for_cancel_ack_and_redispatches_failed_attempt():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="cancel-ack-test",
        ports=[9831],
        artifact_root=Path("logs/cancel-ack-test"),
    )[0]
    calls: list[tuple] = []
    lock = threading.Lock()

    class CancelAckClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "stalled"}, calls, lock)
            self.cancel_state = ""

        def cancel_c3_operation(self, payload):
            self._call("cancel", {**payload, "session_id": lane.session_id})
            self.cancel_state = "cancelled" if payload.get("redispatch") else "failed"
            return {
                "operation": {
                    "operation_id": f"op_{lane.session_id}",
                    "state": "cancelling",
                }
            }

        def wait_for_operation_event(self, payload):
            operation = {
                "operation_id": f"op_{lane.session_id}",
                "state": "cancelling",
            }
            events = []
            if self.cancel_state == "failed":
                operation["cancel_failed_at"] = "2026-01-01T00:00:00Z"
                events = [{"seq": 1, "event_id": "evt-cancel-failed"}]
            if self.cancel_state == "cancelled":
                operation.update(state="cancelled", terminal_reason="watchdog_timeout")
                events = [{"seq": 2, "event_id": "evt-cancel-ack"}]
            return {"operation": operation, "events": events}

    clock_value = 0.0

    def clock():
        nonlocal clock_value
        clock_value += 0.1
        return clock_value

    client = CancelAckClient()
    supervisor = C3BatchSupervisor(
        client_factory=lambda: client,
        prepare_lane=_exact_runtime,
        now=clock,
    )

    report = supervisor.run([lane], max_concurrency=1)

    cancel_payloads = [payload for name, _, payload in calls if name == "cancel"]
    assert len(cancel_payloads) == 2
    assert cancel_payloads[1]["redispatch"] is True
    assert report.lanes[0].operation_state == "cancelled"
    assert report.lanes[0].event_ids == ("evt-cancel-failed", "evt-cancel-ack")


def test_supervisor_waits_for_cancel_retry_after_before_redispatch():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="cancel-backoff-test",
        ports=[9835],
        artifact_root=Path("logs/cancel-backoff-test"),
    )[0]
    calls: list[tuple] = []
    lock = threading.Lock()
    base_time = datetime(2026, 1, 1, tzinfo=UTC)
    clock_value = 0.0
    retry_after = base_time + timedelta(seconds=2)
    redispatch_times: list[datetime] = []

    def clock():
        nonlocal clock_value
        clock_value += 0.1
        return clock_value

    def wall_now():
        return base_time + timedelta(seconds=clock_value)

    class BackoffClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "stalled"}, calls, lock)
            self.cancel_state = ""

        def cancel_c3_operation(self, payload):
            self._call("cancel", {**payload, "session_id": lane.session_id})
            if payload.get("redispatch"):
                redispatch_times.append(wall_now())
                if wall_now() < retry_after:
                    raise HuntBackendError(409, {"reason_code": "cancel_backoff_active"})
                if len(redispatch_times) == 1:
                    raise HuntBackendError(409, {"reason_code": "cancel_backoff_active"})
                self.cancel_state = "cancelled"
            else:
                self.cancel_state = "failed"
            return {
                "operation": {
                    "operation_id": f"op_{lane.session_id}",
                    "state": "cancelling",
                }
            }

        def wait_for_operation_event(self, payload):
            operation = {
                "operation_id": f"op_{lane.session_id}",
                "state": "cancelling",
            }
            if self.cancel_state == "failed":
                operation.update(
                    cancel_failed_at="2026-01-01T00:00:00Z",
                    cancel_retry_after=retry_after.isoformat().replace("+00:00", "Z"),
                )
            elif self.cancel_state == "cancelled":
                operation.update(state="cancelled", terminal_reason="watchdog_timeout")
            return {"operation": operation, "events": []}

    client = BackoffClient()
    report = C3BatchSupervisor(
        client_factory=lambda: client,
        prepare_lane=_exact_runtime,
        now=clock,
        wall_now=wall_now,
    ).run([lane], max_concurrency=1)

    cancel_payloads = [payload for name, _, payload in calls if name == "cancel"]
    assert len(cancel_payloads) == 3
    assert cancel_payloads[1]["redispatch"] is True
    assert cancel_payloads[2]["redispatch"] is True
    assert min(redispatch_times) >= retry_after
    assert report.lanes[0].operation_state == "cancelled"
    assert report.lanes[0].terminal_reason != "batch_lane_exception"
    assert report.lanes[0].error == ""


@pytest.mark.parametrize(
    "error",
    [
        HuntBackendError(500, {"reason_code": "cancel_backoff_active"}),
        HuntBackendError(409, {"message": "cancel_backoff_active"}),
        RuntimeError("cancel_backoff_active"),
    ],
)
def test_cancel_backoff_detection_rejects_non_conflict_and_unstructured_errors(error):
    assert _is_cancel_backoff_active(error) is False


def test_cancel_backoff_detection_accepts_dynamically_loaded_backend_error_shape():
    class DynamicallyLoadedHuntBackendError(RuntimeError):
        def __init__(self):
            super().__init__("foreign module backend conflict")
            self.status_code = 409
            self.reason = {"reason_code": "cancel_backoff_active"}

    assert _is_cancel_backoff_active(DynamicallyLoadedHuntBackendError()) is True


def test_supervisor_does_not_release_lane_while_cancellation_is_pending():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="cancel-pending-test",
        ports=[9832],
        artifact_root=Path("logs/cancel-pending-test"),
        deadline_seconds=10,
    )[0]
    calls: list[tuple] = []
    lock = threading.Lock()

    class PendingCancelClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "stalled"}, calls, lock)

        def cancel_c3_operation(self, payload):
            self._call("cancel", {**payload, "session_id": lane.session_id})
            return {
                "operation": {
                    "operation_id": f"op_{lane.session_id}",
                    "state": "cancelling",
                }
            }

        def wait_for_operation_event(self, payload):
            self._call("wait", {**payload, "session_id": lane.session_id})
            return {
                "operation": {
                    "operation_id": f"op_{lane.session_id}",
                    "state": "cancelling",
                },
                "events": [],
            }

    clock_value = 0.0

    def clock():
        nonlocal clock_value
        clock_value += 1.0
        return clock_value

    client = PendingCancelClient()
    report = C3BatchSupervisor(
        client_factory=lambda: client,
        prepare_lane=_exact_runtime,
        now=clock,
    ).run([lane], max_concurrency=1)

    assert not [call for call in calls if call[0] in {"finish", "fail"}]
    assert report.lanes[0].classification == "cancellation_pending"
    assert report.lanes[0].operation_state == "cancelling"
    assert report.lanes[0].cancel_requested is True
    assert report.lanes[0].cancel_acknowledged is False
    assert report.lanes[0].command_id.startswith("cmd_")
    assert report.lanes[0].trace_id.startswith("trace_")
    assert report.lanes[0].artifact_dir == lane.artifact_dir
    assert report.lanes[0].failure_context_status == "unavailable_nonterminal"
    assert report.lanes[0].failure_context_error == (
        "cancellation_reconciliation_deadline_exceeded"
    )
    assert not [call for call in calls if call[0] == "failure_context"]


def test_cancel_wait_outlasts_monitor_reconciliation_and_returns_terminal_packet():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="late-orphan-test",
        ports=[9832],
        artifact_root=Path("logs/late-orphan-test"),
        deadline_seconds=180,
    )[0]
    waits = 0

    class LateOrphanClient:
        def wait_for_operation_event(self, _payload):
            nonlocal waits
            waits += 1
            if waits < 30:
                return {
                    "operation": {
                        "operation_id": "op-late-orphan",
                        "state": "cancelling",
                        "cancel_failed_at": "2026-07-22T00:00:00Z",
                    },
                    "events": [],
                }
            return {
                "operation": {
                    "operation_id": "op-late-orphan",
                    "state": "orphaned",
                    "terminal_reason": "control_plane_cancel_unreconciled",
                },
                "events": [{"seq": 30, "event_id": "evt-orphaned"}],
            }

        def get_c3_operation(self, _payload):
            return {"operation_id": "op-late-orphan", "state": "cancelling"}

        def cancel_c3_operation(self, _payload):
            return {"operation": {"operation_id": "op-late-orphan", "state": "cancelling"}}

    clock_value = 0.0

    def clock():
        nonlocal clock_value
        clock_value += 0.5
        return clock_value

    client = LateOrphanClient()
    supervisor = C3BatchSupervisor(
        client_factory=lambda: client,
        prepare_lane=_exact_runtime,
        now=clock,
    )

    terminal = supervisor._wait_for_cancel_terminal(
        client,
        lane,
        "lease-late-orphan",
        "op-late-orphan",
        {"operation_id": "op-late-orphan", "state": "cancelling"},
    )

    assert waits == 30
    assert terminal["state"] == "orphaned"
    assert terminal["terminal_reason"] == "control_plane_cancel_unreconciled"


def test_live_shaped_cancel_reconciles_terminal_and_late_artifact_after_wait_error():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="live-cancel-late-artifact",
        ports=[9848],
        artifact_root=Path("logs/live-cancel-late-artifact"),
        deadline_seconds=2,
    )[0]
    wait_reads = 0
    cancellation_wait_reads = 0
    operation_reads = 0
    context_reads = 0
    cancel_requested = False

    class LiveShapedClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "suspected_stall"}, [], threading.Lock())

        def cancel_c3_operation(self, payload):
            nonlocal cancel_requested
            cancel_requested = True
            return {"operation": {"operation_id": f"op_{lane.session_id}", "state": "cancelling"}}

        def wait_for_operation_event(self, payload):
            nonlocal cancellation_wait_reads, wait_reads
            wait_reads += 1
            if not cancel_requested:
                return {
                    "operation": {
                        "operation_id": f"op_{lane.session_id}",
                        "state": "suspected_stall",
                    },
                    "events": [],
                }
            cancellation_wait_reads += 1
            if cancellation_wait_reads == 1:
                raise RuntimeError("transient cancellation waiter failure")
            return {
                "operation": {
                    "operation_id": f"op_{lane.session_id}",
                    "state": "cancelled",
                    "terminal_reason": "watchdog_timeout",
                },
                "events": [{"seq": 8, "event_id": "evt-cancelled"}],
            }

        def get_c3_operation(self, payload):
            nonlocal operation_reads
            operation_reads += 1
            terminal = cancel_requested and operation_reads >= 2
            return {
                "operation": {
                    "operation_id": payload["operation_id"],
                    "state": "cancelled" if terminal else "cancelling",
                    "terminal_reason": "watchdog_timeout" if terminal else "",
                    "artifact_ids": ["artifact-late"] if context_reads >= 2 else [],
                }
            }

        def get_c3_failure_context(self, payload):
            nonlocal context_reads
            context_reads += 1
            complete = context_reads >= 2
            return {
                "failure_context": {
                    "operation_id": payload["operation_id"],
                    "diagnosis_id": "diagnosis-live",
                    "root_cause_code": "field_driver_timeout",
                    "artifact_status": "completed" if complete else "capturing",
                    "artifact_ids": ["artifact-late"] if complete else [],
                },
                "artifacts": (
                    [
                        {
                            "artifact_id": "artifact-late",
                            "status": "completed",
                            "kind": "failure_bundle",
                            "files": ["dom.html"],
                            "manifest_present": True,
                        }
                    ]
                    if complete
                    else []
                ),
            }

    clock_value = 0.0

    def clock():
        nonlocal clock_value
        clock_value += 0.2
        return clock_value

    result = (
        C3BatchSupervisor(
            client_factory=LiveShapedClient,
            prepare_lane=_exact_runtime,
            now=clock,
            sleep=lambda _seconds: None,
        )
        .run([lane], max_concurrency=1)
        .lanes[0]
    )

    assert result.operation_state == "cancelled"
    assert result.terminal_reason == "watchdog_timeout"
    assert result.artifact_ids == ("artifact-late",), (
        result,
        operation_reads,
        context_reads,
        wait_reads,
        cancellation_wait_reads,
    )
    assert result.failure_artifact_ids == ("artifact-late",)
    assert result.failure_artifact_status == "completed"
    assert result.failure_artifact_summaries[0]["artifact_id"] == "artifact-late"
    assert result.operation_refresh_status == "refreshed"
    assert result.operation_refresh_error == ""
    assert result.failure_context_error == ""


def test_live_shaped_terminal_conflict_preserves_authoritative_failure_and_late_artifact():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="live-terminal-conflict",
        ports=[9849],
        artifact_root=Path("logs/live-terminal-conflict"),
    )[0]
    context_reads = 0
    cancel_calls = 0

    class TerminalConflictClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "failed"}, [], threading.Lock())

        def wait_for_operation_event(self, payload):
            return {
                "operation": {
                    "operation_id": payload["operation_id"],
                    "state": "failed",
                    "terminal_reason": "extension_command_failed",
                    "result": {"reason_code": "auth_create_account_to_signin_sink"},
                },
                "events": [{"seq": 9, "event_id": "evt-extension-failed"}],
            }

        def get_c3_operation(self, payload):
            return {
                "operation": {
                    "operation_id": payload["operation_id"],
                    "state": "failed",
                    "terminal_reason": "extension_command_failed",
                    "artifact_ids": ["artifact-late-failed"] if context_reads > 12 else [],
                    "result": {"reason_code": "auth_create_account_to_signin_sink"},
                }
            }

        def get_c3_failure_context(self, payload):
            nonlocal context_reads
            context_reads += 1
            artifact_failed = context_reads > 12
            return {
                "failure_context": {
                    "operation_id": payload["operation_id"],
                    "diagnosis_id": "diagnosis-extension-failed",
                    "root_cause_code": "auth_create_account_to_signin_sink",
                    "summary": "Create-account navigation returned to the sign-in sink.",
                    "artifact_status": "failed" if artifact_failed else "idle",
                    "artifact_ids": ["artifact-late-failed"] if artifact_failed else [],
                },
                "artifacts": (
                    [
                        {
                            "artifact_id": "artifact-late-failed",
                            "status": "failed",
                            "kind": "failure_bundle",
                            "files": [],
                            "manifest_present": False,
                        }
                    ]
                    if artifact_failed
                    else []
                ),
            }

        def fail_lane(self, _payload):
            raise HuntBackendError(
                409,
                {
                    "reason_code": "lane_terminal_conflict",
                    "field": "lease_id",
                },
            )

        def cancel_c3_operation(self, payload):
            nonlocal cancel_calls
            cancel_calls += 1
            return super().cancel_c3_operation(payload)

    result = (
        C3BatchSupervisor(
            client_factory=TerminalConflictClient,
            prepare_lane=_exact_runtime,
            sleep=lambda _seconds: None,
        )
        .run([lane], max_concurrency=1)
        .lanes[0]
    )

    assert result.operation_state == "failed"
    assert result.terminal_reason == "extension_command_failed"
    assert result.classification == "fill_failed"
    assert result.cancel_requested is False
    assert cancel_calls == 0
    assert result.root_cause_code == "auth_create_account_to_signin_sink"
    assert result.failure_artifact_status == "failed"
    assert result.failure_artifact_ids == ("artifact-late-failed",)
    assert result.failure_artifact_summaries[0]["status"] == "failed"
    assert result.operation_refresh_status == "refreshed"
    assert result.error == "lane_finalization_warning:HuntBackendError:lane_terminal_conflict"


def test_cancel_error_still_reconciles_late_orphan_and_terminal_failure_context():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="cancel-error-late-terminal",
        ports=[9851],
        artifact_root=Path("logs/cancel-error-late-terminal"),
    )[0]
    cancel_calls = 0
    post_cancel_waits = 0
    context_reads = 0
    cancel_attempted = False

    class LateOrphanClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "running"}, [], threading.Lock())

        def wait_for_operation_event(self, payload):
            nonlocal post_cancel_waits
            if not cancel_attempted:
                raise HuntBackendError(
                    403,
                    {"reason_code": "operation_identity_mismatch"},
                )
            post_cancel_waits += 1
            if post_cancel_waits == 1:
                raise HuntBackendError(
                    403,
                    {"reason_code": "operation_identity_mismatch"},
                )
            return {
                "operation": {
                    "operation_id": payload["operation_id"],
                    "state": "orphaned",
                    "terminal_reason": "control_plane_cancel_unreconciled",
                    "artifact_ids": ["artifact_452190f484f04b8f820d30a0eb5494b0"],
                },
                "events": [{"seq": 11, "event_id": "evt-orphaned"}],
            }

        def cancel_c3_operation(self, _payload):
            nonlocal cancel_attempted, cancel_calls
            cancel_attempted = True
            cancel_calls += 1
            raise HuntBackendError(
                403,
                {"reason_code": "operation_identity_mismatch"},
            )

        def get_c3_operation(self, payload):
            return {
                "operation": {
                    "operation_id": payload["operation_id"],
                    "state": "cancelling",
                    "terminal_reason": "",
                }
            }

        def get_c3_failure_context(self, payload):
            nonlocal context_reads
            context_reads += 1
            completed = context_reads >= 2
            return {
                "failure_context": {
                    "operation_id": payload["operation_id"],
                    "diagnosis_id": "diagnosis-late-orphan",
                    "root_cause_code": "control_plane_cancel_unreconciled",
                    "artifact_status": "completed" if completed else "capturing",
                    "artifact_ids": (
                        ["artifact_452190f484f04b8f820d30a0eb5494b0"] if completed else []
                    ),
                }
            }

    clock_value = 0.0

    def clock():
        nonlocal clock_value
        clock_value += 0.5
        return clock_value

    result = (
        C3BatchSupervisor(
            client_factory=LateOrphanClient,
            prepare_lane=_exact_runtime,
            now=clock,
            sleep=lambda _seconds: None,
        )
        .run([lane], max_concurrency=1)
        .lanes[0]
    )

    assert cancel_calls == 1
    assert post_cancel_waits == 2
    assert result.operation_state == "orphaned"
    assert result.terminal_reason == "control_plane_cancel_unreconciled"
    assert result.event_ids == ("evt-orphaned",)
    assert result.failure_context_status == "available"
    assert result.root_cause_code == "control_plane_cancel_unreconciled"
    assert result.failure_artifact_status == "completed"
    assert result.failure_artifact_ids == ("artifact_452190f484f04b8f820d30a0eb5494b0",)
    assert context_reads == 2


def test_existing_terminal_lane_is_reused_without_browser_work_or_refinalization():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="existing-terminal-lane",
        ports=[9850],
        artifact_root=Path("logs/existing-terminal-lane"),
    )[0]
    calls: list[tuple] = []
    lock = threading.Lock()
    prior_operation_id = "op-prior-terminal"
    prior_lease_id = "lease-prior-terminal"

    class ExistingTerminalClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "failed"}, calls, lock)

        def get_session_log(self, payload):
            self._call("session_log", payload)
            return {
                "found": True,
                "events": [
                    {
                        "event_id": "evt-prior-terminal",
                        "event_type": "lane.failed",
                        "agent_id": lane.agent_id,
                        "lane_id": lane.lane_id,
                        "session_id": lane.session_id,
                        "lease_id": prior_lease_id,
                        "payload": {
                            "reason": "fill_failed",
                            "result": {
                                "operation_id": prior_operation_id,
                                "classification": "fill_failed",
                                "focus_activated": False,
                                "submit_activated": False,
                            },
                        },
                    }
                ],
            }

        def get_c3_operation(self, payload):
            assert payload == {
                "operation_id": prior_operation_id,
                "agent_id": lane.agent_id,
                "lease_id": prior_lease_id,
            }
            return {
                "operation": {
                    "operation_id": prior_operation_id,
                    "agent_id": lane.agent_id,
                    "lane_id": lane.lane_id,
                    "session_id": lane.session_id,
                    "lease_id": prior_lease_id,
                    "browser_target_id": lane.browser_target_id,
                    "state": "failed",
                    "terminal_reason": "extension_command_failed",
                    "result": {"reason_code": "auth_create_account_to_signin_sink"},
                }
            }

        def bootstrap_lane(self, _payload):
            raise AssertionError("terminal lane must not bootstrap again")

        def page_walk(self, _payload):
            raise AssertionError("terminal lane must not start another operation")

        def fail_lane(self, _payload):
            raise AssertionError("authoritative terminal lane must not be finalized again")

    prepare_calls = 0

    def prepare(_lane):
        nonlocal prepare_calls
        prepare_calls += 1
        raise AssertionError("terminal lane must not prepare a browser target again")

    result = (
        C3BatchSupervisor(
            client_factory=ExistingTerminalClient,
            prepare_lane=prepare,
            sleep=lambda _seconds: None,
        )
        .run([lane], max_concurrency=1)
        .lanes[0]
    )

    assert prepare_calls == 0
    assert result.operation_id == prior_operation_id
    assert result.lease_id == prior_lease_id
    assert result.operation_state == "failed"
    assert result.terminal_reason == "extension_command_failed"
    assert result.classification == "fill_failed"
    assert result.error == ""
    assert result.event_ids == ("evt-prior-terminal",)


def test_failure_context_is_fetched_once_and_reused_if_lane_finish_raises():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="failure-context-once",
        ports=[9832],
        artifact_root=Path("logs/failure-context-once"),
    )[0]
    calls: list[tuple] = []
    lock = threading.Lock()

    class FinishRaisesClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "completed"}, calls, lock)

        def finish_lane(self, payload):
            self._call("finish", payload)
            raise RuntimeError("finish_failed")

    report = C3BatchSupervisor(
        client_factory=FinishRaisesClient,
        prepare_lane=_exact_runtime,
    ).run([lane], max_concurrency=1)

    context_calls = [payload for name, _, payload in calls if name == "failure_context"]
    assert len(context_calls) == 1
    assert context_calls[0] == {
        "operation_id": f"op_{lane.session_id}",
        "agent_id": lane.agent_id,
        "lease_id": f"lease_{lane.session_id}",
        "session_id": lane.session_id,
    }
    assert report.lanes[0].failure_context_status == "available"
    assert report.lanes[0].root_cause_code == "ui_commit_failed"


def test_failure_context_fetch_error_is_explicit_in_lane_result():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="failure-context-error",
        ports=[9834],
        artifact_root=Path("logs/failure-context-error"),
    )[0]
    calls: list[tuple] = []
    lock = threading.Lock()

    class ContextRaisesClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "completed"}, calls, lock)

        def get_c3_failure_context(self, payload):
            self._call(
                "failure_context",
                {**payload, "session_id": payload["operation_id"].removeprefix("op_")},
            )
            raise RuntimeError("context_unavailable")

    result = (
        C3BatchSupervisor(
            client_factory=ContextRaisesClient,
            prepare_lane=_exact_runtime,
        )
        .run([lane], max_concurrency=1)
        .lanes[0]
    )

    assert result.failure_context_status == "error"
    assert result.failure_context_error == "RuntimeError"
    assert result.root_cause_unknown is True


def test_lane_result_retains_bounded_compact_failure_evidence_and_artifact_summaries():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="compact-context",
        ports=[9846],
        artifact_root=Path("logs/compact-context"),
    )[0]

    class RichContextClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "failed"}, [], threading.Lock())

        def get_c3_failure_context(self, payload):
            action_tail = [
                {
                    "seq": index + 1,
                    "event_id": f"evt-{index}",
                    "event_type": "operation.progress",
                    "action": "click",
                    "element": {"selector": f"#field-{index}", "label": "Field"},
                    "unsafe": "must-not-persist",
                }
                for index in range(30)
            ]
            return {
                "failure_context": {
                    "operation_id": payload["operation_id"],
                    "diagnosis_id": "diagnosis-rich",
                    "root_cause_code": "ui_commit_failed",
                    "artifact_status": "completed",
                },
                "action_tail": action_tail,
                "validation_tail": [
                    {"seq": 31, "event_type": "validation", "validation_messages": ["Required"]}
                ],
                "navigation_tail": [
                    {
                        "seq": 32,
                        "event_type": "navigation",
                        "navigation_to": "https://example.test/apply",
                    }
                ],
                "artifacts": [
                    {
                        "artifact_id": "artifact-1",
                        "status": "completed",
                        "kind": "failure_bundle",
                        "files": ["dom.html", "health.json"],
                        "manifest_present": True,
                        "unsafe": "must-not-persist",
                    }
                ],
            }

    result = (
        C3BatchSupervisor(
            client_factory=RichContextClient,
            prepare_lane=_exact_runtime,
        )
        .run([lane], max_concurrency=1)
        .lanes[0]
    )

    assert len(result.failure_action_tail) == 16
    assert result.failure_action_tail[-1]["event_id"] == "evt-29"
    assert "unsafe" not in result.failure_action_tail[-1]
    assert result.failure_validation_tail[0]["validation_messages"] == ("Required",)
    assert result.failure_navigation_tail[0]["navigation_to"] == "https://example.test/apply"
    assert result.failure_artifact_summaries == (
        {
            "artifact_id": "artifact-1",
            "status": "completed",
            "kind": "failure_bundle",
            "captured_at": "",
            "files": ("dom.html", "health.json"),
            "manifest_present": True,
        },
    )


def test_completed_failure_manifest_populates_bounded_lane_artifact_paths(tmp_path):
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="manifest-path-report",
        ports=[9849],
        artifact_root=tmp_path,
    )[0]
    operation_id = f"op_{lane.session_id}"
    manifest_path = (
        tmp_path
        / "ledger"
        / "operations"
        / operation_id
        / "artifacts"
        / "artifact_452190f484f04b8f820d30a0eb5494b0"
        / "manifest.json"
    ).resolve()
    manifest_path.parent.mkdir(parents=True)
    manifest_path.write_text("{}", encoding="utf-8")

    class ManifestContextClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "failed"}, [], threading.Lock())

        def get_c3_failure_context(self, payload):
            return {
                "failure_context": {
                    "operation_id": payload["operation_id"],
                    "diagnosis_id": "diagnosis-live-artifact",
                    "root_cause_code": "auth_ui_cycle_detected",
                    "artifact_status": "completed",
                    "artifact_ids": ["artifact_452190f484f04b8f820d30a0eb5494b0"],
                },
                "artifacts": [
                    {
                        "artifact_id": "artifact_452190f484f04b8f820d30a0eb5494b0",
                        "status": "completed",
                        "kind": "failure_bundle",
                        "manifest_present": True,
                        "manifest_path": str(manifest_path),
                    }
                ],
            }

    result = (
        C3BatchSupervisor(
            client_factory=ManifestContextClient,
            prepare_lane=_exact_runtime,
        )
        .run([lane], max_concurrency=1)
        .lanes[0]
    )

    assert result.failure_artifact_status == "completed"
    assert result.artifact_paths == (str(manifest_path),)


def test_artifact_paths_reject_recursive_unvalidated_and_out_of_root_paths(tmp_path):
    operation_id = "op-fiolncoeaenbkpaealkfaaplhjconhki"
    artifact_id = "artifact_452190f484f04b8f820d30a0eb5494b0"
    operation_root = (tmp_path / "operations" / operation_id).resolve()
    valid_manifest = (operation_root / "artifacts" / artifact_id / "manifest.json").resolve()
    unrelated_manifest = (tmp_path / "unrelated" / artifact_id / "manifest.json").resolve()
    traversal_manifest = (
        operation_root / "artifacts" / artifact_id / ".." / ".." / "unrelated" / "manifest.json"
    )
    context = {
        "operation_id": operation_id,
        "artifact_paths": [str(unrelated_manifest)],
        "nested": {"artifact_path": str(unrelated_manifest)},
        "artifacts": [
            {
                "artifact_id": artifact_id,
                "status": "completed",
                "kind": "failure_bundle",
                "manifest_present": True,
                "manifest_path": str(valid_manifest),
            },
            {
                "artifact_id": artifact_id,
                "status": "completed",
                "kind": "failure_bundle",
                "manifest_present": True,
                "manifest_path": str(unrelated_manifest),
            },
            {
                "artifact_id": artifact_id,
                "status": "completed",
                "kind": "failure_bundle",
                "manifest_present": True,
                "manifest_path": str(traversal_manifest),
            },
            {
                "artifact_id": artifact_id,
                "status": "partial",
                "kind": "failure_bundle",
                "manifest_present": True,
                "manifest_path": str(valid_manifest),
            },
            {
                "artifact_id": "artifact_3035551212",
                "status": "completed",
                "kind": "failure_bundle",
                "manifest_present": True,
                "manifest_path": str(valid_manifest),
            },
        ],
    }

    assert _artifact_paths(context, operation_id=operation_id) == (str(valid_manifest),)


def test_terminal_failure_context_refreshes_until_late_artifact_is_linked():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="late-artifact-refresh",
        ports=[9844],
        artifact_root=Path("logs/late-artifact-refresh"),
    )[0]
    calls: list[tuple] = []

    class LateArtifactClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "failed"}, calls, threading.Lock())
            self.context_reads = 0

        def get_c3_failure_context(self, payload):
            self.context_reads += 1
            return {
                "failure_context": {
                    "operation_id": payload["operation_id"],
                    "diagnosis_id": "diagnosis-late",
                    "root_cause_code": "ui_commit_failed",
                    "artifact_status": "capturing" if self.context_reads < 60 else "completed",
                    "artifact_ids": [] if self.context_reads < 60 else ["artifact-late"],
                }
            }

    client = LateArtifactClient()
    result = (
        C3BatchSupervisor(
            client_factory=lambda: client,
            prepare_lane=_exact_runtime,
            sleep=lambda _seconds: None,
        )
        .run([lane], max_concurrency=1)
        .lanes[0]
    )

    assert client.context_reads == 60
    assert result.failure_artifact_status == "completed"
    assert result.failure_artifact_ids == ("artifact-late",)


def test_partial_artifact_is_settled_and_truncation_sources_remain_distinct():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="partial-artifact-settled",
        ports=[9850],
        artifact_root=Path("logs/partial-artifact-settled"),
    )[0]
    sleep_calls: list[float] = []

    class PartialArtifactClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "failed"}, [], threading.Lock())
            self.context_reads = 0

        def get_c3_failure_context(self, payload):
            self.context_reads += 1
            return {
                "failure_context": {
                    "operation_id": payload["operation_id"],
                    "diagnosis_id": "diagnosis-partial",
                    "root_cause_code": "artifact_capture_failed",
                    "artifact_status": "partial",
                    "artifact_ids": ["artifact-partial"],
                    "evidence_truncated": False,
                },
                "artifacts": [
                    {
                        "artifact_id": "artifact-partial",
                        "status": "partial",
                        "kind": "failure_bundle",
                    }
                ],
                "evidence_truncated": True,
            }

    client = PartialArtifactClient()
    result = (
        C3BatchSupervisor(
            client_factory=lambda: client,
            prepare_lane=_exact_runtime,
            sleep=sleep_calls.append,
        )
        .run([lane], max_concurrency=1)
        .lanes[0]
    )

    assert client.context_reads == 1
    assert sleep_calls == []
    assert result.failure_artifact_status == "partial"
    assert result.failure_evidence_truncated is False
    assert result.failure_response_evidence_truncated is True


def test_terminal_failure_context_refresh_error_keeps_last_available_context():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="late-artifact-refresh-error",
        ports=[9847],
        artifact_root=Path("logs/late-artifact-refresh-error"),
    )[0]

    class RefreshRaisesClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "failed"}, [], threading.Lock())
            self.context_reads = 0

        def get_c3_failure_context(self, payload):
            self.context_reads += 1
            if self.context_reads > 1:
                raise RuntimeError("late refresh failed")
            return {
                "failure_context": {
                    "operation_id": payload["operation_id"],
                    "diagnosis_id": "diagnosis-retained",
                    "root_cause_code": "ui_commit_failed",
                    "summary": "Retain this diagnosis",
                    "artifact_status": "capturing",
                }
            }

    client = RefreshRaisesClient()
    result = (
        C3BatchSupervisor(
            client_factory=lambda: client,
            prepare_lane=_exact_runtime,
            sleep=lambda _seconds: None,
        )
        .run([lane], max_concurrency=1)
        .lanes[0]
    )

    assert client.context_reads == 2
    assert result.failure_context_status == "available"
    assert result.diagnosis_id == "diagnosis-retained"
    assert result.root_cause_code == "ui_commit_failed"
    assert result.failure_summary == "Retain this diagnosis"
    assert result.failure_context_error == "refresh:RuntimeError"


def test_paginated_waiter_advances_server_cursor_without_replaying_page():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="event-page-cursor",
        ports=[9845],
        artifact_root=Path("logs/event-page-cursor"),
    )[0]
    wait_payloads = []

    class PaginatedClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "running"}, [], threading.Lock())

        def wait_for_operation_event(self, payload):
            wait_payloads.append(dict(payload))
            if len(wait_payloads) == 1:
                return {
                    "operation": {"operation_id": f"op_{lane.session_id}", "state": "running"},
                    "events": [{"seq": 2, "event_id": "evt-2"}],
                    "next_after_seq": 3,
                    "has_more": True,
                }
            return {
                "operation": {
                    "operation_id": f"op_{lane.session_id}",
                    "state": "completed",
                    "result": {"review_ready": True},
                },
                "events": [{"seq": 4, "event_id": "evt-4"}],
                "next_after_seq": 4,
                "has_more": False,
            }

    result = (
        C3BatchSupervisor(
            client_factory=PaginatedClient,
            prepare_lane=_exact_runtime,
        )
        .run([lane], max_concurrency=1)
        .lanes[0]
    )

    assert wait_payloads[0]["after_seq"] == 0
    assert wait_payloads[1]["after_seq"] == 3
    assert result.event_ids == ("evt-2", "evt-4")


def test_exception_after_operation_start_cancels_before_terminal_lane_release():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="exception-cancel-test",
        ports=[9833],
        artifact_root=Path("logs/exception-cancel-test"),
    )[0]
    calls: list[tuple] = []
    lock = threading.Lock()

    class ExceptionThenCancelClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "running"}, calls, lock)
            self.cancelled = False

        def wait_for_operation_event(self, payload):
            self._call("wait", {**payload, "session_id": lane.session_id})
            if not self.cancelled:
                raise RuntimeError("backend_wait_failed")
            return {
                "operation": {
                    "operation_id": f"op_{lane.session_id}",
                    "state": "cancelled",
                    "terminal_reason": "exception_cleanup",
                },
                "events": [],
            }

        def cancel_c3_operation(self, payload):
            self._call("cancel", {**payload, "session_id": lane.session_id})
            self.cancelled = True
            return {
                "operation": {
                    "operation_id": f"op_{lane.session_id}",
                    "state": "cancelling",
                }
            }

    client = ExceptionThenCancelClient()
    report = C3BatchSupervisor(
        client_factory=lambda: client,
        prepare_lane=_exact_runtime,
    ).run([lane], max_concurrency=1)

    names = [name for name, _, _ in calls]
    assert names.index("cancel") < names.index("fail")
    assert report.lanes[0].operation_state == "cancelled"
    assert report.lanes[0].cancel_requested is True


def test_event_envelope_without_state_refreshes_projection_before_deadline_cancel():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="event-envelope-test",
        ports=[9834],
        artifact_root=Path("logs/event-envelope-test"),
        deadline_seconds=10,
    )[0]
    calls: list[tuple] = []
    lock = threading.Lock()

    class EventEnvelopeClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "completed"}, calls, lock)

        def wait_for_operation_event(self, payload):
            self._call("wait", {**payload, "session_id": lane.session_id})
            return {
                "operation_id": f"op_{lane.session_id}",
                "events": [
                    {
                        "seq": 1,
                        "event_id": "evt-completed",
                        "event_type": "operation.completed",
                    }
                ],
            }

        def get_c3_operation(self, payload):
            self._call("get", {**payload, "session_id": lane.session_id})
            return {
                "operation": {
                    "operation_id": f"op_{lane.session_id}",
                    "state": "completed",
                    "result": {"review_ready": True},
                }
            }

    clock_values = iter([0.0, 1.0, 9.0, 11.0, 12.0])
    client = EventEnvelopeClient()
    report = C3BatchSupervisor(
        client_factory=lambda: client,
        prepare_lane=_exact_runtime,
        now=lambda: next(clock_values),
    ).run([lane], max_concurrency=1)

    names = [name for name, _, _ in calls]
    assert "get" in names
    assert "cancel" not in names
    assert "finish" in names
    assert report.lanes[0].operation_state == "completed"


def test_terminal_report_preserves_evidence_and_flags_submit_or_focus_activation():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="safety-evidence-test",
        ports=[9835],
        artifact_root=Path("logs/safety-evidence-test"),
    )[0]
    calls: list[tuple] = []
    lock = threading.Lock()

    class SafetyEvidenceClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "completed"}, calls, lock)

        def wait_for_operation_event(self, payload):
            self._call("wait", {**payload, "session_id": lane.session_id})
            return {
                "operation": {
                    "operation_id": f"op_{lane.session_id}",
                    "state": "completed",
                    "artifact_ids": ["artifact-1"],
                    "result": {
                        "review_ready": True,
                        "submitActivated": True,
                        "focusActivated": True,
                        "artifact_paths": ["C:/hunt-logs/artifact-1/summary.json"],
                    },
                },
                "events": [
                    {
                        "seq": 4,
                        "event_id": "evt-safety-proof",
                        "event_type": "operation.completed",
                    }
                ],
            }

    client = SafetyEvidenceClient()
    report = C3BatchSupervisor(
        client_factory=lambda: client,
        prepare_lane=_exact_runtime,
    ).run([lane], max_concurrency=1)
    result = report.lanes[0]

    assert result.classification == "safety_violation"
    assert result.submit_activated is True
    assert result.focus_activated is True
    assert result.command_id.startswith("cmd_")
    assert result.trace_id.startswith("trace_")
    assert result.event_ids == ("evt-safety-proof",)
    assert result.artifact_ids == ("artifact-1",)
    assert result.artifact_dir == lane.artifact_dir
    assert result.artifact_paths == ()
    assert [name for name, _, _ in calls].count("fail") == 1
    assert [name for name, _, _ in calls].count("finish") == 0


def test_supervisor_checkpoints_owned_ids_before_wait_failure():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="checkpoint-test",
        ports=[9836],
        artifact_root=Path("logs/checkpoint-test"),
    )[0]
    checkpoints: list[dict] = []
    calls: list[tuple] = []
    lock = threading.Lock()

    class CheckpointClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "running"}, calls, lock)

        def wait_for_operation_event(self, payload):
            self._call("wait", {**payload, "session_id": lane.session_id})
            raise RuntimeError("wait_failed")

        def cancel_c3_operation(self, payload):
            self._call("cancel", {**payload, "session_id": lane.session_id})
            return {
                "operation": {
                    "operation_id": f"op_{lane.session_id}",
                    "state": "cancelling",
                }
            }

    clock_value = 0.0

    def clock():
        nonlocal clock_value
        clock_value += 5.0
        return clock_value

    report = C3BatchSupervisor(
        client_factory=CheckpointClient,
        prepare_lane=_exact_runtime,
        now=clock,
        checkpoint=lambda _lane, state: checkpoints.append(dict(state)),
    ).run([lane], max_concurrency=1)

    started = next(item for item in checkpoints if item["stage"] == "operation_started")
    assert started["lease_id"].startswith("lease_")
    assert started["operation_id"].startswith("op_")
    assert started["command_id"].startswith("cmd_")
    assert started["trace_id"].startswith("trace_")
    assert started["artifact_dir"] == lane.artifact_dir
    assert checkpoints[-1]["stage"] == "cancel_pending"
    assert report.lanes[0].cancel_requested is True


def test_supervisor_resume_existing_operation_skips_bootstrap_and_start():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="resume-runner-test",
        ports=[9837],
        artifact_root=Path("logs/resume-runner-test"),
    )[0]
    calls: list[tuple] = []
    lock = threading.Lock()
    target = {
        "debug_port": lane.port,
        "extension_id": "abcdefghijklmnopabcdefghijklmnop",
        "tab_id": 417,
        "target_id": "target-417",
        "url": lane.job.url,
    }

    class ResumeClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "completed"}, calls, lock)

        def get_c3_operation(self, payload):
            self._call("get", {**payload, "session_id": lane.session_id})
            return {
                "operation": {
                    "operation_id": "op-resume",
                    "agent_id": lane.agent_id,
                    "lane_id": lane.lane_id,
                    "session_id": lane.session_id,
                    "lease_id": "lease-resume",
                    "browser_target_id": lane.browser_target_id,
                    "target": target,
                    "command_id": "cmd-resume",
                    "trace_id": "trace-resume",
                    "state": "completed",
                    "result": {"review_ready": True},
                }
            }

    client = ResumeClient()
    report = C3BatchSupervisor(
        client_factory=lambda: client,
        prepare_lane=lambda _lane: (_ for _ in ()).throw(
            AssertionError("prepare must not run for resumed operation")
        ),
    ).run(
        [lane],
        max_concurrency=1,
        resume_states={
            lane.session_id: {
                "stage": "operation_started",
                "lease_id": "lease-resume",
                "operation_id": "op-resume",
                "command_id": "cmd-resume",
                "trace_id": "trace-resume",
                "browser_target_id": lane.browser_target_id,
                "target": target,
            }
        },
    )

    names = [name for name, _, _ in calls]
    assert "bootstrap" not in names
    assert "start" not in names
    assert "get" in names
    assert "finish" in names
    assert report.lanes[0].operation_id == "op-resume"
    assert report.lanes[0].command_id == "cmd-resume"


def test_supervisor_resume_preserves_checkpoint_event_cursor_and_history():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="resume-history-test",
        ports=[9841],
        artifact_root=Path("logs/resume-history-test"),
    )[0]
    target = {
        "debug_port": lane.port,
        "extension_id": "abcdefghijklmnopabcdefghijklmnop",
        "tab_id": 417,
        "target_id": "target-417",
        "url": lane.job.url,
    }
    calls: list[tuple] = []
    checkpoints: list[dict] = []

    class TerminalResumeClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "completed"}, calls, threading.Lock())

        def get_c3_operation(self, payload):
            self._call("get", {**payload, "session_id": lane.session_id})
            return {
                "operation": {
                    "operation_id": "op-resume-history",
                    "agent_id": lane.agent_id,
                    "lane_id": lane.lane_id,
                    "session_id": lane.session_id,
                    "lease_id": "lease-resume-history",
                    "browser_target_id": lane.browser_target_id,
                    "target": target,
                    "command_id": "cmd-resume-history",
                    "trace_id": "trace-resume-history",
                    "state": "completed",
                    "result": {"review_ready": True},
                }
            }

    report = C3BatchSupervisor(
        client_factory=TerminalResumeClient,
        prepare_lane=lambda _lane: (_ for _ in ()).throw(
            AssertionError("prepare must not run for resumed operation")
        ),
        checkpoint=lambda _lane, state: checkpoints.append(dict(state)),
    ).run(
        [lane],
        max_concurrency=1,
        resume_states={
            lane.session_id: {
                "stage": "monitoring",
                "lease_id": "lease-resume-history",
                "operation_id": "op-resume-history",
                "command_id": "cmd-resume-history",
                "trace_id": "trace-resume-history",
                "browser_target_id": lane.browser_target_id,
                "target": target,
                "after_seq": 7,
                "event_ids": ["evt-before-restart"],
            }
        },
    )

    assert report.lanes[0].event_ids == ("evt-before-restart",)
    assert not [call for call in calls if call[0] == "wait"]
    assert checkpoints[-1]["result"]["event_ids"] == ("evt-before-restart",)


def test_supervisor_resume_waits_after_checkpoint_sequence_without_replaying_history():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="resume-cursor-test",
        ports=[9842],
        artifact_root=Path("logs/resume-cursor-test"),
    )[0]
    target = {
        "debug_port": lane.port,
        "extension_id": "abcdefghijklmnopabcdefghijklmnop",
        "tab_id": 418,
        "target_id": "target-418",
        "url": lane.job.url,
    }
    wait_payloads = []

    class CursorResumeClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "running"}, [], threading.Lock())

        def get_c3_operation(self, payload):
            return {
                "operation": {
                    "operation_id": "op-resume-cursor",
                    "agent_id": lane.agent_id,
                    "lane_id": lane.lane_id,
                    "session_id": lane.session_id,
                    "lease_id": "lease-resume-cursor",
                    "browser_target_id": lane.browser_target_id,
                    "target": target,
                    "command_id": "cmd-resume-cursor",
                    "trace_id": "trace-resume-cursor",
                    "state": "running",
                }
            }

        def wait_for_operation_event(self, payload):
            wait_payloads.append(dict(payload))
            return {
                "operation": {
                    "operation_id": "op-resume-cursor",
                    "state": "completed",
                    "result": {"review_ready": True},
                },
                "events": [{"seq": 8, "event_id": "evt-after-restart"}],
            }

    report = C3BatchSupervisor(
        client_factory=CursorResumeClient,
        prepare_lane=lambda _lane: {},
    ).run(
        [lane],
        max_concurrency=1,
        resume_states={
            lane.session_id: {
                "stage": "monitoring",
                "lease_id": "lease-resume-cursor",
                "operation_id": "op-resume-cursor",
                "browser_target_id": lane.browser_target_id,
                "target": target,
                "after_seq": 7,
                "event_ids": ["evt-before-restart"],
            }
        },
    )

    assert wait_payloads[0]["after_seq"] == 7
    assert report.lanes[0].event_ids == (
        "evt-before-restart",
        "evt-after-restart",
    )


def test_supervisor_resume_rejects_operation_owned_by_another_lane_without_release():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="resume-owner-test",
        ports=[9838],
        artifact_root=Path("logs/resume-owner-test"),
    )[0]
    calls: list[tuple] = []
    lock = threading.Lock()

    class ForeignResumeClient(FakeMcpClient):
        def __init__(self):
            super().__init__({lane.session_id: "completed"}, calls, lock)

        def get_c3_operation(self, payload):
            self._call("get", {**payload, "session_id": lane.session_id})
            return {
                "operation": {
                    "operation_id": "op-foreign",
                    "agent_id": "agent-foreign",
                    "lane_id": "lane-foreign",
                    "session_id": "session-foreign",
                    "lease_id": "lease-foreign",
                    "state": "completed",
                    "result": {"review_ready": True},
                }
            }

    report = C3BatchSupervisor(
        client_factory=ForeignResumeClient,
        prepare_lane=lambda _lane: {},
    ).run(
        [lane],
        max_concurrency=1,
        resume_states={
            lane.session_id: {
                "stage": "operation_started",
                "lease_id": "lease-resume",
                "operation_id": "op-foreign",
            }
        },
    )

    names = [name for name, _, _ in calls]
    assert "cancel" not in names
    assert "finish" not in names
    assert "fail" not in names
    assert "resume_operation_identity_mismatch" in report.lanes[0].error


@pytest.mark.parametrize(
    "missing_key",
    [
        "operation_id",
        "agent_id",
        "lane_id",
        "session_id",
        "lease_id",
        "browser_target_id",
    ],
)
def test_resume_identity_requires_every_exact_ownership_field(missing_key: str):
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="resume-required-identity",
        ports=[9839],
        artifact_root=Path("logs/resume-required-identity"),
    )[0]
    operation = {
        "operation_id": "op-resume",
        "agent_id": lane.agent_id,
        "lane_id": lane.lane_id,
        "session_id": lane.session_id,
        "lease_id": "lease-resume",
        "browser_target_id": lane.browser_target_id,
    }
    operation.pop(missing_key)

    with pytest.raises(
        ResumeOperationIdentityError,
        match="resume_operation_identity_mismatch",
    ):
        _validate_operation_identity(operation, lane, "lease-resume", "op-resume")


def test_resume_identity_rejects_wrong_browser_target_or_pinned_selector():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="resume-target-identity",
        ports=[9840],
        artifact_root=Path("logs/resume-target-identity"),
    )[0]
    pinned_target = {
        "debug_port": lane.port,
        "extension_id": "abcdefghijklmnopabcdefghijklmnop",
        "tab_id": 417,
        "target_id": "target-417",
        "url": lane.job.url,
    }
    operation = {
        "operation_id": "op-resume",
        "agent_id": lane.agent_id,
        "lane_id": lane.lane_id,
        "session_id": lane.session_id,
        "lease_id": "lease-resume",
        "browser_target_id": "wrong-target",
        "target": {**pinned_target, "tab_id": 999},
    }

    with pytest.raises(
        ResumeOperationIdentityError,
        match="resume_operation_identity_mismatch",
    ):
        _validate_operation_identity(
            operation,
            lane,
            "lease-resume",
            "op-resume",
            pinned_target,
        )


def test_resume_identity_accepts_server_normalized_url_with_full_url_hash():
    lane = plan_lanes(
        read_job_csv(Path("wd_test_jobs.csv"))[:1],
        batch_id="resume-normalized-url",
        ports=[9843],
        artifact_root=Path("logs/resume-normalized-url"),
    )[0]
    pinned_target = {
        "debug_port": lane.port,
        "extension_id": "abcdefghijklmnopabcdefghijklmnop",
        "tab_id": 419,
        "target_id": "target-419",
        "url": lane.job.url,
    }
    operation = {
        "operation_id": "op-normalized",
        "agent_id": lane.agent_id,
        "lane_id": lane.lane_id,
        "session_id": lane.session_id,
        "lease_id": "lease-normalized",
        "browser_target_id": lane.browser_target_id,
        "target": {
            **pinned_target,
            "url": lane.job.canonical_url,
            "url_sha256": hashlib.sha256(lane.job.url.encode("utf-8")).hexdigest(),
        },
    }

    _validate_operation_identity(
        operation,
        lane,
        "lease-normalized",
        "op-normalized",
        pinned_target,
    )
