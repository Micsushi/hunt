from __future__ import annotations

import hashlib
import time
import uuid
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit, urlunsplit

from backend.c3_identifiers import is_trusted_generated_c3_id

from .classifier import classify_operation
from .planner import LanePlan
from .report import BatchReport, LaneResult, utc_now

TERMINAL_STATES = {"completed", "failed", "cancelled", "orphaned"}
CANCEL_RECONCILIATION_WAIT_SECONDS = 35
FAILURE_CONTEXT_REFRESH_ATTEMPTS = 75
FAILURE_CONTEXT_REFRESH_INTERVAL_SECONDS = 0.5
FAILURE_EVIDENCE_TAIL_LIMIT = 16
FAILURE_ARTIFACT_SUMMARY_LIMIT = 32
ARTIFACT_PATH_LIMIT = 32
ARTIFACT_PATH_CHARACTER_LIMIT = 2_000


class ResumeOperationIdentityError(RuntimeError):
    pass


class McpClient(Protocol):
    def get_session_log(self, payload: dict[str, Any]) -> Any: ...

    def bootstrap_lane(self, payload: dict[str, Any]) -> Any: ...

    def page_walk(self, payload: dict[str, Any]) -> Any: ...

    def wait_for_operation_event(self, payload: dict[str, Any]) -> Any: ...

    def get_c3_operation(self, payload: dict[str, Any]) -> Any: ...

    def get_c3_failure_context(self, payload: dict[str, Any]) -> Any: ...

    def cancel_c3_operation(self, payload: dict[str, Any]) -> Any: ...

    def finish_lane(self, payload: dict[str, Any]) -> Any: ...

    def fail_lane(self, payload: dict[str, Any]) -> Any: ...


