from __future__ import annotations

import json
import os
import re
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

REPO_ROOT = Path(__file__).resolve().parent.parent
MAX_DURABLE_EVENT_BYTES = 16_384
MUTATION_METHODS = {"DELETE", "PATCH", "POST", "PUT"}
_write_lock = threading.Lock()


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def get_audit_log_root() -> Path:
    raw = os.getenv("HUNT_AUDIT_LOG_ROOT", "").strip()
    if raw:
        root = Path(raw).expanduser().resolve()
    elif os.name == "nt":
        root = (Path.home() / "Documents" / "hunt-logs").resolve()
    else:
        root = (Path.home() / ".hunt" / "logs").resolve()
    if _is_relative_to(root, REPO_ROOT.resolve()):
        raise RuntimeError(f"HUNT_AUDIT_LOG_ROOT must not be inside repo: {root}")
    return root


def _audit_log_path() -> Path:
    return get_audit_log_root() / "human-commands.jsonl"


def ensure_audit_storage() -> None:
    log_path = _audit_log_path()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8"):
        pass


def write_audit_event(event: dict[str, object]) -> None:
    serialized = json.dumps(event, separators=(",", ":"), sort_keys=True) + "\n"
    if len(serialized.encode("utf-8")) > MAX_DURABLE_EVENT_BYTES:
        raise ValueError("Sanitized audit event exceeds durable size limit")
    log_path = _audit_log_path()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with _write_lock:
        with log_path.open("a", encoding="utf-8") as stream:
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())


def _route_family(route_template: str) -> str:
    first_segment = route_template.strip("/").split("/", 1)[0].lower()
    allowed = {"accounts", "config", "enrich", "generate", "scrape", "test-discord"}
    return f"/{first_segment}" if first_segment in allowed else ""


def append_server_mutation_event(
    *,
    component: Literal["c0", "c1", "c2"],
    method: str,
    route_template: str,
    status_code: int,
) -> str:
    safe_method = method if method in MUTATION_METHODS else "UNKNOWN"
    safe_route = (
        route_template if re.fullmatch(r"/[A-Za-z0-9_/{}/:.*-]{1,255}", route_template) else ""
    )
    safe_status = status_code if 100 <= status_code <= 599 else 500
    event_id = f"evt_{uuid.uuid4().hex}"
    event: dict[str, object] = {
        "event_id": event_id,
        "ts": datetime.now(UTC).isoformat(),
        "component": component,
        "event_type": "human.command",
        "actor": {"type": "human", "id": "human_local", "surface": f"{component}_http"},
        "lane_id": "",
        "session_id": "",
        "command_id": "",
        "trace_id": "",
        "payload": {
            "eventContext": {
                "component": component,
                "route": _route_family(route_template),
                "page": "",
                "laneId": "",
                "sessionId": "",
                "commandId": "",
                "traceId": "",
            },
            "action": f"{component}.http_mutation",
            "buttonId": "",
            "details": {
                "method": safe_method,
                "route": safe_route,
                "status": safe_status,
            },
        },
        "redaction": {
            "applied": True,
            "rules": ["human_command_no_form_values", "server_owned_metadata"],
        },
    }
    write_audit_event(event)
    return event_id


async def audit_mutation_request(
    request: Request,
    call_next,
    *,
    component: Literal["c0", "c1", "c2"],
    enabled: bool = True,
):
    method = request.method.upper()
    if not enabled or method not in MUTATION_METHODS:
        return await call_next(request)

    try:
        await run_in_threadpool(ensure_audit_storage)
    except Exception:
        return JSONResponse(
            status_code=503,
            content={"detail": "Mutation blocked because durable audit storage is unavailable"},
            headers={"X-Hunt-Audit-Status": "unavailable"},
        )

    response = await call_next(request)
    if response.status_code >= 400:
        return response

    route = request.scope.get("route")
    route_template = getattr(route, "path", "") or ""
    try:
        await run_in_threadpool(
            append_server_mutation_event,
            component=component,
            method=method,
            route_template=route_template,
            status_code=response.status_code,
        )
    except Exception:
        return JSONResponse(
            status_code=500,
            content={"detail": "Mutation completed but durable audit write failed"},
            headers={"X-Hunt-Audit-Status": "failed"},
        )
    response.headers["X-Hunt-Audit-Status"] = "written"
    return response
