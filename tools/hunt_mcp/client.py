from __future__ import annotations

import base64
import math
import os
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

try:
    from backend.c3_browser_bridge import RESERVED_C3_COMMAND_PAYLOAD_KEYS
except ModuleNotFoundError:  # Support documented execution from tools/hunt_mcp.
    _REPO_ROOT = Path(__file__).resolve().parents[2]
    if str(_REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(_REPO_ROOT))
    from backend.c3_browser_bridge import RESERVED_C3_COMMAND_PAYLOAD_KEYS

DEFAULT_BACKEND_URL = "http://127.0.0.1:8000"
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_OPERATION_WAIT_SECONDS = 20.0
MAX_OPERATION_WAIT_SECONDS = 60.0
LEASE_HEARTBEAT_INTERVAL_SECONDS = 2.0
TERMINAL_OPERATION_STATES = {"completed", "failed", "cancelled", "orphaned"}
READONLY_CONTROL_ACTIONS = {
    "target_health",
    "page_info",
    "dom_snapshot",
    "screenshot",
    "console_tail",
    "failed_request_tail",
    "active_element",
    "popup_ownership",
    "read_attributes",
}
PROBE_CONTROL_ACTIONS = READONLY_CONTROL_ACTIONS | {
    "open_owned_popup",
    "click_owned_option",
}
RESERVED_COMMAND_PAYLOAD_KEYS = RESERVED_C3_COMMAND_PAYLOAD_KEYS


class HuntBackendError(RuntimeError):
    def __init__(self, status_code: int, reason: Any):
        super().__init__(f"Hunt backend returned {status_code}: {reason}")
        self.status_code = status_code
        self.reason = reason


@dataclass(frozen=True)
class HuntBackendConfig:
    backend_url: str = DEFAULT_BACKEND_URL
    service_token: str | None = None
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS

    @classmethod
    def from_env(cls) -> HuntBackendConfig:
        timeout = os.environ.get("HUNT_MCP_HTTP_TIMEOUT", str(DEFAULT_TIMEOUT_SECONDS))
        return cls(
            backend_url=os.environ.get("HUNT_BACKEND_URL", DEFAULT_BACKEND_URL),
            service_token=os.environ.get("HUNT_SERVICE_TOKEN") or None,
            timeout_seconds=float(timeout),
        )


