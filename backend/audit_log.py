from __future__ import annotations

import json
import re
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from shared.mutation_audit import write_audit_event

REDACTED = "[REDACTED]"
MAX_AUDIT_REQUEST_BYTES = 20_480
MAX_INPUT_PAYLOAD_BYTES = 16_384
_OPAQUE_ID = re.compile(r"^(?:lane|session|cmd|trace)_[a-f0-9]{8,64}$")
_QUEUE_ITEM_ID = re.compile(r"^[a-f0-9]{32}$")
_PATCHABLE_JOB_FIELDS = {
    "ats_type",
    "category",
    "company",
    "description",
    "description_source",
    "is_remote",
    "level",
    "location",
    "operator_notes",
    "operator_tag",
    "title",
}
_BOOLEAN_DETAIL_KEYS = {
    "active",
    "confirmDelete",
    "deleteArtifacts",
    "dryRun",
    "hasDescription",
    "hasDisplayName",
    "hasPassword",
    "hasQuery",
    "hasResume",
    "hasSelectedResume",
    "hasTag",
    "hasUsername",
    "hasValue",
    "includeAdHoc",
    "runNext",
    "secret",
}
_INTEGER_DETAIL_KEYS = {"accountId", "count", "jobId", "limit"}
_VALUE_FREE_STRING_KEYS = {
    "applyType",
    "atsType",
    "enrichmentStatus",
    "key",
    "source",
    "status",
}
_DETAIL_ENUMS = {
    "action": {"delete", "requeue", "set_status"},
    "component": {"c0", "c1", "c2"},
    "direction": {"down", "up"},
    "valueType": {"boolean", "float", "integer", "json", "number", "string"},
}
_ACTION_SPECS: dict[str, tuple[str, set[str]]] = {
    "c0.job.clear_priority": ("job-clear-priority", {"jobId", "runNext"}),
    "c0.job.delete": ("delete-job", {"jobId"}),
    "c0.job.patch": ("edit-job-field", {"jobId", "fields"}),
    "c0.job.requeue": ("requeue-job", {"jobId"}),
    "c0.job.set_priority": ("job-run-next", {"jobId", "runNext"}),
    "c0.jobs.bulk_delete": (
        "jobs-bulk-action",
        {"action", "confirmDelete", "count", "enrichmentStatus"},
    ),
    "c0.jobs.bulk_requeue": (
        "jobs-bulk-action",
        {"action", "confirmDelete", "count", "enrichmentStatus"},
    ),
    "c0.jobs.bulk_set_status": (
        "jobs-bulk-action",
        {"action", "confirmDelete", "count", "enrichmentStatus"},
    ),
    "c0.linkedin_account.save": (
        "save-linkedin-account",
        {"active", "hasDisplayName", "hasPassword", "hasUsername"},
    ),
    "c0.open_apply_page": (
        "open-apply-page",
        {"applyType", "atsType", "hasSelectedResume", "jobId"},
    ),
    "c0.ops.bulk_requeue": (
        "bulk-requeue-run",
        {"dryRun", "hasQuery", "hasTag", "source", "status", "targetStatuses"},
    ),
    "c0.ops.bulk_requeue_count": (
        "bulk-requeue-dry-run",
        {"dryRun", "hasQuery", "hasTag", "source", "status", "targetStatuses"},
    ),
    "c0.ops.requeue_errors": ("requeue-transient-errors", {"errorCodes", "source"}),
    "c0.ops.requeue_stale_processing": ("requeue-stale-processing", set()),
    "c0.settings.save": (
        "save-component-setting",
        {"component", "hasValue", "key", "secret", "valueType"},
    ),
    "c1.enrich": ("trigger-c1-enrich", {"limit"}),
    "c1.reauth": ("trigger-c1-reauth", {"accountId"}),
    "c1.scrape": ("trigger-c1-scrape", set()),
    "c1.verify_easy_apply": ("verify-easy-apply", {"jobId"}),
    "c2.fletcher.bulk_cancel_queue_items": ("bulk-cancel-fletcher-jobs", {"count"}),
    "c2.fletcher.cancel_queue_item": ("cancel-fletcher-job", {"queueItemId"}),
    "c2.fletcher.clear_generated_resumes": (
        "clear-generated-resumes",
        {"deleteArtifacts", "includeAdHoc"},
    ),
    "c2.fletcher.delete_queue_item": ("delete-fletcher-job", {"queueItemId"}),
    "c2.fletcher.move_queue_item": (
        "move-fletcher-job",
        {"direction", "queueItemId"},
    ),
    "c2.fletcher.queue_resume": (
        "queue-fletcher-resume",
        {"hasDescription", "hasResume", "jobId"},
    ),
    "c2.generate": ("trigger-c2-generate", {"jobId"}),
}


