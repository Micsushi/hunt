import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FIELD_PIPELINE = REPO_ROOT / "executioner/src/shared/v2/field-pipeline.js"
BACKGROUND = REPO_ROOT / "executioner/src/background/index.js"
WORKDAY_DRIVERS = REPO_ROOT / "executioner/src/ats/workday/workday-drivers-v2.js"


def run_node(source: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", "-e", source],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def test_driver_evidence_keeps_safe_source_mechanism_and_redacts_sensitive_options():
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
      tracker.update({{
        phase: "popup_options_wait",
        waitClass: "popup_options",
        awaitedOperation: "workday.waitForOptions",
        field: {{
          fieldId: "source--source",
          descriptor: "How Did You Hear About Us?",
          uiModel: "combobox",
        }},
        popupOwner: {{
          id: "source-listbox",
          role: "listbox",
          automationId: "promptOption",
          controls: "source-listbox",
          text: "must-not-leak-popup-text",
        }},
        intendedOption: {{ label: "LinkedIn", safe: true }},
        action: {{
          method: "trusted_keyboard",
          result: "attempted",
          reason: "option_keyboard",
        }},
      }});
      tracker.update({{
        phase: "field_commit_checked",
        field: {{
          fieldId: "source--source",
          descriptor: "How Did You Hear About Us?",
          uiModel: "combobox",
        }},
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
          rawValue: "must-not-leak-raw-value",
        }},
        lastCommittedState: {{
          committed: false,
          empty: true,
          validationVisible: true,
          reason: "workday_commit_not_verified",
        }},
      }});
      tracker.update({{
        phase: "field_commit_checked",
        field: {{
          fieldId: "email",
          descriptor: "Email Address",
          uiModel: "text",
        }},
        intendedOption: {{
          label: "candidate@example.test",
          safe: true,
        }},
        action: {{
          method: "input",
          result: "failed",
          reason: "secret=hunter2",
        }},
        commitVerification: {{
          verified: false,
          reason: "token=super-secret-token",
        }},
      }});
      console.log(JSON.stringify(tracker.snapshot()));
    """

    result = run_node(script)

    assert result.returncode == 0, result.stderr
    snapshot = json.loads(result.stdout)
    assert len(snapshot["recentFieldOutcomes"]) == 2
    source = snapshot["recentFieldOutcomes"][0]
    assert source["field"] == {
        "id": "source--source",
        "label": "How Did You Hear About Us?",
        "type": "combobox",
    }
    assert source["popupOwner"] == {
        "id": "source-listbox",
        "role": "listbox",
        "automationId": "promptOption",
        "controls": "source-listbox",
    }
    assert source["intendedOption"] == {"label": "LinkedIn"}
    assert source["action"] == {
        "method": "trusted_keyboard",
        "result": "failed",
        "reason": "workday_commit_not_verified",
    }
    assert source["commitVerification"] == {
        "verified": False,
        "selectedPillPresent": False,
        "backingValuePresent": False,
        "validationVisible": True,
        "reason": "workday_commit_not_verified",
    }
    sensitive = snapshot["recentFieldOutcomes"][1]
    assert sensitive["intendedOption"] == {"label": ""}
    serialized = json.dumps(snapshot)
    assert "candidate@example.test" not in serialized
    assert "hunter2" not in serialized
    assert "super-secret-token" not in serialized
    assert "must-not-leak" not in serialized
    assert len(snapshot["breadcrumbs"]) <= 16
    assert len(snapshot["recentFieldOutcomes"]) <= 12


def test_driver_evidence_never_treats_ui_state_as_source_option():
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
      tracker.reset({{ fillRunId: "fill-ui-state", operationId: "op-ui-state" }});
      tracker.update({{
        phase: "field_commit_checked",
        field: {{
          fieldId: "source--source",
          descriptor: "How Did You Hear About Us?",
          uiModel: "combobox",
        }},
        intendedOption: {{ label: "Expanded", safe: true }},
        action: {{
          method: "trusted_pointer",
          result: "failed",
          reason: "workday_commit_not_verified",
        }},
      }});
      console.log(JSON.stringify(tracker.snapshot()));
    """

    result = run_node(script)

    assert result.returncode == 0, result.stderr
    snapshot = json.loads(result.stdout)
    assert snapshot["recentFieldOutcomes"][0]["intendedOption"] == {"label": ""}