class C3BatchSupervisor:
    def __init__(
        self,
        *,
        client_factory: Callable[[], McpClient],
        prepare_lane: Callable[[LanePlan], dict[str, Any]],
        now: Callable[[], float] = time.monotonic,
        wall_now: Callable[[], datetime] = lambda: datetime.now(UTC),
        sleep: Callable[[float], None] = time.sleep,
        checkpoint: Callable[[LanePlan, dict[str, Any]], None] | None = None,
    ) -> None:
        self.client_factory = client_factory
        self.prepare_lane = prepare_lane
        self.now = now
        self.wall_now = wall_now
        self.sleep = sleep
        self.checkpoint = checkpoint

    def run(
        self,
        lanes: Iterable[LanePlan],
        *,
        max_concurrency: int = 5,
        resume_states: dict[str, dict[str, Any]] | None = None,
    ) -> BatchReport:
        lane_list = list(lanes)
        _validate_lanes(lane_list)
        if not lane_list:
            raise ValueError("no_lanes")
        concurrency = min(max(1, int(max_concurrency)), len(lane_list), 6)
        started_at = utc_now()
        results: list[LaneResult] = []
        with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="c3-lane") as pool:
            futures = {
                pool.submit(
                    self._run_lane,
                    lane,
                    (resume_states or {}).get(lane.session_id),
                ): lane
                for lane in lane_list
            }
            for future in as_completed(futures):
                results.append(future.result())
        results.sort(
            key=lambda item: next(lane.index for lane in lane_list if lane.lane_id == item.lane_id)
        )
        return BatchReport(
            batch_id=lane_list[0].batch_id,
            lanes=tuple(results),
            started_at=started_at,
            completed_at=utc_now(),
            metadata={
                "max_concurrency": concurrency,
                "source_of_truth": "c3_operation_ledger",
                "allow_submit": False,
                "allow_foreground": False,
            },
        )

    def _run_lane(self, lane: LanePlan, resume_state: dict[str, Any] | None = None) -> LaneResult:
        client = self.client_factory()
        resume_state = resume_state or {}
        lease_id = str(resume_state.get("lease_id") or "")
        operation_id = str(resume_state.get("operation_id") or "")
        command_id = str(resume_state.get("command_id") or "")
        trace_id = str(resume_state.get("trace_id") or "")
        pinned_target = (
            dict(resume_state.get("target")) if isinstance(resume_state.get("target"), dict) else {}
        )
        operation = (
            dict(resume_state.get("operation"))
            if isinstance(resume_state.get("operation"), dict)
            else {}
        )
        event_ids = list(_string_tuple(resume_state.get("event_ids")))
        after_seq = max(0, int(resume_state.get("after_seq") or 0))
        cancel_requested = False
        terminal_sent = False
        classification_hint = ""
        failure_context: dict[str, Any] = {}
        failure_context_status = "not_requested"
        failure_context_error = ""
        failure_context_fetched = False
        existing_terminal: dict[str, Any] = {}
        try:
            if not lease_id and not operation_id:
                existing_terminal = _existing_lane_terminal(client, lane)
                if existing_terminal:
                    lease_id = existing_terminal["lease_id"]
                    operation_id = existing_terminal["operation_id"]
                    terminal_sent = True
                    event_ids.append(existing_terminal["event_id"])
            if not lease_id:
                runtime = self.prepare_lane(lane)
                runtime_job_url = _required_runtime_url(runtime, "resolved_url")
                runtime_tab_id = _required_runtime_int(runtime, "tab_id")
                runtime_debug_port = int(runtime.get("debug_port", lane.port))
                if runtime_debug_port != lane.port:
                    raise ValueError("runtime_debug_port_mismatch")
                pinned_target = {
                    "debug_port": runtime_debug_port,
                    "extension_id": _required_runtime(runtime, "extension_id"),
                    "tab_id": runtime_tab_id,
                    "target_id": _required_runtime(runtime, "target_id"),
                    "url": runtime_job_url,
                }
                bootstrap = client.bootstrap_lane(
                    {
                        "agent_id": lane.agent_id,
                        "lane_id": lane.lane_id,
                        "session_id": lane.session_id,
                        "browser_target_id": lane.browser_target_id,
                        "job_url": runtime_job_url,
                        "debug_port": pinned_target["debug_port"],
                        "extension_id": pinned_target["extension_id"],
                        "tab_id": runtime_tab_id,
                        "target_id": pinned_target["target_id"],
                        "metadata": {
                            "batch_id": lane.batch_id,
                            "artifact_dir": lane.artifact_dir,
                            "profile": lane.profile,
                            "planned_job_url": lane.job.url,
                            "target_id": pinned_target["target_id"],
                        },
                    }
                )
                lease_id = _find_string(bootstrap, "lease_id")
                if not lease_id:
                    raise RuntimeError("bootstrap_missing_lease")
                self._checkpoint(
                    lane,
                    "bootstrapped",
                    lease_id=lease_id,
                    browser_target_id=lane.browser_target_id,
                    target=pinned_target,
                    artifact_dir=lane.artifact_dir,
                )
            elif not existing_terminal:
                _validate_resume_target_state(resume_state, lane, pinned_target)
            if not operation_id:
                command_id = command_id or f"cmd_{uuid.uuid4().hex}"
                trace_id = trace_id or f"trace_{uuid.uuid4().hex}"
                start = client.page_walk(
                    {
                        "command_id": command_id,
                        "trace_id": trace_id,
                        "agent_id": lane.agent_id,
                        "lane_id": lane.lane_id,
                        "session_id": lane.session_id,
                        "lease_id": lease_id,
                        "browser_target_id": lane.browser_target_id,
                        "target": pinned_target,
                        "reason": "autonomous_c3_batch_test",
                        "deadline_seconds": lane.deadline_seconds,
                        "allow_submit": False,
                        "capabilities": [],
                        "command_payload": {"pageWalk": True},
                    }
                )
                operation_id = _find_string(start, "operation_id")
                if not operation_id:
                    raise RuntimeError("operation_start_missing_id")
                self._checkpoint(
                    lane,
                    "operation_started",
                    lease_id=lease_id,
                    operation_id=operation_id,
                    command_id=command_id,
                    trace_id=trace_id,
                    browser_target_id=lane.browser_target_id,
                    target=pinned_target,
                    artifact_dir=lane.artifact_dir,
                )
            else:
                current_operation = _operation_projection(
                    client.get_c3_operation(
                        {
                            "operation_id": operation_id,
                            "agent_id": lane.agent_id,
                            "lease_id": lease_id,
                        }
                    )
                )
                operation = {**operation, **current_operation}
                _validate_operation_identity(
                    operation,
                    lane,
                    lease_id,
                    operation_id,
                    None if existing_terminal else pinned_target,
                )
                command_id = command_id or str(operation.get("command_id") or "")
                trace_id = trace_id or str(operation.get("trace_id") or "")
            deadline = self.now() + lane.deadline_seconds
            while (
                str(operation.get("state") or "") not in TERMINAL_STATES and self.now() < deadline
            ):
                waited = client.wait_for_operation_event(
                    {
                        "operation_id": operation_id,
                        "agent_id": lane.agent_id,
                        "lease_id": lease_id,
                        "after_seq": after_seq,
                        "limit": 100,
                        "timeout_seconds": min(5, max(deadline - self.now(), 0)),
                    }
                )
                projection = _operation_projection(waited)
                if not projection.get("state"):
                    projection = _operation_projection(
                        client.get_c3_operation(
                            {
                                "operation_id": operation_id,
                                "agent_id": lane.agent_id,
                                "lease_id": lease_id,
                            }
                        )
                    )
                operation = projection or operation
                after_seq = max(after_seq, _response_after_sequence(waited))
                event_ids.extend(_event_ids(waited))
                self._checkpoint(
                    lane,
                    "monitoring",
                    lease_id=lease_id,
                    operation_id=operation_id,
                    command_id=command_id,
                    trace_id=trace_id,
                    browser_target_id=lane.browser_target_id,
                    target=pinned_target,
                    after_seq=after_seq,
                    event_ids=list(dict.fromkeys(event_ids)),
                    operation=operation,
                    artifact_dir=lane.artifact_dir,
                )
                state = str(operation.get("state") or "")
                if state in TERMINAL_STATES or state == "stalled":
                    break
            operation_state = str(operation.get("state") or "")
            if operation_state not in TERMINAL_STATES and (
                operation_state == "stalled" or self.now() >= deadline
            ):
                classification_hint = classify_operation(operation)
                operation = self._cancel_and_wait(
                    client,
                    lane,
                    lease_id,
                    operation_id,
                    operation,
                    reason="batch_supervisor_stall_or_deadline",
                    event_ids=event_ids,
                )
                cancel_requested = True

            if str(operation.get("state") or "") not in TERMINAL_STATES:
                operation.setdefault("state", "cancelling" if cancel_requested else "running")
                operation.setdefault("terminal_reason", "cancel_pending")
                self._checkpoint(
                    lane,
                    "cancel_pending",
                    lease_id=lease_id,
                    operation_id=operation_id,
                    command_id=command_id,
                    trace_id=trace_id,
                    browser_target_id=lane.browser_target_id,
                    target=pinned_target,
                    event_ids=list(dict.fromkeys(event_ids)),
                    operation=operation,
                    artifact_dir=lane.artifact_dir,
                )
                return _lane_result(
                    lane,
                    operation_id,
                    lease_id,
                    operation,
                    "cancellation_pending",
                    cancel_requested=cancel_requested,
                    command_id=command_id,
                    trace_id=trace_id,
                    event_ids=event_ids,
                    failure_context_status="unavailable_nonterminal",
                    failure_context_error=str(
                        operation.get("_reconciliation_error")
                        or "cancellation_reconciliation_deadline_exceeded"
                    ),
                )

            failure_context, failure_context_status, failure_context_error = (
                self._fetch_terminal_failure_context(client, lane, lease_id, operation_id)
            )
            failure_context_fetched = True
            operation_refresh_status = "not_requested"
            operation_refresh_error = ""
            try:
                refreshed_operation = _operation_projection(
                    client.get_c3_operation(
                        {
                            "operation_id": operation_id,
                            "agent_id": lane.agent_id,
                            "lease_id": lease_id,
                        }
                    )
                )
            except Exception as refresh_error:
                operation_refresh_status = "error"
                operation_refresh_error = type(refresh_error).__name__
            else:
                if str(refreshed_operation.get("state") or "") in TERMINAL_STATES:
                    operation = _merge_operation_projection(operation, refreshed_operation)
                    operation_refresh_status = "refreshed"
                else:
                    operation_refresh_status = "error"
                    operation_refresh_error = "terminal_operation_refresh_nonterminal"
            safety = _operation_safety_evidence(operation)
            classification = (
                "safety_violation"
                if safety["submit_activated"] or safety["focus_activated"]
                else classification_hint or classify_operation(operation)
            )
            terminal_payload = {
                "agent_id": lane.agent_id,
                "lane_id": lane.lane_id,
                "session_id": lane.session_id,
                "lease_id": lease_id,
                "reason": classification,
                "result": {
                    "operation_id": operation_id,
                    "classification": classification,
                    **safety,
                },
            }
            finalization_warning = ""
            finalization_conflict = False
            if not existing_terminal:
                try:
                    if classification == "review_ready":
                        client.finish_lane(terminal_payload)
                    else:
                        client.fail_lane(terminal_payload)
                except Exception as finalization_error:
                    finalization_warning = _lane_finalization_warning(finalization_error)
                    finalization_conflict = _is_lane_terminal_conflict(finalization_error)
                    try:
                        reconciled_operation = _operation_projection(
                            client.get_c3_operation(
                                {
                                    "operation_id": operation_id,
                                    "agent_id": lane.agent_id,
                                    "lease_id": lease_id,
                                }
                            )
                        )
                    except Exception as reconcile_error:
                        operation_refresh_status = "error"
                        operation_refresh_error = (
                            f"terminal_finalization_refresh:{type(reconcile_error).__name__}"
                        )
                    else:
                        if str(reconciled_operation.get("state") or "") in TERMINAL_STATES:
                            operation = _merge_operation_projection(operation, reconciled_operation)
                            operation_refresh_status = "refreshed"
                            operation_refresh_error = ""
                        else:
                            operation_refresh_status = "error"
                            operation_refresh_error = "terminal_finalization_refresh_nonterminal"
                else:
                    terminal_sent = True

            if finalization_conflict or (
                not failure_context_error
                and _failure_artifact_is_pending(failure_context, failure_context_status)
            ):
                refreshed_context = self._fetch_terminal_failure_context(
                    client, lane, lease_id, operation_id
                )
                if refreshed_context[1] == "available" or failure_context_status != "available":
                    (
                        failure_context,
                        failure_context_status,
                        failure_context_error,
                    ) = refreshed_context
                elif refreshed_context[2]:
                    failure_context_error = f"refresh:{refreshed_context[2]}"

            safety = _operation_safety_evidence(operation)
            classification = (
                "safety_violation"
                if safety["submit_activated"] or safety["focus_activated"]
                else classification_hint or classify_operation(operation)
            )
            result = _lane_result(
                lane,
                operation_id,
                lease_id,
                operation,
                classification,
                cancel_requested=cancel_requested,
                command_id=command_id,
                trace_id=trace_id,
                event_ids=event_ids,
                failure_context=failure_context,
                failure_context_status=failure_context_status,
                failure_context_error=failure_context_error,
                operation_refresh_status=operation_refresh_status,
                operation_refresh_error=operation_refresh_error,
                error=finalization_warning,
            )
            self._checkpoint(lane, "complete", result=result.__dict__)
            return result
        except Exception as error:
            if (
                not isinstance(error, ResumeOperationIdentityError)
                and lease_id
                and operation_id
                and not terminal_sent
            ):
                try:
                    cancel_requested = True
                    operation = self._cancel_and_wait(
                        client,
                        lane,
                        lease_id,
                        operation_id,
                        operation,
                        reason="batch_lane_exception",
                        event_ids=event_ids,
                    )
                except Exception as cancel_error:
                    operation.setdefault("state", "cancelling")
                    operation.setdefault("terminal_reason", "cancel_pending")
                    operation["_reconciliation_error"] = (
                        f"cancel_dispatch:{type(cancel_error).__name__}"
                    )
                    operation = self._wait_for_cancel_terminal(
                        client,
                        lane,
                        lease_id,
                        operation_id,
                        operation,
                        event_ids,
                        allow_redispatch=False,
                    )
                if str(operation.get("state") or "") in TERMINAL_STATES:
                    try:
                        client.fail_lane(
                            {
                                "agent_id": lane.agent_id,
                                "lane_id": lane.lane_id,
                                "session_id": lane.session_id,
                                "lease_id": lease_id,
                                "reason": "batch_lane_exception",
                                "result": {"error_type": type(error).__name__},
                            }
                        )
                        terminal_sent = True
                    except Exception:
                        pass
            elif (
                not isinstance(error, ResumeOperationIdentityError)
                and lease_id
                and not terminal_sent
            ):
                try:
                    client.fail_lane(
                        {
                            "agent_id": lane.agent_id,
                            "lane_id": lane.lane_id,
                            "session_id": lane.session_id,
                            "lease_id": lease_id,
                            "reason": "batch_lane_exception",
                            "result": {"error_type": type(error).__name__},
                        }
                    )
                except Exception:
                    pass
            context_result = (
                self._fetch_terminal_failure_context(client, lane, lease_id, operation_id)
                if not failure_context_fetched
                and operation_id
                and str(operation.get("state") or "") in TERMINAL_STATES
                else (
                    failure_context,
                    (
                        failure_context_status
                        if failure_context_fetched
                        else "unavailable_nonterminal"
                    ),
                    failure_context_error,
                )
            )
            failure_fields = _failure_context_fields(*context_result)
            if not operation_id:
                failure_fields["missing_evidence"] = (
                    "operation_not_started",
                    "control_plane_bootstrap",
                )
                failure_fields["root_cause_unknown"] = True
                failure_fields["live_inspection_required"] = True
            result = LaneResult(
                agent_id=lane.agent_id,
                lane_id=lane.lane_id,
                session_id=lane.session_id,
                operation_id=operation_id,
                job_url=lane.job.url,
                classification="fill_failed",
                operation_state=str(operation.get("state") or "failed"),
                terminal_reason=str(operation.get("terminal_reason") or "batch_lane_exception"),
                lease_id=lease_id,
                command_id=command_id,
                trace_id=trace_id,
                artifact_dir=lane.artifact_dir,
                artifact_ids=_string_tuple(operation.get("artifact_ids")),
                artifact_paths=_artifact_paths(context_result[0], operation_id=operation_id),
                event_ids=tuple(dict.fromkeys(event_ids)),
                cancel_requested=cancel_requested,
                cancel_acknowledged=str(operation.get("state") or "") == "cancelled",
                submit_activated=_operation_safety_evidence(operation)["submit_activated"],
                focus_activated=_operation_safety_evidence(operation)["focus_activated"],
                error=f"{type(error).__name__}:{error}",
                **failure_fields,
            )
            self._checkpoint(
                lane,
                "complete" if terminal_sent else "cancel_pending",
                lease_id=lease_id,
                operation_id=operation_id,
                command_id=command_id,
                trace_id=trace_id,
                browser_target_id=lane.browser_target_id,
                target=pinned_target,
                operation=operation,
                artifact_dir=lane.artifact_dir,
                result=result.__dict__,
            )
            return result
        finally:
            close = getattr(client, "close", None)
            if callable(close):
                close()

    def _wait_for_cancel_terminal(
        self,
        client: McpClient,
        lane: LanePlan,
        lease_id: str,
        operation_id: str,
        operation: dict[str, Any],
        event_ids: list[str] | None = None,
        *,
        allow_redispatch: bool = True,
    ) -> dict[str, Any]:
        grace_deadline = self.now() + max(
            CANCEL_RECONCILIATION_WAIT_SECONDS,
            min(45, max(5, lane.deadline_seconds / 10)),
        )
        after_seq = 0
        redispatched = False
        reconciliation_error = ""
        while self.now() < grace_deadline:
            try:
                waited = client.wait_for_operation_event(
                    {
                        "operation_id": operation_id,
                        "agent_id": lane.agent_id,
                        "lease_id": lease_id,
                        "after_seq": after_seq,
                        "limit": 100,
                        "timeout_seconds": min(2, max(grace_deadline - self.now(), 0.05)),
                    }
                )
            except Exception as error:
                reconciliation_error = f"wait:{type(error).__name__}"
                try:
                    projection = _operation_projection(
                        client.get_c3_operation(
                            {
                                "operation_id": operation_id,
                                "agent_id": lane.agent_id,
                                "lease_id": lease_id,
                            }
                        )
                    )
                except Exception as refresh_error:
                    reconciliation_error = (
                        f"{reconciliation_error};refresh:{type(refresh_error).__name__}"
                    )
                    self.sleep(min(0.1, max(grace_deadline - self.now(), 0)))
                    continue
                operation = projection or operation
                if str(operation.get("state") or "") in TERMINAL_STATES:
                    return operation
                self.sleep(min(0.1, max(grace_deadline - self.now(), 0)))
                continue
            after_seq = max(after_seq, _response_after_sequence(waited))
            if event_ids is not None:
                event_ids.extend(_event_ids(waited))
            projection = _operation_projection(waited)
            if not projection.get("state"):
                projection = _operation_projection(
                    client.get_c3_operation(
                        {
                            "operation_id": operation_id,
                            "agent_id": lane.agent_id,
                            "lease_id": lease_id,
                        }
                    )
                )
            operation = projection or operation
            state = str(operation.get("state") or "")
            if state in TERMINAL_STATES:
                return operation
            if (
                operation.get("cancel_failed_at")
                and not redispatched
                and allow_redispatch
                and _cancel_retry_ready(operation, self.wall_now())
            ):
                try:
                    client.cancel_c3_operation(
                        {
                            "operation_id": operation_id,
                            "agent_id": lane.agent_id,
                            "lease_id": lease_id,
                            "reason": "batch_supervisor_cancel_redispatch",
                            "redispatch": True,
                        }
                    )
                except Exception as error:
                    if not _is_cancel_backoff_active(error):
                        raise
                else:
                    redispatched = True
        operation["_reconciliation_error"] = "cancellation_reconciliation_deadline_exceeded" + (
            f":{reconciliation_error}" if reconciliation_error else ""
        )
        return operation

    def _fetch_terminal_failure_context(
        self,
        client: McpClient,
        lane: LanePlan,
        lease_id: str,
        operation_id: str,
    ) -> tuple[dict[str, Any], str, str]:
        latest = _fetch_failure_context(client, lane, lease_id, operation_id)
        last_available = latest if latest[1] == "available" else None
        for _attempt in range(1, FAILURE_CONTEXT_REFRESH_ATTEMPTS):
            context, status, _error = latest
            if not _failure_artifact_is_pending(context, status):
                break
            self.sleep(FAILURE_CONTEXT_REFRESH_INTERVAL_SECONDS)
            refreshed = _fetch_failure_context(client, lane, lease_id, operation_id)
            if refreshed[1] != "available" and last_available is not None:
                refresh_error = refreshed[2] or refreshed[1]
                return last_available[0], "available", f"refresh:{refresh_error}"
            latest = refreshed
            if latest[1] == "available":
                last_available = latest
        return latest

    def _cancel_and_wait(
        self,
        client: McpClient,
        lane: LanePlan,
        lease_id: str,
        operation_id: str,
        operation: dict[str, Any],
        *,
        reason: str,
        event_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        cancel_response = client.cancel_c3_operation(
            {
                "operation_id": operation_id,
                "agent_id": lane.agent_id,
                "lease_id": lease_id,
                "reason": reason,
            }
        )
        projection = _operation_projection(cancel_response)
        state = str(projection.get("state") or projection.get("status") or "")
        if state in TERMINAL_STATES:
            return projection
        if projection:
            operation = projection
        operation.setdefault("operation_id", operation_id)
        operation["state"] = "cancelling"
        return self._wait_for_cancel_terminal(
            client,
            lane,
            lease_id,
            operation_id,
            operation,
            event_ids,
        )

    def _checkpoint(self, lane: LanePlan, stage: str, **state: Any) -> None:
        if self.checkpoint is not None:
            self.checkpoint(lane, {"stage": stage, **state})


def _cancel_retry_ready(operation: dict[str, Any], now: datetime) -> bool:
    retry_after = operation.get("cancel_retry_after")
    if not retry_after:
        return True
    try:
        parsed = (
            retry_after
            if isinstance(retry_after, datetime)
            else datetime.fromisoformat(str(retry_after).replace("Z", "+00:00"))
        )
    except (TypeError, ValueError):
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)
    return now >= parsed


