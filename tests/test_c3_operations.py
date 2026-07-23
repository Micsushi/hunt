from __future__ import annotations

import hashlib
import json
import threading
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

import backend.c3_commands as c3_commands
from backend.browser_targets import BrowserTargetRegister, InMemoryBrowserTargetStore
from backend.c3_identifiers import restore_trusted_generated_c3_ids
from backend.c3_operation_models import (
    NONTERMINAL_STATES,
    TERMINAL_STATES,
    C3Operation,
    C3OperationRequest,
    InvalidOperationTransition,
    OperationEvent,
    validate_transition,
)
from backend.c3_operations import (
    C3MonitorBridgeBusyError,
    C3MonitorBridgeTimeoutError,
    C3OperationConflictError,
    C3OperationManager,
    C3OperationStore,
    _bounded_bridge_mappings,
    _bridge_failure_event_payload,
    _lock_for,
)
from backend.ledger.leases import InMemoryLeaseStore
from backend.ledger.models import Actor
from backend.ledger.service import LedgerService
from backend.ledger.verify import verify_jsonl_hash_chain


def _now() -> datetime:
    return datetime.now(UTC)


def _operation_payload(**overrides):
    now = _now()
    payload = {
        "operation_id": "op-test",
        "command_id": "cmd-test",
        "trace_id": "trace-test",
        "agent_id": "agent-test",
        "lane_id": "lane-test",
        "session_id": "session-test",
        "lease_id": "lease-test",
        "browser_target_id": "target-test",
        "command": "c3.fill_page",
        "state": "queued",
        "created_at": now,
        "updated_at": now,
        "deadline_at": now + timedelta(minutes=10),
    }
    payload.update(overrides)
    return payload


def _request_payload(**overrides):
    payload = {
        "command_name": "c3.fill_page",
        "command_id": "cmd-test",
        "trace_id": "trace-test",
        "agent_id": "agent-test",
        "lane_id": "lane-test",
        "session_id": "session-test",
        "lease_id": "lease-test",
        "browser_target_id": "target-test",
        "reason": "Exercise the current page fill.",
    }
    payload.update(overrides)
    return payload


def test_operation_state_sets_are_exact_and_disjoint():
    assert NONTERMINAL_STATES == {
        "queued",
        "running",
        "slow",
        "suspected_stall",
        "stalled",
        "cancelling",
    }
    assert TERMINAL_STATES == {"completed", "failed", "cancelled", "orphaned"}
    assert NONTERMINAL_STATES.isdisjoint(TERMINAL_STATES)


def test_completed_operation_cannot_return_to_running():
    with pytest.raises(InvalidOperationTransition):
        validate_transition("completed", "running")


@pytest.mark.parametrize(
    ("current", "next_state"),
    [
        ("queued", "running"),
        ("queued", "cancelling"),
        ("running", "slow"),
        ("running", "suspected_stall"),
        ("suspected_stall", "stalled"),
        ("stalled", "cancelling"),
        ("cancelling", "cancelled"),
        ("running", "completed"),
        ("running", "failed"),
        ("running", "orphaned"),
    ],
)
def test_expected_operation_transitions_are_allowed(current, next_state):
    assert validate_transition(current, next_state) == next_state


def test_operation_requires_durable_identity_and_timing_fields():
    operation = C3Operation(**_operation_payload())

    assert operation.operation_id == "op-test"
    assert operation.command == "c3.fill_page"
    assert operation.heartbeat_seq == 0
    assert operation.progress_seq == 0
    assert operation.allow_submit is False
    assert operation.artifact_ids == []

    with pytest.raises(ValidationError):
        C3Operation(
            **{key: value for key, value in _operation_payload().items() if key != "lease_id"}
        )


def test_submit_requires_explicit_capability():
    with pytest.raises(ValidationError, match="submit capability"):
        C3OperationRequest(**_request_payload(allow_submit=True))

    request = C3OperationRequest(
        **_request_payload(allow_submit=True, capabilities=["c3.final_submit"])
    )
    assert request.allow_submit is True


def test_operation_event_requires_positive_sequence_and_utc_timestamp():
    event = OperationEvent(
        seq=1,
        event_type="operation.requested",
        operation_id="op-test",
        command_id="cmd-test",
        agent_id="agent-test",
        lane_id="lane-test",
        session_id="session-test",
        lease_id="lease-test",
        browser_target_id="target-test",
        payload={"state": "queued"},
        ts=_now(),
    )
    assert event.seq == 1
    assert event.ts.tzinfo is not None

    with pytest.raises(ValidationError):
        OperationEvent(
            seq=0,
            event_type="operation.requested",
            operation_id="op-test",
            command_id="cmd-test",
            agent_id="agent-test",
            lane_id="lane-test",
            session_id="session-test",
            lease_id="lease-test",
            browser_target_id="target-test",
            payload={},
            ts=_now(),
        )

    with pytest.raises(ValidationError, match="UTC offset"):
        OperationEvent(
            seq=1,
            event_type="operation.requested",
            operation_id="op-test",
            command_id="cmd-test",
            agent_id="agent-test",
            lane_id="lane-test",
            session_id="session-test",
            lease_id="lease-test",
            browser_target_id="target-test",
            payload={},
            ts=datetime.now(),
        )


def _store(tmp_path):
    return C3OperationStore(tmp_path / "ledger", id_factory=lambda: "op-test")


def test_operation_store_creates_authoritative_event_stream_and_atomic_projection(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))

    operation_dir = next(
        (tmp_path / "ledger" / "c3" / "sessions").glob("*/session-test/operations/op-test")
    )
    event_path = operation_dir / "events.jsonl"
    projection_path = operation_dir / "operation.json"

    assert operation.state == "queued"
    assert event_path.exists()
    assert json.loads(projection_path.read_text(encoding="utf-8"))["state"] == "queued"
    assert not list(operation_dir.glob("*.tmp*"))
    verification = verify_jsonl_hash_chain(event_path)
    assert verification.ok is True
    assert verification.checked_lines == 1


def test_terminal_append_persists_atomic_failure_context_and_rebuilds_it(tmp_path):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {})
    store.append(
        "op-test",
        "operation.failed",
        {
            "error": {"reason_code": "resume_upload:missing_resume_data"},
            "terminal_reason": "extension_command_failed",
        },
    )

    operation_dir = store.operation_directory("op-test")
    diagnosis_path = operation_dir / "diagnosis.json"
    persisted = json.loads(diagnosis_path.read_text(encoding="utf-8"))

    assert persisted["root_cause_code"] == "resume_upload_missing_data"
    assert store.get_failure_context("op-test").model_dump(mode="json") == persisted
    assert store.rebuild_failure_context("op-test").model_dump(mode="json") == persisted
    assert store.get("op-test").diagnosis_id == persisted["diagnosis_id"]
    assert not list(operation_dir.glob(".diagnosis.json.*.tmp"))


def test_production_bridge_failure_is_bounded_private_and_keeps_causal_field(tmp_path):
    secret = "private-selected-answer"
    raw_dom = f"<html><input value='{secret}'></html>"
    bridge_response = {
        "ok": False,
        "commandReceipt": {"ok": False, "reason": "field_fill_failed"},
        "initialResult": {
            "result": {
                "interactionTrace": [
                    {
                        "eventType": "field.action.failed",
                        "fieldId": "country-field",
                        "label": "Country of residence",
                        "uiModel": "combobox",
                        "selectedOption": secret,
                        "payload": {
                            "fieldId": "country-field",
                            "label": "Country of residence",
                            "uiModel": "combobox",
                            "action": "fill",
                            "committed": False,
                            "reasonCode": "workday_commit_not_verified",
                            "afterRawValue": secret,
                            "element": {
                                "selectorPath": f"#country[value='{secret}']",
                                "htmlClip": raw_dom,
                            },
                        },
                    }
                ],
                "generatedAnswers": [{"answerText": secret}],
                "htmlSnapshot": raw_dom,
            }
        },
    }
    store = C3OperationStore(tmp_path / "ledger", recover=False)
    manager = C3OperationManager(
        store,
        lease_store=object(),
        target_store=object(),
        bridge=lambda _target, _payload: bridge_response,
        max_workers=1,
    )
    operation = manager.start(
        C3OperationRequest(
            **_request_payload(
                command_payload={
                    "answerPreview": secret,
                    "rawValue": secret,
                    "generatedAnswers": [{"answerText": secret}],
                    "htmlSnapshot": raw_dom,
                }
            )
        ),
        mutates_page=True,
    )
    try:
        terminal = _wait_for_manager_state(
            manager,
            operation.operation_id,
            lambda current: current.terminal,
        )
        events_path = store.operation_directory(operation.operation_id) / "events.jsonl"
        serialized = events_path.read_text(encoding="utf-8")
        projection = (events_path.parent / "operation.json").read_text(encoding="utf-8")
        lowered = serialized.lower()
        context = store.get_failure_context(operation.operation_id)

        assert terminal.state == "failed"
        assert len(serialized.encode("utf-8")) < 64_000
        assert secret not in serialized
        assert secret not in projection
        assert raw_dom not in serialized
        assert raw_dom not in projection
        for forbidden_key in (
            "answerpreview",
            "selectedoption",
            "afterrawvalue",
            "generatedanswers",
            "rawvalue",
            "htmlsnapshot",
        ):
            assert forbidden_key not in lowered
        assert context.root_cause_code == "workday_commit_not_verified"
        assert context.causal_element is not None
        assert context.causal_element.field_id == "country-field"
        assert context.causal_element.label == "Country of residence"
        assert context.expected_state
        assert context.observed_state
        assert context.root_cause_unknown is False
    finally:
        manager.shutdown(wait=True)


def test_bridge_failure_retains_bounded_private_auth_terminal_evidence(tmp_path):
    secret_email = "private.person@example.test"
    secret_password = "private-password"
    bridge_response = {
        "ok": False,
        "stoppedReason": "auth_primary_action_not_found",
        "stopDetails": {
            "authState": "login",
            "authUiState": "signin_gateway",
            "fromAuthState": "signup",
            "toAuthState": "login",
            "email": secret_email,
            "password": secret_password,
            "rawValue": secret_email,
        },
        "terminalStep": {
            "kind": "auth",
            "reason": "auth_primary_action_not_found",
            "authState": "login",
            "authUiState": "signin_gateway",
            "filledAuthFields": [
                {
                    "source": "profile:accountEmail",
                    "selector": "input[data-automation-id='email']",
                    "ok": True,
                    "changed": True,
                    "value": secret_email,
                },
                {
                    "source": "profile:accountPassword",
                    "selector": "input[type='password']",
                    "ok": True,
                    "changed": False,
                    "value": secret_password,
                },
                {
                    "source": "untrusted:rawValue",
                    "selector": "input[value='private']",
                    "ok": True,
                },
            ],
            "nearMissCandidates": [
                {
                    "tag": "button",
                    "role": "button",
                    "selector": "button[data-automation-id='SignInWithEmailButton']",
                    "automationId": "SignInWithEmailButton",
                    "label": "Sign in with email",
                    "disabled": False,
                    "clickable": False,
                    "score": 0,
                    "rejectionReason": "not_clickable",
                    "value": secret_email,
                }
            ],
        },
    }
    store = C3OperationStore(tmp_path / "ledger", recover=False)
    manager = C3OperationManager(
        store,
        lease_store=object(),
        target_store=object(),
        bridge=lambda _target, _payload: bridge_response,
        max_workers=1,
    )
    operation = manager.start(
        C3OperationRequest(**_request_payload()),
        mutates_page=True,
    )
    try:
        _wait_for_manager_state(manager, operation.operation_id, lambda current: current.terminal)
        terminal_event = next(
            event
            for event in store.events(operation.operation_id)
            if event.event_type == "operation.failed"
        )
        serialized = json.dumps(terminal_event.payload, sort_keys=True)
        evidence = terminal_event.payload["error"]["failure_evidence"]

        assert evidence["stopped_reason"] == "auth_primary_action_not_found"
        assert evidence["stop_details"] == {
            "auth_state": "login",
            "auth_ui_state": "signin_gateway",
            "from_auth_state": "signup",
            "to_auth_state": "login",
        }
        assert evidence["terminal_step"] == {
            "kind": "auth",
            "reason_code": "auth_primary_action_not_found",
            "auth_state": "login",
            "auth_ui_state": "signin_gateway",
            "filled_auth_fields": [
                {
                    "source": "profile:accountEmail",
                    "selector": "input[data-automation-id='email']",
                    "ok": True,
                    "changed": True,
                },
                {
                    "source": "profile:accountPassword",
                    "selector": "input[type='password']",
                    "ok": True,
                    "changed": False,
                },
            ],
        }
        assert evidence["near_miss_candidates"] == [
            {
                "tag": "button",
                "role": "button",
                "selector": "button[data-automation-id='SignInWithEmailButton']",
                "automation_id": "SignInWithEmailButton",
                "label": "Sign in with email",
                "disabled": False,
                "clickable": False,
                "score": 0,
                "rejection_reason": "not_clickable",
            }
        ]
        assert secret_email not in serialized
        assert secret_password not in serialized
        for forbidden_key in ('"email":', '"password":', '"rawvalue":', '"value":'):
            assert forbidden_key not in serialized.lower()
    finally:
        manager.shutdown(wait=True)


def test_bridge_visible_validation_error_projects_exact_causal_control(tmp_path):
    message = "The field How Did You Hear About Us? is required and must have a value."
    bridge_response = {
        "ok": False,
        "stoppedReason": "visible_validation_errors",
        "stopDetails": {
            "visibleValidationErrors": [message],
            "visibleValidationDetails": [
                {
                    "message": message,
                    "element": {
                        "tag": "input",
                        "selector": "input#source--source",
                        "automationId": "source",
                        "fieldId": "source--source",
                        "label": "How Did You Hear About Us?",
                    },
                }
            ],
        },
        "terminalStep": {
            "kind": "safe_next",
            "reason": "visible_validation_errors",
        },
    }
    store = C3OperationStore(tmp_path / "ledger", recover=False)
    manager = C3OperationManager(
        store,
        lease_store=object(),
        target_store=object(),
        bridge=lambda _target, _payload: bridge_response,
        max_workers=1,
    )
    operation = manager.start(C3OperationRequest(**_request_payload()), mutates_page=True)
    try:
        _wait_for_manager_state(manager, operation.operation_id, lambda current: current.terminal)
        context = store.get_failure_context(operation.operation_id)

        assert context.root_cause_code == "visible_validation_errors"
        assert context.failure_scope == "ui_element"
        assert context.causal_element is not None
        assert context.causal_element.selector == "input#source--source"
        assert context.causal_element.field_id == "source--source"
        assert context.validation_messages == [message]
        assert context.root_cause_unknown is False
        assert context.live_inspection_required is False
    finally:
        manager.shutdown(wait=True)


