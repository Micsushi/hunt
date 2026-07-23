from __future__ import annotations

import json
import time

import pytest
from pydantic import ValidationError

from backend.c3_failure_context import (
    C3ElementEvidence,
    C3FailureContext,
    C3MonitorSummary,
    build_failure_context,
)


def _operation(**overrides):
    operation = {
        "operation_id": "op-fixture",
        "state": "failed",
        "terminal_reason": "extension_command_failed",
        "error": {"reason_code": "mutable_projection_must_not_win"},
        "artifact_ids": [],
        "updated_at": "2026-07-22T12:00:00Z",
    }
    operation.update(overrides)
    return operation


def _event(seq: int, event_type: str, payload: dict, *, event_id: str | None = None):
    return {
        "seq": seq,
        "event_id": event_id or f"evt-{seq}",
        "event_type": event_type,
        "operation_id": "op-fixture",
        "ts": f"2026-07-22T12:00:{seq:02d}Z",
        "payload": payload,
    }


def test_auth_redirect_keeps_exposing_action_but_has_no_causal_element():
    events = [
        _event(
            1,
            "operation.action_checkpoint",
            {
                "stage": "after",
                "action": "click",
                "element": {
                    "selector": "button[data-automation-id='createAccountSubmitButton']",
                    "role": "button",
                    "label": "Create Account",
                },
            },
        ),
        _event(
            2,
            "operation.failed",
            {
                "terminal_reason": "extension_command_failed",
                "error": {
                    "stoppedReason": "auth_create_account_to_signin_sink",
                    "stopDetails": {
                        "fromAuthState": "signup",
                        "toAuthState": "login",
                    },
                },
            },
            event_id="evt-auth-terminal",
        ),
        _event(
            3,
            "operation.health_probe_failed",
            {"error": {"reason_code": "page_probe_timeout"}},
        ),
    ]

    context = build_failure_context(_operation(), events)

    assert context.failure_scope == "navigation"
    assert context.root_cause_code == "auth_create_account_to_signin_sink"
    assert context.causal_element is None
    assert context.exposing_action is not None
    assert context.exposing_action.selector.endswith("createAccountSubmitButton']")
    assert context.last_touched_element == context.exposing_action
    assert context.authoritative_event_id == "evt-auth-terminal"
    assert context.root_cause_unknown is True
    assert context.confidence == "strong"
    assert "tenant_rejection_reason" in context.missing_evidence
    assert context.live_inspection_required is True


def test_cancelled_operation_retains_last_progress_field_without_blame():
    events = [
        _event(
            1,
            "operation.progress",
            {
                "phase": "fill",
                "field": {
                    "key": "input-4",
                    "label": "Email Address*",
                    "kind": "text",
                    "pending_action": "site_state_after_field",
                },
            },
        ),
        _event(
            2,
            "operation.cancelled",
            {"terminal_reason": "batch_supervisor_stall_or_deadline"},
        ),
    ]

    context = build_failure_context(
        _operation(state="cancelled", terminal_reason="batch_supervisor_stall_or_deadline"),
        events,
    )

    assert context.causal_element is None
    assert context.last_touched_element is not None
    assert context.last_touched_element.field_id == "input-4"
    assert context.last_touched_element.label == "Email Address*"


def test_post_auth_application_readiness_boundary_is_specific_but_honestly_unresolved():
    events = [
        _event(
            7,
            "operation.failed",
            {
                "error": {"stoppedReason": "application_fields_not_ready_after_auth"},
                "terminal_reason": "extension_command_failed",
            },
        )
    ]

    context = build_failure_context(_operation(), events)

    assert context.failure_scope == "navigation"
    assert context.root_cause_code == "application_fields_not_ready_after_auth"
    assert context.summary == (
        "Authentication completed, but application fields did not become ready."
    )
    assert context.expected_state == "Application fields become ready after authentication."
    assert context.observed_state == (
        "Authentication completed without exposing ready application fields."
    )
    assert context.causal_element is None
    assert context.confidence == "strong"
    assert context.root_cause_unknown is True
    assert context.missing_evidence == ["post_auth_readiness_reason"]
    assert context.live_inspection_required is True
    assert context.next_safe_action == "inspect_post_auth_readiness_evidence"


def test_missing_safe_next_control_is_specific_without_inventing_an_element():
    context = build_failure_context(
        _operation(error={"reason_code": "no_safe_next_button"}),
        [
            _event(
                1,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "error": {"reason_code": "no_safe_next_button"},
                },
            )
        ],
    )

    assert context.failure_scope == "navigation"
    assert context.root_cause_code == "no_safe_next_button"
    assert context.causal_element is None
    assert context.summary == "No safe Next or Continue control was available on the current page."
    assert context.expected_state == "A single safe non-submit navigation control is available."
    assert context.observed_state == "No safe Next or Continue candidate was retained."
    assert context.missing_evidence == ["page_readiness_or_navigation_candidates"]
    assert context.live_inspection_required is True
    assert context.next_safe_action == "inspect_page_readiness_without_mutation"


def test_auth_primary_action_not_found_exposes_stable_near_miss_without_blame():
    events = [
        _event(
            4,
            "operation.failed",
            {
                "terminal_reason": "extension_command_failed",
                "error": {
                    "reason_code": "auth_primary_action_not_found",
                    "failure_evidence": {
                        "stopped_reason": "auth_primary_action_not_found",
                        "stop_details": {
                            "auth_state": "login",
                            "auth_ui_state": "signin_gateway",
                        },
                        "terminal_step": {
                            "kind": "auth",
                            "reason_code": "auth_primary_action_not_found",
                        },
                        "near_miss_candidates": [
                            {
                                "tag": "a",
                                "role": "link",
                                "selector": (
                                    "a[data-automation-id='accessibilitySkipToMainContent']"
                                ),
                                "automation_id": "accessibilitySkipToMainContent",
                                "label": "Skip to main content",
                                "disabled": False,
                                "score": 500,
                                "rejection_reason": "not_an_auth_action",
                            },
                            {
                                "tag": "button",
                                "role": "button",
                                "selector": ("button[data-automation-id='SignInWithEmailButton']"),
                                "automation_id": "SignInWithEmailButton",
                                "label": "Sign in with email",
                                "disabled": False,
                                "score": 10,
                                "rejection_reason": "outside_active_auth_surface",
                            },
                            {
                                "tag": "button",
                                "role": "button",
                                "selector": (
                                    "button[data-automation-id='createAccountSubmitButton']"
                                ),
                                "automation_id": "createAccountSubmitButton",
                                "label": "Create Account",
                                "disabled": False,
                                "score": 40,
                                "rejection_reason": "blocked_by_captcha_gate",
                            },
                        ],
                    },
                },
            },
            event_id="evt-auth-action-missing",
        )
    ]

    context = build_failure_context(_operation(), events)

    assert context.failure_scope == "navigation"
    assert context.root_cause_code == "auth_primary_action_not_found"
    assert context.causal_element is None
    assert context.exposing_action is not None
    assert context.exposing_action.automation_id == "createAccountSubmitButton"
    assert context.expected_state == "A safe primary authentication action is selected."
    assert "blocked_by_captcha_gate" in context.observed_state
    assert context.confidence == "strong"
    assert context.root_cause_unknown is True
    assert context.missing_evidence == []
    assert context.live_inspection_required is False
    assert context.next_safe_action == "retry_stable_auth_gateway_candidate"