def _is_cancel_backoff_active(error: Exception) -> bool:
    reason = getattr(error, "reason", None)
    return (
        getattr(error, "status_code", None) == 409
        and isinstance(reason, dict)
        and reason.get("reason_code") == "cancel_backoff_active"
    )


def _validate_lanes(lanes: list[LanePlan]) -> None:
    if lanes and len({lane.batch_id for lane in lanes}) != 1:
        raise ValueError("mixed_batch_identity")
    if any(not lane.browser_target_id.strip() for lane in lanes):
        raise ValueError("lane_identity_required")
    identities = (
        [lane.index for lane in lanes],
        [lane.port for lane in lanes],
        [lane.profile for lane in lanes],
        [lane.agent_id for lane in lanes],
        [lane.lane_id for lane in lanes],
        [lane.session_id for lane in lanes],
        [lane.browser_target_id for lane in lanes],
        [str(Path(lane.artifact_dir).resolve()).casefold() for lane in lanes],
    )
    if any(len(set(values)) != len(values) for values in identities):
        raise ValueError("duplicate_lane_identity")
    if any(lane.allow_submit or lane.allow_foreground for lane in lanes):
        raise ValueError("unsafe_lane_capability")


def _required_runtime(runtime: dict[str, Any], key: str) -> str:
    value = runtime.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"runtime_{key}_required")
    return value


