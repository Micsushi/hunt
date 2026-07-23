from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Iterator, Mapping
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.browser_targets import get_browser_target_store
from backend.c3_artifacts import C3ArtifactStore
from backend.c3_browser_controls import C3BrowserControlError, C3BrowserControls
from backend.c3_commands import get_c3_operation_manager
from backend.c3_control_plane import (
    _validation_messages,
    get_browser_control_runner,
    get_probe_budget_manager,
    router,
)
from backend.c3_failure_context import C3FailureContext
from backend.c3_probe_budgets import ProbeBudgetManager
from backend.ledger.api import get_lease_store, require_ledger_access

TARGET_ID = "A1B2C3D4E5F60718293A4B5C6D7E8F90"


class FakeStore:
    def __init__(self, root):
        self.root = root
        self.events = []
        self.operation_dir = root / "operations" / "op-1"
        self.operation_dir.mkdir(parents=True)
        self.active = None
        self.failure_context_reads = 0
        self.failure_evidence_events = []
        self.failure_context = C3FailureContext(
            diagnosis_id="diagnosis-1",
            operation_id="op-1",
            failure_scope="ui_element",
            root_cause_code="required_field_rejected",
            summary="The retained evidence identifies the rejected field.",
            validation_messages=["Select a valid option"],
            evidence_event_ids=["event-action", "event-validation"],
            artifact_ids=["artifact-1"],
            confidence="strong",
            root_cause_unknown=False,
            missing_evidence=[],
            artifact_status="completed",
            authoritative_event_id="event-validation",
            authoritative_event_type="operation.failed",
            source_event_sequence=3,
            live_inspection_required=False,
            next_safe_action="inspect_causal_element",
        )

    def append(self, operation_id, event_type, payload):
        self.events.append((operation_id, event_type, payload))
        return {"event_type": event_type}

    def operation_directory(self, operation_id):
        assert operation_id == "op-1"
        return self.operation_dir

    def active_mutation(self, session_id, *, exclude=""):
        del session_id, exclude
        return self.active

    def get_failure_context(self, operation_id):
        assert operation_id == "op-1"
        self.failure_context_reads += 1
        return self.failure_context

    def tail_events(self, operation_id, *, limit):
        assert operation_id == "op-1"
        retained = self.failure_evidence_events[-limit:]
        return retained, len(self.failure_evidence_events) > limit


class FakeManager:
    def __init__(self, root):
        self.store = FakeStore(root)
        self.operation = SimpleNamespace(
            operation_id="op-1",
            agent_id="agent-1",
            lane_id="lane-1",
            session_id="session-1",
            lease_id="lease-1",
            state="failed",
            terminal=True,
            mutates_page=True,
            artifact_ids=["artifact-1"],
            target={
                "browser_kind": "chrome",
                "debug_port": 9911,
                "extension_id": "ext-1",
                "tab_id": 7,
                "target_id": TARGET_ID,
                "url": "https://example.test/apply",
                "url_sha256": hashlib.sha256(b"https://example.test/apply").hexdigest(),
            },
        )

    def get(self, operation_id):
        if operation_id != "op-1":
            raise FileNotFoundError(operation_id)
        return self.operation


class FakeLeaseStore:
    def require_mutation_lease(self, session_id, actor, lease_id):
        if (session_id, actor.id, lease_id) != ("session-1", "agent-1", "lease-1"):
            raise PermissionError("lease mismatch")
        return SimpleNamespace(lane_id="lane-1")


class FakeTargetStore:
    def get(self, session_id):
        if session_id != "session-1":
            return None
        return SimpleNamespace(
            agent_id="agent-1",
            lane_id="lane-1",
            as_response=lambda: {
                "session_id": "session-1",
                "agent_id": "agent-1",
                "lane_id": "lane-1",
                "debug_port": 9911,
                "browser_kind": "chrome",
                "extension_id": "ext-1",
                "tab_id": 7,
                "url": "https://example.test/apply",
                "metadata": {"target_id": TARGET_ID},
            },
        )


def _identity(action="page_info"):
    return {
        "operation_id": "op-1",
        "agent_id": "agent-1",
        "lane_id": "lane-1",
        "session_id": "session-1",
        "lease_id": "lease-1",
        "action": action,
        "options": {},
    }


def _client(tmp_path, control):
    app = FastAPI()
    app.include_router(router)
    manager = FakeManager(tmp_path)
    budgets = ProbeBudgetManager()
    app.dependency_overrides[require_ledger_access] = lambda: None
    app.dependency_overrides[get_c3_operation_manager] = lambda: manager
    app.dependency_overrides[get_lease_store] = lambda: FakeLeaseStore()
    app.dependency_overrides[get_browser_target_store] = lambda: FakeTargetStore()
    app.dependency_overrides[get_probe_budget_manager] = lambda: budgets
    app.dependency_overrides[get_browser_control_runner] = lambda: control
    client = TestClient(app)
    client.app.state.probe_budgets = budgets
    return client, manager