def test_auth_primary_action_missing_rejection_reason_requires_live_inspection():
    context = build_failure_context(
        _operation(),
        [
            _event(
                5,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "error": {
                        "reason_code": "auth_primary_action_not_found",
                        "failure_evidence": {
                            "near_miss_candidates": [
                                {
                                    "tag": "button",
                                    "role": "button",
                                    "selector": (
                                        "button[data-automation-id='SignInWithEmailButton']"
                                    ),
                                    "automation_id": "SignInWithEmailButton",
                                    "label": "Sign in with email",
                                    "score": 20,
                                }
                            ]
                        },
                    },
                },
            )
        ],
    )

    assert context.exposing_action is None
    assert context.root_cause_unknown is True
    assert context.missing_evidence == ["auth_candidate_rejection_reason"]
    assert context.live_inspection_required is True


def test_auth_primary_action_ignores_historical_candidate_without_rejection():
    context = build_failure_context(
        _operation(),
        [
            _event(
                5,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "error": {
                        "reason_code": "auth_primary_action_not_found",
                        "failure_evidence": {
                            "near_miss_candidates": [
                                {
                                    "tag": "button",
                                    "selector": "button[data-automation-id='signInLink']",
                                    "automation_id": "signInLink",
                                    "label": "Sign In",
                                    "score": 118,
                                },
                                {
                                    "tag": "div",
                                    "role": "button",
                                    "selector": "div[data-automation-id='click_filter']",
                                    "automation_id": "click_filter",
                                    "label": "Sign In",
                                    "score": 0,
                                    "rejection_reason": "unsafe_container",
                                },
                            ],
                            "terminal_step": {
                                "last_safe_candidate": {
                                    "automation_id": "signInLink",
                                    "label": "Sign In",
                                }
                            },
                        },
                    },
                },
            )
        ],
    )

    assert context.exposing_action is not None
    assert context.exposing_action.automation_id == "click_filter"
    assert "unsafe_container" in context.observed_state
    assert context.missing_evidence == []
    assert context.live_inspection_required is False


def test_auth_captcha_gate_has_typed_site_gate_context_and_candidate_reason():
    context = build_failure_context(
        _operation(),
        [
            _event(
                6,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "error": {
                        "reason_code": "auth_captcha_gate",
                        "failure_evidence": {
                            "terminal_step": {
                                "kind": "auth_captcha_gate",
                                "reason_code": "auth_captcha_gate",
                                "auth_state": "signup",
                                "auth_ui_state": "signup_form",
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
                                        "changed": True,
                                    },
                                ],
                            },
                            "near_miss_candidates": [
                                {
                                    "tag": "button",
                                    "role": "button",
                                    "selector": (
                                        "button[data-automation-id='createAccountSubmitButton']"
                                    ),
                                    "automation_id": "createAccountSubmitButton",
                                    "label": "Create Account",
                                    "score": 200,
                                    "rejection_reason": "submit_blocked_by_site_gate",
                                },
                                {
                                    "tag": "div",
                                    "role": "button",
                                    "selector": "div[data-automation-id='click_filter']",
                                    "automation_id": "click_filter",
                                    "label": "Captcha challenge",
                                    "score": 103,
                                    "rejection_reason": "captcha_challenge_not_verified",
                                },
                            ],
                        },
                    },
                },
                event_id="evt-auth-captcha-gate",
            )
        ],
    )

    assert context.failure_scope == "navigation"
    assert context.root_cause_code == "auth_captcha_gate"
    assert context.causal_element is None
    assert context.exposing_action is not None
    assert context.exposing_action.automation_id == "click_filter"
    assert context.expected_state == "The site authentication gate verifies the applicant."
    assert "captcha_challenge_not_verified" in context.observed_state
    assert context.summary == "A site captcha gate blocked authentication progress."
    assert context.confidence == "strong"
    assert context.root_cause_unknown is False
    assert context.missing_evidence == []
    assert context.live_inspection_required is False
    assert context.next_safe_action == "stop_for_site_auth_gate"
    assert context.evidence_event_ids == ["evt-auth-captcha-gate"]
    assert [item.model_dump() for item in context.credential_preparation] == [
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
            "changed": True,
        },
    ]


def test_auth_captcha_gate_without_candidate_reason_requests_live_inspection():
    context = build_failure_context(
        _operation(),
        [
            _event(
                7,
                "operation.failed",
                {
                    "error": {
                        "reason_code": "auth_captcha_gate",
                        "failure_evidence": {
                            "near_miss_candidates": [
                                {
                                    "selector": "div[data-automation-id='click_filter']",
                                    "automation_id": "click_filter",
                                    "label": "Captcha challenge",
                                    "score": 103,
                                }
                            ]
                        },
                    }
                },
            )
        ],
    )

    assert context.exposing_action is not None
    assert context.missing_evidence == ["auth_candidate_rejection_reason"]
    assert context.live_inspection_required is True


def test_auth_ui_cycle_detected_projects_complete_transition_evidence():
    history = [
        {
            "from_auth_state": "signup",
            "from_auth_ui_state": "landing_choice",
            "to_auth_state": "signup",
            "to_auth_ui_state": "signup_form",
            "observed_auth_state": "signup",
            "effective_auth_state": "signup",
            "candidate": {
                "selector": "button[data-automation-id='createAccountLink']",
                "automation_id": "createAccountLink",
                "label": "Create Account",
                "role": "button",
                "tag": "button",
            },
        },
        {
            "from_auth_state": "signup",
            "from_auth_ui_state": "signup_form",
            "to_auth_state": "login",
            "to_auth_ui_state": "credential_form",
            "candidate": {
                "selector": "button[data-automation-id='signInLink']",
                "automation_id": "signInLink",
                "label": "Sign In",
                "role": "button",
                "tag": "button",
            },
        },
        {
            "from_auth_state": "login",
            "from_auth_ui_state": "credential_form",
            "to_auth_state": "signup",
            "to_auth_ui_state": "signup_form",
            "candidate": {
                "selector": "button[data-automation-id='createAccountLink']",
                "automation_id": "createAccountLink",
                "label": "Create Account",
                "role": "button",
                "tag": "button",
            },
        },
    ]
    context = build_failure_context(
        _operation(),
        [
            _event(
                8,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "error": {
                        "reason_code": "auth_ui_cycle_detected",
                        "failure_evidence": {
                            "stopped_reason": "auth_ui_cycle_detected",
                            "stop_details": {
                                "cycle_period": 1,
                                "cycle_length": 2,
                            },
                            "terminal_step": {
                                "kind": "auth_ui_cycle_detected",
                                "reason_code": "auth_ui_cycle_detected",
                                "transition_count": 3,
                                "transition_history": history,
                            },
                        },
                    },
                },
                event_id="evt-auth-ui-cycle",
            )
        ],
    )

    assert context.failure_scope == "navigation"
    assert context.root_cause_code == "auth_ui_cycle_detected"
    assert context.causal_element is not None
    assert context.causal_element.automation_id == "createAccountLink"
    assert context.exposing_action == context.causal_element
    assert context.expected_state == "Authentication advances beyond the repeated UI states."
    assert "3 retained transitions" in context.observed_state
    assert "cycle period 1" in context.observed_state
    assert "cycle length 2" in context.observed_state
    assert "login/credential_form->signup/signup_form" in context.observed_state
    assert context.summary == "Authentication entered a repeated UI control loop."
    assert context.confidence == "strong"
    assert context.root_cause_unknown is False
    assert context.missing_evidence == []
    assert context.live_inspection_required is False
    assert context.next_safe_action == "stop_repeated_auth_ui_cycle"
    assert context.evidence_event_ids == ["evt-auth-ui-cycle"]