def _required_runtime_int(runtime: dict[str, Any], key: str) -> int:
    value = runtime.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"runtime_{key}_required")
    return value


def _required_runtime_url(runtime: dict[str, Any], key: str) -> str:
    value = _required_runtime(runtime, key).strip()
    parsed = urlsplit(value)
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"runtime_{key}_required")
    return value


def _find_string(value: Any, key: str) -> str:
    if isinstance(value, dict):
        direct = value.get(key)
        if isinstance(direct, str) and direct:
            return direct
        for child in value.values():
            found = _find_string(child, key)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_string(child, key)
            if found:
                return found
    return ""


def _operation_projection(value: Any) -> dict[str, Any]:
    if isinstance(value, dict) and isinstance(value.get("operation"), dict):
        return value["operation"]
    return value if isinstance(value, dict) else {}


def _merge_operation_projection(
    previous: dict[str, Any], refreshed: dict[str, Any]
) -> dict[str, Any]:
    """Merge an authoritative refresh without discarding earlier terminal evidence."""
    merged = {**previous, **refreshed}
    previous_result = previous.get("result")
    refreshed_result = refreshed.get("result")
    if isinstance(previous_result, dict) and isinstance(refreshed_result, dict):
        merged["result"] = {**previous_result, **refreshed_result}
    return merged


