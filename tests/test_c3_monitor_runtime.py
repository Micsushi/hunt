from __future__ import annotations

import inspect
import json
from types import SimpleNamespace

import pytest

import backend.c3_monitor_runtime as c3_monitor_runtime
from backend.c3_browser_bridge import (
    C3BrowserBridgeError,
    _bounded_bridge_timeout_ms,
    run_c3_extension_command,
)
from backend.c3_monitor_runtime import build_c3_operation_monitor
from backend.c3_operations import C3MonitorArtifactTimeoutError


def _artifact_capture_manager(
    tmp_path,
    *,
    field_responses,
    monkeypatch,
    snapshot_response=None,
):
    operation_directory = (
        tmp_path / "c3" / "sessions" / "2026-07-26" / "session-1" / "operations" / "op-1"
    )
    operation_directory.mkdir(parents=True)
    field_responses = list(field_responses)
    seen_payloads = []

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
        def _bridge_payload(_operation, *, command_name):
            return {"command_name": command_name, "command_payload": {}}

        @staticmethod
        def bridge(_target, payload):
            seen_payloads.append(dict(payload))
            command_name = payload["command_name"]
            if command_name == "c3.inspect_fields":
                response = field_responses.pop(0)
                if response.get("ok") is not False:
                    response = {"captureGeneration": "capture-1", **response}
                return response
            if command_name == "c3.snapshot_page":
                return snapshot_response or {
                    "ok": True,
                    "captureGeneration": "capture-1",
                    "href": "https://tenant.test/apply",
                }
            if command_name == "c3.inspect_validation":
                return {"ok": True, "visibleValidationErrors": []}
            return {"ok": True, "phase": "failed"}

        @staticmethod
        def run_monitor_artifact_task(callback, *args, **_kwargs):
            return callback(*args)

    def browser_diagnostics(_target, *, on_start, on_result):
        result = c3_monitor_runtime._empty_failure_evidence()["browser"]
        for action, value in (
            ("target_health", {"ok": True, "reachable": True}),
            ("dom_snapshot", {"ok": True, "html": "<main><input required></main>"}),
        ):
            on_start(action)
            result[action] = value
            on_result(action, value)
        return result

    monkeypatch.setattr(c3_monitor_runtime, "_browser_diagnostics", browser_diagnostics)
    return Manager(), operation_directory, seen_payloads


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


def test_terminal_capture_retries_timed_out_field_inventory_within_budget(tmp_path, monkeypatch):
    manager, operation_directory, seen_payloads = _artifact_capture_manager(
        tmp_path,
        field_responses=[
            {"ok": False, "reason": "bridge_command_timeout"},
            {
                "ok": True,
                "fields": [
                    {
                        "label": "How Did You Hear About Us?",
                        "kind": "combobox",
                        "required": True,
                    }
                ],
            },
        ],
        monkeypatch=monkeypatch,
    )
    operation = SimpleNamespace(
        operation_id="op-1",
        session_id="session-1",
        target={"debug_port": 9222},
    )
    monitor = build_c3_operation_monitor(manager)
    try:
        result = monitor.artifact_capture(operation, "operation_failed")
    finally:
        monitor.shutdown(wait=False)

    field_payloads = [
        payload for payload in seen_payloads if payload["command_name"] == "c3.inspect_fields"
    ]
    assert len(field_payloads) == 2
    assert sum(payload["bridge_timeout_ms"] for payload in field_payloads) <= 8_000
    assert result["artifact_status"] == "completed"
    assert result["bundle_status"] == "completed"
    assert result["sub_artifact_status"] == "completed"

    artifact_directory = operation_directory / "artifacts" / result["artifact_id"]
    fields = json.loads((artifact_directory / "fields.json").read_text(encoding="utf-8"))
    field_capture = json.loads(
        (artifact_directory / "field_capture.json").read_text(encoding="utf-8")
    )
    health = json.loads((artifact_directory / "health.json").read_text(encoding="utf-8"))
    assert fields == [
        {
            "kind": "combobox",
            "label": "How Did You Hear About Us?",
            "required": True,
        }
    ]
    assert field_capture["captureGeneration"] == "capture-1"
    assert field_capture["fields"] == fields
    assert health["artifact_collection"]["steps"]["extension.fields"]["attempt_count"] == 2
    assert health["artifact_collection"]["steps"]["extension.fields"]["status"] == "completed"


