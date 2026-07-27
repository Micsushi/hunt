import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKGROUND_PATH = REPO_ROOT / "executioner" / "src" / "background" / "index.js"


def _run_node(script: str) -> dict:
    result = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def _auth_action_boundary_source(source: str) -> str:
    sample_start = source.index("function compactAuthDetectionSample(")
    sample_end = source.index("async function clickAuthPrimaryActionForTab(", sample_start)
    candidate_start = source.index("function compactAuthActionCandidate(", sample_end)
    boundary_end = source.index("function createAuthTransitionDecisionFunction(", candidate_start)
    return source[sample_start:sample_end] + source[candidate_start:boundary_end]


def test_lane22_auth_surface_classifier_distinguishes_loading_partial_and_gateway():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    owner_start = source.index("function createC3WorkflowDetectionFunction()")
    classifier_start = source.index("    function classifyAuthSurface(", owner_start)
    classifier_end = source.index("\n    var bodyText =", classifier_start)
    classifier_source = source[classifier_start:classifier_end]
    script = f"""
      const vm = require("node:vm");
      const context = {{}};
      vm.createContext(context);
      vm.runInContext({json.dumps(classifier_source)}, context);
      const classify = context.classifyAuthSurface;
      const base = {{
        isWorkdayLoginPath: true,
        currentStepIsAuth: true,
        hasCreateAccount: true,
        hasSignIn: true,
        hasEmailSigninChoice: false,
        hasExplicitAuthGateway: false,
        hasCredentialLoginForm: false,
        emailCount: 0,
        passwordCount: 0,
        needsEmailLinkVerification: false,
      }};
      console.log(JSON.stringify({{
        loading: classify(base),
        partial: classify({{ ...base, emailCount: 1 }}),
        fullAma: classify({{
          ...base,
          emailCount: 1,
          passwordCount: 1,
          hasCredentialLoginForm: true,
        }}),
        gateway: classify({{
          ...base,
          currentStepIsAuth: false,
          hasCreateAccount: false,
          hasSignIn: false,
          hasEmailSigninChoice: true,
          hasExplicitAuthGateway: true,
        }}),
      }}));
    """

    payload = _run_node(script)

    assert payload["loading"] == {
        "authState": "login",
        "authUiState": "auth_loading",
    }
    assert payload["partial"] == {
        "authState": "login",
        "authUiState": "partial_credential_form",
    }
    assert payload["fullAma"] == {
        "authState": "login",
        "authUiState": "credential_form",
    }
    assert payload["gateway"] == {
        "authState": "login",
        "authUiState": "landing_choice",
    }


def test_lane22_auth_mutation_requires_two_matching_full_form_samples():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index("function authMutationReadiness(")
    end = source.index("async function stabilizeAuthDetectionBeforeMutation(", start)
    helper_source = source[start:end]
    script = f"""
      const vm = require("node:vm");
      const context = {{}};
      vm.createContext(context);
      vm.runInContext({json.dumps(helper_source)}, context);
      const evaluate = context.authMutationReadiness;
      const generation = {{
        schemaVersion: 1,
        id: "nav-ama-1",
        navigationStartMs: 123,
      }};
      const full = {{
        ok: true,
        isAuthPage: true,
        authState: "login",
        authUiState: "credential_form",
        hasCredentialLoginForm: true,
        emailCount: 1,
        passwordCount: 1,
        href: "https://albertamotorassociation.wd3.myworkdayjobs.com/en-US/AMA/login",
        documentGeneration: generation,
      }};
      console.log(JSON.stringify({{
        loading: evaluate({{ ...full, authUiState: "auth_loading", emailCount: 0, passwordCount: 0 }}),
        partial: evaluate({{ ...full, authUiState: "partial_credential_form", passwordCount: 0 }}),
        oneSample: evaluate(full),
        matching: evaluate(full, {{ ...full }}),
        changedGeneration: evaluate(full, {{
          ...full,
          documentGeneration: {{ ...generation, id: "nav-ama-2" }},
        }}),
      }}));
    """

    payload = _run_node(script)

    assert payload["loading"]["ready"] is False
    assert payload["loading"]["reason"] == "auth_surface_loading"
    assert payload["partial"]["ready"] is False
    assert payload["partial"]["reason"] == "auth_surface_partial"
    assert payload["oneSample"]["ready"] is False
    assert payload["oneSample"]["reason"] == "auth_credential_form_needs_second_sample"
    assert payload["matching"]["ready"] is True
    assert payload["matching"]["reason"] == "auth_credential_form_stable"
    assert payload["changedGeneration"]["ready"] is False
    assert payload["changedGeneration"]["reason"] == "auth_credential_form_changed"


