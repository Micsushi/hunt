import json
import subprocess
from pathlib import Path

BACKGROUND_PATH = (
    Path(__file__).resolve().parents[1] / "executioner" / "src" / "background" / "index.js"
)


def _run_readiness_scenarios():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index("async function waitForApplicationFieldsReadyAfterAuth(")
    end = source.index("function compactStopDetails", start)
    function_source = source[start:end]
    script = f"""
      const vm = require("node:vm");

      async function runScenario(kind) {{
        let now = 0;
        let probeCalls = 0;
        let detectionCalls = 0;
        const progress = [];
        const debug = [];
        const context = {{
          Date: {{ now: () => now }},
          Promise,
          setTimeout: (callback, delayMs) => {{
            now += Math.max(0, Number(delayMs || 0));
            callback();
          }},
          isFillRunCancelled: () => kind === "cancel" && now >= 1300,
          inspectApplicationFieldReadiness: async () => {{
            probeCalls += 1;
            const base = {{
              ok: true,
              href:
                kind === "no_evidence"
                  ? "https://tenant.test/home"
                  : "https://tenant.wd3.myworkdayjobs.com/External/apply",
              title: "Careers",
              currentStep: null,
              readyState: "complete",
              loadingIndicatorVisible: kind === "hard_cap",
              meaningfulControlCount: 0,
              applicationFieldCount: 0,
              requiredApplicationFieldCount: 0,
              validationErrorCount: 0,
              finalSubmitVisible: false,
            }};
            if (kind === "late_ready" && now >= 1300) {{
              return {{
                ...base,
                title: "My Information",
                currentStep: {{ current: 1, total: 4, title: "My Information" }},
                meaningfulControlCount: 9,
                applicationFieldCount: 9,
                requiredApplicationFieldCount: 5,
              }};
            }}
            return base;
          }},
          detectWorkflowForTab: async () => {{
            detectionCalls += 1;
            if (kind === "same_auth") {{
              return {{
                ok: true,
                isAuthPage: true,
                authState: "login",
                authUiState: "credential_form",
                pageKind: "auth_form",
                href: "https://tenant.wd3.myworkdayjobs.com/External/login",
              }};
            }}
            if (
              kind === "detector_disagreement" ||
              (kind === "late_ready" && now >= 1300)
            ) {{
              return {{
                ok: true,
                isAuthPage: false,
                isJobFillPage: true,
                pageKind: "application_page",
                phase: "job_fill",
                href: "https://tenant.wd3.myworkdayjobs.com/External/apply",
                currentStep: {{ current: 1, total: 4, title: "My Information" }},
                workdayFieldCount: 9,
                finalSubmitVisible: false,
                stillLoading: false,
              }};
            }}
            return {{
              ok: true,
              isAuthPage: false,
              isJobFillPage: false,
              pageKind: "unknown",
              phase: "unknown",
              href:
                kind === "no_evidence"
                  ? "https://tenant.test/home"
                  : "https://tenant.wd3.myworkdayjobs.com/External/apply",
              stillLoading: kind === "hard_cap",
            }};
          }},
          showFillProgress: async (_tabId, message) => progress.push(message),
          sendDebugLog: async (event, payload) => debug.push({{ event, payload }}),
        }};
        vm.createContext(context);
        vm.runInContext({json.dumps(function_source)}, context);
        const result = await context.waitForApplicationFieldsReadyAfterAuth(7, {{
          fillRunId: "r4",
          pageLabel: "My Information page 1",
          timeoutMs: 1000,
          graceTimeoutMs: 1000,
          pollIntervalMs: 650,
        }});
        return {{
          result,
          now,
          probeCalls,
          detectionCalls,
          progress,
          debug,
        }};
      }}

      (async () => {{
        const output = {{}};
        for (const kind of [
          "late_ready",
          "detector_disagreement",
          "no_evidence",
          "cancel",
          "hard_cap",
          "same_auth",
        ]) {{
          output[kind] = await runScenario(kind);
        }}
        console.log(JSON.stringify(output));
      }})().catch((error) => {{
        console.error(error);
        process.exit(1);
      }});
    """
    result = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_r4_workday_apply_shell_can_become_ready_during_bounded_grace():
    scenarios = _run_readiness_scenarios()
    late = scenarios["late_ready"]

    assert late["result"]["ok"] is True
    assert late["result"]["reason"] == "application_fields_ready"
    assert late["result"]["graceApplied"] is True
    assert late["result"]["waitMs"] > 1000
    assert late["result"]["waitMs"] <= 2000
    assert late["result"]["probe"]["currentStep"]["title"] == "My Information"
    assert late["result"]["probe"]["applicationFieldCount"] == 9
    assert "workday_apply_route" in late["result"]["graceReasons"]
    assert len(late["result"]["observationSamples"]) >= 3


def test_r4_positive_workflow_detector_repairs_blank_field_probe():
    scenarios = _run_readiness_scenarios()
    disagreement = scenarios["detector_disagreement"]["result"]

    assert disagreement["ok"] is True
    assert disagreement["reason"] == "application_fields_ready"
    assert disagreement["stableReadyProbeCount"] == 2
    assert disagreement["applicationEvidenceSource"] == "workflow_detection"
    assert disagreement["probe"]["currentStep"]["title"] == "My Information"
    assert disagreement["probe"]["applicationFieldCount"] == 9


def test_r4_grace_requires_transition_evidence_and_honors_hard_cap():
    scenarios = _run_readiness_scenarios()
    no_evidence = scenarios["no_evidence"]
    hard_cap = scenarios["hard_cap"]

    assert no_evidence["result"]["ok"] is False
    assert no_evidence["result"]["reason"] == "application_fields_not_ready_after_auth"
    assert no_evidence["result"]["graceApplied"] is False
    assert no_evidence["result"]["waitMs"] == 1000

    assert hard_cap["result"]["ok"] is False
    assert hard_cap["result"]["reason"] == "application_fields_not_ready_after_auth"
    assert hard_cap["result"]["graceApplied"] is True
    assert hard_cap["result"]["waitMs"] == 2000
    assert hard_cap["now"] == 2000
    assert "loading_indicator" in hard_cap["result"]["graceReasons"]


def test_r4_cancellation_and_same_auth_page_still_short_circuit():
    scenarios = _run_readiness_scenarios()
    cancelled = scenarios["cancel"]["result"]
    same_auth = scenarios["same_auth"]["result"]

    assert cancelled["ok"] is False
    assert cancelled["reason"] == "user_cancelled"
    assert cancelled["graceApplied"] is True
    assert cancelled["waitMs"] == 1300

    assert same_auth["ok"] is False
    assert same_auth["reason"] == "still_on_auth_page"
    assert scenarios["same_auth"]["probeCalls"] == 1
    assert scenarios["same_auth"]["detectionCalls"] == 1
