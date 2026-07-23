from __future__ import annotations

import inspect
import json
from types import SimpleNamespace

import pytest

from backend.c3_browser_bridge import (
    C3BrowserBridgeError,
    _bounded_bridge_timeout_ms,
    run_c3_extension_command,
)
from backend.c3_monitor_runtime import build_c3_operation_monitor
from backend.c3_operations import C3MonitorArtifactTimeoutError


def test_progress_reads_have_bridge_side_timeout(tmp_path):
    seen = {}

    class Manager:
        store = SimpleNamespace(root=tmp_path)
        executor = SimpleNamespace(_max_workers=2)

        @staticmethod
        def _bridge_payload(_operation, *, command_name):
            return {"command_name": command_name, "command_payload": {}}

        @staticmethod
        def bridge(_target, payload):
            seen.update(payload)
            return {"ok": True}

        @classmethod
        def run_monitor_bridge(cls, target, payload, *, timeout_seconds):
            seen["boundary_timeout_seconds"] = timeout_seconds
            return cls.bridge(target, payload)

        @staticmethod
        def run_monitor_task(callback, *args, timeout_seconds):
            seen["diagnostic_boundary_timeout_seconds"] = timeout_seconds
            return {"ok": True, "reachable": True}

    monitor = build_c3_operation_monitor(Manager())
    try:
        monitor.progress_probe(SimpleNamespace(operation_id="op-1", target={"debug_port": 9222}))
        health = monitor.health_probe(
            SimpleNamespace(operation_id="op-1", target={"debug_port": 9222})
        )
    finally:
        monitor.shutdown(wait=False)

    assert seen["bridge_timeout_ms"] == 2_500
    assert seen["boundary_timeout_seconds"] > 1
    assert monitor.probe_timeout_seconds > seen["boundary_timeout_seconds"]
    assert monitor.artifact_timeout_seconds > 20
    assert seen["diagnostic_boundary_timeout_seconds"] > 1
    assert health["reachable"] is True
    source = inspect.getsource(run_c3_extension_command)
    assert "Promise.race" in source
    assert "bridge_timeout_ms" in source
    assert 'kwargs["timeout"]' in source


def test_browser_bridge_timeout_supports_long_operation_deadlines_but_remains_bounded():
    assert _bounded_bridge_timeout_ms(120_000) == 120_000
    assert _bounded_bridge_timeout_ms(999_999) == 300_000
    source = inspect.getsource(run_c3_extension_command)
    assert "Math.min(300000" in source


def test_browser_bridge_revalidates_exact_cdp_target_before_dispatch():
    source = inspect.getsource(run_c3_extension_command)

    assert 'target.get("target_id")' in source
    assert "chrome.debugger?.getTargets" in source
    assert "registered_target_identity_mismatch" in source
    assert "registered_tab_identity_mismatch" in source


def test_browser_bridge_rejects_mutation_dispatch_without_exact_target_pin():
    with pytest.raises(C3BrowserBridgeError, match="registered_target_identity_missing"):
        run_c3_extension_command(
            {"debug_port": 9222, "extension_id": "ext-1", "tab_id": 7},
            {"command_name": "c3.fill_page", "command_payload": {}},
        )


def test_terminal_capture_persists_validated_partial_bundle_after_collection_timeout(tmp_path):
    operation_directory = (
        tmp_path / "c3" / "sessions" / "2026-07-22" / "session-1" / "operations" / "op-1"
    )
    operation_directory.mkdir(parents=True)

    class Store:
        root = tmp_path

        @staticmethod
        def operation_directory(_operation_id):
            return operation_directory

        @staticmethod
        def tail_events(_operation_id, *, limit):
            assert limit == 100
            return [], False

    class Manager:
        store = Store()
        executor = SimpleNamespace(_max_workers=2)

        @staticmethod
        def run_monitor_artifact_task(*_args, **_kwargs):
            raise C3MonitorArtifactTimeoutError()

    operation = SimpleNamespace(
        operation_id="op-1",
        session_id="session-1",
        target={"debug_port": 9222},
    )
    monitor = build_c3_operation_monitor(Manager())
    try:
        result = monitor.artifact_capture(operation, "operation_failed")
        validated = monitor.artifact_validator(operation, result["artifact_id"])
    finally:
        monitor.shutdown(wait=False)

    assert result["artifact_status"] == "partial"
    assert validated["artifact_id"] == result["artifact_id"]
    artifact_directory = operation_directory / "artifacts" / result["artifact_id"]
    console = json.loads((artifact_directory / "console.json").read_text(encoding="utf-8"))
    network = json.loads((artifact_directory / "network.json").read_text(encoding="utf-8"))
    assert console == {
        "available": False,
        "events": [],
        "ok": False,
        "reason": "historical_console_unavailable",
        "supported": False,
    }
    assert network == {
        "available": False,
        "events": [],
        "ok": False,
        "reason": "historical_network_unavailable",
        "supported": False,
    }