def test_diagnostic_is_read_only_owned_and_audited(tmp_path):
    calls = []

    def control(target, action, options, *, allow_probe_mutations=False):
        calls.append((target, action, options, allow_probe_mutations))
        return {
            "url": "https://example.test/apply",
            "url_sha256": target["url_sha256"],
            "title": "Apply",
        }

    client, manager = _client(tmp_path, control)
    response = client.post("/api/c3/control/diagnostics/run", json=_identity())

    assert response.status_code == 200
    assert calls[0][1:] == ("page_info", {}, False)
    assert manager.store.events[-1][1] == "diagnostic.executed"

    foreign = _identity()
    foreign["agent_id"] = "other-agent"
    assert client.post("/api/c3/control/diagnostics/run", json=foreign).status_code == 403


def test_probe_budget_is_reserved_before_owned_mutation_and_enforced(tmp_path):
    manager_ref = None
    calls = []

    def control(target, action, options, *, allow_probe_mutations=False):
        calls.append((action, allow_probe_mutations))
        if action == "popup_ownership":
            return {
                "found": True,
                "expanded": len([item for item in calls if item[0] == "popup_ownership"]) > 1,
                "popupId": "menu-1",
            }
        assert manager_ref.store.events[-1][1] == "probe.reserved"
        return {"ok": True, "reason": "owned_popup_opened", "popupId": "menu-1"}

    client, manager = _client(tmp_path, control)
    manager_ref = manager
    create = {key: value for key, value in _identity().items() if key not in {"action", "options"}}
    create.update({"budget_id": "budget-1", "attempts": 2, "mutations": 1})
    assert client.post("/api/c3/control/probes", json=create).status_code == 200

    execute = _identity("open_owned_popup")
    execute.update(
        {
            "options": {"selector": "#source"},
            "reason": "confirm popup ownership",
            "expected_predicate": "popup menu-1 is owned by source",
        }
    )
    first = client.post("/api/c3/control/probes/budget-1/execute", json=execute)
    second = client.post("/api/c3/control/probes/budget-1/execute", json=execute)

    assert first.status_code == 200
    assert first.json()["reservation"]["status"] == "committed"
    assert first.json()["result"]["passed"] is True
    assert calls == [
        ("popup_ownership", False),
        ("open_owned_popup", True),
        ("popup_ownership", False),
    ]
    assert second.status_code == 409
    assert second.json()["detail"]["reason_code"] == "probe_budget_mutations_exceeded"


def test_mutating_probe_response_is_structural_and_never_returns_page_values(tmp_path):
    secret = "private-option-text"
    ownership_reads = 0

    def control(_target, action, _options, *, allow_probe_mutations=False):
        nonlocal ownership_reads
        if action == "popup_ownership":
            ownership_reads += 1
            return {
                "ok": True,
                "found": True,
                "expanded": ownership_reads > 1,
                "popupId": "menu-country",
                "backingValue": secret,
            }
        assert allow_probe_mutations is True
        return {
            "ok": True,
            "reason": "owned_option_clicked",
            "optionText": secret,
            "backingValue": secret,
            "proof": {"passed": True, "afterRawValue": secret},
        }

    client, _manager = _client(tmp_path, control)
    create = {key: value for key, value in _identity().items() if key not in {"action", "options"}}
    create.update({"budget_id": "budget-private-response", "mutations": 1})
    assert client.post("/api/c3/control/probes", json=create).status_code == 200
    execute = _identity("click_owned_option") | {
        "options": {"control_selector": "#country", "option_selector": "#canada"},
        "reason": "verify owned option commit",
        "expected_predicate": "value_committed",
    }

    response = client.post("/api/c3/control/probes/budget-private-response/execute", json=execute)

    assert response.status_code == 200
    assert secret not in response.text
    assert "optionText" not in response.text
    assert "backingValue" not in response.text
    assert response.json()["result"] == {
        "ok": True,
        "reason_code": "owned_option_clicked",
        "predicate": "value_committed",
        "passed": True,
        "popup_id": "",
    }


