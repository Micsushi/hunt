import json
import subprocess
from pathlib import Path

BACKGROUND_PATH = (
    Path(__file__).resolve().parents[1] / "executioner" / "src" / "background" / "index.js"
)


def _run_decisions():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index("function createAuthTransitionDecisionFunction()")
    end = source.index("function createAuthValidationRepairDecisionFunction()", start)
    script = f"""
      const vm = require("node:vm");
      const context = {{}};
      vm.createContext(context);
      vm.runInContext({json.dumps(source[start:end])}, context);
      const decide = context.createAuthTransitionDecisionFunction();
      const before = {{
        ok: true,
        isAuthPage: true,
        authState: "login",
        authUiState: "credential_form",
        pageKind: "auth_form",
        href: "https://tenant.test/login",
      }};
      const unknown = {{
        ok: true,
        isAuthPage: false,
        authState: "unknown",
        authUiState: "unknown",
        pageKind: "unknown",
        phase: "unknown",
        href: "https://tenant.test/apply",
      }};
      const transient = decide({{
        beforeDetection: before,
        afterDetection: unknown,
      }});
      const timedOut = decide({{
        beforeDetection: before,
        afterDetection: unknown,
        transitionTimeoutEvidence: {{
          reason: "application_fields_not_ready_after_auth",
          waitMs: 10037,
          lastProbe: {{
            href: "https://tenant.test/apply",
            applicationFieldCount: 0,
            meaningfulControlCount: 0,
          }},
        }},
      }});
      const rejected = decide({{
        beforeDetection: before,
        afterDetection: {{
          ...before,
          pageKind: "credential_rejected",
          hasLoginFailure: true,
        }},
      }});
      const maintenance = decide({{
        beforeDetection: before,
        afterDetection: {{
          ok: true,
          isAuthPage: false,
          pageKind: "maintenance",
          phase: "unavailable",
          href: "https://tenant.test/apply",
        }},
      }});
      console.log(JSON.stringify({{
        transient,
        timedOut,
        rejected,
        maintenance,
      }}));
    """
    result = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_r3_unknown_post_login_shell_is_pending_until_bounded_timeout():
    decisions = _run_decisions()

    assert decisions["transient"]["kind"] == "auth_transition_pending"
    assert decisions["transient"]["terminal"] is False
    assert decisions["transient"]["observedPageKind"] == "unknown"

    assert decisions["timedOut"]["kind"] == "auth_transition_unclassified"
    assert decisions["timedOut"]["terminal"] is True
    assert decisions["timedOut"]["stoppedReason"] == "unclassified_failure"
    assert decisions["timedOut"]["stopDetails"]["timeoutEvidence"] == {
        "reason": "application_fields_not_ready_after_auth",
        "waitMs": 10037,
        "lastProbe": {
            "href": "https://tenant.test/apply",
            "applicationFieldCount": 0,
            "meaningfulControlCount": 0,
        },
    }


def test_r3_deferral_preserves_direct_terminal_auth_rules():
    decisions = _run_decisions()

    assert decisions["rejected"]["kind"] == "auth_credential_rejected"
    assert decisions["rejected"]["terminal"] is True
    assert decisions["rejected"]["stoppedReason"] == "credential_rejected"
    assert decisions["maintenance"]["kind"] == "auth_site_unavailable"
    assert decisions["maintenance"]["terminal"] is True
    assert decisions["maintenance"]["stoppedReason"] == "maintenance"


def test_page_walk_defers_unknown_until_application_readiness_timeout():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index("async function runV2PageWalkAfterFill(")
    end = source.index("function chooseBestV2ClearFrame", start)
    page_walk = source[start:end]

    immediate_start = page_walk.index(
        "const immediateAuthTransitionDecision = decideAuthTransitionAfterAction({"
    )
    readiness_start = page_walk.index(
        "const readiness = await waitForApplicationFieldsReadyAfterAuth("
    )
    immediate_block = page_walk[immediate_start:readiness_start]

    assert immediate_start < readiness_start
    assert '"auth_transition_unclassified"' not in immediate_block
    assert "transitionTimeoutEvidence" in page_walk[readiness_start:]
