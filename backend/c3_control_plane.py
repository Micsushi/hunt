from __future__ import annotations

import asyncio
import hashlib
import json
import re
import threading
from collections import deque
from collections.abc import Callable, Mapping
from itertools import islice
from typing import Annotated, Any
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from backend.browser_targets import get_browser_target_store
from backend.c3_artifacts import C3ArtifactStore
from backend.c3_browser_controls import (
    ALLOWED_ACTIONS,
    PROBE_MUTATION_ACTIONS,
    C3BrowserControlError,
    run_c3_browser_control,
)
from backend.c3_commands import get_c3_operation_manager
from backend.c3_failure_context import C3ElementEvidence, C3FailureContext
from backend.c3_identifiers import is_trusted_generated_c3_id
from backend.c3_probe_budgets import (
    ProbeBudgetExceeded,
    ProbeBudgetLimits,
    ProbeBudgetManager,
)
from backend.ledger.api import get_lease_store, require_ledger_access
from backend.ledger.models import Actor
from backend.ledger.redaction import redact_payload

router = APIRouter(prefix="/api/c3/control", tags=["c3-control"])
SAFE_ID = re.compile(r"^[A-Za-z0-9_.-]+$")
SAFE_FILE = re.compile(r"^[A-Za-z0-9_.-]+$")
SHA256_HEX = re.compile(r"^[0-9a-fA-F]{64}$")
BrowserControlRunner = Callable[..., dict[str, Any]]
FAILURE_EVIDENCE_TAIL_LIMIT = 16
FAILURE_EVENT_SCAN_LIMIT = 256
FAILURE_ARTIFACT_LIMIT = 32
FAILURE_ARTIFACT_FILE_LIMIT = 32
FAILURE_PAYLOAD_NODE_LIMIT = 256
FAILURE_PAYLOAD_DEPTH_LIMIT = 8
FAILURE_PAYLOAD_WIDTH_LIMIT = 64
FAILURE_PAYLOAD_VALUES_PER_KEY = 8
FAILURE_PAYLOAD_RETAINED_VALUES_LIMIT = 256
FAILURE_ARTIFACT_ID_SCAN_LIMIT = 256
FAILURE_IGNORED_PROJECTION_KEYS = {
    "auth_transition_history",
    "authtransitionhistory",
    "transition_history",
    "transitionhistory",
}
ARTIFACT_LIST_LIMIT = 32
ARTIFACT_LIST_SCAN_LIMIT = 40
SENSITIVE_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(password|passwd|pwd|token|secret|api[_-]?key|cookie|authorization|"
    r"address|answer|typed(?:_value)?|entered(?:_value)?)\b\s*[:=]\s*"
    r"(?:\"[^\"]*\"|'[^']*'|[^\r\n;]+)"
)


class DiagnosticRequest(BaseModel):
    operation_id: str = Field(min_length=1)
    agent_id: str = Field(min_length=1)
    lane_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    lease_id: str = Field(min_length=1)
    action: str = Field(min_length=1)
    options: dict[str, Any] = Field(default_factory=dict)


class ProbeBudgetCreateRequest(BaseModel):
    budget_id: str = Field(min_length=1)
    operation_id: str = Field(min_length=1)
    agent_id: str = Field(min_length=1)
    lane_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    lease_id: str = Field(min_length=1)
    attempts: int = Field(default=10, ge=1, le=100)
    mutations: int = Field(default=2, ge=0, le=10)
    wall_seconds: float = Field(default=60, gt=0, le=600)
    files: int = Field(default=5, ge=0, le=50)
    bytes: int = Field(default=1_000_000, ge=0, le=10_000_000)


class ProbeExecuteRequest(DiagnosticRequest):
    reason: str = Field(min_length=1)
    expected_predicate: str = Field(min_length=1)


class ProbeCommitRequest(BaseModel):
    operation_id: str = Field(min_length=1)
    agent_id: str = Field(min_length=1)
    lane_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    lease_id: str = Field(min_length=1)
    predicate: str = Field(min_length=1)
    observed: dict[str, Any] = Field(default_factory=dict)


class C3FailureEvidenceItem(BaseModel):
    """Small typed event projection; raw ledger payloads are never returned."""

    model_config = ConfigDict(extra="forbid", strict=True)

    seq: int = Field(ge=1)
    event_id: str = ""
    event_type: str = Field(min_length=1)
    ts: str = ""
    reason_code: str = ""
    action: str = ""
    element: C3ElementEvidence | None = None
    validation_messages: list[str] = Field(default_factory=list, max_length=32)
    navigation_from: str = ""
    navigation_to: str = ""


class C3ArtifactManifestSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    artifact_id: str = Field(min_length=1)
    status: str = ""
    kind: str = ""
    captured_at: str = ""
    files: list[str] = Field(default_factory=list, max_length=FAILURE_ARTIFACT_FILE_LIMIT)
    manifest_present: bool = False
    manifest_path: str = Field(default="", max_length=2_000)