def test_artifact_reads_require_operation_owner_and_block_traversal(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    artifact = manager.store.operation_dir / "artifacts" / "artifact-1"
    artifact.mkdir(parents=True)
    (artifact / "manifest.json").write_text(
        json.dumps({"artifact_id": "artifact-1", "files": []}), encoding="utf-8"
    )
    unlinked = manager.store.operation_dir / "artifacts" / "artifact-unlinked"
    unlinked.mkdir(parents=True)
    (unlinked / "manifest.json").write_text(
        json.dumps({"artifact_id": "artifact-unlinked", "files": []}), encoding="utf-8"
    )
    query = "?agent_id=agent-1&lease_id=lease-1"

    listed = client.get(f"/api/c3/control/operations/op-1/artifacts{query}")
    traversal = client.get(f"/api/c3/control/operations/op-1/artifacts/artifact-1/files/..{query}")

    assert listed.status_code == 200
    assert [item["artifact_id"] for item in listed.json()["artifacts"]] == ["artifact-1"]
    assert traversal.status_code in {400, 404}


def test_artifact_file_remains_downloadable_beyond_listing_limit(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    captured = C3ArtifactStore(tmp_path).capture_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        reason_code="field_fill_failed",
        diagnostics={},
        operation_directory=manager.store.operation_dir,
    )
    artifact_id = captured["artifact_id"]
    manifest = json.loads(Path(captured["manifest_path"]).read_text(encoding="utf-8"))
    filename = manifest["files"][0]["name"]
    manager.operation.artifact_ids = [
        *[f"older-artifact-{index}" for index in range(32)],
        artifact_id,
    ]

    response = client.get(
        f"/api/c3/control/operations/op-1/artifacts/{artifact_id}/files/{filename}"
        "?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200


def test_failure_context_returns_owned_bounded_redacted_evidence_after_lease_release(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    manager.store.failure_evidence_events = [
        SimpleNamespace(
            seq=1,
            event_id="event-action",
            event_type="operation.action_failed",
            ts="2026-07-22T12:00:00Z",
            payload={
                "action": "select",
                "element": {
                    "selector": "#country[value='private-answer']",
                    "label": "Country",
                },
                "password": "must-not-leak",
            },
        ),
        SimpleNamespace(
            seq=2,
            event_id="event-validation",
            event_type="operation.validation_failed",
            ts="2026-07-22T12:00:01Z",
            payload={
                "validation_messages": ["Select a valid option"],
                "element": {"selector": "#country", "label": "Country"},
            },
        ),
        SimpleNamespace(
            seq=3,
            event_id="event-navigation",
            event_type="operation.navigation_failed",
            ts="2026-07-22T12:00:02Z",
            payload={
                "from_url": "https://jobs.test/apply?token=secret",
                "to_url": "https://jobs.test/review?email=person@example.test",
            },
        ),
    ]
    captured = C3ArtifactStore(tmp_path).capture_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        reason_code="required_field_rejected",
        diagnostics={},
        operation_directory=manager.store.operation_dir,
    )
    artifact_id = captured["artifact_id"]
    artifact_manifest = json.loads(Path(captured["manifest_path"]).read_text(encoding="utf-8"))
    manager.operation.artifact_ids = [artifact_id]
    manager.store.failure_context = manager.store.failure_context.model_copy(
        update={"artifact_ids": [artifact_id]}
    )

    response = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    body = response.json()
    assert body["context"]["root_cause_code"] == "required_field_rejected"
    assert body["source_event_sequence"] == 3
    assert body["action_tail"][0]["element"]["selector"] == "#country[value='[REDACTED]']"
    assert body["validation_tail"][0]["validation_messages"] == ["Select a valid option"]
    assert body["navigation_tail"][0]["navigation_from"] == "https://jobs.test/apply"
    assert body["navigation_tail"][0]["navigation_to"] == "https://jobs.test/review"
    assert body["artifacts"] == [
        {
            "artifact_id": artifact_id,
            "status": "completed",
            "kind": "failure_bundle",
            "captured_at": artifact_manifest["created_at"],
            "files": sorted(entry["name"] for entry in artifact_manifest["files"]),
            "manifest_present": True,
            "manifest_path": str(Path(captured["manifest_path"]).resolve()),
        }
    ]
    assert "must-not-leak" not in response.text
    assert "private-answer" not in response.text
    assert manager.store.failure_context_reads == 1


def test_failure_context_preserves_strict_nested_event_id_but_redacts_phone_like_id(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    generated_event_id = "evt-2139e6961c814de789c4223731644cb7"
    manager.store.failure_evidence_events = [
        {
            "seq": 1,
            "event_id": generated_event_id,
            "event_type": "operation.progress",
            "payload": {"action": "click", "token": "artifact_3035551212"},
        },
        {
            "seq": 2,
            "event_id": "evt-3035551212",
            "event_type": "operation.progress",
            "payload": {"action": "click"},
        },
    ]

    response = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    body = response.json()
    assert body["action_tail"][0]["event_id"] == generated_event_id
    assert body["action_tail"][1]["event_id"] != "evt-3035551212"
    assert "3035551212" not in response.text


def test_failure_context_does_not_call_bounded_transition_projection_real_loss(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    manager.operation.artifact_ids = []
    manager.store.failure_context = manager.store.failure_context.model_copy(
        update={"artifact_ids": [], "artifact_status": "idle", "evidence_truncated": False}
    )
    history = [
        {
            "from_auth_state": "signup",
            "from_auth_ui_state": "signup_form",
            "to_auth_state": "signup",
            "to_auth_ui_state": "landing_choice",
            "candidate": {
                "automation_id": "signInLink",
                "selector": "button[data-automation-id='signInLink']",
                "label": "Sign In",
            },
        }
        for _ in range(6)
    ]
    manager.store.failure_evidence_events = [
        {
            "seq": 48,
            "event_id": "evt-c55e364e9dd74aae8fafa0e1b74d6320",
            "event_type": "operation.failed",
            "payload": {
                "error": {
                    "reason_code": "auth_ui_cycle_detected",
                    "failure_evidence": {
                        "stop_details": {
                            "cycle_period": 3,
                            "cycle_length": 6,
                            "transition_history": history,
                        },
                        "terminal_step": {
                            "kind": "auth_ui_cycle_detected",
                            "reason_code": "auth_ui_cycle_detected",
                            "last_safe_candidate": {
                                "automation_id": "createAccountLink",
                                "selector": ("button[data-automation-id='createAccountLink']"),
                                "label": "Create Account",
                            },
                            "transition_history": history,
                        },
                    },
                }
            },
        }
    ]

    response = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    body = response.json()
    assert body["action_tail"][0]["event_id"] == ("evt-c55e364e9dd74aae8fafa0e1b74d6320")
    assert body["action_tail"][0]["reason_code"] == "auth_ui_cycle_detected"
    assert body["evidence_truncated"] is False


def test_failure_context_requires_stored_owner_but_not_a_live_lease(tmp_path):
    client, _manager = _client(tmp_path, lambda *_args, **_kwargs: {})

    wrong_owner = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-other&lease_id=lease-1"
    )

    assert wrong_owner.status_code == 403
    assert wrong_owner.json()["detail"]["reason_code"] == "operation_identity_mismatch"


def test_failure_context_rejects_nonterminal_operation_without_rebuilding(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    manager.operation.terminal = False
    manager.operation.state = "running"

    response = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "reason_code": "failure_context_not_terminal",
        "operation_id": "op-1",
        "state": "running",
    }
    assert manager.store.failure_context_reads == 0


def test_failure_context_preserves_missing_evidence_and_caps_each_event_tail(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    manager.store.failure_context = manager.store.failure_context.model_copy(
        update={
            "missing_evidence": ["dom_snapshot", "validation_snapshot"],
            "root_cause_unknown": True,
            "live_inspection_required": True,
        }
    )
    manager.store.failure_evidence_events = [
        SimpleNamespace(
            seq=seq,
            event_id=f"event-{seq}",
            event_type="operation.action_failed",
            ts=f"2026-07-22T12:00:{seq:02d}Z",
            payload={"action": "click", "element": {"selector": f"#field-{seq}"}},
        )
        for seq in range(1, 21)
    ]

    response = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    body = response.json()
    assert body["context"]["missing_evidence"] == ["dom_snapshot", "validation_snapshot"]
    assert len(body["action_tail"]) == 16
    assert [item["seq"] for item in body["action_tail"]] == list(range(5, 21))
    assert body["evidence_truncated"] is True


class _WidthBombMapping(Mapping[str, object]):
    def __init__(self, width: int = 10_000):
        self.width = width
        self.items_seen = 0

    def __getitem__(self, key: str) -> object:
        return f"value-{key}"

    def __iter__(self) -> Iterator[str]:
        for index in range(self.width):
            self.items_seen += 1
            if self.items_seen > 80:
                raise AssertionError("payload traversal consumed unbounded mapping width")
            yield f"key-{index}"

    def __len__(self) -> int:
        return self.width


def test_failure_context_bounds_wide_payloads_and_skips_malformed_events(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    wide_payload = _WidthBombMapping()
    manager.store.failure_evidence_events = [
        {"seq": "not-a-number", "event_type": "operation.action_failed", "payload": {}},
        {"seq": 0, "event_type": "operation.action_failed", "payload": {}},
        {"seq": 1, "event_type": "", "payload": {}},
        {
            "seq": 2,
            "event_id": "event-wide",
            "event_type": "operation.action_failed",
            "ts": "2026-07-22T12:00:02Z",
            "payload": wide_payload,
        },
    ]

    response = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    body = response.json()
    assert [item["seq"] for item in body["action_tail"]] == [2]
    assert body["evidence_truncated"] is True
    assert wide_payload.items_seen <= 80


def test_failure_context_redacts_structural_assignments_from_every_projection(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    manager.store.failure_evidence_events = [
        {
            "seq": 1,
            "event_id": "password=hunter2",
            "event_type": "operation.action_failed",
            "ts": "2026-07-22T12:00:01Z",
            "payload": {
                "action": "click password=hunter2",
                "reason_code": "answer=Yes-I-am-secret",
                "validation_messages": [
                    "password=hunter2",
                    "answer=Yes-I-am-secret",
                ],
                "element": {
                    "selector": "#field[value='hunter2']",
                    "label": "Password password=hunter2",
                },
                "from_url": "https://jobs.test/password=hunter2?answer=Yes-I-am-secret",
            },
        }
    ]

    response = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    assert "hunter2" not in response.text
    assert "Yes-I-am-secret" not in response.text
    assert "[REDACTED]" in response.text


class _ValidationMessageBomb:
    def __init__(self):
        self.consumed = 0

    def __iter__(self):
        for index in range(1_000_000):
            self.consumed += 1
            if self.consumed > 65:
                raise AssertionError("validation messages consumed beyond width+1")
            yield f"validation message {index}"


def test_failure_context_caps_validation_message_iterators_and_marks_truncation(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    messages = _ValidationMessageBomb()
    manager.store.failure_evidence_events = [
        {
            "seq": 1,
            "event_id": "event-validation-bomb",
            "event_type": "operation.validation_failed",
            "ts": "2026-07-22T12:00:01Z",
            "payload": {"validation_messages": messages},
        }
    ]

    response = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    body = response.json()
    assert len(body["validation_tail"][0]["validation_messages"]) == 32
    assert messages.consumed == 65
    assert body["evidence_truncated"] is True


def test_failure_context_marks_truncation_on_the_33rd_unique_validation_message(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    manager.store.failure_evidence_events = [
        {
            "seq": 1,
            "event_id": "event-validation-output-cap",
            "event_type": "operation.validation_failed",
            "ts": "2026-07-22T12:00:01Z",
            "payload": {
                "validation_messages": [f"unique validation {index}" for index in range(40)]
            },
        }
    ]

    response = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    body = response.json()
    assert len(body["validation_tail"][0]["validation_messages"]) == 32
    assert body["evidence_truncated"] is True

    projected, truncated = _validation_messages(
        {"validation_messages": [[f"unique validation {index}" for index in range(40)]]}
    )
    assert len(projected) == 32
    assert truncated is True


def test_failure_context_redacts_full_unquoted_multiword_assignments(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    manager.store.failure_evidence_events = [
        {
            "seq": 1,
            "event_id": "event-multiword-redaction",
            "event_type": "operation.validation_failed",
            "ts": "2026-07-22T12:00:01Z",
            "payload": {
                "validation_messages": [
                    "address=123 Main Street, Apartment 4",
                    "answer=Yes I am secretly qualified",
                    "password=hunter two words",
                ]
            },
        }
    ]

    response = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    assert "123 Main Street" not in response.text
    assert "Apartment 4" not in response.text
    assert "Yes I am secretly qualified" not in response.text
    assert "hunter two words" not in response.text
    assert response.text.count("[REDACTED]") >= 3


def test_failure_context_fallback_never_consumes_an_unbounded_event_source(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    manager.store.tail_events = None
    consumed = 0

    def infinite_events(_operation_id):
        nonlocal consumed
        while True:
            consumed += 1
            yield {
                "seq": consumed,
                "event_id": f"event-{consumed}",
                "event_type": "operation.action_failed",
                "ts": "2026-07-22T12:00:00Z",
                "payload": {"action": "click"},
            }

    manager.store.events = infinite_events

    response = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    assert consumed <= 257
    assert response.json()["evidence_truncated"] is True


def test_failure_context_caps_artifact_ids_and_manifest_bytes(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    yielded = 0

    def artifact_ids():
        nonlocal yielded
        for index in range(1_000_000):
            yielded += 1
            if yielded > 40:
                raise AssertionError("artifact ID collection consumed beyond cap+1")
            yield f"artifact-{index}"

    manager.store.failure_context = manager.store.failure_context.model_copy(
        update={"artifact_ids": []}
    )
    manager.operation.artifact_ids = artifact_ids()
    artifact = manager.store.operation_dir / "artifacts" / "artifact-0"
    artifact.mkdir(parents=True)
    (artifact / "manifest.json").write_text(
        '{"artifact_id":"artifact-0","status":"password=hunter2","padding":"'
        + ("x" * 100_000)
        + '"}',
        encoding="utf-8",
    )

    response = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    assert yielded <= 40
    assert len(response.json()["artifacts"]) == 32
    assert response.json()["evidence_truncated"] is True
    assert "hunter2" not in response.text


def test_failure_context_rejects_artifact_symlink_outside_operation_root(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    outside = tmp_path / "outside-artifact"
    outside.mkdir()
    (outside / "manifest.json").write_text(
        json.dumps({"artifact_id": "artifact-1", "status": "answer=Yes-I-am-secret"}),
        encoding="utf-8",
    )
    artifact_root = manager.store.operation_dir / "artifacts"
    artifact_root.mkdir()
    link = artifact_root / "artifact-1"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are unavailable on this platform")

    response = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    assert response.json()["artifacts"][0]["status"] == "unsafe_path"
    assert response.json()["artifacts"][0]["manifest_present"] is False
    assert "Yes-I-am-secret" not in response.text


def test_failure_context_artifact_summary_uses_validated_bundle_metadata(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    captured = C3ArtifactStore(tmp_path).capture_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        reason_code="field_fill_failed",
        diagnostics={},
        operation_directory=manager.store.operation_dir,
    )
    artifact_id = captured["artifact_id"]
    manifest = json.loads(Path(captured["manifest_path"]).read_text(encoding="utf-8"))
    manager.operation.artifact_ids = [artifact_id]
    manager.store.failure_context = manager.store.failure_context.model_copy(
        update={"artifact_ids": [artifact_id]}
    )

    response = client.get(
        "/api/c3/control/operations/op-1/failure-context?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    assert response.json()["artifacts"] == [
        {
            "artifact_id": artifact_id,
            "status": "completed",
            "kind": "failure_bundle",
            "captured_at": manifest["created_at"],
            "files": sorted(entry["name"] for entry in manifest["files"]),
            "manifest_present": True,
            "manifest_path": str(Path(captured["manifest_path"]).resolve()),
        }
    ]


def test_probe_commit_requires_exact_operation_ownership(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    create = {key: value for key, value in _identity().items() if key not in {"action", "options"}}
    create["budget_id"] = "budget-commit"
    assert client.post("/api/c3/control/probes", json=create).status_code == 200
    budgets = client.app.state.probe_budgets
    reservation = budgets.reserve(
        "budget-commit",
        agent_id="agent-1",
        session_id="session-1",
        lease_id="lease-1",
        operation_id="op-1",
        action="page_info",
        reason="record diagnostic proof",
        expected_predicate="page title exists",
    )
    body = {
        **{key: value for key, value in _identity().items() if key not in {"action", "options"}},
        "predicate": "page title exists",
        "observed": {"title": "Apply", "passed": True},
    }

    foreign = client.post(
        f"/api/c3/control/probes/reservations/{reservation.reservation_id}/commit",
        json={**body, "agent_id": "other-agent"},
    )
    owned = client.post(
        f"/api/c3/control/probes/reservations/{reservation.reservation_id}/commit",
        json=body,
    )

    assert foreign.status_code == 403
    assert owned.status_code == 200
    assert manager.store.events[-1][1] == "probe.committed"
    assert manager.store.events[-1][2]["reservation_id"] == reservation.reservation_id


def test_control_rejects_target_re_registration_for_pinned_operation(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    manager.operation.target["tab_id"] = 99

    response = client.post("/api/c3/control/diagnostics/run", json=_identity())

    assert response.status_code == 409
    assert response.json()["detail"]["reason_code"] == "browser_target_version_mismatch"


@pytest.mark.parametrize("current_target_id", ["", "F" * 32])
def test_control_rejects_missing_or_re_registered_cdp_target_identity(tmp_path, current_target_id):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    client.app.dependency_overrides[get_browser_target_store] = lambda: SimpleNamespace(
        get=lambda _session_id: SimpleNamespace(
            agent_id="agent-1",
            lane_id="lane-1",
            as_response=lambda: {
                "session_id": "session-1",
                "agent_id": "agent-1",
                "lane_id": "lane-1",
                "debug_port": 9911,
                "browser_kind": "chrome",
                "extension_id": "ext-1",
                "tab_id": 7,
                "url": "https://example.test/apply?version=2",
                "metadata": {"target_id": current_target_id} if current_target_id else {},
            },
        )
    )

    response = client.post("/api/c3/control/diagnostics/run", json=_identity())

    assert response.status_code == 409
    assert response.json()["detail"]["reason_code"] in {
        "browser_target_exact_identity_missing",
        "browser_target_version_mismatch",
    }


def test_control_query_navigation_uses_current_target_url_and_matching_full_hash(tmp_path):
    current_url = "https://example.test/apply?source=Indeed&version=2"
    calls = []
    client, manager = _client(
        tmp_path,
        lambda target, *_args, **_kwargs: (
            calls.append(target)
            or {
                "ok": True,
                "url": "https://example.test/apply",
                "url_sha256": hashlib.sha256(current_url.encode()).hexdigest(),
            }
        ),
    )
    manager.operation.target["url"] = "https://example.test/apply?source=LinkedIn&version=1"
    manager.operation.target["url_sha256"] = hashlib.sha256(
        manager.operation.target["url"].encode()
    ).hexdigest()
    client.app.dependency_overrides[get_browser_target_store] = lambda: SimpleNamespace(
        get=lambda _session_id: SimpleNamespace(
            agent_id="agent-1",
            lane_id="lane-1",
            as_response=lambda: {
                "session_id": "session-1",
                "agent_id": "agent-1",
                "lane_id": "lane-1",
                "debug_port": 9911,
                "browser_kind": "chrome",
                "extension_id": "ext-1",
                "tab_id": 7,
                "url": current_url,
                "metadata": {"target_id": TARGET_ID},
            },
        )
    )

    response = client.post("/api/c3/control/diagnostics/run", json=_identity())

    assert response.status_code == 200
    assert calls[0]["target_id"] == TARGET_ID
    assert calls[0]["url"] == current_url
    assert calls[0]["url_sha256"] == hashlib.sha256(current_url.encode()).hexdigest()


def test_control_accepts_expected_same_tab_navigation(tmp_path):
    calls = []
    client, manager = _client(
        tmp_path,
        lambda target, *_args, **_kwargs: (
            calls.append(target)
            or {
                "ok": True,
                "url": "https://example.test/auth/sign-in",
                "url_sha256": hashlib.sha256(
                    b"https://example.test/auth/sign-in?token=private"
                ).hexdigest(),
            }
        ),
    )
    manager.operation.target["url"] = "https://example.test/apply"
    client.app.dependency_overrides[get_browser_target_store] = lambda: SimpleNamespace(
        get=lambda _session_id: SimpleNamespace(
            agent_id="agent-1",
            lane_id="lane-1",
            as_response=lambda: {
                "session_id": "session-1",
                "agent_id": "agent-1",
                "lane_id": "lane-1",
                "debug_port": 9911,
                "browser_kind": "chrome",
                "extension_id": "ext-1",
                "tab_id": 7,
                "url": "https://example.test/auth/sign-in?token=private",
                "metadata": {"target_id": TARGET_ID},
            },
        )
    )

    response = client.post("/api/c3/control/diagnostics/run", json=_identity())

    assert response.status_code == 200
    assert calls[0]["url"] == "https://example.test/auth/sign-in?token=private"
    navigation = [item for item in manager.store.events if item[1] == "navigation.observed"]
    assert len(navigation) == 1
    assert navigation[0][2]["url"] == "https://example.test/auth/sign-in"
    assert navigation[0][2]["url_sha256"]


def test_diagnostic_navigation_hashes_full_observed_query_but_redacts_audit_url(tmp_path):
    observed_url = "https://example.test/apply?version=2&token=private"

    class ObservedPage:
        url = observed_url

        async def title(self):
            return "Apply"

    def real_control(_target, action, options, *, allow_probe_mutations=False):
        return asyncio.run(
            C3BrowserControls(ObservedPage(), allow_probe_mutations=allow_probe_mutations).run(
                action, options
            )
        )

    client, manager = _client(
        tmp_path,
        real_control,
    )

    response = client.post("/api/c3/control/diagnostics/run", json=_identity())

    assert response.status_code == 200
    navigation = [item for item in manager.store.events if item[1] == "navigation.observed"]
    assert len(navigation) == 1
    assert navigation[0][2]["url"] == "https://example.test/apply"
    assert navigation[0][2]["url_sha256"] == hashlib.sha256(observed_url.encode()).hexdigest()
    assert "private" not in json.dumps(navigation[0][2])
    assert response.json()["result"]["url"] == "https://example.test/apply"
    assert (
        response.json()["result"]["url_sha256"] == hashlib.sha256(observed_url.encode()).hexdigest()
    )
    assert "private" not in response.text


@pytest.mark.parametrize("observed_hash", ["", "not-a-hash", "f" * 63, "g" * 64])
def test_diagnostic_fails_closed_for_missing_or_invalid_observed_url_hash(tmp_path, observed_hash):
    client, manager = _client(
        tmp_path,
        lambda *_args, **_kwargs: {
            "url": "https://example.test/apply",
            "url_sha256": observed_hash,
            "title": "Apply",
        },
    )

    response = client.post("/api/c3/control/diagnostics/run", json=_identity())

    assert response.status_code == 409
    assert response.json()["detail"]["reason_code"] == "diagnostic_url_identity_invalid"
    assert not any(event[1] == "diagnostic.executed" for event in manager.store.events)


def test_artifact_listing_validates_and_projects_manifest_fields(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    store = C3ArtifactStore(tmp_path)
    result = store.capture_failure_bundle(
        session_id="session-1",
        operation_id="op-1",
        reason_code="failed",
        diagnostics={},
        operation_directory=manager.store.operation_dir,
    )
    artifact_id = result["artifact_id"]
    manager.operation.artifact_ids = [artifact_id]
    manifest_path = Path(result["manifest_path"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["secret_extra"] = "UniqueCandidate-7Q9"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    response = client.get(
        "/api/c3/control/operations/op-1/artifacts?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    assert response.json()["artifacts"][0]["artifact_id"] == artifact_id
    assert "secret_extra" not in response.text
    assert "UniqueCandidate-7Q9" not in response.text


def test_artifact_listing_rejects_manifest_symlink_and_bounds_link_scan(tmp_path):
    client, manager = _client(tmp_path, lambda *_args, **_kwargs: {})
    outside = tmp_path / "outside.json"
    outside.write_text(
        json.dumps({"artifact_id": "artifact-0", "secret": "UniqueCandidate-7Q9"}),
        encoding="utf-8",
    )
    artifact = manager.store.operation_dir / "artifacts" / "artifact-0"
    artifact.mkdir(parents=True)
    try:
        (artifact / "manifest.json").symlink_to(outside)
    except OSError:
        pytest.skip("file symlinks are unavailable on this platform")

    consumed = 0

    def linked_ids():
        nonlocal consumed
        for index in range(1_000_000):
            consumed += 1
            if consumed > 40:
                raise AssertionError("linked artifact scan exceeded cap")
            yield f"artifact-{index}"

    manager.operation.artifact_ids = linked_ids()
    response = client.get(
        "/api/c3/control/operations/op-1/artifacts?agent_id=agent-1&lease_id=lease-1"
    )

    assert response.status_code == 200
    assert consumed <= 40
    assert "UniqueCandidate-7Q9" not in response.text
    assert response.json()["truncated"] is True


def test_mutating_probe_rejects_active_session_mutation(tmp_path):
    client, manager = _client(
        tmp_path,
        lambda *_args, **_kwargs: {"ok": True, "reason": "owned_popup_opened"},
    )
    create = {key: value for key, value in _identity().items() if key not in {"action", "options"}}
    create.update({"budget_id": "budget-active", "mutations": 1})
    assert client.post("/api/c3/control/probes", json=create).status_code == 200
    manager.store.active = SimpleNamespace(operation_id="op-active")
    execute = _identity("open_owned_popup") | {
        "options": {"selector": "#source"},
        "reason": "probe only after failed mutation unwinds",
        "expected_predicate": "popup_open",
    }

    response = client.post("/api/c3/control/probes/budget-active/execute", json=execute)

    assert response.status_code == 409
    assert response.json()["detail"]["reason_code"] == "session_mutation_in_progress"


def test_probe_output_bytes_are_reserved_before_browser_action(tmp_path):
    calls = []
    client, _manager = _client(
        tmp_path,
        lambda *_args, **_kwargs: calls.append(True) or {"url": "https://example.test"},
    )
    create = {key: value for key, value in _identity().items() if key not in {"action", "options"}}
    create.update({"budget_id": "budget-zero-bytes", "bytes": 0})
    assert client.post("/api/c3/control/probes", json=create).status_code == 200
    execute = _identity("page_info") | {
        "reason": "read page identity",
        "expected_predicate": "page_info_available",
    }

    response = client.post("/api/c3/control/probes/budget-zero-bytes/execute", json=execute)

    assert response.status_code == 409
    assert response.json()["detail"]["reason_code"] == "probe_budget_bytes_exceeded"
    assert calls == []


def test_probe_rejects_output_larger_than_reserved_server_bound(tmp_path):
    client, _manager = _client(
        tmp_path,
        lambda *_args, **_kwargs: {"title": "x" * 25_000},
    )
    create = {key: value for key, value in _identity().items() if key not in {"action", "options"}}
    create.update({"budget_id": "budget-output-bound", "bytes": 20_000})
    assert client.post("/api/c3/control/probes", json=create).status_code == 200
    execute = _identity("page_info") | {
        "reason": "read bounded page identity",
        "expected_predicate": "page_info_available",
    }

    response = client.post("/api/c3/control/probes/budget-output-bound/execute", json=execute)

    assert response.status_code == 409
    assert response.json()["detail"]["reason_code"] == "probe_output_bytes_exceeded"


def test_failed_probe_reservation_is_durable_terminal_and_cannot_be_committed(tmp_path):
    def control(*_args, **_kwargs):
        raise C3BrowserControlError("diagnostic_action_timeout")

    client, manager = _client(tmp_path, control)
    create = {key: value for key, value in _identity().items() if key not in {"action", "options"}}
    create.update({"budget_id": "budget-failed", "attempts": 2})
    assert client.post("/api/c3/control/probes", json=create).status_code == 200
    execute = _identity("page_info") | {
        "reason": "inspect bounded page",
        "expected_predicate": "page_info_available",
    }

    failed = client.post("/api/c3/control/probes/budget-failed/execute", json=execute)
    snapshot = client.app.state.probe_budgets.snapshot("budget-failed")
    reservation = snapshot["reservations"][0]
    commit_body = {
        **{key: value for key, value in _identity().items() if key not in {"action", "options"}},
        "predicate": "page_info_available",
        "observed": {"passed": True},
    }
    committed = client.post(
        f"/api/c3/control/probes/reservations/{reservation['reservation_id']}/commit",
        json=commit_body,
    )

    assert failed.status_code == 409
    assert reservation["status"] == "failed"
    assert committed.status_code == 409
    assert committed.json()["detail"]["reason_code"] == "probe_reservation_already_finalized"
    assert [event for _, event, _ in manager.store.events][-2:] == [
        "probe.reserved",
        "probe.failed",
    ]


def test_unexpected_probe_exception_finalizes_reservation(tmp_path):
    def control(*_args, **_kwargs):
        raise RuntimeError("unexpected_playwright_failure")

    client, _manager = _client(tmp_path, control)
    create = {key: value for key, value in _identity().items() if key not in {"action", "options"}}
    create.update({"budget_id": "budget-crash", "attempts": 2})
    assert client.post("/api/c3/control/probes", json=create).status_code == 200
    execute = _identity("page_info") | {
        "reason": "inspect bounded page",
        "expected_predicate": "page_info_available",
    }

    response = client.post("/api/c3/control/probes/budget-crash/execute", json=execute)
    reservation = client.app.state.probe_budgets.snapshot("budget-crash")["reservations"][0]

    assert response.status_code == 409
    assert response.json()["detail"]["reason_code"] == "probe_execution_failed"
    assert reservation["status"] == "failed"
