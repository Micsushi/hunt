import json
import time

from backend.c3_operation_models import C3OperationRequest
from backend.c3_operations import (
    C3OperationManager,
    C3OperationStore,
    _bridge_review_ready,
    _sanitize_operation_event_payload,
)


def _contains_truncation_marker(value):
    if isinstance(value, dict):
        if value.get("truncated") is True and str(value.get("reason", "")).startswith("event_"):
            return True
        return any(_contains_truncation_marker(child) for child in value.values())
    if isinstance(value, list):
        return any(_contains_truncation_marker(child) for child in value)
    return False


def _oversized_review_response():
    bulk = {
        f"group_{group}": [
            {
                "kind": "review_field",
                "label": f"bounded-label-{group}-{item}",
                "metadata": {"pageKind": "review", "index": item},
            }
            for item in range(128)
        ]
        for group in range(128)
    }
    return {
        "bulk": bulk,
        "ok": False,
        "commandReceipt": {"ok": False, "reason": "final_submit_visible"},
        "stoppedReason": "final_submit_visible",
        "pageWalk": {
            "ok": True,
            "stoppedReason": "final_submit_visible",
            "currentPageNumber": 4,
            "terminalStep": {
                "kind": "safe_next",
                "reason": "final_submit_visible",
                "pageTitle": "Review",
            },
        },
        "submitActivated": False,
    }


def _request():
    return C3OperationRequest(
        command_name="c3.page_walk",
        command_id="cmd-review-ready",
        trace_id="trace-review-ready",
        agent_id="agent-review-ready",
        lane_id="lane-review-ready",
        session_id="session-review-ready",
        lease_id="lease-review-ready",
        browser_target_id="target-review-ready",
        reason="Stop safely at Review.",
        deadline_seconds=30,
        allow_submit=False,
    )


def test_scalar_terminal_leaves_never_become_structured_truncation_markers(
    monkeypatch,
):
    monkeypatch.setattr("backend.c3_operations._EVENT_MAX_NODES", 4)
    payload = {
        "result": {
            "nested": [
                {"value": "one"},
                {"value": "two"},
                {"value": "three"},
            ]
        },
        "terminal_reason": "review_ready",
        "reason": "review_ready",
        "error": "bounded_driver_error",
    }

    sanitized = _sanitize_operation_event_payload(payload)

    assert sanitized["terminal_reason"] == "review_ready"
    assert sanitized["reason"] == "review_ready"
    assert sanitized["error"] == "bounded_driver_error"
    assert all(isinstance(sanitized[key], str) for key in ("terminal_reason", "reason", "error"))
    assert _contains_truncation_marker(sanitized["result"]) is True


def test_oversized_review_safe_stop_completes_with_bounded_result(tmp_path):
    response = _oversized_review_response()
    store = C3OperationStore(tmp_path / "ledger", id_factory=lambda: "op-review-ready")
    manager = C3OperationManager(
        store,
        lease_store=None,
        target_store=None,
        bridge=lambda _target, _payload: response,
        max_workers=2,
    )
    try:
        started = manager.start(_request(), mutates_page=True)
        deadline = time.monotonic() + 5
        operation = manager.get(started.operation_id)
        while not operation.terminal and time.monotonic() < deadline:
            time.sleep(0.01)
            operation = manager.get(started.operation_id)

        assert operation.state == "completed"
        assert operation.terminal_reason == "review_ready"
        assert isinstance(operation.result, dict)
        assert _contains_truncation_marker(operation.result) is True
        assert operation.allow_submit is False

        terminal = next(
            event
            for event in manager.events(operation.operation_id)
            if event.event_type == "operation.completed"
        )
        assert terminal.payload["terminal_reason"] == "review_ready"
        assert isinstance(terminal.payload["result"], dict)
        assert _contains_truncation_marker(terminal.payload["result"]) is True

        serialized = json.dumps(terminal.payload)
        assert "event_node_limit" in serialized
        assert '"submitActivated": false' in serialized
    finally:
        manager.shutdown(wait=True)


def test_review_ready_requires_review_and_submit_proof_from_same_observation():
    response = {
        "ok": False,
        "stoppedReason": "final_submit_visible",
        "observations": [
            {"pageKind": "review"},
            {"finalSubmitVisible": True},
        ],
    }

    assert _bridge_review_ready(response) is False