def test_lane22_auth_stabilization_waits_through_transient_loading_before_mutation():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index("function authMutationReadiness(")
    end = source.index("async function clickAuthPrimaryActionForTab(", start)
    helper_source = source[start:end]
    script = f"""
      const vm = require("node:vm");
      const generation = {{
        schemaVersion: 1,
        id: "nav-ama-1",
        navigationStartMs: 123,
      }};
      const base = {{
        ok: true,
        isAuthPage: true,
        authState: "login",
        href: "https://albertamotorassociation.wd3.myworkdayjobs.com/en-US/AMA/login",
        documentGeneration: generation,
        frameId: 0,
      }};
      const sequence = [
        {{ ...base, authUiState: "partial_credential_form", emailCount: 1, passwordCount: 0 }},
        {{
          ...base,
          authUiState: "credential_form",
          hasCredentialLoginForm: true,
          emailCount: 1,
          passwordCount: 1,
        }},
        {{
          ...base,
          authUiState: "credential_form",
          hasCredentialLoginForm: true,
          emailCount: 1,
          passwordCount: 1,
        }},
      ];
      const context = {{
        detectWorkflowForTab: async () => sequence.shift(),
        setTimeout: (callback) => callback(),
      }};
      vm.createContext(context);
      vm.runInContext({json.dumps(helper_source)}, context);
      const initial = {{
        ...base,
        authUiState: "auth_loading",
        emailCount: 0,
        passwordCount: 0,
      }};
      context.stabilizeAuthDetectionBeforeMutation(1, initial).then((result) => {{
        console.log(JSON.stringify(result));
      }});
    """

    payload = _run_node(script)

    assert payload["ready"] is True
    assert payload["reason"] == "auth_credential_form_stable"
    assert payload["detection"]["authUiState"] == "credential_form"
    assert [sample["authUiState"] for sample in payload["samples"]] == [
        "auth_loading",
        "partial_credential_form",
        "credential_form",
        "credential_form",
    ]
    assert all(sample["sampledAt"].endswith("Z") for sample in payload["samples"])


def test_lane22_preflight_block_records_no_click_action_boundary():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    helper_source = _auth_action_boundary_source(source)
    script = f"""
      const vm = require("node:vm");
      const context = {{}};
      vm.createContext(context);
      vm.runInContext({json.dumps(helper_source)}, context);
      const generation = {{ id: "nav-ama-1" }};
      const credential = {{
        authState: "login",
        authUiState: "credential_form",
        documentGeneration: generation,
        frameId: 0,
        emailCount: 1,
        passwordCount: 1,
      }};
      const loading = {{
        ...credential,
        authUiState: "auth_loading",
        emailCount: 0,
        passwordCount: 0,
      }};
      const boundary = context.authActionBoundaryFromNextAction(
        {{
          clicked: false,
          reason: "auth_surface_loading",
          workflowDetection: credential,
          stabilizationSamples: [credential, loading],
        }},
        credential,
      );
      console.log(JSON.stringify(boundary));
    """

    payload = _run_node(script)

    assert payload == {
        "stage": "preflight_blocked",
        "preActionDetection": {
            "authState": "login",
            "authUiState": "credential_form",
            "documentGenerationId": "nav-ama-1",
            "frameId": 0,
            "emailCount": 1,
            "passwordCount": 1,
            "emailPopulated": False,
            "passwordPopulated": False,
        },
        "stabilization": {
            "reason": "auth_surface_loading",
            "sampleCount": 2,
            "samples": [
                {
                    "authState": "login",
                    "authUiState": "credential_form",
                    "documentGenerationId": "nav-ama-1",
                    "frameId": 0,
                    "emailCount": 1,
                    "passwordCount": 1,
                    "emailPopulated": False,
                    "passwordPopulated": False,
                },
                {
                    "authState": "login",
                    "authUiState": "auth_loading",
                    "documentGenerationId": "nav-ama-1",
                    "frameId": 0,
                    "emailCount": 0,
                    "passwordCount": 0,
                    "emailPopulated": False,
                    "passwordPopulated": False,
                },
            ],
        },
        "credentialCompleteness": {
            "emailVisible": False,
            "passwordVisible": False,
            "emailPopulated": False,
            "passwordPopulated": False,
        },
        "actionReceipt": {
            "attempted": False,
            "candidateProbePerformed": False,
            "clicked": False,
            "reason": "auth_surface_loading",
        },
    }