def test_terminal_capture_marks_sub_artifact_partial_after_bounded_retries(tmp_path, monkeypatch):
    manager, operation_directory, seen_payloads = _artifact_capture_manager(
        tmp_path,
        field_responses=[
            {"ok": False, "reason": "bridge_command_timeout"},
            {"ok": False, "reason": "bridge_command_timeout"},
        ],
        monkeypatch=monkeypatch,
    )
    operation = SimpleNamespace(
        operation_id="op-1",
        session_id="session-1",
        target={"debug_port": 9222},
    )
    monitor = build_c3_operation_monitor(manager)
    try:
        result = monitor.artifact_capture(operation, "operation_failed")
    finally:
        monitor.shutdown(wait=False)

    field_payloads = [
        payload for payload in seen_payloads if payload["command_name"] == "c3.inspect_fields"
    ]
    assert len(field_payloads) == 2
    assert sum(payload["bridge_timeout_ms"] for payload in field_payloads) <= 8_000
    assert result["artifact_status"] == "partial"
    assert result["bundle_status"] == "completed"
    assert result["sub_artifact_status"] == "partial"
    assert result["sub_artifact_errors"] == [
        {"step": "extension.fields", "reason": "bridge_command_timeout"}
    ]

    artifact_directory = operation_directory / "artifacts" / result["artifact_id"]
    health = json.loads((artifact_directory / "health.json").read_text(encoding="utf-8"))
    field_step = health["artifact_collection"]["steps"]["extension.fields"]
    assert field_step["attempt_count"] == 2
    assert field_step["status"] == "unavailable"
    assert health["artifact_collection"]["coherence"] == {
        "reason": "fields_unavailable",
        "status": "not_evaluated",
    }
    assert [attempt["reason"] for attempt in field_step["attempts"]] == [
        "bridge_command_timeout",
        "bridge_command_timeout",
    ]


def test_terminal_capture_marks_mixed_snapshot_and_field_generation_incoherent(
    tmp_path, monkeypatch
):
    manager, operation_directory, _seen_payloads = _artifact_capture_manager(
        tmp_path,
        snapshot_response={
            "ok": True,
            "captureGeneration": "snapshot-generation",
            "snapshot": {
                "href": "https://tenant.test/login",
                "workflow": {"authUiState": "landing_choice"},
                "readiness": {"authFieldCount": 0},
            },
        },
        field_responses=[
            {
                "ok": True,
                "captureGeneration": "fields-generation",
                "fields": [
                    {
                        "label": "Email Address",
                        "type": "text",
                        "autocomplete": "email",
                    },
                    {
                        "label": "Password",
                        "type": "password",
                        "autocomplete": "current-password",
                    },
                ],
            }
        ],
        monkeypatch=monkeypatch,
    )
    operation = SimpleNamespace(
        operation_id="op-1",
        session_id="session-1",
        target={"debug_port": 9222},
    )
    monitor = build_c3_operation_monitor(manager)
    try:
        result = monitor.artifact_capture(operation, "operation_failed")
    finally:
        monitor.shutdown(wait=False)

    assert result["artifact_status"] == "partial"
    assert result["sub_artifact_errors"] == [
        {
            "step": "extension.snapshot_fields_coherence",
            "reason": "capture_generation_mismatch",
        }
    ]
    artifact_directory = operation_directory / "artifacts" / result["artifact_id"]
    page = json.loads((artifact_directory / "page.json").read_text(encoding="utf-8"))
    fields = json.loads((artifact_directory / "fields.json").read_text(encoding="utf-8"))
    health = json.loads((artifact_directory / "health.json").read_text(encoding="utf-8"))
    assert page["captureGeneration"] == "snapshot-generation"
    assert [field["label"] for field in fields] == ["Email Address", "Password"]
    assert health["artifact_collection"]["coherence"] == {
        "reason": "capture_generation_mismatch",
        "status": "incoherent",
    }


def test_capture_generation_accepts_extension_document_generation_metadata():
    generation = {
        "schemaVersion": 1,
        "id": "nav-ms2b2a0n",
        "navigationStartMs": 1785101029943,
    }

    assert (
        c3_monitor_runtime._capture_generation({"snapshot": {"documentGeneration": generation}})
        == "nav-ms2b2a0n"
    )
    assert (
        c3_monitor_runtime._capture_generation({"documentGeneration": generation}) == "nav-ms2b2a0n"
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
