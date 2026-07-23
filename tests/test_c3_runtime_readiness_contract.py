import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
READINESS_MODULE = REPO_ROOT / "executioner" / "src" / "background" / "runtime-readiness.js"
BACKGROUND = REPO_ROOT / "executioner" / "src" / "background" / "index.js"
ISSUE_REGISTRY = REPO_ROOT / "scripts" / "lib" / "c3_issue_registry.js"


def _classify(probe: dict) -> dict:
    script = f"""
      import {{ classifyWorkdayRuntimeProbe }} from {json.dumps(READINESS_MODULE.as_uri())};
      console.log(JSON.stringify(classifyWorkdayRuntimeProbe({json.dumps(probe)})));
    """
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(completed.stdout)


def _run_safe_next_after_runtime_wait(refreshed_probe: dict) -> dict:
    script = f"""
      const fs = require("node:fs");
      const vm = require("node:vm");
      const source = fs.readFileSync({json.dumps(str(BACKGROUND))}, "utf8");
      const start = source.indexOf("async function clickSafeNextForTab(");
      const end = source.indexOf("async function maybeHandleSafeNextAfterFill(", start);
      let probeCalls = 0;
      let clickExecutions = 0;
      const initialProbe = {{
        ok: false,
        available: false,
        reason: "no_safe_next_button",
        inputCount: 0,
        candidateCount: 0,
      }};
      const refreshedProbe = {json.dumps(refreshed_probe)};
      const context = {{
        console,
        chrome: {{
          scripting: {{
            async executeScript(input) {{
              if (input.args?.[0]?.click) {{
                clickExecutions += 1;
                return [{{
                  frameId: input.target.frameIds?.[0] || 0,
                  result: {{
                    ...refreshedProbe,
                    ok: true,
                    found: true,
                    clicked: true,
                    reason: "clicked_safe_next",
                  }},
                }}];
              }}
              throw new Error("unexpected_execute_script");
            }},
          }},
        }},
        withTimeout: async (promise) => await promise,
        createSafeNextFunction: () => function safeNextFixture() {{}},
        detectWorkdayRuntimeErrorForTab: async () => ({{ found: false }}),
        probeSafeNextForTab: async () => {{
          probeCalls += 1;
          return probeCalls === 1 ? initialProbe : refreshedProbe;
        }},
        detectWorkflowForTab: async () => ({{ isAuthPage: false }}),
        probeAuthPageForTab: async () => ({{ isAuthPage: false }}),
        detectWorkdayCatalogPageForTab: async () => ({{ isCatalogPage: false }}),
        recoverWorkdayRuntimeErrorForTab: async () => ({{ attempted: false }}),
        waitForSafeNextAvailabilityForTab: async () => ({{
          ok: false,
          reason: "safe_next_wait_timeout",
          waitedMs: 3500,
          probe: initialProbe,
        }}),
        inspectApplicationFieldReadiness: async () => ({{
          ok: true,
          workdayHost: true,
          rootPresent: true,
          rootChildCount: 0,
          inputCount: 0,
        }}),
        classifyWorkdayRuntimeProbe: () => ({{
          ready: false,
          reason: "workday_runtime_loading",
        }}),
        waitForWorkdayRuntimeSurface: async () => ({{
          ok: true,
          reason: "workday_runtime_surface_ready",
          waitedMs: 650,
          probe: {{ rootChildCount: 3, visibleControlCount: 1 }},
        }}),
        getPageSnapshot: async () => ({{ url: "https://example.test/apply" }}),
        waitForPostNextSignalForTab: async () => ({{ changed: true }}),
        postNextSignalHasPageChange: () => true,
        dispatchTrustedInput: async () => ({{ ok: true }}),
        logActivity: async () => null,
        showPageToast: async () => null,
        summarizeSafeNextResult: (result) => result.reason || "",
        describePageWalkStop: (reason) => reason,
      }};
      vm.createContext(context);
      vm.runInContext(source.slice(start, end), context);
      context.clickSafeNextForTab(17, {{ auto: true, triggeredBy: "runtime_test" }})
        .then((result) => console.log(JSON.stringify({{
          result,
          probeCalls,
          clickExecutions,
        }})))
        .catch((error) => {{
          console.error(error.stack || error.message || String(error));
          process.exitCode = 1;
        }});
    """
    completed = subprocess.run(
        ["node", "-e", script],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(completed.stdout)


def test_empty_workday_root_is_runtime_not_ready_not_missing_next():
    result = _classify(
        {
            "ok": True,
            "workdayHost": True,
            "rootPresent": True,
            "rootChildCount": 0,
            "readyState": "complete",
            "bodyHead": "Careers Privacy Terms",
            "currentStep": None,
            "loadingIndicatorVisible": False,
            "visibleControlCount": 0,
            "applicationFieldCount": 0,
            "validationErrorCount": 0,
            "finalSubmitVisible": False,
        }
    )

    assert result == {
        "ready": False,
        "empty": True,
        "reason": "workday_runtime_not_ready",
    }


def test_rendered_surface_is_not_classified_as_empty_runtime():
    result = _classify(
        {
            "ok": True,
            "workdayHost": True,
            "rootPresent": True,
            "rootChildCount": 4,
            "readyState": "complete",
            "bodyHead": "My Information",
            "currentStep": {"title": "My Information"},
            "loadingIndicatorVisible": False,
            "visibleControlCount": 3,
            "applicationFieldCount": 2,
            "validationErrorCount": 0,
            "finalSubmitVisible": False,
        }
    )

    assert result["ready"] is True
    assert result["empty"] is False
    assert result["reason"] == "workday_runtime_surface_ready"


def test_loading_workday_surface_remains_not_ready_until_rendered():
    result = _classify(
        {
            "ok": True,
            "workdayHost": True,
            "rootPresent": True,
            "rootChildCount": 0,
            "readyState": "interactive",
            "bodyHead": "",
            "currentStep": None,
            "loadingIndicatorVisible": True,
            "visibleControlCount": 0,
            "applicationFieldCount": 0,
            "validationErrorCount": 0,
            "finalSubmitVisible": False,
        }
    )

    assert result == {
        "ready": False,
        "empty": False,
        "reason": "workday_runtime_loading",
    }


def test_blank_non_workday_page_is_not_given_workday_failure_reason():
    result = _classify(
        {
            "ok": True,
            "workdayHost": False,
            "rootPresent": False,
            "rootChildCount": 0,
            "readyState": "complete",
            "bodyHead": "",
            "currentStep": None,
            "loadingIndicatorVisible": False,
            "visibleControlCount": 0,
            "applicationFieldCount": 0,
            "validationErrorCount": 0,
            "finalSubmitVisible": False,
        }
    )

    assert result == {
        "ready": True,
        "empty": False,
        "reason": "non_workday_surface",
    }


def test_safe_next_flow_waits_for_runtime_surface_before_missing_next():
    background = BACKGROUND.read_text(encoding="utf-8")

    assert "async function waitForWorkdayRuntimeSurface" in background
    assert 'reason: "workday_runtime_not_ready"' in background
    assert "runtimeReadiness" in background
    assert "classifyWorkdayRuntimeProbe" in background
    assert "terminalStep: steps.length ? steps[steps.length - 1] : null" in background
    assert "workdayHost" in background
    assert "rootPresent" in background
    assert "rootChildCount" in background


def test_safe_next_reprobes_and_clicks_when_runtime_surface_finishes_rendering():
    output = _run_safe_next_after_runtime_wait(
        {
            "ok": True,
            "available": True,
            "found": True,
            "frameId": 0,
            "reason": "safe_next_available",
            "inputCount": 0,
            "candidateCount": 1,
            "candidate": {"label": "Next", "score": 100},
        }
    )

    assert output["probeCalls"] == 2
    assert output["clickExecutions"] == 1
    assert output["result"]["clicked"] is True
    assert output["result"]["reason"] == "clicked_safe_next"


def test_safe_next_reprobe_keeps_newly_rendered_final_submit_blocked():
    output = _run_safe_next_after_runtime_wait(
        {
            "ok": False,
            "available": False,
            "found": False,
            "reason": "final_submit_visible",
            "inputCount": 0,
            "candidateCount": 0,
            "blockedFinalSubmitLabels": ["Submit"],
        }
    )

    assert output["probeCalls"] == 2
    assert output["clickExecutions"] == 0
    assert output["result"]["clicked"] is False
    assert output["result"]["reason"] == "final_submit_visible"


def test_issue_registry_keeps_new_typed_reasons_specific():
    registry = ISSUE_REGISTRY.read_text(encoding="utf-8")

    assert "/auth_signup_signin_loop/i" in registry
    assert 'return "auth_signup_signin_loop"' in registry
    assert "/workday_runtime_not_ready/i" in registry
    assert 'return "workday_runtime_not_ready"' in registry