def test_auth_ui_cycle_summary_compacts_repeated_suffix_within_existing_text_bound():
    suffix = [
        {
            "from_auth_state": "signup",
            "from_auth_ui_state": "signup_form",
            "to_auth_state": "signup",
            "to_auth_ui_state": "landing_choice",
        },
        {
            "from_auth_state": "signup",
            "from_auth_ui_state": "landing_choice",
            "to_auth_state": "signup",
            "to_auth_ui_state": "signup_form",
        },
        {
            "from_auth_state": "signup",
            "from_auth_ui_state": "signup_form",
            "to_auth_state": "signup",
            "to_auth_ui_state": "signup_form",
        },
    ]
    context = build_failure_context(
        _operation(),
        [
            _event(
                14,
                "operation.failed",
                {
                    "error": {
                        "reason_code": "auth_ui_cycle_detected",
                        "failure_evidence": {
                            "stop_details": {
                                "cycle_period": 3,
                                "cycle_length": 6,
                            },
                            "terminal_step": {
                                "kind": "auth_ui_cycle_detected",
                                "transition_history": [*suffix, *suffix],
                            },
                        },
                    }
                },
            )
        ],
    )

    assert "6 retained transitions" in context.observed_state
    assert "repeating suffix of 3" in context.observed_state
    assert "signup/signup_form->signup/landing_choice" in context.observed_state
    assert "signup/landing_choice->signup/signup_form" in context.observed_state
    assert "[TRUNCATED]" not in context.observed_state
    assert len(context.observed_state) <= 500


def test_auth_cycle_marks_backend_clipped_history_and_reports_total_vs_retained():
    history = [
        {
            "from_auth_state": "signup",
            "from_auth_ui_state": f"step_{index}",
            "to_auth_state": "signup",
            "to_auth_ui_state": f"step_{index + 1}",
        }
        for index in range(8)
    ]
    context = build_failure_context(
        _operation(),
        [
            _event(
                15,
                "operation.failed",
                {
                    "error": {
                        "reason_code": "auth_ui_cycle_detected",
                        "failure_evidence": {
                            "stop_details": {"cycle_period": 2, "cycle_length": 4},
                            "terminal_step": {
                                "kind": "auth_ui_cycle_detected",
                                "transition_count": 10,
                                "transition_history": history,
                            },
                        },
                    }
                },
            )
        ],
    )

    assert context.evidence_truncated is True
    assert "10 total transitions" in context.observed_state
    assert "8 retained transitions" in context.observed_state


def test_auth_cycle_marks_raw_history_clipped_to_eight_without_explicit_count():
    history = [
        {
            "from_auth_state": "signup",
            "from_auth_ui_state": f"step_{index}",
            "to_auth_state": "signup",
            "to_auth_ui_state": f"step_{index + 1}",
        }
        for index in range(10)
    ]
    context = build_failure_context(
        _operation(),
        [
            _event(
                16,
                "operation.failed",
                {
                    "error": {
                        "reason_code": "auth_ui_cycle_detected",
                        "failure_evidence": {
                            "terminal_step": {
                                "kind": "auth_ui_cycle_detected",
                                "transition_history": history,
                            }
                        },
                    }
                },
            )
        ],
    )

    assert context.evidence_truncated is True
    assert "10 total transitions" in context.observed_state
    assert "8 retained transitions" in context.observed_state


def test_auth_flow_limit_with_history_is_an_evidenced_active_auth_loop():
    context = build_failure_context(
        _operation(),
        [
            _event(
                9,
                "operation.failed",
                {
                    "error": {
                        "reason_code": "auth_flow_limit_reached",
                        "failure_evidence": {
                            "stopped_reason": "auth_flow_limit_reached",
                            "terminal_step": {
                                "kind": "auth_chain_continue",
                                "last_safe_candidate": {
                                    "selector": ("button[data-automation-id='createAccountLink']"),
                                    "automation_id": "createAccountLink",
                                    "label": "Create Account",
                                },
                                "transition_history": [
                                    {
                                        "from_auth_state": "signup",
                                        "from_auth_ui_state": "landing_choice",
                                        "to_auth_state": "signup",
                                        "to_auth_ui_state": "signup_form",
                                        "candidate": {
                                            "selector": (
                                                "button[data-automation-id='createAccountLink']"
                                            ),
                                            "automation_id": "createAccountLink",
                                            "label": "Create Account",
                                        },
                                    },
                                    {
                                        "from_auth_state": "signup",
                                        "from_auth_ui_state": "signup_form",
                                        "to_auth_state": "signup",
                                        "to_auth_ui_state": "landing_choice",
                                        "candidate": {
                                            "selector": ("button[data-automation-id='signInLink']"),
                                            "automation_id": "signInLink",
                                            "label": "Sign In",
                                        },
                                    },
                                ],
                            },
                        },
                    }
                },
                event_id="evt-auth-flow-limit-history",
            )
        ],
    )

    assert context.failure_scope == "navigation"
    assert context.causal_element is not None
    assert context.causal_element.automation_id == "signInLink"
    assert context.exposing_action == context.causal_element
    assert context.confidence == "strong"
    assert context.root_cause_unknown is False
    assert context.missing_evidence == []
    assert context.live_inspection_required is False
    assert context.next_safe_action == "stop_active_auth_loop"
    assert "2 retained transitions" in context.observed_state


def test_auth_flow_limit_without_history_stays_unknown_and_requires_live_inspection():
    context = build_failure_context(
        _operation(),
        [
            _event(
                10,
                "operation.failed",
                {
                    "error": {
                        "reason_code": "auth_flow_limit_reached",
                        "failure_evidence": {
                            "stopped_reason": "auth_flow_limit_reached",
                            "stop_details": {
                                "auth_state": "signup",
                                "auth_ui_state": "signup_form",
                            },
                            "terminal_step": {
                                "kind": "auth_chain_continue",
                                "last_safe_candidate": {
                                    "selector": ("button[data-automation-id='createAccountLink']"),
                                    "automation_id": "createAccountLink",
                                    "label": "Create Account",
                                },
                            },
                        },
                    }
                },
            )
        ],
    )

    assert context.failure_scope == "unknown"
    assert context.causal_element is None
    assert context.exposing_action is None
    assert context.confidence == "unknown"
    assert context.root_cause_unknown is True
    assert "auth_transition_history" in context.missing_evidence
    assert context.live_inspection_required is True


