import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKGROUND = REPO_ROOT / "executioner/src/background/index.js"


def run_node(source: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", "-e", source],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def test_direct_terminal_requires_matching_structured_observation():
    script = f"""
      const fs = require("node:fs");
      const vm = require("node:vm");
      const source = fs.readFileSync({json.dumps(str(BACKGROUND))}, "utf8");
      const start = source.indexOf("function directPageStateTerminal(");
      const end = source.indexOf(
        "async function runInitialFillBeforeDirectPageWalk(",
        start,
      );
      const context = {{}};
      vm.createContext(context);
      vm.runInContext(source.slice(start, end), context);
      const generic = context.directPageStateTerminal({{
        pageKind: "unknown",
        directEvidence: {{
          messages: ["The page you are looking for doesn't exist."],
        }},
      }});
      const kindOnly = context.directPageStateTerminal({{
        pageKind: "job_unavailable",
        directEvidence: {{ jobUnavailableVisible: false }},
      }});
      const mismatch = context.directPageStateTerminal({{
        pageKind: "maintenance",
        directEvidence: {{ jobUnavailableVisible: true }},
      }});
      const unavailable = context.directPageStateTerminal({{
        pageKind: "job_unavailable",
        phase: "unavailable",
        href: "https://tenant.test/job/R1",
        title: "Work at Example",
        directEvidence: {{
          jobUnavailableVisible: true,
          maintenanceVisible: false,
          messages: ["The page you are looking for doesn't exist."],
        }},
      }});
      const maintenance = context.directPageStateTerminal({{
        pageKind: "maintenance",
        phase: "unavailable",
        directEvidence: {{
          maintenanceVisible: true,
          jobUnavailableVisible: false,
          messages: ["Scheduled maintenance is in progress."],
        }},
      }});
      console.log(JSON.stringify({{
        generic,
        kindOnly,
        mismatch,
        unavailable,
        maintenance,
      }}));
    """

    result = run_node(script)

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["generic"] is None
    assert payload["kindOnly"] is None
    assert payload["mismatch"] is None
    assert payload["unavailable"]["reason"] == "job_unavailable"
    assert payload["unavailable"]["directObservation"]["pageKind"] == ("job_unavailable")
    assert payload["unavailable"]["directObservation"]["messages"] == [
        "The page you are looking for doesn't exist."
    ]
    assert payload["maintenance"]["reason"] == "maintenance"


def test_initial_direct_unavailable_page_never_prepares_or_fills():
    script = f"""
      const fs = require("node:fs");
      const vm = require("node:vm");
      const source = fs.readFileSync({json.dumps(str(BACKGROUND))}, "utf8");
      const helperStart = source.indexOf("function directPageStateTerminal(");
      const initialStart = source.indexOf(
        "async function runInitialFillBeforeDirectPageWalk(",
        helperStart,
      );
      const initialEnd = source.indexOf(
        "function compactPageWalkApplyEntryTelemetry(",
        initialStart,
      );
      let prepareCalls = 0;
      let fillCalls = 0;
      const context = {{
        detectWorkflowForTab: async () => ({{
          pageKind: "job_unavailable",
          phase: "unavailable",
          href: "https://tenant.test/job/R1",
          title: "Work at Example",
          directEvidence: {{
            jobUnavailableVisible: true,
            messages: ["This job is no longer available."],
          }},
        }}),
        C3CombinedFillWorkflow: class {{
          prepare() {{
            prepareCalls += 1;
            return {{ auth: {{ ok: true }}, applyEntry: {{ ok: true }} }};
          }}
        }},
        runFillWithOneRefreshRetry: async () => {{
          fillCalls += 1;
          return {{ ok: true }};
        }},
      }};
      vm.createContext(context);
      vm.runInContext(
        source.slice(helperStart, initialStart) +
          "\\n" +
          source.slice(initialStart, initialEnd),
        context,
      );
      (async () => {{
        const result = await context.runInitialFillBeforeDirectPageWalk({{
          tabId: 1,
          state: {{ activeApplyContext: {{}} }},
          fillRunId: "fill-1",
          triggeredBy: "test",
          allowLlmAnswers: false,
        }});
        console.log(JSON.stringify({{ result, prepareCalls, fillCalls }}));
      }})().catch((error) => {{
        console.error(error.stack || String(error));
        process.exitCode = 1;
      }});
    """

    result = run_node(script)

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["prepareCalls"] == 0
    assert payload["fillCalls"] == 0
    assert payload["result"]["ok"] is False
    assert payload["result"]["reason"] == "job_unavailable"
    assert payload["result"]["stoppedReason"] == "job_unavailable"
    assert payload["result"]["steps"][0]["kind"] == ("direct_page_state_terminal")
    assert payload["result"]["terminalStep"]["reason"] == "job_unavailable"


def test_page_walk_checks_direct_terminal_state_at_all_mutation_boundaries():
    source = BACKGROUND.read_text(encoding="utf-8")

    initial = source[
        source.index("async function runInitialFillBeforeDirectPageWalk(") : source.index(
            "function compactPageWalkApplyEntryTelemetry("
        )
    ]
    fill = source[
        source.index("async function runFillWithOneRefreshRetry(") : source.index(
            "function internalCommandReceipt("
        )
    ]
    page_walk = source[
        source.index("async function runV2PageWalkAfterFill(") : source.index(
            "function chooseBestV2ClearFrame("
        )
    ]
    handler = source[
        source.index('case "hunt.apply.page_walk":') : source.index(
            'case "hunt.apply.fill_remaining_with_llm":'
        )
    ]

    assert initial.index("directPageStateTerminalResponse(") < initial.index(
        "new C3CombinedFillWorkflow("
    )
    assert fill.count("directPageStateTerminalResponse(") >= 4
    assert 'kind: "direct_page_state_terminal"' in page_walk
    assert (
        "detectDirectTerminalResponse(\n      state,\n      afterNextDirectDetection" in page_walk
    )
    assert "detectDirectTerminalFromFill(repairFill)" in page_walk
    assert "stopDetails: initialResult.stopDetails || {}" in handler
    assert "steps: initialResult.steps || []" in handler
    assert "initialResult.terminalStep ||" in handler