class C3FailureContextResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    operation_id: str = Field(min_length=1)
    operation_state: str = Field(min_length=1)
    terminal: bool
    context: C3FailureContext
    action_tail: list[C3FailureEvidenceItem] = Field(
        default_factory=list, max_length=FAILURE_EVIDENCE_TAIL_LIMIT
    )
    validation_tail: list[C3FailureEvidenceItem] = Field(
        default_factory=list, max_length=FAILURE_EVIDENCE_TAIL_LIMIT
    )
    navigation_tail: list[C3FailureEvidenceItem] = Field(
        default_factory=list, max_length=FAILURE_EVIDENCE_TAIL_LIMIT
    )
    artifacts: list[C3ArtifactManifestSummary] = Field(
        default_factory=list, max_length=FAILURE_ARTIFACT_LIMIT
    )
    artifact_status: str
    source_event_sequence: int = Field(ge=0)
    evidence_truncated: bool = False


_budget_managers: dict[str, ProbeBudgetManager] = {}
_budget_lock = threading.Lock()


def get_browser_control_runner() -> BrowserControlRunner:
    def run(
        target: dict[str, Any],
        action: str,
        options: dict[str, Any],
        *,
        allow_probe_mutations: bool = False,
    ) -> dict[str, Any]:
        return asyncio.run(
            run_c3_browser_control(
                target,
                action,
                options,
                allow_probe_mutations=allow_probe_mutations,
            )
        )

    return run


def get_probe_budget_manager(manager=Depends(get_c3_operation_manager)) -> ProbeBudgetManager:
    key = str(manager.store.root.resolve())
    with _budget_lock:
        budgets = _budget_managers.get(key)
        if budgets is None:
            budgets = ProbeBudgetManager(
                storage_path=manager.store.root / "c3" / "probe_budgets.sqlite3"
            )
            _budget_managers[key] = budgets
        return budgets


@router.post("/diagnostics/run")
def run_diagnostic(
    body: DiagnosticRequest,
    _access: Annotated[None, Depends(require_ledger_access)],
    manager=Depends(get_c3_operation_manager),
    lease_store=Depends(get_lease_store),
    target_store=Depends(get_browser_target_store),
    control: BrowserControlRunner = Depends(get_browser_control_runner),
):
    if body.action not in ALLOWED_ACTIONS:
        raise HTTPException(400, detail={"reason_code": "diagnostic_action_not_allowed"})
    operation, target = _authorize_active(body, manager, lease_store, target_store)
    try:
        result = control(target, body.action, body.options, allow_probe_mutations=False)
    except C3BrowserControlError as exc:
        raise HTTPException(409, detail={"reason_code": str(exc)}) from exc
    if body.action in {"page_info", "target_health"}:
        observed_url = _safe_navigation_url(str(result.get("url") or ""))
        observed_url_sha256 = str(result.get("url_sha256") or "").strip()
        if not observed_url or SHA256_HEX.fullmatch(observed_url_sha256) is None:
            raise HTTPException(409, detail={"reason_code": "diagnostic_url_identity_invalid"})
        result = {
            **result,
            "url": observed_url,
            "url_sha256": observed_url_sha256.lower(),
        }
    manager.store.append(
        operation.operation_id,
        "diagnostic.executed",
        {"action": body.action, "ok": bool(result.get("ok", True))},
    )
    observed_url = _safe_navigation_url(str(result.get("url") or ""))
    observed_url_sha256 = str(result.get("url_sha256") or "").lower()
    previous_url = _safe_navigation_url(str(operation.target.get("url") or ""))
    previous_url_sha256 = str(operation.target.get("url_sha256") or "").lower()
    if observed_url and observed_url_sha256 and observed_url_sha256 != previous_url_sha256:
        manager.store.append(
            operation.operation_id,
            "navigation.observed",
            {
                "action": body.action,
                "from_url": previous_url,
                "to_url": observed_url,
                "url": observed_url,
                "url_sha256": observed_url_sha256,
            },
        )
    return {"operation_id": operation.operation_id, "action": body.action, "result": result}


@router.post("/probes")
def create_probe_budget(
    body: ProbeBudgetCreateRequest,
    _access: Annotated[None, Depends(require_ledger_access)],
    manager=Depends(get_c3_operation_manager),
    lease_store=Depends(get_lease_store),
    target_store=Depends(get_browser_target_store),
    budgets: ProbeBudgetManager = Depends(get_probe_budget_manager),
):
    operation, _target = _authorize_active(body, manager, lease_store, target_store)
    try:
        snapshot = budgets.create(
            budget_id=body.budget_id,
            agent_id=body.agent_id,
            session_id=body.session_id,
            lease_id=body.lease_id,
            operation_id=body.operation_id,
            limits=ProbeBudgetLimits(
                attempts=body.attempts,
                mutations=body.mutations,
                wall_seconds=body.wall_seconds,
                files=body.files,
                bytes=body.bytes,
            ),
        )
    except ValueError as exc:
        raise HTTPException(409, detail={"reason_code": str(exc)}) from exc
    manager.store.append(operation.operation_id, "probe.budget_created", snapshot)
    return snapshot


