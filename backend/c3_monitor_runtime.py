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
_MONITOR_ARTIFACT_EXTENSION_TIMEOUT_MS = 3_500
_MONITOR_ARTIFACT_EXTENSION_BUDGET_SECONDS = 18.0
_MONITOR_ARTIFACT_EXTENSION_MAX_ATTEMPTS = 2


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
            attempts: list[dict[str, Any]] | None = None,
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
                if attempts:
                    evidence["collection"]["steps"][step].update(
                        {
                            "attempt_count": len(attempts),
                            "attempts": attempts,
                        }
                    )
                if unavailable and value.get("supported", True):
                    evidence["collection"]["errors"].append(
                        {"step": step, "reason": str(value.get("reason") or "unavailable")[:180]}
                    )

        def direct_extension_read(command_name: str, timeout_ms: int) -> dict[str, Any]:
            payload = manager._bridge_payload(operation, command_name=command_name)
            payload["bridge_timeout_ms"] = timeout_ms
            payload["command_payload"].update(
                {"operationId": operation.operation_id, "allowSubmit": False}
            )
            response = manager.bridge(operation.target, payload)
            return response if isinstance(response, dict) else {}

        extension_deadline = time.monotonic() + _MONITOR_ARTIFACT_EXTENSION_BUDGET_SECONDS
        for section, command_name in (
            ("snapshot", "c3.snapshot_page"),
            ("fields", "c3.inspect_fields"),
            ("validation", "c3.inspect_validation"),
            ("progress", "c3.get_progress"),
        ):
            step = f"extension.{section}"
            start_step(step)
            value, attempts = _bounded_artifact_extension_read(
                lambda _operation, command, timeout_ms: direct_extension_read(command, timeout_ms),
                operation,
                command_name,
                deadline=extension_deadline,
            )
            finish_step(
                step,
                value,
                section=section,
                attempts=attempts,
            )

        with evidence_lock:
            snapshot_value = evidence["snapshot"]
            fields_value = evidence["fields"]
            if snapshot_value.get("ok") is False:
                evidence["collection"]["coherence"] = {
                    "status": "not_evaluated",
                    "reason": "snapshot_unavailable",
                }
            elif fields_value.get("ok") is False:
                evidence["collection"]["coherence"] = {
                    "status": "not_evaluated",
                    "reason": "fields_unavailable",
                }
            elif coherence_reason := _snapshot_fields_coherence_reason(
                snapshot_value,
                fields_value,
            ):
                evidence["collection"]["coherence"] = {
                    "status": "incoherent",
                    "reason": coherence_reason,
                }
                evidence["collection"]["errors"].append(
                    {
                        "step": "extension.snapshot_fields_coherence",
                        "reason": coherence_reason,
                    }
                )
            else:
                evidence["collection"]["coherence"] = {
                    "status": "coherent",
                    "reason": "matching_capture_generation",
                }

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
                "page": snapshot,
                "fields": fields.get("fields") or fields.get("visibleFields") or fields,
                "field_capture": fields,
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
        sub_artifact_errors = list(evidence["collection"]["errors"])
        artifact_status = "partial" if sub_artifact_errors else "completed"
        return {
            "artifact_id": str(result["artifact_id"]),
            "artifact_status": artifact_status,
            "bundle_status": "completed",
            "sub_artifact_status": artifact_status,
            "sub_artifact_errors": sub_artifact_errors,
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


def _bounded_artifact_extension_read(
    read: Any,
    operation: Any,
    command_name: str,
    *,
    deadline: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    attempts: list[dict[str, Any]] = []
    result = _unavailable("artifact_extension_budget_exhausted")
    for attempt_number in range(1, _MONITOR_ARTIFACT_EXTENSION_MAX_ATTEMPTS + 1):
        remaining_ms = max(0, int((deadline - time.monotonic()) * 1000))
        if remaining_ms <= 0:
            break
        timeout_ms = min(_MONITOR_ARTIFACT_EXTENSION_TIMEOUT_MS, remaining_ms)
        started = time.monotonic()
        result = _best_effort_extension_read(
            lambda current_operation, command: read(
                current_operation,
                command,
                timeout_ms,
            ),
            operation,
            command_name,
        )
        reason = str(result.get("reason") or "")[:180]
        attempts.append(
            {
                "attempt": attempt_number,
                "duration_ms": round(max(0.0, time.monotonic() - started) * 1000),
                "reason": reason,
                "status": "unavailable" if result.get("ok") is False else "completed",
                "timeout_ms": timeout_ms,
            }
        )
        if result.get("ok") is not False or not reason.endswith("_timeout"):
            break
    return result, attempts


def _snapshot_fields_coherence_reason(
    snapshot: dict[str, Any],
    fields: dict[str, Any],
) -> str:
    snapshot_generation = _capture_generation(snapshot)
    fields_generation = _capture_generation(fields)
    if not snapshot_generation or not fields_generation:
        return "capture_generation_unproven"
    if snapshot_generation != fields_generation:
        return "capture_generation_mismatch"
    return ""


def _capture_generation(payload: dict[str, Any]) -> str:
    candidates: list[Any] = [payload]
    for key in ("snapshot", "result", "capture"):
        nested = payload.get(key)
        if isinstance(nested, dict):
            candidates.append(nested)
    for candidate in candidates:
        document_generation = candidate.get("documentGeneration") or candidate.get(
            "document_generation"
        )
        if isinstance(document_generation, dict):
            value = (
                document_generation.get("id")
                or document_generation.get("documentId")
                or document_generation.get("document_id")
            )
            if isinstance(value, (str, int)) and str(value).strip():
                return str(value).strip()[:160]
        for key in (
            "captureGeneration",
            "capture_generation",
            "captureId",
            "capture_id",
            "documentId",
            "document_id",
        ):
            value = candidate.get(key)
            if isinstance(value, (str, int)) and str(value).strip():
                return str(value).strip()[:160]
    return ""


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
