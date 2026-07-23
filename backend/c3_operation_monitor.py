from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import Any

from backend.c3_watchdog import C3WatchdogPolicy

ProgressProbe = Callable[[Any], dict[str, Any]]
HealthProbe = Callable[[Any], dict[str, Any]]
ArtifactCapture = Callable[[Any, str], Any]
ArtifactValidator = Callable[[Any, str], Any]
CancelRequest = Callable[[str, str], Any]


class C3OperationMonitor:
    """Poll extension liveness independently from the command's blocking worker."""

    def __init__(
        self,
        store: Any,
        *,
        progress_probe: ProgressProbe,
        health_probe: HealthProbe | None = None,
        artifact_capture: ArtifactCapture,
        cancel_request: CancelRequest,
        artifact_validator: ArtifactValidator | None = None,
        watchdog: C3WatchdogPolicy | None = None,
        interval_seconds: float = 2,
        max_workers: int = 8,
        probe_workers: int | None = None,
        cancel_ack_timeout_seconds: float = 10,
        cancel_reconcile_timeout_seconds: float = 30,
        probe_timeout_seconds: float = 1,
        artifact_timeout_seconds: float = 5,
        checkpoint_cooldown_seconds: float = 30,
    ) -> None:
        self.store = store
        self.progress_probe = progress_probe
        self.health_probe = health_probe
        self.artifact_capture = artifact_capture
        self.artifact_validator = artifact_validator
        self.cancel_request = cancel_request
        self.watchdog = watchdog or C3WatchdogPolicy()
        self.interval_seconds = max(0.05, float(interval_seconds))
        self.cancel_ack_timeout_seconds = max(0.1, float(cancel_ack_timeout_seconds))
        self.cancel_reconcile_timeout_seconds = max(0.1, float(cancel_reconcile_timeout_seconds))
        self.probe_timeout_seconds = max(0.01, float(probe_timeout_seconds))
        self.artifact_timeout_seconds = max(0.01, float(artifact_timeout_seconds))
        self.checkpoint_cooldown_seconds = max(0.0, float(checkpoint_cooldown_seconds))
        poll_workers = max(1, int(max_workers))
        probe_worker_count = max(1, int(probe_workers or poll_workers))
        self.executor = ThreadPoolExecutor(
            max_workers=poll_workers, thread_name_prefix="c3-monitor"
        )
        self.probe_executor = ThreadPoolExecutor(
            max_workers=probe_worker_count, thread_name_prefix="c3-monitor-probe"
        )
        self._poll_slots = threading.BoundedSemaphore(poll_workers)
        self._probe_slots = threading.BoundedSemaphore(probe_worker_count)
        self._stop = threading.Event()
        self._captured: set[tuple[str, str]] = set()
        self._checkpoint_at: dict[str, float] = {}
        self._pending_probes: dict[str, Future[Any]] = {}
        self._pending_health_probes: dict[str, Future[Any]] = {}
        self._probe_timeout_reported: set[str] = set()
        self._health_timeout_reported: set[str] = set()
        self._tracked: set[str] = set()
        self._inflight: set[str] = set()
        self._lock = threading.RLock()
        self._scheduler = threading.Thread(
            target=self._schedule,
            name="c3-monitor-scheduler",
            daemon=True,
        )
        self._scheduler.start()

    def track(self, operation_id: str) -> None:
        with self._lock:
            self._tracked.add(operation_id)

    def poll_once(self, operation_id: str) -> Any:
        operation = self.store.get(operation_id)
        if operation.terminal:
            self._finish_terminal(operation)
            return operation
        progress: dict[str, Any] = {}
        progress, probe_error = self._bounded_progress_probe(operation)
        operation = self.store.get(operation_id)
        if operation.terminal:
            self._finish_terminal(operation)
            return operation
        if probe_error is not None:
            self.store.append(
                operation_id,
                "operation.health_probe_failed",
                {"error": probe_error},
            )
        if progress:
            self._record_progress(operation_id, operation, progress)
        operation = self.store.get(operation_id)
        if operation.terminal:
            self._finish_terminal(operation)
            return operation
        if operation.state == "cancelling":
            if operation.cancel_failed_at is not None:
                if self._cancel_reconciliation_expired(operation):
                    terminal = self._append_if_nonterminal(
                        operation_id,
                        "operation.orphaned",
                        {
                            "terminal_reason": "control_plane_cancel_unreconciled",
                            "error": {"reason_code": "control_plane_cancel_unreconciled"},
                        },
                        expected_states={"cancelling"},
                    )
                    current = self.store.get(operation_id)
                    if terminal is not None or current.terminal:
                        self._cleanup_operation(operation_id)
                    return current
                monitor_error = getattr(operation, "monitor_error", None)
                error = (
                    monitor_error
                    if isinstance(monitor_error, dict)
                    else operation.error
                    if isinstance(operation.error, dict)
                    else {}
                )
                self._capture_once(
                    operation,
                    str(error.get("reason_code") or "cancellation_failed"),
                )
                return operation
            self._check_cancel_ack_timeout(operation)
            return operation

        decision = self.watchdog.evaluate(operation)
        if "fail_queued" in decision.actions:
            self._append_if_nonterminal(
                operation_id,
                "operation.failed",
                {
                    "terminal_reason": decision.reason_code,
                    "error": {"reason_code": decision.reason_code},
                },
                expected_states={"queued"},
            )
            current = self.store.get(operation_id)
            if current.terminal:
                self._finish_terminal(current)
            return current
        if (
            operation.state != "queued"
            and decision.state != operation.state
            and decision.state
            in {
                "running",
                "slow",
                "suspected_stall",
                "stalled",
            }
        ):
            event_type = {
                "running": "operation.started",
                "slow": "operation.slow",
                "suspected_stall": "operation.suspected_stall",
                "stalled": "operation.stalled",
            }[decision.state]
            appended = self._append_if_nonterminal(
                operation_id,
                event_type,
                {
                    "state": decision.state,
                    "reason": decision.reason_code,
                    "heartbeat_age_seconds": decision.heartbeat_age_seconds,
                    "progress_age_seconds": decision.progress_age_seconds,
                },
                expected_states={operation.state},
            )
            operation = self.store.get(operation_id)
            if appended is None:
                if operation.terminal:
                    self._finish_terminal(operation)
                return operation
        if "capture_checkpoint" in decision.actions:
            expected_state = operation.state
            captured = self._capture_checkpoint(
                operation_id,
                decision.reason_code,
                expected_state=expected_state,
            )
            operation = self.store.get(operation_id)
            if operation.terminal:
                self._finish_terminal(operation)
                return operation
            if not captured or operation.state != expected_state:
                return operation
        if "health_probe" in decision.actions:
            self._run_health_probe(operation)
            operation = self.store.get(operation_id)
            if operation.terminal:
                self._finish_terminal(operation)
                return operation
        if "request_cancel" in decision.actions:
            self.cancel_request(operation_id, decision.reason_code)
        if "capture_failure_bundle" in decision.actions:
            self._capture_once(operation, decision.reason_code)
        return self.store.get(operation_id)

    def _cancel_reconciliation_expired(self, operation: Any) -> bool:
        if operation.cancel_failed_at is None:
            return False
        anchor = getattr(operation, "cancel_requested_at", None) or operation.cancel_failed_at
        anchor = anchor if anchor.tzinfo else anchor.replace(tzinfo=UTC)
        return (datetime.now(UTC) - anchor).total_seconds() >= self.cancel_reconcile_timeout_seconds

    def shutdown(self, *, wait: bool = True) -> None:
        self._stop.set()
        if self._scheduler.is_alive():
            self._scheduler.join(timeout=max(0.1, self.interval_seconds * 2))
        self.executor.shutdown(wait=wait, cancel_futures=not wait)
        self.probe_executor.shutdown(wait=wait, cancel_futures=not wait)

    def _schedule(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            with self._lock:
                ready = sorted(self._tracked - self._inflight)
            for operation_id in ready:
                if not self._poll_slots.acquire(blocking=False):
                    break
                with self._lock:
                    if operation_id not in self._tracked or operation_id in self._inflight:
                        self._poll_slots.release()
                        continue
                    self._inflight.add(operation_id)
                try:
                    future = self.executor.submit(self._poll_tracked, operation_id)
                except RuntimeError:
                    with self._lock:
                        self._inflight.discard(operation_id)
                    self._poll_slots.release()
                    return
                future.add_done_callback(
                    lambda completed, op_id=operation_id: self._poll_finished(op_id, completed)
                )

    def _poll_tracked(self, operation_id: str) -> bool:
        try:
            return bool(self.poll_once(operation_id).terminal)
        except FileNotFoundError:
            return True
        except Exception as exc:
            try:
                self.store.append(
                    operation_id,
                    "operation.monitor_failed",
                    {"error": {"type": type(exc).__name__, "message": str(exc)[:240]}},
                )
            except Exception:
                pass
            return False

    def _poll_finished(self, operation_id: str, future: Future[bool]) -> None:
        terminal = False
        try:
            terminal = bool(future.result())
        except Exception:
            terminal = False
        with self._lock:
            self._inflight.discard(operation_id)
            if terminal:
                self._tracked.discard(operation_id)
        self._poll_slots.release()
        if terminal:
            self._cleanup_operation(operation_id)

    def _submit_probe(self, callback: Callable[..., Any], *args: Any) -> Future[Any] | None:
        if not self._probe_slots.acquire(blocking=False):
            return None
        try:
            future = self.probe_executor.submit(callback, *args)
        except RuntimeError:
            self._probe_slots.release()
            return None
        future.add_done_callback(lambda _completed: self._probe_slots.release())
        return future

    def _append_if_nonterminal(
        self,
        operation_id: str,
        event_type: str,
        payload: dict[str, Any],
        *,
        expected_states: set[str] | None = None,
    ) -> Any:
        conditional_append = getattr(self.store, "append_if_nonterminal", None)
        if callable(conditional_append):
            return conditional_append(
                operation_id,
                event_type,
                payload,
                expected_states=expected_states,
            )
        operation = self.store.get(operation_id)
        if operation.terminal:
            return None
        if expected_states is not None and operation.state not in expected_states:
            return None
        return self.store.append(operation_id, event_type, payload)

    def _cleanup_operation(self, operation_id: str) -> None:
        with self._lock:
            self._tracked.discard(operation_id)
            self._pending_probes.pop(operation_id, None)
            self._pending_health_probes.pop(operation_id, None)
            self._probe_timeout_reported.discard(operation_id)
            self._health_timeout_reported.discard(operation_id)
            self._checkpoint_at.pop(operation_id, None)
            self._captured = {key for key in self._captured if key[0] != operation_id}

    def _finish_terminal(self, operation: Any) -> None:
        if operation.state == "failed":
            self._capture_once(operation, "operation_failed")
        self._cleanup_operation(operation.operation_id)

    def _clear_completed_pending(
        self,
        pending: dict[str, Future[Any]],
        operation_id: str,
        completed: Future[Any],
    ) -> None:
        with self._lock:
            if pending.get(operation_id) is completed:
                pending.pop(operation_id, None)

    def _bounded_progress_probe(
        self, operation: Any
    ) -> tuple[dict[str, Any], dict[str, str] | None]:
        operation_id = operation.operation_id
        with self._lock:
            future = self._pending_probes.get(operation_id)
            if future is None:
                future = self._submit_probe(self.progress_probe, operation)
                if future is not None:
                    self._pending_probes[operation_id] = future
                    future.add_done_callback(
                        lambda completed, op_id=operation_id: self._clear_completed_pending(
                            self._pending_probes, op_id, completed
                        )
                    )
        if future is None:
            with self._lock:
                first_timeout = operation_id not in self._probe_timeout_reported
                self._probe_timeout_reported.add(operation_id)
            return (
                ({}, {"type": "CapacityError", "message": "progress_probe_capacity_exhausted"})
                if first_timeout
                else ({}, None)
            )
        try:
            result = future.result(timeout=self.probe_timeout_seconds)
        except TimeoutError:
            with self._lock:
                first_timeout = operation_id not in self._probe_timeout_reported
                self._probe_timeout_reported.add(operation_id)
            if not first_timeout:
                return {}, None
            return {}, {
                "type": "TimeoutError",
                "message": "progress_probe_timeout",
            }
        except Exception as exc:
            with self._lock:
                self._pending_probes.pop(operation_id, None)
                self._probe_timeout_reported.discard(operation_id)
            return {}, {"type": type(exc).__name__, "message": str(exc)[:240]}
        with self._lock:
            self._pending_probes.pop(operation_id, None)
            self._probe_timeout_reported.discard(operation_id)
        return (dict(result) if isinstance(result, dict) else {}), None

    def _capture_checkpoint(
        self, operation_id: str, reason_code: str, *, expected_state: str
    ) -> bool:
        now = time.monotonic()
        with self._lock:
            previous = self._checkpoint_at.get(operation_id)
            if previous is not None and now - previous < self.checkpoint_cooldown_seconds:
                return True
            self._checkpoint_at[operation_id] = now
        appended = self._append_if_nonterminal(
            operation_id,
            "operation.checkpoint",
            {"reason": reason_code},
            expected_states={expected_state},
        )
        if appended is None:
            with self._lock:
                if self._checkpoint_at.get(operation_id) == now:
                    self._checkpoint_at.pop(operation_id, None)
            return False
        return True

    def _run_health_probe(self, operation: Any) -> None:
        if self.health_probe is None:
            current = self.store.get(operation.operation_id)
            if current.terminal:
                self._cleanup_operation(operation.operation_id)
                return
            self.store.append(
                operation.operation_id,
                "operation.health_probe_failed",
                {"error": {"type": "Unsupported", "message": "health_probe_unavailable"}},
            )
            return
        operation_id = operation.operation_id
        with self._lock:
            future = self._pending_health_probes.get(operation_id)
            if future is None:
                future = self._submit_probe(self.health_probe, operation)
                if future is not None:
                    self._pending_health_probes[operation_id] = future
                    future.add_done_callback(
                        lambda completed, op_id=operation_id: self._clear_completed_pending(
                            self._pending_health_probes, op_id, completed
                        )
                    )
        if future is None:
            with self._lock:
                first_timeout = operation_id not in self._health_timeout_reported
                self._health_timeout_reported.add(operation_id)
            if first_timeout:
                current = self.store.get(operation_id)
                if current.terminal:
                    self._cleanup_operation(operation_id)
                    return
                self.store.append(
                    operation_id,
                    "operation.health_probe_failed",
                    {
                        "error": {
                            "type": "CapacityError",
                            "message": "health_probe_capacity_exhausted",
                        }
                    },
                )
            return
        try:
            result = future.result(timeout=self.probe_timeout_seconds)
        except TimeoutError:
            with self._lock:
                first_timeout = operation_id not in self._health_timeout_reported
                self._health_timeout_reported.add(operation_id)
            if first_timeout:
                current = self.store.get(operation_id)
                if current.terminal:
                    self._cleanup_operation(operation_id)
                    return
                self.store.append(
                    operation_id,
                    "operation.health_probe_failed",
                    {"error": {"type": "TimeoutError", "message": "health_probe_timeout"}},
                )
            return
        except Exception as exc:
            with self._lock:
                self._pending_health_probes.pop(operation_id, None)
                self._health_timeout_reported.discard(operation_id)
            current = self.store.get(operation_id)
            if current.terminal:
                self._cleanup_operation(operation_id)
                return
            self.store.append(
                operation_id,
                "operation.health_probe_failed",
                {"error": {"type": type(exc).__name__, "message": str(exc)[:240]}},
            )
            return
        with self._lock:
            self._pending_health_probes.pop(operation_id, None)
            self._health_timeout_reported.discard(operation_id)
        current = self.store.get(operation_id)
        if current.terminal:
            self._cleanup_operation(operation_id)
            return
        self.store.append(
            operation_id,
            "operation.health_probe_completed",
            {"result": result or {}},
        )

    def _record_progress(self, operation_id: str, operation: Any, progress: dict[str, Any]) -> None:
        operation = self.store.get(operation_id)
        if operation.terminal:
            self._cleanup_operation(operation_id)
            return
        reported_id = str(progress.get("operationId") or progress.get("operation_id") or "")
        if reported_id and reported_id != operation_id:
            self._append_if_nonterminal(
                operation_id,
                "operation.stale_progress_ignored",
                {"reported_operation_id": reported_id},
                expected_states={operation.state},
            )
            current = self.store.get(operation_id)
            if current.terminal:
                self._cleanup_operation(operation_id)
            return
        heartbeat_seq = int(progress.get("heartbeatSeq") or progress.get("heartbeat_seq") or 0)
        progress_seq = int(progress.get("progressSeq") or progress.get("progress_seq") or 0)
        if heartbeat_seq > operation.heartbeat_seq:
            self.store.append(
                operation_id,
                "operation.heartbeat",
                {
                    "heartbeat_seq": heartbeat_seq,
                    "phase": str(progress.get("phase") or operation.phase),
                },
            )
            operation = self.store.get(operation_id)
            if operation.terminal:
                self._cleanup_operation(operation_id)
                return
        if progress_seq > operation.progress_seq:
            self.store.append(
                operation_id,
                "operation.progress",
                {
                    "progress_seq": progress_seq,
                    "phase": str(progress.get("phase") or ""),
                    "substep": str(progress.get("substep") or ""),
                    "field": {
                        "key": str(progress.get("fieldKey") or ""),
                        "label": str(progress.get("fieldLabel") or "")[:240],
                        "kind": str(progress.get("fieldKind") or ""),
                        "attempt": int(progress.get("attempt") or 0),
                        "pending_action": str(progress.get("pendingAction") or "")[:240],
                        "popup_owner": str(progress.get("popupOwner") or "")[:240],
                    },
                },
            )
        if progress.get("cancelAcknowledgedAt") or progress.get("cancel_acknowledged_at"):
            current = self.store.get(operation_id)
            if current.state == "cancelling" and current.cancel_acknowledged_at is None:
                acknowledged = self._append_if_nonterminal(
                    operation_id,
                    "operation.cancel_acknowledged",
                    {"reason": "driver_unwound"},
                    expected_states={"cancelling"},
                )
                if acknowledged is None:
                    current = self.store.get(operation_id)
                    if current.terminal:
                        self._cleanup_operation(operation_id)
                    return
                cancelled = self._append_if_nonterminal(
                    operation_id,
                    "operation.cancelled",
                    {"terminal_reason": current.cancellation_reason or "agent_cancel"},
                    expected_states={"cancelling"},
                )
                if cancelled is None:
                    current = self.store.get(operation_id)
                    if current.terminal:
                        self._cleanup_operation(operation_id)

    def _capture_once(self, operation: Any, reason_code: str) -> None:
        key = (operation.operation_id, reason_code)
        with self._lock:
            if key in self._captured:
                return
            self._captured.add(key)
        future = self._submit_probe(self.artifact_capture, operation, reason_code)
        if future is None:
            self.store.append(
                operation.operation_id,
                "operation.artifact_capture_failed",
                {
                    "reason": reason_code,
                    "error": {
                        "type": "CapacityError",
                        "message": "artifact_capture_capacity_exhausted",
                    },
                },
            )
            return
        future.add_done_callback(
            lambda completed: self._artifact_capture_completed(operation, reason_code, completed)
        )
        try:
            future.result(timeout=self.artifact_timeout_seconds)
        except TimeoutError:
            self.store.append(
                operation.operation_id,
                "operation.artifact_capture_failed",
                {
                    "reason": reason_code,
                    "error": {"type": "TimeoutError", "message": "artifact_capture_timeout"},
                },
            )
            return
        except Exception as exc:
            self.store.append(
                operation.operation_id,
                "operation.artifact_capture_failed",
                {
                    "reason": reason_code,
                    "error": {"type": type(exc).__name__, "message": str(exc)[:240]},
                },
            )
            return

    def _artifact_capture_completed(
        self,
        operation: Any,
        reason_code: str,
        future: Future[Any],
    ) -> None:
        try:
            artifact_id = future.result()
        except Exception:
            return
        self._link_artifact(operation, reason_code, artifact_id)

    def _link_artifact(self, operation: Any, reason_code: str, artifact_id: Any) -> None:
        artifact_status = "completed"
        if isinstance(artifact_id, Mapping):
            artifact_status = str(artifact_id.get("artifact_status") or "completed").lower()
            artifact_id = artifact_id.get("artifact_id")
        artifact_id = str(artifact_id or "")
        if not artifact_id or len(artifact_id) > 240:
            return
        try:
            if self.artifact_validator is not None:
                valid = self.artifact_validator(operation, artifact_id)
                if valid is False or valid is None:
                    raise ValueError("artifact_manifest_invalid")
        except Exception:
            self.store.append(
                operation.operation_id,
                "operation.artifact_capture_failed",
                {
                    "reason": reason_code,
                    "artifact_id": artifact_id,
                    "late_completion": True,
                    "error": {
                        "type": "ValueError",
                        "message": "artifact_manifest_invalid",
                    },
                },
            )
            return
        append_artifact = getattr(self.store, "append_artifact", None)
        if callable(append_artifact):
            append_artifact(
                operation.operation_id,
                artifact_id,
                reason=reason_code,
                late_completion=True,
            )
        else:
            current = self.store.get(operation.operation_id)
            artifact_ids = list(current.artifact_ids)
            if artifact_id not in artifact_ids:
                artifact_ids.append(artifact_id)
                self.store.append(
                    operation.operation_id,
                    "operation.artifact_captured",
                    {
                        "artifact_ids": artifact_ids,
                        "reason": reason_code,
                        "late_completion": True,
                    },
                )
        if artifact_status == "partial":
            self.store.append(
                operation.operation_id,
                "operation.artifact_capture_partial",
                {
                    "artifact_ids": [artifact_id],
                    "reason": reason_code,
                    "late_completion": True,
                },
            )

    def _check_cancel_ack_timeout(self, operation: Any) -> None:
        pending_at = operation.cancel_pending_at
        if (
            pending_at is None
            or operation.cancel_failed_at is not None
            or operation.cancel_acknowledged_at is not None
        ):
            return
        pending_at = pending_at if pending_at.tzinfo else pending_at.replace(tzinfo=UTC)
        if (datetime.now(UTC) - pending_at).total_seconds() < self.cancel_ack_timeout_seconds:
            return
        reason = "cancel_acknowledgement_timeout"
        retry_after = datetime.now(UTC) + timedelta(seconds=1)
        self.store.append(
            operation.operation_id,
            "operation.cancel_failed",
            {
                "cancel_attempt_id": operation.cancel_attempt_id,
                "cancel_attempt_count": operation.cancel_attempt_count,
                "reason": reason,
                "error": {"reason_code": reason},
                "retry_after": retry_after.isoformat().replace("+00:00", "Z"),
            },
        )
        self._capture_once(operation, reason)