@router.post("/probes/{budget_id}/execute")
def execute_probe(
    budget_id: str,
    body: ProbeExecuteRequest,
    _access: Annotated[None, Depends(require_ledger_access)],
    manager=Depends(get_c3_operation_manager),
    lease_store=Depends(get_lease_store),
    target_store=Depends(get_browser_target_store),
    budgets: ProbeBudgetManager = Depends(get_probe_budget_manager),
    control: BrowserControlRunner = Depends(get_browser_control_runner),
):
    operation, target = _authorize_active(body, manager, lease_store, target_store)
    mutation_count = 1 if body.action in PROBE_MUTATION_ACTIONS else 0
    if mutation_count:
        _authorize_probe_mutation(operation, manager)
    file_count, byte_count = _probe_output_reservation(body.action)
    try:
        reservation = budgets.reserve(
            budget_id,
            agent_id=body.agent_id,
            session_id=body.session_id,
            lease_id=body.lease_id,
            operation_id=body.operation_id,
            action=body.action,
            reason=body.reason,
            expected_predicate=body.expected_predicate,
            mutation_count=mutation_count,
            file_count=file_count,
            byte_count=byte_count,
        )
    except (KeyError, ValueError, PermissionError, ProbeBudgetExceeded) as exc:
        raise HTTPException(409, detail={"reason_code": str(exc)}) from exc
    identity = {
        "agent_id": body.agent_id,
        "session_id": body.session_id,
        "lease_id": body.lease_id,
        "operation_id": body.operation_id,
    }

    def reject_probe(reason: str, details: dict[str, Any] | None = None) -> None:
        failed = budgets.fail(reservation.reservation_id, reason=reason, **identity)
        manager.store.append(
            operation.operation_id,
            "probe.failed",
            {
                "reservation_id": reservation.reservation_id,
                "status": failed["status"],
                "reason": reason,
                **(details or {}),
            },
        )
        raise HTTPException(409, detail={"reason_code": reason})

    try:
        manager.store.append(
            operation.operation_id,
            "probe.reserved",
            {"reservation_id": reservation.reservation_id, "action": body.action},
        )
    except Exception as exc:
        budgets.abort(
            reservation.reservation_id,
            reason="probe_reservation_audit_failed",
            **identity,
        )
        raise HTTPException(409, detail={"reason_code": "probe_reservation_audit_failed"}) from exc
    try:
        before = None
        if mutation_count:
            before = control(
                target,
                "popup_ownership",
                _popup_ownership_options(body.action, body.options),
                allow_probe_mutations=False,
            )
        result = control(
            target,
            body.action,
            body.options,
            allow_probe_mutations=bool(mutation_count),
        )
        if result.get("ok") is False:
            reject_probe(str(result.get("reason") or "probe_failed"))
        after = None
        if mutation_count:
            after = control(
                target,
                "popup_ownership",
                _popup_ownership_options(body.action, body.options),
                allow_probe_mutations=False,
            )
        output_bytes = len(
            json.dumps(
                {"before": before, "observed": result, "after": after},
                ensure_ascii=False,
                default=str,
            ).encode("utf-8")
        )
        if output_bytes > byte_count:
            reject_probe(
                "probe_output_bytes_exceeded",
                {"output_bytes": output_bytes, "reserved_bytes": byte_count},
            )
        if not _probe_predicate_passed(body.action, before, result, after):
            reject_probe("probe_predicate_not_satisfied")
        committed = budgets.commit(
            reservation.reservation_id,
            proof={
                "predicate": body.expected_predicate,
                "passed": True,
            },
            **identity,
        )
    except HTTPException:
        raise
    except C3BrowserControlError as exc:
        reject_probe(str(exc))
    except Exception as exc:
        reject_probe("probe_execution_failed", {"error_type": type(exc).__name__})
    manager.store.append(operation.operation_id, "probe.committed", committed)
    response_result = _structural_mutation_probe_result(body, result) if mutation_count else result
    return {"reservation": committed, "result": response_result}


@router.post("/probes/reservations/{reservation_id}/commit")
def commit_probe(
    reservation_id: str,
    body: ProbeCommitRequest,
    _access: Annotated[None, Depends(require_ledger_access)],
    manager=Depends(get_c3_operation_manager),
    lease_store=Depends(get_lease_store),
    target_store=Depends(get_browser_target_store),
    budgets: ProbeBudgetManager = Depends(get_probe_budget_manager),
):
    operation, _target = _authorize_active(body, manager, lease_store, target_store)
    if body.observed.get("passed") is not True:
        raise HTTPException(409, detail={"reason_code": "probe_proof_not_satisfied"})
    try:
        committed = budgets.commit(
            reservation_id,
            proof={"predicate": body.predicate, "passed": True},
            agent_id=body.agent_id,
            session_id=body.session_id,
            lease_id=body.lease_id,
            operation_id=body.operation_id,
        )
    except (KeyError, ValueError, PermissionError) as exc:
        raise HTTPException(409, detail={"reason_code": str(exc)}) from exc
    manager.store.append(operation.operation_id, "probe.committed", committed)
    return committed