def test_bridge_auth_captcha_gate_projects_direct_login_candidates_without_private_values(
    tmp_path,
):
    secret_email = "private.login@example.test"
    secret_password = "private-login-password"
    bridge_response = {
        "ok": False,
        "stoppedReason": "auth_captcha_gate",
        "stopDetails": {
            "authState": "login",
            "authUiState": "signin_form",
            "email": secret_email,
            "password": secret_password,
        },
        "terminalStep": {
            "kind": "auth_captcha_gate",
            "reason": "auth_captcha_gate",
            "authState": "login",
            "authUiState": "signin_form",
            "effectiveAuthState": "login",
            "effectiveAuthUiState": "credential_form",
            "candidate": {
                "tag": "button",
                "role": "button",
                "selector": "button[data-automation-id='signInSubmitButton']",
                "automationId": "signInSubmitButton",
                "label": "Sign In",
                "disabled": True,
                "clickable": False,
                "score": 220,
                "rejectionReason": "not_clickable",
                "value": secret_email,
            },
            "captchaCandidate": {
                "tag": "div",
                "role": "button",
                "selector": "div[data-automation-id='click_filter']",
                "automationId": "click_filter",
                "label": "Captcha challenge",
                "disabled": False,
                "clickable": True,
                "score": 180,
                "rejectionReason": "captcha_challenge_not_verified",
            },
            "nearMissCandidates": [
                {
                    "tag": "button",
                    "role": "button",
                    "selector": "button[data-automation-id='signInSubmitButton']",
                    "automationId": "signInSubmitButton",
                    "label": "Sign In",
                    "disabled": True,
                    "clickable": False,
                    "score": 220,
                    "rejectionReason": "not_clickable",
                },
                {
                    "tag": "div",
                    "role": "button",
                    "selector": "div[data-automation-id='click_filter']",
                    "automationId": "click_filter",
                    "label": "Captcha challenge",
                    "disabled": False,
                    "clickable": True,
                    "score": 180,
                    "rejectionReason": "captcha_challenge_not_verified",
                },
                {
                    "tag": "div",
                    "selector": "div[data-automation-id='noCaptchaWrapper']",
                    "automationId": "noCaptchaWrapper",
                    "label": "Captcha wrapper",
                    "clickable": True,
                    "score": 0,
                    "rejectionReason": "unsafe_container",
                },
            ],
        },
    }
    store = C3OperationStore(tmp_path / "ledger", recover=False)
    manager = C3OperationManager(
        store,
        lease_store=object(),
        target_store=object(),
        bridge=lambda _target, _payload: bridge_response,
        max_workers=1,
    )
    operation = manager.start(
        C3OperationRequest(**_request_payload()),
        mutates_page=True,
    )
    try:
        terminal = _wait_for_manager_state(
            manager, operation.operation_id, lambda current: current.terminal
        )
        context = store.get_failure_context(operation.operation_id)
        terminal_event = next(
            event
            for event in store.events(operation.operation_id)
            if event.event_type == "operation.failed"
        )
        serialized = json.dumps(
            {
                "operation": terminal.model_dump(mode="json"),
                "event": terminal_event.model_dump(mode="json"),
                "context": context.model_dump(mode="json"),
            },
            sort_keys=True,
        )
        projected_candidates = terminal_event.payload["error"]["failure_evidence"][
            "near_miss_candidates"
        ]

        assert context.failure_scope == "navigation"
        assert context.root_cause_code == "auth_captcha_gate"
        assert context.causal_element is None
        assert [candidate["automation_id"] for candidate in projected_candidates] == [
            "signInSubmitButton",
            "click_filter",
            "noCaptchaWrapper",
        ]
        assert projected_candidates[0]["disabled"] is True
        assert projected_candidates[0]["clickable"] is False
        assert projected_candidates[0]["rejection_reason"] == "not_clickable"
        assert projected_candidates[1]["rejection_reason"] == ("captcha_challenge_not_verified")
        assert (
            terminal_event.payload["error"]["failure_evidence"]["terminal_step"][
                "effective_auth_state"
            ]
            == "login"
        )
        assert (
            terminal_event.payload["error"]["failure_evidence"]["terminal_step"][
                "effective_auth_ui_state"
            ]
            == "credential_form"
        )
        assert context.exposing_action is not None
        assert context.exposing_action.automation_id == "click_filter"
        assert context.exposing_action.selector == "div[data-automation-id='click_filter']"
        assert "captcha_challenge_not_verified" in context.observed_state
        assert context.missing_evidence == []
        assert context.live_inspection_required is False
        assert secret_email not in serialized
        assert secret_password not in serialized
        for forbidden_key in ('"email":', '"password":', '"rawvalue":', '"value":'):
            assert forbidden_key not in serialized.lower()
    finally:
        manager.shutdown(wait=True)


def test_bridge_failure_caps_structural_near_misses_at_eight():
    response = {
        "ok": False,
        "stoppedReason": "auth_primary_action_not_found",
        "terminalStep": {
            "kind": "auth_primary_action",
            "reason": "auth_primary_action_not_found",
            "nearMissCandidates": [
                {
                    "tag": "button",
                    "role": "button",
                    "selector": f"button#candidate-{index}",
                    "automationId": f"Candidate{index}",
                    "label": f"Candidate {index}",
                    "disabled": False,
                    "score": 0,
                }
                for index in range(12)
            ],
        },
    }

    evidence = _bridge_failure_event_payload(response)["error"]["failure_evidence"]

    assert len(evidence["near_miss_candidates"]) == 8
    assert [item["automation_id"] for item in evidence["near_miss_candidates"]] == [
        f"Candidate{index}" for index in range(8)
    ]


def test_bridge_auth_not_found_does_not_promote_prior_successful_candidate_as_near_miss():
    response = {
        "ok": False,
        "pageWalk": {
            "stoppedReason": "auth_primary_action_not_found",
            "terminalStep": {
                "kind": "auth_primary_action_not_found",
                "reason": "auth_primary_action_not_found",
                "candidate": {
                    "tag": "button",
                    "selector": "button[data-automation-id='signInLink']",
                    "automationId": "signInLink",
                    "label": "Sign In",
                    "clickable": True,
                    "score": 118,
                },
                "lastSafeCandidate": {
                    "automationId": "signInLink",
                    "label": "Sign In",
                },
                "nearMissCandidates": [
                    {
                        "tag": "div",
                        "role": "button",
                        "selector": "div[data-automation-id='click_filter']",
                        "automationId": "click_filter",
                        "label": "Sign In",
                        "clickable": True,
                        "score": 0,
                        "rejectionReason": "unsafe_container",
                    }
                ],
            },
        },
    }

    evidence = _bridge_failure_event_payload(response)["error"]["failure_evidence"]

    assert [candidate["automation_id"] for candidate in evidence["near_miss_candidates"]] == [
        "click_filter"
    ]
    assert evidence["terminal_step"]["last_safe_candidate"]["automation_id"] == "signInLink"


def test_bridge_failure_drops_private_candidate_rejection_reason():
    secret = "private-password"
    response = {
        "ok": False,
        "password": secret,
        "stoppedReason": "auth_primary_action_not_found",
        "terminalStep": {
            "kind": "auth_primary_action",
            "reason": "auth_primary_action_not_found",
            "nearMissCandidates": [
                {
                    "selector": "button[data-automation-id='createAccountSubmitButton']",
                    "automationId": "createAccountSubmitButton",
                    "label": "Create Account",
                    "score": 20,
                    "rejectionReason": secret,
                }
            ],
        },
    }

    evidence = _bridge_failure_event_payload(response)["error"]["failure_evidence"]
    serialized = json.dumps(evidence, sort_keys=True)

    assert evidence["near_miss_candidates"][0]["automation_id"] == ("createAccountSubmitButton")
    assert "rejection_reason" not in evidence["near_miss_candidates"][0]
    assert secret not in serialized


def test_bridge_failure_uses_terminal_attempt_step_details_and_candidates():
    response = {
        "ok": False,
        "attempts": [
            {
                "stoppedReason": "auth_same_page_attempt_limit_reached",
                "stopDetails": {
                    "authState": "signup",
                    "authUiState": "signup_form",
                    "nearMissCandidates": [
                        {
                            "selector": "button#stale-action",
                            "automationId": "StaleAction",
                            "label": "Stale action",
                            "score": 0,
                        }
                    ],
                },
                "terminalStep": {
                    "kind": "auth",
                    "reason": "auth_same_page_attempt_limit_reached",
                    "authState": "signup",
                    "nearMissCandidates": [
                        {
                            "selector": "button#stale-action",
                            "automationId": "StaleAction",
                            "label": "Stale action",
                            "score": 0,
                        }
                    ],
                },
            }
        ],
        "pageWalk": {
            "stoppedReason": "auth_signup_signin_loop",
            "stopDetails": {
                "authState": "login",
                "authUiState": "credential_form",
                "nearMissCandidates": [
                    {
                        "selector": "button#terminal-details-action",
                        "automationId": "TerminalDetailsAction",
                        "label": "Terminal details action",
                        "score": 0,
                    }
                ],
            },
            "terminalStep": {
                "kind": "auth_signup_signin_loop",
                "authState": "login",
                "authUiState": "credential_form",
                "fromAuthState": "signup",
                "fromAuthUiState": "signup_form",
                "toAuthState": "login",
                "toAuthUiState": "credential_form",
                "transitionCount": 2,
                "lastSafeCandidate": {
                    "tag": "button",
                    "role": "button",
                    "selector": "button[data-automation-id='createAccountSubmitButton']",
                    "automationId": "createAccountSubmitButton",
                    "label": "Create Account",
                    "disabled": False,
                    "score": 120,
                    "value": "private-value",
                },
                "nearMissCandidates": [
                    {
                        "selector": "button#terminal-action",
                        "automationId": "TerminalAction",
                        "label": "Terminal action",
                        "score": 0,
                    }
                ],
            },
        },
    }

    payload = _bridge_failure_event_payload(response)
    evidence = payload["error"]["failure_evidence"]

    assert payload["error"]["reason_code"] == "auth_signup_signin_loop"
    assert evidence["stopped_reason"] == "auth_signup_signin_loop"
    assert evidence["stop_details"] == {
        "auth_state": "login",
        "auth_ui_state": "credential_form",
    }
    assert evidence["terminal_step"] == {
        "kind": "auth_signup_signin_loop",
        "auth_state": "login",
        "auth_ui_state": "credential_form",
        "from_auth_state": "signup",
        "from_auth_ui_state": "signup_form",
        "to_auth_state": "login",
        "to_auth_ui_state": "credential_form",
        "transition_count": 2,
        "last_safe_candidate": {
            "tag": "button",
            "role": "button",
            "selector": "button[data-automation-id='createAccountSubmitButton']",
            "automation_id": "createAccountSubmitButton",
            "label": "Create Account",
            "disabled": False,
            "score": 120,
        },
    }
    assert evidence["near_miss_candidates"] == [
        {
            "selector": "button#terminal-action",
            "automation_id": "TerminalAction",
            "label": "Terminal action",
            "score": 0,
        }
    ]


def test_bridge_global_auth_limit_retains_last_bounded_transition_history():
    secret = "private-applicant-value"
    transitions = [
        {
            "fromAuthState": f"state_{index}",
            "fromAuthUiState": f"ui_{index}",
            "toAuthState": f"state_{index + 1}",
            "toAuthUiState": f"ui_{index + 1}",
            "observedState": f"observed_{index}",
            "observedUiState": f"observed_ui_{index}",
            "effectiveFromAuthState": f"effective_{index}",
            "effectiveFromAuthUiState": f"effective_ui_{index}",
            "lastAuthActionCandidate": {
                "tag": "button",
                "role": "button",
                "selector": f"button[data-automation-id='AuthAction{index}']",
                "automationId": f"AuthAction{index}",
                "label": f"Auth action {index}",
                "disabled": False,
                "clickable": True,
                "score": 100 + index,
                "value": secret,
            },
            "password": secret,
            "unboundedDebug": "must not survive",
        }
        for index in range(10)
    ]
    response = {
        "ok": False,
        "password": secret,
        "pageWalk": {
            "stoppedReason": "auth_flow_limit_reached",
            "stopDetails": {
                "authState": "signup",
                "authUiState": "signup_form",
            },
            "terminalStep": {
                "kind": "auth_chain_continue",
                "fromAuthState": "signup",
                "fromAuthUiState": "landing_choice",
                "toAuthState": "signup",
                "toAuthUiState": "signup_form",
            },
            "authTransitionCount": 10,
            "authTransitionHistory": transitions,
            "lastAuthActionCandidate": {
                "tag": "button",
                "selector": "button[data-automation-id='createAccountLink']",
                "automationId": "createAccountLink",
                "label": "Create Account",
                "disabled": False,
                "clickable": True,
                "score": 138,
            },
        },
    }

    evidence = _bridge_failure_event_payload(response)["error"]["failure_evidence"]
    serialized = json.dumps(evidence, sort_keys=True)

    assert evidence["stopped_reason"] == "auth_flow_limit_reached"
    assert evidence["terminal_step"]["kind"] == "auth_flow_limit_reached"
    assert evidence["terminal_step"]["reason_code"] == "auth_flow_limit_reached"
    assert evidence["terminal_step"]["last_safe_candidate"]["automation_id"] == (
        "createAccountLink"
    )
    assert evidence["terminal_step"]["transition_count"] == 10
    assert len(evidence["terminal_step"]["transition_history"]) == 8
    assert evidence["terminal_step"]["transition_history"][0]["from_auth_state"] == ("state_2")
    terminal_transition = evidence["terminal_step"]["transition_history"][-1]
    assert terminal_transition == {
        "from_auth_state": "state_9",
        "from_auth_ui_state": "ui_9",
        "to_auth_state": "state_10",
        "to_auth_ui_state": "ui_10",
        "observed_auth_state": "observed_9",
        "observed_auth_ui_state": "observed_ui_9",
        "effective_from_auth_state": "effective_9",
        "effective_from_auth_ui_state": "effective_ui_9",
        "candidate": {
            "tag": "button",
            "role": "button",
            "selector": "button[data-automation-id='AuthAction9']",
            "automation_id": "AuthAction9",
            "label": "Auth action 9",
            "disabled": False,
            "clickable": True,
            "score": 109,
        },
    }
    assert secret not in serialized
    assert "unboundedDebug" not in serialized