class HuntLedgerClient:
    def __init__(
        self,
        config: HuntBackendConfig | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.config = config or HuntBackendConfig.from_env()
        headers = {}
        if self.config.service_token:
            headers["Authorization"] = f"Bearer {self.config.service_token}"
        self._client = httpx.Client(
            base_url=self.config.backend_url.rstrip("/"),
            headers=headers,
            timeout=self.config.timeout_seconds,
            transport=transport,
        )
        self._heartbeat_lock = threading.Lock()
        self._next_heartbeat_at: dict[tuple[str, str], float] = {}

    def close(self) -> None:
        self._client.close()

    def create_agent(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", "/api/ledger/agents", json=payload)

    def create_lane(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", "/api/ledger/lanes", json=payload)

    def open_session(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", "/api/ledger/sessions", json=payload)

    def claim_lease(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", "/api/ledger/leases/claim", json=payload)

    def heartbeat_lease(self, payload: dict[str, Any]) -> Any:
        lease_id = _required(payload, "lease_id")
        return self._request("POST", f"/api/ledger/leases/{lease_id}/heartbeat", json=payload)

    def release_lease(self, payload: dict[str, Any]) -> Any:
        lease_id = _required(payload, "lease_id")
        return self._request("POST", f"/api/ledger/leases/{lease_id}/release", json=payload)

    def append_event(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", "/api/ledger/events", json=payload)

    def get_active(self, payload: dict[str, Any] | None = None) -> Any:
        params = payload or None
        return self._request("GET", "/api/ledger/active", params=params)

    def get_agent_log(self, payload: dict[str, Any]) -> Any:
        agent_id = _required(payload, "agent_id")
        params = {key: value for key, value in payload.items() if key != "agent_id"}
        return self._request("GET", f"/api/ledger/agents/{agent_id}", params=params or None)

    def get_session_log(self, payload: dict[str, Any]) -> Any:
        session_id = _required(payload, "session_id")
        params = {key: value for key, value in payload.items() if key != "session_id"}
        return self._request("GET", f"/api/ledger/sessions/{session_id}", params=params or None)

    def get_command_timeline(self, payload: dict[str, Any]) -> Any:
        command_id = _required(payload, "command_id")
        return self._request("GET", f"/api/ledger/commands/{command_id}/timeline")

    def find_recent_failures(self, payload: dict[str, Any] | None = None) -> Any:
        body = payload or {}
        params = {
            key: value
            for key, value in {
                "component": body.get("component") or "c3",
                "limit": body.get("limit") or 20,
            }.items()
            if value is not None
        }
        return self._request("GET", "/api/ledger/failures/recent", params=params)

    def write_probe_file(self, payload: dict[str, Any]) -> Any:
        body = dict(payload)
        body.setdefault("trusted", False)
        return self._request("POST", "/api/ledger/probes", json=body)

    def register_browser_target(self, payload: dict[str, Any]) -> Any:
        return self._request(
            "POST", "/api/c3/browser-targets/register", json=_browser_target_body(payload)
        )

    def get_browser_target(self, payload: dict[str, Any]) -> Any:
        session_id = _required(payload, "session_id")
        return self._request("GET", f"/api/c3/browser-targets/{session_id}")

    def list_browser_targets(self, payload: dict[str, Any] | None = None) -> Any:
        del payload
        return self._request("GET", "/api/c3/browser-targets")

    def unregister_browser_target(self, payload: dict[str, Any]) -> Any:
        session_id = _required(payload, "session_id")
        params = {
            key: value
            for key, value in {
                "agent_id": payload.get("agent_id"),
                "reason": payload.get("reason"),
            }.items()
            if value
        }
        return self._request(
            "DELETE", f"/api/c3/browser-targets/{session_id}", params=params or None
        )

    def run_c3_command(self, payload: dict[str, Any]) -> Any:
        _required(payload, "command_id")
        _required(payload, "command_name")
        _required(payload, "agent_id")
        _required(payload, "session_id")
        _required(payload, "lease_id")
        _required(payload, "reason")
        command_payload = payload.get("command_payload", {})
        if not isinstance(command_payload, dict):
            raise ValueError("command_payload must be an object")
        _reject_reserved_command_payload_keys(command_payload)
        target_id = _required(payload, "target_id")
        target = payload.get("target")
        if target is None:
            target = _target_from_payload(payload, command_payload)
        if not isinstance(target, dict):
            raise ValueError("target must be an object")
        supplied_target_id = str(target.get("target_id") or "")
        if supplied_target_id and supplied_target_id != target_id:
            raise ValueError("target.target_id must match target_id")
        target = {**target, "target_id": target_id}

        body = dict(payload)
        body["command_payload"] = command_payload
        body["target"] = target
        return self._request("POST", "/api/c3/commands/run", json=body)

    def get_c3_command_catalog(self, payload: dict[str, Any] | None = None) -> Any:
        del payload
        return self._request("GET", "/api/c3/commands/catalog")

    def run_c3_diagnostic(self, payload: dict[str, Any]) -> Any:
        body = _control_identity_body(payload)
        body["action"] = _allowed_control_action(
            payload, READONLY_CONTROL_ACTIONS, "diagnostic_action_not_allowed"
        )
        body["options"] = _object_value(payload, "options")
        return self._request("POST", "/api/c3/control/diagnostics/run", json=body)

    def create_c3_probe_budget(self, payload: dict[str, Any]) -> Any:
        body = _control_identity_body(payload)
        body["budget_id"] = _required(payload, "budget_id")
        body.update(
            _selected_payload(
                payload,
                ("attempts", "mutations", "wall_seconds", "files", "bytes"),
            )
        )
        return self._request("POST", "/api/c3/control/probes", json=body)

    def execute_c3_probe(self, payload: dict[str, Any]) -> Any:
        budget_id = _required(payload, "budget_id")
        body = _control_identity_body(payload)
        body.update(
            {
                "action": _allowed_control_action(
                    payload, PROBE_CONTROL_ACTIONS, "probe_action_not_allowed"
                ),
                "options": _object_value(payload, "options"),
                "reason": _required(payload, "reason"),
                "expected_predicate": _required(payload, "expected_predicate"),
            }
        )
        return self._request("POST", f"/api/c3/control/probes/{budget_id}/execute", json=body)

    def commit_c3_probe(self, payload: dict[str, Any]) -> Any:
        reservation_id = _safe_path_id(payload, "reservation_id")
        body = _control_identity_body(payload)
        body.update(
            {
                "predicate": _required(payload, "predicate"),
                "observed": _object_value(payload, "observed"),
            }
        )
        return self._request(
            "POST",
            f"/api/c3/control/probes/reservations/{reservation_id}/commit",
            json=body,
        )

    def list_c3_operation_artifacts(self, payload: dict[str, Any]) -> Any:
        operation_id = _safe_path_id(payload, "operation_id")
        return self._request(
            "GET",
            f"/api/c3/control/operations/{operation_id}/artifacts",
            params={
                "agent_id": _required(payload, "agent_id"),
                "lease_id": _required(payload, "lease_id"),
            },
        )

    def get_c3_failure_context(self, payload: dict[str, Any]) -> Any:
        allowed = {"operation_id", "agent_id", "lease_id"}
        unexpected = sorted(set(payload) - allowed)
        if unexpected:
            raise ValueError(f"unexpected failure-context fields: {', '.join(unexpected)}")
        operation_id = _safe_path_id(payload, "operation_id")
        return self._request(
            "GET",
            f"/api/c3/control/operations/{operation_id}/failure-context",
            params={
                "agent_id": _required(payload, "agent_id"),
                "lease_id": _required(payload, "lease_id"),
            },
        )

    def download_c3_operation_artifact(self, payload: dict[str, Any]) -> Any:
        operation_id = _safe_path_id(payload, "operation_id")
        artifact_id = _safe_path_id(payload, "artifact_id")
        filename = _safe_path_id(payload, "filename")
        response = self._client.request(
            "GET",
            (f"/api/c3/control/operations/{operation_id}/artifacts/{artifact_id}/files/{filename}"),
            params={
                "agent_id": _required(payload, "agent_id"),
                "lease_id": _required(payload, "lease_id"),
            },
        )
        if response.status_code >= 400:
            raise HuntBackendError(response.status_code, _response_reason(response))
        return {
            "filename": filename,
            "content_type": response.headers.get("content-type", "application/octet-stream"),
            "size": len(response.content),
            "content_base64": base64.b64encode(response.content).decode("ascii"),
        }

    def start_c3_operation(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", "/api/c3/operations", json=_operation_body(payload))

    def get_c3_operation(self, payload: dict[str, Any]) -> Any:
        operation_id = _required(payload, "operation_id")
        return self._request(
            "GET",
            f"/api/c3/operations/{operation_id}",
            params=_operation_read_identity(payload),
        )

    def get_c3_operation_events(self, payload: dict[str, Any]) -> Any:
        operation_id = _required(payload, "operation_id")
        after_seq = _nonnegative_int(payload.get("after_seq", 0), "after_seq")
        limit = _bounded_event_limit(payload.get("limit", 100))
        return self._request(
            "GET",
            f"/api/c3/operations/{operation_id}/events",
            params={
                **_operation_read_identity(payload),
                "after_seq": after_seq,
                "limit": limit,
            },
        )

    def wait_for_operation_event(self, payload: dict[str, Any]) -> Any:
        operation_id = _required(payload, "operation_id")
        agent_id = _required(payload, "agent_id")
        lease_id = _required(payload, "lease_id")
        after_seq = _nonnegative_int(payload.get("after_seq", 0), "after_seq")
        limit = _bounded_event_limit(payload.get("limit", 100))
        timeout_seconds = _bounded_wait_seconds(payload.get("timeout_seconds"))
        poll_interval = min(
            max(float(payload.get("poll_interval_seconds", 0.25)), 0.05),
            2.0,
        )
        deadline = time.monotonic() + timeout_seconds
        heartbeat_key = (agent_id, lease_id)
        projection: Any = {}

        while True:
            if time.monotonic() >= deadline:
                return _operation_wait_timeout(operation_id, projection)
            try:
                now = time.monotonic()
                with self._heartbeat_lock:
                    next_heartbeat_at = self._next_heartbeat_at.get(heartbeat_key, 0.0)
                    heartbeat_due = now >= next_heartbeat_at
                    if heartbeat_due:
                        self._next_heartbeat_at[heartbeat_key] = (
                            now + LEASE_HEARTBEAT_INTERVAL_SECONDS
                        )
                if heartbeat_due:
                    self._request(
                        "POST",
                        f"/api/ledger/leases/{lease_id}/heartbeat",
                        json={
                            "lease_id": lease_id,
                            "agent_id": agent_id,
                            "actor": _agent_actor(agent_id),
                        },
                        timeout=_remaining_http_timeout(deadline, self.config.timeout_seconds),
                    )
                events_result = self._request(
                    "GET",
                    f"/api/c3/operations/{operation_id}/events",
                    params={
                        "agent_id": agent_id,
                        "lease_id": lease_id,
                        "after_seq": after_seq,
                        "limit": limit,
                    },
                    timeout=_remaining_http_timeout(deadline, self.config.timeout_seconds),
                )
            except httpx.TimeoutException:
                return _operation_wait_timeout(operation_id, projection)
            events = _operation_events(events_result)
            if events:
                return events_result
            if bool(events_result.get("has_more")) or bool(events_result.get("truncated")):
                next_after_seq = _nonnegative_int(
                    events_result.get("next_after_seq", after_seq),
                    "next_after_seq",
                )
                if next_after_seq <= after_seq:
                    raise RuntimeError("operation_event_cursor_not_advancing")
                after_seq = next_after_seq
                continue

            try:
                operation = self._request(
                    "GET",
                    f"/api/c3/operations/{operation_id}",
                    params={"agent_id": agent_id, "lease_id": lease_id},
                    timeout=_remaining_http_timeout(deadline, self.config.timeout_seconds),
                )
            except httpx.TimeoutException:
                return _operation_wait_timeout(operation_id, projection)
            projection = _operation_projection(operation)
            if _operation_state(projection) in TERMINAL_OPERATION_STATES:
                return {
                    "operation_id": operation_id,
                    "operation": projection,
                    "events": [],
                    "next_after_seq": after_seq,
                    "has_more": False,
                    "truncated": False,
                    "terminal": True,
                    "timed_out": False,
                }
            if time.monotonic() >= deadline:
                return _operation_wait_timeout(operation_id, projection)
            time.sleep(min(poll_interval, max(deadline - time.monotonic(), 0)))

    def cancel_c3_operation(self, payload: dict[str, Any]) -> Any:
        operation_id = _required(payload, "operation_id")
        body = _selected_payload(payload, ("agent_id", "lease_id", "reason", "redispatch"))
        return self._request("POST", f"/api/c3/operations/{operation_id}/cancel", json=body)

    def retry_c3_operation(self, payload: dict[str, Any]) -> Any:
        operation_id = _required(payload, "operation_id")
        _required(payload, "agent_id")
        _required(payload, "lease_id")
        body = _selected_payload(
            payload,
            (
                "agent_id",
                "command_id",
                "trace_id",
                "lease_id",
                "reason",
                "deadline_at",
                "deadline_seconds",
            ),
        )
        return self._request("POST", f"/api/c3/operations/{operation_id}/retry", json=body)

    def bootstrap_lane(self, payload: dict[str, Any]) -> Any:
        agent_id = _required(payload, "agent_id")
        lane_id = _required(payload, "lane_id")
        session_id = _required(payload, "session_id")
        extension_id = _required(payload, "extension_id")
        target_id = _required(payload, "target_id")
        actor = _agent_actor(agent_id)
        raw_metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        metadata = {**raw_metadata, "target_id": target_id}
        job_url = str(payload.get("job_url") or payload.get("url") or "")

        agent = self.create_agent(
            {"agent_id": agent_id, "component": "c3", "actor": actor, "metadata": metadata}
        )
        lane = self.create_lane(
            {
                "lane_id": lane_id,
                "component": "c3",
                "agent_id": agent_id,
                "actor": actor,
                "metadata": {**metadata, "job_url": job_url},
            }
        )
        session = self.open_session(
            {
                "session_id": session_id,
                "component": "c3",
                "agent_id": agent_id,
                "lane_id": lane_id,
                "parent_session_id": str(payload.get("parent_session_id") or ""),
                "actor": actor,
                "metadata": metadata,
            }
        )
        lease = self.claim_lease(
            {
                "lease_type": "session_mutation",
                "agent_id": agent_id,
                "lane_id": lane_id,
                "session_id": session_id,
                "ttl_seconds": int(payload.get("ttl_seconds") or 60),
                "actor": actor,
                "metadata": metadata,
            }
        )
        lease_id = _lease_id_from_claim(lease)
        try:
            target = self.register_browser_target(
                {
                    **payload,
                    "agent_id": agent_id,
                    "lane_id": lane_id,
                    "session_id": session_id,
                    "extension_id": extension_id,
                    "url": job_url,
                    "actor": actor,
                }
            )
        except Exception as exc:
            cleanup = self._compensate_bootstrap(
                agent_id=agent_id,
                session_id=session_id,
                lease_id=lease_id,
            )
            if not all(step.get("ok") is True for step in cleanup.values()):
                reason = {
                    "reason_code": "bootstrap_cleanup_incomplete",
                    "original_error": _exception_detail(exc),
                    "cleanup": cleanup,
                }
                try:
                    evidence = self.append_event(
                        {
                            "component": "c3",
                            "event_type": "lane.bootstrap_cleanup_incomplete",
                            "actor": actor,
                            "agent_id": agent_id,
                            "lane_id": lane_id,
                            "session_id": session_id,
                            "lease_id": lease_id,
                            "payload": reason,
                        }
                    )
                    reason["evidence"] = evidence
                except Exception as evidence_exc:
                    reason["evidence_error"] = _exception_detail(evidence_exc)
                raise HuntBackendError(500, reason) from exc
            raise
        return {
            "ok": True,
            "browser_target_id": session_id,
            "agent": agent,
            "lane": lane,
            "session": session,
            "lease": lease,
            "target": target,
        }

    def _compensate_bootstrap(
        self, *, agent_id: str, session_id: str, lease_id: str
    ) -> dict[str, Any]:
        cleanup: dict[str, Any] = {}
        try:
            result = self.unregister_browser_target(
                {
                    "session_id": session_id,
                    "agent_id": agent_id,
                    "reason": "bootstrap_failed",
                }
            )
            cleanup["unregister_target"] = {"ok": True, "result": result}
        except HuntBackendError as exc:
            if exc.status_code == 404:
                cleanup["unregister_target"] = {
                    "ok": True,
                    "result": {"status": "already_absent"},
                }
            else:
                cleanup["unregister_target"] = {
                    "ok": False,
                    "error": _exception_detail(exc),
                }
        except Exception as exc:
            cleanup["unregister_target"] = {
                "ok": False,
                "error": _exception_detail(exc),
            }
        if lease_id:
            try:
                result = self.release_lease(
                    {
                        "lease_id": lease_id,
                        "agent_id": agent_id,
                        "actor": _agent_actor(agent_id),
                        "reason": "bootstrap_failed",
                    }
                )
                cleanup["release_lease"] = {"ok": True, "result": result}
            except Exception as exc:
                cleanup["release_lease"] = {
                    "ok": False,
                    "error": _exception_detail(exc),
                }
        else:
            cleanup["release_lease"] = {
                "ok": False,
                "error": {"type": "ValueError", "message": "lease_id missing from claim"},
            }
        return cleanup

    def finish_lane(self, payload: dict[str, Any]) -> Any:
        return self._terminal_lane(payload, "lane.finished")

    def fail_lane(self, payload: dict[str, Any]) -> Any:
        return self._terminal_lane(payload, "lane.failed")

    def transfer_lane(self, payload: dict[str, Any]) -> Any:
        lease_id = _required(payload, "lease_id")
        agent_id = _required(payload, "agent_id")
        target_agent_id = _required(payload, "target_agent_id")
        body = {
            "agent_id": agent_id,
            "actor": _agent_actor(agent_id),
            "target_actor": _agent_actor(target_agent_id),
            "reason": _required(payload, "reason"),
        }
        return self._request("POST", f"/api/ledger/leases/{lease_id}/transfer", json=body)

    def _terminal_lane(self, payload: dict[str, Any], event_type: str) -> Any:
        agent_id = _required(payload, "agent_id")
        lane_id = _required(payload, "lane_id")
        session_id = _required(payload, "session_id")
        lease_id = _required(payload, "lease_id")
        reason = _required(payload, "reason")
        actor = _agent_actor(agent_id)
        return self._request(
            "POST",
            f"/api/ledger/lanes/{lane_id}/terminal",
            json={
                "agent_id": agent_id,
                "session_id": session_id,
                "lease_id": lease_id,
                "event_type": event_type,
                "actor": actor,
                "reason": reason,
                "result": payload.get("result") if isinstance(payload.get("result"), dict) else {},
            },
        )

    def detect_page(self, payload: dict[str, Any]) -> Any:
        return self._run_named_c3_command("c3.detect_page", payload, "Detect apply page state.")

    def inspect_fields(self, payload: dict[str, Any]) -> Any:
        return self._run_named_c3_command("c3.inspect_fields", payload, "Inspect visible fields.")

    def inspect_validation(self, payload: dict[str, Any]) -> Any:
        return self._run_named_c3_command(
            "c3.inspect_validation", payload, "Inspect visible validation state."
        )

    def snapshot_page(self, payload: dict[str, Any]) -> Any:
        return self._run_named_c3_command(
            "c3.snapshot_page", payload, "Capture sanitized page snapshot."
        )

    def get_progress(self, payload: dict[str, Any]) -> Any:
        return self._run_named_c3_command("c3.get_progress", payload, "Read current C3 progress.")

    def fill_page(self, payload: dict[str, Any]) -> Any:
        return self._start_named_c3_operation("c3.fill_page", payload, "Fill current apply page.")

    def fill_remaining_with_llm(self, payload: dict[str, Any]) -> Any:
        return self._start_named_c3_operation(
            "c3.fill_remaining_with_llm",
            payload,
            "Fill remaining fields with generated answers.",
        )

    def page_walk(self, payload: dict[str, Any]) -> Any:
        return self._start_named_c3_operation(
            "c3.page_walk", payload, "Continue filling later apply pages."
        )

    def click_next_after_fill(self, payload: dict[str, Any]) -> Any:
        return self._start_named_c3_operation(
            "c3.click_next_after_fill", payload, "Click safe next action."
        )

    def clear_page(self, payload: dict[str, Any]) -> Any:
        return self._start_named_c3_operation(
            "c3.clear_page", payload, "Clear current apply page fields."
        )

    def cancel_session(self, payload: dict[str, Any]) -> Any:
        return self._start_named_c3_operation(
            "c3.cancel_session", payload, "Cancel current C3 session action."
        )

    def _run_named_c3_command(
        self, command_name: str, payload: dict[str, Any], default_reason: str
    ) -> Any:
        body = dict(payload)
        body["command_name"] = command_name
        body.setdefault("reason", default_reason)
        return self.run_c3_command(body)

    def _start_named_c3_operation(
        self, command_name: str, payload: dict[str, Any], default_reason: str
    ) -> Any:
        body = dict(payload)
        body["command_name"] = command_name
        body.setdefault("reason", default_reason)
        return self.start_c3_operation(body)

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        response = self._client.request(method, path, **kwargs)
        if response.status_code >= 400:
            raise HuntBackendError(response.status_code, _response_reason(response))
        if not response.content:
            return {"ok": True}
        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            return response.json()
        return {"ok": True, "text": response.text}


def _required(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value


def _safe_path_id(payload: dict[str, Any], key: str) -> str:
    value = _required(payload, key)
    if value in {".", ".."} or any(
        not (character.isalnum() or character in "_.-") for character in value
    ):
        raise ValueError(f"{key} must be a safe identifier")
    return value


def _control_identity_body(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        key: _required(payload, key)
        for key in ("operation_id", "agent_id", "lane_id", "session_id", "lease_id")
    }


def _object_value(payload: dict[str, Any], key: str) -> dict[str, Any]:
    value = payload.get(key, {})
    if not isinstance(value, dict):
        raise ValueError(f"{key} must be an object")
    return value


def _allowed_control_action(payload: dict[str, Any], allowed: set[str], reason_code: str) -> str:
    action = _required(payload, "action")
    if action not in allowed:
        raise ValueError(reason_code)
    return action


def _operation_body(payload: dict[str, Any]) -> dict[str, Any]:
    command_name = _required(payload, "command_name")
    if command_name.casefold() == "c3.final_submit":
        raise ValueError("c3.final_submit is blocked for ordinary MCP lane operations")
    if payload.get("allow_submit") is True:
        raise ValueError("allow_submit is not available through ordinary MCP lane tools")
    for key in ("allow_foreground", "allowForeground", "bring_to_front", "bringToFront"):
        if payload.get(key) is True:
            raise ValueError(f"{key} is not available through ordinary MCP lane tools")
    capabilities = payload.get("capabilities", [])
    if not isinstance(capabilities, list):
        raise ValueError("capabilities must be an empty list for ordinary MCP lane operations")
    if capabilities:
        raise ValueError("capabilities must be empty for ordinary MCP lane operations")

    command_payload = payload.get("command_payload", {})
    if not isinstance(command_payload, dict):
        raise ValueError("command_payload must be an object")
    _reject_reserved_command_payload_keys(command_payload)
    body = {
        "command_id": _required(payload, "command_id"),
        "command_name": command_name,
        "trace_id": _required(payload, "trace_id"),
        "agent_id": _required(payload, "agent_id"),
        "lane_id": _required(payload, "lane_id"),
        "session_id": _required(payload, "session_id"),
        "lease_id": _required(payload, "lease_id"),
        "browser_target_id": _required(payload, "browser_target_id"),
        "reason": _required(payload, "reason"),
        "command_payload": command_payload,
        "allow_submit": False,
    }
    for key in (
        "deadline_at",
        "deadline_seconds",
    ):
        if payload.get(key) not in (None, ""):
            body[key] = payload[key]
    if isinstance(payload.get("target"), dict):
        body["target"] = payload["target"]
    if isinstance(payload.get("actor"), dict):
        body["actor"] = payload["actor"]
    return body


def _nonnegative_int(value: Any, key: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} must be a nonnegative integer") from exc
    if parsed < 0:
        raise ValueError(f"{key} must be a nonnegative integer")
    return parsed


def _bounded_event_limit(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("limit must be an integer between 1 and 500")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit must be an integer between 1 and 500") from exc
    if not 1 <= parsed <= 500:
        raise ValueError("limit must be an integer between 1 and 500")
    return parsed


def _operation_read_identity(payload: dict[str, Any]) -> dict[str, str]:
    return {
        "agent_id": _required(payload, "agent_id"),
        "lease_id": _required(payload, "lease_id"),
    }


def _reject_reserved_command_payload_keys(value: Any, path: str = "command_payload") -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            normalized = "".join(
                character for character in str(key).casefold() if character.isalnum()
            )
            if normalized in RESERVED_COMMAND_PAYLOAD_KEYS:
                raise ValueError(f"{path}.{key} is a reserved control key")
            _reject_reserved_command_payload_keys(nested, f"{path}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            _reject_reserved_command_payload_keys(nested, f"{path}[{index}]")


def _bounded_wait_seconds(value: Any) -> float:
    try:
        parsed = DEFAULT_OPERATION_WAIT_SECONDS if value is None else float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("timeout_seconds must be a number") from exc
    if not math.isfinite(parsed) or parsed < 0 or parsed > MAX_OPERATION_WAIT_SECONDS:
        raise ValueError(f"timeout_seconds must be between 0 and {int(MAX_OPERATION_WAIT_SECONDS)}")
    return parsed


def _remaining_http_timeout(deadline: float, configured_timeout: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise httpx.TimeoutException("operation wait deadline elapsed")
    return min(float(configured_timeout), remaining)


def _operation_wait_timeout(operation_id: str, projection: Any) -> dict[str, Any]:
    return {
        "operation_id": operation_id,
        "operation": projection,
        "events": [],
        "terminal": False,
        "timed_out": True,
    }


def _operation_events(result: Any) -> list[Any]:
    if isinstance(result, list):
        return result
    if isinstance(result, dict) and isinstance(result.get("events"), list):
        return result["events"]
    return []


def _operation_state(result: Any) -> str:
    if not isinstance(result, dict):
        return ""
    operation = result.get("operation")
    if isinstance(operation, dict):
        return str(operation.get("state") or "")
    return str(result.get("state") or "")


def _operation_projection(result: Any) -> Any:
    if isinstance(result, dict) and isinstance(result.get("operation"), dict):
        return result["operation"]
    return result


def _agent_actor(agent_id: str) -> dict[str, str]:
    return {"type": "agent", "id": agent_id, "surface": "mcp"}


def _lease_id_from_claim(result: Any) -> str:
    if not isinstance(result, dict):
        return ""
    lease = result.get("lease")
    if isinstance(lease, dict):
        return str(lease.get("lease_id") or "")
    return str(result.get("lease_id") or "")


def _selected_payload(payload: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {key: payload[key] for key in keys if payload.get(key) not in (None, "")}


def _target_from_payload(
    payload: dict[str, Any], command_payload: dict[str, Any]
) -> dict[str, Any]:
    debug_port = (
        payload.get("debug_port") or payload.get("cdp_port") or command_payload.get("cdp_port")
    )
    extension_id = payload.get("extension_id") or command_payload.get("extension_id")
    tab_id = _optional_int(
        payload.get("tab_id") or command_payload.get("tab_id") or command_payload.get("tabId")
    )
    url = payload.get("url") or command_payload.get("url")
    return {
        "browser_kind": payload.get("browser_kind") or "p_chrome",
        "debug_port": debug_port,
        "extension_id": extension_id,
        "options_url": payload.get("options_url") or command_payload.get("options_url") or "",
        "tab_id": tab_id,
        "target_id": payload.get("target_id") or command_payload.get("target_id") or "",
        "url": url or "",
    }


def _browser_target_body(payload: dict[str, Any]) -> dict[str, Any]:
    session_id = _required(payload, "session_id")
    agent_id = _required(payload, "agent_id")
    lane_id = _required(payload, "lane_id")
    extension_id = _required(payload, "extension_id")
    target_id = _required(payload, "target_id")
    debug_port = payload.get("debug_port") or payload.get("cdp_port")
    if not debug_port:
        raise ValueError("debug_port or cdp_port is required")
    return {
        "session_id": session_id,
        "agent_id": agent_id,
        "lane_id": lane_id,
        "browser_kind": payload.get("browser_kind") or "p_chrome",
        "debug_port": int(debug_port),
        "extension_id": extension_id,
        "options_url": payload.get("options_url")
        or f"chrome-extension://{extension_id}/src/options/options.html",
        "tab_id": _optional_int(payload.get("tab_id")),
        "url": payload.get("url") or "",
        "metadata": {
            **(payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}),
            "target_id": target_id,
        },
        "actor": payload.get("actor")
        if isinstance(payload.get("actor"), dict)
        else {"type": "agent", "id": agent_id, "surface": "mcp"},
    }


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _response_reason(response: httpx.Response) -> Any:
    try:
        body = response.json()
    except ValueError:
        return response.text
    if isinstance(body, dict):
        return body.get("detail", body)
    return body


def _exception_detail(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, HuntBackendError):
        return {
            "type": type(exc).__name__,
            "status_code": exc.status_code,
            "reason": exc.reason,
        }
    return {"type": type(exc).__name__, "message": str(exc)[:500]}
