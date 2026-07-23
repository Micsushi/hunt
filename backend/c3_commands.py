from __future__ import annotations

import hashlib
import threading
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.browser_targets import get_browser_target_store
from backend.c3_browser_bridge import (
    C3BrowserBridgeError,
    run_c3_extension_command,
    sanitize_c3_command_payload,
)
from backend.c3_operation_models import (
    C3OperationActionRequest,
    C3OperationRequest,
    C3OperationRetryRequest,
)
from backend.c3_operations import (
    C3OperationConflictError,
    C3OperationManager,
    C3OperationRetryError,
    C3OperationStore,
)
from backend.ledger.api import get_lease_store, get_ledger_service, require_ledger_access
from backend.ledger.leases import LeaseConflictError, LeaseNotFoundError, LeasePermissionError
from backend.ledger.models import Actor
from backend.ledger.service import LedgerService

CommandStatus = Literal["accepted", "rejected", "started", "completed", "failed", "not_implemented"]


C3_COMMAND_REGISTRY: dict[str, dict[str, Any]] = {
    "c3.detect_page": {
        "mutates_page": False,
        "executable": True,
        "summary": "Detect apply page state.",
    },
    "c3.fill_page": {
        "mutates_page": True,
        "executable": True,
        "summary": "Fill current apply page.",
    },
    "c3.fill_remaining_with_llm": {
        "mutates_page": True,
        "executable": True,
        "summary": "Fill remaining fields with generated answers.",
    },
    "c3.page_walk": {
        "mutates_page": True,
        "executable": True,
        "summary": "Continue filling later apply pages through the extension receiver.",
    },
    "c3.click_next_after_fill": {
        "mutates_page": True,
        "executable": True,
        "summary": "Click safe next action.",
    },
    "c3.clear_page": {
        "mutates_page": True,
        "executable": True,
        "summary": "Clear current page fields.",
    },
    "c3.cancel_session": {
        "mutates_page": True,
        "executable": True,
        "summary": "Cancel current C3 action.",
    },
    "c3.get_progress": {
        "mutates_page": False,
        "executable": True,
        "summary": "Read fill progress.",
    },
    "c3.snapshot_page": {
        "mutates_page": False,
        "executable": True,
        "summary": "Capture sanitized page snapshot.",
    },
    "c3.inspect_fields": {
        "mutates_page": False,
        "executable": True,
        "summary": "Inspect visible fields.",
    },
    "c3.inspect_validation": {
        "mutates_page": False,
        "executable": True,
        "summary": "Inspect visible validation.",
    },
}

router = APIRouter(prefix="/api/c3/commands", tags=["c3-commands"])
operations_router = APIRouter(prefix="/api/c3/operations", tags=["c3-operations"])
_operation_managers: dict[str, C3OperationManager] = {}
_operation_managers_lock = threading.Lock()


class C3CommandRunRequest(BaseModel):
    command_name: str = Field(..., min_length=1)
    command_id: str = Field(..., min_length=1)
    trace_id: str = Field(..., min_length=1)
    agent_id: str = Field(..., min_length=1)
    lane_id: str = Field(..., min_length=1)
    session_id: str = Field(..., min_length=1)
    lease_id: str = ""
    target: dict[str, Any] = Field(default_factory=dict)
    command_payload: dict[str, Any] = Field(default_factory=dict)
    reason: str = Field(..., min_length=1)
    actor: dict[str, Any] | None = None


def get_c3_operation_manager(
    service: LedgerService = Depends(get_ledger_service),
    lease_store=Depends(get_lease_store),
    target_store=Depends(get_browser_target_store),
) -> C3OperationManager:
    key = str(service.root.resolve())
    with _operation_managers_lock:
        manager = _operation_managers.get(key)
        if manager is None:
            manager = C3OperationManager(
                C3OperationStore(service.root),
                lease_store=lease_store,
                target_store=target_store,
                bridge=run_c3_extension_command,
                max_workers=8,
            )
            from backend.c3_monitor_runtime import build_c3_operation_monitor

            manager.monitor = build_c3_operation_monitor(manager)
            _operation_managers[key] = manager
        return manager