class HumanCommandContext(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    component: Literal["c0", "c1", "c2"] | None = None
    route: str = Field(default="", max_length=512)
    page: str = Field(default="", max_length=512)
    lane_id: str = Field(default="", alias="laneId", max_length=128)
    session_id: str = Field(default="", alias="sessionId", max_length=128)
    command_id: str = Field(default="", alias="commandId", max_length=128)
    trace_id: str = Field(default="", alias="traceId", max_length=128)


class HumanCommandDetails(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    account_id: int | None = Field(default=None, alias="accountId", ge=0)
    action: str | None = Field(default=None, max_length=128)
    active: bool | None = None
    apply_type: str | None = Field(default=None, alias="applyType", max_length=128)
    ats_type: str | None = Field(default=None, alias="atsType", max_length=128)
    component: Literal["c0", "c1", "c2"] | None = None
    confirm_delete: bool | None = Field(default=None, alias="confirmDelete")
    count: int | None = Field(default=None, ge=0)
    delete_artifacts: bool | None = Field(default=None, alias="deleteArtifacts")
    direction: Literal["down", "up"] | None = None
    dry_run: bool | None = Field(default=None, alias="dryRun")
    enrichment_status: str | None = Field(
        default=None,
        alias="enrichmentStatus",
        max_length=128,
    )
    error_codes: list[str] | None = Field(
        default=None,
        alias="errorCodes",
        max_length=100,
    )
    fields: list[str] | None = Field(default=None, max_length=32)
    has_description: bool | None = Field(default=None, alias="hasDescription")
    has_display_name: bool | None = Field(default=None, alias="hasDisplayName")
    has_password: bool | None = Field(default=None, alias="hasPassword")
    has_query: bool | None = Field(default=None, alias="hasQuery")
    has_resume: bool | None = Field(default=None, alias="hasResume")
    has_selected_resume: bool | None = Field(default=None, alias="hasSelectedResume")
    has_tag: bool | None = Field(default=None, alias="hasTag")
    has_username: bool | None = Field(default=None, alias="hasUsername")
    has_value: bool | None = Field(default=None, alias="hasValue")
    include_ad_hoc: bool | None = Field(default=None, alias="includeAdHoc")
    job_id: int | None = Field(default=None, alias="jobId", ge=0)
    key: str | None = Field(default=None, max_length=128)
    limit: int | None = Field(default=None, ge=0)
    queue_item_id: str | None = Field(default=None, alias="queueItemId", max_length=128)
    run_next: bool | None = Field(default=None, alias="runNext")
    secret: bool | None = None
    source: str | None = Field(default=None, max_length=128)
    status: str | None = Field(default=None, max_length=128)
    target_statuses: list[str] | None = Field(
        default=None,
        alias="targetStatuses",
        max_length=100,
    )
    value_type: str | None = Field(default=None, alias="valueType", max_length=128)


class HumanCommandPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    event_context: HumanCommandContext = Field(
        default_factory=HumanCommandContext,
        alias="eventContext",
    )
    action: str = Field(max_length=128)
    button_id: str = Field(default="", alias="buttonId", max_length=128)
    details: HumanCommandDetails = Field(default_factory=HumanCommandDetails)


class HumanActor(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["human"]
    id: str = Field(default="human_local", max_length=128)
    surface: str = Field(default="c0_ui", max_length=128)


class HumanCommandEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: str = Field(default_factory=lambda: f"evt_{uuid.uuid4().hex}", max_length=128)
    ts: str = Field(default_factory=lambda: datetime.now(UTC).isoformat(), max_length=128)
    component: Literal["c0", "c1", "c2"]
    event_type: Literal["human.command"]
    actor: HumanActor
    lane_id: str = Field(default="", max_length=128)
    session_id: str = Field(default="", max_length=128)
    command_id: str = Field(default="", max_length=128)
    trace_id: str = Field(default="", max_length=128)
    payload: HumanCommandPayload


def _redacted(rules: set[str], _key: str) -> str:
    rules.add("value_removed")
    return REDACTED


def _sanitize_opaque_id(value: Any, rules: set[str], key: str) -> str:
    candidate = str(value or "").strip()
    if not candidate:
        return ""
    if _OPAQUE_ID.fullmatch(candidate):
        return candidate
    return _redacted(rules, key)


def _route_family(value: Any, rules: set[str]) -> str:
    route = str(value or "").strip()
    if not route:
        return ""
    first_segment = route.split("?", 1)[0].strip("/").split("/", 1)[0].lower()
    allowed = {"control", "fletcher", "jobs", "login", "logs", "ops", "settings"}
    if first_segment in allowed:
        return f"/{first_segment}"
    return _redacted(rules, "route")


def _sanitize_detail_value(key: str, value: Any, rules: set[str]) -> Any:
    if key in _BOOLEAN_DETAIL_KEYS:
        if isinstance(value, bool):
            return value
        return _redacted(rules, key)
    if key in _INTEGER_DETAIL_KEYS:
        if (
            isinstance(value, int)
            and not isinstance(value, bool)
            and 0 <= value <= 9_223_372_036_854_775_807
        ):
            return value
        if value is None and key == "jobId":
            return None
        return _redacted(rules, key)
    if key == "queueItemId":
        candidate = str(value or "").strip().lower()
        if _QUEUE_ITEM_ID.fullmatch(candidate):
            return candidate
        return _redacted(rules, key)
    if key == "fields":
        if not isinstance(value, list) or len(value) > 32:
            raise HTTPException(status_code=422, detail="Invalid human command field list")
        if len(set(map(str, value))) != len(value):
            raise HTTPException(status_code=422, detail="Duplicate human command fields")
        approved = [
            field for field in value if isinstance(field, str) and field in _PATCHABLE_JOB_FIELDS
        ]
        if len(approved) != len(value):
            rules.add("field_names_allowlist")
        return approved
    if key in {"errorCodes", "targetStatuses"}:
        if not isinstance(value, list) or len(value) > 100:
            return _redacted(rules, key)
        rules.add(f"value_count_only:{key}")
        return {"count": len(value)}
    if key in _DETAIL_ENUMS:
        if isinstance(value, str) and value in _DETAIL_ENUMS[key]:
            return value
        return _redacted(rules, key)
    if key in _VALUE_FREE_STRING_KEYS:
        return _redacted(rules, key) if value not in (None, "") else ""
    return _redacted(rules, key)


def _sanitize_details(
    value: Any,
    allowed_keys: set[str],
    rules: set[str],
) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    if len(value) > 20:
        raise HTTPException(status_code=422, detail="Too many human command details")
    unknown_keys = {str(key) for key in value} - allowed_keys
    if unknown_keys:
        raise HTTPException(status_code=422, detail="Unknown human command detail")
    sanitized: dict[str, Any] = {}
    for raw_key, raw_value in value.items():
        key = str(raw_key)
        sanitized[key] = _sanitize_detail_value(key, raw_value, rules)
    return sanitized


def _sanitize_human_payload(
    payload: Any,
    component: str,
    rules: set[str],
) -> dict[str, Any]:
    source = payload if isinstance(payload, Mapping) else {}
    if len(json.dumps(source, separators=(",", ":"), default=str).encode("utf-8")) > (
        MAX_INPUT_PAYLOAD_BYTES
    ):
        raise HTTPException(status_code=422, detail="Human command payload is too large")
    allowed_payload_keys = {"action", "buttonId", "details", "eventContext"}
    if {str(key) for key in source} - allowed_payload_keys:
        raise HTTPException(status_code=422, detail="Unknown human command payload field")
    rules.add("human_command_no_form_values")
    action = str(source.get("action", ""))
    if not action.startswith(f"{component}."):
        raise HTTPException(status_code=422, detail="Human command component mismatch")
    spec = _ACTION_SPECS.get(action)
    if spec is None:
        raise HTTPException(status_code=422, detail="Unknown human command action")
    expected_button, allowed_detail_keys = spec
    button_id = str(source.get("buttonId", ""))
    if button_id != expected_button:
        raise HTTPException(status_code=422, detail="Invalid human command button")
    raw_context = source.get("eventContext")
    context = raw_context if isinstance(raw_context, Mapping) else {}
    allowed_context_keys = {
        "commandId",
        "component",
        "laneId",
        "page",
        "route",
        "sessionId",
        "traceId",
    }
    if {str(key) for key in context} - allowed_context_keys:
        raise HTTPException(status_code=422, detail="Unknown human command context field")
    sanitized = {
        "eventContext": {
            "component": component,
            "route": _route_family(context.get("route"), rules),
            "page": _redacted(rules, "page") if context.get("page") else "",
            "laneId": _sanitize_opaque_id(context.get("laneId"), rules, "laneId"),
            "sessionId": _sanitize_opaque_id(context.get("sessionId"), rules, "sessionId"),
            "commandId": _sanitize_opaque_id(context.get("commandId"), rules, "commandId"),
            "traceId": _sanitize_opaque_id(context.get("traceId"), rules, "traceId"),
        },
        "action": action,
        "buttonId": expected_button,
        "details": _sanitize_details(source.get("details"), allowed_detail_keys, rules),
    }
    return sanitized


def _require_audit_access(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_hunt_service_token: Annotated[str | None, Header()] = None,
) -> None:
    try:
        from hunter.config import HUNT_SERVICE_TOKEN

        expected = (HUNT_SERVICE_TOKEN or "").strip()
    except Exception:
        expected = ""
    if expected:
        bearer = ""
        if authorization and authorization.lower().startswith("bearer "):
            bearer = authorization[7:].strip()
        if bearer == expected or (x_hunt_service_token or "").strip() == expected:
            return
    try:
        from backend.auth_session import SESSION_COOKIE_NAME, validate_session

        if validate_session(request.cookies.get(SESSION_COOKIE_NAME, "")):
            return
    except Exception:
        pass
    raise HTTPException(status_code=401, detail="Missing or invalid audit credential")


router = APIRouter(prefix="/api/audit", tags=["audit"])


@router.post("/events")
def append_human_command(
    body: HumanCommandEvent,
    _access: Annotated[None, Depends(_require_audit_access)],
) -> dict[str, Any]:
    event = body.model_dump(by_alias=True, exclude_none=True)
    rules: set[str] = set()
    event["event_id"] = f"evt_{uuid.uuid4().hex}"
    event["ts"] = datetime.now(UTC).isoformat()
    event["actor"] = {"type": "human", "id": "human_local", "surface": "c0_ui"}
    event["lane_id"] = _sanitize_opaque_id(event["lane_id"], rules, "lane_id")
    event["session_id"] = _sanitize_opaque_id(event["session_id"], rules, "session_id")
    event["command_id"] = _sanitize_opaque_id(event["command_id"], rules, "command_id")
    event["trace_id"] = _sanitize_opaque_id(event["trace_id"], rules, "trace_id")
    event["payload"] = _sanitize_human_payload(event["payload"], event["component"], rules)
    event["redaction"] = {
        "applied": bool(rules),
        "rules": sorted(rules),
    }
    write_audit_event(event)
    return {"event_id": event["event_id"], "logged": True}