def _existing_lane_terminal(client: McpClient, lane: LanePlan) -> dict[str, Any]:
    """Return the authoritative terminal identity for an immutable lane plan."""
    getter = getattr(client, "get_session_log", None)
    if not callable(getter):
        return {}
    response = getter({"session_id": lane.session_id})
    events = response.get("events", []) if isinstance(response, dict) else []
    for event in events:
        if not isinstance(event, dict) or event.get("event_type") not in {
            "lane.finished",
            "lane.failed",
        }:
            continue
        if any(
            str(event.get(key) or "") != expected
            for key, expected in {
                "agent_id": lane.agent_id,
                "lane_id": lane.lane_id,
                "session_id": lane.session_id,
            }.items()
        ):
            continue
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
        terminal = {
            "event_id": str(event.get("event_id") or ""),
            "lease_id": str(event.get("lease_id") or ""),
            "operation_id": str(result.get("operation_id") or ""),
        }
        if not all(terminal.values()):
            raise RuntimeError("lane_terminal_projection_invalid")
        return terminal
    return {}


def _lane_finalization_warning(error: Exception) -> str:
    reason = getattr(error, "reason", None)
    reason_code = str(reason.get("reason_code") or "") if isinstance(reason, dict) else ""
    suffix = f":{reason_code}" if reason_code else ""
    return f"lane_finalization_warning:{type(error).__name__}{suffix}"