@router.get(
    "/operations/{operation_id}/failure-context",
    response_model=C3FailureContextResponse,
)
def get_operation_failure_context(
    operation_id: str,
    agent_id: str = Query(min_length=1),
    lease_id: str = Query(min_length=1),
    _access: None = Depends(require_ledger_access),
    manager=Depends(get_c3_operation_manager),
) -> C3FailureContextResponse:
    """Return retained failure evidence without requiring a currently active lease."""

    operation = _authorize_read(operation_id, agent_id, lease_id, manager)
    if not operation.terminal:
        raise HTTPException(
            409,
            detail={
                "reason_code": "failure_context_not_terminal",
                "operation_id": operation.operation_id,
                "state": str(operation.state),
            },
        )
    try:
        context = manager.store.get_failure_context(operation.operation_id)
    except ValueError as exc:
        raise HTTPException(
            409,
            detail={
                "reason_code": "failure_context_unavailable",
                "operation_id": operation.operation_id,
            },
        ) from exc

    events, scan_truncated = _failure_evidence_events(manager.store, operation.operation_id)
    action_tail: deque[C3FailureEvidenceItem] = deque(maxlen=FAILURE_EVIDENCE_TAIL_LIMIT)
    validation_tail: deque[C3FailureEvidenceItem] = deque(maxlen=FAILURE_EVIDENCE_TAIL_LIMIT)
    navigation_tail: deque[C3FailureEvidenceItem] = deque(maxlen=FAILURE_EVIDENCE_TAIL_LIMIT)
    category_counts = {"action": 0, "validation": 0, "navigation": 0}
    payload_truncated = False
    for event in events:
        try:
            item, categories, event_payload_truncated = _project_failure_event(event)
        except Exception:
            payload_truncated = True
            continue
        payload_truncated = payload_truncated or event_payload_truncated
        if item is None:
            continue
        for category, tail in (
            ("action", action_tail),
            ("validation", validation_tail),
            ("navigation", navigation_tail),
        ):
            if category in categories:
                category_counts[category] += 1
                tail.append(item)

    artifacts, artifact_truncated = _failure_artifact_summaries(manager.store, operation, context)
    tail_truncated = any(count > FAILURE_EVIDENCE_TAIL_LIMIT for count in category_counts.values())
    return C3FailureContextResponse(
        operation_id=operation.operation_id,
        operation_state=str(operation.state),
        terminal=True,
        context=context,
        action_tail=list(action_tail),
        validation_tail=list(validation_tail),
        navigation_tail=list(navigation_tail),
        artifacts=artifacts,
        artifact_status=context.artifact_status,
        source_event_sequence=context.source_event_sequence,
        evidence_truncated=bool(
            context.evidence_truncated
            or scan_truncated
            or payload_truncated
            or tail_truncated
            or artifact_truncated
        ),
    )


@router.get("/operations/{operation_id}/artifacts")
def list_operation_artifacts(
    operation_id: str,
    agent_id: str = Query(min_length=1),
    lease_id: str = Query(min_length=1),
    _access: None = Depends(require_ledger_access),
    manager=Depends(get_c3_operation_manager),
):
    operation = _authorize_read(operation_id, agent_id, lease_id, manager)
    artifact_ids, truncated = _bounded_linked_artifact_ids(operation.artifact_ids)
    artifact_store = C3ArtifactStore(manager.store.root)
    operation_directory = manager.store.operation_directory(operation.operation_id)
    summaries: list[dict[str, Any]] = []
    for artifact_id in artifact_ids:
        if not SAFE_ID.fullmatch(artifact_id) or artifact_id in {".", ".."}:
            truncated = True
            continue
        try:
            manifest = artifact_store.validate_failure_bundle(
                session_id=operation.session_id,
                operation_id=operation.operation_id,
                artifact_id=artifact_id,
                operation_directory=operation_directory,
            )
        except ValueError:
            summaries.append(
                {
                    "artifact_id": artifact_id,
                    "status": "invalid",
                    "kind": "failure_bundle",
                    "captured_at": "",
                    "files": [],
                    "manifest_present": False,
                }
            )
            truncated = True
            continue
        files = [
            str(entry.get("name") or "")
            for entry in manifest["files"]
            if isinstance(entry, Mapping) and SAFE_FILE.fullmatch(str(entry.get("name") or ""))
        ]
        summaries.append(
            {
                "artifact_id": artifact_id,
                "status": "completed",
                "kind": "failure_bundle",
                "captured_at": _safe_failure_text(manifest.get("created_at"), 80),
                "files": files[:FAILURE_ARTIFACT_FILE_LIMIT],
                "manifest_present": True,
            }
        )
    return {
        "operation_id": operation.operation_id,
        "artifacts": summaries,
        "truncated": truncated,
    }