def shutdown_c3_operation_managers(*, wait: bool = True) -> None:
    with _operation_managers_lock:
        managers = list(_operation_managers.values())
        _operation_managers.clear()
    for manager in managers:
        manager.shutdown(wait=wait)


def _safe_url(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    parsed = urlsplit(value.strip())
    if not parsed.scheme or not parsed.netloc:
        return value.strip()[:240]
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def _safe_target(target: dict[str, Any]) -> dict[str, Any]:
    raw_url = str(target.get("url") or "").split("#", 1)[0]
    metadata = target.get("metadata") if isinstance(target.get("metadata"), dict) else {}
    return {
        "browser_kind": str(target.get("browser_kind") or ""),
        "debug_port": target.get("debug_port"),
        "extension_id": str(target.get("extension_id") or ""),
        "options_url": _safe_url(target.get("options_url")),
        "tab_id": target.get("tab_id"),
        "target_id": str(target.get("target_id") or metadata.get("target_id") or ""),
        "url": _safe_url(target.get("url")),
        "url_sha256": hashlib.sha256(raw_url.encode("utf-8")).hexdigest() if raw_url else "",
    }


def _exact_operation_target(target: dict[str, Any]) -> dict[str, Any]:
    """Pin the exact registered target used for mutating operation dispatch."""
    safe = _safe_target(target)
    exact_url = str(target.get("url") or "").strip().split("#", 1)[0]
    if not exact_url:
        return safe
    safe["url"] = exact_url
    safe["url_sha256"] = hashlib.sha256(exact_url.encode("utf-8")).hexdigest()
    safe["target_id"] = str(target.get("target_id") or "")
    return safe


def _missing_target(target: dict[str, Any]) -> bool:
    safe = _safe_target(target)
    return not (
        safe["browser_kind"]
        and safe["debug_port"] is not None
        and safe["extension_id"]
        and safe["tab_id"] is not None
        and safe["target_id"]
        and safe["url"]
    )


def _reason_metadata(reason: str) -> dict[str, Any]:
    encoded = reason.encode("utf-8")
    return {
        "reason_length": len(reason),
        "reason_sha256_prefix": hashlib.sha256(encoded).hexdigest()[:12],
    }


def _actor_for_request(body: C3CommandRunRequest) -> tuple[Actor, str | None]:
    raw = body.actor or {}
    actor_type = str(raw.get("type") or "agent")
    actor_id = str(raw.get("id") or body.agent_id)
    surface = str(raw.get("surface") or "mcp")
    if actor_type != "agent" or actor_id != body.agent_id:
        return Actor(type="agent", id=body.agent_id, surface=surface), "bad_actor"
    return Actor(type="agent", id=body.agent_id, surface=surface), None


def _command_event(
    body: C3CommandRunRequest,
    *,
    actor: Actor,
    event_type: str,
    status: CommandStatus,
    reason_code: str,
    target: dict[str, Any] | None = None,
) -> dict[str, Any]:
    command = C3_COMMAND_REGISTRY.get(body.command_name) or {}
    return {
        "component": "c3",
        "event_type": event_type,
        "actor": actor.as_event_actor(),
        "agent_id": body.agent_id,
        "lane_id": body.lane_id,
        "session_id": body.session_id,
        "lease_id": body.lease_id,
        "command_id": body.command_id,
        "trace_id": body.trace_id,
        "payload": {
            "command_name": body.command_name,
            "status": status,
            "reason_code": reason_code,
            "mutates_page": bool(command.get("mutates_page")),
            "target": _safe_target(target or body.target),
            **_reason_metadata(body.reason),
        },
    }


def _append_command_event(
    service: LedgerService,
    body: C3CommandRunRequest,
    *,
    actor: Actor,
    event_type: str,
    status: CommandStatus,
    reason_code: str,
    target: dict[str, Any] | None = None,
) -> str:
    result = service.append_event(
        _command_event(
            body,
            actor=actor,
            event_type=event_type,
            status=status,
            reason_code=reason_code,
            target=target,
        )
    )
    return str(result["event_id"])


def _target_from_registry(store: Any, session_id: str) -> dict[str, Any]:
    target = store.get(session_id)
    return target.as_response() if target is not None else {}


_OPERATION_TARGET_SELECTORS = (
    "browser_kind",
    "debug_port",
    "extension_id",
    "options_url",
    "tab_id",
    "target_id",
    "url",
)


def _registered_operation_target(
    store: Any,
    body: C3OperationRequest,
) -> dict[str, Any]:
    record = store.get(body.session_id)
    if record is None:
        raise HTTPException(
            status_code=400,
            detail={"reason_code": "browser_target_not_registered"},
        )
    target = record.as_response()
    metadata = target.get("metadata") if isinstance(target.get("metadata"), dict) else {}
    target["target_id"] = str(target.get("target_id") or metadata.get("target_id") or "")
    if (
        target.get("tab_id") is None
        or not str(target.get("target_id") or "")
        or not str(target.get("url") or "")
    ):
        raise HTTPException(
            status_code=400,
            detail={"reason_code": "browser_target_exact_identity_missing"},
        )
    if str(target.get("session_id") or "") != body.session_id:
        raise HTTPException(
            status_code=400,
            detail={"reason_code": "browser_target_mismatch"},
        )
    if str(target.get("agent_id") or "") != body.agent_id:
        raise HTTPException(
            status_code=403,
            detail={"reason_code": "browser_target_owner_mismatch"},
        )
    if str(target.get("lane_id") or "") != body.lane_id:
        raise HTTPException(
            status_code=400,
            detail={"reason_code": "browser_target_lane_mismatch"},
        )
    mismatched = [
        selector
        for selector in _OPERATION_TARGET_SELECTORS
        if selector in body.target and body.target[selector] != target.get(selector)
    ]
    if mismatched:
        raise HTTPException(
            status_code=400,
            detail={
                "reason_code": "browser_target_selector_mismatch",
                "selectors": mismatched,
            },
        )
    return target


def _merged_target(body: C3CommandRunRequest, store: Any) -> dict[str, Any]:
    registered = _target_from_registry(store, body.session_id)
    merged = {**registered, **body.target}
    merged["target_id"] = _safe_target(merged)["target_id"]
    return merged


def _require_request_lease(body: Any, lease_store: Any, actor: Actor) -> None:
    try:
        lease = lease_store.require_mutation_lease(body.session_id, actor, body.lease_id)
    except LeaseConflictError as exc:
        raise HTTPException(status_code=403, detail={"reason_code": "bad_actor"}) from exc
    except (LeaseNotFoundError, LeasePermissionError, KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail={"reason_code": "missing_lease"}) from exc
    if lease is None or lease.lane_id != body.lane_id:
        raise HTTPException(status_code=400, detail={"reason_code": "missing_lease"})


def _operation_json(operation: Any) -> dict[str, Any]:
    return operation.model_dump(mode="json", by_alias=True)


def _extension_payload(
    body: C3CommandRunRequest, target: dict[str, Any], actor: Actor
) -> dict[str, Any]:
    command_payload = sanitize_c3_command_payload(body.command_payload)
    if target.get("tab_id") is not None and command_payload.get("tabId") is None:
        command_payload["tabId"] = target.get("tab_id")
    command_payload["operationId"] = body.command_id
    command_payload["allowSubmit"] = False
    command_payload["triggeredBy"] = "mcp_backend_cdp_bridge"
    return {
        "command_name": body.command_name,
        "command_id": body.command_id,
        "trace_id": body.trace_id,
        "agent_id": body.agent_id,
        "lane_id": body.lane_id,
        "session_id": body.session_id,
        "lease_id": body.lease_id,
        "actor": actor.as_event_actor(),
        "tab_id": target.get("tab_id"),
        "url": target.get("url") or "",
        "command_payload": command_payload,
    }


def _response(
    body: C3CommandRunRequest,
    *,
    status: CommandStatus,
    reason_code: str,
    ledger_event_id: str,
    http_status: int,
) -> JSONResponse:
    content = {
        "status": status,
        "reason_code": reason_code,
        "command_name": body.command_name,
        "command_id": body.command_id,
        "trace_id": body.trace_id,
        "agent_id": body.agent_id,
        "lane_id": body.lane_id,
        "session_id": body.session_id,
        "lease_id": body.lease_id,
        "ledger_event_id": ledger_event_id,
        "execution": {"attempted": False},
    }
    return JSONResponse(status_code=http_status, content=content)


def _normalized_receipt(
    body: C3CommandRunRequest,
    extension_response: Any,
    *,
    status: CommandStatus,
    reason_code: str,
) -> dict[str, Any]:
    receipt = {}
    if isinstance(extension_response, dict) and isinstance(
        extension_response.get("commandReceipt"), dict
    ):
        receipt = extension_response["commandReceipt"]
    return {
        "command_id": body.command_id,
        "trace_id": body.trace_id,
        "command_name": body.command_name,
        "status": status,
        "ok": bool(receipt.get("ok")) if receipt else status == "accepted",
        "reason_code": receipt.get("reason") or reason_code,
        "message": receipt.get("message") or "",
        "filled_field_count": int(receipt.get("filledFieldCount") or 0),
        "pending_llm_field_count": int(receipt.get("pendingLlmFieldCount") or 0),
        "manual_review_required": bool(receipt.get("manualReviewRequired")),
    }


def _reject(
    service: LedgerService,
    body: C3CommandRunRequest,
    *,
    actor: Actor,
    reason_code: str,
    http_status: int = 400,
) -> JSONResponse:
    ledger_event_id = _append_command_event(
        service,
        body,
        actor=actor,
        event_type="command.rejected",
        status="rejected",
        reason_code=reason_code,
    )
    return _response(
        body,
        status="rejected",
        reason_code=reason_code,
        ledger_event_id=ledger_event_id,
        http_status=http_status,
    )


@router.post("/run")
def run_c3_command(
    body: C3CommandRunRequest,
    _access: None = Depends(require_ledger_access),
    service: LedgerService = Depends(get_ledger_service),
    lease_store=Depends(get_lease_store),
    target_store=Depends(get_browser_target_store),
):
    actor, actor_error = _actor_for_request(body)
    target = _merged_target(body, target_store)
    if actor_error:
        return _reject(service, body, actor=actor, reason_code=actor_error)
    if body.command_name not in C3_COMMAND_REGISTRY:
        return _reject(service, body, actor=actor, reason_code="unknown_command")
    if not C3_COMMAND_REGISTRY[body.command_name].get("executable", True):
        return _reject(service, body, actor=actor, reason_code="unsupported_command_route")
    if _missing_target(target):
        return _reject(service, body, actor=actor, reason_code="missing_target")
    if not body.lease_id.strip():
        return _reject(service, body, actor=actor, reason_code="missing_lease")

    try:
        lease = lease_store.require_mutation_lease(body.session_id, actor, body.lease_id)
    except LeaseConflictError:
        return _reject(service, body, actor=actor, reason_code="bad_actor")
    except (LeaseNotFoundError, LeasePermissionError, KeyError, ValueError):
        return _reject(service, body, actor=actor, reason_code="missing_lease")

    if lease is None or lease.lane_id != body.lane_id:
        return _reject(service, body, actor=actor, reason_code="missing_lease")

    requested_event_id = _append_command_event(
        service,
        body,
        actor=actor,
        event_type="command.requested",
        status="accepted",
        reason_code="browser_execution_requested",
        target=target,
    )
    started_event_id = _append_command_event(
        service,
        body,
        actor=actor,
        event_type="command.started",
        status="started",
        reason_code="browser_execution_started",
        target=target,
    )
    try:
        extension_response = run_c3_extension_command(
            target,
            _extension_payload(body, target, actor),
        )
    except C3BrowserBridgeError as exc:
        failed_event_id = _append_command_event(
            service,
            body,
            actor=actor,
            event_type="command.failed",
            status="failed",
            reason_code=str(exc),
            target=target,
        )
        return _response(
            body,
            status="rejected",
            reason_code=str(exc),
            ledger_event_id=failed_event_id,
            http_status=502,
        )
    except Exception:
        failed_event_id = _append_command_event(
            service,
            body,
            actor=actor,
            event_type="command.failed",
            status="failed",
            reason_code="unexpected_error",
            target=target,
        )
        return _response(
            body,
            status="rejected",
            reason_code="unexpected_error",
            ledger_event_id=failed_event_id,
            http_status=500,
        )

    completed_event_id = _append_command_event(
        service,
        body,
        actor=actor,
        event_type="command.completed",
        status="completed",
        reason_code="browser_execution_completed",
        target=target,
    )

    return JSONResponse(
        status_code=200,
        content={
            "status": "accepted",
            "reason_code": "browser_execution_completed",
            "command_name": body.command_name,
            "command_id": body.command_id,
            "trace_id": body.trace_id,
            "agent_id": body.agent_id,
            "lane_id": body.lane_id,
            "session_id": body.session_id,
            "lease_id": body.lease_id,
            "ledger_event_id": completed_event_id,
            "ledger_event_ids": {
                "requested": requested_event_id,
                "started": started_event_id,
                "completed": completed_event_id,
            },
            "execution": {"attempted": True, "bridge": "playwright_cdp"},
            "target": _safe_target(target),
            "response": extension_response,
            "receipt": _normalized_receipt(
                body,
                extension_response,
                status="accepted",
                reason_code="browser_execution_completed",
            ),
            "commandReceipt": extension_response.get("commandReceipt")
            if isinstance(extension_response, dict)
            else None,
        },
    )


@router.get("/catalog")
def get_c3_command_catalog(_access: None = Depends(require_ledger_access)):
    return {
        "commands": [
            {
                "command_name": name,
                "mutates_page": bool(definition.get("mutates_page")),
                "executable": bool(definition.get("executable")),
                "summary": str(definition.get("summary") or ""),
            }
            for name, definition in sorted(C3_COMMAND_REGISTRY.items())
        ]
    }


@operations_router.post("")
def start_c3_operation(
    body: C3OperationRequest,
    _access: None = Depends(require_ledger_access),
    manager: C3OperationManager = Depends(get_c3_operation_manager),
    lease_store=Depends(get_lease_store),
    target_store=Depends(get_browser_target_store),
):
    actor_type = str((body.actor or {}).get("type") or "agent")
    actor_id = str((body.actor or {}).get("id") or body.agent_id)
    actor = Actor(
        type="agent",
        id=body.agent_id,
        surface=str((body.actor or {}).get("surface") or "mcp"),
    )
    if actor_type != "agent" or actor_id != body.agent_id:
        raise HTTPException(status_code=403, detail={"reason_code": "bad_actor"})
    definition = C3_COMMAND_REGISTRY.get(body.command)
    if definition is None:
        raise HTTPException(status_code=400, detail={"reason_code": "unknown_command"})
    if not definition.get("executable", True):
        raise HTTPException(status_code=400, detail={"reason_code": "unsupported_command_route"})
    if body.browser_target_id != body.session_id:
        raise HTTPException(
            status_code=400,
            detail={"reason_code": "browser_target_mismatch"},
        )
    target = _registered_operation_target(target_store, body)
    if not body.lease_id.strip():
        raise HTTPException(status_code=400, detail={"reason_code": "missing_lease"})
    _require_request_lease(body, lease_store, actor)
    request = body.model_copy(
        update={"target": _exact_operation_target(target), "actor": actor.as_event_actor()}
    )
    try:
        operation = manager.start(
            request,
            mutates_page=bool(definition.get("mutates_page")),
        )
    except C3OperationConflictError as exc:
        raise HTTPException(
            status_code=409,
            detail={"reason_code": exc.reason_code, "operation_id": exc.operation_id},
        ) from exc
    return JSONResponse(
        status_code=202,
        content={
            "status": "accepted",
            "operation_id": operation.operation_id,
            "operation": _operation_json(operation),
        },
    )


@operations_router.get("/{operation_id}")
def get_c3_operation(
    operation_id: str,
    agent_id: str = Query(min_length=1),
    lease_id: str = Query(min_length=1),
    _access: None = Depends(require_ledger_access),
    manager: C3OperationManager = Depends(get_c3_operation_manager),
):
    operation = _authorize_operation_read(operation_id, agent_id, lease_id, manager)
    return {"operation": _operation_json(operation)}


@operations_router.get("/{operation_id}/events")
def get_c3_operation_events(
    operation_id: str,
    agent_id: str = Query(min_length=1),
    lease_id: str = Query(min_length=1),
    after_seq: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    _access: None = Depends(require_ledger_access),
    manager: C3OperationManager = Depends(get_c3_operation_manager),
):
    _authorize_operation_read(operation_id, agent_id, lease_id, manager)
    page = manager.event_page(operation_id, after_seq=after_seq, limit=limit)
    return {
        "operation_id": operation_id,
        "after_seq": after_seq,
        "limit": limit,
        "events": [event.model_dump(mode="json") for event in page.events],
        "next_after_seq": page.next_after_seq,
        "has_more": page.has_more,
        "truncated": page.truncated,
    }


def _authorize_operation_read(
    operation_id: str,
    agent_id: str,
    lease_id: str,
    manager: C3OperationManager,
):
    try:
        operation = manager.get(operation_id)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=404, detail={"reason_code": "operation_not_found"}) from exc
    if operation.agent_id != agent_id or operation.lease_id != lease_id:
        raise HTTPException(status_code=403, detail={"reason_code": "operation_identity_mismatch"})
    return operation