def test_failed_auth_click_boundary_names_the_selected_candidate():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    helper_source = _auth_action_boundary_source(source)
    script = f"""
      const vm = require("node:vm");
      const context = {{}};
      vm.createContext(context);
      vm.runInContext({json.dumps(helper_source)}, context);
      const boundary = context.authActionBoundaryFromNextAction(
        {{
          clicked: false,
          reason: "auth_primary_action_click_failed",
          workflowDetection: {{
            isAuthPage: true,
            authState: "login",
            authUiState: "credential_form",
            emailCount: 1,
            passwordCount: 1,
          }},
          candidate: {{
            tag: "button",
            role: "button",
            automationId: "signInSubmitButton",
            selector: "button[data-automation-id='signInSubmitButton']",
            label: "Sign In",
            disabled: false,
            clickable: true,
          }},
        }},
        {{}},
      );
      console.log(JSON.stringify(boundary));
    """

    payload = _run_node(script)

    assert payload["stage"] == "action_not_dispatched"
    assert payload["actionReceipt"] == {
        "attempted": True,
        "candidateProbePerformed": True,
        "clicked": False,
        "reason": "auth_primary_action_click_failed",
    }
    assert payload["candidate"] == {
        "tag": "button",
        "role": "button",
        "selector": "button[data-automation-id='signInSubmitButton']",
        "automationId": "signInSubmitButton",
        "label": "Sign In",
        "disabled": False,
        "clickable": True,
    }


def test_lane22_safe_next_never_owns_auth_and_clicked_auth_uses_auth_waiter():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    safe_next = source[
        source.index("async function clickSafeNextForTab(") : source.index(
            "async function maybeHandleSafeNextAfterFill("
        )
    ]
    page_walk = source[
        source.index("async function runV2PageWalkAfterFill(") : source.index(
            "function chooseBestV2ClearFrame"
        )
    ]

    auth_preflight = safe_next.index("const workflowDetection = await detectWorkflowForTab(tabId)")
    generic_probe = safe_next.index("let probe = await probeSafeNextForTab(tabId)")
    assert auth_preflight < generic_probe
    assert "workflowDetection?.isAuthPage" in safe_next[auth_preflight:generic_probe]

    clicked_branch = page_walk.index('nextAction.reason === "clicked_auth_primary_action"')
    generic_wait = page_walk.index("waitForPostNextSignalForTab(", clicked_branch)
    auth_wait = page_walk.index("waitForAuthActionTransitionForTab(", clicked_branch)
    generic_failure = page_walk.index('"page_did_not_advance_after_next"', clicked_branch)
    assert auth_wait < generic_wait
    assert auth_wait < generic_failure
    assert "preActionDetection" in page_walk[clicked_branch:generic_wait]
    assert "postActionDetection" in page_walk[clicked_branch:generic_wait]
    assert "candidate" in page_walk[clicked_branch:generic_wait]
    assert "lastAuthActionBoundary" in page_walk
    assert "authActionBoundary" in page_walk


def test_capture_contract_exposes_bounded_generation_and_rejects_mixed_documents():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index("function c3DocumentGenerationMetadata(")
    end = source.index("function createC3WorkflowDetectionFunction()", start)
    helper_source = source[start:end]
    script = f"""
      const vm = require("node:vm");
      const context = {{}};
      vm.createContext(context);
      vm.runInContext({json.dumps(helper_source)}, context);
      const metadata = context.c3DocumentGenerationMetadata({{
        timeOrigin: 123456.75,
        timing: {{ navigationStart: 999 }},
      }});
      const same = context.sameC3DocumentGeneration(
        {{ documentGeneration: metadata, frameId: 0 }},
        {{ documentGeneration: {{ ...metadata }}, frameId: 0 }},
        {{ documentGeneration: {{ ...metadata }}, frameId: 0 }},
      );
      const mixed = context.sameC3DocumentGeneration(
        {{ documentGeneration: metadata, frameId: 0 }},
        {{
          documentGeneration: {{ ...metadata, id: "nav-other" }},
          frameId: 0,
        }},
      );
      console.log(JSON.stringify({{ metadata, same, mixed }}));
    """

    payload = _run_node(script)

    assert payload["metadata"] == {
        "schemaVersion": 1,
        "id": "nav-2n9c",
        "navigationStartMs": 123456,
    }
    assert len(payload["metadata"]["id"]) <= 48
    assert payload["same"] is True
    assert payload["mixed"] is False

    assert (
        source.count(
            "c3DocumentGenerationMetadata(\n"
            '        typeof performance === "undefined" ? {} : performance,'
        )
        >= 3
    )
    snapshot_handler = source[
        source.index('case "hunt.apply.snapshot_page":') : source.index(
            'case "hunt.apply.inspect_fields":'
        )
    ]
    inspect_handler = source[
        source.index('case "hunt.apply.inspect_fields":') : source.index(
            'case "hunt.apply.inspect_validation":'
        )
    ]
    assert "captureCoherentPageEvidence(tabId)" in snapshot_handler
    assert "captureCoherence" in snapshot_handler
    assert "documentGeneration" in snapshot_handler
    assert "documentGeneration" in inspect_handler
