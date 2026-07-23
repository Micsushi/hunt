from __future__ import annotations

import asyncio
import base64
import threading
import time
from copy import deepcopy
from typing import Any

from backend.c3_artifacts import C3ArtifactStore
from backend.c3_browser_controls import C3BrowserControlError, run_c3_browser_control
from backend.c3_operation_monitor import C3OperationMonitor
from backend.c3_operations import C3MonitorBridgeError, C3OperationConflictError

_MONITOR_EXTENSION_TIMEOUT_MS = 2_500
_MONITOR_BOUNDARY_TIMEOUT_SECONDS = 3.0
_MONITOR_PROBE_WAIT_SECONDS = 3.25
_MONITOR_DIAGNOSTIC_TIMEOUT_SECONDS = 3.0
_MONITOR_ARTIFACT_ADMISSION_SECONDS = 4.0
_MONITOR_ARTIFACT_EXECUTION_SECONDS = 30.0
_MONITOR_ARTIFACT_RECONCILE_SECONDS = 36.0


def build_c3_operation_monitor(manager: Any) -> C3OperationMonitor:
    artifacts = C3ArtifactStore(manager.store.root)

    def extension_read(operation: Any, command_name: str) -> dict[str, Any]:
        payload = manager._bridge_payload(operation, command_name=command_name)
        payload["bridge_timeout_ms"] = _MONITOR_EXTENSION_TIMEOUT_MS
        payload["command_payload"].update(
            {"operationId": operation.operation_id, "allowSubmit": False}
        )
        response = manager.run_monitor_bridge(
            operation.target,
            payload,
            timeout_seconds=_MONITOR_BOUNDARY_TIMEOUT_SECONDS,
        )
        return response if isinstance(response, dict) else {}

    def progress_probe(operation: Any) -> dict[str, Any]:
        return extension_read(operation, "c3.get_progress")

    def collect_failure_evidence(
        operation: Any,
        evidence: dict[str, Any],
        evidence_lock: threading.Lock,
    ) -> dict[str, Any]:
        step_started: dict[str, float] = {}

        def start_step(step: str) -> None:
            step_started[step] = time.monotonic()
            with evidence_lock:
                evidence["collection"]["steps"][step] = {"status": "running"}

        def finish_step(
            step: str,
            value: dict[str, Any],
            *,
            section: str | None = None,
            browser_action: str | None = None,
        ) -> None:
            unavailable = value.get("ok") is False
            with evidence_lock:
                if section is not None:
                    evidence[section] = value
                if browser_action is not None:
                    evidence["browser"][browser_action] = value
                evidence["collection"]["steps"][step] = {
                    "status": "unavailable" if unavailable else "completed",
                    "duration_ms": round(
                        max(0.0, time.monotonic() - step_started.get(step, time.monotonic())) * 1000
                    ),
                    "reason": str(value.get("reason") or "")[:180],
                }
                if unavailable and value.get("supported", True):
                    evidence["collection"]["errors"].append(
                        {"step": step, "reason": str(value.get("reason") or "unavailable")[:180]}
                    )

        def direct_extension_read(command_name: str) -> dict[str, Any]:
            payload = manager._bridge_payload(operation, command_name=command_name)
            payload["bridge_timeout_ms"] = _MONITOR_EXTENSION_TIMEOUT_MS
            payload["command_payload"].update(
                {"operationId": operation.operation_id, "allowSubmit": False}
            )
            response = manager.bridge(operation.target, payload)
            return response if isinstance(response, dict) else {}

        for section, command_name in (
            ("snapshot", "c3.snapshot_page"),
            ("fields", "c3.inspect_fields"),
            ("validation", "c3.inspect_validation"),
            ("progress", "c3.get_progress"),
        ):
            step = f"extension.{section}"
            start_step(step)
            finish_step(
                step,
                _best_effort_extension_read(
                    lambda _operation, command: direct_extension_read(command),
                    operation,
                    command_name,
                ),
                section=section,
            )

        def browser_step_started(action: str) -> None:
            start_step(f"browser.{action}")

        def browser_step_finished(action: str, value: dict[str, Any]) -> None:
            finish_step(
                f"browser.{action}",
                value,
                browser_action=action,
            )

        _browser_diagnostics(
            operation.target,
            on_start=browser_step_started,
            on_result=browser_step_finished,
        )
        with evidence_lock:
            return deepcopy(evidence)

    def capture(operation: Any, reason_code: str) -> dict[str, str]:
        evidence = _empty_failure_evidence()
        evidence_lock = threading.Lock()
        try:
            manager.run_monitor_artifact_task(
                collect_failure_evidence,
                operation,
                evidence,
                evidence_lock,
                admission_timeout_seconds=_MONITOR_ARTIFACT_ADMISSION_SECONDS,
                timeout_seconds=_MONITOR_ARTIFACT_EXECUTION_SECONDS,
            )
        except C3MonitorBridgeError as exc:
            with evidence_lock:
                evidence["collection"]["errors"].append(
                    {"step": "collection_boundary", "reason": exc.reason_code}
                )
        with evidence_lock:
            evidence = deepcopy(evidence)
        snapshot = evidence["snapshot"]
        fields = evidence["fields"]
        validation = evidence["validation"]
        browser = evidence["browser"]
        screenshot = None
        screenshot_payload = browser.get("screenshot")
        if isinstance(screenshot_payload, dict) and screenshot_payload.get("base64"):
            try:
                screenshot = base64.b64decode(str(screenshot_payload["base64"]), validate=True)
            except ValueError:
                screenshot = None
        retained_events, _events_truncated = manager.store.tail_events(
            operation.operation_id,
            limit=100,
        )
        events = [event.model_dump(mode="json") for event in retained_events]
        result = artifacts.capture_failure_bundle(
            session_id=operation.session_id,
            operation_id=operation.operation_id,
            reason_code=reason_code,
            screenshot=screenshot,
            operation_directory=manager.store.operation_directory(operation.operation_id),
            diagnostics={
                "dom": (browser.get("dom_snapshot") or {}).get("html", ""),
                "fields": fields.get("fields") or fields.get("visibleFields") or fields,
                "validation": validation.get("visibleValidationErrors") or validation,
                "progress": evidence["progress"],
                "console": browser.get("console_tail") or {},
                "network": browser.get("failed_request_tail") or {},
                "health": {
                    "target_health": browser.get("target_health") or {},
                    "artifact_collection": evidence["collection"],
                },
                "events": events,
                "checkpoints": snapshot.get("interactionTrace")
                or snapshot.get("checkpoints")
                or [],
            },
        )
        artifact_status = "partial" if evidence["collection"]["errors"] else "completed"
        return {
            "artifact_id": str(result["artifact_id"]),
            "artifact_status": artifact_status,
        }

    def request_cancel(operation_id: str, reason: str) -> None:
        try:
            manager.cancel(operation_id, reason=reason)
        except C3OperationConflictError:
            return

    return C3OperationMonitor(
        manager.store,
        progress_probe=progress_probe,
        health_probe=lambda operation: manager.run_monitor_task(
            _single_browser_diagnostic,
            operation.target,
            "target_health",
            timeout_seconds=_MONITOR_DIAGNOSTIC_TIMEOUT_SECONDS,
        ),
        artifact_capture=capture,
        artifact_validator=lambda operation, artifact_id: artifacts.validate_failure_bundle(
            session_id=operation.session_id,
            operation_id=operation.operation_id,
            artifact_id=artifact_id,
            operation_directory=manager.store.operation_directory(operation.operation_id),
        ),
        cancel_request=request_cancel,
        max_workers=max(
            2,
            int(getattr(getattr(manager, "executor", None), "_max_workers", 8)),
        ),
        probe_timeout_seconds=_MONITOR_PROBE_WAIT_SECONDS,
        artifact_timeout_seconds=_MONITOR_ARTIFACT_RECONCILE_SECONDS,
    )