@router.get("/operations/{operation_id}/artifacts/{artifact_id}/files/{filename}")
def get_operation_artifact_file(
    operation_id: str,
    artifact_id: str,
    filename: str,
    agent_id: str = Query(min_length=1),
    lease_id: str = Query(min_length=1),
    _access: None = Depends(require_ledger_access),
    manager=Depends(get_c3_operation_manager),
):
    operation = _authorize_read(operation_id, agent_id, lease_id, manager)
    if (
        not SAFE_ID.fullmatch(artifact_id)
        or not SAFE_FILE.fullmatch(filename)
        or artifact_id in {".", ".."}
        or filename in {".", ".."}
    ):
        raise HTTPException(400, detail={"reason_code": "unsafe_artifact_path"})
    linked_ids = operation.artifact_ids
    if not isinstance(linked_ids, (list, tuple)) or artifact_id not in linked_ids:
        raise HTTPException(404, detail={"reason_code": "artifact_not_linked"})
    root = manager.store.operation_directory(operation.operation_id).resolve()
    try:
        manifest = C3ArtifactStore(manager.store.root).validate_failure_bundle(
            session_id=operation.session_id,
            operation_id=operation.operation_id,
            artifact_id=artifact_id,
            operation_directory=root,
        )
    except ValueError as exc:
        raise HTTPException(409, detail={"reason_code": "artifact_invalid"}) from exc
    declared_files = {
        str(entry.get("name") or "") for entry in manifest["files"] if isinstance(entry, Mapping)
    }
    if filename not in declared_files:
        raise HTTPException(404, detail={"reason_code": "artifact_file_not_found"})
    path = (root / "artifacts" / artifact_id / filename).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise HTTPException(400, detail={"reason_code": "unsafe_artifact_path"}) from exc
    if not path.is_file():
        raise HTTPException(404, detail={"reason_code": "artifact_file_not_found"})
    return FileResponse(path)


def _failure_evidence_events(store: Any, operation_id: str) -> tuple[list[Any], bool]:
    tail_reader = getattr(store, "tail_events", None)
    source: Any
    source_truncated = False
    if callable(tail_reader):
        result = tail_reader(operation_id, limit=FAILURE_EVENT_SCAN_LIMIT)
        if isinstance(result, tuple) and len(result) == 2:
            source, source_truncated = result
        else:
            source = result
            source_truncated = True
    else:
        reader = getattr(store, "events", None)
        source = (
            reader(operation_id)
            if callable(reader)
            else getattr(store, "failure_evidence_events", [])
        )
    try:
        iterator = iter(source)
    except TypeError:
        return [], True
    retained: list[Any] = []
    source_failed = False
    for _index in range(FAILURE_EVENT_SCAN_LIMIT + 1):
        try:
            retained.append(next(iterator))
        except StopIteration:
            break
        except Exception:
            source_failed = True
            break
    overflow = len(retained) > FAILURE_EVENT_SCAN_LIMIT
    if overflow:
        retained = retained[-FAILURE_EVENT_SCAN_LIMIT:]
    return retained, bool(source_truncated or source_failed or overflow)


def _project_failure_event(event: Any) -> tuple[C3FailureEvidenceItem | None, set[str], bool]:
    if isinstance(event, Mapping):
        row = event
    elif hasattr(event, "model_dump"):
        row = event.model_dump(mode="python")
    else:
        try:
            row = vars(event)
        except TypeError:
            return None, set(), True
    if not isinstance(row, Mapping):
        return None, set(), True
    seq = row.get("seq")
    if isinstance(seq, bool) or not isinstance(seq, int) or seq <= 0:
        return None, set(), True
    payload = row.get("payload") if isinstance(row.get("payload"), Mapping) else {}
    values, payload_truncated = _bounded_payload_values(payload)
    event_type = _safe_failure_text(row.get("event_type"), 120)
    if not event_type:
        return None, set(), True
    action = _first_text(values, ("action", "interaction", "command"), limit=80)
    reason_code = _first_text(
        values,
        ("root_cause_code", "reason_code", "error_code", "stopped_reason"),
        limit=120,
    )
    element = _project_failure_element(values)
    validation_messages, validation_truncated = _validation_messages(values)
    navigation_from = _safe_navigation_url(
        _first_text(values, ("from_url", "previous_url", "source_url"), limit=2_000)
    )
    navigation_to = _safe_navigation_url(
        _first_text(values, ("to_url", "next_url", "current_url", "url"), limit=2_000)
    )

    lowered = event_type.lower()
    categories: set[str] = set()
    if (
        action
        or element is not None
        or any(
            token in lowered
            for token in ("action", "click", "fill", "select", "type", "checkpoint")
        )
    ):
        categories.add("action")
    if validation_messages or "validation" in lowered:
        categories.add("validation")
    if (
        navigation_from
        or navigation_to
        or any(
            token in lowered for token in ("navigation", "navigate", "page_transition", "redirect")
        )
    ):
        categories.add("navigation")
    if not categories:
        return None, set(), payload_truncated or validation_truncated
    return (
        C3FailureEvidenceItem(
            seq=seq,
            event_id=_safe_failure_identifier(row.get("event_id"), 160),
            event_type=event_type,
            ts=_safe_failure_text(row.get("ts"), 80),
            reason_code=reason_code,
            action=action,
            element=element,
            validation_messages=validation_messages,
            navigation_from=navigation_from,
            navigation_to=navigation_to,
        ),
        categories,
        payload_truncated or validation_truncated,
    )