def _is_lane_terminal_conflict(error: Exception) -> bool:
    reason = getattr(error, "reason", None)
    return (
        getattr(error, "status_code", None) == 409
        and isinstance(reason, dict)
        and reason.get("reason_code") == "lane_terminal_conflict"
    )


def _validate_operation_identity(
    operation: dict[str, Any],
    lane: LanePlan,
    lease_id: str,
    operation_id: str,
    pinned_target: dict[str, Any] | None = None,
) -> None:
    expected = {
        "operation_id": operation_id,
        "agent_id": lane.agent_id,
        "lane_id": lane.lane_id,
        "session_id": lane.session_id,
        "lease_id": lease_id,
        "browser_target_id": lane.browser_target_id,
    }
    if any(str(operation.get(key) or "") != value for key, value in expected.items()):
        raise ResumeOperationIdentityError("resume_operation_identity_mismatch")
    if pinned_target is not None:
        _validate_target_selectors(operation.get("target"), pinned_target)


def _validate_resume_target_state(
    resume_state: dict[str, Any], lane: LanePlan, pinned_target: dict[str, Any]
) -> None:
    if str(resume_state.get("browser_target_id") or "") != lane.browser_target_id:
        raise ResumeOperationIdentityError("resume_operation_identity_mismatch")
    if pinned_target.get("debug_port") != lane.port:
        raise ResumeOperationIdentityError("resume_operation_identity_mismatch")
    _validate_target_selectors(pinned_target, pinned_target)


def _validate_target_selectors(value: Any, pinned_target: dict[str, Any]) -> None:
    if not isinstance(value, dict):
        raise ResumeOperationIdentityError("resume_operation_identity_mismatch")
    required = ("debug_port", "extension_id", "tab_id", "target_id")
    if any(value.get(key) != pinned_target.get(key) for key in required):
        raise ResumeOperationIdentityError("resume_operation_identity_mismatch")
    pinned_url = str(pinned_target.get("url") or "").strip()
    actual_url = str(value.get("url") or "").strip()
    expected_hash = hashlib.sha256(pinned_url.split("#", 1)[0].encode("utf-8")).hexdigest()
    url_matches = actual_url == pinned_url or (
        actual_url == _normalized_target_url(pinned_url)
        and str(value.get("url_sha256") or "") == expected_hash
    )
    if not url_matches:
        raise ResumeOperationIdentityError("resume_operation_identity_mismatch")
    if (
        isinstance(pinned_target.get("tab_id"), bool)
        or not isinstance(pinned_target.get("tab_id"), int)
        or pinned_target["tab_id"] < 0
        or not str(pinned_target.get("extension_id") or "").strip()
        or not str(pinned_target.get("target_id") or "").strip()
        or not str(pinned_target.get("url") or "").strip()
        or urlsplit(str(pinned_target.get("url") or "").strip()).scheme.casefold()
        not in {"http", "https"}
    ):
        raise ResumeOperationIdentityError("resume_operation_identity_mismatch")


def _normalized_target_url(value: str) -> str:
    parsed = urlsplit(value)
    if not parsed.scheme or not parsed.netloc:
        return value
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def _max_event_sequence(value: Any) -> int:
    events = value.get("events", []) if isinstance(value, dict) else []
    return max([int(event.get("seq") or 0) for event in events if isinstance(event, dict)] or [0])


def _response_after_sequence(value: Any) -> int:
    candidates = [_max_event_sequence(value)]

    def visit(item: Any) -> None:
        if not isinstance(item, dict):
            return
        for key, nested in item.items():
            if key == "next_after_seq":
                try:
                    candidates.append(max(0, int(nested or 0)))
                except (TypeError, ValueError):
                    pass
            elif isinstance(nested, dict):
                visit(nested)

    visit(value)
    return max(candidates)


