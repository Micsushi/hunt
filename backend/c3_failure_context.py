"""Deterministic, redaction-safe failure context built from immutable C3 events."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from itertools import islice
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator, model_validator

from backend.c3_identifiers import is_trusted_generated_c3_id
from backend.ledger.redaction import REDACTED, redact_payload

FailureScope = Literal[
    "ui_element",
    "navigation",
    "external_server",
    "control_plane",
    "setup",
    "browser",
    "extension",
    "unknown",
]
Confidence = Literal["proven", "strong", "weak", "unknown"]
ArtifactStatus = Literal["idle", "capturing", "partial", "completed", "failed"]

_TERMINAL_EVENT_TYPES = {
    "operation.completed",
    "operation.failed",
    "operation.cancelled",
    "operation.orphaned",
}
_CONTROL_EVENT_TYPES = {
    "operation.cancel_failed",
    "operation.cancel_pending",
    "operation.stalled",
}
_MONITOR_EVENT_TYPES = {
    "operation.health_probe_failed",
    "operation.progress_probe_failed",
    "operation.monitor_failed",
    "operation.artifact_capture_failed",
}
_NON_CAUSAL_ELEMENT_SCOPES = {"navigation", "external_server", "control_plane"}
_EVIDENCE_GATED_AUTH_CYCLE_CODES = {
    "auth_flow_limit_reached",
    "auth_same_page_attempt_limit_reached",
}
_AUTH_CYCLE_CODES = {"auth_ui_cycle_detected", *_EVIDENCE_GATED_AUTH_CYCLE_CODES}
_GENERIC_CODES = {
    "",
    "error",
    "failed",
    "failure",
    "operation_failed",
    "extension_command_failed",
}
_CODE_KEYS = {
    "root_cause_code": 90,
    "reason_code": 85,
    "reasoncode": 85,
    "stopped_reason": 85,
    "stoppedreason": 85,
    "terminal_reason": 70,
    "terminalreason": 70,
    "manual_review_reasons": 65,
    "manualreviewreasons": 65,
    "error_code": 50,
    "errorcode": 50,
}
_SENSITIVE_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(password|passwd|pwd|token|secret|api[_-]?key|cookie|authorization|"
    r"address|answer|typed(?:_value)?|entered(?:_value)?)\b"
    r"\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\r\n]+)"
)
_VALUE_SELECTOR_RE = re.compile(r"(?i)(\[\s*value\s*=\s*)(?:\"[^\"]*\"|'[^']*'|[^\]\s]+)(\s*\])")
_SENSITIVE_VALUE_KEY_RE = re.compile(
    r"(?i)(?:^|_)(?:password|passwd|pwd|typed_value|entered_value|answer|answer_value|"
    r"address|address_value|field_value|value)$"
)
_SAFE_ACTIONS = {
    "click",
    "type",
    "select",
    "upload",
    "press",
    "scroll",
    "navigate",
    "focus",
}
_DYNAMIC_SELECTOR_RE = re.compile(
    r"(?i)(?::nth-(?:child|of-type)|\.css-[a-z0-9_-]{5,}|"
    r"\.(?:sc|jsx)-[a-z0-9_-]{5,})"
)
_REQUIRED_FIELD_VALIDATION_RE = re.compile(
    r"\bthe field\s+(?P<label>.+?)\s+is required and must have a value\b",
    re.I,
)
_EMPTY_FIELD_EVIDENCE_RE = re.compile(
    r"\b(?:0|no)\s+items?\s+selected\b|\bselect one\b|\b(?:value\s+is\s+)?(?:empty|blank)\b",
    re.I,
)
_MAX_WALK_DEPTH = 16
_MAX_WALK_NODES = 2_048
_MAX_EVIDENCE_EVENT_IDS = 128
_MAX_CHECKPOINT_IDS = 64
_MAX_ARTIFACT_IDS = 64
_MAX_VALIDATION_MESSAGES = 32
_MAX_CREDENTIAL_PREPARATION = 4
_MAX_OBSERVED_MESSAGES = 64
_MAX_DIAGNOSTIC_MESSAGES = 64
_MAX_PAGE_OBSERVATIONS = 32
_MAX_FIELD_COMMIT_FAILURES = 32
_MAX_REASON_LIST_ITEMS = 32
_MAX_GENERIC_LIST_ITEMS = 512
_MAX_DIAGNOSIS_EVENTS = 128


class _TraversalReport:
    def __init__(self) -> None:
        self.truncated = False

    def mark_truncated(self) -> None:
        self.truncated = True


class _OrderedCollector:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.values: list[str] = []
        self._seen: set[str] = set()
        self.truncated = False

    def add(self, value: str) -> None:
        if not value or value in self._seen:
            return
        self._seen.add(value)
        if len(self.values) >= self.limit:
            self.truncated = True
            return
        self.values.append(value)

    def extend(self, values: Iterable[str]) -> None:
        for value in values:
            self.add(value)


class C3BoundingBox(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    x: float
    y: float
    width: float = Field(ge=0)
    height: float = Field(ge=0)


class C3ElementEvidence(BaseModel):
    """Safe identity for an element; never includes its entered value."""

    model_config = ConfigDict(extra="forbid", strict=True)

    selector: str = ""
    role: str = ""
    label: str = ""
    tag: str = ""
    element_id: str = ""
    name: str = ""
    automation_id: str = ""
    field_id: str = ""
    ui_model: str = ""
    input_type: str = ""
    autocomplete: str = ""
    page: str = ""
    frame_id: int | None = None
    document_id: str = ""
    action: str = ""
    checkpoint_id: str = ""
    bounding_box: C3BoundingBox | None = None

    @field_validator("selector", mode="before")
    @classmethod
    def _redact_selector_value(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        safe = _safe_text(value, limit=300)
        return _VALUE_SELECTOR_RE.sub(rf"\1'{REDACTED}'\2", safe)

    @field_validator(
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
        "checkpoint_id",
        mode="before",
    )
    @classmethod
    def _redact_identity_text(cls, value: Any) -> Any:
        return _safe_text(value, limit=300) if isinstance(value, str) else value

    @field_validator("action", mode="before")
    @classmethod
    def _retain_action_verb_only(cls, value: Any) -> Any:
        return _safe_action(value) if isinstance(value, str) else value


class C3CredentialPreparationEvidence(BaseModel):
    """Value-free proof that a known profile credential prepared a control."""

    model_config = ConfigDict(extra="forbid", strict=True)

    source: Literal["profile:accountEmail", "profile:accountPassword"]
    selector: str = Field(min_length=1)
    ok: bool
    changed: bool

    @field_validator("selector", mode="before")
    @classmethod
    def _redact_selector_value(cls, value: Any) -> Any:
        safe = _safe_text(value, limit=300)
        return _VALUE_SELECTOR_RE.sub(rf"\1'{REDACTED}'\2", safe)


class C3MonitorSummary(BaseModel):
    """Typed monitor failures kept separate from primary operation cause."""

    model_config = ConfigDict(extra="forbid", strict=True)

    health_probe_failure_count: int = Field(default=0, ge=0)
    progress_probe_failure_count: int = Field(default=0, ge=0)
    monitor_failure_count: int = Field(default=0, ge=0)
    artifact_capture_failure_count: int = Field(default=0, ge=0)
    cancel_failure_count: int = Field(default=0, ge=0)
    last_error_code: str = ""

    @field_validator("last_error_code", mode="before")
    @classmethod
    def _sanitize_monitor_code(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        return _normalize_code(value)


class C3PageObservation(BaseModel):
    """Value-free page state retained from a browser observation."""

    model_config = ConfigDict(extra="forbid", strict=True)

    event_id: str = ""
    href: str = ""
    title: str = ""
    page_kind: str = ""
    phase: str = ""
    auth_state: str = ""
    auth_ui_state: str = ""
    current_step: str = ""
    document_ready_state: str = ""
    frame_id: int | None = None

    @field_validator(
        "event_id",
        "href",
        "title",
        "page_kind",
        "phase",
        "auth_state",
        "auth_ui_state",
        "current_step",
        "document_ready_state",
        mode="before",
    )
    @classmethod
    def _sanitize_text(cls, value: Any) -> Any:
        return _safe_text(value, limit=500) if isinstance(value, str) else value


class C3FieldCommitFailure(BaseModel):
    """Value-free proof that a field action did not commit."""

    model_config = ConfigDict(extra="forbid", strict=True)

    event_id: str = ""
    field_id: str = ""
    label: str = ""
    ui_model: str = ""
    action: str = ""
    reason_code: str = ""
    committed: bool = False
    required: bool | None = None
    option_count: int | None = Field(default=None, ge=0)
    selected_value_present: bool | None = None
    attempted_option: str = ""
    action_method: str = ""
    action_result: str = ""
    commit_verified: bool | None = None
    selected_pill_present: bool | None = None
    backing_value_present: bool | None = None
    validation_visible: bool | None = None

    @field_validator(
        "event_id",
        "field_id",
        "label",
        "ui_model",
        "reason_code",
        "attempted_option",
        "action_method",
        "action_result",
        mode="before",
    )
    @classmethod
    def _sanitize_text(cls, value: Any) -> Any:
        return _safe_text(value, limit=300) if isinstance(value, str) else value

    @field_validator("action", mode="before")
    @classmethod
    def _sanitize_action(cls, value: Any) -> Any:
        return _safe_action(value) if isinstance(value, str) else value


class C3FailureContext(BaseModel):
    """Compact evidence packet. Append-only events remain its source of truth."""

    model_config = ConfigDict(extra="forbid", strict=True)

    diagnosis_id: str = ""
    operation_id: str = Field(min_length=1)
    failure_scope: FailureScope = "unknown"
    root_cause_code: str = "unknown_failure"
    reported_cause_code: str = ""
    cause_asserted: bool = False
    summary: str = "Failure cause could not be established from retained evidence."
    causal_element: C3ElementEvidence | None = None
    last_touched_element: C3ElementEvidence | None = None
    exposing_action: C3ElementEvidence | None = None
    expected_state: str = ""
    observed_state: str = ""
    observed_messages: list[str] = Field(default_factory=list)
    diagnostic_messages: list[str] = Field(default_factory=list)
    page_observations: list[C3PageObservation] = Field(default_factory=list)
    field_commit_failures: list[C3FieldCommitFailure] = Field(default_factory=list)
    timeout_evidence: dict[str, Any] = Field(default_factory=dict)
    auth_action_boundary: dict[str, Any] = Field(default_factory=dict)
    evidence_conflicts: list[str] = Field(default_factory=list)
    validation_messages: list[str] = Field(default_factory=list)
    credential_preparation: list[C3CredentialPreparationEvidence] = Field(
        default_factory=list, max_length=_MAX_CREDENTIAL_PREPARATION
    )
    evidence_event_ids: list[str] = Field(default_factory=list)
    checkpoint_ids: list[str] = Field(default_factory=list)
    artifact_ids: list[str] = Field(default_factory=list)
    ruled_out: list[str] = Field(default_factory=list)
    confidence: Confidence = "unknown"
    root_cause_unknown: bool = True
    mechanism_unknown: bool = False
    missing_evidence: list[str] = Field(default_factory=list)
    monitor_summary: C3MonitorSummary = Field(default_factory=C3MonitorSummary)
    artifact_status: ArtifactStatus = "idle"
    evidence_truncated: bool = False
    authoritative_event_id: str = ""
    authoritative_event_type: str = ""
    source_event_sequence: int = 0
    live_inspection_required: bool = True
    next_safe_action: str = "inspect_retained_evidence_then_use_live_inspection"
    generated_at: str = ""

    @model_validator(mode="before")
    @classmethod
    def _mark_direct_collection_truncation(cls, value: Any) -> Any:
        if not isinstance(value, Mapping):
            return value
        data = dict(value)
        caps = {
            "validation_messages": _MAX_VALIDATION_MESSAGES,
            "observed_messages": _MAX_OBSERVED_MESSAGES,
            "diagnostic_messages": _MAX_DIAGNOSTIC_MESSAGES,
            "page_observations": _MAX_PAGE_OBSERVATIONS,
            "field_commit_failures": _MAX_FIELD_COMMIT_FAILURES,
            "evidence_conflicts": _MAX_REASON_LIST_ITEMS,
            "credential_preparation": _MAX_CREDENTIAL_PREPARATION,
            "evidence_event_ids": _MAX_EVIDENCE_EVENT_IDS,
            "checkpoint_ids": _MAX_CHECKPOINT_IDS,
            "artifact_ids": _MAX_ARTIFACT_IDS,
            "ruled_out": _MAX_REASON_LIST_ITEMS,
            "missing_evidence": _MAX_REASON_LIST_ITEMS,
        }
        if any(
            isinstance(data.get(field), list) and len(data[field]) > limit
            for field, limit in caps.items()
        ):
            data["evidence_truncated"] = True
        return data

    @field_validator(
        "diagnosis_id",
        "operation_id",
        "authoritative_event_id",
        "authoritative_event_type",
        "generated_at",
        mode="before",
    )
    @classmethod
    def _sanitize_identifier_fields(cls, value: Any) -> Any:
        return _safe_identifier(value) if isinstance(value, str) else value

    @field_validator("root_cause_code", "reported_cause_code", mode="before")
    @classmethod
    def _sanitize_root_cause_code(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        return _normalize_code(value) or "unknown_failure"

    @field_validator("next_safe_action", mode="before")
    @classmethod
    def _sanitize_next_action(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        return _normalize_code(value) or "inspect_retained_failure_context"

    @field_validator("summary", "expected_state", "observed_state", mode="before")
    @classmethod
    def _redact_free_text(cls, value: Any) -> Any:
        return _safe_text(value, limit=500) if isinstance(value, str) else value

    @field_validator("validation_messages", mode="before")
    @classmethod
    def _redact_validation_text(cls, value: Any) -> Any:
        if not isinstance(value, list):
            return value
        collector = _OrderedCollector(_MAX_VALIDATION_MESSAGES)
        for item in value:
            if not isinstance(item, str):
                return value
            collector.add(_safe_text(item, limit=300))
        return collector.values

    @field_validator("observed_messages", "diagnostic_messages", mode="before")
    @classmethod
    def _redact_observed_messages(cls, value: Any) -> Any:
        if not isinstance(value, list):
            return value
        collector = _OrderedCollector(_MAX_OBSERVED_MESSAGES)
        for item in value:
            if not isinstance(item, str):
                return value
            collector.add(_safe_text(item, limit=500))
        return collector.values

    @field_validator("evidence_event_ids", "checkpoint_ids", "artifact_ids", mode="before")
    @classmethod
    def _sanitize_identifier_lists(cls, value: Any, info: ValidationInfo) -> Any:
        if not isinstance(value, list):
            return value
        limits = {
            "evidence_event_ids": _MAX_EVIDENCE_EVENT_IDS,
            "checkpoint_ids": _MAX_CHECKPOINT_IDS,
            "artifact_ids": _MAX_ARTIFACT_IDS,
        }
        collector = _OrderedCollector(limits[info.field_name])
        for item in value:
            if not isinstance(item, str):
                return value
            collector.add(_safe_identifier(item))
        return collector.values

    @field_validator("ruled_out", "missing_evidence", "evidence_conflicts", mode="before")
    @classmethod
    def _sanitize_reason_lists(cls, value: Any) -> Any:
        if not isinstance(value, list):
            return value
        collector = _OrderedCollector(_MAX_REASON_LIST_ITEMS)
        for item in value:
            if not isinstance(item, str):
                return value
            collector.add(_normalize_code(item) or "redacted")
        return collector.values

    @model_validator(mode="after")
    def _enforce_causal_and_confidence_invariants(self):
        evidence_code = self.root_cause_code if self.cause_asserted else self.reported_cause_code
        if (
            self.failure_scope in _NON_CAUSAL_ELEMENT_SCOPES
            and self.causal_element
            and evidence_code not in {"auth_signup_signin_loop", *_AUTH_CYCLE_CODES}
        ):
            raise ValueError(f"{self.failure_scope} failures cannot name a causal UI element")
        if self.confidence in {"weak", "unknown"} and not self.root_cause_unknown:
            raise ValueError("weak or unknown confidence requires root_cause_unknown=true")
        if self.root_cause_unknown and self.missing_evidence and not self.live_inspection_required:
            raise ValueError("unknown root cause with missing evidence requires live inspection")
        return self


def _credential_preparation_from_event(
    authoritative: Mapping[str, Any] | None,
) -> tuple[list[dict[str, Any]], bool]:
    if not authoritative:
        return [], False
    allowed_sources = {"profile:accountEmail", "profile:accountPassword"}
    prepared: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    truncated = False
    for raw_group in _find_values(
        _payload(authoritative), {"filled_auth_fields", "filledauthfields"}
    ):
        if not isinstance(raw_group, (list, tuple)):
            continue
        for raw in raw_group:
            if not isinstance(raw, Mapping):
                continue
            source = str(raw.get("source") or "")
            selector = _safe_text(raw.get("selector"), limit=300)
            selector = _VALUE_SELECTOR_RE.sub(rf"\1'{REDACTED}'\2", selector)
            identity = (source, selector)
            if source not in allowed_sources or not selector or identity in seen:
                continue
            seen.add(identity)
            if len(prepared) >= _MAX_CREDENTIAL_PREPARATION:
                truncated = True
                continue
            prepared.append(
                {
                    "source": source,
                    "selector": selector,
                    "ok": bool(raw.get("ok")),
                    "changed": bool(raw.get("changed")),
                }
            )
    return prepared, truncated


def _observed_messages_from_events(events: list[dict[str, Any]]) -> tuple[list[str], bool]:
    collector = _OrderedCollector(_MAX_OBSERVED_MESSAGES)
    visible_message_keys = {
        "alert",
        "alerts",
        "visible_messages",
        "visible_validation_errors",
        "validation_messages",
        "body_text_excerpt",
    }
    for event in events:
        if _event_type(event).lower() in {
            "operation.result_ignored_after_cancel",
            "operation.result_ignored_after_deadline",
        }:
            continue
        for key, current in _bounded_walk(_payload(event)):
            if key in {
                "direct_evidence",
                "directevidence",
                "direct_observation",
                "directobservation",
            } and isinstance(current, Mapping):
                for direct_key in (
                    "messages",
                    "visible_messages",
                    "alerts",
                    "body_text_excerpt",
                ):
                    collector.extend(_message_text_values(current.get(direct_key)))
            if key not in visible_message_keys:
                continue
            collector.extend(_message_text_values(current))
    return collector.values, collector.truncated


def _message_text_values(value: Any) -> list[str]:
    values = value if isinstance(value, (list, tuple)) else [value]
    result: list[str] = []
    for candidate in values:
        if isinstance(candidate, Mapping):
            candidate = (
                candidate.get("message")
                or candidate.get("text")
                or candidate.get("body_text_excerpt")
            )
        if isinstance(candidate, str):
            result.append(_safe_text(candidate, limit=500))
    return result


def _diagnostic_messages_from_events(
    events: list[dict[str, Any]],
    *,
    excluded_visible_messages: Iterable[str] = (),
) -> tuple[list[str], bool]:
    collector = _OrderedCollector(_MAX_DIAGNOSTIC_MESSAGES)
    excluded = set(excluded_visible_messages)
    diagnostic_keys = {
        "reason",
        "reason_code",
        "reasoncode",
        "error_code",
        "errorcode",
        "message",
        "messages",
    }
    for event in events:
        event_type = _event_type(event).lower()
        payload = _payload(event)
        phase = _normalize_code(_first_value(payload, {"phase", "substep", "stage"}))
        if not (
            event_type in {*_MONITOR_EVENT_TYPES, *_CONTROL_EVENT_TYPES}
            or event_type in _TERMINAL_EVENT_TYPES
            or any(
                token in event_type
                for token in ("heartbeat", "probe", "monitor", "bridge", "transport")
            )
            or any(
                token in phase for token in ("heartbeat", "probe", "monitor", "bridge", "transport")
            )
        ):
            continue
        for key, current in _bounded_walk(payload):
            if key not in diagnostic_keys:
                continue
            collector.extend(
                message for message in _message_text_values(current) if message not in excluded
            )
    return collector.values, collector.truncated


def _page_observations_from_events(
    events: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], bool]:
    observations: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    truncated = False
    for event in events:
        event_id = _event_id(event)
        if _event_type(event).lower() in {
            "operation.result_ignored_after_cancel",
            "operation.result_ignored_after_deadline",
        }:
            continue
        for _, current in _bounded_walk(_payload(event)):
            if not isinstance(current, Mapping):
                continue
            normalized = {_snake_key(key): value for key, value in current.items()}
            href = normalized.get("href") or normalized.get("url") or ""
            page_kind = normalized.get("page_kind") or ""
            phase = normalized.get("phase") or ""
            auth_state = normalized.get("auth_state") or ""
            auth_ui_state = normalized.get("auth_ui_state") or ""
            document_ready_state = normalized.get("document_ready_state") or ""
            current_step_value = normalized.get("current_step")
            if isinstance(current_step_value, Mapping):
                current_step = (
                    current_step_value.get("title") or current_step_value.get("label") or ""
                )
            else:
                current_step = current_step_value or normalized.get("current_step_title") or ""
            title = normalized.get("title") or normalized.get("page_title") or ""
            # Action/result metadata often carries authState or phase without
            # being a browser page observation. Require page identity so an
            # ignored late action cannot overwrite terminal browser truth.
            if not href and not (title and document_ready_state):
                continue
            if not any(
                (
                    href,
                    page_kind,
                    phase,
                    auth_state,
                    auth_ui_state,
                    current_step,
                    document_ready_state,
                )
            ):
                continue
            frame_id = normalized.get("frame_id")
            try:
                frame_id = int(frame_id) if frame_id is not None else None
            except (TypeError, ValueError):
                frame_id = None
            observation = {
                "event_id": event_id,
                "href": _safe_text(href, limit=500),
                "title": _safe_text(title, limit=300),
                "page_kind": _normalize_code(page_kind),
                "phase": _normalize_code(phase),
                "auth_state": _normalize_code(auth_state),
                "auth_ui_state": _normalize_code(auth_ui_state),
                "current_step": _safe_text(current_step, limit=300),
                "document_ready_state": _normalize_code(document_ready_state),
                "frame_id": frame_id,
            }
            identity = tuple(observation.values())
            if identity in seen:
                continue
            seen.add(identity)
            if len(observations) >= _MAX_PAGE_OBSERVATIONS:
                truncated = True
                continue
            observations.append(observation)
    return observations, truncated


_DRIVER_COMMIT_FAILURE_REASONS = {
    "commit_not_verified",
    "no_matching_option",
    "option_not_committed",
    "workday_commit_not_verified",
    "workday_popup_options_missing",
    "workday_source_options_unavailable",
    "workday_validation_not_cleared",
}


def _normalized_mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {_snake_key(key): current for key, current in value.items()}


def _driver_failure_outcomes(payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    outcomes: list[Mapping[str, Any]] = []
    seen: set[int] = set()
    for key, current in _bounded_walk(payload):
        if key != "driver_evidence" or not isinstance(current, Mapping):
            continue
        driver = _normalized_mapping(current)
        causal = driver.get("causal_field")
        candidates: list[Any] = [causal] if isinstance(causal, Mapping) else []
        recent = driver.get("recent_field_outcomes")
        if isinstance(recent, (list, tuple)):
            candidates.extend(recent[-12:])
        for candidate in candidates:
            if not isinstance(candidate, Mapping) or id(candidate) in seen:
                continue
            seen.add(id(candidate))
            outcomes.append(candidate)
    return outcomes


def _driver_field_commit_failure(
    event: Mapping[str, Any],
    outcome: Mapping[str, Any],
) -> dict[str, Any] | None:
    normalized = _normalized_mapping(outcome)
    field = _normalized_mapping(normalized.get("field"))
    action = _normalized_mapping(normalized.get("action"))
    verification = _normalized_mapping(normalized.get("commit_verification"))
    committed_state = _normalized_mapping(normalized.get("last_committed_state"))
    intended_option = _normalized_mapping(normalized.get("intended_option"))

    action_result = _normalize_code(action.get("result"))
    action_reason = _normalize_code(action.get("reason"))
    verification_reason = _normalize_code(verification.get("reason"))
    committed_reason = _normalize_code(committed_state.get("reason"))
    explicitly_succeeded = (
        action_result == "committed"
        or verification.get("verified") is True
        or committed_state.get("committed") is True
    )
    explicitly_failed = (
        action_result == "failed"
        or action_reason in _DRIVER_COMMIT_FAILURE_REASONS
        or verification_reason in _DRIVER_COMMIT_FAILURE_REASONS
        or committed_reason in _DRIVER_COMMIT_FAILURE_REASONS
    )
    if explicitly_succeeded or not explicitly_failed:
        return None

    field_id = _safe_identifier(field.get("id") or field.get("field_id") or "")
    label = _safe_text(field.get("label") or "", limit=300)
    ui_model = _safe_identifier(field.get("type") or field.get("ui_model") or "")
    if not field_id and not label:
        return None
    reason_code = (
        action_reason
        if action_result == "failed" and action_reason
        else verification_reason or committed_reason or action_reason or "field_action_failed"
    )
    selected_present: bool | None = None
    if verification.get("verified") is False or committed_state.get("committed") is False:
        selected_present = False
    elif verification.get("verified") is True or committed_state.get("committed") is True:
        selected_present = True
    elif isinstance(committed_state.get("empty"), bool):
        selected_present = not committed_state["empty"]
    elif isinstance(verification.get("backing_value_present"), bool):
        selected_present = verification["backing_value_present"]
    return {
        "event_id": _event_id(event),
        "field_id": field_id,
        "label": label,
        "ui_model": ui_model,
        "action": ("select" if ui_model in {"combobox", "button_listbox", "select"} else "type"),
        "reason_code": reason_code,
        "committed": False,
        "required": None,
        "option_count": None,
        "selected_value_present": selected_present,
        "attempted_option": _safe_text(intended_option.get("label") or "", limit=160),
        "action_method": _normalize_code(action.get("method")),
        "action_result": action_result,
        "commit_verified": (
            verification.get("verified") if isinstance(verification.get("verified"), bool) else None
        ),
        "selected_pill_present": (
            verification.get("selected_pill_present")
            if isinstance(verification.get("selected_pill_present"), bool)
            else None
        ),
        "backing_value_present": (
            verification.get("backing_value_present")
            if isinstance(verification.get("backing_value_present"), bool)
            else None
        ),
        "validation_visible": (
            verification.get("validation_visible")
            if isinstance(verification.get("validation_visible"), bool)
            else committed_state.get("validation_visible")
            if isinstance(committed_state.get("validation_visible"), bool)
            else None
        ),
    }


def _field_commit_failures_from_events(
    events: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], bool]:
    failures: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    truncated = False
    for event in events:
        event_type = _event_type(event).lower()
        payload = _payload(event)
        driver_failures = [
            failure
            for outcome in _driver_failure_outcomes(payload)
            if (failure := _driver_field_commit_failure(event, outcome)) is not None
        ]
        if driver_failures:
            for failure in driver_failures:
                identity = (
                    failure["field_id"],
                    failure["reason_code"],
                    failure["label"],
                )
                if identity in seen:
                    continue
                seen.add(identity)
                if len(failures) >= _MAX_FIELD_COMMIT_FAILURES:
                    truncated = True
                    continue
                failures.append(failure)
            continue
        is_field_failure_event = (
            "field.action.failed" in event_type
            or "field.commit.failed" in event_type
            or "commit_failed" in event_type
        )
        if not is_field_failure_event:
            continue
        reason_code = _normalize_code(
            _first_value(payload, {"reason_code", "reasoncode", "reason"})
        )
        element = _first_mapping(payload, {"causal_element", "causalelement", "element"}) or {}
        field_id = _safe_identifier(
            _first_value(payload, {"field_id", "fieldid"})
            or element.get("field_id")
            or element.get("fieldId")
            or ""
        )
        label = _safe_text(
            _first_value(payload, {"label", "descriptor"}) or element.get("label") or "",
            limit=300,
        )
        if not field_id and not label:
            continue
        ui_model = _safe_identifier(
            _first_value(payload, {"ui_model", "uimodel", "kind"})
            or element.get("ui_model")
            or element.get("uiModel")
            or ""
        )
        identity = (field_id, reason_code, label)
        if identity in seen:
            continue
        seen.add(identity)
        if len(failures) >= _MAX_FIELD_COMMIT_FAILURES:
            truncated = True
            continue
        option_count_value = _first_value(payload, {"option_count", "optioncount"})
        try:
            option_count = (
                max(0, int(option_count_value)) if option_count_value is not None else None
            )
        except (TypeError, ValueError):
            option_count = None
        selected_present = _first_value(
            payload,
            {
                "selected_value_present",
                "selectedvaluepresent",
                "committed_value_present",
                "committedvaluepresent",
            },
        )
        failures.append(
            {
                "event_id": _event_id(event),
                "field_id": field_id,
                "label": label,
                "ui_model": ui_model,
                "action": _safe_action(
                    _first_value(payload, {"action"}) or element.get("action") or ""
                ),
                "reason_code": reason_code or "field_action_failed",
                "committed": False,
                "required": (
                    bool(_first_value(payload, {"required"}))
                    if _first_value(payload, {"required"}) is not None
                    else None
                ),
                "option_count": option_count,
                "selected_value_present": (
                    bool(selected_present) if selected_present is not None else None
                ),
                "attempted_option": "",
                "action_method": "",
                "action_result": "",
                "commit_verified": None,
                "selected_pill_present": None,
                "backing_value_present": None,
                "validation_visible": None,
            }
        )
    return failures, truncated


def _field_commit_failure_matches_element(
    failure: Mapping[str, Any],
    element: Any,
) -> bool:
    raw_element = _model_dump_or_none(element) or {}
    failure_id = _safe_identifier(failure.get("field_id") or "")
    element_id = _safe_identifier(
        raw_element.get("field_id")
        or raw_element.get("element_id")
        or raw_element.get("automation_id")
        or ""
    )
    if failure_id and element_id and failure_id == element_id:
        return True
    failure_label = re.sub(
        r"[^a-z0-9]+",
        " ",
        str(failure.get("label") or "").lower(),
    ).strip()
    element_label = re.sub(
        r"[^a-z0-9]+",
        " ",
        str(raw_element.get("label") or "").lower(),
    ).strip()
    return bool(
        failure_label
        and element_label
        and (
            failure_label == element_label
            or failure_label in element_label
            or element_label in failure_label
        )
    )


def _known_cause_has_direct_proof(
    code: str,
    events: list[dict[str, Any]],
    observed_messages: list[str],
    page_observations: list[dict[str, Any]],
) -> bool:
    combined = " ".join(observed_messages)
    page_kinds = {item.get("page_kind") for item in page_observations}
    if code == "credential_rejected":
        return bool(
            re.search(
                r"wrong email address or password|account might be locked|invalid "
                r"(?:email address|username) or password|incorrect email or password",
                combined,
                re.I,
            )
            or "credential_rejected" in page_kinds
        )
    if code == "maintenance":
        return bool(
            re.search(
                r"(?:undergoing|scheduled)\s+maintenance|service unavailable|"
                r"temporarily unavailable|down for maintenance",
                combined,
                re.I,
            )
            or "maintenance" in page_kinds
        )
    if code == "job_unavailable":
        return bool(
            re.search(
                r"page you are looking for|job is no longer available|job posting "
                r"(?:is )?(?:closed|expired)|position has been filled",
                combined,
                re.I,
            )
            or "job_unavailable" in page_kinds
        )
    if code == "auth_captcha_gate":
        if "captcha_present" in page_kinds:
            return True
        for event in events:
            proof = _first_value(
                _payload(event),
                {
                    "captcha_challenge_present",
                    "captchachallengepresent",
                    "captcha_present",
                    "captchapresent",
                },
            )
            if proof is True:
                return True
        return False
    return code == "unclassified_failure"


def required_field_label_from_validation(value: Any) -> str:
    """Return only a field name explicitly stated by a required-value validation."""

    if not isinstance(value, str):
        return ""
    match = _REQUIRED_FIELD_VALIDATION_RE.search(value)
    return _safe_text(match.group("label"), limit=300).strip(" *:-") if match else ""


def required_field_text_is_empty(label: str, value: Any) -> bool:
    """Require same-field text plus an explicit empty/zero-selection marker."""

    return bool(_text_names_required_field(label, value) and _EMPTY_FIELD_EVIDENCE_RE.search(value))


def _text_names_required_field(label: str, value: Any) -> bool:
    if not label or not isinstance(value, str):
        return False
    normalized_label = re.sub(r"[^a-z0-9]+", " ", label.lower()).strip()
    normalized_value = re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
    return bool(normalized_label and normalized_label in normalized_value)


def _direct_required_field_blocker(
    authoritative: dict[str, Any] | None,
    cause_event: dict[str, Any] | None,
    events: list[dict[str, Any]],
) -> tuple[str, C3ElementEvidence, dict[str, Any], str] | None:
    validation_messages: list[str] = []
    seen_sources: set[int] = set()
    for event in (cause_event, authoritative):
        if event is None or id(event) in seen_sources:
            continue
        seen_sources.add(id(event))
        validation_messages.extend(
            _safe_text_list(
                _find_values(
                    _payload(event),
                    {
                        "validation_messages",
                        "validationmessages",
                        "visible_validation_errors",
                        "visiblevalidationerrors",
                    },
                )
            )
        )
    named_validations = [
        (required_field_label_from_validation(message), message) for message in validation_messages
    ]
    named_validations = [(label, message) for label, message in named_validations if label]
    if not named_validations:
        return None

    terminal_seq = _event_seq(authoritative) if authoritative else None
    for event in reversed(events):
        if terminal_seq is not None and _event_seq(event) > terminal_seq:
            continue
        payload = _payload(event)
        raw_candidates = [
            value
            for value in _find_values(
                payload,
                {
                    "field",
                    "element",
                    "causal_element",
                    "causalelement",
                },
            )
            if isinstance(value, Mapping)
        ]
        for raw in raw_candidates:
            field_text = " ".join(
                str(raw.get(key) or "")
                for key in (
                    "label",
                    "text",
                    "value",
                    "raw_value",
                    "rawValue",
                )
            )
            for label, message in named_validations:
                explicit_empty = required_field_text_is_empty(label, field_text)
                selected_present = _first_value(
                    raw,
                    {
                        "selected_value_present",
                        "selectedvaluepresent",
                        "committed_value_present",
                        "committedvaluepresent",
                    },
                )
                explicit_empty = explicit_empty or (
                    selected_present is False and _text_names_required_field(label, field_text)
                )
                if not explicit_empty:
                    continue
                element_data = dict(raw)
                element_data["label"] = label
                element = _element(element_data, payload)
                if element is None:
                    element = C3ElementEvidence(label=label)
                return label, element, event, _safe_text(message, limit=300)
    return None


def build_failure_context(
    operation: Any,
    events: Iterable[Any],
    artifact_ids: Iterable[str] = (),
    *,
    evidence_truncated: bool = False,
) -> C3FailureContext:
    """Build the same packet for the same operation/events, without side effects."""

    traversal_report = _TraversalReport()
    operation_data = _as_mapping(operation)
    normalized_events = [
        event
        for event in _normalize_events(events, traversal_report)
        if _event_type(event).lower()
        not in {
            "operation.result_ignored_after_cancel",
            "operation.result_ignored_after_deadline",
        }
    ]
    observed_messages, observed_messages_truncated = _observed_messages_from_events(
        normalized_events
    )
    diagnostic_messages, diagnostic_messages_truncated = _diagnostic_messages_from_events(
        normalized_events,
        excluded_visible_messages=observed_messages,
    )
    page_observations, page_observations_truncated = _page_observations_from_events(
        normalized_events
    )
    field_commit_failures, field_commit_failures_truncated = _field_commit_failures_from_events(
        normalized_events
    )
    materialized_artifact_ids, artifact_input_truncated = _materialize_artifact_ids(artifact_ids)
    for event in normalized_events:
        for _ in _bounded_walk(_payload(event), traversal_report):
            pass
    authoritative = _authoritative_event(normalized_events)
    credential_preparation, credential_preparation_truncated = _credential_preparation_from_event(
        authoritative
    )
    cause_code, cause_event = _select_cause(authoritative, normalized_events)
    reported_cause_code = cause_code
    required_field_blocker = (
        _direct_required_field_blocker(authoritative, cause_event, normalized_events)
        if cause_code in {"visible_validation_errors", "visible_validation_errors_after_next"}
        else None
    )
    diagnostic_cause_code = "required_field_uncommitted" if required_field_blocker else cause_code
    cause_asserted = bool(required_field_blocker) or (
        cause_code != "unclassified_failure"
        and _known_cause_has_direct_proof(
            cause_code,
            normalized_events,
            observed_messages,
            page_observations,
        )
    )
    effective_cause_code = diagnostic_cause_code if cause_asserted else "unclassified_failure"
    evidence_conflicts: list[str] = []
    operation_state = _normalize_code(operation_data.get("state"))
    page_kinds = {item.get("page_kind") for item in page_observations}
    if operation_state in {"failed", "cancelled", "orphaned"} and "review" in page_kinds:
        evidence_conflicts.append("terminal_failure_with_review_evidence")
    if not cause_asserted and reported_cause_code != "unclassified_failure":
        evidence_conflicts.append(f"unasserted_reported_cause_{reported_cause_code}")
    auth_transition_history, raw_auth_transition_count, auth_history_input_clipped = (
        _auth_transition_history(authoritative)
    )
    explicit_auth_transition_count = _auth_transition_count(authoritative)
    auth_transition_total = max(
        raw_auth_transition_count,
        explicit_auth_transition_count or 0,
    )
    auth_history_truncated = auth_history_input_clipped or bool(
        explicit_auth_transition_count is not None
        and explicit_auth_transition_count > len(auth_transition_history)
    )
    scope = _classify_scope(diagnostic_cause_code)
    if cause_code in _EVIDENCE_GATED_AUTH_CYCLE_CODES and auth_transition_history:
        scope = "navigation"

    if required_field_blocker:
        _, causal_element, causal_event, _ = required_field_blocker
    else:
        causal_element, causal_event = _find_causal_element(
            diagnostic_cause_code,
            scope,
            authoritative,
            normalized_events,
            cause_event,
            auth_transition_history,
        )
    last_touched, last_event = _find_last_touched(normalized_events, authoritative)
    exposing_action, exposing_event, exposing_rejection_reason = _find_exposing_action(
        reported_cause_code, normalized_events, authoritative
    )
    if cause_code in _AUTH_CYCLE_CODES and auth_transition_history:
        cycle_identity = _last_auth_cycle_candidate(
            auth_transition_history, _payload(authoritative)
        )
        if cycle_identity:
            if causal_element is None:
                causal_element = cycle_identity
                causal_event = authoritative
            if exposing_action is None:
                exposing_action = cycle_identity
                exposing_event = authoritative
    if cause_code == "auth_signup_signin_loop":
        terminal_identity = _auth_loop_terminal_identity(authoritative)
        if terminal_identity:
            if causal_element is None:
                causal_element = terminal_identity
                causal_event = authoritative
            if exposing_action is None:
                exposing_action = terminal_identity
                exposing_event = authoritative
            if last_touched is None or (
                authoritative is not None
                and last_event is not authoritative
                and _event_seq(last_event) < _event_seq(authoritative)
            ):
                last_touched = terminal_identity
                last_event = authoritative
    if scope in _NON_CAUSAL_ELEMENT_SCOPES and not _allows_navigation_causal_element(
        cause_code,
        auth_transition_history,
    ):
        causal_element = None
        causal_event = None
    commit_mechanism_known = bool(
        required_field_blocker
        and causal_element
        and any(
            _field_commit_failure_matches_element(failure, causal_element)
            for failure in field_commit_failures
        )
    )

    expected_state, observed_state = _states_for(
        diagnostic_cause_code,
        authoritative,
        cause_event,
        exposing_rejection_reason,
        auth_transition_history,
        auth_transition_total,
    )
    if required_field_blocker:
        required_label = required_field_blocker[0]
        expected_state = f'Required field "{required_label}" contains a committed value.'
        observed_state = (
            f'Required field "{required_label}" remained empty, and the site '
            "displayed a required-value validation error."
        )
    if cause_code == "auth_captcha_gate" and not cause_asserted:
        expected_state = "A visible structural security challenge is directly observed."
        observed_state = (
            "No direct visible CAPTCHA proof was retained; only an authentication "
            "candidate or gate label was reported."
        )
        if exposing_rejection_reason:
            observed_state += f" Candidate rejection: {exposing_rejection_reason}."
    confidence, root_unknown = _confidence_for(
        diagnostic_cause_code,
        scope,
        causal_element,
        authoritative,
        auth_transition_history,
    )
    if cause_code == "auth_captcha_gate" and not cause_asserted:
        confidence = "unknown"
    if not cause_asserted:
        root_unknown = True
    missing_evidence = _missing_evidence_for(
        diagnostic_cause_code,
        scope,
        causal_element,
        confidence,
        authoritative,
        exposing_rejection_reason,
        auth_transition_history,
    )
    if required_field_blocker:
        missing_evidence = [] if commit_mechanism_known else ["field_commit_evidence"]
    if cause_code == "auth_captcha_gate":
        missing_evidence = [] if cause_asserted else ["direct_captcha_challenge"]
    live_inspection_required = _live_inspection_required(
        diagnostic_cause_code,
        scope,
        confidence,
        root_unknown,
        missing_evidence,
    )

    contributing = {
        id(event)
        for event in (cause_event, authoritative, causal_event, last_event, exposing_event)
        if event is not None
    }
    evidence_event_ids = _OrderedCollector(_MAX_EVIDENCE_EVENT_IDS)
    checkpoint_ids = _OrderedCollector(_MAX_CHECKPOINT_IDS)
    validation_messages = _OrderedCollector(_MAX_VALIDATION_MESSAGES)
    invalidated_event_ids = {
        _event_id(event)
        for event in normalized_events
        if _is_failure_evidence_event(event)
        and _failure_was_resolved(event, normalized_events, authoritative)
    }
    for event in normalized_events:
        payload = _payload(event)
        if id(event) in contributing:
            evidence_event_ids.add(_event_id(event))
            evidence_event_ids.extend(
                event_id
                for event_id in _string_list(
                    _find_values(payload, {"evidence_event_ids", "evidenceeventids"})
                )
                if event_id not in invalidated_event_ids
            )
            checkpoint_ids.extend(
                _string_list(_find_values(payload, {"checkpoint_ids", "checkpointids"})),
            )
            checkpoint_id = _first_value(payload, {"checkpoint_id", "checkpointid"})
            if checkpoint_id:
                checkpoint_ids.add(_safe_text(checkpoint_id, limit=160))
            validation_messages.extend(
                _safe_text_list(
                    _find_values(
                        payload,
                        {
                            "validation_messages",
                            "validationmessages",
                            "visible_validation_errors",
                            "visiblevalidationerrors",
                        },
                    )
                ),
            )

    all_artifact_ids, artifact_ids_truncated = _collect_artifact_ids(
        operation_data, normalized_events, materialized_artifact_ids
    )
    artifact_status = _artifact_status(normalized_events, all_artifact_ids)
    monitor_summary = _monitor_summary(normalized_events)
    authoritative_id = _event_id(authoritative) if authoritative else ""
    authoritative_type = _event_type(authoritative) if authoritative else ""
    authoritative_seq = _event_seq(authoritative) if authoritative else 0
    generated_at = _safe_text(
        (authoritative or {}).get("ts")
        or operation_data.get("updated_at")
        or operation_data.get("created_at")
        or "",
        limit=80,
    )
    operation_id = _safe_identifier(operation_data.get("operation_id") or "unknown-operation")
    diagnosis_suffix = _safe_identifier(authoritative_id or str(authoritative_seq or "none"))
    timeout_evidence = _first_mapping(
        _payload(authoritative or {}),
        {"timeout_evidence", "timeoutevidence"},
    )
    auth_action_boundary = _auth_action_boundary(authoritative)
    summary = _summary_for(effective_cause_code, scope)
    if effective_cause_code == "required_field_uncommitted" and commit_mechanism_known:
        summary = (
            "A directly observed required field remained empty and blocked page advancement; "
            "C3 retained the failed field-commit mechanism."
        )

    raw = {
        "diagnosis_id": f"diagnosis-{operation_id}-{diagnosis_suffix}",
        "operation_id": operation_id,
        "failure_scope": scope,
        "root_cause_code": effective_cause_code,
        "reported_cause_code": reported_cause_code,
        "cause_asserted": cause_asserted,
        "summary": summary,
        "causal_element": _model_dump_or_none(causal_element),
        "last_touched_element": _model_dump_or_none(last_touched),
        "exposing_action": _model_dump_or_none(exposing_action),
        "expected_state": expected_state,
        "observed_state": observed_state,
        "observed_messages": observed_messages,
        "diagnostic_messages": diagnostic_messages,
        "page_observations": page_observations,
        "field_commit_failures": field_commit_failures,
        "timeout_evidence": dict(timeout_evidence or {}),
        "auth_action_boundary": auth_action_boundary,
        "evidence_conflicts": evidence_conflicts,
        "validation_messages": validation_messages.values,
        "credential_preparation": credential_preparation,
        "evidence_event_ids": evidence_event_ids.values,
        "checkpoint_ids": checkpoint_ids.values,
        "artifact_ids": all_artifact_ids,
        "ruled_out": _ruled_out_for(diagnostic_cause_code),
        "confidence": confidence,
        "root_cause_unknown": root_unknown,
        "mechanism_unknown": bool(
            (required_field_blocker and not commit_mechanism_known)
            or (effective_cause_code == "unclassified_failure" and not cause_asserted)
        ),
        "missing_evidence": missing_evidence,
        "monitor_summary": monitor_summary.model_dump(mode="python"),
        "artifact_status": artifact_status,
        "evidence_truncated": (
            evidence_truncated
            or traversal_report.truncated
            or evidence_event_ids.truncated
            or checkpoint_ids.truncated
            or validation_messages.truncated
            or observed_messages_truncated
            or diagnostic_messages_truncated
            or page_observations_truncated
            or field_commit_failures_truncated
            or credential_preparation_truncated
            or artifact_ids_truncated
            or artifact_input_truncated
            or auth_history_truncated
        ),
        "authoritative_event_id": authoritative_id,
        "authoritative_event_type": authoritative_type,
        "source_event_sequence": authoritative_seq,
        "live_inspection_required": live_inspection_required,
        "next_safe_action": _next_safe_action_for(effective_cause_code, scope),
        "generated_at": generated_at,
    }
    safe, _ = redact_payload(raw)
    structurally_safe = _redact_structural_values(
        safe, _collect_sensitive_values(normalized_events)
    )
    structurally_safe = _restore_internal_identifier_fields(structurally_safe, raw)
    return C3FailureContext.model_validate(structurally_safe)


def _as_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    raise TypeError("operation and events must be mappings or Pydantic models")


def _materialize_artifact_ids(
    artifact_ids: Iterable[str] | str,
) -> tuple[list[Any], bool]:
    if isinstance(artifact_ids, str):
        return [artifact_ids], False
    if isinstance(artifact_ids, (set, frozenset)):
        materialized = sorted(artifact_ids, key=str)
        return materialized[:_MAX_ARTIFACT_IDS], len(materialized) > _MAX_ARTIFACT_IDS
    materialized = list(islice(iter(artifact_ids), _MAX_ARTIFACT_IDS + 1))
    return materialized[:_MAX_ARTIFACT_IDS], len(materialized) > _MAX_ARTIFACT_IDS


def _bounded_walk(value: Any, report: _TraversalReport | None = None) -> Iterable[tuple[str, Any]]:
    report = report or _TraversalReport()
    stack: list[tuple[Any, str, int, frozenset[int]]] = [(value, "", 0, frozenset())]
    visited_nodes = 0
    while stack:
        current, key, depth, ancestors = stack.pop()
        visited_nodes += 1
        if visited_nodes > _MAX_WALK_NODES:
            report.mark_truncated()
            return
        yield key, current
        if not isinstance(current, (Mapping, list, tuple, set, frozenset)):
            continue
        if depth >= _MAX_WALK_DEPTH:
            report.mark_truncated()
            continue
        identity = id(current)
        if identity in ancestors:
            report.mark_truncated()
            continue
        child_ancestors = ancestors | {identity}
        if isinstance(current, Mapping):
            children = [(child, _snake_key(child_key)) for child_key, child in current.items()]
        elif isinstance(current, (set, frozenset)):
            children = [(child, key) for child in sorted(current, key=repr)]
        else:
            children = [(child, key) for child in current]
        for child, child_key in reversed(children):
            stack.append((child, child_key, depth + 1, child_ancestors))


def _normalize_events(
    events: Iterable[Any], report: _TraversalReport | None = None
) -> list[dict[str, Any]]:
    normalized: list[tuple[int, dict[str, Any]]] = []
    for index, event in enumerate(events):
        row = _as_mapping(event)
        normalized.append((index, row))
        for nested_index, nested in enumerate(_nested_field_failure_events(row), start=1):
            normalized.append((index * 10 + nested_index, nested))
    normalized.sort(key=lambda item: (_event_seq(item[1]), str(item[1].get("ts") or ""), item[0]))
    ordered = [event for _, event in normalized]
    if len(ordered) <= _MAX_DIAGNOSIS_EVENTS:
        return ordered
    if report is not None:
        report.mark_truncated()
    authoritative = _authoritative_event(ordered)
    retained = ordered[-_MAX_DIAGNOSIS_EVENTS:]
    if authoritative is not None and authoritative not in retained:
        retained[0] = authoritative
        retained.sort(key=lambda event: (_event_seq(event), str(event.get("ts") or "")))
    return retained


def _nested_field_failure_events(parent: Mapping[str, Any]) -> list[dict[str, Any]]:
    if _event_type(parent) == "field.action.failed":
        return []
    retained: list[dict[str, Any]] = []
    parent_payload = _payload(parent)
    for _key, current in _bounded_walk(parent_payload):
        if not isinstance(current, Mapping):
            continue
        nested_type = str(
            current.get("event_type") or current.get("eventType") or current.get("action") or ""
        ).lower()
        if nested_type != "field.action.failed":
            continue
        payload = _normalized_nested_field_payload(current)
        if not payload:
            continue
        retained.append(
            {
                "seq": _event_seq(parent),
                "event_id": f"{_event_id(parent)}.field-failure-{len(retained) + 1}",
                "event_type": "field.action.failed",
                "ts": parent.get("ts"),
                "payload": payload,
            }
        )
        if len(retained) >= 4:
            break
    return retained


def _normalized_nested_field_payload(value: Mapping[str, Any]) -> dict[str, Any]:
    detail = value.get("payload") if isinstance(value.get("payload"), Mapping) else value
    reason_code = (
        _normalize_code(_first_value(detail, {"reason_code", "reasoncode", "reason"}))
        or "field_action_failed"
    )
    field_id = _safe_identifier(_first_value(value, {"field_id", "fieldid"}) or "")
    label = _safe_text(_first_value(value, {"label", "descriptor"}) or "", limit=300)
    ui_model = _safe_identifier(_first_value(value, {"ui_model", "uimodel", "kind"}) or "")
    raw_element = _first_mapping(value, {"causal_element", "causalelement", "element"})
    element = dict(raw_element) if raw_element else {}
    if field_id:
        element["field_id"] = field_id
    if label:
        element["label"] = label
    if ui_model:
        element["ui_model"] = ui_model
    if "selectorPath" in element and "selector" not in element:
        element["selector"] = element.pop("selectorPath")
    action = _safe_action(_first_value(value, {"action"}) or "")
    if not action:
        action = "select" if ui_model in {"combobox", "button_listbox", "select"} else "type"
    element["action"] = action
    return {
        "reason_code": reason_code,
        "field_id": field_id,
        "action": action,
        "committed": False,
        "required": _first_value(value, {"required"}),
        "option_count": _first_value(value, {"option_count", "optioncount"}),
        "selected_value_present": _first_value(
            value,
            {
                "selected_value_present",
                "selectedvaluepresent",
                "committed_value_present",
                "committedvaluepresent",
            },
        ),
        "causal_element": element,
        "expected_state": "Field action completes with a verified commit.",
        "observed_state": f"Field action ended without commit proof ({reason_code}).",
    }


def _authoritative_event(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    terminal = [event for event in events if _event_type(event) in _TERMINAL_EVENT_TYPES]
    if terminal:
        return terminal[0]
    control = [event for event in events if _event_type(event) in _CONTROL_EVENT_TYPES]
    if control:
        return control[-1]
    non_monitor = [event for event in events if _event_type(event) not in _MONITOR_EVENT_TYPES]
    return (non_monitor or events or [None])[-1]


def _select_cause(
    authoritative: dict[str, Any] | None,
    events: list[dict[str, Any]],
) -> tuple[str, dict[str, Any] | None]:
    candidates: list[tuple[int, int, str, dict[str, Any]]] = []
    terminal_seq = _event_seq(authoritative) if authoritative else None
    bounded = [
        event
        for event in events
        if _event_type(event) not in _MONITOR_EVENT_TYPES
        and (terminal_seq is None or _event_seq(event) <= terminal_seq)
    ]
    correlated_failures = [
        event
        for event in bounded
        if event is not authoritative
        and _is_failure_evidence_event(event)
        and _event_correlated_to_authoritative(event, authoritative)
        and not _failure_was_resolved(event, bounded, authoritative)
    ]
    latest_unresolved = correlated_failures[-1] if correlated_failures else None
    relevant = [event for event in (authoritative, latest_unresolved) if event is not None]
    for event in relevant:
        is_authoritative = event is authoritative
        for key_score, code in _code_candidates(_payload(event)):
            score = key_score + (20 if is_authoritative else 0) + _specificity_score(code)
            candidates.append((score, _event_seq(event), code, event))
    if candidates:
        _, _, code, event = max(candidates, key=lambda item: (item[0], item[1]))
        if event is authoritative:
            matching_nested = next(
                (
                    failure
                    for failure in reversed(correlated_failures)
                    if code in {candidate for _, candidate in _code_candidates(_payload(failure))}
                ),
                None,
            )
            if matching_nested is not None:
                event = matching_nested
        return code, event
    return "unknown_failure", authoritative


def _is_failure_evidence_event(event: Mapping[str, Any]) -> bool:
    event_type = _event_type(event).lower()
    payload = _payload(event)
    return (
        "failed" in event_type
        or event_type.endswith(".failure")
        or str(payload.get("stage") or "").lower() == "failed"
    )


def _event_correlated_to_authoritative(
    event: Mapping[str, Any], authoritative: Mapping[str, Any] | None
) -> bool:
    if not authoritative:
        return False
    linked_ids = set(
        _string_list(
            _find_values(
                _payload(authoritative),
                {"evidence_event_ids", "evidenceeventids"},
            )
        )
    )
    if _event_id(event) in linked_ids:
        return True
    return bool(_correlation_tokens(event) & _correlation_tokens(authoritative))


def _correlation_tokens(event: Mapping[str, Any]) -> set[str]:
    payload = _payload(event)
    tokens: set[str] = set()
    for name in {
        "action_id",
        "actionid",
        "checkpoint_id",
        "checkpointid",
        "field_id",
        "fieldid",
        "selector",
    }:
        for value in _find_values(payload, {name}):
            for token in _string_list(value):
                if token:
                    tokens.add(f"{_snake_key(name)}:{token}")
    return tokens


def _failure_was_resolved(
    failure: Mapping[str, Any],
    events: list[dict[str, Any]],
    authoritative: Mapping[str, Any] | None,
) -> bool:
    failure_tokens = _correlation_tokens(failure)
    if not failure_tokens:
        return False
    for event in events:
        if _event_seq(event) <= _event_seq(failure) or event is authoritative:
            continue
        if not failure_tokens.intersection(_correlation_tokens(event)):
            continue
        if _is_resolution_event(event):
            return True
    return False


def _is_resolution_event(event: Mapping[str, Any]) -> bool:
    event_type = _event_type(event).lower()
    if any(
        marker in event_type
        for marker in (
            "action_completed",
            "action_repaired",
            "repair_completed",
            "commit_verified",
            "validation_cleared",
        )
    ):
        return True
    payload = _payload(event)
    proof = _first_mapping(payload, {"proof", "commit_proof", "commitproof"})
    return bool(proof and proof.get("committed") is True)


def _code_candidates(value: Any) -> list[tuple[int, str]]:
    candidates: list[tuple[int, str]] = []
    for key, candidate in _bounded_walk(value):
        if key not in _CODE_KEYS:
            continue
        code = _normalize_code(candidate)
        if code:
            candidates.append((_CODE_KEYS[key], code))
    return candidates


def _specificity_score(code: str) -> int:
    if code in _GENERIC_CODES:
        return -80
    scope = _classify_scope(code)
    if scope != "unknown":
        return 80
    return 0


def _normalize_code(value: Any) -> str:
    if not isinstance(value, (str, int)):
        return ""
    text = _safe_text(value, limit=160).strip()
    if (
        not text
        or REDACTED in text
        or len(text) > 160
        or not re.fullmatch(r"[A-Za-z0-9_.:-]+", text)
    ):
        return ""
    code = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", text)
    code = re.sub(r"[^A-Za-z0-9]+", "_", code).strip("_").lower()
    aliases = {
        "resume_upload_missing_resume_data": "resume_upload_missing_data",
        "missing_resume_data": "resume_upload_missing_data",
        "commit_not_verified": "workday_commit_not_verified",
        "workday_commit_failure": "workday_commit_not_verified",
    }
    if code.endswith("workday_commit_not_verified"):
        return "workday_commit_not_verified"
    if code.endswith("resume_upload_missing_resume_data"):
        return "resume_upload_missing_data"
    return aliases.get(code, code)


def _classify_scope(code: str) -> FailureScope:
    if code == "resume_upload_missing_data" or re.search(
        r"(?:missing|unavailable).*(?:resume|profile)|(?:resume|profile).*(?:missing|unavailable)",
        code,
    ):
        return "setup"
    if code in {
        "credential_rejected",
        "auth_create_account_to_signin_sink",
        "auth_captcha_gate",
        "auth_primary_action_not_found",
        "auth_signup_signin_loop",
        "auth_ui_cycle_detected",
        "application_fields_not_ready_after_auth",
        "no_safe_next_button",
        "workday_runtime_not_ready",
    } or any(token in code for token in ("navigation", "redirect", "signin_sink", "load_failed")):
        return "navigation"
    if code in {"maintenance", "job_unavailable"}:
        return "external_server"
    if code in {
        "required_field_uncommitted",
        "visible_validation_errors",
        "visible_validation_errors_after_next",
    }:
        return "ui_element"
    if any(token in code for token in ("tenant_server", "external_server", "http_4", "http_5")):
        return "external_server"
    if any(
        token in code
        for token in (
            "cancel",
            "watchdog",
            "lease",
            "control_plane",
            "deadline_exceeded",
            "orphaned",
        )
    ):
        return "control_plane"
    if any(token in code for token in ("browser", "cdp", "target_unreachable")):
        return "browser"
    if code == "extension_command_failed" or any(
        token in code for token in ("extension_worker", "extension_version")
    ):
        return "extension"
    if any(
        token in code
        for token in (
            "commit_not_verified",
            "validation_not_cleared",
            "option_not_committed",
            "popup_owner",
            "field_fill",
            "element_",
        )
    ):
        return "ui_element"
    return "unknown"


def _find_causal_element(
    code: str,
    scope: FailureScope,
    authoritative: dict[str, Any] | None,
    events: list[dict[str, Any]],
    cause_event: dict[str, Any] | None,
    auth_transition_history: list[Mapping[str, Any]],
) -> tuple[C3ElementEvidence | None, dict[str, Any] | None]:
    if (
        code == "auth_signup_signin_loop"
        or code == "auth_ui_cycle_detected"
        or (code in _EVIDENCE_GATED_AUTH_CYCLE_CODES and auth_transition_history)
    ) and authoritative:
        raw = _first_mapping(_payload(authoritative), {"causal_element", "causalelement"})
        element = _element(raw, _payload(authoritative))
        if element:
            return element, authoritative
    if scope in _NON_CAUSAL_ELEMENT_SCOPES:
        return None, None
    if scope not in {"ui_element", "setup"}:
        return None, None
    terminal_seq = _event_seq(authoritative) if authoritative else None
    bounded_events = [
        event for event in events if terminal_seq is None or _event_seq(event) <= terminal_seq
    ]
    ordered = ([authoritative] if authoritative else []) + list(reversed(bounded_events))
    linked_event_ids = set(
        _string_list(
            _find_values(
                _payload(authoritative or {}),
                {"evidence_event_ids", "evidenceeventids"},
            )
        )
    )
    seen: set[int] = set()
    for event in ordered:
        if event is None or id(event) in seen:
            continue
        seen.add(id(event))
        payload = _payload(event)
        directly_linked = (
            event is cause_event
            or event is authoritative
            or _event_id(event) in linked_event_ids
            or (
                _event_correlated_to_authoritative(event, authoritative)
                and code in {candidate for _, candidate in _code_candidates(payload)}
            )
        )
        if not directly_linked:
            continue
        if (
            event is not authoritative
            and _is_failure_evidence_event(event)
            and _failure_was_resolved(event, bounded_events, authoritative)
        ):
            continue
        if scope == "ui_element" and not _event_proves_element_failure(event, code):
            continue
        raw = _first_mapping(payload, {"causal_element", "causalelement"})
        if raw is None and scope == "ui_element":
            raw = _first_mapping(payload, {"element"})
        element = _element(raw, payload)
        if element:
            return element, event
    return None, None


def _event_proves_element_failure(event: Mapping[str, Any], code: str) -> bool:
    event_type = _event_type(event)
    payload = _payload(event)
    event_codes = {candidate for _, candidate in _code_candidates(payload)}
    code_linked = code in event_codes
    if event_type == "operation.failed" and code in {
        "visible_validation_errors",
        "visible_validation_errors_after_next",
    }:
        causal = _first_mapping(payload, {"causal_element", "causalelement"})
        validation = _find_values(
            payload,
            {
                "validation_messages",
                "validationmessages",
                "visible_validation_errors",
                "visiblevalidationerrors",
            },
        )
        return code_linked and causal is not None and any(bool(value) for value in validation)
    if event_type in {
        "operation.action_failed",
        "operation.commit_failed",
        "operation.validation_failed",
        "field.action.failed",
        "field.commit.failed",
        "field.validation.failed",
    }:
        return code_linked
    if event_type != "operation.action_checkpoint":
        return False
    if str(payload.get("stage") or "").lower() != "failed" or not code_linked:
        return False
    proof = _first_mapping(payload, {"proof", "commit_proof", "commitproof"})
    if proof and proof.get("committed") is False:
        return True
    validation = _find_values(
        payload,
        {
            "validation_messages",
            "validationmessages",
            "visible_validation_errors",
            "visiblevalidationerrors",
        },
    )
    return any(bool(value) for value in validation)


def _find_last_touched(
    events: list[dict[str, Any]], authoritative: dict[str, Any] | None
) -> tuple[C3ElementEvidence | None, dict[str, Any] | None]:
    for event in reversed(events):
        if authoritative is not None and _event_seq(event) > _event_seq(authoritative):
            continue
        payload = _payload(event)
        raw = _first_mapping(
            payload,
            {"last_touched_element", "lasttouchedelement"},
        )
        if raw is None and _event_type(event) in {
            "operation.action_checkpoint",
            "operation.action_failed",
            "operation.action_completed",
        }:
            raw = _first_mapping(payload, {"element"})
        if raw is None and _event_type(event) in {
            "operation.progress",
            "operation.heartbeat",
        }:
            raw = _first_mapping(payload, {"field"})
        element = _element(raw, payload)
        if element:
            return element, event
    return None, None


def _find_exposing_action(
    code: str,
    events: list[dict[str, Any]],
    authoritative: dict[str, Any] | None,
) -> tuple[C3ElementEvidence | None, dict[str, Any] | None, str]:
    if authoritative:
        raw = _first_mapping(_payload(authoritative), {"exposing_action", "exposingaction"})
        element = _element(raw, _payload(authoritative))
        if element:
            return element, authoritative, _candidate_rejection_reason(raw)
        if code in {"auth_primary_action_not_found", "auth_captcha_gate"}:
            candidate = _highest_ranked_auth_candidate(code, _payload(authoritative))
            if candidate is not None:
                element = _element(candidate, _payload(authoritative))
                if element:
                    return (
                        element,
                        authoritative,
                        _candidate_rejection_reason(candidate),
                    )
    if code == "auth_create_account_to_signin_sink":
        for event in reversed(events):
            if authoritative is not None and _event_seq(event) > _event_seq(authoritative):
                continue
            payload = _payload(event)
            label = str(_first_value(payload, {"label"}) or "")
            raw = _first_mapping(payload, {"element"})
            if raw and "create account" in f"{label} {raw.get('label', '')}".lower():
                element = _element(raw, payload)
                if element:
                    return element, event, ""
    return None, None, ""


def _highest_ranked_auth_candidate(
    code: str,
    payload: Mapping[str, Any],
) -> Mapping[str, Any] | None:
    ranked: list[tuple[float, int, int, Mapping[str, Any]]] = []
    retained_index = 0
    for candidates in _find_values(
        payload,
        {"near_miss_candidates", "nearmisscandidates"},
    ):
        if not isinstance(candidates, (list, tuple)):
            continue
        for candidate in candidates[:8]:
            if not isinstance(candidate, Mapping):
                continue
            if code == "auth_primary_action_not_found" and not _candidate_rejection_reason(
                candidate
            ):
                # Candidates without a current rejection can be historical
                # last-safe actions copied into terminal evidence. They do not
                # prove what blocked the present auth decision.
                retained_index += 1
                continue
            element = _element(candidate, payload)
            if (
                element is None
                or not _has_stable_causal_identity(element)
                or not _is_relevant_auth_candidate(code, candidate)
            ):
                retained_index += 1
                continue
            score_value = candidate.get("score")
            score = (
                float(score_value)
                if isinstance(score_value, (int, float)) and not isinstance(score_value, bool)
                else float("-inf")
            )
            role = str(candidate.get("role") or "").strip().lower()
            tag = str(candidate.get("tag") or "").strip().lower()
            actionability = 2 if role == "button" or tag == "button" else 1
            ranked.append((score, actionability, -retained_index, candidate))
            retained_index += 1
    if not ranked:
        return None
    return max(ranked, key=lambda item: item[:3])[3]


def _is_relevant_auth_candidate(code: str, candidate: Mapping[str, Any]) -> bool:
    identity = " ".join(
        str(candidate.get(key) or "")
        for key in ("automation_id", "automationId", "label", "selector")
    ).lower()
    compact = re.sub(r"[^a-z0-9]+", "", identity)
    captcha_tokens = ("captcha", "nocaptcha", "clickfilter", "challenge")
    if code == "auth_captcha_gate":
        return any(token in compact for token in captcha_tokens)
    auth_tokens = captcha_tokens + (
        "signin",
        "login",
        "createaccount",
        "signup",
        "submitbutton",
    )
    return any(token in compact for token in auth_tokens)


def _candidate_rejection_reason(candidate: Mapping[str, Any] | None) -> str:
    if not candidate:
        return ""
    return _normalize_code(candidate.get("rejection_reason") or candidate.get("rejectionReason"))


def _auth_transition_history(
    authoritative: Mapping[str, Any] | None,
) -> tuple[list[Mapping[str, Any]], int, bool]:
    if not authoritative:
        return [], 0, False
    payload = _payload(authoritative)
    containers = (
        _first_mapping(payload, {"terminal_step", "terminalstep"}),
        _first_mapping(payload, {"stop_details", "stopdetails"}),
    )
    for container in containers:
        if not container:
            continue
        for raw_history in _find_values(
            container,
            {
                "auth_transition_history",
                "authtransitionhistory",
                "transition_history",
                "transitionhistory",
            },
        ):
            if not isinstance(raw_history, (list, tuple)):
                continue
            history = [item for item in raw_history[-8:] if isinstance(item, Mapping)]
            if history:
                return history, len(raw_history), len(raw_history) > 8
    return [], 0, False


def _auth_transition_count(authoritative: Mapping[str, Any] | None) -> int | None:
    if not authoritative:
        return None
    payload = _payload(authoritative)
    for container in (
        _first_mapping(payload, {"terminal_step", "terminalstep"}),
        _first_mapping(payload, {"stop_details", "stopdetails"}),
    ):
        if not container:
            continue
        raw = _first_value(
            container,
            {"auth_transition_count", "authtransitioncount", "transition_count", "transitioncount"},
        )
        if isinstance(raw, int) and not isinstance(raw, bool):
            return max(0, min(1_000_000, raw))
    return None


def _auth_action_boundary(
    authoritative: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if not authoritative:
        return {}
    raw = _first_mapping(
        _payload(authoritative),
        {
            "auth_action_boundary",
            "authactionboundary",
            "last_auth_action_boundary",
            "lastauthactionboundary",
        },
    )
    if not raw:
        return {}

    def safe_int(value: Any) -> int:
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0

    def detection_sample(value: Mapping[str, Any] | None) -> dict[str, Any]:
        value = value or {}
        return {
            "authState": _normalize_code(_first_value(value, {"auth_state", "authstate"}))
            or "unknown",
            "authUiState": _normalize_code(_first_value(value, {"auth_ui_state", "authuistate"}))
            or "unknown",
            "documentGenerationId": _safe_identifier(
                _first_value(
                    value,
                    {"document_generation_id", "documentgenerationid"},
                )
                or ""
            ),
            "frameId": max(
                0,
                min(
                    1_000_000,
                    safe_int(_first_value(value, {"frame_id", "frameid"})),
                ),
            ),
            "emailCount": max(
                0,
                min(
                    100,
                    safe_int(_first_value(value, {"email_count", "emailcount"})),
                ),
            ),
            "passwordCount": max(
                0,
                min(
                    100,
                    safe_int(
                        _first_value(
                            value,
                            {
                                "password_count",
                                "passwordcount",
                            },
                        )
                    ),
                ),
            ),
            "emailPopulated": bool(_first_value(value, {"email_populated", "emailpopulated"})),
            "passwordPopulated": bool(
                _first_value(value, {"password_populated", "passwordpopulated"})
            ),
            "sampledAt": _safe_text(
                _first_value(value, {"sampled_at", "sampledat"}) or "",
                limit=80,
            ),
            "urlIdentity": _safe_text(
                _first_value(value, {"url_identity", "urlidentity"}) or "",
                limit=500,
            ),
            "pageTitle": _safe_text(
                _first_value(value, {"page_title", "pagetitle"}) or "",
                limit=300,
            ),
            "pageKind": _normalize_code(_first_value(value, {"page_kind", "pagekind"})),
            "phase": _normalize_code(_first_value(value, {"phase"})),
            "stillLoading": bool(_first_value(value, {"still_loading", "stillloading"})),
            "authShellStillSettling": bool(
                _first_value(
                    value,
                    {"auth_shell_still_settling", "authshellstillsettling"},
                )
            ),
        }

    pre = _first_mapping(raw, {"pre_action_detection", "preactiondetection"})
    post = _first_mapping(raw, {"post_action_detection", "postactiondetection"})
    stabilization = _first_mapping(raw, {"stabilization"}) or {}
    raw_samples = _first_value(stabilization, {"samples"})
    samples = (
        [
            detection_sample(sample)
            for sample in list(raw_samples)[-8:]
            if isinstance(sample, Mapping)
        ]
        if isinstance(raw_samples, (list, tuple))
        else []
    )
    completeness = _first_mapping(raw, {"credential_completeness", "credentialcompleteness"}) or {}
    receipt = _first_mapping(raw, {"action_receipt", "actionreceipt"}) or {}
    reason = (
        _normalize_code(_first_value(receipt, {"reason", "reason_code", "reasoncode"}))
        or _normalize_code(
            _first_value(
                stabilization,
                {"reason", "reason_code", "reasoncode"},
            )
        )
        or ""
    )
    boundary = {
        "stage": _normalize_code(_first_value(raw, {"stage"})) or "unknown",
        "preActionDetection": detection_sample(pre),
        "stabilization": {
            "reason": _normalize_code(
                _first_value(
                    stabilization,
                    {"reason", "reason_code", "reasoncode"},
                )
            )
            or reason,
            "sampleCount": max(
                len(samples),
                min(
                    8,
                    max(
                        0,
                        safe_int(
                            _first_value(
                                stabilization,
                                {"sample_count", "samplecount"},
                            )
                        ),
                    ),
                ),
            ),
            "samples": samples,
        },
        "credentialCompleteness": {
            "emailVisible": bool(_first_value(completeness, {"email_visible", "emailvisible"})),
            "passwordVisible": bool(
                _first_value(
                    completeness,
                    {
                        "password_visible",
                        "passwordvisible",
                    },
                )
            ),
            "emailPopulated": bool(
                _first_value(completeness, {"email_populated", "emailpopulated"})
            ),
            "passwordPopulated": bool(
                _first_value(
                    completeness,
                    {"password_populated", "passwordpopulated"},
                )
            ),
        },
        "actionReceipt": {
            "attempted": bool(_first_value(receipt, {"attempted"})),
            "candidateProbePerformed": bool(
                _first_value(
                    receipt,
                    {
                        "candidate_probe_performed",
                        "candidateprobeperformed",
                    },
                )
            ),
            "clicked": bool(_first_value(receipt, {"clicked"})),
            "reason": reason,
        },
    }
    if post:
        boundary["postActionDetection"] = detection_sample(post)
    candidate = _element(
        _first_mapping(raw, {"candidate"}),
        raw,
    )
    if candidate:
        boundary["candidate"] = candidate.model_dump(
            mode="python",
            exclude_none=True,
        )
    return boundary


def _last_auth_cycle_candidate(
    history: list[Mapping[str, Any]],
    parent: Mapping[str, Any],
) -> C3ElementEvidence | None:
    for transition in reversed(history):
        raw = _first_mapping(
            transition,
            {
                "candidate",
                "last_auth_action_candidate",
                "lastauthactioncandidate",
                "last_safe_candidate",
                "lastsafecandidate",
            },
        )
        element = _element(raw, parent)
        if element and _has_stable_causal_identity(element):
            return element
    terminal_step = _first_mapping(
        parent,
        {"terminal_step", "terminalstep"},
    )
    raw = _first_mapping(
        terminal_step or {},
        {
            "last_auth_action_candidate",
            "lastauthactioncandidate",
            "last_safe_candidate",
            "lastsafecandidate",
        },
    )
    element = _element(raw, parent)
    if element and _has_stable_causal_identity(element):
        return element
    return None


def _allows_navigation_causal_element(
    code: str,
    auth_transition_history: list[Mapping[str, Any]],
) -> bool:
    return code in {"auth_signup_signin_loop", "auth_ui_cycle_detected"} or (
        code in _EVIDENCE_GATED_AUTH_CYCLE_CODES and bool(auth_transition_history)
    )


def _auth_loop_terminal_identity(
    authoritative: Mapping[str, Any] | None,
) -> C3ElementEvidence | None:
    if not authoritative:
        return None
    payload = _payload(authoritative)
    raw = _first_mapping(
        payload,
        {
            "last_auth_action_candidate",
            "lastauthactioncandidate",
            "last_safe_candidate",
            "lastsafecandidate",
        },
    )
    return _element(raw, payload)


def _element(raw: Mapping[str, Any] | None, parent: Mapping[str, Any]) -> C3ElementEvidence | None:
    if not raw:
        return None
    aliases = {
        "id": "element_id",
        "elementid": "element_id",
        "automationid": "automation_id",
        "fieldid": "field_id",
        "key": "field_id",
        "kind": "input_type",
        "uimodel": "ui_model",
        "frameid": "frame_id",
        "documentid": "document_id",
        "checkpointid": "checkpoint_id",
        "boundingbox": "bounding_box",
        "rect": "bounding_box",
    }
    allowed = set(C3ElementEvidence.model_fields)
    data: dict[str, Any] = {}
    for key, value in raw.items():
        normalized = aliases.get(_snake_key(key), _snake_key(key))
        if normalized not in allowed or value is None:
            continue
        if normalized == "bounding_box" and isinstance(value, Mapping):
            width = value.get("width", value.get("w"))
            height = value.get("height", value.get("h"))
            if None not in (value.get("x"), value.get("y"), width, height):
                data[normalized] = {
                    "x": value["x"],
                    "y": value["y"],
                    "width": width,
                    "height": height,
                }
        elif normalized == "frame_id":
            try:
                data[normalized] = int(value)
            except (TypeError, ValueError):
                continue
        else:
            text = _safe_action(value) if normalized == "action" else _safe_text(value, limit=300)
            if normalized == "selector":
                text = _VALUE_SELECTOR_RE.sub(rf"\1'{REDACTED}'\2", text)
            data[normalized] = text
    action = _first_value(parent, {"action"})
    if action and not data.get("action"):
        data["action"] = _safe_action(action)
    checkpoint_id = _first_value(parent, {"checkpoint_id", "checkpointid"})
    if checkpoint_id and not data.get("checkpoint_id"):
        data["checkpoint_id"] = _safe_text(checkpoint_id, limit=160)
    if not any(data.get(key) for key in ("selector", "label", "element_id", "field_id")):
        return None
    return C3ElementEvidence.model_validate(data)


def _states_for(
    code: str,
    authoritative: dict[str, Any] | None,
    cause_event: dict[str, Any] | None,
    candidate_rejection_reason: str = "",
    auth_transition_history: list[Mapping[str, Any]] | None = None,
    auth_transition_total: int = 0,
) -> tuple[str, str]:
    expected = _find_state_value([cause_event, authoritative], {"expected_state", "expectedstate"})
    observed = _find_state_value([cause_event, authoritative], {"observed_state", "observedstate"})
    defaults = {
        "credential_rejected": (
            "Authentication advances to a non-authentication destination.",
            "The site displayed an explicit credential or account-lock rejection.",
        ),
        "maintenance": (
            "The job site exposes an available application surface.",
            "The site displayed an explicit maintenance or temporary-unavailability message.",
        ),
        "job_unavailable": (
            "The requested job posting exposes an application surface.",
            "The site displayed an explicit missing, closed, or unavailable-job message.",
        ),
        "auth_create_account_to_signin_sink": (
            "Create Account reaches verification or application fields.",
            "Create Account returned to Sign In without an exposed validation reason.",
        ),
        "application_fields_not_ready_after_auth": (
            "The authentication action reaches a verified application surface.",
            "No verified application surface appeared; authentication success was not established.",
        ),
        "auth_primary_action_not_found": (
            "A safe primary authentication action is selected.",
            "No eligible authentication action was selected; one structural near-miss was retained.",
        ),
        "auth_captcha_gate": (
            "The site authentication gate verifies the applicant.",
            "A captcha site gate blocked authentication progress.",
        ),
        "auth_signup_signin_loop": (
            "Authentication advances beyond the signup-to-signin transition.",
            "Signup returned to Sign In more than once in one run.",
        ),
        "auth_ui_cycle_detected": (
            "Authentication advances beyond the repeated UI states.",
            "Authentication entered a repeated UI control loop.",
        ),
        "auth_flow_limit_reached": (
            "Authentication advances beyond the active auth control loop.",
            "Authentication remained active until the auth flow limit.",
        ),
        "auth_same_page_attempt_limit_reached": (
            "Authentication advances beyond repeated attempts on the same page.",
            "Authentication remained on the same page until the attempt limit.",
        ),
        "resume_upload_missing_data": (
            "Resume attachment committed before continuing.",
            "Required resume data was unavailable.",
        ),
        "workday_commit_not_verified": (
            "Selected value committed to Workday backing state.",
            "Attempted value was not verifiably committed.",
        ),
        "control_plane_cancel_unreconciled": (
            "Cooperative cancellation reaches an acknowledged terminal state.",
            "Cancellation acknowledgement was not reconciled before control ownership ended.",
        ),
        "no_safe_next_button": (
            "A single safe non-submit navigation control is available.",
            "No safe Next or Continue candidate was retained.",
        ),
        "workday_runtime_not_ready": (
            "Workday exposes an authentication, application, validation, or navigation surface.",
            "Workday root remained structurally empty after readiness wait.",
        ),
    }
    default_expected, default_observed = defaults.get(
        code,
        (
            "Operation reaches its requested terminal outcome.",
            "Retained evidence does not establish the failing condition.",
        ),
    )
    resolved_observed = observed or default_observed
    if code in _AUTH_CYCLE_CODES and auth_transition_history:
        cycle_period, cycle_length = (
            _auth_cycle_metrics(authoritative) if code == "auth_ui_cycle_detected" else (None, None)
        )
        resolved_observed = _auth_cycle_observed_state(
            auth_transition_history,
            cycle_period=cycle_period,
            cycle_length=cycle_length,
            total_count=auth_transition_total,
        )
    if candidate_rejection_reason:
        suffix = f" Candidate rejection: {candidate_rejection_reason}."
        resolved_observed = f"{_safe_text(resolved_observed, limit=500 - len(suffix))}{suffix}"
    return expected or default_expected, resolved_observed


def _auth_cycle_metrics(
    authoritative: Mapping[str, Any] | None,
) -> tuple[int | None, int | None]:
    payload = _payload(authoritative or {})

    def metric(names: set[str]) -> int | None:
        raw = _first_value(payload, names)
        if not isinstance(raw, int) or isinstance(raw, bool):
            return None
        return max(0, min(1_000_000, raw))

    return metric({"cycle_period", "cycleperiod"}), metric({"cycle_length", "cyclelength"})


def _auth_cycle_observed_state(
    history: list[Mapping[str, Any]],
    *,
    cycle_period: int | None = None,
    cycle_length: int | None = None,
    total_count: int = 0,
) -> str:
    displayed_history = history[:8]
    repeating_suffix = ""
    if cycle_period is not None and 0 < cycle_period < len(displayed_history):
        displayed_history = displayed_history[-cycle_period:]
        repeating_suffix = f"; repeating suffix of {cycle_period}"
    transitions: list[str] = []
    for transition in displayed_history:
        from_state = _transition_state_label(transition, "from")
        to_state = _transition_state_label(transition, "to")
        transitions.append(f"{from_state}->{to_state}")
    detail = "; ".join(transitions)
    retained_count = len(history)
    total_count = max(retained_count, total_count)
    if total_count > retained_count:
        prefix = (
            f"Authentication UI cycle observed {total_count} total transitions with "
            f"{retained_count} retained transitions"
        )
    else:
        prefix = f"Authentication UI cycle observed {retained_count} retained transitions"
    cycle_metrics: list[str] = []
    if cycle_period is not None:
        cycle_metrics.append(f"cycle period {cycle_period}")
    if cycle_length is not None:
        cycle_metrics.append(f"cycle length {cycle_length}")
    if cycle_metrics:
        prefix = f"{prefix} ({', '.join(cycle_metrics)}{repeating_suffix})"
    return _safe_text(f"{prefix}: {detail}.", limit=500)


def _transition_state_label(transition: Mapping[str, Any], direction: str) -> str:
    state = _safe_text(
        transition.get(f"{direction}_auth_state")
        or transition.get(f"{direction}AuthState")
        or "unknown",
        limit=40,
    )
    ui_state = _safe_text(
        transition.get(f"{direction}_auth_ui_state")
        or transition.get(f"{direction}AuthUiState")
        or "unknown",
        limit=40,
    )
    return f"{state}/{ui_state}"


def _find_state_value(events: list[dict[str, Any] | None], names: set[str]) -> str:
    for event in events:
        if not event:
            continue
        value = _first_value(_payload(event), names)
        if value:
            return _safe_text(value, limit=500)
    return ""


def _confidence_for(
    code: str,
    scope: FailureScope,
    causal_element: C3ElementEvidence | None,
    authoritative: dict[str, Any] | None,
    auth_transition_history: list[Mapping[str, Any]] | None = None,
) -> tuple[Confidence, bool]:
    if code in {
        "credential_rejected",
        "maintenance",
        "job_unavailable",
        "required_field_uncommitted",
    }:
        return "proven", False
    if code == "auth_create_account_to_signin_sink":
        return "strong", True
    if code == "auth_primary_action_not_found":
        return "strong", True
    if code == "auth_captcha_gate":
        return "strong", False
    if code == "auth_signup_signin_loop":
        return "proven", False
    if code == "auth_ui_cycle_detected":
        return "strong", False
    if code in _EVIDENCE_GATED_AUTH_CYCLE_CODES and auth_transition_history:
        return "strong", False
    if code == "application_fields_not_ready_after_auth":
        return "strong", True
    if code == "no_safe_next_button":
        return "strong", True
    if code == "workday_runtime_not_ready":
        return "strong", True
    if _is_generic_boundary_error(code) and not _has_underlying_cause_proof(authoritative):
        return "weak", True
    if code in {"resume_upload_missing_data", "control_plane_cancel_unreconciled"}:
        return "proven", False
    if scope == "ui_element" and causal_element:
        if _has_stable_causal_identity(causal_element):
            return "proven", False
        return "weak", True
    if scope in {"control_plane", "browser", "extension", "external_server"} and authoritative:
        return "strong", False
    return "unknown", True


def _has_stable_causal_identity(element: C3ElementEvidence) -> bool:
    if any(
        (
            element.element_id,
            element.automation_id,
            element.field_id,
        )
    ):
        return True
    selector = element.selector.strip()
    if not selector or _DYNAMIC_SELECTOR_RE.search(selector):
        return False
    return bool(
        re.search(
            r"(?i)(?:#[A-Za-z][A-Za-z0-9_.:-]*|\[(?:data-automation-id|id|name|"
            r"aria-label|data-fkit-id)\s*=)",
            selector,
        )
    )


def _is_generic_boundary_error(code: str) -> bool:
    return code == "extension_command_failed" or bool(re.fullmatch(r"http_\d{3}", code))


def _has_underlying_cause_proof(authoritative: Mapping[str, Any] | None) -> bool:
    if not authoritative:
        return False
    proof_values = _find_values(
        _payload(authoritative),
        {
            "underlying_cause_proven",
            "underlyingcauseproven",
            "root_cause_proven",
            "rootcauseproven",
        },
    )
    return any(value is True for value in proof_values)


def _missing_evidence_for(
    code: str,
    scope: FailureScope,
    causal_element: C3ElementEvidence | None,
    confidence: Confidence,
    authoritative: Mapping[str, Any] | None,
    candidate_rejection_reason: str = "",
    auth_transition_history: list[Mapping[str, Any]] | None = None,
) -> list[str]:
    if code in {"credential_rejected", "maintenance", "job_unavailable"}:
        return []
    if code == "required_field_uncommitted":
        return ["field_commit_evidence"]
    if code == "auth_create_account_to_signin_sink":
        return ["tenant_rejection_reason"]
    if code in {"auth_primary_action_not_found", "auth_captcha_gate"}:
        return [] if candidate_rejection_reason else ["auth_candidate_rejection_reason"]
    if code == "auth_signup_signin_loop":
        return []
    if code in _AUTH_CYCLE_CODES:
        if not auth_transition_history:
            return ["auth_transition_history"]
        missing: list[str] = []
        if not _auth_transition_endpoints_complete(auth_transition_history):
            missing.append("auth_transition_endpoints")
        if causal_element is None:
            missing.append("auth_cycle_candidate")
        return missing
    if code == "application_fields_not_ready_after_auth":
        return ["post_auth_readiness_reason"]
    if code == "no_safe_next_button":
        return ["page_readiness_or_navigation_candidates"]
    if code == "workday_runtime_not_ready":
        for summary in _find_values(
            _payload(authoritative or {}),
            {"runtime_readiness", "runtimereadiness"},
        ):
            if isinstance(summary, Mapping) and _normalize_code(
                summary.get("reason_code") or summary.get("reasonCode") or summary.get("reason")
            ):
                return []
        return ["runtime_readiness_reason"]
    missing: list[str] = []
    if scope == "ui_element" and causal_element is None:
        missing.append("causal_element")
    if (
        scope == "ui_element"
        and causal_element is not None
        and not _has_stable_causal_identity(causal_element)
    ):
        missing.append("stable_causal_identity")
    if confidence == "weak":
        missing.append("underlying_cause")
    if scope == "unknown" or confidence == "unknown":
        missing.append("causal_evidence")
    return missing


def _auth_transition_endpoints_complete(history: list[Mapping[str, Any]]) -> bool:
    for transition in history:
        has_from = bool(
            transition.get("from_auth_state")
            or transition.get("fromAuthState")
            or transition.get("from_auth_ui_state")
            or transition.get("fromAuthUiState")
        )
        has_to = bool(
            transition.get("to_auth_state")
            or transition.get("toAuthState")
            or transition.get("to_auth_ui_state")
            or transition.get("toAuthUiState")
        )
        if not has_from or not has_to:
            return False
    return True


def _live_inspection_required(
    code: str,
    scope: FailureScope,
    confidence: Confidence,
    root_cause_unknown: bool,
    missing_evidence: list[str],
) -> bool:
    if root_cause_unknown and missing_evidence:
        return True
    if code == "auth_create_account_to_signin_sink":
        return False
    if code in {"auth_primary_action_not_found", "auth_signup_signin_loop"}:
        return False
    if code == "auth_captcha_gate":
        return bool(missing_evidence)
    if code in _AUTH_CYCLE_CODES:
        return bool(missing_evidence)
    if code == "application_fields_not_ready_after_auth":
        return True
    if code == "no_safe_next_button":
        return True
    if code == "workday_runtime_not_ready":
        return True
    if scope in {"setup", "control_plane", "external_server"} and confidence != "unknown":
        return False
    return confidence == "unknown" or bool(
        {"causal_element", "stable_causal_identity"}.intersection(missing_evidence)
    )


def _summary_for(code: str, scope: FailureScope) -> str:
    summaries = {
        "credential_rejected": (
            "The site explicitly rejected the credentials or reported that the account might be locked."
        ),
        "maintenance": "The site explicitly reported a maintenance or unavailable state.",
        "job_unavailable": "The site explicitly reported that the requested job was unavailable.",
        "unclassified_failure": (
            "C3 recorded a failure but did not assert a diagnosis; use the retained observations."
        ),
        "auth_create_account_to_signin_sink": (
            "Create Account returned to Sign In without reaching verification or application fields."
        ),
        "application_fields_not_ready_after_auth": (
            "The authentication action did not reach a verified application surface."
        ),
        "auth_primary_action_not_found": (
            "No safe primary authentication action was selected from the current page."
        ),
        "auth_captcha_gate": "A site captcha gate blocked authentication progress.",
        "auth_signup_signin_loop": (
            "Authentication repeated the signup-to-signin transition within one run."
        ),
        "auth_ui_cycle_detected": "Authentication entered a repeated UI control loop.",
        "resume_upload_missing_data": (
            "Required resume upload could not proceed because resume data was unavailable."
        ),
        "workday_commit_not_verified": (
            "Workday interaction completed without verifiable backing-state commit."
        ),
        "control_plane_cancel_unreconciled": (
            "Cooperative cancellation did not reach a reconciled terminal state."
        ),
        "no_safe_next_button": (
            "No safe Next or Continue control was available on the current page."
        ),
        "workday_runtime_not_ready": (
            "Workday runtime did not expose a usable page surface within the readiness budget."
        ),
        "required_field_uncommitted": (
            "A directly observed required field remained empty and blocked page advancement; "
            "the lower-level commit mechanism was not established."
        ),
    }
    if code in _EVIDENCE_GATED_AUTH_CYCLE_CODES and scope == "navigation":
        return "Authentication remained in an active control loop until the flow limit."
    return summaries.get(
        code,
        f"{scope.replace('_', ' ').title()} failure recorded as {code}.",
    )


def _next_safe_action_for(code: str, scope: FailureScope) -> str:
    actions = {
        "credential_rejected": "verify_credentials_or_account_state",
        "maintenance": "retry_after_maintenance",
        "job_unavailable": "find_current_job_posting",
        "unclassified_failure": "diagnose_from_retained_evidence",
        "auth_create_account_to_signin_sink": "record_auth_sink_and_try_next_job",
        "application_fields_not_ready_after_auth": "inspect_post_auth_readiness_evidence",
        "auth_primary_action_not_found": "retry_stable_auth_gateway_candidate",
        "auth_captcha_gate": "stop_for_site_auth_gate",
        "auth_signup_signin_loop": "stop_repeated_auth_transition",
        "auth_ui_cycle_detected": "stop_repeated_auth_ui_cycle",
        "resume_upload_missing_data": "seed_default_resume_and_retry_fresh_lane",
        "workday_commit_not_verified": "retry_owned_field_with_commit_checkpoint",
        "control_plane_cancel_unreconciled": "reconcile_backend_cancellation_without_page_mutation",
        "no_safe_next_button": "inspect_page_readiness_without_mutation",
        "workday_runtime_not_ready": "retry_workday_runtime_readiness_without_mutation",
        "required_field_uncommitted": "request_manual_completion_for_required_field",
    }
    if code in actions:
        return actions[code]
    if code in _EVIDENCE_GATED_AUTH_CYCLE_CODES and scope == "navigation":
        return "stop_active_auth_loop"
    if scope == "unknown":
        return "inspect_missing_evidence_then_use_live_inspection"
    return "inspect_retained_failure_context"


def _ruled_out_for(code: str) -> list[str]:
    if code == "resume_upload_missing_data":
        return ["ui_element_missing", "final_submit_block"]
    if code == "auth_create_account_to_signin_sink":
        return ["page_stall", "final_submit_block"]
    if code == "control_plane_cancel_unreconciled":
        return ["causal_ui_element"]
    return []


def _monitor_summary(events: list[dict[str, Any]]) -> C3MonitorSummary:
    summary: dict[str, Any] = {
        "health_probe_failure_count": 0,
        "progress_probe_failure_count": 0,
        "monitor_failure_count": 0,
        "artifact_capture_failure_count": 0,
        "cancel_failure_count": 0,
        "last_error_code": "",
    }
    event_to_count = {
        "operation.health_probe_failed": "health_probe_failure_count",
        "operation.progress_probe_failed": "progress_probe_failure_count",
        "operation.monitor_failed": "monitor_failure_count",
        "operation.artifact_capture_failed": "artifact_capture_failure_count",
        "operation.cancel_failed": "cancel_failure_count",
    }
    for event in events:
        event_type = _event_type(event)
        count_key = event_to_count.get(event_type)
        if count_key:
            summary[count_key] += 1
            codes = _code_candidates(_payload(event))
            if codes:
                summary["last_error_code"] = max(codes, key=lambda item: item[0])[1]
            else:
                diagnostics, _ = _diagnostic_messages_from_events([event])
                if diagnostics:
                    summary["last_error_code"] = _normalize_code(diagnostics[0])
    return C3MonitorSummary.model_validate(summary)


def _collect_artifact_ids(
    operation: Mapping[str, Any],
    events: list[dict[str, Any]],
    artifact_ids: Iterable[Any],
) -> tuple[list[str], bool]:
    result = _OrderedCollector(_MAX_ARTIFACT_IDS)
    traversal_report = _TraversalReport()
    result.extend(_string_list(operation.get("artifact_ids", []), traversal_report))
    result.extend(_string_list(artifact_ids, traversal_report))
    for event in events:
        if _event_type(event).startswith("operation.artifact_"):
            payload = _payload(event)
            result.extend(
                _string_list(
                    _find_values(
                        payload, {"artifact_id", "artifactid", "artifact_ids", "artifactids"}
                    ),
                    traversal_report,
                ),
            )
    return result.values, result.truncated or traversal_report.truncated


def _artifact_status(events: list[dict[str, Any]], artifact_ids: list[str]) -> ArtifactStatus:
    status: ArtifactStatus = "completed" if artifact_ids else "idle"
    has_artifacts = bool(artifact_ids)
    for event in events:
        event_type = _event_type(event)
        payload = _payload(event)
        explicit = str(payload.get("artifact_status") or payload.get("capture_state") or "").lower()
        if explicit in {"idle", "capturing", "partial", "completed", "failed"}:
            status = explicit  # type: ignore[assignment]
        if event_type in {
            "operation.artifact_capture_started",
            "operation.artifact_capture_timeout",
        }:
            status = "capturing"
        elif event_type in {
            "operation.artifact_capture_partial",
            "operation.artifact_partial",
        }:
            status = "partial"
        elif event_type == "operation.artifact_capture_failed":
            status = "partial" if has_artifacts else "failed"
        elif event_type in {
            "operation.artifact_captured",
            "operation.artifact_capture_completed",
        }:
            status = "completed"
        if _string_list(
            _find_values(
                payload,
                {"artifact_id", "artifactid", "artifact_ids", "artifactids"},
            )
        ):
            has_artifacts = True
    return status


def _payload(event: Mapping[str, Any]) -> dict[str, Any]:
    value = event.get("payload")
    return dict(value) if isinstance(value, Mapping) else {}


def _event_type(event: Mapping[str, Any] | None) -> str:
    return str((event or {}).get("event_type") or "")


def _event_id(event: Mapping[str, Any] | None) -> str:
    return _safe_identifier((event or {}).get("event_id") or "")


def _event_seq(event: Mapping[str, Any] | None) -> int:
    try:
        return int((event or {}).get("seq") or 0)
    except (TypeError, ValueError):
        return 0


def _first_mapping(value: Any, names: set[str]) -> Mapping[str, Any] | None:
    for found in _find_values(value, names):
        if isinstance(found, Mapping):
            return found
    return None


def _first_value(value: Any, names: set[str]) -> Any:
    found = _find_values(value, names)
    return found[0] if found else None


def _find_values(value: Any, names: set[str]) -> list[Any]:
    found: list[Any] = []
    normalized_names = {_snake_key(name) for name in names}
    for key, current in _bounded_walk(value):
        if key in normalized_names:
            found.append(current)
    return found


def _string_list(value: Any, report: _TraversalReport | None = None) -> list[str]:
    result = _OrderedCollector(_MAX_GENERIC_LIST_ITEMS)
    for _, current in _bounded_walk(value, report):
        if isinstance(current, (Mapping, list, tuple, set, frozenset)):
            continue
        if str(current or "").strip():
            result.add(_safe_identifier(current))
    return result.values


def _safe_text_list(values: list[Any]) -> list[str]:
    result = _OrderedCollector(_MAX_GENERIC_LIST_ITEMS)
    for value in values:
        for item in value if isinstance(value, (list, tuple)) else [value]:
            text = _safe_text(item, limit=300)
            if text:
                result.add(text)
    return result.values


def _safe_identifier(value: Any) -> str:
    raw = str(value or "").strip()[:200]
    if is_trusted_generated_c3_id(raw):
        return raw
    text = _safe_text(raw, limit=200)
    return re.sub(r"[^A-Za-z0-9_.:-]+", "-", text).strip("-")


def _restore_internal_identifier_fields(
    safe: Mapping[str, Any],
    raw: Mapping[str, Any],
) -> dict[str, Any]:
    restored = dict(safe)
    for field in (
        "diagnosis_id",
        "operation_id",
        "authoritative_event_id",
    ):
        value = raw.get(field)
        if is_trusted_generated_c3_id(value):
            restored[field] = value
    for field in ("evidence_event_ids", "checkpoint_ids", "artifact_ids"):
        values = raw.get(field)
        safe_values = restored.get(field)
        if not isinstance(values, list) or not isinstance(safe_values, list):
            continue
        restored[field] = [
            value if is_trusted_generated_c3_id(value) else safe_values[index]
            for index, value in enumerate(values[: len(safe_values)])
        ]
    return restored


def _safe_text(value: Any, *, limit: int) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if text.startswith(("http://", "https://")):
        parsed = urlsplit(text)
        text = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    text = _SENSITIVE_ASSIGNMENT_RE.sub(lambda match: f"{match.group(1)}={REDACTED}", text)
    safe, _ = redact_payload({"field_text": text[:limit]})
    return str(safe["field_text"])


def _safe_action(value: Any) -> str:
    parts = str(value or "").strip().lower().split(maxsplit=1)
    if not parts:
        return ""
    action = parts[0]
    return action if action in _SAFE_ACTIONS else ""


def _collect_sensitive_values(events: Iterable[Mapping[str, Any]]) -> set[str]:
    values: set[str] = set()
    for event in events:
        for key, current in _bounded_walk(_payload(event)):
            if _SENSITIVE_VALUE_KEY_RE.search(key) and isinstance(current, str):
                text = current.strip()
                if text and text != REDACTED:
                    values.add(text)
    return values


def _redact_structural_values(value: Any, sensitive_values: set[str]) -> Any:
    serialized = json.dumps(value, ensure_ascii=False)
    encoded_redaction = json.dumps(REDACTED, ensure_ascii=False)[1:-1]
    for sensitive in sorted(sensitive_values, key=len, reverse=True):
        encoded_sensitive = json.dumps(sensitive, ensure_ascii=False)[1:-1]
        serialized = serialized.replace(encoded_sensitive, encoded_redaction)
    return json.loads(serialized)


def _model_dump_or_none(model: BaseModel | None) -> dict[str, Any] | None:
    return model.model_dump(mode="python") if model is not None else None


def _snake_key(value: Any) -> str:
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(value or ""))
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