def test_same_page_auth_limit_with_history_is_an_evidenced_active_auth_loop():
    context = build_failure_context(
        _operation(),
        [
            _event(
                11,
                "operation.failed",
                {
                    "error": {
                        "reason_code": "auth_same_page_attempt_limit_reached",
                        "failure_evidence": {
                            "stopped_reason": "auth_same_page_attempt_limit_reached",
                            "terminal_step": {
                                "kind": "auth_same_page_attempt_limit_reached",
                                "reason_code": "auth_same_page_attempt_limit_reached",
                                "last_safe_candidate": {
                                    "selector": (
                                        "button[data-automation-id='createAccountSubmitButton']"
                                    ),
                                    "automation_id": "createAccountSubmitButton",
                                    "label": "Create Account",
                                },
                                "transition_history": [
                                    {
                                        "from_auth_state": "signup",
                                        "from_auth_ui_state": "signup_form",
                                        "to_auth_state": "signup",
                                        "to_auth_ui_state": "signup_form",
                                        "candidate": {
                                            "selector": (
                                                "button[data-automation-id="
                                                "'createAccountSubmitButton']"
                                            ),
                                            "automation_id": ("createAccountSubmitButton"),
                                            "label": "Create Account",
                                        },
                                    }
                                ],
                            },
                        },
                    }
                },
                event_id="evt-same-page-limit-history",
            )
        ],
    )

    assert context.failure_scope == "navigation"
    assert context.root_cause_code == "auth_same_page_attempt_limit_reached"
    assert context.causal_element is not None
    assert context.causal_element.automation_id == "createAccountSubmitButton"
    assert context.exposing_action == context.causal_element
    assert context.confidence == "strong"
    assert context.root_cause_unknown is False
    assert context.missing_evidence == []
    assert context.live_inspection_required is False
    assert context.next_safe_action == "stop_active_auth_loop"
    assert "1 retained transitions" in context.observed_state


def test_same_page_auth_limit_without_history_stays_unknown_and_requires_inspection():
    context = build_failure_context(
        _operation(),
        [
            _event(
                12,
                "operation.failed",
                {
                    "error": {
                        "reason_code": "auth_same_page_attempt_limit_reached",
                        "failure_evidence": {
                            "stopped_reason": "auth_same_page_attempt_limit_reached",
                            "stop_details": {
                                "auth_state": "signup",
                                "auth_ui_state": "signup_form",
                            },
                            "terminal_step": {
                                "kind": "wait_after_auth_fields",
                                "reason_code": "still_on_auth_page",
                            },
                        },
                    }
                },
            )
        ],
    )

    assert context.failure_scope == "unknown"
    assert context.causal_element is None
    assert context.exposing_action is None
    assert context.confidence == "unknown"
    assert context.root_cause_unknown is True
    assert "auth_transition_history" in context.missing_evidence
    assert context.live_inspection_required is True


@pytest.mark.parametrize(
    "reason_code",
    ["auth_flow_limit_reached", "auth_same_page_attempt_limit_reached"],
)
def test_non_cycle_auth_limits_ignore_injected_cycle_metrics(reason_code):
    history = [
        {
            "from_auth_state": "signup",
            "from_auth_ui_state": "signup_form",
            "to_auth_state": "signup",
            "to_auth_ui_state": "landing_choice",
            "candidate": {
                "selector": "button[data-automation-id='signInLink']",
                "automation_id": "signInLink",
                "label": "Sign In",
            },
        }
    ]

    def context(*, include_cycle_metrics: bool):
        stop_details = {"auth_state": "signup", "auth_ui_state": "signup_form"}
        terminal_step = {
            "kind": reason_code,
            "reason_code": reason_code,
            "transition_history": history,
        }
        if include_cycle_metrics:
            stop_details.update({"cycle_period": 4, "cycle_length": 8})
            terminal_step.update({"cycle_period": 4, "cycle_length": 8})
        return build_failure_context(
            _operation(),
            [
                _event(
                    13,
                    "operation.failed",
                    {
                        "error": {
                            "reason_code": reason_code,
                            "failure_evidence": {
                                "stopped_reason": reason_code,
                                "stop_details": stop_details,
                                "terminal_step": terminal_step,
                            },
                        }
                    },
                    event_id="evt-non-cycle-auth-limit",
                )
            ],
        )

    baseline = context(include_cycle_metrics=False)
    injected = context(include_cycle_metrics=True)

    assert injected.model_dump(mode="json") == baseline.model_dump(mode="json")
    assert "cycle period" not in injected.observed_state
    assert "cycle length" not in injected.observed_state


def test_auth_signup_signin_loop_is_proven_without_causal_ui_element():
    context = build_failure_context(
        _operation(),
        [
            _event(
                8,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "error": {
                        "reason_code": "auth_signup_signin_loop",
                        "failure_evidence": {
                            "stop_details": {
                                "from_auth_state": "signup",
                                "to_auth_state": "login",
                                "transition_count": 2,
                            },
                            "terminal_step": {
                                "kind": "auth",
                                "reason_code": "auth_signup_signin_loop",
                            },
                        },
                    },
                },
            )
        ],
    )

    assert context.failure_scope == "navigation"
    assert context.root_cause_code == "auth_signup_signin_loop"
    assert context.causal_element is None
    assert (
        context.expected_state == "Authentication advances beyond the signup-to-signin transition."
    )
    assert context.observed_state == "Signup returned to Sign In more than once in one run."
    assert context.confidence == "proven"
    assert context.root_cause_unknown is False
    assert context.missing_evidence == []
    assert context.live_inspection_required is False
    assert context.next_safe_action == "stop_repeated_auth_transition"


def test_auth_signup_signin_loop_projects_terminal_last_safe_candidate():
    secret = "private-applicant-value"
    events = [
        _event(
            7,
            "operation.progress",
            {
                "field": {
                    "key": "input-4",
                    "label": "Email Address*",
                    "kind": "text",
                }
            },
        ),
        _event(
            8,
            "operation.failed",
            {
                "terminal_reason": "extension_command_failed",
                "error": {
                    "reason_code": "auth_signup_signin_loop",
                    "failure_evidence": {
                        "stopped_reason": "auth_signup_signin_loop",
                        "terminal_step": {
                            "kind": "auth_signup_signin_loop",
                            "reason_code": "auth_signup_signin_loop",
                            "transition_count": 2,
                            "last_safe_candidate": {
                                "tag": "div",
                                "role": "button",
                                "selector": (
                                    f"div[data-automation-id='click_filter'][value='{secret}']"
                                ),
                                "automation_id": "click_filter",
                                "label": "Create Account",
                                "disabled": False,
                                "score": 103,
                                "value": secret,
                            },
                        },
                    },
                },
            },
            event_id="evt-auth-loop-terminal",
        ),
    ]

    context = build_failure_context(_operation(), events)
    serialized = json.dumps(context.model_dump(mode="json"), sort_keys=True)

    assert context.failure_scope == "navigation"
    assert context.root_cause_code == "auth_signup_signin_loop"
    assert context.causal_element is not None
    assert context.causal_element.automation_id == "click_filter"
    assert context.causal_element.selector.endswith("[value='[REDACTED]']")
    assert context.last_touched_element == context.causal_element
    assert context.exposing_action == context.causal_element
    assert context.confidence == "proven"
    assert context.root_cause_unknown is False
    assert context.missing_evidence == []
    assert context.live_inspection_required is False
    assert context.evidence_event_ids == ["evt-auth-loop-terminal"]
    assert secret not in serialized
    assert '"value"' not in serialized


