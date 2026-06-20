from __future__ import annotations

import hashlib
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.browser_targets import get_browser_target_store
from backend.c3_browser_bridge import C3BrowserBridgeError, run_c3_extension_command
from backend.ledger.api import get_lease_store, get_ledger_service, require_ledger_access
from backend.ledger.leases import LeaseConflictError, LeaseNotFoundError, LeasePermissionError
from backend.ledger.models import Actor
from backend.ledger.service import LedgerService

CommandStatus = Literal["accepted", "rejected", "started", "completed", "failed", "not_implemented"]


C3_COMMAND_REGISTRY: dict[str, dict[str, Any]] = {
    "c3.detect_page": {"mutates_page": False, "executable": True, "summary": "Detect apply page state."},
    "c3.fill_page": {"mutates_page": True, "executable": True, "summary": "Fill current apply page."},
    "c3.fill_remaining_with_llm": {
        "mutates_page": True,
        "executable": True,
        "summary": "Fill remaining fields with generated answers.",
    },
    "c3.page_walk": {
        "mutates_page": True,
        "executable": False,
        "summary": "Continue filling later pages; registered but not directly exposed by extension receiver yet.",
    },
    "c3.click_next_after_fill": {"mutates_page": True, "executable": True, "summary": "Click safe next action."},
    "c3.clear_page": {"mutates_page": True, "executable": True, "summary": "Clear current page fields."},
    "c3.cancel_session": {"mutates_page": True, "executable": True, "summary": "Cancel current C3 action."},
    "c3.get_progress": {"mutates_page": False, "executable": True, "summary": "Read fill progress."},
    "c3.snapshot_page": {"mutates_page": False, "executable": True, "summary": "Capture sanitized page snapshot."},
    "c3.inspect_fields": {"mutates_page": False, "executable": True, "summary": "Inspect visible fields."},
    "c3.inspect_validation": {"mutates_page": False, "executable": True, "summary": "Inspect visible validation."},
}

router = APIRouter(prefix="/api/c3/commands", tags=["c3-commands"])


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


def _safe_url(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    parsed = urlsplit(value.strip())
    if not parsed.scheme or not parsed.netloc:
        return value.strip()[:240]
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def _safe_target(target: dict[str, Any]) -> dict[str, Any]:
    return {
        "browser_kind": str(target.get("browser_kind") or ""),
        "debug_port": target.get("debug_port"),
        "extension_id": str(target.get("extension_id") or ""),
        "options_url": _safe_url(target.get("options_url")),
        "tab_id": target.get("tab_id"),
        "url": _safe_url(target.get("url")),
    }


def _missing_target(target: dict[str, Any]) -> bool:
    safe = _safe_target(target)
    return not (
        safe["browser_kind"]
        and safe["debug_port"] is not None
        and safe["extension_id"]
        and (safe["tab_id"] is not None or safe["url"])
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


def _merged_target(body: C3CommandRunRequest, store: Any) -> dict[str, Any]:
    registered = _target_from_registry(store, body.session_id)
    return {**registered, **body.target}


def _extension_payload(body: C3CommandRunRequest, target: dict[str, Any], actor: Actor) -> dict[str, Any]:
    command_payload = dict(body.command_payload)
    if target.get("tab_id") is not None and command_payload.get("tabId") is None:
        command_payload["tabId"] = target.get("tab_id")
    command_payload["triggeredBy"] = command_payload.get("triggeredBy") or "mcp_backend_cdp_bridge"
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
    if isinstance(extension_response, dict) and isinstance(extension_response.get("commandReceipt"), dict):
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