def _best_effort_extension_read(read: Any, operation: Any, command_name: str) -> dict[str, Any]:
    try:
        return read(operation, command_name)
    except Exception as exc:
        return {
            "ok": False,
            "available": False,
            "supported": True,
            "reason": f"{type(exc).__name__}:{str(exc)[:180]}",
        }


def _empty_failure_evidence() -> dict[str, Any]:
    return {
        "snapshot": _unavailable("not_collected"),
        "fields": _unavailable("not_collected"),
        "validation": _unavailable("not_collected"),
        "progress": _unavailable("not_collected"),
        "browser": {
            "target_health": _unavailable("not_collected"),
            "dom_snapshot": _unavailable("not_collected"),
            "screenshot": _unavailable("screenshot_redaction_unavailable", supported=False),
            "console_tail": {
                **_unavailable("historical_console_unavailable", supported=False),
                "events": [],
            },
            "failed_request_tail": {
                **_unavailable("historical_network_unavailable", supported=False),
                "events": [],
            },
        },
        "collection": {"steps": {}, "errors": []},
    }


def _unavailable(reason: str, *, supported: bool = True) -> dict[str, Any]:
    return {"ok": False, "available": False, "supported": supported, "reason": reason}


def _browser_diagnostics(
    target: dict[str, Any],
    *,
    on_start: Any | None = None,
    on_result: Any | None = None,
) -> dict[str, Any]:
    async def collect() -> dict[str, Any]:
        result = _empty_failure_evidence()["browser"]
        for action in ("target_health", "dom_snapshot"):
            if on_start is not None:
                on_start(action)
            try:
                result[action] = await run_c3_browser_control(target, action)
            except C3BrowserControlError as exc:
                result[action] = _unavailable(str(exc))
            if on_result is not None:
                on_result(action, result[action])
        return result

    return asyncio.run(collect())


def _single_browser_diagnostic(target: dict[str, Any], action: str) -> dict[str, Any]:
    async def collect() -> dict[str, Any]:
        return await run_c3_browser_control(target, action)

    return asyncio.run(collect())