def _lane_result(
    lane: LanePlan,
    operation_id: str,
    lease_id: str,
    operation: dict[str, Any],
    classification: str,
    *,
    cancel_requested: bool,
    command_id: str = "",
    trace_id: str = "",
    event_ids: Iterable[str] = (),
    failure_context: dict[str, Any] | None = None,
    failure_context_status: str = "not_requested",
    failure_context_error: str = "",
    operation_refresh_status: str = "not_requested",
    operation_refresh_error: str = "",
    error: str = "",
) -> LaneResult:
    artifact_ids = operation.get("artifact_ids")
    safety = _operation_safety_evidence(operation)
    return LaneResult(
        agent_id=lane.agent_id,
        lane_id=lane.lane_id,
        session_id=lane.session_id,
        operation_id=operation_id,
        job_url=lane.job.url,
        classification=classification,
        operation_state=str(operation.get("state") or ""),
        terminal_reason=str(operation.get("terminal_reason") or ""),
        lease_id=lease_id,
        operation_refresh_status=operation_refresh_status,
        operation_refresh_error=operation_refresh_error,
        command_id=command_id or str(operation.get("command_id") or ""),
        trace_id=trace_id or str(operation.get("trace_id") or ""),
        artifact_dir=lane.artifact_dir,
        artifact_ids=tuple(artifact_ids) if isinstance(artifact_ids, list) else (),
        artifact_paths=_artifact_paths(failure_context or {}, operation_id=operation_id),
        event_ids=tuple(dict.fromkeys(event_ids)),
        cancel_requested=cancel_requested,
        cancel_acknowledged=str(operation.get("state") or "") == "cancelled"
        or bool(operation.get("cancel_acknowledged_at")),
        submit_activated=safety["submit_activated"],
        focus_activated=safety["focus_activated"],
        error=error,
        **_failure_context_fields(
            failure_context or {}, failure_context_status, failure_context_error
        ),
    )


def _fetch_failure_context(
    client: McpClient,
    lane: LanePlan,
    lease_id: str,
    operation_id: str,
) -> tuple[dict[str, Any], str, str]:
    getter = getattr(client, "get_c3_failure_context", None)
    if not callable(getter):
        return {}, "unavailable", "client_method_unavailable"
    try:
        response = getter(
            {
                "operation_id": operation_id,
                "agent_id": lane.agent_id,
                "lease_id": lease_id,
            }
        )
    except Exception as exc:
        return {}, "error", type(exc).__name__
    context = _failure_context_projection(response)
    if not context:
        return {}, "error", "failure_context_missing"
    return context, "available", ""


def _failure_artifact_is_pending(context: dict[str, Any], status: str) -> bool:
    return status == "available" and str(context.get("artifact_status") or "idle") in {
        "idle",
        "pending",
        "queued",
        "capturing",
    }


