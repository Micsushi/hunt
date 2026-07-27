import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FIELD_PIPELINE = REPO_ROOT / "executioner/src/shared/v2/field-pipeline.js"
WORKDAY_FILL = REPO_ROOT / "executioner/src/ats/workday/fill-v2.js"
BACKGROUND = REPO_ROOT / "executioner/src/background/index.js"


def run_node(source: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", "-e", source],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def test_driver_evidence_tracker_is_bounded_structured_and_value_free():
    script = f"""
      const fs = require("node:fs");
      const vm = require("node:vm");
      const context = {{
        window: {{ __huntV2: {{}} }},
        console: {{ log() {{}} }},
        Date,
      }};
      vm.createContext(context);
      vm.runInContext(
        fs.readFileSync({json.dumps(str(FIELD_PIPELINE))}, "utf8"),
        context,
      );
      const tracker = context.window.__huntV2.driverEvidence;
      tracker.reset({{ fillRunId: "fill-1", operationId: "op-1" }});
      for (let index = 0; index < 25; index += 1) {{
        tracker.update({{
          phase: index === 24 ? "field_commit_wait" : "popup_options_wait",
          waitClass: index === 24 ? "field_commit" : "popup_options",
          awaitedOperation:
            index === 24
              ? "workday.settleWorkdayCommit"
              : "workday.waitForOptions",
          field: {{
            fieldId: "phone-country-code",
            descriptor: "Phone Country Code",
            uiModel: "combobox",
          }},
          lastCommittedState: {{
            committed: false,
            selected: false,
            checked: false,
            empty: true,
            validationVisible: true,
            reason: "commit_pending",
            rawValue: "candidate@example.test",
            text: "hunter2-secret-value",
            answer: "private-answer",
          }},
        }});
      }}
      const snapshot = tracker.snapshot();
      console.log(JSON.stringify(snapshot));
    """

    result = run_node(script)

    assert result.returncode == 0, result.stderr
    snapshot = json.loads(result.stdout)
    assert snapshot["phase"] == "field_commit_wait"
    assert snapshot["waitClass"] == "field_commit"
    assert snapshot["field"] == {
        "id": "phone-country-code",
        "label": "Phone Country Code",
        "type": "combobox",
    }
    assert snapshot["awaitedOperation"] == "workday.settleWorkdayCommit"
    assert snapshot["startedAt"]
    assert snapshot["lastProgressAt"]
    assert snapshot["capturedAt"]
    assert snapshot["elapsedMs"] >= 0
    assert len(snapshot["breadcrumbs"]) == 16
    assert snapshot["lastCommittedState"] == {
        "committed": False,
        "selected": False,
        "checked": False,
        "empty": True,
        "validationVisible": True,
        "reason": "commit_pending",
    }
    serialized = json.dumps(snapshot)
    assert "candidate@example.test" not in serialized
    assert "hunter2-secret-value" not in serialized
    assert "private-answer" not in serialized


def test_workday_return_timeout_includes_redacted_driver_and_page_state_snapshot():
    script = f"""
      const {{ pathToFileURL }} = require("node:url");
      (async () => {{
        const module = await import(
          pathToFileURL({json.dumps(str(WORKDAY_FILL))}).href
        );
        global.window = {{
          location: {{ href: "https://tenant.test/apply" }},
          __huntApplyUtils: {{ detectAuthState: () => "signed_in" }},
          __huntV2: {{
            fieldPipeline: {{
              runHuntV2Fill: () => new Promise(() => {{}}),
            }},
            driverEvidence: {{
              snapshot: () => ({{
                active: true,
                phase: "field_commit_wait",
                waitClass: "field_commit",
                field: {{
                  id: "phone-country-code",
                  label: "Phone Country Code",
                  type: "combobox",
                  rawValue: "candidate@example.test",
                }},
                awaitedOperation: "workday.settleWorkdayCommit",
                startedAt: "2026-07-26T17:00:00.000Z",
                lastProgressAt: "2026-07-26T17:00:04.000Z",
                elapsedMs: 5000,
                popupOwner: {{
                  id: "phone-country-listbox",
                  role: "listbox",
                  automationId: "promptOption",
                  controls: "phone-country-listbox",
                  text: "must-not-leak-popup-text",
                }},
                intendedOption: {{
                  label: "candidate@example.test",
                }},
                action: {{
                  method: "trusted_keyboard",
                  result: "failed",
                  reason: "secret=hunter2-secret-value",
                  answer: "private-answer",
                }},
                commitVerification: {{
                  verified: false,
                  selectedPillPresent: false,
                  backingValuePresent: false,
                  validationVisible: true,
                  reason: "token=super-secret-token",
                  rawValue: "must-not-leak-commit",
                }},
                lastCommittedState: {{
                  committed: false,
                  selected: false,
                  checked: false,
                  empty: true,
                  validationVisible: true,
                  reason: "commit_pending",
                  rawValue: "hunter2-secret-value",
                }},
                breadcrumbs: [
                  {{
                    phase: "popup_options_wait",
                    waitClass: "popup_options",
                    awaitedOperation: "workday.waitForOptions",
                    at: "2026-07-26T17:00:01.000Z",
                    answer: "private-answer",
                  }},
                ],
                recentFieldOutcomes: [
                  {{
                    at: "2026-07-26T17:00:04.000Z",
                    phase: "field_commit_checked",
                    field: {{
                      id: "source--source",
                      label: "How Did You Hear About Us?",
                      type: "combobox",
                    }},
                    popupOwner: {{
                      id: "source-listbox",
                      role: "listbox",
                      automationId: "promptOption",
                      controls: "source-listbox",
                    }},
                    intendedOption: {{ label: "LinkedIn" }},
                    action: {{
                      method: "trusted_keyboard",
                      result: "failed",
                      reason: "workday_commit_not_verified",
                    }},
                    commitVerification: {{
                      verified: false,
                      selectedPillPresent: false,
                      backingValuePresent: false,
                      validationVisible: true,
                      reason: "workday_commit_not_verified",
                    }},
                  }},
                ],
                token: "super-secret-token",
              }}),
            }},
          }},
          __huntApplyCancelledFillRunIds: [],
          __huntApplyFillCancelReasons: {{}},
        }};
        global.document = {{
          readyState: "complete",
          querySelectorAll: () => [],
          documentElement: {{ outerHTML: "<html><body></body></html>" }},
        }};
        global.getComputedStyle = () => ({{
          display: "block",
          visibility: "visible",
        }});
        global.chrome = {{
          runtime: {{ sendMessage() {{}} }},
        }};
        const fill = module.createWorkdayFillV2Function();
        const result = await fill({{
          fillRunId: "fill-timeout",
          settings: {{ workdayFillReturnTimeoutMs: 5 }},
        }});
        console.log(JSON.stringify(result));
      }})().catch((error) => {{
        console.error(error.stack || error.message || String(error));
        process.exitCode = 1;
      }});
    """

    result = run_node(script)

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    evidence = payload["timeoutEvidence"]
    assert evidence["reason"] == "workday_fill_return_timeout"
    assert evidence["timeoutMs"] == 5
    assert evidence["documentReadyState"] == "complete"
    assert evidence["pageTransitionObserved"] is False
    driver = evidence["driverInFlight"]
    assert driver["phase"] == "field_commit_wait"
    assert driver["waitClass"] == "field_commit"
    assert driver["field"] == {
        "id": "phone-country-code",
        "label": "Phone Country Code",
        "type": "combobox",
    }
    assert driver["awaitedOperation"] == "workday.settleWorkdayCommit"
    assert driver["startedAt"] == "2026-07-26T17:00:00.000Z"
    assert driver["lastProgressAt"] == "2026-07-26T17:00:04.000Z"
    assert driver["elapsedMs"] >= 5000
    assert driver["lastCommittedState"]["committed"] is False
    assert driver["breadcrumbs"][0]["waitClass"] == "popup_options"
    assert driver["popupOwner"] == {
        "id": "phone-country-listbox",
        "role": "listbox",
        "automationId": "promptOption",
        "controls": "phone-country-listbox",
    }
    assert driver["intendedOption"] == {"label": ""}
    assert driver["action"]["method"] == "trusted_keyboard"
    assert driver["action"]["result"] == "failed"
    assert driver["commitVerification"]["verified"] is False
    assert driver["recentFieldOutcomes"][0]["intendedOption"] == {"label": "LinkedIn"}
    serialized = json.dumps(evidence)
    assert "candidate@example.test" not in serialized
    assert "hunter2-secret-value" not in serialized
    assert "private-answer" not in serialized
    assert "super-secret-token" not in serialized


def test_workday_timeout_keeps_page_transition_separate_from_idle_driver_state():
    script = f"""
      const {{ pathToFileURL }} = require("node:url");
      (async () => {{
        const module = await import(
          pathToFileURL({json.dumps(str(WORKDAY_FILL))}).href
        );
        global.window = {{
          location: {{ href: "https://tenant.test/apply" }},
          __huntV2: {{
            fieldPipeline: {{
              runHuntV2Fill: () => new Promise(() => {{}}),
            }},
            driverEvidence: {{
              snapshot: () => ({{
                active: false,
                phase: "idle",
                waitClass: "idle",
                breadcrumbs: [],
              }}),
            }},
          }},
          __huntApplyCancelledFillRunIds: [],
          __huntApplyFillCancelReasons: {{}},
        }};
        global.document = {{
          readyState: "loading",
          querySelectorAll: () => [],
          documentElement: {{ outerHTML: "<html><body></body></html>" }},
        }};
        global.getComputedStyle = () => ({{
          display: "block",
          visibility: "visible",
        }});
        global.chrome = {{
          runtime: {{ sendMessage() {{}} }},
        }};
        const fill = module.createWorkdayFillV2Function();
        const result = await fill({{
          fillRunId: "fill-transition",
          settings: {{ workdayFillReturnTimeoutMs: 5 }},
        }});
        console.log(JSON.stringify(result.timeoutEvidence));
      }})().catch((error) => {{
        console.error(error.stack || error.message || String(error));
        process.exitCode = 1;
      }});
    """

    result = run_node(script)

    assert result.returncode == 0, result.stderr
    evidence = json.loads(result.stdout)
    assert evidence["pageTransitionObserved"] is True
    assert evidence["observedWaitState"] == "page_transition"
    assert evidence["driverInFlight"]["phase"] == "idle"
    assert evidence["driverInFlight"]["waitClass"] == "idle"


def test_page_walk_cancellation_preserves_sanitized_workday_timeout_evidence():
    script = f"""
      const fs = require("node:fs");
      const vm = require("node:vm");
      const source = fs.readFileSync({json.dumps(str(BACKGROUND))}, "utf8");
      const evidenceStart = source.indexOf("function pageWalkTimeoutEvidence(");
      const evidenceEnd = source.indexOf("function compactAuthActionCandidate", evidenceStart);
      const cancelledStart = source.indexOf("function fillCancelledResponse(");
      const cancelledEnd = source.indexOf("function fillNoProgressTimeoutResponse", cancelledStart);
      const context = {{}};
      vm.createContext(context);
      vm.runInContext(
        source.slice(evidenceStart, evidenceEnd) +
          "\\n" +
          source.slice(cancelledStart, cancelledEnd),
        context,
      );
      const timeoutEvidence = {{
        reason: "workday_fill_return_timeout",
        observedWaitState: "field_commit",
        driverInFlight: {{
          phase: "field_commit_wait",
          awaitedOperation: "workday.settleWorkdayCommit",
        }},
      }};
      const extracted = context.pageWalkTimeoutEvidence({{
        result: {{ timeoutEvidence }},
      }});
      const response = context.fillCancelledResponse(
        {{ activeApplyContext: {{}} }},
        "workday_fill_return_timeout",
        extracted,
      );
      console.log(JSON.stringify(response));
    """

    result = run_node(script)

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["cancelled"] is True
    assert payload["reason"] == "workday_fill_return_timeout"
    assert payload["timeoutEvidence"]["observedWaitState"] == "field_commit"
    assert payload["attempt"]["timeoutEvidence"] == payload["timeoutEvidence"]
    assert payload["result"]["timeoutEvidence"] == payload["timeoutEvidence"]
    background = BACKGROUND.read_text(encoding="utf-8")
    assert background.count("timeoutEvidence: pageWalkTimeoutEvidence(currentFill)") >= 2
