from __future__ import annotations

import json
import math
import re
import threading
import uuid
from collections.abc import Callable, Collection
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import islice
from pathlib import Path
from typing import Any

from backend.c3_browser_bridge import (
    C3BrowserBridgeError,
    _bounded_bridge_timeout_ms,
    c3_bridge_response_ok,
    sanitize_c3_command_payload,
)
from backend.c3_failure_context import C3FailureContext, build_failure_context
from backend.c3_identifiers import restore_trusted_generated_c3_ids
from backend.c3_operation_models import (
    NONTERMINAL_STATES,
    C3Operation,
    C3OperationRequest,
    OperationEvent,
    validate_transition,
)
from backend.ledger.config import initialize_ledger_root
from backend.ledger.jsonl_store import JsonlLedger
from backend.ledger.redaction import redact_payload

_LOCKS: dict[Path, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()
_STATE_BY_EVENT = {
    "operation.requested": "queued",
    "operation.started": "running",
    "operation.slow": "slow",
    "operation.suspected_stall": "suspected_stall",
    "operation.stalled": "stalled",
    "operation.cancel_requested": "cancelling",
    "operation.cancelled": "cancelled",
    "operation.completed": "completed",
    "operation.failed": "failed",
    "operation.orphaned": "orphaned",
}
_LIFECYCLE_EVENTS = frozenset(
    {
        *_STATE_BY_EVENT,
        "operation.cancel_redispatched",
        "operation.cancel_attempted",
        "operation.cancel_pending",
        "operation.cancel_failed",
        "operation.cancel_acknowledged",
    }
)
_POST_TERMINAL_IGNORED_EVENTS = frozenset(
    {
        "operation.heartbeat",
        "operation.progress",
        "operation.health_probe_completed",
        *_LIFECYCLE_EVENTS,
    }
)
_PROJECTION_NEUTRAL_EVENTS = frozenset(
    {"diagnosis.failed", "operation.result_ignored_after_deadline"}
)
_TAIL_READ_CHUNK_BYTES = 64 * 1024
_TAIL_READ_MAX_BYTES = 2 * 1024 * 1024
_EVENT_PAGE_MAX_LIMIT = 500
_EVENT_OFFSET_CACHE_LIMIT = 8_192
_EVENT_PAGE_DEFAULT_BYTES = 512 * 1024
_EVENT_PAGE_MAX_BYTES = 2 * 1024 * 1024
_DIAGNOSIS_EVENT_LIMIT = 128
_EVENT_SEQ_PREFIX_RE = re.compile(rb'"seq"\s*:\s*(\d+)')
_SELECTOR_VALUE_RE = re.compile(r"(?i)(\[\s*value\s*=\s*)(?:\"[^\"]*\"|'[^']*'|[^\]\s]+)(\s*\])")
_EVENT_PRIVATE_KEYS = frozenset(
    {
        "address",
        "afterrawvalue",
        "aftertext",
        "answer",
        "answerpreview",
        "answers",
        "answertext",
        "beforerawvalue",
        "beforetext",
        "commandpayload",
        "content",
        "coverletter",
        "defaultresume",
        "dom",
        "domhtml",
        "domsnapshot",
        "enteredvalue",
        "generatedanswers",
        "html",
        "htmlclip",
        "htmlsnapshot",
        "innerhtml",
        "outerhtml",
        "pagetext",
        "password",
        "profile",
        "rawvalue",
        "resumebody",
        "resumetext",
        "selectedoption",
        "text",
        "typedvalue",
        "value",
        "values",
    }
)
_EVENT_MAX_DEPTH = 10
_EVENT_MAX_MAPPING_KEYS = 128
_EVENT_MAX_LIST_ITEMS = 128
_EVENT_MAX_STRING_CHARS = 16_384
_EVENT_MAX_TOTAL_STRING_CHARS = 240_000
_EVENT_MAX_NODES = 2_048
_BRIDGE_SCAN_MAX_NODES = 2_048
_BRIDGE_SCAN_MAX_DEPTH = 16
_BRIDGE_NEAR_MISS_LIMIT = 8
_BRIDGE_TRANSITION_HISTORY_LIMIT = 8
_BRIDGE_FILLED_AUTH_FIELD_LIMIT = 4
_BRIDGE_EVIDENCE_GATED_AUTH_LIMITS = frozenset(
    {
        "auth_flow_limit_reached",
        "auth_same_page_attempt_limit_reached",
    }
)
_BRIDGE_STOP_DETAIL_FIELDS = {
    "authstate": "auth_state",
    "authuistate": "auth_ui_state",
    "observedauthstate": "observed_auth_state",
    "observedauthuistate": "observed_auth_ui_state",
    "effectiveauthstate": "effective_auth_state",
    "effectiveauthuistate": "effective_auth_ui_state",
    "fromauthstate": "from_auth_state",
    "toauthstate": "to_auth_state",
    "workflowstate": "workflow_state",
    "fromworkflowstate": "from_workflow_state",
    "toworkflowstate": "to_workflow_state",
    "transitioncount": "transition_count",
    "authtransitioncount": "transition_count",
    "cycleperiod": "cycle_period",
    "cyclelength": "cycle_length",
    "rootpresent": "root_present",
    "rootchildcount": "root_child_count",
    "fieldcount": "field_count",
    "validationcount": "validation_count",
    "safenavigationcount": "safe_navigation_count",
    "readinessattempts": "readiness_attempts",
}
_BRIDGE_TRANSITION_FIELDS = {
    "fromauthstate": "from_auth_state",
    "fromauthuistate": "from_auth_ui_state",
    "toauthstate": "to_auth_state",
    "toauthuistate": "to_auth_ui_state",
    "observedstate": "observed_auth_state",
    "observedauthstate": "observed_auth_state",
    "observeduistate": "observed_auth_ui_state",
    "observedauthuistate": "observed_auth_ui_state",
    "effectivestate": "effective_auth_state",
    "effectiveauthstate": "effective_auth_state",
    "effectiveuistate": "effective_auth_ui_state",
    "effectiveauthuistate": "effective_auth_ui_state",
    "effectivefromauthstate": "effective_from_auth_state",
    "effectivefromauthuistate": "effective_from_auth_ui_state",
}
_OMIT = object()


@dataclass(frozen=True)
class C3OperationEventPage:
    events: tuple[OperationEvent, ...]
    next_after_seq: int
    has_more: bool
    truncated: bool
    bytes_read: int


def _lock_for(path: Path) -> threading.RLock:
    resolved = path.resolve()
    with _LOCKS_GUARD:
        if resolved not in _LOCKS:
            _LOCKS[resolved] = threading.RLock()
        return _LOCKS[resolved]


def _now() -> datetime:
    return datetime.now(UTC)


def _alphabetic_uuid(prefix: str) -> str:
    alphabetic = uuid.uuid4().hex.translate(str.maketrans("0123456789", "ghijklmnop"))
    return f"{prefix}-{alphabetic}"


def _bridge_stopped_reason(response: Any) -> str:
    if not isinstance(response, dict):
        return ""
    return str(response.get("stoppedReason") or response.get("stopped_reason") or "")


def _normalized_event_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def _sanitize_operation_event_payload(
    value: Any,
    *,
    _depth: int = 0,
    _budget: dict[str, int] | None = None,
) -> Any:
    """Bound event structure and remove applicant-entered values before JSONL persistence."""

    budget = _budget if _budget is not None else {"nodes": 0, "string_chars": 0}
    budget["nodes"] += 1
    if budget["nodes"] > _EVENT_MAX_NODES:
        return {"truncated": True, "reason": "event_node_limit"}
    if _depth > _EVENT_MAX_DEPTH:
        return {"truncated": True, "reason": "event_depth_limit"}
    if isinstance(value, dict):
        safe: dict[str, Any] = {}
        for index, (key, child) in enumerate(value.items()):
            if index >= _EVENT_MAX_MAPPING_KEYS:
                safe["truncated"] = True
                break
            if _normalized_event_key(key) in _EVENT_PRIVATE_KEYS:
                continue
            retained = _sanitize_operation_event_payload(child, _depth=_depth + 1, _budget=budget)
            if retained is not _OMIT:
                safe[str(key)[:160]] = retained
        return safe
    if isinstance(value, (list, tuple)):
        safe = [
            _sanitize_operation_event_payload(child, _depth=_depth + 1, _budget=budget)
            for child in value[:_EVENT_MAX_LIST_ITEMS]
        ]
        if len(value) > _EVENT_MAX_LIST_ITEMS:
            safe.append({"truncated": True, "reason": "event_list_limit"})
        return [child for child in safe if child is not _OMIT]
    if isinstance(value, str):
        remaining = max(0, _EVENT_MAX_TOTAL_STRING_CHARS - budget["string_chars"])
        retained = value[: min(_EVENT_MAX_STRING_CHARS, remaining)]
        budget["string_chars"] += len(retained)
        return retained if retained else "[TRUNCATED]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:_EVENT_MAX_STRING_CHARS]


def _redact_operation_event_payload(payload: dict[str, Any]) -> dict[str, Any]:
    redacted, _redaction = redact_payload(payload)
    restored = restore_trusted_generated_c3_ids(redacted, payload)
    return restored if isinstance(restored, dict) else {}


def _bounded_bridge_mappings(value: Any):
    stack: list[tuple[Any, int]] = [(value, 0)]
    visited = 0
    while stack:
        current, depth = stack.pop()
        visited += 1
        if visited > _BRIDGE_SCAN_MAX_NODES:
            return
        if isinstance(current, dict):
            yield current
            if depth >= _BRIDGE_SCAN_MAX_DEPTH:
                continue
            children = tuple(islice(current.values(), _EVENT_MAX_MAPPING_KEYS))
            for child in reversed(children):
                if isinstance(child, (dict, list, tuple)):
                    stack.append((child, depth + 1))
        elif isinstance(current, (list, tuple)) and depth < _BRIDGE_SCAN_MAX_DEPTH:
            for child in reversed(current[:_EVENT_MAX_LIST_ITEMS]):
                if isinstance(child, (dict, list, tuple)):
                    stack.append((child, depth + 1))


def _mapping_value(value: dict[str, Any], names: set[str]) -> Any:
    normalized = {_normalized_event_key(name) for name in names}
    for mapping in _bounded_bridge_mappings(value):
        for index, (key, candidate) in enumerate(mapping.items()):
            if index >= _EVENT_MAX_MAPPING_KEYS:
                break
            if _normalized_event_key(key) in normalized:
                return candidate
    return None


def _direct_mapping_value(value: dict[str, Any], names: set[str]) -> Any:
    normalized = {_normalized_event_key(name) for name in names}
    for index, (key, candidate) in enumerate(value.items()):
        if index >= _EVENT_MAX_MAPPING_KEYS:
            break
        if _normalized_event_key(key) in normalized:
            return candidate
    return None


def _machine_reason(value: Any, fallback: str = "") -> str:
    text = str(value or "").strip()
    if not text or len(text) > 160 or not re.fullmatch(r"[A-Za-z0-9_.:-]+", text):
        return fallback
    return re.sub(r"[^A-Za-z0-9]+", "_", text).strip("_").lower() or fallback


def _safe_bridge_label(value: Any, sensitive_values: set[str]) -> str:
    text = str(value or "").replace("\x00", " ").strip()[:300]
    for sensitive in sorted(sensitive_values, key=len, reverse=True):
        if sensitive:
            text = text.replace(sensitive, "[REDACTED]")
    safe, _redaction = redact_payload({"field_text": text})
    return str(safe["field_text"])


def _bridge_sensitive_values(response: Any) -> set[str]:
    values: set[str] = set()
    for mapping in _bounded_bridge_mappings(response):
        for index, (key, value) in enumerate(mapping.items()):
            if index >= _EVENT_MAX_MAPPING_KEYS:
                break
            if _normalized_event_key(key) not in _EVENT_PRIVATE_KEYS:
                continue
            if isinstance(value, str) and value.strip():
                values.add(value.strip())
    return values


def _bridge_field_failure(response: Any) -> dict[str, Any] | None:
    sensitive_values = _bridge_sensitive_values(response)
    selected: dict[str, Any] | None = None
    for mapping in _bounded_bridge_mappings(response):
        event_type = str(
            mapping.get("event_type") or mapping.get("eventType") or mapping.get("action") or ""
        ).lower()
        if event_type == "field.action.failed":
            selected = mapping
    if selected is None:
        return None
    detail = selected.get("payload") if isinstance(selected.get("payload"), dict) else selected
    reason_code = _machine_reason(
        _mapping_value(detail, {"reason_code", "reasonCode", "reason"}),
        "field_action_failed",
    )
    field_id = _safe_bridge_label(
        _mapping_value(selected, {"field_id", "fieldId"}), sensitive_values
    )
    label = _safe_bridge_label(_mapping_value(selected, {"label", "descriptor"}), sensitive_values)
    ui_model = _safe_bridge_label(
        _mapping_value(selected, {"ui_model", "uiModel", "kind"}), sensitive_values
    )
    raw_element = _mapping_value(selected, {"element"})
    raw_element = raw_element if isinstance(raw_element, dict) else {}
    selector = _safe_bridge_label(
        raw_element.get("selector") or raw_element.get("selectorPath") or "", sensitive_values
    )
    selector = _SELECTOR_VALUE_RE.sub(r"\1'[REDACTED]'\2", selector)
    element = {
        "selector": selector,
        "label": label,
        "field_id": field_id,
        "ui_model": ui_model,
        "element_id": _safe_bridge_label(raw_element.get("id"), sensitive_values),
        "name": _safe_bridge_label(raw_element.get("name"), sensitive_values),
        "role": _safe_bridge_label(raw_element.get("role"), sensitive_values),
        "tag": _safe_bridge_label(
            raw_element.get("tag") or raw_element.get("tagName"), sensitive_values
        ),
        "input_type": _safe_bridge_label(raw_element.get("type"), sensitive_values),
        "action": "select" if ui_model in {"combobox", "button_listbox", "select"} else "type",
    }
    element = {key: value for key, value in element.items() if value}
    return {
        "event_type": "field.action.failed",
        "reason_code": reason_code,
        "field_id": field_id,
        "action": element.get("action", ""),
        "committed": False,
        "causal_element": element,
        "expected_state": "Field action completes with a verified commit.",
        "observed_state": f"Field action ended without commit proof ({reason_code}).",
    }


def _bridge_terminal_selection(
    response: Any,
) -> tuple[
    str,
    dict[str, Any] | None,
    dict[str, Any] | None,
    Any,
    dict[str, Any] | None,
]:
    stopped_records: list[tuple[str, dict[str, Any]]] = []
    terminal_records: list[tuple[dict[str, Any], str, dict[str, Any]]] = []
    detail_records: list[tuple[dict[str, Any], str, dict[str, Any]]] = []
    fallback_candidates: list[Any] = []
    for mapping in _bounded_bridge_mappings(response):
        owner_reason = _machine_reason(
            _direct_mapping_value(mapping, {"stopped_reason", "stoppedReason"})
        )
        if owner_reason:
            stopped_records.append((owner_reason, mapping))
        raw_step = _direct_mapping_value(mapping, {"terminal_step", "terminalStep"})
        if isinstance(raw_step, dict):
            terminal_records.append((raw_step, owner_reason, mapping))
        raw_details = _direct_mapping_value(mapping, {"stop_details", "stopDetails"})
        if isinstance(raw_details, dict):
            detail_records.append((raw_details, owner_reason, mapping))
        raw_candidates = _direct_mapping_value(
            mapping,
            {"near_miss_candidates", "nearMissCandidates"},
        )
        if isinstance(raw_candidates, (list, tuple)):
            fallback_candidates.append(raw_candidates)

    def step_reason(raw_step: dict[str, Any]) -> str:
        return _machine_reason(
            _direct_mapping_value(
                raw_step,
                {"reason_code", "reasonCode", "reason", "stopped_reason", "stoppedReason"},
            )
            or _direct_mapping_value(raw_step, {"kind", "step_kind", "stepKind"})
        )

    coherent = [
        record for record in terminal_records if record[1] and step_reason(record[0]) == record[1]
    ]
    selected_step_record = coherent[-1] if coherent else None
    if selected_step_record is not None:
        stopped_reason = selected_step_record[1]
    elif stopped_records:
        stopped_reason = stopped_records[-1][0]
        matching_steps = [
            record
            for record in terminal_records
            if step_reason(record[0]) == stopped_reason or record[1] == stopped_reason
        ]
        selected_step_record = matching_steps[-1] if matching_steps else None
    else:
        stopped_reason = _machine_reason(
            _mapping_value(response, {"stopped_reason", "stoppedReason", "reason"})
        )
    if selected_step_record is None and terminal_records:
        selected_step_record = terminal_records[-1]

    selected_owner = selected_step_record[2] if selected_step_record is not None else None
    selected_details_record = next(
        (record for record in reversed(detail_records) if record[2] is selected_owner),
        None,
    )
    raw_step = selected_step_record[0] if selected_step_record is not None else None
    raw_details = selected_details_record[0] if selected_details_record is not None else None
    raw_candidates = None
    direct_candidates: list[dict[str, Any]] = []
    for source in (raw_step, raw_details, selected_owner):
        if not isinstance(source, dict):
            continue
        for names in (
            {"candidate"},
            {"captcha_candidate", "captchaCandidate"},
        ):
            direct_candidate = _direct_mapping_value(source, names)
            if isinstance(direct_candidate, dict):
                rejection_reason = _direct_mapping_value(
                    direct_candidate,
                    {"rejection_reason", "rejectionReason"},
                )
                # A terminal step can retain the last successfully clicked
                # auth candidate in `candidate`. That is transition history,
                # not a current near miss. Only promote it for a typed CAPTCHA
                # gate or when the producer supplied a current rejection.
                if stopped_reason == "auth_captcha_gate" or rejection_reason:
                    direct_candidates.append(direct_candidate)
        candidate_value = _direct_mapping_value(
            source,
            {"near_miss_candidates", "nearMissCandidates"},
        )
        if isinstance(candidate_value, (list, tuple)):
            raw_candidates = candidate_value
            break
    if direct_candidates:
        combined_candidates = direct_candidates[:_BRIDGE_NEAR_MISS_LIMIT]
        if isinstance(raw_candidates, (list, tuple)):
            remaining = _BRIDGE_NEAR_MISS_LIMIT - len(combined_candidates)
            combined_candidates.extend(raw_candidates[:remaining])
        raw_candidates = combined_candidates
    if (
        raw_candidates is None
        and fallback_candidates
        and not terminal_records
        and not detail_records
    ):
        raw_candidates = fallback_candidates[-1]
    return stopped_reason, raw_step, raw_details, raw_candidates, selected_owner


def _bridge_terminal_owner_step(
    stopped_reason: str,
    raw_step: dict[str, Any] | None,
    selected_owner: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Attach page-walk auth evidence and promote the terminal limit over a stale step."""

    if raw_step is None and selected_owner is None:
        return None
    merged = dict(raw_step or {})
    if not isinstance(selected_owner, dict):
        return merged
    for names, target in (
        ({"auth_transition_count", "authTransitionCount"}, "authTransitionCount"),
        ({"auth_transition_history", "authTransitionHistory"}, "authTransitionHistory"),
        ({"last_auth_action_candidate", "lastAuthActionCandidate"}, "lastAuthActionCandidate"),
    ):
        owner_value = _direct_mapping_value(selected_owner, names)
        if owner_value is not None:
            merged[target] = owner_value
    retained_history = merged.get("authTransitionHistory")
    retained_candidate = merged.get("lastAuthActionCandidate")
    if stopped_reason in _BRIDGE_EVIDENCE_GATED_AUTH_LIMITS and (
        isinstance(retained_history, (list, tuple))
        and retained_history
        or isinstance(retained_candidate, dict)
        and retained_candidate
    ):
        merged["kind"] = stopped_reason
        merged["reason"] = stopped_reason
    return merged


def _bridge_stop_details(raw: Any, sensitive_values: set[str]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    details: dict[str, Any] = {}
    for index, (key, value) in enumerate(raw.items()):
        if index >= _EVENT_MAX_MAPPING_KEYS:
            break
        canonical = _BRIDGE_STOP_DETAIL_FIELDS.get(_normalized_event_key(key))
        if canonical is None:
            continue
        if canonical in {"cycle_period", "cycle_length"}:
            if isinstance(value, int) and not isinstance(value, bool):
                details[canonical] = max(0, min(1_000_000, value))
            continue
        if isinstance(value, bool):
            details[canonical] = value
        elif isinstance(value, int) and not isinstance(value, bool):
            details[canonical] = max(-1_000_000, min(1_000_000, value))
        elif isinstance(value, str):
            safe_value = _safe_bridge_label(value, sensitive_values)
            if safe_value:
                details[canonical] = safe_value
    raw_transition_history = _direct_mapping_value(
        raw,
        {
            "auth_transition_history",
            "authTransitionHistory",
            "transition_history",
            "transitionHistory",
        },
    )
    transition_history = _bridge_transition_history(raw_transition_history, sensitive_values)
    if transition_history:
        details["transition_history"] = transition_history
        if (
            isinstance(raw_transition_history, (list, tuple))
            and len(raw_transition_history) > _BRIDGE_TRANSITION_HISTORY_LIMIT
        ):
            details["transition_count"] = max(
                int(details.get("transition_count") or 0),
                len(raw_transition_history),
            )
    return details


def _bridge_structural_candidate(raw: Any, sensitive_values: set[str]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    candidate: dict[str, Any] = {}
    for source_key, target_key in (
        ("tag", "tag"),
        ("role", "role"),
        ("selector", "selector"),
        ("automationId", "automation_id"),
        ("automation_id", "automation_id"),
        ("fieldId", "field_id"),
        ("field_id", "field_id"),
        ("id", "element_id"),
        ("name", "name"),
        ("type", "input_type"),
        ("label", "label"),
    ):
        if target_key in candidate:
            continue
        value = _safe_bridge_label(raw.get(source_key), sensitive_values)
        if target_key == "selector":
            value = _SELECTOR_VALUE_RE.sub(r"\1'[REDACTED]'\2", value)
        if value:
            candidate[target_key] = value
    if isinstance(raw.get("disabled"), bool):
        candidate["disabled"] = raw["disabled"]
    if isinstance(raw.get("clickable"), bool):
        candidate["clickable"] = raw["clickable"]
    score = raw.get("score")
    if isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(score):
        candidate["score"] = max(-1_000_000, min(1_000_000, score))
    rejection_reason = _machine_reason(
        _safe_bridge_label(
            raw.get("rejectionReason") or raw.get("rejection_reason"),
            sensitive_values,
        )
    )
    if rejection_reason:
        candidate["rejection_reason"] = rejection_reason
    if any(candidate.get(key) for key in ("selector", "automation_id", "label")):
        return candidate
    return None


def _bridge_filled_auth_fields(raw_fields: Any, sensitive_values: set[str]) -> list[dict[str, Any]]:
    if not isinstance(raw_fields, (list, tuple)):
        return []
    allowed_sources = {"profile:accountEmail", "profile:accountPassword"}
    fields: list[dict[str, Any]] = []
    for raw in raw_fields[:_BRIDGE_FILLED_AUTH_FIELD_LIMIT]:
        if not isinstance(raw, dict) or raw.get("source") not in allowed_sources:
            continue
        structural = _bridge_structural_candidate(raw, sensitive_values)
        selector = str((structural or {}).get("selector") or "")
        if not selector:
            continue
        field = {
            "source": raw["source"],
            "selector": selector,
            "ok": bool(raw.get("ok")),
            "changed": bool(raw.get("changed")),
        }
        if field not in fields:
            fields.append(field)
    return fields


def _bridge_transition_history(
    raw_history: Any,
    sensitive_values: set[str],
) -> list[dict[str, Any]]:
    if not isinstance(raw_history, (list, tuple)):
        return []
    history: list[dict[str, Any]] = []
    for raw_transition in raw_history[-_BRIDGE_TRANSITION_HISTORY_LIMIT:]:
        if not isinstance(raw_transition, dict):
            continue
        transition: dict[str, Any] = {}
        for index, (key, value) in enumerate(raw_transition.items()):
            if index >= _EVENT_MAX_MAPPING_KEYS:
                break
            canonical = _BRIDGE_TRANSITION_FIELDS.get(_normalized_event_key(key))
            if canonical is None or not isinstance(value, str):
                continue
            safe_value = _safe_bridge_label(value, sensitive_values)
            if safe_value:
                transition[canonical] = safe_value
        raw_candidate = _direct_mapping_value(
            raw_transition,
            {
                "candidate",
                "last_safe_candidate",
                "lastSafeCandidate",
                "last_auth_action_candidate",
                "lastAuthActionCandidate",
            },
        )
        candidate = _bridge_structural_candidate(raw_candidate, sensitive_values)
        if candidate:
            transition["candidate"] = candidate
        if transition:
            history.append(transition)
    return history


def _bridge_runtime_readiness(raw: Any, sensitive_values: set[str]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    readiness: dict[str, Any] = {}
    if isinstance(raw.get("ok"), bool):
        readiness["ok"] = raw["ok"]
    reason_code = _machine_reason(raw.get("reasonCode") or raw.get("reason"))
    if reason_code:
        readiness["reason_code"] = reason_code
    waited_ms = raw.get("waitedMs", raw.get("waited_ms"))
    if isinstance(waited_ms, int) and not isinstance(waited_ms, bool):
        readiness["waited_ms"] = max(0, min(600_000, waited_ms))
    raw_probe = raw.get("probe")
    if isinstance(raw_probe, dict):
        probe: dict[str, Any] = {}
        for source_key, target_key in (
            ("workdayHost", "workday_host"),
            ("rootPresent", "root_present"),
            ("loadingIndicatorVisible", "loading_indicator_visible"),
            ("finalSubmitVisible", "final_submit_visible"),
        ):
            if isinstance(raw_probe.get(source_key), bool):
                probe[target_key] = raw_probe[source_key]
        for source_key, target_key in (
            ("rootChildCount", "root_child_count"),
            ("visibleControlCount", "visible_control_count"),
            ("applicationFieldCount", "application_field_count"),
            ("validationErrorCount", "validation_error_count"),
        ):
            value = raw_probe.get(source_key)
            if isinstance(value, int) and not isinstance(value, bool):
                probe[target_key] = max(0, min(1_000_000, value))
        ready_state = _safe_bridge_label(raw_probe.get("readyState"), sensitive_values)
        if ready_state:
            probe["ready_state"] = ready_state
        if probe:
            readiness["probe"] = probe
    return readiness


def _bridge_terminal_step(selected: Any, sensitive_values: set[str]) -> dict[str, Any]:
    if selected is None:
        return {}
    step: dict[str, Any] = {}
    kind = _safe_bridge_label(selected.get("kind") or selected.get("stepKind"), sensitive_values)
    reason_code = _machine_reason(
        selected.get("reasonCode") or selected.get("reason") or selected.get("stoppedReason")
    )
    if kind:
        step["kind"] = kind
    if reason_code:
        step["reason_code"] = reason_code
    for source_key, target_key in (
        ("authState", "auth_state"),
        ("authUiState", "auth_ui_state"),
        ("observedAuthState", "observed_auth_state"),
        ("observedAuthUiState", "observed_auth_ui_state"),
        ("effectiveAuthState", "effective_auth_state"),
        ("effectiveAuthUiState", "effective_auth_ui_state"),
        ("fromAuthState", "from_auth_state"),
        ("fromAuthUiState", "from_auth_ui_state"),
        ("toAuthState", "to_auth_state"),
        ("toAuthUiState", "to_auth_ui_state"),
        ("workflowState", "workflow_state"),
    ):
        value = _safe_bridge_label(selected.get(source_key), sensitive_values)
        if value:
            step[target_key] = value
    transition_count = selected.get(
        "authTransitionCount",
        selected.get("transitionCount", selected.get("transition_count")),
    )
    if isinstance(transition_count, int) and not isinstance(transition_count, bool):
        step["transition_count"] = max(0, min(1_000_000, transition_count))
    for camel_key, snake_key in (
        ("cyclePeriod", "cycle_period"),
        ("cycleLength", "cycle_length"),
    ):
        cycle_value = selected.get(camel_key, selected.get(snake_key))
        if isinstance(cycle_value, int) and not isinstance(cycle_value, bool):
            step[snake_key] = max(0, min(1_000_000, cycle_value))
    last_safe_candidate = selected.get(
        "lastAuthActionCandidate",
        selected.get(
            "lastSafeCandidate",
            selected.get(
                "last_auth_action_candidate",
                selected.get("last_safe_candidate"),
            ),
        ),
    )
    structural_candidate = _bridge_structural_candidate(last_safe_candidate, sensitive_values)
    if structural_candidate:
        step["last_safe_candidate"] = structural_candidate
    runtime_readiness = _bridge_runtime_readiness(
        selected.get("runtimeReadiness", selected.get("runtime_readiness")),
        sensitive_values,
    )
    if runtime_readiness:
        step["runtime_readiness"] = runtime_readiness
    filled_auth_fields = _bridge_filled_auth_fields(
        selected.get("filledAuthFields", selected.get("filled_auth_fields")),
        sensitive_values,
    )
    if filled_auth_fields:
        step["filled_auth_fields"] = filled_auth_fields
    raw_transition_history = selected.get(
        "authTransitionHistory",
        selected.get(
            "transitionHistory",
            selected.get(
                "auth_transition_history",
                selected.get("transition_history"),
            ),
        ),
    )
    transition_history = _bridge_transition_history(raw_transition_history, sensitive_values)
    if transition_history:
        step["transition_history"] = transition_history
        if (
            isinstance(raw_transition_history, (list, tuple))
            and len(raw_transition_history) > _BRIDGE_TRANSITION_HISTORY_LIMIT
        ):
            step["transition_count"] = max(
                int(step.get("transition_count") or 0),
                len(raw_transition_history),
            )
    return step


def _bridge_near_miss_candidates(
    raw_candidates: Any, sensitive_values: set[str]
) -> list[dict[str, Any]]:
    if not isinstance(raw_candidates, (list, tuple)):
        return []
    candidates: list[dict[str, Any]] = []
    seen: set[tuple[str, ...]] = set()
    for raw in raw_candidates:
        candidate = _bridge_structural_candidate(raw, sensitive_values)
        if not candidate:
            continue
        automation_id = str(candidate.get("automation_id") or "").strip().lower()
        identity = (
            ("automation_id", automation_id)
            if automation_id
            else (
                "structure",
                str(candidate.get("selector") or "").strip().lower(),
                str(candidate.get("label") or "").strip().lower(),
                str(candidate.get("role") or "").strip().lower(),
                str(candidate.get("tag") or "").strip().lower(),
            )
        )
        if identity in seen:
            continue
        seen.add(identity)
        candidates.append(candidate)
        if len(candidates) >= _BRIDGE_NEAR_MISS_LIMIT:
            break
    return candidates


def _bridge_terminal_failure_evidence(response: Any) -> dict[str, Any] | None:
    sensitive_values = _bridge_sensitive_values(response)
    stopped_reason, raw_step, raw_details, raw_candidates, selected_owner = (
        _bridge_terminal_selection(response)
    )
    raw_step = _bridge_terminal_owner_step(stopped_reason, raw_step, selected_owner)
    stop_details = _bridge_stop_details(raw_details, sensitive_values)
    terminal_step = _bridge_terminal_step(raw_step, sensitive_values)
    near_miss_candidates = _bridge_near_miss_candidates(raw_candidates, sensitive_values)
    validation_messages: list[str] = []
    causal_element: dict[str, Any] | None = None
    if isinstance(raw_details, dict):
        raw_validation = _direct_mapping_value(
            raw_details,
            {
                "validation_messages",
                "validationMessages",
                "visible_validation_errors",
                "visibleValidationErrors",
            },
        )
        if isinstance(raw_validation, (list, tuple)):
            for item in raw_validation[:8]:
                message = _safe_bridge_label(item, sensitive_values)
                if message and message not in validation_messages:
                    validation_messages.append(message)
        raw_validation_details = _direct_mapping_value(
            raw_details,
            {
                "validation_details",
                "validationDetails",
                "visible_validation_details",
                "visibleValidationDetails",
            },
        )
        if isinstance(raw_validation_details, (list, tuple)):
            for detail in raw_validation_details[:8]:
                if not isinstance(detail, dict):
                    continue
                raw_element = _direct_mapping_value(detail, {"element", "control"})
                projected = _bridge_structural_candidate(raw_element, sensitive_values)
                if projected:
                    causal_element = projected
                    break
    if not any(
        (
            stopped_reason,
            stop_details,
            terminal_step,
            near_miss_candidates,
            validation_messages,
            causal_element,
        )
    ):
        return None
    evidence: dict[str, Any] = {}
    if stopped_reason:
        evidence["stopped_reason"] = stopped_reason
    if stop_details:
        evidence["stop_details"] = stop_details
    if terminal_step:
        evidence["terminal_step"] = terminal_step
    if near_miss_candidates:
        evidence["near_miss_candidates"] = near_miss_candidates
    if validation_messages:
        evidence["validation_messages"] = validation_messages
    if causal_element:
        evidence["causal_element"] = causal_element
    return evidence


def _bridge_failure_event_payload(response: Any) -> dict[str, Any]:
    field_evidence = _bridge_field_failure(response)
    terminal_evidence = _bridge_terminal_failure_evidence(response)
    bridge_reason = str((terminal_evidence or {}).get("stopped_reason") or "") or _machine_reason(
        _mapping_value(response, {"stopped_reason", "stoppedReason", "reason"}),
        "extension_command_failed",
    )
    error: dict[str, Any] = {
        "reason_code": "extension_command_failed" if field_evidence else bridge_reason,
        "bridge_reason_code": bridge_reason,
    }
    if field_evidence:
        if terminal_evidence:
            field_evidence.update(terminal_evidence)
        error["failure_evidence"] = field_evidence
    elif terminal_evidence:
        error["failure_evidence"] = terminal_evidence
    return {"error": error, "terminal_reason": "extension_command_failed"}


def _event_seq_from_prefix(raw_line: bytes) -> int | None:
    match = _EVENT_SEQ_PREFIX_RE.search(raw_line)
    if match is None:
        return None
    try:
        return int(match.group(1))
    except (TypeError, ValueError):
        return None


def _path_component(value: str) -> str:
    component = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value or "").strip()).strip("-")
    if not component:
        raise ValueError("operation path ID cannot be empty")
    return component


def _dump_model(model: Any, *, by_alias: bool = True) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump(mode="json", by_alias=by_alias)
    return model.dict(by_alias=by_alias)


class C3OperationStore:
    """Durable per-operation JSONL streams with replace-on-write projections."""

    def __init__(
        self,
        root: str | Path,
        *,
        ledger: JsonlLedger | None = None,
        id_factory: Callable[[], str] | None = None,
        recover: bool = True,
    ) -> None:
        self.root = initialize_ledger_root(root)
        self.ledger = ledger or JsonlLedger()
        self.id_factory = id_factory or (lambda: _alphabetic_uuid("op"))
        self._directories: dict[str, Path] = {}
        self._event_end_offsets: dict[str, dict[int, int]] = {}
        self.recovery_errors: dict[str, str] = {}
        if recover:
            self._recover_existing()

    def create(
        self, request: C3OperationRequest, *, mutates_page: bool | None = None
    ) -> C3Operation:
        operation_id = _path_component(self.id_factory())
        if operation_id in self._directories:
            raise ValueError(f"operation already exists: {operation_id}")
        now = _now()
        deadline = request.deadline_at or now + timedelta(seconds=request.deadline_seconds)
        raw = {
            "operation_id": operation_id,
            "command_id": request.command_id,
            "trace_id": request.trace_id,
            "agent_id": request.agent_id,
            "lane_id": request.lane_id,
            "session_id": request.session_id,
            "lease_id": request.lease_id,
            "browser_target_id": request.browser_target_id,
            "command": request.command,
            "state": "queued",
            "created_at": now,
            "updated_at": now,
            "deadline_at": deadline,
            "allow_submit": request.allow_submit,
            "capabilities": list(request.capabilities),
            "target": dict(request.target),
            "command_payload": _sanitize_operation_event_payload(dict(request.command_payload)),
            "actor": dict(
                request.actor or {"type": "agent", "id": request.agent_id, "surface": "mcp"}
            ),
            "reason": request.reason,
            "mutates_page": bool(mutates_page),
            "parent_operation_id": request.parent_operation_id,
            "retry_count": request.retry_count,
        }
        safe, _redaction = redact_payload(raw)
        safe = restore_trusted_generated_c3_ids(safe, raw)
        operation = C3Operation.model_validate(safe)
        directory = self._new_operation_directory(operation)
        self._directories[operation_id] = directory
        with _lock_for(directory):
            events_path = directory / "events.jsonl"
            requested_payload = _sanitize_operation_event_payload(
                {"operation": _dump_model(operation), "state": "queued"}
            )
            event = self.ledger.append(
                events_path,
                self._event_payload(
                    operation,
                    "operation.requested",
                    requested_payload,
                ),
            )
            self._record_event_offset(
                directory,
                operation_id,
                int(event["seq"]),
                events_path.stat().st_size,
            )
            operation = self._apply_event(operation, event)
            self._write_projection(directory, operation)
        return operation

    def append(
        self,
        operation_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
    ) -> OperationEvent | None:
        directory = self.operation_directory(operation_id)
        with _lock_for(directory):
            operation = self._read_projection(directory)
            if operation.terminal and event_type in _POST_TERMINAL_IGNORED_EVENTS:
                return None
            structural_payload = _sanitize_operation_event_payload(dict(payload or {}))
            safe_payload = _redact_operation_event_payload(structural_payload)
            self._apply_event(
                operation,
                {
                    "event_type": event_type,
                    "payload": safe_payload,
                    "ts": _now().isoformat().replace("+00:00", "Z"),
                },
            )
            events_path = directory / "events.jsonl"
            row = self.ledger.append(
                events_path,
                self._event_payload(operation, event_type, safe_payload),
            )
            self._record_event_offset(
                directory,
                operation_id,
                int(row["seq"]),
                events_path.stat().st_size,
            )
            updated = self._apply_event(operation, row)
            self._write_projection(directory, updated)
            if updated.terminal:
                self._rebuild_failure_context_locked(directory, updated)
            return OperationEvent.model_validate(row)

    def append_if_nonterminal(
        self,
        operation_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        *,
        expected_states: Collection[str] | None = None,
    ) -> OperationEvent | None:
        directory = self.operation_directory(operation_id)
        with _lock_for(directory):
            operation = self._read_projection(directory)
            if operation.terminal:
                return None
            if expected_states is not None and operation.state not in expected_states:
                return None
            return self.append(operation_id, event_type, payload)

    def append_artifact(
        self,
        operation_id: str,
        artifact_id: str,
        *,
        reason: str,
        late_completion: bool = False,
    ) -> OperationEvent | None:
        """Atomically add one artifact link without losing concurrent additions."""

        artifact_id = str(artifact_id or "").strip()
        if not artifact_id or len(artifact_id) > 240:
            raise ValueError("artifact ID must contain 1 to 240 characters")
        directory = self.operation_directory(operation_id)
        with _lock_for(directory):
            operation = self._read_projection(directory)
            if artifact_id in operation.artifact_ids:
                return None
            return self.append(
                operation_id,
                "operation.artifact_captured",
                {
                    "artifact_ids": [*operation.artifact_ids, artifact_id],
                    "reason": reason,
                    "late_completion": bool(late_completion),
                },
            )

    def get(self, operation_id: str) -> C3Operation:
        return self._read_projection(self.operation_directory(operation_id))

    def get_failure_context(self, operation_id: str) -> C3FailureContext:
        directory = self.operation_directory(operation_id)
        with _lock_for(directory):
            path = directory / "diagnosis.json"
            try:
                return C3FailureContext.model_validate_json(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return self._rebuild_failure_context_locked(
                    directory, self._read_projection(directory)
                )

    def rebuild_failure_context(self, operation_id: str) -> C3FailureContext:
        directory = self.operation_directory(operation_id)
        with _lock_for(directory):
            return self._rebuild_failure_context_locked(directory, self._read_projection(directory))

    def events(self, operation_id: str, *, after_seq: int = 0) -> list[OperationEvent]:
        directory = self.operation_directory(operation_id)
        path = directory / "events.jsonl"
        events: list[OperationEvent] = []
        if not path.exists():
            return events
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            event = OperationEvent.model_validate(json.loads(line))
            if event.seq > int(after_seq or 0):
                events.append(event)
        return events

    def event_page(
        self,
        operation_id: str,
        *,
        after_seq: int = 0,
        limit: int = 100,
        max_bytes: int = _EVENT_PAGE_DEFAULT_BYTES,
    ) -> C3OperationEventPage:
        """Stream one bounded event page without materializing the JSONL file."""

        if isinstance(after_seq, bool) or not isinstance(after_seq, int) or after_seq < 0:
            raise ValueError("after_seq must be a non-negative integer")
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= _EVENT_PAGE_MAX_LIMIT
        ):
            raise ValueError(f"event page limit must be between 1 and {_EVENT_PAGE_MAX_LIMIT}")
        if (
            isinstance(max_bytes, bool)
            or not isinstance(max_bytes, int)
            or not 1 <= max_bytes <= _EVENT_PAGE_MAX_BYTES
        ):
            raise ValueError(f"event page byte limit must be between 1 and {_EVENT_PAGE_MAX_BYTES}")
        directory = self.operation_directory(operation_id)
        path = directory / "events.jsonl"
        with _lock_for(directory):
            return self._read_event_page_locked(
                operation_id,
                directory,
                path,
                after_seq=after_seq,
                limit=limit,
                max_bytes=max_bytes,
            )

    def _read_event_page_locked(
        self,
        operation_id: str,
        directory: Path,
        path: Path,
        *,
        after_seq: int,
        limit: int,
        max_bytes: int,
    ) -> C3OperationEventPage:
        if not path.exists():
            return C3OperationEventPage((), after_seq, False, False, 0)

        events: list[OperationEvent] = []
        next_after_seq = after_seq
        bytes_read = 0
        truncated = False
        has_more = False
        start_offset = self._event_offset_after_seq(directory, operation_id, after_seq)
        with path.open("rb") as stream:
            stream.seek(start_offset)
            while True:
                raw_line = stream.readline(_EVENT_PAGE_MAX_BYTES + 1)
                if not raw_line:
                    break
                if len(raw_line) > _EVENT_PAGE_MAX_BYTES and not raw_line.endswith(b"\n"):
                    skipped_seq = _event_seq_from_prefix(raw_line)
                    while raw_line and not raw_line.endswith(b"\n"):
                        raw_line = stream.readline(_EVENT_PAGE_MAX_BYTES + 1)
                        skipped_seq = skipped_seq or _event_seq_from_prefix(raw_line)
                    truncated = True
                    if skipped_seq is not None and skipped_seq > after_seq:
                        next_after_seq = max(next_after_seq, skipped_seq)
                        self._record_event_offset(
                            directory,
                            operation_id,
                            skipped_seq,
                            stream.tell(),
                        )
                    has_more = bool(stream.read(1))
                    continue
                if not raw_line.strip():
                    continue
                try:
                    event = OperationEvent.model_validate(json.loads(raw_line))
                except (TypeError, ValueError):
                    truncated = True
                    continue
                self._record_event_offset(
                    directory,
                    operation_id,
                    event.seq,
                    stream.tell(),
                )
                if event.seq <= after_seq:
                    continue
                if bytes_read + len(raw_line) > max_bytes:
                    truncated = True
                    next_after_seq = event.seq
                    has_more = bool(stream.read(1))
                    break
                events.append(event)
                bytes_read += len(raw_line)
                next_after_seq = event.seq
                if len(events) >= limit:
                    has_more = bool(stream.read(1))
                    break
        return C3OperationEventPage(
            tuple(events),
            next_after_seq,
            has_more,
            truncated,
            bytes_read,
        )

    def _event_offset_after_seq(self, directory: Path, operation_id: str, after_seq: int) -> int:
        offsets = self._event_end_offsets.get(operation_id)
        if offsets is None:
            offsets = self._load_event_offsets(directory, operation_id)
        exact = offsets.get(after_seq)
        if exact is not None:
            return exact
        eligible = [seq for seq in offsets if seq <= after_seq]
        return offsets[max(eligible)] if eligible else 0

    def _record_event_offset(
        self,
        directory: Path,
        operation_id: str,
        seq: int,
        end_offset: int,
    ) -> None:
        if seq < 1 or end_offset < 1:
            return
        with _lock_for(directory):
            offsets = self._event_end_offsets.setdefault(operation_id, {})
            if offsets.get(seq) == end_offset:
                return
            offsets[seq] = end_offset
            while len(offsets) > _EVENT_OFFSET_CACHE_LIMIT:
                offsets.pop(next(iter(offsets)))
            index_path = directory / "event-offsets.jsonl"
            with index_path.open("a", encoding="utf-8", newline="\n") as stream:
                stream.write(json.dumps({"seq": seq, "end_offset": end_offset}) + "\n")

    def _load_event_offsets(self, directory: Path, operation_id: str) -> dict[int, int]:
        index_path = directory / "event-offsets.jsonl"
        offsets: dict[int, int] = {}
        try:
            with index_path.open("r", encoding="utf-8") as stream:
                for line in stream:
                    row = json.loads(line)
                    seq = int(row["seq"])
                    end_offset = int(row["end_offset"])
                    if seq < 1 or end_offset < 1:
                        raise ValueError("invalid event offset")
                    offsets[seq] = end_offset
                    while len(offsets) > _EVENT_OFFSET_CACHE_LIMIT:
                        offsets.pop(next(iter(offsets)))
        except (FileNotFoundError, OSError, TypeError, ValueError, json.JSONDecodeError):
            offsets = self._rebuild_event_offsets(directory)
        self._event_end_offsets[operation_id] = offsets
        return offsets

    def _rebuild_event_offsets(self, directory: Path) -> dict[int, int]:
        events_path = directory / "events.jsonl"
        offsets: dict[int, int] = {}
        index_path = directory / "event-offsets.jsonl"
        temporary = directory / f".{index_path.name}.{uuid.uuid4().hex}.tmp"
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as index_stream:
                if events_path.exists():
                    with events_path.open("rb") as event_stream:
                        while raw_line := event_stream.readline():
                            try:
                                seq = int(json.loads(raw_line)["seq"])
                            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                                continue
                            end_offset = event_stream.tell()
                            offsets[seq] = end_offset
                            while len(offsets) > _EVENT_OFFSET_CACHE_LIMIT:
                                offsets.pop(next(iter(offsets)))
                            index_stream.write(
                                json.dumps({"seq": seq, "end_offset": end_offset}) + "\n"
                            )
            temporary.replace(index_path)
        finally:
            temporary.unlink(missing_ok=True)
        return offsets

    def tail_events(self, operation_id: str, *, limit: int) -> tuple[list[OperationEvent], bool]:
        """Read a bounded suffix of an event stream without materializing the file."""

        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
            raise ValueError("tail event limit must be a positive integer")
        path = self.operation_directory(operation_id) / "events.jsonl"
        if not path.exists():
            return [], False

        buffer = b""
        bytes_read = 0
        with path.open("rb") as stream:
            stream.seek(0, 2)
            position = stream.tell()
            while (
                position > 0
                and buffer.count(b"\n") < limit + 1
                and bytes_read < _TAIL_READ_MAX_BYTES
            ):
                chunk_size = min(
                    _TAIL_READ_CHUNK_BYTES,
                    position,
                    _TAIL_READ_MAX_BYTES - bytes_read,
                )
                position -= chunk_size
                stream.seek(position)
                buffer = stream.read(chunk_size) + buffer
                bytes_read += chunk_size

        raw_lines = buffer.splitlines()
        if position > 0 and raw_lines:
            # The first retained row can begin in the middle of a JSON object.
            raw_lines = raw_lines[1:]
        truncated = position > 0 or len(raw_lines) > limit
        valid: list[OperationEvent] = []
        for raw_line in raw_lines:
            if not raw_line.strip():
                continue
            try:
                valid.append(OperationEvent.model_validate(json.loads(raw_line)))
            except (TypeError, ValueError):
                truncated = True
        return valid[-limit:], truncated or len(valid) > limit

    def list(self, *, session_id: str = "") -> list[C3Operation]:
        operations = [self._read_projection(path) for path in self._directories.values()]
        if session_id:
            operations = [
                operation for operation in operations if operation.session_id == session_id
            ]
        return sorted(
            operations, key=lambda operation: (operation.created_at, operation.operation_id)
        )

    def operation_directory(self, operation_id: str) -> Path:
        operation_id = _path_component(operation_id)
        directory = self._directories.get(operation_id)
        if directory is None:
            matches = list((self.root / "c3" / "sessions").glob(f"*/*/operations/{operation_id}"))
            if not matches:
                raise FileNotFoundError(operation_id)
            directory = sorted(matches)[-1]
            self._directories[operation_id] = directory
        return directory

    def active_mutation(self, session_id: str, *, exclude: str = "") -> C3Operation | None:
        candidates = [
            operation
            for operation in self.list(session_id=session_id)
            if operation.mutates_page
            and operation.state in NONTERMINAL_STATES
            and operation.cancel_acknowledged_at is None
            and operation.operation_id != exclude
        ]
        return candidates[-1] if candidates else None

    def _new_operation_directory(self, operation: C3Operation) -> Path:
        session_id = _path_component(operation.session_id)
        active_path = self.root / "active.json"
        session_directory: Path | None = None
        if active_path.exists():
            active = json.loads(active_path.read_text(encoding="utf-8"))
            entry = (active.get("active_sessions") or {}).get(operation.session_id) or {}
            manifest_path = str(entry.get("manifest_path") or "")
            if manifest_path:
                session_directory = Path(manifest_path).resolve().parent
        if session_directory is None:
            session_directory = (
                self.root / "c3" / "sessions" / _now().date().isoformat() / session_id
            )
        directory = session_directory / "operations" / operation.operation_id
        directory.mkdir(parents=True, exist_ok=False)
        return directory

    def _event_payload(
        self, operation: C3Operation, event_type: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        return {
            "component": "c3",
            "event_type": event_type,
            "actor": {"type": "agent", "id": operation.agent_id, "surface": "backend"},
            "operation_id": operation.operation_id,
            "command_id": operation.command_id,
            "trace_id": operation.trace_id,
            "agent_id": operation.agent_id,
            "lane_id": operation.lane_id,
            "session_id": operation.session_id,
            "lease_id": operation.lease_id,
            "browser_target_id": operation.browser_target_id,
            "payload": payload,
        }

    def _read_projection(self, directory: Path) -> C3Operation:
        path = directory / "operation.json"
        with _lock_for(directory):
            if not path.exists():
                raise FileNotFoundError(path)
            return C3Operation.model_validate_json(path.read_text(encoding="utf-8"))

    def _write_projection(self, directory: Path, operation: C3Operation) -> None:
        path = directory / "operation.json"
        temporary = directory / f".{path.name}.{uuid.uuid4().hex}.tmp"
        payload = json.dumps(
            _dump_model(operation),
            indent=2,
            sort_keys=True,
            ensure_ascii=False,
        )
        temporary.write_text(payload + "\n", encoding="utf-8")
        temporary.replace(path)

    def _write_failure_context(self, directory: Path, context: C3FailureContext) -> None:
        path = directory / "diagnosis.json"
        temporary = directory / f".{path.name}.{uuid.uuid4().hex}.tmp"
        try:
            payload = json.dumps(
                _dump_model(context, by_alias=False),
                indent=2,
                sort_keys=True,
                ensure_ascii=False,
            )
            temporary.write_text(payload + "\n", encoding="utf-8")
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    def _rebuild_failure_context_locked(
        self, directory: Path, operation: C3Operation
    ) -> C3FailureContext:
        if not operation.terminal:
            raise ValueError("failure context requires a terminal operation")
        rows, events_truncated = self.tail_events(
            operation.operation_id,
            limit=_DIAGNOSIS_EVENT_LIMIT,
        )
        terminal_types = {
            "operation.completed",
            "operation.failed",
            "operation.cancelled",
            "operation.orphaned",
        }
        if not any(row.event_type in terminal_types for row in rows):
            projected_terminal = self._projected_terminal_event(operation)
            if projected_terminal is not None:
                rows = [projected_terminal, *rows]
                events_truncated = True
            existing = self._valid_existing_failure_context(directory, operation)
            if projected_terminal is None and existing is not None:
                context = C3FailureContext.model_validate(
                    {
                        **existing.model_dump(mode="python"),
                        "artifact_ids": list(operation.artifact_ids),
                        "artifact_status": (
                            "completed" if operation.artifact_ids else existing.artifact_status
                        ),
                        "evidence_truncated": True,
                    }
                )
                self._persist_failure_context_locked(directory, operation, context)
                return context
        try:
            context = C3FailureContext.model_validate(
                build_failure_context(
                    operation,
                    rows,
                    artifact_ids=operation.artifact_ids,
                    evidence_truncated=events_truncated,
                )
            )
            self._persist_failure_context_locked(directory, operation, context)
            return context
        except Exception as exc:
            self._record_diagnosis_failure(directory, operation, exc)
            context = self._unknown_failure_context(operation, rows)
            try:
                self._persist_failure_context_locked(directory, operation, context)
            except Exception:
                pass
            return context

    @staticmethod
    def _projected_terminal_event(operation: C3Operation) -> OperationEvent | None:
        if (
            not operation.terminal
            or not operation.terminal_event_id
            or operation.terminal_event_type
            not in {
                "operation.completed",
                "operation.failed",
                "operation.cancelled",
                "operation.orphaned",
            }
            or operation.terminal_event_seq < 1
        ):
            return None
        payload: dict[str, Any] = {"terminal_reason": operation.terminal_reason}
        if operation.result is not None:
            payload["result"] = operation.result
        if operation.error is not None:
            payload["error"] = operation.error
        return OperationEvent.model_validate(
            {
                "seq": operation.terminal_event_seq,
                "event_id": operation.terminal_event_id,
                "event_type": operation.terminal_event_type,
                "operation_id": operation.operation_id,
                "command_id": operation.command_id,
                "trace_id": operation.trace_id,
                "agent_id": operation.agent_id,
                "lane_id": operation.lane_id,
                "session_id": operation.session_id,
                "lease_id": operation.lease_id,
                "browser_target_id": operation.browser_target_id,
                "ts": operation.finished_at or operation.updated_at,
                "component": "c3",
                "actor": {"type": "agent", "id": operation.agent_id, "surface": "backend"},
                "payload": payload,
            }
        )

    @staticmethod
    def _valid_existing_failure_context(
        directory: Path, operation: C3Operation
    ) -> C3FailureContext | None:
        try:
            context = C3FailureContext.model_validate_json(
                (directory / "diagnosis.json").read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            return None
        if context.operation_id != operation.operation_id:
            return None
        if operation.diagnosis_id and context.diagnosis_id != operation.diagnosis_id:
            return None
        if context.authoritative_event_type not in {
            "operation.completed",
            "operation.failed",
            "operation.cancelled",
            "operation.orphaned",
        }:
            return None
        return context

    def _persist_failure_context_locked(
        self,
        directory: Path,
        operation: C3Operation,
        context: C3FailureContext,
    ) -> None:
        self._write_failure_context(directory, context)
        if operation.diagnosis_id != context.diagnosis_id:
            projected = C3Operation.model_validate(
                {
                    **operation.model_dump(mode="python"),
                    "diagnosis_id": context.diagnosis_id,
                }
            )
            self._write_projection(directory, projected)

    def _record_diagnosis_failure(
        self,
        directory: Path,
        operation: C3Operation,
        exc: Exception,
    ) -> None:
        safe_payload, _redaction = redact_payload(
            {
                "error": {
                    "reason_code": "diagnosis_builder_exception",
                    "error_type": type(exc).__name__,
                }
            }
        )
        try:
            self.ledger.append(
                directory / "events.jsonl",
                self._event_payload(operation, "diagnosis.failed", safe_payload),
            )
        except Exception:
            pass

    @staticmethod
    def _unknown_failure_context(
        operation: C3Operation, events: list[OperationEvent]
    ) -> C3FailureContext:
        terminal = next(
            (
                event
                for event in events
                if event.event_type
                in {
                    "operation.completed",
                    "operation.failed",
                    "operation.cancelled",
                    "operation.orphaned",
                }
            ),
            None,
        )
        event_id = terminal.event_id if terminal else ""
        event_seq = terminal.seq if terminal else 0
        generated_at = (
            terminal.ts if terminal else operation.finished_at or operation.updated_at
        ).isoformat()
        suffix = _path_component(event_id or str(event_seq or "none"))
        return C3FailureContext.model_validate(
            {
                "diagnosis_id": f"diagnosis-{operation.operation_id}-{suffix}",
                "operation_id": operation.operation_id,
                "failure_scope": "unknown",
                "root_cause_code": "unknown_failure",
                "summary": "Failure context generation failed; primary operation truth remains authoritative.",
                "expected_state": "Operation failure context is generated from retained evidence.",
                "observed_state": "Diagnosis builder failed before establishing a cause.",
                "artifact_ids": list(operation.artifact_ids),
                "artifact_status": "completed" if operation.artifact_ids else "idle",
                "confidence": "unknown",
                "root_cause_unknown": True,
                "missing_evidence": ["diagnosis_generation"],
                "authoritative_event_id": event_id,
                "authoritative_event_type": terminal.event_type if terminal else "",
                "source_event_sequence": event_seq,
                "live_inspection_required": True,
                "next_safe_action": "inspect_diagnosis_failure_and_retained_events",
                "generated_at": generated_at,
            }
        )

    def _apply_event(self, operation: C3Operation, event: dict[str, Any]) -> C3Operation:
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        event_type = str(event.get("event_type") or "")
        if event_type in _PROJECTION_NEUTRAL_EVENTS:
            return operation
        if operation.terminal and event_type in _POST_TERMINAL_IGNORED_EVENTS:
            return operation
        timestamp = datetime.fromisoformat(str(event["ts"]).replace("Z", "+00:00"))
        updates: dict[str, Any] = {"updated_at": timestamp}
        next_state = _STATE_BY_EVENT.get(event_type, operation.state)
        validate_transition(operation.state, next_state)
        updates["state"] = next_state
        if event_type == "operation.started" and operation.started_at is None:
            updates["started_at"] = timestamp
        if event_type == "operation.heartbeat":
            updates["heartbeat_seq"] = max(
                operation.heartbeat_seq + 1, int(payload.get("heartbeat_seq") or 0)
            )
            updates["last_heartbeat_at"] = timestamp
        if event_type == "operation.progress":
            updates["progress_seq"] = max(
                operation.progress_seq + 1, int(payload.get("progress_seq") or 0)
            )
            updates["last_progress_at"] = timestamp
        if event_type == "operation.cancel_requested":
            updates["cancel_requested_at"] = timestamp
            updates["cancellation_reason"] = str(payload.get("reason") or "")
        if event_type in {"operation.cancel_requested", "operation.cancel_redispatched"}:
            updates["cancel_attempt_id"] = str(payload.get("cancel_attempt_id") or "")
            updates["cancel_attempt_count"] = int(payload.get("cancel_attempt_count") or 0)
            updates["cancel_pending_at"] = None
            updates["cancel_failed_at"] = None
            updates["cancel_retry_after"] = None
            if payload.get("reason"):
                updates["cancellation_reason"] = str(payload["reason"])
        if event_type == "operation.cancel_attempted":
            updates["cancel_attempted_at"] = timestamp
        if event_type == "operation.cancel_pending":
            updates["cancel_pending_at"] = timestamp
        if event_type == "operation.cancel_failed":
            updates["cancel_failed_at"] = timestamp
            retry_after = payload.get("retry_after")
            if retry_after:
                updates["cancel_retry_after"] = datetime.fromisoformat(
                    str(retry_after).replace("Z", "+00:00")
                )
        if event_type == "operation.cancel_acknowledged":
            updates["cancel_acknowledged_at"] = timestamp
        if next_state not in NONTERMINAL_STATES and operation.finished_at is None:
            updates["finished_at"] = timestamp
        entering_terminal = not operation.terminal and next_state not in NONTERMINAL_STATES
        observability_failure_events = {
            "operation.health_probe_failed",
            "operation.monitor_failed",
            "operation.artifact_capture_failed",
            "operation.cancel_failed",
        }
        if event_type in observability_failure_events and "error" in payload:
            updates["monitor_error"] = payload["error"]
        for key in (
            "phase",
            "substep",
            "field",
            "driver",
        ):
            if key in payload and not operation.terminal:
                updates[key] = payload[key]
        terminal_lifecycle_events = {
            "operation.cancelled",
            "operation.completed",
            "operation.failed",
            "operation.orphaned",
        }
        if entering_terminal and event_type in terminal_lifecycle_events:
            updates["terminal_event_id"] = str(event.get("event_id") or "")
            updates["terminal_event_type"] = event_type
            updates["terminal_event_seq"] = max(0, int(event.get("seq") or 0))
            for key in ("terminal_reason", "result", "error"):
                if key in payload:
                    updates[key] = payload[key]
        if event_type == "operation.artifact_captured" and "artifact_ids" in payload:
            if not isinstance(payload["artifact_ids"], list):
                raise ValueError("operation.artifact_captured artifact_ids must be a list")
            updates["artifact_ids"] = list(
                dict.fromkeys([*operation.artifact_ids, *payload["artifact_ids"]])
            )
        return C3Operation.model_validate(
            {
                **operation.model_dump(mode="python"),
                **updates,
            }
        )

    def _recover_existing(self) -> None:
        sessions_root = self.root / "c3" / "sessions"
        if not sessions_root.exists():
            return
        recovered: list[tuple[str, bool]] = []
        for event_path in sorted(sessions_root.glob("*/*/operations/*/events.jsonl")):
            directory = event_path.parent
            try:
                operation = self._recover_terminal_snapshot(directory)
                if operation is None:
                    operation = self._rebuild_projection(directory)
            except Exception as exc:
                self.recovery_errors[directory.name] = type(exc).__name__
                continue
            self._directories[operation.operation_id] = directory
            if operation.state in NONTERMINAL_STATES:
                recovered.append(
                    (operation.operation_id, operation.cancel_acknowledged_at is not None)
                )
        for operation_id, cancellation_acknowledged in recovered:
            operation = self.get(operation_id)
            if cancellation_acknowledged:
                self.append(
                    operation_id,
                    "operation.cancelled",
                    {
                        "cancel_attempt_id": operation.cancel_attempt_id,
                        "cancel_attempt_count": operation.cancel_attempt_count,
                        "terminal_reason": operation.cancellation_reason or "agent_cancel",
                    },
                )
            else:
                self.append(
                    operation_id,
                    "operation.orphaned",
                    {
                        "terminal_reason": "backend_restart",
                        "error": {"reason_code": "backend_restart_nonterminal"},
                    },
                )

    def _recover_terminal_snapshot(self, directory: Path) -> C3Operation | None:
        events_path = directory / "events.jsonl"
        if not events_path.exists() or events_path.stat().st_size == 0:
            return None
        try:
            operation = self._read_projection(directory)
        except (OSError, ValueError):
            return None
        if operation.operation_id != directory.name or not operation.terminal:
            return None
        context = self._valid_existing_failure_context(directory, operation)
        if context is not None and operation.diagnosis_id:
            return operation
        if self._projected_terminal_event(operation) is None:
            return None
        self._rebuild_failure_context_locked(directory, operation)
        return self._read_projection(directory)

    def _rebuild_projection(self, directory: Path) -> C3Operation:
        operation: C3Operation | None = None
        with (directory / "events.jsonl").open("r", encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue
                row = json.loads(line)
                if operation is None:
                    first_payload = row.get("payload") or {}
                    operation_payload = first_payload.get("operation")
                    if not isinstance(operation_payload, dict):
                        raise ValueError(f"operation.requested snapshot missing: {directory}")
                    operation = C3Operation.model_validate(operation_payload)
                    continue
                operation = self._apply_event(operation, row)
        if operation is None:
            raise ValueError(f"empty operation event stream: {directory}")
        self._write_projection(directory, operation)
        if operation.terminal:
            self._rebuild_failure_context_locked(directory, operation)
        return operation


class C3OperationConflictError(RuntimeError):
    def __init__(self, reason_code: str, operation_id: str = "") -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code
        self.operation_id = operation_id


class C3MonitorBridgeError(RuntimeError):
    def __init__(self, reason_code: str, detail: str = "") -> None:
        self.reason_code = reason_code
        self.detail = str(detail or "")[:180]
        super().__init__(f"{reason_code}:{self.detail}" if self.detail else reason_code)


class C3MonitorBridgeBusyError(C3MonitorBridgeError):
    def __init__(self) -> None:
        super().__init__("monitor_bridge_busy")


class C3MonitorBridgeTimeoutError(C3MonitorBridgeError):
    def __init__(self) -> None:
        super().__init__("monitor_bridge_timeout")


class C3MonitorBridgeExecutionError(C3MonitorBridgeError):
    def __init__(self, error_type: str, detail: str = "") -> None:
        self.error_type = error_type
        super().__init__("monitor_bridge_execution_failed", f"{error_type}:{detail}")


class C3MonitorArtifactAdmissionTimeoutError(C3MonitorBridgeError):
    def __init__(self) -> None:
        super().__init__("monitor_artifact_admission_timeout")


class C3MonitorArtifactTimeoutError(C3MonitorBridgeError):
    def __init__(self) -> None:
        super().__init__("monitor_artifact_capture_timeout")


class C3OperationRetryError(RuntimeError):
    def __init__(self, reason_code: str) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code


class C3OperationManager:
    """Own bounded background workers while JSONL remains operation authority."""

    def __init__(
        self,
        store: C3OperationStore,
        *,
        lease_store: Any,
        target_store: Any,
        bridge: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]],
        max_workers: int = 4,
        control_workers: int = 2,
        cancel_timeout_seconds: float = 10.0,
        cancel_retry_backoff_seconds: float = 1.0,
        monitor: Any | None = None,
    ) -> None:
        self.store = store
        self.lease_store = lease_store
        self.target_store = target_store
        self.bridge = bridge
        self.executor = ThreadPoolExecutor(
            max_workers=max(2, int(max_workers)),
            thread_name_prefix="c3-operation",
        )
        self.control_workers = max(1, int(control_workers))
        self._control_executor = ThreadPoolExecutor(
            max_workers=self.control_workers,
            thread_name_prefix="c3-control",
        )
        bridge_workers = max(2, int(max_workers))
        self._bridge_executor = ThreadPoolExecutor(
            max_workers=bridge_workers,
            thread_name_prefix="c3-bridge",
        )
        self._bridge_slots = threading.BoundedSemaphore(bridge_workers)
        self._cancel_bridge_executor = ThreadPoolExecutor(
            max_workers=self.control_workers,
            thread_name_prefix="c3-cancel-bridge",
        )
        self._monitor_bridge_executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="c3-monitor-bridge",
        )
        self._monitor_bridge_slot = threading.BoundedSemaphore(1)
        self._monitor_admission_lock = threading.Lock()
        self._monitor_artifact_waiters = 0
        self._cancel_bridge_slots = threading.BoundedSemaphore(self.control_workers)
        self.cancel_timeout_seconds = max(0.01, float(cancel_timeout_seconds))
        self.cancel_retry_backoff_seconds = max(0.0, float(cancel_retry_backoff_seconds))
        self.monitor = monitor
        self._lock = threading.RLock()
        self._queue_deadline_timers: dict[str, threading.Timer] = {}
        self._closed = False

    def start(self, request: C3OperationRequest, *, mutates_page: bool) -> C3Operation:
        with self._lock:
            self._ensure_open()
            if mutates_page:
                active = self.store.active_mutation(request.session_id)
                if active is not None:
                    raise C3OperationConflictError(
                        "session_mutation_in_progress", active.operation_id
                    )
            operation = self.store.create(request, mutates_page=mutates_page)
            delay = max(0.0, (operation.deadline_at - _now()).total_seconds())
            timer = threading.Timer(delay, self._expire_queued, args=(operation.operation_id,))
            timer.daemon = True
            self._queue_deadline_timers[operation.operation_id] = timer
            timer.start()
            self.executor.submit(self._execute, operation.operation_id)
            if self.monitor is not None:
                self.monitor.track(operation.operation_id)
            return operation

    def get(self, operation_id: str) -> C3Operation:
        return self.store.get(operation_id)

    def events(self, operation_id: str, *, after_seq: int = 0) -> list[OperationEvent]:
        return self.store.events(operation_id, after_seq=after_seq)

    def event_page(
        self,
        operation_id: str,
        *,
        after_seq: int = 0,
        limit: int = 100,
        max_bytes: int = _EVENT_PAGE_DEFAULT_BYTES,
    ) -> C3OperationEventPage:
        return self.store.event_page(
            operation_id,
            after_seq=after_seq,
            limit=limit,
            max_bytes=max_bytes,
        )

    def run_monitor_task(
        self,
        callback: Callable[..., Any],
        *args: Any,
        timeout_seconds: float,
    ) -> Any:
        return self._run_monitor_task(
            callback,
            args,
            timeout_seconds=timeout_seconds,
            artifact_priority=False,
            admission_timeout_seconds=0,
        )

    def run_monitor_artifact_task(
        self,
        callback: Callable[..., Any],
        *args: Any,
        admission_timeout_seconds: float,
        timeout_seconds: float,
    ) -> Any:
        return self._run_monitor_task(
            callback,
            args,
            timeout_seconds=timeout_seconds,
            artifact_priority=True,
            admission_timeout_seconds=admission_timeout_seconds,
        )

    def _run_monitor_task(
        self,
        callback: Callable[..., Any],
        args: tuple[Any, ...],
        *,
        timeout_seconds: float,
        artifact_priority: bool,
        admission_timeout_seconds: float,
    ) -> Any:
        timeout_seconds = max(0.01, float(timeout_seconds))
        if artifact_priority:
            with self._monitor_admission_lock:
                self._monitor_artifact_waiters += 1
            try:
                acquired = self._monitor_bridge_slot.acquire(
                    timeout=max(0.01, float(admission_timeout_seconds))
                )
            finally:
                with self._monitor_admission_lock:
                    self._monitor_artifact_waiters -= 1
            if not acquired:
                raise C3MonitorArtifactAdmissionTimeoutError()
        else:
            with self._monitor_admission_lock:
                if self._monitor_artifact_waiters:
                    raise C3MonitorBridgeBusyError()
                acquired = self._monitor_bridge_slot.acquire(blocking=False)
            if not acquired:
                raise C3MonitorBridgeBusyError()
        try:
            future = self._monitor_bridge_executor.submit(callback, *args)
        except Exception:
            self._monitor_bridge_slot.release()
            raise
        future.add_done_callback(lambda _completed: self._monitor_bridge_slot.release())
        try:
            return future.result(timeout=timeout_seconds)
        except FutureTimeoutError as exc:
            if artifact_priority:
                raise C3MonitorArtifactTimeoutError() from exc
            raise C3MonitorBridgeTimeoutError() from exc
        except Exception as exc:
            raise C3MonitorBridgeExecutionError(type(exc).__name__, str(exc)) from exc

    def run_monitor_bridge(
        self,
        target: dict[str, Any],
        payload: dict[str, Any],
        *,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        response = self.run_monitor_task(
            self.bridge,
            target,
            payload,
            timeout_seconds=timeout_seconds,
        )
        return response if isinstance(response, dict) else {}

    def cancel(
        self,
        operation_id: str,
        *,
        reason: str,
        redispatch: bool = False,
    ) -> C3Operation:
        with self._lock:
            self._ensure_open()
            operation = self.store.get(operation_id)
            if operation.terminal:
                raise C3OperationConflictError("operation_already_terminal", operation_id)
            if operation.state != "cancelling":
                self._dispatch_cancel_attempt(
                    operation,
                    event_type="operation.cancel_requested",
                    reason=reason or "agent_cancel",
                )
            elif redispatch:
                if operation.cancel_failed_at is None:
                    raise C3OperationConflictError("cancel_attempt_in_progress", operation_id)
                if (
                    operation.cancel_retry_after is not None
                    and _now() < operation.cancel_retry_after
                ):
                    raise C3OperationConflictError("cancel_backoff_active", operation_id)
                self._dispatch_cancel_attempt(
                    operation,
                    event_type="operation.cancel_redispatched",
                    reason=reason or operation.cancellation_reason or "agent_cancel",
                )
            return self.store.get(operation_id)

    def _dispatch_cancel_attempt(
        self,
        operation: C3Operation,
        *,
        event_type: str,
        reason: str,
    ) -> None:
        attempt_id = _alphabetic_uuid("cancel")
        attempt_count = operation.cancel_attempt_count + 1
        self.store.append(
            operation.operation_id,
            event_type,
            {
                "reason": reason,
                "cancel_attempt_id": attempt_id,
                "cancel_attempt_count": attempt_count,
            },
        )
        self._control_executor_for(operation.session_id).submit(
            self._execute_cancel,
            operation.operation_id,
            attempt_id,
            attempt_count,
        )

    def retry(
        self,
        operation_id: str,
        *,
        command_id: str = "",
        trace_id: str = "",
        lease_id: str = "",
        reason: str = "",
        deadline_at: datetime | None = None,
        deadline_seconds: int | None = None,
    ) -> C3Operation:
        with self._lock:
            parent = self.store.get(operation_id)
            if not parent.terminal and parent.cancel_acknowledged_at is None:
                raise C3OperationRetryError("parent_operation_not_terminal")
            request = C3OperationRequest(
                command=parent.command,
                command_id=command_id or _alphabetic_uuid("cmd"),
                trace_id=trace_id or _alphabetic_uuid("trace"),
                agent_id=parent.agent_id,
                lane_id=parent.lane_id,
                session_id=parent.session_id,
                lease_id=lease_id or parent.lease_id,
                browser_target_id=parent.browser_target_id,
                target=parent.target,
                command_payload=parent.command_payload,
                actor=parent.actor,
                reason=reason or f"Retry operation {parent.operation_id}",
                deadline_at=deadline_at,
                deadline_seconds=deadline_seconds or 600,
                allow_submit=parent.allow_submit,
                capabilities=parent.capabilities,
                parent_operation_id=parent.operation_id,
                retry_count=parent.retry_count + 1,
            )
            return self.start(request, mutates_page=parent.mutates_page)

    def shutdown(self, *, wait: bool = True) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            queue_timers = list(self._queue_deadline_timers.values())
            self._queue_deadline_timers.clear()
        for timer in queue_timers:
            timer.cancel()
        if self.monitor is not None:
            self.monitor.shutdown(wait=wait)
        self._control_executor.shutdown(wait=wait, cancel_futures=not wait)
        self.executor.shutdown(wait=wait, cancel_futures=not wait)
        self._bridge_executor.shutdown(wait=wait, cancel_futures=not wait)
        self._cancel_bridge_executor.shutdown(wait=wait, cancel_futures=not wait)
        self._monitor_bridge_executor.shutdown(wait=wait, cancel_futures=not wait)

    def _control_executor_for(self, session_id: str) -> ThreadPoolExecutor:
        _path_component(session_id)
        return self._control_executor

    def _execute(self, operation_id: str) -> None:
        operation = self.store.get(operation_id)
        if operation.state != "queued":
            self._cancel_queue_timer(operation_id)
            return
        if _now() >= operation.deadline_at:
            self._expire_queued(operation_id)
            return
        try:
            started = self.store.append_if_nonterminal(
                operation_id,
                "operation.started",
                {"phase": "bridge", "substep": "dispatch_extension_command"},
                expected_states={"queued"},
            )
            self._cancel_queue_timer(operation_id)
            if started is None:
                return
            self.store.append(
                operation_id,
                "operation.heartbeat",
                {"heartbeat_seq": 1, "phase": "bridge"},
            )
            self.store.append(
                operation_id,
                "operation.progress",
                {
                    "progress_seq": 1,
                    "phase": "bridge",
                    "substep": "extension_command_dispatched",
                },
            )
            operation = self.store.get(operation_id)
            remaining_seconds = max(0.0, (operation.deadline_at - _now()).total_seconds())
            if remaining_seconds <= 0:
                self._fail_bridge_deadline(operation_id)
                return
            bridge_payload = self._bridge_payload(operation)
            bridge_payload["bridge_timeout_ms"] = max(
                1, _bounded_bridge_timeout_ms(int(remaining_seconds * 1_000))
            )
            bridge_future = self._submit_bridge_bounded(
                self._bridge_executor,
                self._bridge_slots,
                operation.target,
                bridge_payload,
            )
            if bridge_future is None:
                self._fail_if_running(operation_id, "operation_bridge_capacity_exhausted")
                return
            try:
                response = bridge_future.result(timeout=remaining_seconds)
            except FutureTimeoutError:
                self._fail_bridge_deadline(operation_id)
                bridge_future.add_done_callback(
                    lambda completed, op_id=operation_id: self._record_late_bridge_result(
                        op_id, completed
                    )
                )
                return
            current = self.store.get(operation_id)
            if (
                current.state == "cancelling"
                and _bridge_stopped_reason(response) == "user_cancelled"
            ):
                with self._lock:
                    current = self.store.get(operation_id)
                    acknowledged = self.store.append_if_nonterminal(
                        operation_id,
                        "operation.cancel_acknowledged",
                        {
                            "cancel_attempt_id": current.cancel_attempt_id,
                            "cancel_attempt_count": current.cancel_attempt_count,
                            "result": response,
                            "reason": "driver_unwound",
                        },
                        expected_states={"cancelling"},
                    )
                    if acknowledged is not None:
                        current = self.store.get(operation_id)
                        self.store.append_if_nonterminal(
                            operation_id,
                            "operation.cancelled",
                            {
                                "cancel_attempt_id": current.cancel_attempt_id,
                                "cancel_attempt_count": current.cancel_attempt_count,
                                "result": response,
                                "terminal_reason": current.cancellation_reason or "agent_cancel",
                            },
                            expected_states={"cancelling"},
                        )
                return
            if current.state == "cancelling" or current.terminal:
                self.store.append(
                    operation_id,
                    "operation.result_ignored_after_cancel",
                    {"result": response, "reason": "operation_no_longer_running"},
                )
                return
            if c3_bridge_response_ok(response):
                self.store.append(
                    operation_id,
                    "operation.completed",
                    {"result": response, "terminal_reason": "browser_execution_completed"},
                )
            else:
                self.store.append(
                    operation_id,
                    "operation.failed",
                    _bridge_failure_event_payload(response),
                )
        except C3BrowserBridgeError as exc:
            self._fail_if_running(operation_id, str(exc))
        except Exception as exc:
            self._fail_if_running(
                operation_id,
                "unexpected_error",
                detail={"type": type(exc).__name__, "message": str(exc)[:240]},
            )

    def _cancel_queue_timer(self, operation_id: str) -> None:
        with self._lock:
            timer = self._queue_deadline_timers.pop(operation_id, None)
        if timer is not None:
            timer.cancel()

    def _expire_queued(self, operation_id: str) -> None:
        self._cancel_queue_timer(operation_id)
        self.store.append_if_nonterminal(
            operation_id,
            "operation.failed",
            {
                "terminal_reason": "operation_queue_deadline_exceeded",
                "error": {"reason_code": "operation_queue_deadline_exceeded"},
            },
            expected_states={"queued"},
        )

    def _fail_bridge_deadline(self, operation_id: str) -> None:
        self.store.append_if_nonterminal(
            operation_id,
            "operation.failed",
            {
                "terminal_reason": "operation_bridge_deadline_exceeded",
                "error": {"reason_code": "operation_bridge_deadline_exceeded"},
            },
            expected_states={"running", "slow", "suspected_stall", "stalled"},
        )

    def _record_late_bridge_result(
        self, operation_id: str, completed: Future[dict[str, Any]]
    ) -> None:
        try:
            response = completed.result()
            payload = {
                "reason": "operation_deadline_already_terminal",
                "late_response_ok": c3_bridge_response_ok(response),
            }
        except Exception as exc:
            payload = {
                "reason": "operation_deadline_already_terminal",
                "late_error_type": type(exc).__name__,
            }
        try:
            self.store.append(
                operation_id,
                "operation.result_ignored_after_deadline",
                payload,
            )
        except (FileNotFoundError, RuntimeError, ValueError):
            return

    def _execute_cancel(
        self,
        operation_id: str,
        attempt_id: str,
        attempt_count: int,
    ) -> None:
        operation = self.store.get(operation_id)
        if operation.state != "cancelling" or operation.cancel_attempt_id != attempt_id:
            return
        self.store.append(
            operation_id,
            "operation.cancel_attempted",
            {
                "cancel_attempt_id": attempt_id,
                "cancel_attempt_count": attempt_count,
            },
        )
        payload = self._bridge_payload(operation, command_name="c3.cancel_session")
        payload["command_payload"].update(
            {
                "operationId": operation.operation_id,
                "cancelAttemptId": attempt_id,
                "reason": operation.cancellation_reason or "agent_cancel",
            }
        )
        payload["bridge_timeout_ms"] = max(
            1,
            _bounded_bridge_timeout_ms(int(self.cancel_timeout_seconds * 1_000)),
        )
        try:
            bridge_future = self._submit_bridge_bounded(
                self._cancel_bridge_executor,
                self._cancel_bridge_slots,
                operation.target,
                payload,
            )
            if bridge_future is None:
                with self._lock:
                    self._record_cancel_failure_locked(
                        operation_id,
                        attempt_id,
                        attempt_count,
                        reason="cancel_bridge_capacity_exhausted",
                        error={"reason_code": "cancel_bridge_capacity_exhausted"},
                    )
                return
            try:
                response = bridge_future.result(timeout=self.cancel_timeout_seconds)
            except FutureTimeoutError:
                self._cancel_timed_out(operation_id, attempt_id, attempt_count)
                bridge_future.add_done_callback(
                    lambda completed, op_id=operation_id, att_id=attempt_id, count=attempt_count: (
                        self._record_late_cancel_result(
                            op_id,
                            att_id,
                            count,
                            completed,
                        )
                    )
                )
                return
            with self._lock:
                current = self.store.get(operation_id)
                if (
                    current.state != "cancelling"
                    or current.cancel_attempt_id != attempt_id
                    or current.cancel_failed_at is not None
                ):
                    self.store.append(
                        operation_id,
                        "operation.cancel_result_ignored",
                        {
                            "cancel_attempt_id": attempt_id,
                            "cancel_attempt_count": attempt_count,
                            "reason": "cancel_attempt_no_longer_current",
                        },
                    )
                    return
                if not c3_bridge_response_ok(response) or response.get("cancelled") is not True:
                    self._record_cancel_failure_locked(
                        operation_id,
                        attempt_id,
                        attempt_count,
                        reason="cancel_not_accepted",
                        error=response,
                    )
                    return
                if response.get("acknowledged") is not True:
                    self.store.append(
                        operation_id,
                        "operation.cancel_pending",
                        {
                            "cancel_attempt_id": attempt_id,
                            "cancel_attempt_count": attempt_count,
                            "result": response,
                            "reason": "cancel_requested_not_yet_acknowledged",
                        },
                    )
                    return
                self.store.append(
                    operation_id,
                    "operation.cancel_acknowledged",
                    {
                        "cancel_attempt_id": attempt_id,
                        "cancel_attempt_count": attempt_count,
                        "result": response,
                        "reason": "cancel_acknowledged",
                    },
                )
                self.store.append(
                    operation_id,
                    "operation.cancelled",
                    {
                        "cancel_attempt_id": attempt_id,
                        "cancel_attempt_count": attempt_count,
                        "result": response,
                        "terminal_reason": current.cancellation_reason or "agent_cancel",
                    },
                )
                return
        except Exception as exc:
            self._record_cancel_failure(
                operation_id,
                attempt_id,
                attempt_count,
                reason="cancel_bridge_failed",
                error={"type": type(exc).__name__, "message": str(exc)[:240]},
            )

    def _record_late_cancel_result(
        self,
        operation_id: str,
        attempt_id: str,
        attempt_count: int,
        completed: Future[dict[str, Any]],
    ) -> None:
        try:
            response = completed.result()
            payload = {
                "cancel_attempt_id": attempt_id,
                "cancel_attempt_count": attempt_count,
                "reason": "cancel_attempt_already_timed_out",
                "late_response_ok": c3_bridge_response_ok(response),
                "late_cancelled": response.get("cancelled") is True,
                "late_acknowledged": response.get("acknowledged") is True,
            }
        except Exception as exc:
            payload = {
                "cancel_attempt_id": attempt_id,
                "cancel_attempt_count": attempt_count,
                "reason": "cancel_attempt_already_timed_out",
                "late_error_type": type(exc).__name__,
            }
        try:
            self.store.append(operation_id, "operation.cancel_result_ignored", payload)
        except (FileNotFoundError, RuntimeError, ValueError):
            return

    def _submit_bridge_bounded(
        self,
        executor: ThreadPoolExecutor,
        slots: threading.BoundedSemaphore,
        target: dict[str, Any],
        payload: dict[str, Any],
    ) -> Future[dict[str, Any]] | None:
        if not slots.acquire(blocking=False):
            return None
        try:
            future = executor.submit(self.bridge, target, payload)
        except Exception:
            slots.release()
            raise
        future.add_done_callback(lambda _completed: slots.release())
        return future

    def _cancel_timed_out(
        self,
        operation_id: str,
        attempt_id: str,
        attempt_count: int,
    ) -> None:
        self._record_cancel_failure(
            operation_id,
            attempt_id,
            attempt_count,
            reason="cancel_bridge_timeout",
            error={"reason_code": "cancel_bridge_timeout"},
        )

    def _record_cancel_failure(
        self,
        operation_id: str,
        attempt_id: str,
        attempt_count: int,
        *,
        reason: str,
        error: Any,
    ) -> None:
        with self._lock:
            self._record_cancel_failure_locked(
                operation_id,
                attempt_id,
                attempt_count,
                reason=reason,
                error=error,
            )

    def _record_cancel_failure_locked(
        self,
        operation_id: str,
        attempt_id: str,
        attempt_count: int,
        *,
        reason: str,
        error: Any,
    ) -> None:
        current = self.store.get(operation_id)
        if (
            current.state != "cancelling"
            or current.cancel_attempt_id != attempt_id
            or current.cancel_pending_at is not None
            or current.cancel_failed_at is not None
        ):
            return
        retry_after = _now() + timedelta(seconds=self.cancel_retry_backoff_seconds)
        self.store.append(
            operation_id,
            "operation.cancel_failed",
            {
                "cancel_attempt_id": attempt_id,
                "cancel_attempt_count": attempt_count,
                "reason": reason,
                "error": error,
                "retry_after": retry_after.isoformat().replace("+00:00", "Z"),
            },
        )

    def _fail_if_running(
        self, operation_id: str, reason: str, *, detail: dict[str, Any] | None = None
    ) -> None:
        current = self.store.get(operation_id)
        if current.state == "cancelling" or current.terminal:
            self.store.append(
                operation_id,
                "operation.error_ignored_after_cancel",
                {"reason": reason, "error": detail or {}},
            )
            return
        self.store.append(
            operation_id,
            "operation.failed",
            {"terminal_reason": reason, "error": detail or {"reason_code": reason}},
        )

    def _bridge_payload(
        self, operation: C3Operation, *, command_name: str | None = None
    ) -> dict[str, Any]:
        command_payload = sanitize_c3_command_payload(operation.command_payload)
        if operation.target.get("tab_id") is not None and command_payload.get("tabId") is None:
            command_payload["tabId"] = operation.target.get("tab_id")
        command_payload["operationId"] = operation.operation_id
        command_payload["allowSubmit"] = False
        command_payload["triggeredBy"] = "c3_operation_manager"
        return {
            "operation_id": operation.operation_id,
            "command_name": command_name or operation.command,
            "command_id": operation.command_id,
            "trace_id": operation.trace_id,
            "agent_id": operation.agent_id,
            "lane_id": operation.lane_id,
            "session_id": operation.session_id,
            "lease_id": operation.lease_id,
            "tab_id": operation.target.get("tab_id"),
            "url": operation.target.get("url") or "",
            "actor": operation.actor
            or {"type": "agent", "id": operation.agent_id, "surface": "mcp"},
            "command_payload": command_payload,
        }

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("operation manager is shut down")
