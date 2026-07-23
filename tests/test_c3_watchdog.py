from datetime import UTC, datetime, timedelta

from backend.c3_watchdog import C3WatchdogPolicy

NOW = datetime(2026, 7, 21, 20, 0, tzinfo=UTC)


def _operation(*, heartbeat_age: int, progress_age: int, deadline_age: int = -60):
    return {
        "state": "running",
        "last_heartbeat_at": NOW - timedelta(seconds=heartbeat_age),
        "last_progress_at": NOW - timedelta(seconds=progress_age),
        "deadline_at": NOW + timedelta(seconds=-deadline_age),
    }


def test_watchdog_marks_suspected_stall_at_ten_seconds():
    decision = C3WatchdogPolicy().evaluate(_operation(heartbeat_age=10, progress_age=10), now=NOW)

    assert decision.state == "suspected_stall"
    assert decision.reason_code == "operation_heartbeat_missing"
    assert decision.actions == ("health_probe",)


def test_watchdog_requests_bundle_at_twenty_seconds():
    decision = C3WatchdogPolicy().evaluate(_operation(heartbeat_age=20, progress_age=20), now=NOW)

    assert decision.state == "suspected_stall"
    assert decision.actions == ("health_probe", "capture_failure_bundle")


def test_watchdog_stalls_and_cancels_at_thirty_seconds():
    decision = C3WatchdogPolicy().evaluate(_operation(heartbeat_age=30, progress_age=30), now=NOW)

    assert decision.state == "stalled"
    assert decision.actions == (
        "health_probe",
        "capture_failure_bundle",
        "request_cancel",
    )


def test_live_heartbeat_with_old_progress_is_slow_not_stalled():
    decision = C3WatchdogPolicy().evaluate(_operation(heartbeat_age=2, progress_age=45), now=NOW)

    assert decision.state == "slow"
    assert decision.reason_code == "operation_semantic_progress_slow"
    assert decision.actions == ("capture_checkpoint",)


def test_hard_deadline_requests_bundle_and_cancel_even_with_live_heartbeat():
    decision = C3WatchdogPolicy().evaluate(
        _operation(heartbeat_age=1, progress_age=1, deadline_age=1), now=NOW
    )

    assert decision.state == "stalled"
    assert decision.reason_code == "operation_deadline_exceeded"
    assert decision.actions == ("capture_failure_bundle", "request_cancel")


def test_watchdog_leaves_healthy_operation_running():
    decision = C3WatchdogPolicy().evaluate(_operation(heartbeat_age=2, progress_age=3), now=NOW)

    assert decision.state == "running"
    assert decision.reason_code == "operation_healthy"
    assert decision.actions == ()


def test_watchdog_does_not_stall_an_operation_that_has_not_started():
    decision = C3WatchdogPolicy().evaluate(
        {
            "state": "queued",
            "last_heartbeat_at": None,
            "last_progress_at": None,
            "deadline_at": NOW + timedelta(seconds=60),
        },
        now=NOW,
    )

    assert decision.state == "queued"
    assert decision.reason_code == "operation_queued"
    assert decision.actions == ()


def test_watchdog_enforces_expired_deadline_while_operation_is_queued():
    operation = _operation(heartbeat_age=999, progress_age=999, deadline_age=1)
    operation["state"] = "queued"
    operation["started_at"] = None

    decision = C3WatchdogPolicy().evaluate(operation, now=NOW)

    assert decision.state == "failed"
    assert decision.reason_code == "operation_queue_deadline_exceeded"
    assert decision.actions == ("fail_queued",)