def test_workday_option_selection_rejects_expanded_ui_state_before_action():
    script = f"""
      const fs = require("node:fs");
      const vm = require("node:vm");
      const root = {{
        optionCollector: {{ collectOptions: async () => [] }},
        fieldDrivers: {{
          fillField: async () => ({{}}),
          clearField: async () => ({{}}),
        }},
      }};
      const context = {{
        window: {{ __huntV2: root }},
        console: {{ log() {{}} }},
        Date,
        setTimeout,
        clearTimeout,
        Event: function Event() {{}},
        KeyboardEvent: function KeyboardEvent() {{}},
        MouseEvent: function MouseEvent() {{}},
        document: {{}},
      }};
      vm.createContext(context);
      vm.runInContext(
        fs.readFileSync({json.dumps(str(WORKDAY_DRIVERS))}, "utf8"),
        context,
      );
      const drivers = context.window.__huntV2.workdayDrivers;
      const selected = drivers.preferredWorkdayOption(
        [
          {{ label: "Expanded", element: {{}} }},
          {{ label: "LinkedIn", element: {{}} }},
        ],
        {{ label: "Expanded" }},
        {{ value: "LinkedIn" }},
        {{
          descriptor: "How Did You Hear About Us?",
          element: {{
            id: "source--source",
            name: "source",
            getAttribute: () => "",
          }},
        }},
      );
      console.log(JSON.stringify({{
        expandedIsUiState: drivers.isWorkdayUiStateOptionLabel("Expanded"),
        linkedinIsUiState: drivers.isWorkdayUiStateOptionLabel("LinkedIn"),
        selected: selected?.label || "",
      }}));
    """

    result = run_node(script)

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload == {
        "expandedIsUiState": True,
        "linkedinIsUiState": False,
        "selected": "LinkedIn",
    }


def test_page_walk_selects_causal_field_evidence_and_compacts_terminal_payload():
    script = f"""
      const fs = require("node:fs");
      const vm = require("node:vm");
      const source = fs.readFileSync({json.dumps(str(BACKGROUND))}, "utf8");
      const stopStart = source.indexOf("function compactStopDetails(");
      const stopEnd = source.indexOf("function describePageWalkStop", stopStart);
      const evidenceStart = source.indexOf("function driverEvidenceText(");
      const evidenceEnd = source.indexOf("function compactAuthActionCandidate", evidenceStart);
      const context = {{}};
      vm.createContext(context);
      vm.runInContext(
        source.slice(stopStart, stopEnd) +
          "\\n" +
          source.slice(evidenceStart, evidenceEnd),
        context,
      );
      const raw = {{
        active: false,
        phase: "pipeline_complete",
        field: {{ id: "province", label: "Province", type: "combobox" }},
        rawValue: "must-not-leak-top-level",
        breadcrumbs: Array.from({{ length: 30 }}, (_, index) => ({{
          at: "2026-07-26T17:00:00.000Z",
          phase: "field_commit_checked",
          waitClass: "idle",
          field: {{ id: `field-${{index}}`, label: `Field ${{index}}`, type: "text" }},
          awaitedOperation: "",
          answer: "must-not-leak-answer",
        }})),
        recentFieldOutcomes: [
          {{
            at: "2026-07-26T17:00:00.000Z",
            field: {{
              id: "source--source",
              label: "How Did You Hear About Us?* 0 items selected Error: The field How Did You Hear About Us? is required and must have a value. source--source Search text off",
              type: "combobox",
            }},
            popupOwner: {{
              id: "source-listbox",
              role: "listbox",
              automationId: "promptOption",
              controls: "source-listbox",
              text: "must-not-leak-popup-text",
            }},
            intendedOption: {{ label: "LinkedIn", rawValue: "secret" }},
            action: {{
              method: "trusted_keyboard",
              result: "failed",
              reason: "workday_commit_not_verified",
              answer: "must-not-leak-action",
            }},
            commitVerification: {{
              verified: false,
              selectedPillPresent: false,
              backingValuePresent: false,
              validationVisible: true,
              reason: "workday_commit_not_verified",
              rawValue: "must-not-leak-commit",
            }},
          }},
          {{
            field: {{
              id: "address--countryRegion",
              label: "Province or Territory Select One Province or TerritorySelect One",
              type: "button_listbox",
            }},
            intendedOption: {{ label: "" }},
            action: {{
              method: "option_match",
              result: "failed",
              reason: "no_matching_option",
            }},
          }},
        ],
      }};
      const selected = context.pageWalkDriverEvidence(
        {{ result: {{ driverEvidence: raw }} }},
        ["Error-How Did You Hear About Us? The field How Did You Hear About Us? is required and must have a value."],
      );
      const compact = context.compactStopDetails({{
        visibleValidationErrors: ["Error-How Did You Hear About Us? The field How Did You Hear About Us? is required and must have a value."],
        driverEvidence: selected,
      }});
      console.log(JSON.stringify(compact));
    """

    result = run_node(script)

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    evidence = payload["driverEvidence"]
    assert evidence["causalField"]["field"]["id"] == "source--source"
    assert evidence["causalField"]["intendedOption"] == {"label": "LinkedIn"}
    assert evidence["causalField"]["action"]["method"] == "trusted_keyboard"
    assert evidence["causalField"]["commitVerification"]["verified"] is False
    assert len(evidence["breadcrumbs"]) <= 16
    assert len(evidence["recentFieldOutcomes"]) <= 12
    serialized = json.dumps(payload)
    assert "must-not-leak" not in serialized
    assert '"rawValue"' not in serialized

    background = BACKGROUND.read_text(encoding="utf-8")
    assert "driverEvidence: pageWalkDriverEvidence(currentFill, afterNextErrors)" in background
    assert background.count("driverEvidence: pageWalkDriverEvidence(currentFill)") >= 2


def test_pipeline_results_expose_driver_evidence_snapshot():
    source = FIELD_PIPELINE.read_text(encoding="utf-8")

    assert source.count("driverEvidence: root.driverEvidence.snapshot()") >= 2