def _authorized_operation_action(
    operation: Any,
    body: C3OperationActionRequest | C3OperationRetryRequest,
    lease_store: Any,
) -> tuple[str, str]:
    agent_id = body.agent_id
    lease_id = body.lease_id
    if agent_id != operation.agent_id:
        raise HTTPException(status_code=403, detail={"reason_code": "bad_actor"})
    request = type(
        "OperationLeaseRequest",
        (),
        {
            "session_id": operation.session_id,
            "lane_id": operation.lane_id,
            "lease_id": lease_id,
        },
    )()
    _require_request_lease(
        request,
        lease_store,
        Actor(type="agent", id=agent_id, surface="mcp"),
    )
    return agent_id, lease_id


@operations_router.post("/{operation_id}/cancel")
def cancel_c3_operation(
    operation_id: str,
    body: C3OperationActionRequest,
    _access: None = Depends(require_ledger_access),
    manager: C3OperationManager = Depends(get_c3_operation_manager),
    lease_store=Depends(get_lease_store),
):
    try:
        current = manager.get(operation_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail={"reason_code": "operation_not_found"}) from exc
    _authorized_operation_action(current, body, lease_store)
    try:
        operation = manager.cancel(
            operation_id,
            reason=body.reason or "agent_cancel",
            redispatch=body.redispatch,
        )
    except C3OperationConflictError as exc:
        raise HTTPException(status_code=409, detail={"reason_code": exc.reason_code}) from exc
    return JSONResponse(
        status_code=202,
        content={
            "status": "cancelling",
            "operation_id": operation.operation_id,
            "operation": _operation_json(operation),
        },
    )


@operations_router.post("/{operation_id}/retry")
def retry_c3_operation(
    operation_id: str,
    body: C3OperationRetryRequest,
    _access: None = Depends(require_ledger_access),
    manager: C3OperationManager = Depends(get_c3_operation_manager),
    lease_store=Depends(get_lease_store),
):
    try:
        parent = manager.get(operation_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail={"reason_code": "operation_not_found"}) from exc
    _authorized_operation_action(parent, body, lease_store)
    try:
        operation = manager.retry(
            operation_id,
            command_id=body.command_id,
            trace_id=body.trace_id,
            lease_id=body.lease_id,
            reason=body.reason,
            deadline_at=body.deadline_at,
            deadline_seconds=body.deadline_seconds,
        )
    except (C3OperationRetryError, C3OperationConflictError) as exc:
        raise HTTPException(
            status_code=409,
            detail={"reason_code": exc.reason_code},
        ) from exc
    return JSONResponse(
        status_code=202,
        content={
            "status": "accepted",
            "operation_id": operation.operation_id,
            "parent_operation_id": operation.parent_operation_id,
            "operation": _operation_json(operation),
        },
    )