def test_auth_signup_signin_loop_does_not_overwrite_direct_terminal_elements():
    direct = {
        "selector": "button[data-automation-id='createAccountLink']",
        "automation_id": "createAccountLink",
        "label": "Create Account",
        "role": "button",
        "tag": "button",
    }
    context = build_failure_context(
        _operation(),
        [
            _event(
                9,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "error": {
                        "reason_code": "auth_signup_signin_loop",
                        "causal_element": direct,
                        "last_touched_element": direct,
                        "exposing_action": direct,
                        "failure_evidence": {
                            "terminal_step": {
                                "kind": "auth_signup_signin_loop",
                                "last_safe_candidate": {
                                    "selector": "div[data-automation-id='click_filter']",
                                    "automation_id": "click_filter",
                                    "label": "Create Account",
                                },
                            }
                        },
                    },
                },
            )
        ],
    )

    assert context.causal_element is not None
    assert context.causal_element.automation_id == "createAccountLink"
    assert context.last_touched_element == context.causal_element
    assert context.exposing_action == context.causal_element


def test_workday_runtime_not_ready_reports_empty_shell_not_missing_next():
    context = build_failure_context(
        _operation(),
        [
            _event(
                9,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "error": {
                        "reason_code": "workday_runtime_not_ready",
                        "failure_evidence": {
                            "stop_details": {
                                "root_present": True,
                                "root_child_count": 0,
                                "field_count": 0,
                                "validation_count": 0,
                                "safe_navigation_count": 0,
                            },
                            "terminal_step": {
                                "kind": "runtime_readiness",
                                "reason_code": "workday_runtime_not_ready",
                            },
                        },
                    },
                },
            )
        ],
    )

    assert context.failure_scope == "navigation"
    assert context.root_cause_code == "workday_runtime_not_ready"
    assert context.causal_element is None
    assert context.expected_state == (
        "Workday exposes an authentication, application, validation, or navigation surface."
    )
    assert (
        context.observed_state == "Workday root remained structurally empty after readiness wait."
    )
    assert context.confidence == "strong"
    assert context.root_cause_unknown is True
    assert context.missing_evidence == ["runtime_readiness_reason"]
    assert context.live_inspection_required is True
    assert context.next_safe_action == "retry_workday_runtime_readiness_without_mutation"


def test_workday_runtime_summary_satisfies_runtime_reason_evidence():
    context = build_failure_context(
        _operation(),
        [
            _event(
                10,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "error": {
                        "reason_code": "workday_runtime_not_ready",
                        "failure_evidence": {
                            "terminal_step": {
                                "kind": "safe_next",
                                "reason_code": "workday_runtime_not_ready",
                                "runtime_readiness": {
                                    "ok": False,
                                    "reason_code": "runtime_surface_timeout",
                                    "waited_ms": 2500,
                                    "probe": {
                                        "workday_host": True,
                                        "root_present": True,
                                        "root_child_count": 0,
                                        "ready_state": "complete",
                                        "visible_control_count": 0,
                                        "application_field_count": 0,
                                    },
                                },
                            }
                        },
                    },
                },
            )
        ],
    )

    assert context.root_cause_code == "workday_runtime_not_ready"
    assert context.missing_evidence == []


def test_missing_resume_is_setup_failure_with_relevant_upload_element():
    events = [
        _event(
            1,
            "operation.failed",
            {
                "terminal_reason": "extension_command_failed",
                "error": {
                    "manualReviewReasons": ["resume_upload:missing_resume_data"],
                    "causal_element": {
                        "selector": "button#resumeAttachments--attachments",
                        "role": "button",
                        "label": "Upload a file",
                        "page": "My Experience",
                    },
                },
            },
        )
    ]

    context = build_failure_context(_operation(), events)

    assert context.failure_scope == "setup"
    assert context.root_cause_code == "resume_upload_missing_data"
    assert context.causal_element is not None
    assert context.causal_element.selector == "button#resumeAttachments--attachments"
    assert context.expected_state == "Resume attachment committed before continuing."
    assert context.observed_state == "Required resume data was unavailable."
    assert context.confidence == "proven"
    assert context.root_cause_unknown is False
    assert context.live_inspection_required is False


def test_workday_commit_failure_uses_specific_action_evidence_over_generic_terminal_code():
    events = [
        _event(
            1,
            "operation.action_failed",
            {
                "reason_code": "workday_commit_not_verified",
                "expected_state": "Selected source committed to Workday backing state.",
                "observed_state": "Option click completed but no selected item appeared.",
                "causal_element": {
                    "selector": "input#source--source",
                    "role": "combobox",
                    "label": "How did you hear about us?",
                },
                "checkpoint_ids": ["checkpoint-before", "checkpoint-after"],
            },
            event_id="evt-action-failed",
        ),
        _event(
            2,
            "operation.failed",
            {
                "terminal_reason": "extension_command_failed",
                "error": {"reason_code": "extension_command_failed"},
                "evidence_event_ids": ["evt-action-failed"],
            },
            event_id="evt-generic-terminal",
        ),
    ]

    context = build_failure_context(_operation(), events, artifact_ids=("artifact-a",))

    assert context.failure_scope == "ui_element"
    assert context.root_cause_code == "workday_commit_not_verified"
    assert context.causal_element is not None
    assert context.causal_element.selector == "input#source--source"
    assert context.checkpoint_ids == ["checkpoint-before", "checkpoint-after"]
    assert context.evidence_event_ids == ["evt-action-failed", "evt-generic-terminal"]
    assert context.artifact_ids == ["artifact-a"]
    assert context.artifact_status == "completed"
    assert context.live_inspection_required is False


def test_field_prefixed_workday_commit_reason_normalizes_to_stable_code():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.action_failed",
                {
                    "reason_code": "source--source:workday_commit_not_verified",
                    "causal_element": {
                        "selector": "input#source--source",
                        "label": "Source",
                    },
                },
            ),
            _event(
                2,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "evidence_event_ids": ["evt-1"],
                },
            ),
        ],
    )

    assert context.root_cause_code == "workday_commit_not_verified"


def test_control_plane_cancellation_backoff_has_no_causal_ui_element():
    events = [
        _event(
            1,
            "operation.cancel_failed",
            {
                "reason": "cancel_bridge_failed",
                "retry_after": "2026-07-22T12:01:00Z",
                "last_touched_element": {
                    "selector": "button[data-automation-id='pageFooterNextButton']",
                    "label": "Save and Continue",
                },
            },
            event_id="evt-cancel-failed",
        ),
        _event(
            2,
            "operation.orphaned",
            {
                "terminal_reason": "control_plane_cancel_unreconciled",
                "error": {"reason_code": "control_plane_cancel_unreconciled"},
            },
            event_id="evt-orphaned",
        ),
    ]

    context = build_failure_context(
        _operation(state="orphaned", terminal_reason="wrong_projection_reason"), events
    )

    assert context.failure_scope == "control_plane"
    assert context.root_cause_code == "control_plane_cancel_unreconciled"
    assert context.causal_element is None
    assert context.last_touched_element is not None
    assert context.monitor_summary.cancel_failure_count == 1
    assert context.authoritative_event_id == "evt-orphaned"
    assert context.confidence == "proven"
    assert context.live_inspection_required is False


def test_unknown_failure_requests_live_inspection_only_when_evidence_is_missing():
    context = build_failure_context(
        _operation(error={"reason_code": "projection_only_error"}),
        [
            _event(
                1,
                "operation.failed",
                {"terminal_reason": "unexpected_error", "error": {"message": "boom"}},
            )
        ],
    )

    assert context.failure_scope == "unknown"
    assert context.root_cause_code == "unexpected_error"
    assert context.root_cause_unknown is True
    assert context.confidence == "unknown"
    assert context.causal_element is None
    assert "causal_evidence" in context.missing_evidence
    assert context.live_inspection_required is True