def _bounded_payload_values(payload: Mapping[str, Any]) -> tuple[dict[str, list[Any]], bool]:
    values: dict[str, list[Any]] = {}
    stack: list[tuple[Any, str, int, frozenset[int]]] = [(payload, "", 0, frozenset())]
    visited = 0
    retained_values = 0
    truncated = False
    while stack:
        current, key, depth, ancestors = stack.pop()
        visited += 1
        if visited > FAILURE_PAYLOAD_NODE_LIMIT:
            truncated = True
            break
        if key:
            bucket = values.setdefault(key, [])
            if (
                len(bucket) < FAILURE_PAYLOAD_VALUES_PER_KEY
                and retained_values < FAILURE_PAYLOAD_RETAINED_VALUES_LIMIT
            ):
                bucket.append(current)
                retained_values += 1
            else:
                truncated = True
        if key in FAILURE_IGNORED_PROJECTION_KEYS:
            continue
        if depth > FAILURE_PAYLOAD_DEPTH_LIMIT:
            truncated = True
            continue
        if isinstance(current, Mapping):
            object_id = id(current)
            if object_id in ancestors:
                truncated = True
                continue
            next_ancestors = ancestors | {object_id}
            child_keys = list(islice(iter(current), FAILURE_PAYLOAD_WIDTH_LIMIT + 1))
            if len(child_keys) > FAILURE_PAYLOAD_WIDTH_LIMIT:
                truncated = True
                child_keys = child_keys[:FAILURE_PAYLOAD_WIDTH_LIMIT]
            for child_key in reversed(child_keys):
                normalized = str(child_key).strip().lower().replace("-", "_")[:120]
                try:
                    value = current[child_key]
                except Exception:
                    truncated = True
                    continue
                stack.append((value, normalized, depth + 1, next_ancestors))
        elif isinstance(current, (list, tuple)):
            object_id = id(current)
            if object_id in ancestors:
                truncated = True
                continue
            next_ancestors = ancestors | {object_id}
            children = list(islice(iter(current), FAILURE_PAYLOAD_WIDTH_LIMIT + 1))
            if len(children) > FAILURE_PAYLOAD_WIDTH_LIMIT:
                truncated = True
                children = children[:FAILURE_PAYLOAD_WIDTH_LIMIT]
            for value in reversed(children):
                stack.append((value, key, depth + 1, next_ancestors))
    return values, truncated


def _first_text(values: dict[str, list[Any]], keys: tuple[str, ...], *, limit: int) -> str:
    for key in keys:
        for value in values.get(key, []):
            if isinstance(value, (str, int, float)) and not isinstance(value, bool):
                text = _safe_failure_text(value, limit)
                if text:
                    return text
    return ""


def _validation_messages(values: dict[str, list[Any]]) -> tuple[list[str], bool]:
    messages: list[str] = []
    truncated = False
    for key in ("validation_messages", "validation_message", "field_errors", "errors"):
        for value in values.get(key, []):
            candidates, candidates_truncated = _bounded_validation_candidates(value)
            truncated = truncated or candidates_truncated
            for candidate in candidates:
                if isinstance(candidate, Mapping):
                    candidate = candidate.get("message") or candidate.get("text") or ""
                text = _safe_failure_text(candidate, 300)
                if text and text not in messages:
                    if len(messages) < 32:
                        messages.append(text)
                    else:
                        truncated = True
    return messages, truncated


def _bounded_validation_candidates(value: Any) -> tuple[list[Any], bool]:
    if isinstance(value, (str, bytes, bytearray, Mapping)):
        return [value], False
    try:
        iterator = iter(value)
    except TypeError:
        return [value], False
    candidates: list[Any] = []
    failed = False
    for _index in range(FAILURE_PAYLOAD_WIDTH_LIMIT + 1):
        try:
            candidates.append(next(iterator))
        except StopIteration:
            break
        except Exception:
            failed = True
            break
    overflow = len(candidates) > FAILURE_PAYLOAD_WIDTH_LIMIT
    return candidates[:FAILURE_PAYLOAD_WIDTH_LIMIT], failed or overflow


def _project_failure_element(values: dict[str, list[Any]]) -> C3ElementEvidence | None:
    candidates: list[Mapping[str, Any]] = []
    for key in ("causal_element", "last_touched_element", "element", "field", "target"):
        candidates.extend(value for value in values.get(key, []) if isinstance(value, Mapping))
    if not candidates:
        selector = _first_text(values, ("selector",), limit=300)
        label = _first_text(values, ("label", "field_label"), limit=300)
        if not selector and not label:
            return None
        candidates = [{"selector": selector, "label": label}]
    source = candidates[0]
    allowed = {
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
        "frame_id",
        "document_id",
        "action",
        "checkpoint_id",
        "bounding_box",
    }
    projected = {key: source[key] for key in allowed if key in source}
    try:
        return C3ElementEvidence.model_validate(projected)
    except ValueError:
        return None