def _failure_context_projection(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    for key in ("failure_context", "context", "diagnosis"):
        nested = value.get(key)
        if isinstance(nested, dict):
            response_fields = {
                name: value[name]
                for name in (
                    "action_tail",
                    "validation_tail",
                    "navigation_tail",
                    "artifacts",
                    "artifact_status",
                    "source_event_sequence",
                )
                if name in value
            }
            return {
                **nested,
                **response_fields,
                "diagnosis_evidence_truncated": bool(nested.get("evidence_truncated", False)),
                "response_evidence_truncated": bool(
                    value.get(
                        "evidence_truncated",
                        nested.get("evidence_truncated", False),
                    )
                ),
            }
    if "root_cause_code" in value and "operation_id" in value:
        return value
    return {}


def _failure_context_fields(context: dict[str, Any], status: str, error: str) -> dict[str, Any]:
    causal = context.get("causal_element")
    causal = causal if isinstance(causal, dict) else {}
    last_touched = context.get("last_touched_element")
    last_touched = last_touched if isinstance(last_touched, dict) else {}
    return {
        "failure_context_status": status,
        "diagnosis_id": str(context.get("diagnosis_id") or ""),
        "failure_scope": str(context.get("failure_scope") or ""),
        "root_cause_code": str(context.get("root_cause_code") or ""),
        "failure_summary": str(context.get("summary") or ""),
        "causal_selector": str(causal.get("selector") or ""),
        "causal_label": str(causal.get("label") or ""),
        "last_touched_selector": str(last_touched.get("selector") or ""),
        "last_touched_label": str(last_touched.get("label") or ""),
        "expected_state": str(context.get("expected_state") or ""),
        "observed_state": str(context.get("observed_state") or ""),
        "confidence": str(context.get("confidence") or "unknown"),
        "root_cause_unknown": bool(context.get("root_cause_unknown", True)),
        "failure_evidence_event_ids": _string_tuple(context.get("evidence_event_ids")),
        "failure_checkpoint_ids": _string_tuple(context.get("checkpoint_ids")),
        "failure_artifact_ids": _string_tuple(context.get("artifact_ids")),
        "failure_action_tail": _compact_evidence_tail(context.get("action_tail")),
        "failure_validation_tail": _compact_evidence_tail(context.get("validation_tail")),
        "failure_navigation_tail": _compact_evidence_tail(context.get("navigation_tail")),
        "failure_artifact_summaries": _compact_artifact_summaries(context.get("artifacts")),
        "failure_artifact_status": str(context.get("artifact_status") or "idle"),
        "failure_source_event_sequence": _nonnegative_int(context.get("source_event_sequence")),
        "failure_evidence_truncated": bool(
            context.get(
                "diagnosis_evidence_truncated",
                context.get("evidence_truncated", False),
            )
        ),
        "failure_response_evidence_truncated": bool(
            context.get(
                "response_evidence_truncated",
                context.get("evidence_truncated", False),
            )
        ),
        "validation_messages": _string_tuple(context.get("validation_messages")),
        "credential_preparation": _compact_credential_preparation(
            context.get("credential_preparation")
        ),
        "missing_evidence": _string_tuple(context.get("missing_evidence")),
        "live_inspection_required": bool(context.get("live_inspection_required", True)),
        "next_safe_action": str(context.get("next_safe_action") or ""),
        "failure_context_error": error,
    }


def _compact_credential_preparation(value: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    allowed_sources = {"profile:accountEmail", "profile:accountPassword"}
    prepared: list[dict[str, Any]] = []
    for raw in value[:4]:
        if not isinstance(raw, dict) or raw.get("source") not in allowed_sources:
            continue
        selector = _bounded_text(raw.get("selector"), 300)
        if not selector:
            continue
        prepared.append(
            {
                "source": raw["source"],
                "selector": selector,
                "ok": bool(raw.get("ok")),
                "changed": bool(raw.get("changed")),
            }
        )
    return tuple(prepared)


def _compact_evidence_tail(value: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    items: list[dict[str, Any]] = []
    for raw in value[-FAILURE_EVIDENCE_TAIL_LIMIT:]:
        if not isinstance(raw, dict):
            continue
        item: dict[str, Any] = {
            "seq": _nonnegative_int(raw.get("seq")),
            "event_id": _bounded_text(raw.get("event_id")),
            "event_type": _bounded_text(raw.get("event_type")),
            "ts": _bounded_text(raw.get("ts")),
            "reason_code": _bounded_text(raw.get("reason_code")),
            "action": _bounded_text(raw.get("action")),
            "validation_messages": _bounded_string_tuple(raw.get("validation_messages"), 32),
            "navigation_from": _bounded_text(raw.get("navigation_from"), 1_000),
            "navigation_to": _bounded_text(raw.get("navigation_to"), 1_000),
        }
        element = _compact_element(raw.get("element"))
        if element:
            item["element"] = element
        items.append(item)
    return tuple(items)


def _compact_element(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    allowed = (
        "selector",
        "role",
        "label",
        "tag",
        "element_id",
        "name",
        "automation_id",
        "field_id",
        "ui_model",
        "input_type",
        "autocomplete",
        "page",
        "document_id",
        "action",
        "checkpoint_id",
    )
    return {
        key: _bounded_text(value.get(key)) for key in allowed if value.get(key) not in (None, "")
    }


def _compact_artifact_summaries(value: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    summaries: list[dict[str, Any]] = []
    for raw in value[:FAILURE_ARTIFACT_SUMMARY_LIMIT]:
        if not isinstance(raw, dict) or not str(raw.get("artifact_id") or "").strip():
            continue
        summaries.append(
            {
                "artifact_id": _bounded_text(raw.get("artifact_id")),
                "status": _bounded_text(raw.get("status")),
                "kind": _bounded_text(raw.get("kind")),
                "captured_at": _bounded_text(raw.get("captured_at")),
                "files": _bounded_string_tuple(raw.get("files"), 32),
                "manifest_present": bool(raw.get("manifest_present", False)),
            }
        )
    return tuple(summaries)


def _bounded_text(value: Any, limit: int = 500) -> str:
    return str(value or "")[:limit]


def _bounded_string_tuple(value: Any, limit: int) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(_bounded_text(item) for item in value[:limit] if isinstance(item, str) and item)


def _nonnegative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _event_ids(value: Any) -> list[str]:
    events = value.get("events", []) if isinstance(value, dict) else []
    return [
        str(event.get("event_id"))
        for event in events
        if isinstance(event, dict) and event.get("event_id")
    ]


def _string_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(str(item) for item in value if isinstance(item, str) and item)


def _artifact_paths(context: Any, *, operation_id: str = "") -> tuple[str, ...]:
    """Return only backend-validated failure-bundle manifest paths."""

    if not isinstance(context, dict):
        return ()
    context_operation_id = str(context.get("operation_id") or "").strip()
    if operation_id and context_operation_id and operation_id != context_operation_id:
        return ()
    expected_operation_id = str(operation_id or context_operation_id).strip()
    artifacts = context.get("artifacts")
    if not expected_operation_id or not isinstance(artifacts, (list, tuple)):
        return ()
    found: list[str] = []
    for raw in artifacts[:ARTIFACT_PATH_LIMIT]:
        if not isinstance(raw, dict):
            continue
        artifact_id = str(raw.get("artifact_id") or "").strip()
        manifest_path = str(raw.get("manifest_path") or "").strip()
        if (
            raw.get("status") != "completed"
            or raw.get("kind") != "failure_bundle"
            or raw.get("manifest_present") is not True
            or not is_trusted_generated_c3_id(artifact_id)
            or not manifest_path
            or len(manifest_path) > ARTIFACT_PATH_CHARACTER_LIMIT
            or "\x00" in manifest_path
        ):
            continue
        candidate = Path(manifest_path)
        if not candidate.is_absolute():
            continue
        canonical = candidate.resolve(strict=False)
        artifact_root = canonical.parent.parent
        operation_root = artifact_root.parent
        if (
            canonical.name != "manifest.json"
            or canonical.parent.name != artifact_id
            or artifact_root.name != "artifacts"
            or operation_root.name != expected_operation_id
            or canonical != artifact_root / artifact_id / "manifest.json"
        ):
            continue
        try:
            canonical.relative_to(artifact_root)
        except ValueError:
            continue
        text = str(canonical)
        if text not in found:
            found.append(text)
    return tuple(found)


def _operation_safety_evidence(operation: dict[str, Any]) -> dict[str, bool]:
    flags = {"submit_activated": False, "focus_activated": False}
    submit_keys = {"submitactivated", "submitclicked", "finalsubmitactivated", "submitted"}
    focus_keys = {
        "focusactivated",
        "foregroundactivated",
        "broughttofront",
        "bringtofrontactivated",
    }

    def visit(value: Any, key: str = "") -> None:
        normalized = "".join(character for character in key.casefold() if character.isalnum())
        if value is True and normalized in submit_keys:
            flags["submit_activated"] = True
        if value is True and normalized in focus_keys:
            flags["focus_activated"] = True
        if isinstance(value, dict):
            for child_key, child in value.items():
                visit(child, str(child_key))
        elif isinstance(value, (list, tuple)):
            for child in value:
                visit(child)

    visit(operation)
    return flags