def test_bridge_same_page_auth_limit_promotes_owner_evidence_over_stale_wait_step():
    transitions = [
        {
            "fromAuthState": "signup",
            "fromAuthUiState": "signup_form",
            "effectiveFromAuthState": "signup",
            "effectiveFromAuthUiState": "signup_form",
            "toAuthState": "signup",
            "toAuthUiState": "signup_form",
            "candidate": {
                "tag": "button",
                "role": "button",
                "selector": "button[data-automation-id='createAccountSubmitButton']",
                "automationId": "createAccountSubmitButton",
                "label": "Create Account",
                "disabled": False,
                "clickable": True,
            },
        }
        for _ in range(4)
    ]
    response = {
        "ok": False,
        "pageWalk": {
            "stoppedReason": "auth_same_page_attempt_limit_reached",
            "stopDetails": {
                "authState": "signup",
                "authUiState": "signup_form",
                "attempts": 4,
            },
            "terminalStep": {
                "kind": "wait_after_auth_fields",
                "reason": "still_on_auth_page",
            },
            "authTransitionCount": 4,
            "authTransitionHistory": transitions,
            "lastAuthActionCandidate": {
                "tag": "button",
                "role": "button",
                "selector": "button[data-automation-id='createAccountSubmitButton']",
                "automationId": "createAccountSubmitButton",
                "label": "Create Account",
                "disabled": False,
                "clickable": True,
            },
        },
    }

    evidence = _bridge_failure_event_payload(response)["error"]["failure_evidence"]

    assert evidence["stopped_reason"] == "auth_same_page_attempt_limit_reached"
    assert evidence["terminal_step"]["kind"] == "auth_same_page_attempt_limit_reached"
    assert evidence["terminal_step"]["reason_code"] == ("auth_same_page_attempt_limit_reached")
    assert evidence["terminal_step"]["transition_count"] == 4
    assert len(evidence["terminal_step"]["transition_history"]) == 4
    assert evidence["terminal_step"]["last_safe_candidate"]["automation_id"] == (
        "createAccountSubmitButton"
    )


def test_bridge_auth_ui_cycle_retains_production_cycle_period_and_length():
    response = {
        "ok": False,
        "pageWalk": {
            "stoppedReason": "auth_ui_cycle_detected",
            "stopDetails": {
                "cyclePeriod": 1,
                "cycleLength": 2,
                "authTransitionCount": 2,
            },
            "terminalStep": {
                "kind": "auth_ui_cycle_detected",
                "reason": "auth_ui_cycle_detected",
                "cyclePeriod": 1,
                "cycleLength": 2,
                "authTransitionCount": 2,
            },
        },
    }

    evidence = _bridge_failure_event_payload(response)["error"]["failure_evidence"]

    assert evidence["stop_details"]["cycle_period"] == 1
    assert evidence["stop_details"]["cycle_length"] == 2
    assert evidence["terminal_step"]["cycle_period"] == 1
    assert evidence["terminal_step"]["cycle_length"] == 2


def test_bridge_auth_ui_cycle_bounds_cycle_period_and_length():
    response = {
        "ok": False,
        "pageWalk": {
            "stoppedReason": "auth_ui_cycle_detected",
            "stopDetails": {"cyclePeriod": -1, "cycleLength": 2_000_000},
            "terminalStep": {
                "kind": "auth_ui_cycle_detected",
                "cyclePeriod": -1,
                "cycleLength": 2_000_000,
            },
        },
    }

    evidence = _bridge_failure_event_payload(response)["error"]["failure_evidence"]

    assert evidence["stop_details"]["cycle_period"] == 0
    assert evidence["stop_details"]["cycle_length"] == 1_000_000
    assert evidence["terminal_step"]["cycle_period"] == 0
    assert evidence["terminal_step"]["cycle_length"] == 1_000_000


def test_bridge_auth_ui_cycle_omits_boolean_cycle_period_and_length():
    response = {
        "ok": False,
        "pageWalk": {
            "stoppedReason": "auth_ui_cycle_detected",
            "stopDetails": {
                "authState": "signup",
                "cyclePeriod": True,
                "cycleLength": False,
            },
            "terminalStep": {
                "kind": "auth_ui_cycle_detected",
                "cyclePeriod": True,
                "cycleLength": False,
            },
        },
    }

    evidence = _bridge_failure_event_payload(response)["error"]["failure_evidence"]

    assert "cycle_period" not in evidence["stop_details"]
    assert "cycle_length" not in evidence["stop_details"]
    assert "cycle_period" not in evidence["terminal_step"]
    assert "cycle_length" not in evidence["terminal_step"]


def test_bridge_history_clipping_retains_total_transition_count_without_source_count():
    history = [
        {
            "fromAuthState": "signup",
            "fromAuthUiState": f"step_{index}",
            "toAuthState": "signup",
            "toAuthUiState": f"step_{index + 1}",
        }
        for index in range(10)
    ]
    response = {
        "ok": False,
        "pageWalk": {
            "stoppedReason": "auth_ui_cycle_detected",
            "stopDetails": {"authTransitionHistory": history},
            "terminalStep": {
                "kind": "auth_ui_cycle_detected",
                "authTransitionHistory": history,
            },
        },
    }

    evidence = _bridge_failure_event_payload(response)["error"]["failure_evidence"]

    assert len(evidence["stop_details"]["transition_history"]) == 8
    assert evidence["stop_details"]["transition_count"] == 10
    assert len(evidence["terminal_step"]["transition_history"]) == 8
    assert evidence["terminal_step"]["transition_count"] == 10


def test_bridge_failure_omits_unrelated_prior_attempt_details_and_candidates():
    response = {
        "ok": False,
        "attempts": [
            {
                "stoppedReason": "auth_primary_action_not_found",
                "stopDetails": {
                    "authState": "signup",
                    "authUiState": "landing_choice",
                },
                "terminalStep": {
                    "kind": "auth_primary_action",
                    "reason": "auth_primary_action_not_found",
                    "nearMissCandidates": [
                        {
                            "selector": "button#unrelated-prior-action",
                            "automationId": "UnrelatedPriorAction",
                            "label": "Unrelated prior action",
                            "score": 0,
                        }
                    ],
                },
            }
        ],
        "pageWalk": {
            "stoppedReason": "workday_runtime_not_ready",
            "terminalStep": {
                "kind": "safe_next",
                "reason": "workday_runtime_not_ready",
            },
        },
    }

    evidence = _bridge_failure_event_payload(response)["error"]["failure_evidence"]

    assert evidence["stopped_reason"] == "workday_runtime_not_ready"
    assert evidence["terminal_step"] == {
        "kind": "safe_next",
        "reason_code": "workday_runtime_not_ready",
    }
    assert "stop_details" not in evidence
    assert "near_miss_candidates" not in evidence


def test_bridge_failure_omits_same_reason_evidence_from_prior_attempt_owner():
    response = {
        "ok": False,
        "attempts": [
            {
                "stoppedReason": "auth_primary_action_not_found",
                "stopDetails": {
                    "authState": "signup",
                    "authUiState": "landing_choice",
                    "nearMissCandidates": [
                        {
                            "selector": "button#prior-owner-action",
                            "automationId": "PriorOwnerAction",
                            "label": "Prior owner action",
                            "score": 0,
                        }
                    ],
                },
                "terminalStep": {
                    "kind": "auth_primary_action",
                    "reason": "auth_primary_action_not_found",
                },
            }
        ],
        "pageWalk": {
            "stoppedReason": "auth_primary_action_not_found",
            "terminalStep": {
                "kind": "auth_primary_action",
                "reason": "auth_primary_action_not_found",
                "authState": "login",
                "authUiState": "credential_form",
            },
        },
    }

    evidence = _bridge_failure_event_payload(response)["error"]["failure_evidence"]

    assert evidence["terminal_step"]["auth_state"] == "login"
    assert "stop_details" not in evidence
    assert "near_miss_candidates" not in evidence


def test_bridge_failure_ignores_control_keys_beyond_mapping_scan_bound():
    oversized_page_walk = {f"filler_{index}": index for index in range(128)}
    oversized_page_walk.update(
        {
            "stoppedReason": "auth_primary_action_not_found",
            "stopDetails": {"authState": "login"},
            "terminalStep": {
                "kind": "auth_primary_action",
                "reason": "auth_primary_action_not_found",
            },
        }
    )

    payload = _bridge_failure_event_payload({"ok": False, "pageWalk": oversized_page_walk})

    assert payload["error"] == {
        "reason_code": "extension_command_failed",
        "bridge_reason_code": "extension_command_failed",
    }


def test_bounded_bridge_mapping_walk_consumes_at_most_mapping_limit_values():
    class CountingValuesDict(dict):
        consumed = 0

        def values(self):
            for value in super().values():
                type(self).consumed += 1
                yield value

    CountingValuesDict.consumed = 0
    oversized = CountingValuesDict((f"child_{index}", {"index": index}) for index in range(1_000))

    mappings = list(_bounded_bridge_mappings(oversized))

    assert mappings[0] is oversized
    assert CountingValuesDict.consumed <= 128


def test_bridge_failure_retains_bounded_runtime_readiness_summary():
    response = {
        "ok": False,
        "pageWalk": {
            "stoppedReason": "workday_runtime_not_ready",
            "terminalStep": {
                "kind": "safe_next",
                "reason": "workday_runtime_not_ready",
                "runtimeReadiness": {
                    "ok": False,
                    "reason": "runtime_surface_timeout",
                    "waitedMs": 2500,
                    "probe": {
                        "workdayHost": True,
                        "rootPresent": True,
                        "rootChildCount": 0,
                        "readyState": "complete",
                        "loadingIndicatorVisible": False,
                        "visibleControlCount": 0,
                        "applicationFieldCount": 0,
                        "validationErrorCount": 0,
                        "finalSubmitVisible": False,
                        "pageText": "private page content",
                    },
                },
            },
        },
    }

    evidence = _bridge_failure_event_payload(response)["error"]["failure_evidence"]

    assert evidence["terminal_step"]["runtime_readiness"] == {
        "ok": False,
        "reason_code": "runtime_surface_timeout",
        "waited_ms": 2500,
        "probe": {
            "workday_host": True,
            "root_present": True,
            "root_child_count": 0,
            "ready_state": "complete",
            "loading_indicator_visible": False,
            "visible_control_count": 0,
            "application_field_count": 0,
            "validation_error_count": 0,
            "final_submit_visible": False,
        },
    }
    assert "private page content" not in json.dumps(evidence)


def test_operation_event_payload_has_a_total_structure_and_string_budget(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    store.append(
        operation.operation_id,
        "operation.completed",
        {
            "result": {
                "audit": [{"safe_detail": "x" * 16_000} for _ in range(10_000)],
                "ok": True,
            }
        },
    )

    events_path = store.operation_directory(operation.operation_id) / "events.jsonl"

    assert events_path.stat().st_size < 512_000
    assert store.get(operation.operation_id).state == "completed"


def test_recovery_rebuilds_failure_context_from_events(tmp_path):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {})
    store.append(
        "op-test",
        "operation.failed",
        {
            "error": {"reason_code": "auth_create_account_to_signin_sink"},
            "terminal_reason": "extension_command_failed",
        },
    )
    expected = store.get_failure_context("op-test")
    diagnosis_path = store.operation_directory("op-test") / "diagnosis.json"
    diagnosis_path.write_text('{"corrupt": true}', encoding="utf-8")

    recovered = C3OperationStore(tmp_path / "ledger")

    assert recovered.get_failure_context("op-test") == expected
    assert recovered.get("op-test").diagnosis_id == expected.diagnosis_id


def test_get_failure_context_rebuilds_corrupt_projection_from_events(tmp_path):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {})
    store.append(
        "op-test",
        "operation.failed",
        {
            "error": {"reason_code": "resume_upload:missing_resume_data"},
            "terminal_reason": "extension_command_failed",
        },
    )
    expected = store.get_failure_context("op-test")
    diagnosis_path = store.operation_directory("op-test") / "diagnosis.json"
    diagnosis_path.write_text('{"corrupt": true}', encoding="utf-8")

    rebuilt = store.get_failure_context("op-test")

    assert rebuilt == expected
    assert C3OperationStore(tmp_path / "ledger").get_failure_context("op-test") == expected


def test_late_monitor_and_artifact_events_refresh_diagnosis_not_primary_cause(tmp_path):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {})
    store.append(
        "op-test",
        "operation.failed",
        {
            "error": {"reason_code": "auth_create_account_to_signin_sink"},
            "terminal_reason": "extension_command_failed",
        },
    )
    before_operation = store.get("op-test")
    before_context = store.get_failure_context("op-test")

    store.append(
        "op-test",
        "operation.health_probe_failed",
        {"error": {"reason_code": "probe_timeout"}},
    )
    store.append(
        "op-test",
        "operation.artifact_captured",
        {"artifact_ids": ["artifact-late"]},
    )

    after_operation = store.get("op-test")
    after_context = store.get_failure_context("op-test")
    assert after_operation.state == before_operation.state == "failed"
    assert after_operation.error == before_operation.error
    assert after_operation.terminal_reason == before_operation.terminal_reason
    assert after_context.root_cause_code == before_context.root_cause_code
    assert after_context.authoritative_event_id == before_context.authoritative_event_id
    assert after_context.artifact_ids == ["artifact-late"]
    assert after_context.monitor_summary.health_probe_failure_count == 1


def test_diagnosis_builder_exception_records_failure_without_changing_terminal_truth(
    tmp_path, monkeypatch
):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {})

    def fail_builder(*_args, **_kwargs):
        raise RuntimeError("diagnosis exploded")

    monkeypatch.setattr("backend.c3_operations.build_failure_context", fail_builder)
    primary_error = {"reason_code": "primary_failure"}

    store.append(
        "op-test",
        "operation.failed",
        {
            "error": primary_error,
            "terminal_reason": "extension_command_failed",
        },
    )

    operation = store.get("op-test")
    context = store.get_failure_context("op-test")
    assert operation.state == "failed"
    assert operation.error == primary_error
    assert operation.terminal_reason == "extension_command_failed"
    assert context.root_cause_code == "unknown_failure"
    assert context.root_cause_unknown is True
    assert context.live_inspection_required is True
    assert [event.event_type for event in store.events("op-test")][-1] == "diagnosis.failed"


def test_invalid_diagnosis_builder_return_is_contained_as_unknown(tmp_path, monkeypatch):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {})
    monkeypatch.setattr(
        "backend.c3_operations.build_failure_context",
        lambda *_args, **_kwargs: {"invalid": "packet"},
    )

    store.append(
        "op-test",
        "operation.failed",
        {
            "error": {"reason_code": "primary_failure"},
            "terminal_reason": "extension_command_failed",
        },
    )

    operation = store.get("op-test")
    context = store.get_failure_context("op-test")
    assert operation.state == "failed"
    assert operation.error == {"reason_code": "primary_failure"}
    assert operation.terminal_reason == "extension_command_failed"
    assert context.root_cause_code == "unknown_failure"
    assert context.root_cause_unknown is True
    assert store.events("op-test")[-1].event_type == "diagnosis.failed"


def test_diagnosis_write_failure_persists_unknown_without_changing_terminal_truth(
    tmp_path, monkeypatch
):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {})
    original_write = store._write_failure_context
    write_count = 0

    def fail_first_write(directory, context):
        nonlocal write_count
        write_count += 1
        if write_count == 1:
            raise OSError("diagnosis disk unavailable")
        return original_write(directory, context)

    monkeypatch.setattr(store, "_write_failure_context", fail_first_write)
    primary_error = {"reason_code": "primary_failure"}

    store.append(
        "op-test",
        "operation.failed",
        {
            "error": primary_error,
            "terminal_reason": "extension_command_failed",
        },
    )

    operation = store.get("op-test")
    context = store.get_failure_context("op-test")
    assert write_count == 2
    assert operation.state == "failed"
    assert operation.error == primary_error
    assert operation.terminal_reason == "extension_command_failed"
    assert context.root_cause_code == "unknown_failure"
    assert context.missing_evidence == ["diagnosis_generation"]
    assert store.events("op-test")[-1].event_type == "diagnosis.failed"