def _failure_artifact_summaries(
    store: Any, operation: Any, context: C3FailureContext
) -> tuple[list[C3ArtifactManifestSummary], bool]:
    artifact_ids: list[str] = []
    seen: set[str] = set()
    scanned = 0
    truncated = False
    for source in (context.artifact_ids, operation.artifact_ids):
        candidates = [source] if isinstance(source, str) else source
        try:
            iterator = iter(candidates)
        except TypeError:
            truncated = True
            continue
        while True:
            try:
                candidate = next(iterator)
            except StopIteration:
                break
            except Exception:
                truncated = True
                break
            scanned += 1
            if scanned > FAILURE_ARTIFACT_ID_SCAN_LIMIT:
                truncated = True
                break
            artifact_id = str(candidate)
            if artifact_id in seen:
                continue
            seen.add(artifact_id)
            artifact_ids.append(artifact_id)
            if len(artifact_ids) > FAILURE_ARTIFACT_LIMIT:
                truncated = True
                break
        if truncated and (
            len(artifact_ids) > FAILURE_ARTIFACT_LIMIT or scanned > FAILURE_ARTIFACT_ID_SCAN_LIMIT
        ):
            break
    summaries: list[C3ArtifactManifestSummary] = []
    operation_root = store.operation_directory(operation.operation_id).resolve()
    artifact_store = C3ArtifactStore(store.root)
    for artifact_id in artifact_ids[:FAILURE_ARTIFACT_LIMIT]:
        if not SAFE_ID.fullmatch(artifact_id) or artifact_id in {".", ".."}:
            truncated = True
            continue
        try:
            manifest = artifact_store.validate_failure_bundle(
                session_id=operation.session_id,
                operation_id=operation.operation_id,
                artifact_id=artifact_id,
                operation_directory=operation_root,
            )
        except ValueError as exc:
            reason = str(exc)
            summaries.append(
                C3ArtifactManifestSummary(
                    artifact_id=artifact_id,
                    status="unsafe_path" if reason == "unsafe_artifact_path" else "invalid",
                    manifest_present=False,
                )
            )
            truncated = True
            continue
        files, files_truncated = _artifact_filenames(manifest.get("files"))
        truncated = truncated or files_truncated
        summaries.append(
            C3ArtifactManifestSummary(
                artifact_id=artifact_id,
                status="completed",
                kind="failure_bundle",
                captured_at=_safe_failure_text(manifest.get("created_at"), 80),
                files=sorted(files),
                manifest_present=True,
                manifest_path=str(
                    (operation_root / "artifacts" / artifact_id / "manifest.json").resolve()
                ),
            )
        )
    return summaries, truncated


def _artifact_filenames(value: Any) -> tuple[list[str], bool]:
    if not isinstance(value, (list, tuple)):
        return [], False
    files: list[str] = []
    for item in value[: FAILURE_ARTIFACT_FILE_LIMIT + 1]:
        if isinstance(item, Mapping):
            item = item.get("filename") or item.get("name") or item.get("path") or ""
        name = _safe_failure_text(str(item).replace("\\", "/").rsplit("/", 1)[-1], 200)
        if SAFE_FILE.fullmatch(name) and name not in {".", ".."} and name not in files:
            files.append(name)
        if len(files) >= FAILURE_ARTIFACT_FILE_LIMIT:
            break
    return files, len(value) > FAILURE_ARTIFACT_FILE_LIMIT


def _safe_failure_text(value: Any, limit: int) -> str:
    if value is None or isinstance(value, (Mapping, list, tuple, set)):
        return ""
    text = str(value).replace("\x00", "").strip()
    # Reuse the ledger's redaction rules for emails, phones, and verification codes.
    safe, _info = redact_payload({"value": text})
    structurally_safe = SENSITIVE_ASSIGNMENT_RE.sub(
        lambda match: f"{match.group(1)}=[REDACTED]", str(safe["value"])
    )
    return structurally_safe[:limit]


def _safe_failure_identifier(value: Any, limit: int) -> str:
    raw = str(value or "").replace("\x00", "").strip()
    if is_trusted_generated_c3_id(raw):
        return raw[:limit]
    return _safe_failure_text(raw, limit)


def _safe_navigation_url(value: str) -> str:
    if not value:
        return ""
    try:
        parts = urlsplit(value)
    except ValueError:
        return ""
    if parts.scheme and parts.netloc:
        return _safe_failure_text(urlunsplit((parts.scheme, parts.netloc, parts.path, "", "")), 500)
    return _safe_failure_text(parts.path, 500)