def test_causal_element_and_last_touched_element_do_not_alias():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.action_failed",
                {
                    "reason_code": "workday_commit_not_verified",
                    "causal_element": {
                        "selector": "input#source--source",
                        "label": "Source",
                    },
                    "last_touched_element": {
                        "selector": "button[data-automation-id='pageFooterNextButton']",
                        "label": "Save and Continue",
                    },
                },
            ),
            _event(
                2,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "evidence_event_ids": ["evt-1"],
                },
            ),
        ],
    )

    assert context.causal_element is not None
    assert context.last_touched_element is not None
    assert context.causal_element.selector == "input#source--source"
    assert "pageFooterNextButton" in context.last_touched_element.selector


def test_terminal_event_is_authoritative_over_mutable_projection_and_late_monitor_error():
    context = build_failure_context(
        _operation(
            terminal_reason="page_probe_timeout",
            error={"reason_code": "page_probe_timeout"},
        ),
        [
            _event(
                1,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "error": {"stoppedReason": "auth_create_account_to_signin_sink"},
                },
                event_id="evt-authoritative",
            ),
            _event(
                2,
                "operation.monitor_failed",
                {"error": {"reason_code": "page_probe_timeout"}},
                event_id="evt-monitor",
            ),
        ],
    )

    assert context.root_cause_code == "auth_create_account_to_signin_sink"
    assert context.authoritative_event_id == "evt-authoritative"
    assert context.monitor_summary.monitor_failure_count == 1
    assert context.monitor_summary.last_error_code == "page_probe_timeout"


def test_first_terminal_event_remains_authoritative_over_legacy_duplicate_terminal():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "error": {"stoppedReason": "auth_create_account_to_signin_sink"},
                    "expected_state": "Primary expected state.",
                    "observed_state": "Primary observed state.",
                },
                event_id="evt-primary-terminal",
            ),
            _event(
                2,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "error": {"reason_code": "workday_commit_not_verified"},
                    "expected_state": "Legacy duplicate expected state.",
                    "observed_state": "Legacy duplicate observed state.",
                },
                event_id="evt-legacy-duplicate-terminal",
            ),
        ],
    )

    assert context.authoritative_event_id == "evt-primary-terminal"
    assert context.root_cause_code == "auth_create_account_to_signin_sink"
    assert context.expected_state == "Primary expected state."
    assert context.observed_state == "Primary observed state."
    assert context.evidence_event_ids == ["evt-primary-terminal"]


def test_output_is_redaction_safe_and_models_reject_extra_fields():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.action_failed",
                {
                    "reason_code": "workday_commit_not_verified",
                    "observed_state": (
                        "password=hunter2 token=tok-secret contact alice@example.com"
                    ),
                    "causal_element": {
                        "selector": "input[value='hunter2']",
                        "label": "alice@example.com",
                    },
                },
            ),
            _event(
                2,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "evidence_event_ids": ["evt-1"],
                },
            ),
        ],
    )
    serialized = json.dumps(context.model_dump(mode="json"), sort_keys=True)

    assert "hunter2" not in serialized
    assert "tok-secret" not in serialized
    assert "alice@example.com" not in serialized
    assert "[REDACTED]" in serialized

    with pytest.raises(ValidationError):
        C3ElementEvidence(selector="#field", invented=True)
    with pytest.raises(ValidationError):
        C3FailureContext(
            operation_id="op-x",
            root_cause_code="unknown_failure",
            invented=True,
        )


def test_post_terminal_action_event_cannot_replace_authoritative_cause():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.failed",
                {
                    "terminal_reason": "unexpected_error",
                    "error": {"reason_code": "unexpected_error"},
                },
                event_id="evt-terminal",
            ),
            _event(
                2,
                "operation.action_failed",
                {
                    "reason_code": "workday_commit_not_verified",
                    "causal_element": {"selector": "input#poison", "label": "Late"},
                },
                event_id="evt-post-terminal-poison",
            ),
        ],
    )

    assert context.root_cause_code == "unexpected_error"
    assert context.failure_scope == "unknown"
    assert context.authoritative_event_id == "evt-terminal"
    assert "evt-post-terminal-poison" not in context.evidence_event_ids


def test_ordinary_after_checkpoint_cannot_be_promoted_to_causal_element():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.action_checkpoint",
                {
                    "stage": "after",
                    "reason_code": "workday_commit_not_verified",
                    "element": {
                        "selector": "input#source--source",
                        "label": "Source",
                    },
                    "last_touched_element": {
                        "selector": "button#next",
                        "label": "Next",
                    },
                },
            ),
            _event(
                2,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "evidence_event_ids": ["evt-1"],
                },
            ),
        ],
    )

    assert context.root_cause_code == "extension_command_failed"
    assert context.causal_element is None
    assert context.last_touched_element is not None
    assert context.last_touched_element.selector == "button#next"
    assert context.confidence in {"weak", "unknown"}
    assert context.root_cause_unknown is True


def test_failed_checkpoint_requires_direct_commit_or_validation_proof_for_causality():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.action_checkpoint",
                {
                    "stage": "failed",
                    "reason_code": "workday_commit_not_verified",
                    "element": {"selector": "input#without-proof", "label": "Source"},
                },
            ),
            _event(
                2,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "evidence_event_ids": ["evt-1"],
                },
            ),
        ],
    )

    assert context.causal_element is None


def test_unknown_terminal_element_without_commit_or_validation_proof_is_not_causal():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.failed",
                {
                    "terminal_reason": "unexpected_error",
                    "causal_element": {
                        "selector": "input#unproven",
                        "label": "Correlation only",
                    },
                },
            )
        ],
    )

    assert context.causal_element is None


@pytest.mark.parametrize(
    ("terminal_payload", "expected_scope"),
    [
        (
            {
                "terminal_reason": "extension_command_failed",
                "error": {"reason_code": "extension_command_failed"},
            },
            "extension",
        ),
        (
            {
                "terminal_reason": "http_500",
                "error": {"reason_code": "http_500"},
            },
            "external_server",
        ),
    ],
)
def test_generic_extension_and_http_failures_do_not_claim_underlying_cause(
    terminal_payload, expected_scope
):
    context = build_failure_context(_operation(), [_event(1, "operation.failed", terminal_payload)])

    assert context.failure_scope == expected_scope
    assert context.confidence in {"weak", "unknown"}
    assert context.root_cause_unknown is True


def test_structural_redaction_never_serializes_typed_password_address_or_answer_values():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.action_failed",
                {
                    "reason_code": "workday_commit_not_verified",
                    "action": "type hunter2 into answer field",
                    "typed_value": "hunter2",
                    "answer_value": "Yes-I-am-secret",
                    "address": "742 Evergreen Terrace",
                    "observed_state": "address: 742 Evergreen Terrace",
                    "causal_element": {
                        "selector": "input[name='address'][value='742 Evergreen Terrace']",
                        "label": "Home address: 742 Evergreen Terrace",
                        "autocomplete": "street-address",
                        "action": "type hunter2",
                    },
                },
            ),
            _event(
                2,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "evidence_event_ids": ["evt-1"],
                },
            ),
        ],
    )
    serialized = json.dumps(context.model_dump(mode="json"), sort_keys=True)

    for secret in (
        "hunter2",
        "Yes-I-am-secret",
        "742 Evergreen Terrace",
    ):
        assert secret not in serialized
    assert context.causal_element is not None
    assert context.causal_element.action == "type"
    assert "[REDACTED]" in serialized