def test_diagnosis_id_projection_failure_is_contained_after_terminal_write(tmp_path, monkeypatch):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {})
    original_write = store._write_projection
    failed_projection = False

    def fail_first_diagnosis_projection(directory, operation):
        nonlocal failed_projection
        if operation.diagnosis_id and not failed_projection:
            failed_projection = True
            raise OSError("operation projection unavailable")
        return original_write(directory, operation)

    monkeypatch.setattr(store, "_write_projection", fail_first_diagnosis_projection)
    primary_error = {"reason_code": "primary_failure"}

    store.append(
        "op-test",
        "operation.failed",
        {
            "error": primary_error,
            "terminal_reason": "extension_command_failed",
        },
    )

    operation = store.get("op-test")
    context = store.get_failure_context("op-test")
    assert failed_projection is True
    assert operation.state == "failed"
    assert operation.error == primary_error
    assert operation.terminal_reason == "extension_command_failed"
    assert operation.diagnosis_id == context.diagnosis_id
    assert context.root_cause_code == "unknown_failure"
    assert store.events("op-test")[-1].event_type == "diagnosis.failed"


@pytest.mark.parametrize(
    "event_type",
    [
        "operation.health_probe_failed",
        "operation.monitor_failed",
        "operation.artifact_capture_failed",
    ],
)
def test_observability_failure_does_not_overwrite_terminal_truth(tmp_path, event_type):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {})
    primary_error = {"reason_code": "missing_actor_context"}
    primary_result = {"stoppedReason": "missing_actor_context"}
    store.append(
        "op-test",
        "operation.failed",
        {
            "error": primary_error,
            "result": primary_result,
            "terminal_reason": "extension_command_failed",
        },
    )
    monitor_error = {"type": "TimeoutError", "message": f"{event_type}_timeout"}

    store.append(
        "op-test",
        event_type,
        {
            "error": monitor_error,
            "result": {"reachable": False},
            "terminal_reason": "observability_failed",
        },
    )

    current = store.get("op-test")
    assert current.error == primary_error
    assert current.result == primary_result
    assert current.terminal_reason == "extension_command_failed"
    assert current.monitor_error == monitor_error


def test_first_terminal_event_remains_authoritative_when_duplicate_arrives(tmp_path):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {})
    store.append(
        "op-test",
        "operation.failed",
        {
            "error": {"reason_code": "primary_failure"},
            "result": {"step": "source"},
            "terminal_reason": "extension_command_failed",
        },
    )

    store.append(
        "op-test",
        "operation.failed",
        {
            "error": {"reason_code": "late_failure"},
            "result": {"step": "wrong"},
            "terminal_reason": "late_terminal_reason",
        },
    )

    current = store.get("op-test")
    assert current.error == {"reason_code": "primary_failure"}
    assert current.result == {"step": "source"}
    assert current.terminal_reason == "extension_command_failed"


def test_non_lifecycle_payload_cannot_terminalize_operation(tmp_path):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {})
    monitor_error = {"reason_code": "health_probe_timeout"}

    store.append(
        "op-test",
        "operation.health_probe_failed",
        {
            "state": "failed",
            "error": monitor_error,
            "result": {"reachable": False},
            "terminal_reason": "payload_injected_terminal",
        },
    )

    current = store.get("op-test")
    assert current.state == "running"
    assert current.finished_at is None
    assert current.error is None
    assert current.result is None
    assert current.terminal_reason == ""
    assert current.monitor_error == monitor_error


def test_lifecycle_event_type_is_authoritative_over_payload_state(tmp_path):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {})

    store.append(
        "op-test",
        "operation.completed",
        {
            "state": "failed",
            "result": {"ok": True},
            "terminal_reason": "bridge_completed",
        },
    )

    current = store.get("op-test")
    assert current.state == "completed"
    assert current.result == {"ok": True}
    assert current.terminal_reason == "bridge_completed"


@pytest.mark.parametrize(
    ("event_type", "payload"),
    [
        ("operation.heartbeat", {"heartbeat_seq": 99, "phase": "stale"}),
        (
            "operation.progress",
            {"progress_seq": 99, "phase": "stale", "substep": "stale"},
        ),
        ("operation.health_probe_completed", {"result": {"reachable": True}}),
        (
            "operation.completed",
            {"result": {"ok": False}, "terminal_reason": "late_completed"},
        ),
        (
            "operation.failed",
            {"error": {"reason_code": "late_failed"}, "terminal_reason": "late_failed"},
        ),
        ("operation.cancelled", {"terminal_reason": "late_cancelled"}),
        (
            "operation.orphaned",
            {"error": {"reason_code": "late_orphaned"}, "terminal_reason": "late_orphaned"},
        ),
        ("operation.cancel_acknowledged", {"reason": "late_ack"}),
        (
            "operation.cancel_failed",
            {"error": {"reason_code": "late_cancel_failure"}},
        ),
    ],
)
def test_store_atomically_ignores_post_terminal_telemetry(tmp_path, event_type, payload):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {"phase": "bridge"})
    store.append(
        "op-test",
        "operation.completed",
        {"result": {"ok": True}, "terminal_reason": "bridge_completed"},
    )
    before = store.get("op-test")
    events_before = store.events("op-test")

    appended = store.append("op-test", event_type, payload)

    after = store.get("op-test")
    assert appended is None
    assert store.events("op-test") == events_before
    assert after.updated_at == before.updated_at
    assert after.heartbeat_seq == before.heartbeat_seq
    assert after.progress_seq == before.progress_seq
    assert after.phase == before.phase
    assert after.substep == before.substep
    assert after.result == before.result


def test_recovery_preserves_first_terminal_event_from_legacy_duplicate_stream(tmp_path):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {})
    first_terminal = store.append(
        "op-test",
        "operation.failed",
        {
            "error": {"reason_code": "primary_failure"},
            "result": {"step": "source"},
            "terminal_reason": "extension_command_failed",
        },
    )
    operation = store.get("op-test")
    directory = store.operation_directory("op-test")
    store.ledger.append(
        directory / "events.jsonl",
        store._event_payload(
            operation,
            "operation.failed",
            {
                "error": {"reason_code": "legacy_late_failure"},
                "result": {"step": "wrong"},
                "terminal_reason": "legacy_late_terminal",
            },
        ),
    )

    recovered = C3OperationStore(tmp_path / "ledger")

    current = recovered.get("op-test")
    assert current.error == {"reason_code": "primary_failure"}
    assert current.result == {"step": "source"}
    assert current.terminal_reason == "extension_command_failed"
    assert current.updated_at == first_terminal.ts
    assert len(recovered.events("op-test")) == 4


def test_conditional_append_ignores_changed_nonterminal_state_without_mutation(tmp_path):
    store = _store(tmp_path)
    store.create(C3OperationRequest(**_request_payload()))
    store.append("op-test", "operation.started", {"phase": "bridge"})
    before = store.get("op-test")
    events_before = store.events("op-test")

    appended = store.append_if_nonterminal(
        "op-test",
        "operation.checkpoint",
        {"reason": "stale_watchdog_decision"},
        expected_states={"slow"},
    )

    assert appended is None
    assert store.events("op-test") == events_before
    assert store.get("op-test") == before


def test_operation_store_appends_events_updates_projection_and_reads_after_sequence(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))

    started = store.append(
        operation.operation_id,
        "operation.started",
        {"progress_seq": 0, "phase": "bridge"},
    )
    store.append(
        operation.operation_id,
        "operation.progress",
        {"progress_seq": 1, "phase": "field_action", "substep": "open_popup"},
    )

    current = store.get(operation.operation_id)
    assert started.seq == 2
    assert current.state == "running"
    assert current.phase == "field_action"
    assert current.substep == "open_popup"
    assert current.progress_seq == 1
    assert [event.seq for event in store.events(operation.operation_id, after_seq=1)] == [2, 3]


def test_operation_store_reads_a_bounded_tail_without_materializing_the_full_stream(
    tmp_path, monkeypatch
):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    for seq in range(8):
        store.append(
            operation.operation_id,
            "operation.progress",
            {"progress_seq": seq + 1, "phase": "fill"},
        )
    events_path = store.operation_directory(operation.operation_id) / "events.jsonl"
    original_read_text = type(events_path).read_text

    def reject_full_read(path, *args, **kwargs):
        if path == events_path:
            raise AssertionError("tail_events must not call Path.read_text on the event stream")
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(type(events_path), "read_text", reject_full_read)

    events, truncated = store.tail_events(operation.operation_id, limit=3)

    assert [event.seq for event in events] == [8, 9, 10]
    assert truncated is True