def _authorize_active(body: Any, manager: Any, lease_store: Any, target_store: Any):
    operation = _authorize_read(body.operation_id, body.agent_id, body.lease_id, manager)
    if operation.lane_id != body.lane_id or operation.session_id != body.session_id:
        raise HTTPException(403, detail={"reason_code": "operation_identity_mismatch"})
    actor = Actor(type="agent", id=body.agent_id, surface="mcp")
    try:
        lease = lease_store.require_mutation_lease(body.session_id, actor, body.lease_id)
    except Exception as exc:
        raise HTTPException(409, detail={"reason_code": "missing_lease"}) from exc
    if lease is None or lease.lane_id != body.lane_id:
        raise HTTPException(409, detail={"reason_code": "missing_lease"})
    target_record = target_store.get(body.session_id)
    if (
        target_record is None
        or target_record.agent_id != body.agent_id
        or target_record.lane_id != body.lane_id
    ):
        raise HTTPException(409, detail={"reason_code": "browser_target_mismatch"})
    current_target = target_record.as_response()
    current_metadata = (
        current_target.get("metadata") if isinstance(current_target.get("metadata"), dict) else {}
    )
    current_target_id = str(
        current_target.get("target_id") or current_metadata.get("target_id") or ""
    )
    current_url = str(current_target.get("url") or "").strip()
    pinned_target = operation.target if isinstance(operation.target, dict) else {}
    current_pin = {
        "browser_kind": current_target.get("browser_kind"),
        "debug_port": current_target.get("debug_port"),
        "extension_id": current_target.get("extension_id"),
        "options_url": current_target.get("options_url"),
        "tab_id": current_target.get("tab_id"),
        "target_id": current_target_id,
    }
    required_identity = ("browser_kind", "debug_port", "extension_id", "tab_id", "target_id")
    if (
        any(pinned_target.get(key) in (None, "") for key in required_identity)
        or not str(pinned_target.get("url") or "").strip()
        or not str(pinned_target.get("url_sha256") or "").strip()
        or any(current_pin.get(key) in (None, "") for key in required_identity)
        or not current_url
    ):
        raise HTTPException(409, detail={"reason_code": "browser_target_exact_identity_missing"})
    pinned_url = str(pinned_target["url"]).strip()
    if pinned_target["url_sha256"] != hashlib.sha256(pinned_url.encode("utf-8")).hexdigest():
        raise HTTPException(409, detail={"reason_code": "browser_target_version_mismatch"})
    if any(
        pinned_target.get(key) != current_pin.get(key)
        for key in current_pin
        if key in required_identity or pinned_target.get(key) not in (None, "")
    ):
        raise HTTPException(409, detail={"reason_code": "browser_target_version_mismatch"})
    return operation, {
        **pinned_target,
        "target_id": current_target_id,
        "url": current_url,
        "url_sha256": hashlib.sha256(current_url.encode("utf-8")).hexdigest(),
    }


def _bounded_linked_artifact_ids(value: Any) -> tuple[list[str], bool]:
    if isinstance(value, str):
        iterator = iter([value])
    else:
        try:
            iterator = iter(value)
        except TypeError:
            return [], True
    artifact_ids: list[str] = []
    seen: set[str] = set()
    truncated = False
    for _index in range(ARTIFACT_LIST_SCAN_LIMIT):
        try:
            candidate = next(iterator)
        except StopIteration:
            break
        except Exception:
            return artifact_ids, True
        artifact_id = str(candidate)
        if artifact_id in seen:
            continue
        seen.add(artifact_id)
        if len(artifact_ids) >= ARTIFACT_LIST_LIMIT:
            truncated = True
            break
        artifact_ids.append(artifact_id)
    else:
        truncated = True
    return artifact_ids, truncated


def _authorize_read(operation_id: str, agent_id: str, lease_id: str, manager: Any):
    try:
        operation = manager.get(operation_id)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, detail={"reason_code": "operation_not_found"}) from exc
    if operation.agent_id != agent_id or operation.lease_id != lease_id:
        raise HTTPException(403, detail={"reason_code": "operation_identity_mismatch"})
    return operation


def _authorize_probe_mutation(operation: Any, manager: Any) -> None:
    if str(getattr(operation, "state", "")) not in {"failed", "cancelled", "orphaned"}:
        raise HTTPException(409, detail={"reason_code": "probe_operation_not_eligible"})
    active = manager.store.active_mutation(operation.session_id)
    if active is not None:
        raise HTTPException(
            409,
            detail={
                "reason_code": "session_mutation_in_progress",
                "operation_id": active.operation_id,
            },
        )


def _probe_output_reservation(action: str) -> tuple[int, int]:
    bounds = {
        "dom_snapshot": (1, 500_000),
        "console_tail": (1, 200_000),
        "failed_request_tail": (1, 200_000),
        "screenshot": (1, 500_000),
    }
    return bounds.get(action, (0, 20_000))


def _popup_ownership_options(action: str, options: dict[str, Any]) -> dict[str, Any]:
    selector_key = "control_selector" if action == "click_owned_option" else "selector"
    return {"selector": str(options.get(selector_key) or "")}


def _probe_predicate_passed(
    action: str,
    before: dict[str, Any] | None,
    result: dict[str, Any],
    after: dict[str, Any] | None,
) -> bool:
    if action == "open_owned_popup":
        return bool(
            result.get("ok") is True
            and after
            and after.get("found") is True
            and after.get("expanded") is True
            and after.get("popupId")
        )
    if action == "click_owned_option":
        proof = result.get("proof") if isinstance(result.get("proof"), dict) else {}
        return bool(result.get("ok") is True and proof.get("passed") is True)
    return result.get("ok") is not False


def _structural_mutation_probe_result(
    body: ProbeExecuteRequest, result: dict[str, Any]
) -> dict[str, Any]:
    reason = re.sub(
        r"[^a-z0-9]+", "_", str(result.get("reason") or "probe_committed").lower()
    ).strip("_")
    return {
        "ok": result.get("ok") is True,
        "reason_code": reason[:160] or "probe_committed",
        "predicate": body.expected_predicate,
        "passed": True,
        "popup_id": str(result.get("popupId") or result.get("popup_id") or "")[:160],
    }