def test_production_nested_field_action_failure_supplies_exact_causal_identity():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "error": {
                        "initialResult": {
                            "result": {
                                "interactionTrace": [
                                    {
                                        "eventType": "field.action.failed",
                                        "fieldId": "employment-country",
                                        "label": "Employment country",
                                        "uiModel": "combobox",
                                        "payload": {
                                            "fieldId": "employment-country",
                                            "label": "Employment country",
                                            "action": "fill",
                                            "committed": False,
                                            "reasonCode": "workday_commit_not_verified",
                                            "expectedState": "Expected private-selected-answer",
                                            "observedState": "Observed private-selected-answer",
                                        },
                                    }
                                ]
                            }
                        }
                    },
                },
                event_id="evt-terminal-production",
            )
        ],
    )

    assert context.root_cause_code == "workday_commit_not_verified"
    assert context.causal_element is not None
    assert context.causal_element.field_id == "employment-country"
    assert context.causal_element.label == "Employment country"
    assert context.expected_state
    assert context.observed_state
    assert context.confidence == "proven"
    assert context.root_cause_unknown is False
    assert "private-selected-answer" not in json.dumps(context.model_dump(mode="json"))


def test_models_are_strict_and_monitor_summary_is_typed():
    with pytest.raises(ValidationError):
        C3ElementEvidence(selector="#field", frame_id="7")
    with pytest.raises(ValidationError):
        C3FailureContext(operation_id="op-x", source_event_sequence="1")
    with pytest.raises(ValidationError):
        C3MonitorSummary(monitor_failure_count="1")
    with pytest.raises(ValidationError):
        C3MonitorSummary(invented=True)

    context = build_failure_context(
        _operation(), [_event(1, "operation.failed", {"terminal_reason": "unexpected_error"})]
    )
    assert isinstance(context.monitor_summary, C3MonitorSummary)


def test_direct_model_construction_redacts_secret_like_identity_text():
    element = C3ElementEvidence(
        selector="input[value='hunter2']",
        label="password=hunter2",
        action="type hunter2",
    )
    serialized = json.dumps(element.model_dump(mode="json"), sort_keys=True)

    assert "hunter2" not in serialized
    assert element.action == "type"
    assert "[REDACTED]" in serialized

    context = C3FailureContext(
        operation_id="op-redaction",
        observed_state="answer=Yes-I-am-secret",
        validation_messages=["address=742 Evergreen Terrace"],
    )
    context_json = json.dumps(context.model_dump(mode="json"), sort_keys=True)
    assert "Yes-I-am-secret" not in context_json
    assert "742 Evergreen Terrace" not in context_json


def test_artifact_status_uses_event_order_and_later_completion_wins():
    context = build_failure_context(
        _operation(),
        [
            _event(4, "operation.artifact_capture_completed", {"artifact_ids": ["a-1"]}),
            _event(1, "operation.artifact_capture_started", {}),
            _event(3, "operation.artifact_capture_partial", {"artifact_ids": ["a-1"]}),
            _event(2, "operation.artifact_capture_failed", {"reason_code": "timeout"}),
            _event(5, "operation.failed", {"terminal_reason": "unexpected_error"}),
        ],
    )

    assert context.artifact_ids == ["a-1"]
    assert context.artifact_status == "completed"


def test_explicit_artifact_partial_state_is_retained_without_completed_event():
    context = build_failure_context(
        _operation(),
        [
            _event(1, "operation.artifact_capture_started", {}),
            _event(2, "operation.artifact_capture_partial", {"artifact_ids": ["a-1"]}),
            _event(3, "operation.failed", {"terminal_reason": "unexpected_error"}),
        ],
    )

    assert context.artifact_ids == ["a-1"]
    assert context.artifact_status == "partial"


def test_repaired_correlated_action_failure_cannot_override_generic_terminal():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.action_failed",
                {
                    "action_id": "action-source",
                    "reason_code": "workday_commit_not_verified",
                    "causal_element": {"selector": "input#source", "label": "Source"},
                },
                event_id="evt-failed-action",
            ),
            _event(
                2,
                "operation.action_completed",
                {
                    "action_id": "action-source",
                    "proof": {"committed": True},
                },
                event_id="evt-repair-completed",
            ),
            _event(
                3,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "evidence_event_ids": ["evt-failed-action"],
                },
                event_id="evt-terminal",
            ),
        ],
    )

    assert context.root_cause_code == "extension_command_failed"
    assert context.causal_element is None
    assert "evt-failed-action" not in context.evidence_event_ids


def test_uncorrelated_old_action_failure_cannot_override_generic_terminal():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.action_failed",
                {
                    "action_id": "old-action",
                    "reason_code": "workday_commit_not_verified",
                    "causal_element": {"selector": "input#old", "label": "Old"},
                },
                event_id="evt-old-failure",
            ),
            _event(
                2,
                "operation.failed",
                {"terminal_reason": "extension_command_failed"},
                event_id="evt-terminal",
            ),
        ],
    )

    assert context.root_cause_code == "extension_command_failed"
    assert context.causal_element is None
    assert context.evidence_event_ids == ["evt-terminal"]


def test_specific_terminal_cannot_reuse_element_from_resolved_linked_failure():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.action_failed",
                {
                    "action_id": "action-source",
                    "reason_code": "workday_commit_not_verified",
                    "causal_element": {"selector": "input#source", "label": "Source"},
                },
                event_id="evt-failed-action",
            ),
            _event(
                2,
                "operation.action_completed",
                {
                    "action_id": "action-source",
                    "proof": {"committed": True},
                },
            ),
            _event(
                3,
                "operation.failed",
                {
                    "terminal_reason": "workday_commit_not_verified",
                    "evidence_event_ids": ["evt-failed-action"],
                },
            ),
        ],
    )

    assert context.root_cause_code == "workday_commit_not_verified"
    assert context.causal_element is None


def test_free_text_reason_and_secret_like_reason_code_never_become_machine_code():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.failed",
                {
                    "terminal_reason": "unexpected_error",
                    "reason": "password=hunter2 arbitrary failure sentence",
                    "error": {"reason_code": "answer=Yes-I-am-secret"},
                },
            )
        ],
    )
    serialized = json.dumps(context.model_dump(mode="json"), sort_keys=True)

    assert context.root_cause_code == "unexpected_error"
    assert "hunter2" not in serialized
    assert "Yes-I-am-secret" not in serialized


def test_nested_artifact_and_element_kind_cannot_replace_terminal_machine_code():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "artifact": {"kind": "screenshot"},
                    "element": {"kind": "browser_target_unreachable"},
                },
            )
        ],
    )

    assert context.root_cause_code == "extension_command_failed"
    assert context.failure_scope == "extension"