def test_operation_store_atomically_adds_concurrent_artifact_links(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    store.append(
        operation.operation_id,
        "operation.failed",
        {"error": {"reason_code": "extension_command_failed"}},
    )
    barrier = threading.Barrier(3)

    def link(artifact_id):
        barrier.wait()
        store.append_artifact(
            operation.operation_id,
            artifact_id,
            reason="operation_failed",
            late_completion=True,
        )

    threads = [
        threading.Thread(target=link, args=("artifact-one",)),
        threading.Thread(target=link, args=("artifact-two",)),
    ]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join(timeout=2)

    assert all(not thread.is_alive() for thread in threads)
    assert set(store.get(operation.operation_id).artifact_ids) == {
        "artifact-one",
        "artifact-two",
    }


def test_operation_event_redaction_preserves_only_strict_generated_c3_ids(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    event_id = "evt-2515398246d541f2a743bb2e989a40c3"
    operation_id = "op-bifagllfnlamkgpppbgkmhmdbdbkpnld"
    artifact_id = "artifact_2515398246d541f2a743bb2e989a40c3"

    event = store.append(
        operation.operation_id,
        "operation.progress",
        {
            "trusted_ids": {
                "event_id": event_id,
                "operation_id": operation_id,
                "artifact_id": artifact_id,
            },
            "adversarial_ids": [
                "evt-3035551212",
                "op-3035551212",
                "artifact_3035551212",
            ],
            "token": artifact_id,
        },
    )

    assert event is not None
    assert event.payload["trusted_ids"] == {
        "event_id": event_id,
        "operation_id": operation_id,
        "artifact_id": artifact_id,
    }
    serialized = json.dumps(event.payload, sort_keys=True)
    assert "3035551212" not in serialized
    assert event.payload["token"] == "[REDACTED]"


def test_identifier_restoration_is_strictly_bound_to_each_field_kind():
    event_id = "evt-3035551212abcdefabcdefabcdefabcd"
    operation_id = "op-bifagllfnlamkgpppbgkmhmdbdbkpnld"
    artifact_id = "artifact_3035551212abcdefabcdefabcdefabcd"
    diagnosis_id = f"diagnosis-{operation_id}-{event_id}"
    lease_id = "lease_3035551212ab"
    target_id = "3035551212ABCDEFABCDEFABCDEFABCD"
    original = {
        "event_id": event_id,
        "event_ids": [event_id],
        "authoritative_event_id": event_id,
        "evidence_event_ids": [event_id],
        "operation_id": operation_id,
        "parent_operation_id": operation_id,
        "artifact_id": artifact_id,
        "artifact_ids": [artifact_id],
        "diagnosis_id": diagnosis_id,
        "lease_id": lease_id,
        "target_id": target_id,
        "cross_kind": {
            "event_id": artifact_id,
            "operation_id": event_id,
            "artifact_id": diagnosis_id,
            "diagnosis_id": artifact_id,
            "lease_id": event_id,
            "target_id": event_id,
            "checkpoint_id": event_id,
        },
        "token": artifact_id,
    }
    redacted = {
        "event_id": "[REDACTED]",
        "event_ids": ["[REDACTED]"],
        "authoritative_event_id": "[REDACTED]",
        "evidence_event_ids": ["[REDACTED]"],
        "operation_id": "[REDACTED]",
        "parent_operation_id": "[REDACTED]",
        "artifact_id": "[REDACTED]",
        "artifact_ids": ["[REDACTED]"],
        "diagnosis_id": "[REDACTED]",
        "lease_id": "[REDACTED]",
        "target_id": "[REDACTED]",
        "cross_kind": {key: "[REDACTED]" for key in original["cross_kind"]},
        "token": "[REDACTED]",
    }

    restored = restore_trusted_generated_c3_ids(redacted, original)

    assert restored == {
        **original,
        "cross_kind": {key: "[REDACTED]" for key in original["cross_kind"]},
        "token": "[REDACTED]",
    }


def test_late_artifact_link_retains_live_generated_id_in_operation_and_diagnosis(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    store.append(
        operation.operation_id,
        "operation.failed",
        {"error": {"reason_code": "auth_same_page_attempt_limit_reached"}},
    )
    artifact_id = "artifact_2515398246d541f2a743bb2e989a40c3"

    event = store.append_artifact(
        operation.operation_id,
        artifact_id,
        reason="operation_failed",
        late_completion=True,
    )

    assert event is not None
    assert event.payload["artifact_ids"] == [artifact_id]
    assert store.get(operation.operation_id).artifact_ids == [artifact_id]
    context = store.get_failure_context(operation.operation_id)
    assert context.artifact_ids == [artifact_id]
    assert context.artifact_status == "completed"


def test_operation_event_page_is_cursor_paginated_and_count_bounded(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    for seq in range(4):
        store.append(
            operation.operation_id,
            "operation.progress",
            {"progress_seq": seq + 1, "phase": "fill"},
        )

    first = store.event_page(operation.operation_id, limit=2)
    second = store.event_page(
        operation.operation_id,
        after_seq=first.next_after_seq,
        limit=2,
    )

    assert [event.seq for event in first.events] == [1, 2]
    assert first.next_after_seq == 2
    assert first.has_more is True
    assert first.truncated is False
    assert [event.seq for event in second.events] == [3, 4]
    assert second.next_after_seq == 4
    assert second.has_more is True


def test_operation_event_page_stops_at_byte_bound_without_full_read(tmp_path, monkeypatch):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    store.append(
        operation.operation_id,
        "operation.progress",
        {"progress_seq": 1, "phase": "x" * 12_000},
    )
    events_path = store.operation_directory(operation.operation_id) / "events.jsonl"
    original_read_text = type(events_path).read_text

    def reject_full_read(path, *args, **kwargs):
        if path == events_path:
            raise AssertionError("event_page must stream the event file")
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(type(events_path), "read_text", reject_full_read)

    page = store.event_page(
        operation.operation_id,
        after_seq=1,
        limit=10,
        max_bytes=4_096,
    )

    assert [event.seq for event in page.events] == [2]
    assert page.bytes_read <= 4_096
    assert page.next_after_seq == 3
    assert page.has_more is False
    assert page.truncated is True


def test_operation_event_page_advances_past_valid_row_over_page_byte_budget(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {"phase": "bridge"})

    page = store.event_page(
        operation.operation_id,
        after_seq=1,
        limit=10,
        max_bytes=1,
    )

    assert page.events == ()
    assert page.next_after_seq == 2
    assert page.has_more is False
    assert page.truncated is True


def test_operation_event_page_advances_past_oversize_valid_row(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    events_path = store.operation_directory(operation.operation_id) / "events.jsonl"
    oversized = store._event_payload(  # noqa: SLF001 - targeted durable-stream test
        operation,
        "operation.health_probe_failed",
        {"error": {"message": "x" * (2 * 1024 * 1024 + 32)}},
    )
    store.ledger.append(events_path, oversized)

    page = store.event_page(operation.operation_id, after_seq=1, limit=10)

    assert page.events == ()
    assert page.next_after_seq == 2
    assert page.has_more is False
    assert page.truncated is True


def test_operation_event_page_uses_cursor_offset_instead_of_rescanning_prefix(
    tmp_path, monkeypatch
):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    for progress_seq in range(1, 101):
        store.append(
            operation.operation_id,
            "operation.progress",
            {"progress_seq": progress_seq},
        )

    validations = 0
    original = OperationEvent.model_validate

    def counted(value, *args, **kwargs):
        nonlocal validations
        validations += 1
        return original(value, *args, **kwargs)

    monkeypatch.setattr(OperationEvent, "model_validate", counted)

    page = store.event_page(operation.operation_id, after_seq=100, limit=2)

    assert [event.seq for event in page.events] == [101, 102]
    assert validations <= 2


def test_event_page_holds_operation_lock_while_reading(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    directory = store.operation_directory(operation.operation_id)
    started = threading.Event()
    finished = threading.Event()

    def read_page():
        started.set()
        store.event_page(operation.operation_id)
        finished.set()

    lock = _lock_for(directory)
    lock.acquire()
    thread = threading.Thread(target=read_page, daemon=True)
    try:
        thread.start()
        assert started.wait(timeout=1)
        assert not finished.wait(timeout=0.1)
    finally:
        lock.release()
    assert finished.wait(timeout=1)
    thread.join(timeout=1)


def test_event_offset_index_load_is_streamed_without_read_text(tmp_path, monkeypatch):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    directory = store.operation_directory(operation.operation_id)
    index_path = directory / "event-offsets.jsonl"
    store._event_end_offsets.clear()  # noqa: SLF001 - restart-cache fixture
    original_read_text = type(index_path).read_text

    def reject_index_materialization(path, *args, **kwargs):
        if path == index_path:
            raise AssertionError("event offset index must be streamed")
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(type(index_path), "read_text", reject_index_materialization)

    page = store.event_page(operation.operation_id, after_seq=1)

    assert [event.seq for event in page.events] == [2]


def test_corrupt_projection_recovery_streams_event_log(tmp_path, monkeypatch):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    store.append(operation.operation_id, "operation.completed", {"result": {"ok": True}})
    directory = store.operation_directory(operation.operation_id)
    (directory / "operation.json").write_text("{corrupt", encoding="utf-8")
    events_path = directory / "events.jsonl"
    original_read_text = type(events_path).read_text

    def reject_event_materialization(path, *args, **kwargs):
        if path == events_path:
            raise AssertionError("event recovery must stream")
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(type(events_path), "read_text", reject_event_materialization)
    recovered = C3OperationStore(tmp_path / "ledger")

    assert recovered.get(operation.operation_id).state == "completed"


def test_terminal_diagnosis_reads_only_bounded_event_tail(tmp_path, monkeypatch):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    for seq in range(140):
        store.append(
            operation.operation_id,
            "operation.progress",
            {"progress_seq": seq + 1, "phase": "fill"},
        )
    events_path = store.operation_directory(operation.operation_id) / "events.jsonl"
    original_read_text = type(events_path).read_text

    def reject_full_read(path, *args, **kwargs):
        if path == events_path:
            raise AssertionError("terminal diagnosis must use bounded streaming reads")
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(type(events_path), "read_text", reject_full_read)

    store.append(
        operation.operation_id,
        "operation.failed",
        {"error": {"reason_code": "extension_command_failed"}},
    )

    context = store.get_failure_context(operation.operation_id)
    assert context.authoritative_event_type == "operation.failed"
    assert context.evidence_truncated is True


def test_bounded_diagnosis_retains_existing_authoritative_terminal_outside_tail(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    store.append(
        operation.operation_id,
        "operation.failed",
        {
            "terminal_reason": "extension_command_failed",
            "error": {"reason_code": "workday_commit_not_verified"},
        },
    )
    first = store.get_failure_context(operation.operation_id)
    events_path = store.operation_directory(operation.operation_id) / "events.jsonl"
    terminal_operation = store.get(operation.operation_id)
    for index in range(140):
        store.ledger.append(
            events_path,
            store._event_payload(  # noqa: SLF001 - legacy late-event fixture
                terminal_operation,
                "operation.result_ignored_after_deadline",
                {"late_response_ok": False, "index": index},
            ),
        )

    rebuilt = store.rebuild_failure_context(operation.operation_id)

    assert rebuilt.authoritative_event_id == first.authoritative_event_id
    assert rebuilt.authoritative_event_type == "operation.failed"
    assert rebuilt.root_cause_code == first.root_cause_code
    assert rebuilt.evidence_truncated is True


def test_recovery_reuses_valid_terminal_projection_and_diagnosis(tmp_path, monkeypatch):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    store.append(
        operation.operation_id,
        "operation.failed",
        {"terminal_reason": "extension_command_failed"},
    )
    expected = store.get_failure_context(operation.operation_id)

    def reject_rebuild(*_args, **_kwargs):
        raise AssertionError("valid terminal snapshots should not replay the event stream")

    monkeypatch.setattr(C3OperationStore, "_rebuild_projection", reject_rebuild)

    recovered = C3OperationStore(tmp_path / "ledger")

    assert recovered.get(operation.operation_id).state == "failed"
    assert recovered.get_failure_context(operation.operation_id) == expected
    assert recovered.recovery_errors == {}


def test_recovery_rebuilds_missing_diagnosis_from_projected_first_terminal(tmp_path, monkeypatch):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    terminal = store.append(
        operation.operation_id,
        "operation.failed",
        {
            "terminal_reason": "extension_command_failed",
            "error": {"reason_code": "workday_commit_not_verified"},
        },
    )
    directory = store.operation_directory(operation.operation_id)
    terminal_operation = store.get(operation.operation_id)
    for index in range(140):
        store.ledger.append(
            directory / "events.jsonl",
            store._event_payload(  # noqa: SLF001 - post-terminal recovery fixture
                terminal_operation,
                "diagnostic.executed",
                {"index": index},
            ),
        )
    (directory / "diagnosis.json").unlink()

    def reject_full_rebuild(*_args, **_kwargs):
        raise AssertionError("terminal projection must retain first-terminal authority")

    monkeypatch.setattr(C3OperationStore, "_rebuild_projection", reject_full_rebuild)
    recovered = C3OperationStore(tmp_path / "ledger")
    context = recovered.get_failure_context(operation.operation_id)

    assert context.authoritative_event_id == terminal.event_id
    assert context.authoritative_event_type == "operation.failed"
    assert context.root_cause_code == "workday_commit_not_verified"
    assert context.evidence_truncated is True


def test_invalid_transition_is_not_appended_to_durable_stream(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))

    with pytest.raises(InvalidOperationTransition):
        store.append(operation.operation_id, "operation.stalled", {})

    assert [event.event_type for event in store.events(operation.operation_id)] == [
        "operation.requested"
    ]
    recovered = C3OperationStore(tmp_path / "ledger")
    assert recovered.get(operation.operation_id).state == "orphaned"


def test_invalid_projection_payload_is_not_appended_to_durable_stream(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))

    with pytest.raises(ValueError):
        store.append(
            operation.operation_id,
            "operation.artifact_captured",
            {"artifact_ids": {"not": "a-list"}},
        )

    assert [event.event_type for event in store.events(operation.operation_id)] == [
        "operation.requested"
    ]
    assert store.get(operation.operation_id).artifact_ids == []


def test_manager_stops_monitor_before_shared_control_and_bridge_executors(monkeypatch):
    order = []

    class Recorder:
        def __init__(self, name):
            self.name = name

        def shutdown(self, **_kwargs):
            order.append(self.name)

    operation_executor = Recorder("operation_executor")
    control_executor = Recorder("control_executor")
    bridge_executor = Recorder("bridge_executor")
    cancel_bridge_executor = Recorder("cancel_bridge_executor")
    monitor_bridge_executor = Recorder("monitor_bridge_executor")
    monitor = Recorder("monitor")
    executors = iter(
        [
            operation_executor,
            control_executor,
            bridge_executor,
            cancel_bridge_executor,
            monitor_bridge_executor,
        ]
    )
    monkeypatch.setattr(
        "backend.c3_operations.ThreadPoolExecutor",
        lambda **_kwargs: next(executors),
    )
    manager = C3OperationManager(
        SimpleNamespace(),
        lease_store=None,
        target_store=None,
        bridge=lambda *_args: {},
        monitor=monitor,
    )
    manager.shutdown(wait=False)

    assert order == [
        "monitor",
        "control_executor",
        "operation_executor",
        "bridge_executor",
        "cancel_bridge_executor",
        "monitor_bridge_executor",
    ]


def test_manager_uses_one_bounded_control_executor_for_all_sessions(tmp_path):
    store = _store(tmp_path)
    manager = C3OperationManager(
        store,
        lease_store=None,
        target_store=None,
        bridge=lambda *_args: {},
        control_workers=2,
    )
    try:
        assert manager._control_executor_for("session-one") is manager._control_executor_for(  # noqa: SLF001
            "session-two"
        )
        assert not hasattr(manager, "_control_executors")
    finally:
        manager.shutdown(wait=False)


def test_monitor_bridge_boundary_serializes_probes_without_starving_main_bridge(tmp_path):
    monitor_entered = threading.Event()
    monitor_release = threading.Event()

    def bridge(_target, payload):
        if payload.get("command_name") == "c3.get_progress":
            monitor_entered.set()
            assert monitor_release.wait(timeout=5)
        return {"ok": True, "commandReceipt": {"ok": True}}

    manager = C3OperationManager(
        _store(tmp_path),
        lease_store=None,
        target_store=None,
        bridge=bridge,
        max_workers=2,
    )
    monitor_result = manager.executor.submit(
        manager.run_monitor_bridge,
        {},
        {"command_name": "c3.get_progress"},
        timeout_seconds=1,
    )
    try:
        assert monitor_entered.wait(timeout=1)
        main_result = manager._bridge_executor.submit(  # noqa: SLF001
            manager.bridge,
            {},
            {"command_name": "c3.page_walk"},
        ).result(timeout=0.5)
        assert main_result["ok"] is True

        with pytest.raises(C3MonitorBridgeBusyError):
            manager.run_monitor_bridge(
                {},
                {"command_name": "c3.get_progress"},
                timeout_seconds=0.1,
            )
    finally:
        monitor_release.set()
        assert monitor_result.result(timeout=1)["ok"] is True
        manager.shutdown(wait=True)


def test_monitor_bridge_timeout_keeps_slot_owned_until_late_cleanup_finishes(tmp_path):
    entered = threading.Event()
    release = threading.Event()

    def bridge(_target, _payload):
        entered.set()
        assert release.wait(timeout=5)
        return {"ok": True}

    manager = C3OperationManager(
        _store(tmp_path),
        lease_store=None,
        target_store=None,
        bridge=bridge,
    )
    try:
        with pytest.raises(C3MonitorBridgeTimeoutError):
            manager.run_monitor_bridge({}, {}, timeout_seconds=0.05)
        assert entered.is_set()
        with pytest.raises(C3MonitorBridgeBusyError):
            manager.run_monitor_bridge({}, {}, timeout_seconds=0.05)
        release.set()
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            try:
                result = manager.run_monitor_bridge({}, {}, timeout_seconds=0.2)
                break
            except C3MonitorBridgeBusyError:
                time.sleep(0.01)
        else:
            raise AssertionError("monitor bridge slot was not released after cleanup")
        assert result["ok"] is True
    finally:
        release.set()
        manager.shutdown(wait=True)


def test_terminal_artifact_admission_has_priority_over_new_progress_probes(tmp_path):
    progress_entered = threading.Event()
    release_progress = threading.Event()
    artifact_entered = threading.Event()
    release_artifact = threading.Event()

    def progress_task():
        progress_entered.set()
        assert release_progress.wait(timeout=5)
        return "progress-finished"

    def artifact_task():
        artifact_entered.set()
        assert release_artifact.wait(timeout=5)
        return "artifact-finished"

    manager = C3OperationManager(
        _store(tmp_path),
        lease_store=None,
        target_store=None,
        bridge=lambda *_args: {},
    )
    progress = manager.executor.submit(
        manager.run_monitor_task,
        progress_task,
        timeout_seconds=1,
    )
    artifact = None
    try:
        assert progress_entered.wait(timeout=1)
        artifact = manager.executor.submit(
            manager.run_monitor_artifact_task,
            artifact_task,
            admission_timeout_seconds=1,
            timeout_seconds=1,
        )
        deadline = time.monotonic() + 1
        while manager._monitor_artifact_waiters < 1 and time.monotonic() < deadline:  # noqa: SLF001
            time.sleep(0.01)
        assert manager._monitor_artifact_waiters == 1  # noqa: SLF001

        with pytest.raises(C3MonitorBridgeBusyError):
            manager.run_monitor_task(lambda: "new-progress", timeout_seconds=0.1)

        release_progress.set()
        assert artifact_entered.wait(timeout=1)
        with pytest.raises(C3MonitorBridgeBusyError):
            manager.run_monitor_task(lambda: "overlap", timeout_seconds=0.1)
        release_artifact.set()

        assert progress.result(timeout=1) == "progress-finished"
        assert artifact.result(timeout=1) == "artifact-finished"
    finally:
        release_progress.set()
        release_artifact.set()
        if artifact is not None:
            artifact.cancel()
        manager.shutdown(wait=True)


def test_operation_projection_and_events_are_redacted(tmp_path):
    store = _store(tmp_path)
    request = C3OperationRequest(
        **_request_payload(
            command_payload={"access_token": "top-secret", "note": "call 303-555-1212"}
        )
    )
    operation = store.create(request)
    operation_dir = next(
        (tmp_path / "ledger" / "c3" / "sessions").glob("*/session-test/operations/op-test")
    )

    serialized = (operation_dir / "events.jsonl").read_text(encoding="utf-8")
    projection = (operation_dir / "operation.json").read_text(encoding="utf-8")
    assert "top-secret" not in serialized + projection
    assert "303-555-1212" not in serialized + projection
    assert operation.command_payload["access_token"] == "[REDACTED]"


def test_restart_rebuilds_from_jsonl_and_orphans_only_nonterminal_operations(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {"phase": "bridge"})
    operation_dir = next(
        (tmp_path / "ledger" / "c3" / "sessions").glob("*/session-test/operations/op-test")
    )
    stale_projection = json.loads((operation_dir / "operation.json").read_text(encoding="utf-8"))
    stale_projection["state"] = "completed"
    (operation_dir / "operation.json").write_text(json.dumps(stale_projection), encoding="utf-8")

    recovered = C3OperationStore(tmp_path / "ledger")

    assert recovered.get(operation.operation_id).state == "orphaned"
    assert recovered.events(operation.operation_id, after_seq=0)[-1].event_type == (
        "operation.orphaned"
    )


def test_restart_does_not_change_terminal_operation(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    store.append(
        operation.operation_id,
        "operation.completed",
        {"result": {"ok": True}, "terminal_reason": "bridge_completed"},
    )
    count_before = len(store.events(operation.operation_id))

    recovered = C3OperationStore(tmp_path / "ledger")

    assert recovered.get(operation.operation_id).state == "completed"
    assert len(recovered.events(operation.operation_id)) == count_before


def test_restart_finalizes_acknowledged_cancellation_as_cancelled(tmp_path):
    store = _store(tmp_path)
    operation = store.create(C3OperationRequest(**_request_payload()))
    store.append(operation.operation_id, "operation.started", {})
    store.append(
        operation.operation_id,
        "operation.cancel_requested",
        {
            "reason": "agent_cancel",
            "cancel_attempt_id": "cancel-ack",
            "cancel_attempt_count": 1,
        },
    )
    store.append(
        operation.operation_id,
        "operation.cancel_acknowledged",
        {
            "cancel_attempt_id": "cancel-ack",
            "cancel_attempt_count": 1,
            "reason": "cancel_acknowledged",
        },
    )

    recovered = C3OperationStore(tmp_path / "ledger")

    current = recovered.get(operation.operation_id)
    assert current.state == "cancelled"
    assert current.terminal_reason == "agent_cancel"
    assert recovered.events(operation.operation_id)[-1].event_type == "operation.cancelled"


def test_recovery_isolates_malformed_operation_and_recovers_healthy_siblings(tmp_path):
    ids = iter(["op-corrupt", "op-healthy"])
    store = C3OperationStore(tmp_path / "ledger", id_factory=lambda: next(ids))
    corrupt = store.create(C3OperationRequest(**_request_payload(command_id="cmd-corrupt")))
    healthy = store.create(C3OperationRequest(**_request_payload(command_id="cmd-healthy")))
    corrupt_events = store.operation_directory(corrupt.operation_id) / "events.jsonl"
    corrupt_events.write_text("{not-json}\n", encoding="utf-8")

    recovered = C3OperationStore(tmp_path / "ledger")

    assert recovered.get(healthy.operation_id).state == "orphaned"
    assert corrupt.operation_id in recovered.recovery_errors


def _claim_operation_lease(lease_store):
    claim = lease_store.claim_session_mutation_lease(
        "lane-test",
        "session-test",
        Actor(type="agent", id="agent-test", surface="mcp"),
        ttl_seconds=60,
    )
    return claim.lease.lease_id


def _operation_api_payload(lease_id, **overrides):
    payload = {
        **_request_payload(lease_id=lease_id),
        "browser_target_id": "session-test",
        "target": {
            "browser_kind": "chrome",
            "debug_port": 9222,
            "extension_id": "ext-test",
            "tab_id": 42,
            "target_id": "target-job-42",
            "url": "https://jobs.example/apply?token=secret",
        },
    }
    payload.update(overrides)
    return payload


def _operation_client(
    tmp_path,
    bridge,
    *,
    max_workers=4,
    control_workers=2,
    register_target=True,
    target_agent_id="agent-test",
    target_lane_id="lane-test",
    cancel_timeout_seconds=5.0,
    cancel_retry_backoff_seconds=0.1,
):
    app = FastAPI()
    service = LedgerService(tmp_path / "ledger")
    lease_store = InMemoryLeaseStore()
    target_store = InMemoryBrowserTargetStore()
    if register_target:
        target_store.register(
            BrowserTargetRegister(
                session_id="session-test",
                agent_id=target_agent_id,
                lane_id=target_lane_id,
                browser_kind="chrome",
                debug_port=9222,
                extension_id="ext-test",
                options_url="chrome-extension://ext-test/src/options/options.html",
                tab_id=42,
                url="https://jobs.example/apply?token=secret",
                metadata={"target_id": "target-job-42"},
            )
        )
    operation_store = C3OperationStore(service.root, recover=False)
    manager = C3OperationManager(
        operation_store,
        lease_store=lease_store,
        target_store=target_store,
        bridge=bridge,
        max_workers=max_workers,
        control_workers=control_workers,
        cancel_timeout_seconds=cancel_timeout_seconds,
        cancel_retry_backoff_seconds=cancel_retry_backoff_seconds,
    )
    app.include_router(c3_commands.operations_router)
    app.include_router(c3_commands.router)
    app.dependency_overrides[c3_commands.get_ledger_service] = lambda: service
    app.dependency_overrides[c3_commands.get_lease_store] = lambda: lease_store
    app.dependency_overrides[c3_commands.get_browser_target_store] = lambda: target_store
    app.dependency_overrides[c3_commands.get_c3_operation_manager] = lambda: manager
    app.dependency_overrides[c3_commands.require_ledger_access] = lambda: None
    return TestClient(app), manager, lease_store


def _wait_for_state(client, operation_id, expected, lease_id, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(
            f"/api/c3/operations/{operation_id}",
            params={"agent_id": "agent-test", "lease_id": lease_id},
        )
        if response.status_code == 200 and response.json()["operation"]["state"] in expected:
            return response.json()["operation"]
        time.sleep(0.01)
    raise AssertionError(f"operation {operation_id} did not reach {expected}")


def _wait_for_manager_state(manager, operation_id, predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        operation = manager.get(operation_id)
        if predicate(operation):
            return operation
        time.sleep(0.01)
    raise AssertionError(f"operation {operation_id} did not reach expected state")


def test_operation_post_returns_202_without_waiting_for_blocking_bridge(tmp_path):
    bridge_entered = threading.Event()
    bridge_release = threading.Event()

    def blocking_bridge(_target, payload):
        bridge_entered.set()
        assert bridge_release.wait(timeout=5)
        return {"ok": True, "commandReceipt": {"ok": True, "commandId": payload["command_id"]}}

    client, manager, lease_store = _operation_client(tmp_path, blocking_bridge)
    lease_id = _claim_operation_lease(lease_store)
    try:
        started = time.monotonic()
        response = client.post("/api/c3/operations", json=_operation_api_payload(lease_id))
        elapsed = time.monotonic() - started

        assert response.status_code == 202
        assert elapsed < 2
        operation_id = response.json()["operation_id"]
        assert response.json()["operation"]["state"] in {"queued", "running"}
        assert bridge_entered.wait(timeout=1)

        events = client.get(
            f"/api/c3/operations/{operation_id}/events",
            params={"agent_id": "agent-test", "lease_id": lease_id, "after_seq": 1},
        )
        assert events.status_code == 200
        assert all(event["seq"] > 1 for event in events.json()["events"])
    finally:
        bridge_release.set()
        manager.shutdown(wait=True)


def test_operation_start_preserves_exact_registered_query_url_and_ownership_ids(tmp_path):
    exact_url = "https://jobs.example/apply?source=LinkedIn"
    target_id = "213ECD6932550875B5BA79D24C5DEBAB"
    lease_id = "lease_9756151594f7"
    captured_targets = []

    def bridge(target, _payload):
        captured_targets.append(dict(target))
        return {"ok": True, "commandReceipt": {"ok": True}}

    client, manager, lease_store = _operation_client(
        tmp_path,
        bridge,
        register_target=False,
    )
    lease_store._id_factory = lambda _prefix: lease_id
    target_store = client.app.dependency_overrides[c3_commands.get_browser_target_store]()
    target_store.register(
        BrowserTargetRegister(
            session_id="session-test",
            agent_id="agent-test",
            lane_id="lane-test",
            browser_kind="chrome",
            debug_port=9222,
            extension_id="ext-test",
            options_url="chrome-extension://ext-test/src/options/options.html",
            tab_id=42,
            url=exact_url,
            metadata={"target_id": target_id},
        )
    )
    claimed_lease_id = _claim_operation_lease(lease_store)
    assert claimed_lease_id == lease_id
    payload = _operation_api_payload(claimed_lease_id)
    payload["target"]["url"] = exact_url
    payload["target"]["target_id"] = target_id

    try:
        response = client.post("/api/c3/operations", json=payload)

        assert response.status_code == 202
        operation_id = response.json()["operation_id"]
        operation = manager.get(operation_id)
        assert operation.lease_id == lease_id
        assert operation.target["target_id"] == target_id
        assert operation.target["url"] == exact_url
        assert operation.target["url_sha256"] == hashlib.sha256(exact_url.encode()).hexdigest()
        assert (
            client.get(
                f"/api/c3/operations/{operation_id}",
                params={"agent_id": "agent-test", "lease_id": lease_id},
            ).status_code
            == 200
        )
        deadline = time.monotonic() + 1
        while not captured_targets and time.monotonic() < deadline:
            time.sleep(0.01)
        assert captured_targets[0]["target_id"] == target_id
        assert captured_targets[0]["url"] == exact_url
    finally:
        manager.shutdown(wait=True)


def test_main_bridge_deadline_releases_operation_worker_and_ignores_late_result(tmp_path):
    bridge_entered = threading.Event()
    bridge_release = threading.Event()
    captured_payload = {}

    def blocking_bridge(_target, payload):
        captured_payload.update(payload)
        bridge_entered.set()
        assert bridge_release.wait(timeout=5)
        return {"ok": True, "commandReceipt": {"ok": True}}

    client, manager, lease_store = _operation_client(tmp_path, blocking_bridge, max_workers=2)
    lease_id = _claim_operation_lease(lease_store)
    try:
        response = client.post(
            "/api/c3/operations",
            json=_operation_api_payload(
                lease_id,
                deadline_at=(_now() + timedelta(seconds=1)).isoformat(),
            ),
        )
        operation_id = response.json()["operation_id"]
        assert bridge_entered.wait(timeout=2)

        failed = _wait_for_state(client, operation_id, {"failed"}, lease_id, timeout=2.5)
        assert failed["terminal_reason"] == "operation_bridge_deadline_exceeded"
        assert 1 <= captured_payload["bridge_timeout_ms"] <= 5000
        assert manager.executor.submit(lambda: "released").result(timeout=0.5) == "released"

        bridge_release.set()
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            event_types = [event.event_type for event in manager.events(operation_id)]
            if "operation.result_ignored_after_deadline" in event_types:
                break
            time.sleep(0.01)
        current = manager.get(operation_id)
        assert current.state == "failed"
        assert "operation.completed" not in event_types
        assert "operation.result_ignored_after_deadline" in event_types
    finally:
        bridge_release.set()
        manager.shutdown(wait=True)


def test_hard_hung_bridge_pool_fails_later_operation_immediately(tmp_path):
    bridge_release = threading.Event()
    bridge_calls = 0

    def hard_hung_bridge(_target, _payload):
        nonlocal bridge_calls
        bridge_calls += 1
        assert bridge_release.wait(timeout=10)
        return {"ok": True, "commandReceipt": {"ok": True}}

    client, manager, lease_store = _operation_client(tmp_path, hard_hung_bridge, max_workers=2)
    lease_id = _claim_operation_lease(lease_store)
    try:
        for _index in range(2):
            response = client.post(
                "/api/c3/operations",
                json=_operation_api_payload(
                    lease_id,
                    deadline_at=(_now() + timedelta(milliseconds=250)).isoformat(),
                ),
            )
            operation_id = response.json()["operation_id"]
            _wait_for_state(client, operation_id, {"failed"}, lease_id, timeout=2)

        started = time.monotonic()
        response = client.post(
            "/api/c3/operations",
            json=_operation_api_payload(
                lease_id,
                deadline_at=(_now() + timedelta(seconds=5)).isoformat(),
            ),
        )
        operation_id = response.json()["operation_id"]
        failed = _wait_for_state(client, operation_id, {"failed"}, lease_id, timeout=1)

        assert time.monotonic() - started < 1
        assert failed["terminal_reason"] == "operation_bridge_capacity_exhausted"
        assert bridge_calls == 2
    finally:
        bridge_release.set()
        manager.shutdown(wait=True)


def test_queued_operation_expires_without_entering_mutation_worker(tmp_path):
    bridge_release = threading.Event()
    bridge_calls: list[str] = []

    def blocking_bridge(_target, payload):
        bridge_calls.append(payload["command_id"])
        assert bridge_release.wait(timeout=5)
        return {"ok": True, "commandReceipt": {"ok": True}}

    store = C3OperationStore(tmp_path / "ledger", recover=False)
    manager = C3OperationManager(
        store,
        lease_store=None,
        target_store=None,
        bridge=blocking_bridge,
        max_workers=2,
    )

    def request(suffix: str, *, deadline: datetime) -> C3OperationRequest:
        return C3OperationRequest(
            **_request_payload(
                command_name="c3.inspect_fields",
                command_id=f"cmd-{suffix}",
                trace_id=f"trace-{suffix}",
                deadline_at=deadline,
            )
        )

    try:
        long_deadline = _now() + timedelta(seconds=3)
        manager.start(request("one", deadline=long_deadline), mutates_page=False)
        manager.start(request("two", deadline=long_deadline), mutates_page=False)
        wait_until = time.monotonic() + 1
        while len(bridge_calls) < 2 and time.monotonic() < wait_until:
            time.sleep(0.01)
        assert len(bridge_calls) == 2

        queued = manager.start(
            request("queued", deadline=_now() + timedelta(milliseconds=150)),
            mutates_page=False,
        )
        terminal = _wait_for_manager_state(
            manager,
            queued.operation_id,
            lambda operation: operation.terminal,
            timeout=1,
        )

        assert terminal.state == "failed"
        assert terminal.terminal_reason == "operation_queue_deadline_exceeded"
        assert "cmd-queued" not in bridge_calls
        assert "operation.started" not in [
            event.event_type for event in manager.events(queued.operation_id)
        ]
    finally:
        bridge_release.set()
        manager.shutdown(wait=True)


def test_manager_propagates_bridge_timeout_beyond_five_seconds(tmp_path):
    captured = {}

    def bridge(_target, payload):
        captured.update(payload)
        return {"ok": True, "commandReceipt": {"ok": True}}

    client, manager, lease_store = _operation_client(tmp_path, bridge)
    lease_id = _claim_operation_lease(lease_store)
    try:
        response = client.post(
            "/api/c3/operations",
            json=_operation_api_payload(
                lease_id,
                deadline_at=(_now() + timedelta(seconds=120)).isoformat(),
            ),
        )
        _wait_for_state(client, response.json()["operation_id"], {"completed"}, lease_id)

        assert 100_000 <= captured["bridge_timeout_ms"] <= 120_000
    finally:
        manager.shutdown(wait=True)


def test_operation_bridge_payload_overwrites_reserved_fields_and_strips_nested_bypasses(
    tmp_path,
):
    captured = {}
    bridge_called = threading.Event()

    def bridge(_target, payload):
        captured.update(payload)
        bridge_called.set()
        return {"ok": True, "commandReceipt": {"ok": True}}

    client, manager, lease_store = _operation_client(tmp_path, bridge)
    lease_id = _claim_operation_lease(lease_store)
    try:
        response = client.post(
            "/api/c3/operations",
            json=_operation_api_payload(
                lease_id,
                allow_submit=True,
                capabilities=["c3.final_submit"],
                command_payload={
                    "operationId": "spoofed-operation",
                    "allowSubmit": True,
                    "triggeredBy": "spoofed-trigger",
                    "fillRunId": "spoofed-run",
                    "allowForeground": True,
                    "bringToFront": True,
                    "nested": {
                        "safe": "preserved",
                        "allow_foreground": True,
                        "operation_id": "nested-spoof",
                        "items": [
                            {
                                "bring_to_front": True,
                                "fill_run_id": "nested-run",
                                "ok": 1,
                            }
                        ],
                    },
                },
            ),
        )

        assert response.status_code == 202
        assert bridge_called.wait(timeout=1)
        assert captured["actor"] == {
            "type": "agent",
            "id": "agent-test",
            "surface": "mcp",
        }
        command_payload = captured["command_payload"]
        assert command_payload["operationId"] == captured["operation_id"]
        assert command_payload["allowSubmit"] is False
        assert command_payload["triggeredBy"] == "c3_operation_manager"
        assert "fillRunId" not in command_payload
        assert "allowForeground" not in command_payload
        assert "bringToFront" not in command_payload
        assert command_payload["nested"] == {
            "safe": "preserved",
            "items": [{"ok": 1}],
        }
    finally:
        manager.shutdown(wait=True)


def test_operation_rejects_browser_target_id_not_bound_to_session(tmp_path):
    client, manager, lease_store = _operation_client(
        tmp_path,
        lambda _target, _payload: {"ok": True, "commandReceipt": {"ok": True}},
    )
    lease_id = _claim_operation_lease(lease_store)
    try:
        response = client.post(
            "/api/c3/operations",
            json=_operation_api_payload(lease_id, browser_target_id="other-session"),
        )

        assert response.status_code == 400
        assert response.json()["detail"]["reason_code"] == "browser_target_mismatch"
    finally:
        manager.shutdown(wait=True)


def test_operation_requires_registered_browser_target(tmp_path):
    client, manager, lease_store = _operation_client(
        tmp_path,
        lambda _target, _payload: {"ok": True, "commandReceipt": {"ok": True}},
        register_target=False,
    )
    lease_id = _claim_operation_lease(lease_store)
    try:
        response = client.post(
            "/api/c3/operations",
            json=_operation_api_payload(lease_id),
        )

        assert response.status_code == 400
        assert response.json()["detail"]["reason_code"] == "browser_target_not_registered"
    finally:
        manager.shutdown(wait=True)


def test_operation_rejects_registered_target_without_authoritative_target_id(tmp_path):
    client, manager, lease_store = _operation_client(
        tmp_path,
        lambda _target, _payload: {"ok": True, "commandReceipt": {"ok": True}},
        register_target=False,
    )
    target_store = client.app.dependency_overrides[c3_commands.get_browser_target_store]()
    target_store.register(
        BrowserTargetRegister(
            session_id="session-test",
            agent_id="agent-test",
            lane_id="lane-test",
            browser_kind="chrome",
            debug_port=9222,
            extension_id="ext-test",
            options_url="chrome-extension://ext-test/src/options/options.html",
            tab_id=42,
            url="https://jobs.example/apply?source=LinkedIn",
            metadata={},
        )
    )
    lease_id = _claim_operation_lease(lease_store)
    try:
        response = client.post(
            "/api/c3/operations",
            json=_operation_api_payload(lease_id),
        )

        assert response.status_code == 400
        assert response.json()["detail"]["reason_code"] == ("browser_target_exact_identity_missing")
    finally:
        manager.shutdown(wait=True)


@pytest.mark.parametrize(
    ("target_agent_id", "target_lane_id", "status_code", "reason_code"),
    [
        ("agent-other", "lane-test", 403, "browser_target_owner_mismatch"),
        ("agent-test", "lane-other", 400, "browser_target_lane_mismatch"),
    ],
)
def test_operation_rejects_registered_target_owned_by_other_caller_or_lane(
    tmp_path,
    target_agent_id,
    target_lane_id,
    status_code,
    reason_code,
):
    client, manager, lease_store = _operation_client(
        tmp_path,
        lambda _target, _payload: {"ok": True, "commandReceipt": {"ok": True}},
        target_agent_id=target_agent_id,
        target_lane_id=target_lane_id,
    )
    lease_id = _claim_operation_lease(lease_store)
    try:
        response = client.post(
            "/api/c3/operations",
            json=_operation_api_payload(lease_id),
        )

        assert response.status_code == status_code
        assert response.json()["detail"]["reason_code"] == reason_code
    finally:
        manager.shutdown(wait=True)


def test_operation_rejects_caller_target_selector_spoof(tmp_path):
    bridge_called = threading.Event()
    client, manager, lease_store = _operation_client(
        tmp_path,
        lambda _target, _payload: bridge_called.set(),
    )
    lease_id = _claim_operation_lease(lease_store)
    try:
        payload = _operation_api_payload(lease_id)
        payload["target"]["debug_port"] = 9333
        response = client.post("/api/c3/operations", json=payload)

        assert response.status_code == 400
        assert response.json()["detail"]["reason_code"] == "browser_target_selector_mismatch"
        assert not bridge_called.is_set()
    finally:
        manager.shutdown(wait=True)


def test_operation_rejects_canonical_url_when_registered_target_has_query_identity(tmp_path):
    exact_url = "https://jobs.example/apply?source=LinkedIn"
    bridge_called = threading.Event()
    client, manager, lease_store = _operation_client(
        tmp_path,
        lambda _target, _payload: bridge_called.set(),
        register_target=False,
    )
    target_store = client.app.dependency_overrides[c3_commands.get_browser_target_store]()
    target_store.register(
        BrowserTargetRegister(
            session_id="session-test",
            agent_id="agent-test",
            lane_id="lane-test",
            browser_kind="chrome",
            debug_port=9222,
            extension_id="ext-test",
            options_url="chrome-extension://ext-test/src/options/options.html",
            tab_id=42,
            url=exact_url,
            metadata={"target_id": "target-job-42"},
        )
    )
    lease_id = _claim_operation_lease(lease_store)
    payload = _operation_api_payload(lease_id)
    payload["target"]["url"] = "https://jobs.example/apply"
    try:
        response = client.post("/api/c3/operations", json=payload)

        assert response.status_code == 400
        assert response.json()["detail"]["reason_code"] == "browser_target_selector_mismatch"
        assert response.json()["detail"]["selectors"] == ["url"]
        assert not bridge_called.is_set()
    finally:
        manager.shutdown(wait=True)


def test_operation_persists_exact_session_bound_browser_target_id(tmp_path):
    client, manager, lease_store = _operation_client(
        tmp_path,
        lambda _target, _payload: {"ok": True, "commandReceipt": {"ok": True}},
    )
    lease_id = _claim_operation_lease(lease_store)
    try:
        response = client.post(
            "/api/c3/operations",
            json=_operation_api_payload(lease_id),
        )

        assert response.status_code == 202
        assert response.json()["operation"]["browser_target_id"] == "session-test"
        assert response.json()["operation"]["target"]["debug_port"] == 9222
        assert response.json()["operation"]["target"]["extension_id"] == "ext-test"
        assert response.json()["operation"]["target"]["target_id"] == "target-job-42"
    finally:
        manager.shutdown(wait=True)


def test_second_session_mutation_conflicts_but_read_only_operation_is_allowed(tmp_path):
    release = threading.Event()

    def blocking_bridge(_target, _payload):
        assert release.wait(timeout=5)
        return {"ok": True, "commandReceipt": {"ok": True}}

    client, manager, lease_store = _operation_client(tmp_path, blocking_bridge)
    lease_id = _claim_operation_lease(lease_store)
    try:
        first = client.post("/api/c3/operations", json=_operation_api_payload(lease_id))
        assert first.status_code == 202

        second_payload = _operation_api_payload(
            lease_id, command_id="cmd-second", trace_id="trace-second"
        )
        second = client.post("/api/c3/operations", json=second_payload)
        assert second.status_code == 409
        assert second.json()["detail"]["reason_code"] == "session_mutation_in_progress"

        read_payload = _operation_api_payload(
            lease_id,
            command_name="c3.inspect_fields",
            command_id="cmd-read",
            trace_id="trace-read",
        )
        read = client.post("/api/c3/operations", json=read_payload)
        assert read.status_code == 202
        assert read.json()["operation_id"] != first.json()["operation_id"]
    finally:
        release.set()
        manager.shutdown(wait=True)


def test_cancel_retains_active_state_until_ack_and_retry_creates_child(tmp_path):
    fill_release = threading.Event()
    cancel_entered = threading.Event()
    cancel_release = threading.Event()

    def bridge(_target, payload):
        if payload["command_name"] == "c3.cancel_session":
            cancel_entered.set()
            assert cancel_release.wait(timeout=5)
            return {
                "ok": True,
                "cancelled": True,
                "acknowledged": True,
                "commandReceipt": {"ok": True, "reason": "cancel_acknowledged"},
            }
        assert fill_release.wait(timeout=5)
        return {"ok": True, "commandReceipt": {"ok": True}}

    client, manager, lease_store = _operation_client(tmp_path, bridge, max_workers=3)
    lease_id = _claim_operation_lease(lease_store)
    try:
        started = client.post("/api/c3/operations", json=_operation_api_payload(lease_id))
        operation_id = started.json()["operation_id"]
        _wait_for_state(client, operation_id, {"running"}, lease_id)

        early_retry = client.post(
            f"/api/c3/operations/{operation_id}/retry",
            json={
                "agent_id": "agent-test",
                "lease_id": lease_id,
                "command_id": "cmd-retry-early",
                "trace_id": "trace-retry-early",
            },
        )
        assert early_retry.status_code == 409

        cancel = client.post(
            f"/api/c3/operations/{operation_id}/cancel",
            json={"agent_id": "agent-test", "lease_id": lease_id, "reason": "test cancel"},
        )
        assert cancel.status_code == 202
        assert cancel.json()["operation"]["state"] == "cancelling"
        assert cancel_entered.wait(timeout=1)
        assert (
            client.get(
                f"/api/c3/operations/{operation_id}",
                params={"agent_id": "agent-test", "lease_id": lease_id},
            ).json()["operation"]["state"]
            == "cancelling"
        )

        conflict = client.post(
            "/api/c3/operations",
            json=_operation_api_payload(
                lease_id, command_id="cmd-during-cancel", trace_id="trace-during-cancel"
            ),
        )
        assert conflict.status_code == 409

        cancel_release.set()
        cancelled = _wait_for_state(client, operation_id, {"cancelled"}, lease_id)
        assert cancelled["cancel_acknowledged_at"]

        retry = client.post(
            f"/api/c3/operations/{operation_id}/retry",
            json={
                "agent_id": "agent-test",
                "lease_id": lease_id,
                "command_id": "cmd-retry",
                "trace_id": "trace-retry",
                "reason": "retry test",
            },
        )
        assert retry.status_code == 202
        assert retry.json()["operation_id"] != operation_id
        assert retry.json()["parent_operation_id"] == operation_id
        assert retry.json()["operation"]["parent_operation_id"] == operation_id
    finally:
        fill_release.set()
        cancel_release.set()
        manager.shutdown(wait=True)


def test_original_bridge_user_cancelled_response_reconciles_cancelling_operation(tmp_path):
    fill_entered = threading.Event()
    fill_release = threading.Event()

    def bridge(_target, payload):
        if payload["command_name"] == "c3.cancel_session":
            return {
                "ok": False,
                "cancelled": False,
                "commandReceipt": {"ok": False, "reason": "cancel_dispatch_failed"},
            }
        fill_entered.set()
        assert fill_release.wait(timeout=5)
        return {
            "ok": False,
            "stoppedReason": "user_cancelled",
            "commandReceipt": {"ok": False, "reason": "user_cancelled"},
        }

    client, manager, lease_store = _operation_client(tmp_path, bridge, max_workers=3)
    lease_id = _claim_operation_lease(lease_store)
    try:
        started = client.post("/api/c3/operations", json=_operation_api_payload(lease_id))
        operation_id = started.json()["operation_id"]
        assert fill_entered.wait(timeout=1)

        cancelled = client.post(
            f"/api/c3/operations/{operation_id}/cancel",
            json={"agent_id": "agent-test", "lease_id": lease_id, "reason": "test cancel"},
        )
        assert cancelled.status_code == 202
        _wait_for_manager_state(
            manager,
            operation_id,
            lambda current: current.state == "cancelling",
        )

        fill_release.set()
        terminal = _wait_for_state(client, operation_id, {"cancelled"}, lease_id)
        assert terminal["cancel_acknowledged_at"] is not None
        assert terminal["terminal_reason"] == "test cancel"
        event_types = [event.event_type for event in manager.events(operation_id)]
        assert "operation.cancel_acknowledged" in event_types
        assert "operation.cancelled" in event_types
        assert "operation.result_ignored_after_cancel" not in event_types
    finally:
        fill_release.set()
        manager.shutdown(wait=True)


@pytest.mark.parametrize(
    "cancel_body",
    [
        {"lease_id": "lease-placeholder", "reason": "missing agent"},
        {"agent_id": "agent-test", "reason": "missing lease"},
    ],
)
def test_cancel_requires_explicit_agent_and_lease(tmp_path, cancel_body):
    fill_release = threading.Event()

    def bridge(_target, _payload):
        assert fill_release.wait(timeout=5)
        return {"ok": True, "commandReceipt": {"ok": True}}

    client, manager, lease_store = _operation_client(tmp_path, bridge)
    lease_id = _claim_operation_lease(lease_store)
    if cancel_body.get("lease_id"):
        cancel_body["lease_id"] = lease_id
    try:
        started = client.post("/api/c3/operations", json=_operation_api_payload(lease_id))
        operation_id = started.json()["operation_id"]

        response = client.post(
            f"/api/c3/operations/{operation_id}/cancel",
            json=cancel_body,
        )

        assert response.status_code == 422
    finally:
        fill_release.set()
        manager.shutdown(wait=True)


def test_cancel_api_redispatches_only_when_explicit_after_failed_attempt(tmp_path):
    fill_release = threading.Event()
    cancel_count = 0

    def bridge(_target, payload):
        nonlocal cancel_count
        if payload["command_name"] == "c3.cancel_session":
            cancel_count += 1
            if cancel_count == 1:
                return {"ok": False, "reason": "temporary_cancel_bridge_failure"}
            return {
                "ok": True,
                "cancelled": True,
                "acknowledged": True,
                "commandReceipt": {"ok": True},
            }
        assert fill_release.wait(timeout=5)
        return {"ok": True, "commandReceipt": {"ok": True}}

    client, manager, lease_store = _operation_client(
        tmp_path,
        bridge,
        cancel_retry_backoff_seconds=0,
    )
    lease_id = _claim_operation_lease(lease_store)
    action = {
        "agent_id": "agent-test",
        "lease_id": lease_id,
        "reason": "retry cancel dispatch",
    }
    try:
        started = client.post("/api/c3/operations", json=_operation_api_payload(lease_id))
        operation_id = started.json()["operation_id"]
        first = client.post(f"/api/c3/operations/{operation_id}/cancel", json=action)
        first_attempt_id = first.json()["operation"]["cancel_attempt_id"]
        _wait_for_manager_state(
            manager,
            operation_id,
            lambda current: current.cancel_failed_at is not None,
        )

        idempotent = client.post(
            f"/api/c3/operations/{operation_id}/cancel",
            json=action,
        )
        assert idempotent.status_code == 202
        assert idempotent.json()["operation"]["cancel_attempt_id"] == first_attempt_id
        assert cancel_count == 1

        redispatch = client.post(
            f"/api/c3/operations/{operation_id}/cancel",
            json={**action, "redispatch": True},
        )
        assert redispatch.status_code == 202
        assert redispatch.json()["operation"]["cancel_attempt_id"] != first_attempt_id
        assert redispatch.json()["operation"]["cancel_attempt_count"] == 2
        _wait_for_state(client, operation_id, {"cancelled"}, lease_id)
    finally:
        fill_release.set()
        manager.shutdown(wait=True)


def test_retry_requires_explicit_agent_and_lease_instead_of_parent_defaults(tmp_path):
    client, manager, lease_store = _operation_client(
        tmp_path,
        lambda _target, _payload: {"ok": True, "commandReceipt": {"ok": True}},
    )
    lease_id = _claim_operation_lease(lease_store)
    try:
        started = client.post("/api/c3/operations", json=_operation_api_payload(lease_id))
        operation_id = started.json()["operation_id"]
        _wait_for_state(client, operation_id, {"completed"}, lease_id)

        missing_agent = client.post(
            f"/api/c3/operations/{operation_id}/retry",
            json={
                "lease_id": lease_id,
                "command_id": "cmd-missing-agent",
                "trace_id": "trace-missing-agent",
            },
        )
        missing_lease = client.post(
            f"/api/c3/operations/{operation_id}/retry",
            json={
                "agent_id": "agent-test",
                "command_id": "cmd-missing-lease",
                "trace_id": "trace-missing-lease",
            },
        )

        assert missing_agent.status_code == 422
        assert missing_lease.status_code == 422
    finally:
        manager.shutdown(wait=True)


def test_retry_rejects_cross_agent_and_lease_from_another_session(tmp_path):
    client, manager, lease_store = _operation_client(
        tmp_path,
        lambda _target, _payload: {"ok": True, "commandReceipt": {"ok": True}},
    )
    lease_id = _claim_operation_lease(lease_store)
    other_lease = lease_store.claim_session_mutation_lease(
        "lane-test",
        "session-other",
        Actor(type="agent", id="agent-test", surface="mcp"),
        ttl_seconds=60,
    ).lease.lease_id
    try:
        started = client.post("/api/c3/operations", json=_operation_api_payload(lease_id))
        operation_id = started.json()["operation_id"]
        _wait_for_state(client, operation_id, {"completed"}, lease_id)

        cross_agent = client.post(
            f"/api/c3/operations/{operation_id}/retry",
            json={
                "agent_id": "agent-other",
                "lease_id": lease_id,
                "command_id": "cmd-cross-agent",
                "trace_id": "trace-cross-agent",
            },
        )
        wrong_session = client.post(
            f"/api/c3/operations/{operation_id}/retry",
            json={
                "agent_id": "agent-test",
                "lease_id": other_lease,
                "command_id": "cmd-wrong-session",
                "trace_id": "trace-wrong-session",
            },
        )

        assert cross_agent.status_code == 403
        assert cross_agent.json()["detail"]["reason_code"] == "bad_actor"
        assert wrong_session.status_code == 400
        assert wrong_session.json()["detail"]["reason_code"] == "missing_lease"
    finally:
        manager.shutdown(wait=True)


def test_retry_after_cancel_ack_does_not_conflict_with_acknowledged_parent(tmp_path):
    operation_ids = iter(["op-parent", "op-child"])
    store = C3OperationStore(
        tmp_path / "ledger",
        id_factory=lambda: next(operation_ids),
        recover=False,
    )
    parent = store.create(
        C3OperationRequest(**_request_payload()),
        mutates_page=True,
    )
    store.append(parent.operation_id, "operation.started", {})
    store.append(parent.operation_id, "operation.cancel_requested", {"reason": "test"})
    store.append(parent.operation_id, "operation.cancel_acknowledged", {})
    manager = C3OperationManager(
        store,
        lease_store=object(),
        target_store=object(),
        bridge=lambda _target, _payload: {"ok": True, "commandReceipt": {"ok": True}},
        max_workers=2,
    )
    try:
        child = manager.retry(
            parent.operation_id,
            command_id="cmd-child",
            trace_id="trace-child",
            lease_id="lease-test",
            reason="retry after acknowledged cancellation",
        )

        assert child.parent_operation_id == parent.operation_id
        assert child.operation_id == "op-child"
    finally:
        manager.shutdown(wait=True)


def test_cancel_dispatch_uses_control_worker_when_operation_pool_is_saturated(tmp_path):
    operation_release = threading.Event()
    both_operations_started = threading.Event()
    cancel_dispatched = threading.Event()
    operation_count = 0
    count_lock = threading.Lock()

    def bridge(_target, payload):
        nonlocal operation_count
        if payload["command_name"] == "c3.cancel_session":
            cancel_dispatched.set()
            return {"ok": True, "commandReceipt": {"ok": True}}
        with count_lock:
            operation_count += 1
            if operation_count == 2:
                both_operations_started.set()
        assert operation_release.wait(timeout=5)
        return {"ok": True, "commandReceipt": {"ok": True}}

    store = C3OperationStore(tmp_path / "ledger", recover=False)
    manager = C3OperationManager(
        store,
        lease_store=object(),
        target_store=object(),
        bridge=bridge,
        max_workers=2,
    )
    try:
        first = manager.start(
            C3OperationRequest(**_request_payload(session_id="session-one")),
            mutates_page=True,
        )
        manager.start(
            C3OperationRequest(
                **_request_payload(
                    session_id="session-two",
                    command_id="cmd-two",
                    trace_id="trace-two",
                )
            ),
            mutates_page=True,
        )
        assert both_operations_started.wait(timeout=1)

        manager.cancel(first.operation_id, reason="saturation test")

        assert cancel_dispatched.wait(timeout=1)
    finally:
        operation_release.set()
        manager.shutdown(wait=True)


def test_shared_cancel_control_capacity_is_globally_bounded(tmp_path):
    operation_release = threading.Event()
    first_cancel_release = threading.Event()
    second_cancel_release = threading.Event()
    operations_started = threading.Event()
    first_cancel_started = threading.Event()
    second_cancel_started = threading.Event()
    third_cancel_started = threading.Event()
    operation_count = 0
    count_lock = threading.Lock()

    def bridge(_target, payload):
        nonlocal operation_count
        if payload["command_name"] == "c3.cancel_session":
            if payload["session_id"] == "session-one":
                first_cancel_started.set()
                assert first_cancel_release.wait(timeout=5)
            elif payload["session_id"] == "session-two":
                second_cancel_started.set()
                assert second_cancel_release.wait(timeout=5)
            else:
                third_cancel_started.set()
            return {"ok": True, "commandReceipt": {"ok": True}}
        with count_lock:
            operation_count += 1
            if operation_count == 3:
                operations_started.set()
        assert operation_release.wait(timeout=5)
        return {"ok": True, "commandReceipt": {"ok": True}}

    store = C3OperationStore(tmp_path / "ledger", recover=False)
    manager = C3OperationManager(
        store,
        lease_store=object(),
        target_store=object(),
        bridge=bridge,
        max_workers=3,
        control_workers=2,
        cancel_timeout_seconds=5,
    )
    try:
        first = manager.start(
            C3OperationRequest(**_request_payload(session_id="session-one")),
            mutates_page=True,
        )
        second = manager.start(
            C3OperationRequest(
                **_request_payload(
                    session_id="session-two",
                    command_id="cmd-two",
                    trace_id="trace-two",
                )
            ),
            mutates_page=True,
        )
        third = manager.start(
            C3OperationRequest(
                **_request_payload(
                    session_id="session-three",
                    command_id="cmd-three",
                    trace_id="trace-three",
                )
            ),
            mutates_page=True,
        )
        assert operations_started.wait(timeout=1)

        manager.cancel(first.operation_id, reason="cancel first")
        assert first_cancel_started.wait(timeout=1)
        manager.cancel(second.operation_id, reason="cancel second")
        assert second_cancel_started.wait(timeout=1)
        manager.cancel(third.operation_id, reason="cancel third")

        assert not third_cancel_started.wait(timeout=0.1)
        first_cancel_release.set()
        assert third_cancel_started.wait(timeout=1)
    finally:
        first_cancel_release.set()
        second_cancel_release.set()
        operation_release.set()
        manager.shutdown(wait=True)


def test_cancel_timeout_records_attempt_and_allows_explicit_redispatch_after_backoff(
    tmp_path,
):
    fill_release = threading.Event()
    first_cancel_release = threading.Event()
    second_cancel_started = threading.Event()
    cancel_count = 0
    count_lock = threading.Lock()

    def bridge(_target, payload):
        nonlocal cancel_count
        if payload["command_name"] == "c3.cancel_session":
            with count_lock:
                cancel_count += 1
                attempt_number = cancel_count
            if attempt_number == 1:
                assert first_cancel_release.wait(timeout=5)
            else:
                second_cancel_started.set()
            return {
                "ok": True,
                "cancelled": True,
                "acknowledged": True,
                "commandReceipt": {"ok": True},
            }
        assert fill_release.wait(timeout=5)
        return {"ok": True, "commandReceipt": {"ok": True}}

    store = C3OperationStore(tmp_path / "ledger", recover=False)
    manager = C3OperationManager(
        store,
        lease_store=object(),
        target_store=object(),
        bridge=bridge,
        max_workers=2,
        control_workers=2,
        cancel_timeout_seconds=0.05,
        cancel_retry_backoff_seconds=0.2,
    )
    operation = manager.start(C3OperationRequest(**_request_payload()), mutates_page=True)
    try:
        first = manager.cancel(operation.operation_id, reason="first attempt")
        first_attempt_id = first.cancel_attempt_id
        failed = _wait_for_manager_state(
            manager,
            operation.operation_id,
            lambda current: current.cancel_failed_at is not None,
        )
        assert failed.cancel_attempt_id == first_attempt_id
        assert failed.cancel_attempt_count == 1
        failed_events = [
            event
            for event in manager.events(operation.operation_id)
            if event.event_type == "operation.cancel_failed"
        ]
        assert failed_events[-1].payload["cancel_attempt_id"] == first_attempt_id
        assert "[REDACTED]" not in first_attempt_id

        with pytest.raises(C3OperationConflictError) as backoff:
            manager.cancel(operation.operation_id, reason="too soon", redispatch=True)
        assert backoff.value.reason_code == "cancel_backoff_active"

        time.sleep(0.22)
        redispatched = manager.cancel(
            operation.operation_id,
            reason="explicit redispatch",
            redispatch=True,
        )
        assert redispatched.cancel_attempt_id != first_attempt_id
        assert redispatched.cancel_attempt_count == 2
        assert second_cancel_started.wait(timeout=1)
        _wait_for_manager_state(
            manager,
            operation.operation_id,
            lambda current: current.state == "cancelled",
        )
    finally:
        first_cancel_release.set()
        fill_release.set()
        manager.shutdown(wait=True)


def test_hung_cancel_bridge_releases_shared_control_worker_and_late_ack_is_ignored(
    tmp_path,
):
    fill_release = threading.Event()
    cancel_entered = threading.Event()
    cancel_release = threading.Event()

    def bridge(_target, payload):
        if payload["command_name"] == "c3.cancel_session":
            cancel_entered.set()
            assert cancel_release.wait(timeout=5)
            return {
                "ok": True,
                "cancelled": True,
                "acknowledged": True,
                "commandReceipt": {"ok": True},
            }
        assert fill_release.wait(timeout=5)
        return {"ok": True, "commandReceipt": {"ok": True}}

    client, manager, lease_store = _operation_client(
        tmp_path,
        bridge,
        max_workers=2,
        control_workers=1,
        cancel_timeout_seconds=0.1,
    )
    lease_id = _claim_operation_lease(lease_store)
    try:
        started = client.post("/api/c3/operations", json=_operation_api_payload(lease_id))
        operation_id = started.json()["operation_id"]
        _wait_for_manager_state(
            manager,
            operation_id,
            lambda operation: operation.state == "running",
        )
        manager.cancel(operation_id, reason="test")
        assert cancel_entered.wait(timeout=1)
        timed_out = _wait_for_manager_state(
            manager,
            operation_id,
            lambda operation: operation.cancel_failed_at is not None,
            timeout=1,
        )

        assert timed_out.monitor_error["reason_code"] == "cancel_bridge_timeout"
        assert manager._control_executor.submit(lambda: "released").result(timeout=0.5) == (  # noqa: SLF001
            "released"
        )

        cancel_release.set()
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            event_types = [event.event_type for event in manager.events(operation_id)]
            if "operation.cancel_result_ignored" in event_types:
                break
            time.sleep(0.01)
        current = manager.get(operation_id)
        assert current.state == "cancelling"
        assert current.cancel_acknowledged_at is None
        assert "operation.cancel_result_ignored" in event_types
    finally:
        cancel_release.set()
        fill_release.set()
        manager.shutdown(wait=True)


def test_cancel_accepted_without_acknowledgement_remains_pending(tmp_path):
    fill_release = threading.Event()
    cancel_returned = threading.Event()

    def bridge(_target, payload):
        if payload["command_name"] == "c3.cancel_session":
            cancel_returned.set()
            return {
                "ok": True,
                "cancelled": True,
                "acknowledged": False,
                "commandReceipt": {"ok": True},
            }
        assert fill_release.wait(timeout=5)
        return {"ok": True, "commandReceipt": {"ok": True}}

    store = C3OperationStore(tmp_path / "ledger", recover=False)
    manager = C3OperationManager(
        store,
        lease_store=object(),
        target_store=object(),
        bridge=bridge,
        max_workers=2,
        control_workers=2,
        cancel_timeout_seconds=0.1,
    )
    operation = manager.start(C3OperationRequest(**_request_payload()), mutates_page=True)
    try:
        manager.cancel(operation.operation_id, reason="pending unwind")
        assert cancel_returned.wait(timeout=1)
        current = _wait_for_manager_state(
            manager,
            operation.operation_id,
            lambda candidate: any(
                event.event_type == "operation.cancel_pending"
                for event in manager.events(candidate.operation_id)
            ),
        )

        assert current.state == "cancelling"
        assert current.cancel_acknowledged_at is None
        assert current.cancel_failed_at is None
        manager._cancel_timed_out(  # exercise the timer callback losing the response race
            operation.operation_id,
            current.cancel_attempt_id,
            current.cancel_attempt_count,
        )
        assert manager.get(operation.operation_id).cancel_failed_at is None
    finally:
        fill_release.set()
        manager.shutdown(wait=True)
