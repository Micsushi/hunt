import json
import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKGROUND_PATH = REPO_ROOT / "executioner" / "src" / "background" / "index.js"


def run_node(script: str) -> dict:
    result = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def transition_source() -> str:
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index("function authDetectionChangedAfterAction(")
    end = source.index("class C3JobFillWorkflow", start)
    return source[start:end]


def test_wait_requires_repeated_application_observation_after_transient_shell():
    source = transition_source()
    script = f"""
        const vm = require("node:vm");
        const detections = [
          {{
            ok: true,
            pageKind: "unknown",
            phase: "unknown",
            href: "https://tenant.test/apply",
            title: "Join Today!",
            isAuthPage: false,
            authState: "unknown",
            authUiState: "unknown",
          }},
          {{
            ok: true,
            pageKind: "application_page",
            phase: "job_fill",
            href: "https://tenant.test/apply",
            title: "Reliability Engineering Intern",
            isAuthPage: false,
            authState: "unknown",
            authUiState: "unknown",
            currentStep: {{ current: 1, total: 4, title: "My Information" }},
          }},
          {{
            ok: true,
            pageKind: "application_page",
            phase: "job_fill",
            href: "https://tenant.test/apply",
            title: "Reliability Engineering Intern",
            isAuthPage: false,
            authState: "unknown",
            authUiState: "unknown",
            currentStep: {{ current: 1, total: 4, title: "My Information" }},
          }},
        ];
        const snapshots = [
          {{
            href: "https://tenant.test/apply",
            title: "Join Today!",
            documentReadyState: "complete",
            visibleValidationErrors: [],
          }},
          {{
            href: "https://tenant.test/apply",
            title: "Reliability Engineering Intern",
            documentReadyState: "complete",
            currentStep: {{ current: 1, total: 4, title: "My Information" }},
            visibleValidationErrors: [],
          }},
          {{
            href: "https://tenant.test/apply",
            title: "Reliability Engineering Intern",
            documentReadyState: "complete",
            currentStep: {{ current: 1, total: 4, title: "My Information" }},
            visibleValidationErrors: [],
          }},
        ];
        const readiness = [
          {{
            applicationFieldCount: 0,
            meaningfulControlCount: 0,
            finalSubmitVisible: false,
          }},
          {{
            applicationFieldCount: 8,
            meaningfulControlCount: 10,
            finalSubmitVisible: false,
            currentStep: {{ current: 1, total: 4, title: "My Information" }},
          }},
          {{
            applicationFieldCount: 8,
            meaningfulControlCount: 10,
            finalSubmitVisible: false,
            currentStep: {{ current: 1, total: 4, title: "My Information" }},
          }},
        ];
        const context = {{
          console,
          setTimeout,
          detectEmailVerificationCodePage: async () => ({{ ok: false }}),
          detectWorkflowForTab: async () => detections.shift(),
          getPageSnapshot: async () => snapshots.shift(),
          inspectApplicationFieldReadiness: async () => readiness.shift(),
        }};
        vm.createContext(context);
        vm.runInContext({json.dumps(source)}, context);
        (async () => {{
          const result = await context.waitForAuthActionTransitionForTab(1, {{
            beforeDetection: {{
              ok: true,
              pageKind: "auth_form",
              phase: "auth",
              href: "https://tenant.test/auth",
              isAuthPage: true,
              authState: "login",
              authUiState: "credential_form",
            }},
            beforeSnapshot: {{
              href: "https://tenant.test/auth",
              title: "Sign In",
              documentReadyState: "complete",
            }},
            timeoutMs: 200,
            intervalMs: 0,
          }});
          console.log(JSON.stringify(result));
        }})();
    """

    result = run_node(script)

    assert result["ok"] is True
    assert result["reason"] == "stable_page_state"
    assert result["detection"]["pageKind"] == "application_page"
    assert result["detection"]["currentStep"]["title"] == "My Information"
    assert result["readiness"]["applicationFieldCount"] == 8
    assert [sample["pageKind"] for sample in result["observationSamples"]] == [
        "unknown",
        "application_page",
        "application_page",
    ]


def test_authoritative_transition_beats_unsynchronized_transient_probe():
    source = transition_source()
    assert "function authoritativeAuthTransitionDetection(" in source
    script = f"""
        const vm = require("node:vm");
        const context = {{}};
        vm.createContext(context);
        vm.runInContext({json.dumps(source)}, context);
        const application = {{
          ok: true,
          pageKind: "application_page",
          phase: "job_fill",
          currentStep: {{ current: 1, total: 4, title: "My Information" }},
        }};
        const transient = {{
          ok: true,
          pageKind: "unknown",
          phase: "unknown",
          title: "Join Today!",
        }};
        const directUnavailable = {{
          ok: true,
          pageKind: "job_unavailable",
          phase: "unavailable",
        }};
        const stable = context.authoritativeAuthTransitionDetection({{
          ok: true,
          reason: "stable_page_state",
          detection: application,
        }});
        const direct = context.authoritativeAuthTransitionDetection({{
          ok: true,
          reason: "direct_terminal_observation",
          detection: directUnavailable,
        }});
        const timeout = context.authoritativeAuthTransitionDetection({{
          ok: false,
          reason: "timeout",
          detection: application,
        }});
        console.log(JSON.stringify({{ stable, direct, timeout, transient }}));
    """

    result = run_node(script)

    assert result["stable"]["pageKind"] == "application_page"
    assert result["stable"]["currentStep"]["title"] == "My Information"
    assert result["direct"]["pageKind"] == "job_unavailable"
    assert result["timeout"] is None
    assert result["transient"]["pageKind"] == "unknown"


def test_page_walk_uses_authoritative_transition_before_fallback_probe():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index("async function runV2PageWalkAfterFill(")
    end = source.index("function chooseBestV2ClearFrame", start)
    page_walk = source[start:end]

    assert "authoritativeAuthTransitionDetection(authTransition)" in page_walk
    assert re.search(
        r"authoritativeTransitionDetection\s*\|\|\s*"
        r"\(await detectWorkflowForTab\(tabId\)\)",
        page_walk,
    )