def test_all_serialized_string_and_list_fields_apply_redaction():
    context = C3FailureContext(
        diagnosis_id="diagnosis-password=hunter2",
        operation_id="op-password=hunter2",
        root_cause_code="password=hunter2",
        summary="password=hunter2",
        expected_state="answer=Yes-I-am-secret",
        observed_state="address=742 Evergreen Terrace",
        validation_messages=["password=hunter2"],
        evidence_event_ids=["evt-password=hunter2"],
        checkpoint_ids=["checkpoint-answer=Yes-I-am-secret"],
        artifact_ids=["artifact-address=742 Evergreen Terrace"],
        ruled_out=["password=hunter2"],
        missing_evidence=["answer=Yes-I-am-secret"],
        authoritative_event_id="evt-password=hunter2",
        authoritative_event_type="operation.password=hunter2",
        next_safe_action="password=hunter2",
        monitor_summary=C3MonitorSummary(last_error_code="password=hunter2"),
        generated_at="password=hunter2",
    )
    serialized = json.dumps(context.model_dump(mode="json"), sort_keys=True)

    assert "hunter2" not in serialized
    assert "Yes-I-am-secret" not in serialized
    assert "742 Evergreen Terrace" not in serialized


def test_generated_hex_event_id_is_not_mistaken_for_a_phone_number():
    event_id = "evt-a068b6538979487e90ced486b03b40b5"
    operation_id = f"op-{'a' * 32}"
    artifact_id = "artifact_a068b6538979487e90ced486b03b40b5"
    context = build_failure_context(
        _operation(operation_id=operation_id),
        [
            _event(
                1,
                "operation.failed",
                {"terminal_reason": "extension_command_failed"},
                event_id=event_id,
            )
        ],
        artifact_ids=[artifact_id],
    )

    assert context.operation_id == operation_id
    assert context.authoritative_event_id == event_id
    assert context.evidence_event_ids == [event_id]
    assert context.artifact_ids == [artifact_id]
    assert context.diagnosis_id.endswith(event_id)


def test_phone_like_prefixed_identifiers_are_not_treated_as_trusted_internal_ids():
    phone_like_event_id = "evt-3035551212"
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.failed",
                {"terminal_reason": "extension_command_failed"},
                event_id=phone_like_event_id,
            )
        ],
    )
    serialized = json.dumps(context.model_dump(mode="json"), sort_keys=True)

    assert phone_like_event_id not in serialized
    assert "3035551212" not in serialized
    assert "REDACTED" in context.authoritative_event_id
    assert "REDACTED" in context.evidence_event_ids[0]
    assert "REDACTED" in context.diagnosis_id


def test_artifact_iterables_are_materialized_once_and_deterministic():
    yielded: list[str] = []

    def artifact_generator():
        for artifact_id in ("artifact-b", "artifact-a"):
            yielded.append(artifact_id)
            yield artifact_id

    generated = build_failure_context(
        _operation(),
        [_event(1, "operation.failed", {"terminal_reason": "unexpected_error"})],
        artifact_ids=artifact_generator(),
    )
    scalar = build_failure_context(
        _operation(),
        [_event(1, "operation.failed", {"terminal_reason": "unexpected_error"})],
        artifact_ids="artifact-scalar",
    )
    unordered = build_failure_context(
        _operation(),
        [_event(1, "operation.failed", {"terminal_reason": "unexpected_error"})],
        artifact_ids={"artifact-z", "artifact-a", "artifact-m"},
    )

    assert yielded == ["artifact-b", "artifact-a"]
    assert generated.artifact_ids == ["artifact-b", "artifact-a"]
    assert scalar.artifact_ids == ["artifact-scalar"]
    assert unordered.artifact_ids == ["artifact-a", "artifact-m", "artifact-z"]


def test_infinite_artifact_iterable_consumes_only_cap_plus_one_and_marks_truncation():
    consumed: list[int] = []

    def infinite_artifacts():
        index = 0
        while True:
            consumed.append(index)
            yield f"artifact-{index:03d}"
            index += 1

    context = build_failure_context(
        _operation(),
        [_event(1, "operation.failed", {"terminal_reason": "unexpected_error"})],
        artifact_ids=infinite_artifacts(),
    )

    assert len(consumed) == 65
    assert len(context.artifact_ids) == 64
    assert context.artifact_ids[-1] == "artifact-063"
    assert context.evidence_truncated is True


def test_cyclic_artifact_iterable_sets_truncation_marker_without_recursing():
    cyclic_artifacts: list = []
    cyclic_artifacts.append(cyclic_artifacts)

    context = build_failure_context(
        _operation(),
        [_event(1, "operation.failed", {"terminal_reason": "unexpected_error"})],
        artifact_ids=cyclic_artifacts,
    )

    assert context.artifact_ids == []
    assert context.evidence_truncated is True


def test_cyclic_and_excessively_deep_payloads_are_bounded_and_marked_truncated():
    cycle: dict = {}
    cycle["self"] = cycle
    deep: dict = {}
    cursor = deep
    for _ in range(40):
        cursor["next"] = {}
        cursor = cursor["next"]
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.failed",
                {
                    "terminal_reason": "unexpected_error",
                    "cyclic_noise": cycle,
                    "deep_noise": deep,
                },
            )
        ],
    )

    assert context.root_cause_code == "unexpected_error"
    assert context.evidence_truncated is True


def test_failure_context_caps_all_evidence_collections_and_marks_truncation():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.failed",
                {
                    "terminal_reason": "unexpected_error",
                    "evidence_event_ids": [f"evt-{index}" for index in range(500)],
                    "checkpoint_ids": [f"checkpoint-{index}" for index in range(500)],
                    "validation_messages": [f"validation-{index}" for index in range(500)],
                },
            )
        ],
        artifact_ids=[f"artifact-{index}" for index in range(500)],
    )

    assert len(context.evidence_event_ids) <= 128
    assert len(context.checkpoint_ids) <= 64
    assert len(context.validation_messages) <= 32
    assert len(context.artifact_ids) <= 64
    assert context.evidence_truncated is True


def test_failure_context_bounds_500_event_work_and_truncates_deterministically():
    events = []
    for seq in range(1, 500):
        action_id = f"action-{seq // 2}"
        events.append(
            _event(
                seq,
                "operation.action_repaired" if seq % 2 == 0 else "operation.action_failed",
                {
                    "action_id": action_id,
                    "reason_code": "workday_commit_not_verified",
                },
            )
        )
    events.append(
        _event(
            500,
            "operation.failed",
            {
                "terminal_reason": "extension_command_failed",
                "action_id": "action-249",
            },
        )
    )

    started = time.perf_counter()
    first = build_failure_context(_operation(), events)
    elapsed = time.perf_counter() - started
    second = build_failure_context(_operation(), events)

    assert elapsed < 2.0
    assert first == second
    assert first.evidence_truncated is True
    assert first.authoritative_event_id == "evt-500"


def test_dynamic_css_selector_cannot_claim_proven_ui_root_cause():
    context = build_failure_context(
        _operation(),
        [
            _event(
                1,
                "operation.action_failed",
                {
                    "reason_code": "workday_commit_not_verified",
                    "causal_element": {
                        "selector": ".css-1a2b3c:nth-child(7)",
                        "label": "Source",
                        "document_id": "document-123",
                    },
                },
                event_id="evt-dynamic-element",
            ),
            _event(
                2,
                "operation.failed",
                {
                    "terminal_reason": "extension_command_failed",
                    "evidence_event_ids": ["evt-dynamic-element"],
                },
            ),
        ],
    )

    assert context.root_cause_code == "workday_commit_not_verified"
    assert context.causal_element is not None
    assert context.confidence in {"weak", "unknown"}
    assert context.root_cause_unknown is True
    assert "stable_causal_identity" in context.missing_evidence
    assert context.live_inspection_required is True
