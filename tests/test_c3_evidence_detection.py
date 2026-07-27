import json
import subprocess
from pathlib import Path

import pytest

try:
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

    class PlaywrightError(Exception):
        pass


REPO_ROOT = Path(__file__).resolve().parents[1]
BACKGROUND_PATH = REPO_ROOT / "executioner" / "src" / "background" / "index.js"
SAFE_NEXT_PATH = REPO_ROOT / "executioner" / "src" / "background" / "safe-next.js"


def _function_source(name: str, next_name: str) -> str:
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index(f"function {name}(")
    end = source.index(f"function {next_name}(", start)
    return source[start:end]


@pytest.fixture
def browser_page():
    if sync_playwright is None:
        pytest.skip("playwright is required for C3 evidence fixtures")
    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")
        page = browser.new_page()
        yield page
        browser.close()


def _detect(page):
    page.add_script_tag(
        content=_function_source(
            "createC3WorkflowDetectionFunction",
            "createClickAuthPrimaryActionFunction",
        )
    )
    return page.evaluate("createC3WorkflowDetectionFunction()()")


def _snapshot(page):
    page.add_script_tag(
        content=_function_source("createPageSnapshotFunction", "chooseBestPageSnapshot")
    )
    return page.evaluate("createPageSnapshotFunction()()")


def _readiness(page):
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    owner_start = source.index("async function inspectApplicationFieldReadiness(")
    func_start = source.index("func: () => {", owner_start) + len("func: ")
    func_end = source.index("\n        },\n      }),", func_start) + len("\n        }")
    probe = source[func_start:func_end]
    return page.evaluate(f"({probe})()")


def _safe_next(page):
    source = SAFE_NEXT_PATH.read_text(encoding="utf-8").replace("export function ", "function ")
    page.add_script_tag(content=source)
    return page.evaluate("createSafeNextFunction()({ click: false })")


def test_unknown_page_is_not_assumed_to_be_job_fill(browser_page):
    browser_page.set_content("<html><head><title>Blank</title></head><body></body></html>")

    detection = _detect(browser_page)

    assert detection["pageKind"] == "unknown"
    assert detection["phase"] == "unknown"
    assert detection["isJobFillPage"] is False


@pytest.mark.parametrize(
    ("text", "expected_kind"),
    [
        ("This site is currently undergoing maintenance. Please try again later.", "maintenance"),
        ("The page you are looking for cannot be found.", "job_unavailable"),
        ("This job is no longer available.", "job_unavailable"),
    ],
)
def test_direct_unavailable_states_are_preserved(browser_page, text, expected_kind):
    browser_page.set_content(f"<html><body><main><h1>{text}</h1></main></body></html>")

    detection = _detect(browser_page)

    assert detection["pageKind"] == expected_kind
    assert detection["directEvidence"]["messages"]


def test_related_job_title_with_maintenance_word_is_not_site_maintenance(browser_page):
    html = """
        <html><body>
          <main>
            <h1>Reliability Engineering Intern</h1>
            <a role="button" href="/External/job/example/apply">Apply</a>
            <aside>Related job: Maintenance &amp; Reliability Specialist</aside>
          </main>
        </body></html>
    """
    browser_page.route(
        "**/*",
        lambda route: route.fulfill(status=200, content_type="text/html", body=html),
    )
    browser_page.goto("https://tenant.wd3.myworkdayjobs.com/External/job/example")

    detection = _detect(browser_page)

    assert detection["directEvidence"]["maintenanceVisible"] is False
    assert detection["pageKind"] == "apply_entry"
    assert detection["isApplyEntryPage"] is True


def test_explicit_credential_rejection_is_direct_auth_evidence(browser_page):
    browser_page.set_content(
        """
        <html><body>
          <form data-automation-id="signInFormo">
            <label>Email <input type="email" /></label>
            <label>Password <input type="password" /></label>
            <div role="alert">You may have entered the wrong email address or password
              or your account might be locked.</div>
            <button data-automation-id="signInSubmitButton">Sign In</button>
          </form>
        </body></html>
        """
    )

    detection = _detect(browser_page)

    assert detection["pageKind"] == "credential_rejected"
    assert detection["hasLoginFailure"] is True
    assert detection["directEvidence"]["alerts"][0]["message"].startswith("You may have entered")


def test_workday_review_without_progress_step_is_detected_structurally(browser_page):
    html = """
        <html><body>
          <h1>Review your application</h1>
          <button data-automation-id="bottom-navigation-next-button">
            Submit
          </button>
        </body></html>
    """
    browser_page.route(
        "**/*",
        lambda route: route.fulfill(status=200, content_type="text/html", body=html),
    )
    browser_page.goto("https://tenant.wd3.myworkdayjobs.com/en-US/jobs/apply/review")

    detection = _detect(browser_page)

    assert detection["pageKind"] == "review"
    assert detection["finalSubmitVisible"] is True


def test_auth_submit_decoy_is_never_final_submit_evidence(browser_page):
    html = """
        <html><body>
          <div>current step 1 of 8
Create Account/Sign In
step 8 of 8
Review</div>
          <div data-automation-id="progressBarActiveStep">
            <label>Create Account/Sign In</label>
          </div>
          <form data-automation-id="signInFormo">
            <label>Email Address <input type="email" /></label>
            <label>Password <input type="password" /></label>
            <button data-automation-id="signInSubmitButton" type="submit">
              Sign In
            </button>
            <div data-automation-id="noCaptchaWrapper">
              <div data-automation-id="click_filter" role="button"
                style="opacity: 0">Submit</div>
            </div>
          </form>
        </body></html>
    """
    browser_page.route(
        "**/*",
        lambda route: route.fulfill(status=200, content_type="text/html", body=html),
    )
    browser_page.goto(
        "https://workday.wd5.myworkdayjobs.com/en-US/Workday/job/example/apply/applyManually"
    )

    detection = _detect(browser_page)
    readiness = _readiness(browser_page)
    safe_next = _safe_next(browser_page)

    assert detection["pageKind"] == "auth_form"
    assert detection["finalSubmitVisible"] is False
    assert readiness["finalSubmitVisible"] is False
    assert safe_next["reason"] == "no_safe_next_button"
    assert safe_next["blockedFinalSubmitLabels"] == []


def test_finning_review_final_submit_remains_authoritative(browser_page):
    html = """
        <html><body>
          <div>current step 4 of 4
Review</div>
          <div data-automation-id="progressBarActiveStep">
            <label>Review</label>
          </div>
          <main>
            <h1>Review your application</h1>
            <button data-automation-id="bottom-navigation-next-button"
              type="submit">Submit</button>
          </main>
        </body></html>
    """
    browser_page.route(
        "**/*",
        lambda route: route.fulfill(status=200, content_type="text/html", body=html),
    )
    browser_page.goto(
        "https://finning.wd3.myworkdayjobs.com/en-US/External/job/example/apply/applyManually"
    )

    detection = _detect(browser_page)
    readiness = _readiness(browser_page)
    safe_next = _safe_next(browser_page)

    assert detection["pageKind"] == "review"
    assert detection["finalSubmitVisible"] is True
    assert readiness["finalSubmitVisible"] is True
    assert safe_next["reason"] == "final_submit_visible"
    assert safe_next["blockedFinalSubmitLabels"] == ["Submit"]


def test_snapshot_projection_requires_review_and_detector_agreement():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index("function authoritativeFinalSubmitVisible(")
    end = source.index("function createC3WorkflowDetectionFunction()", start)
    script = f"""
      const vm = require("node:vm");
      const context = {{}};
      vm.createContext(context);
      vm.runInContext({json.dumps(source[start:end])}, context);
      const evaluate = context.authoritativeFinalSubmitVisible;
      console.log(JSON.stringify({{
        authDecoy: evaluate(
          {{ pageKind: "auth_form", isJobFillPage: false, finalSubmitVisible: false }},
          {{ finalSubmitVisible: true }}
        ),
        readinessOnly: evaluate(
          {{ pageKind: "review", isJobFillPage: true, finalSubmitVisible: false }},
          {{ finalSubmitVisible: true }}
        ),
        review: evaluate(
          {{ pageKind: "review", isJobFillPage: true, finalSubmitVisible: true }},
          {{ finalSubmitVisible: true }}
        ),
      }}));
    """
    result = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)

    assert json.loads(result.stdout) == {
        "authDecoy": False,
        "readinessOnly": False,
        "review": True,
    }
    snapshot_handler = source[
        source.index('case "hunt.apply.snapshot_page":') : source.index(
            'case "hunt.apply.inspect_fields":'
        )
    ]
    assert "authoritativeFinalSubmitVisible(" in snapshot_handler
    assert "workflow: {" in snapshot_handler
    assert "readiness: {" in snapshot_handler
    assert snapshot_handler.count("finalSubmitVisible,") == 2


def test_workday_application_path_requires_structural_fields(browser_page):
    html = """
        <html><body>
          <h1>My Information</h1>
          <div data-automation-id="formField-firstName">
            <label>First Name <input name="firstName" /></label>
          </div>
        </body></html>
    """
    browser_page.route(
        "**/*",
        lambda route: route.fulfill(status=200, content_type="text/html", body=html),
    )
    browser_page.goto("https://tenant.wd3.myworkdayjobs.com/en-US/jobs/apply/applyManually")

    detection = _detect(browser_page)

    assert detection["pageKind"] == "application_page"
    assert detection["isJobFillPage"] is True


def test_current_step_prefers_visible_workday_aria_semantics_over_internal_counting():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    owner_starts = [
        source.index("function createC3WorkflowDetectionFunction()"),
        source.index("function createPageSnapshotFunction()"),
    ]
    for owner_start in owner_starts:
        step_start = source.index("    function currentWorkdayStep() {", owner_start)
        step_end = source.index("    function describeValidationElement", step_start)
        step_function = source[step_start:step_end]
        script = f"""
      const vm = require("node:vm");
      const activeStep = {{
        innerText: "Current Step 2 of 6\\nMy Experience",
        textContent: "Current Step 2 of 6 My Experience",
        getAttribute(name) {{
          return {{
            "aria-posinset": "2",
            "aria-setsize": "6",
            "aria-label": "Current Step 2 of 6 My Experience",
          }}[name] || "";
        }},
        querySelectorAll(selector) {{
          if (selector !== "label") return [];
          return [
            {{ innerText: "Current Step 2 of 6" }},
            {{ innerText: "My Experience" }},
          ];
        }},
      }};
      const internalNodes = [
        {{ id: "progress-container" }},
        {{ id: "step-1" }},
        activeStep,
        {{ id: "step-3" }},
        {{ id: "step-4" }},
        {{ id: "step-5" }},
        {{ id: "step-6" }},
      ];
      const context = {{
        normalize(value) {{
          return String(value || "").replace(/\\s+/g, " ").trim();
        }},
        normalizeText(value) {{
          return String(value || "").replace(/\\s+/g, " ").trim();
        }},
        document: {{
          body: {{ innerText: "Current Step 2 of 6\\nMy Experience" }},
          querySelector(selector) {{
            return selector.includes("progressBarActiveStep") ? activeStep : null;
          }},
          querySelectorAll() {{
            return internalNodes;
          }},
        }},
      }};
      vm.createContext(context);
      vm.runInContext({json.dumps(step_function)}, context);
      console.log(JSON.stringify(context.currentWorkdayStep()));
    """

        result = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
        current_step = json.loads(result.stdout)

        assert current_step == {
            "current": 2,
            "total": 6,
            "title": "My Experience",
        }


def test_captcha_requires_a_visible_structural_challenge(browser_page):
    browser_page.set_content(
        """
        <html><body>
          <div id="px-captcha" style="display:none">Press and hold</div>
          <iframe title="reCAPTCHA challenge"
            src="https://www.google.com/recaptcha/api2/anchor"></iframe>
        </body></html>
        """
    )

    detection = _detect(browser_page)

    assert detection["pageKind"] == "captcha_present"
    assert detection["captchaChallengePresent"] is True
    assert detection["directEvidence"]["captcha"]["kind"] == "iframe"


def test_hidden_nocaptcha_wrapper_is_not_a_captcha(browser_page):
    browser_page.set_content(
        """
        <html><body>
          <div data-automation-id="click_filter" style="display:none">
            No CAPTCHA wrapper
          </div>
        </body></html>
        """
    )

    detection = _detect(browser_page)

    assert detection["pageKind"] == "unknown"
    assert detection["captchaChallengePresent"] is False


def test_snapshot_keeps_unrecognized_visible_alert_without_keyword_filter(browser_page):
    browser_page.set_content(
        """
        <html><body>
          <label for="email">Email</label>
          <input id="email" type="email" aria-describedby="site-message" />
          <div id="site-message" role="alert">Your account might be locked.</div>
        </body></html>
        """
    )

    snapshot = _snapshot(browser_page)

    assert snapshot["visibleMessages"][0]["message"] == "Your account might be locked."
    assert snapshot["visibleValidationErrors"] == ["Your account might be locked."]
    assert snapshot["captureCompleteness"]["visibleMessages"] is True


def test_snapshot_does_not_treat_positive_live_status_as_validation(browser_page):
    browser_page.set_content(
        """
        <html><body>
          <div role="status" aria-live="polite">The page is loaded.</div>
          <label for="email">Email</label>
          <input id="email" type="email" />
        </body></html>
        """
    )

    snapshot = _snapshot(browser_page)

    assert snapshot["visibleMessages"][0]["message"] == "The page is loaded."
    assert snapshot["visibleValidationErrors"] == []
    assert snapshot["visibleValidationDetails"] == []


def test_snapshot_does_not_treat_linked_upload_success_as_validation(browser_page):
    browser_page.set_content(
        """
        <html><body>
          <div data-automation-id="formField-resume">
            <label for="resume">Resume</label>
            <input id="resume" type="file" aria-describedby="upload-status" />
            <div id="upload-status" role="status" aria-live="polite">
              main.pdf successfully uploaded
            </div>
          </div>
        </body></html>
        """
    )

    snapshot = _snapshot(browser_page)

    assert snapshot["visibleMessages"][0]["message"] == "main.pdf successfully uploaded"
    assert snapshot["visibleValidationErrors"] == []
    assert snapshot["visibleValidationDetails"] == []


def test_snapshot_prefers_visible_body_step_over_polluted_internal_node_count(
    browser_page,
):
    browser_page.set_content(
        """
        <html><body>
          <div>current step 1 of 4
My Information</div>
          <div data-automation-id="progressBarCompletedStep">internal shell</div>
          <div data-automation-id="progressBarActiveStep">
            <label>My Information</label>
          </div>
          <div data-automation-id="progressBarInactiveStep">My Experience</div>
          <div data-automation-id="progressBarInactiveStep">Application Questions</div>
          <div data-automation-id="progressBarInactiveStep">Review</div>
        </body></html>
        """
    )

    snapshot = _snapshot(browser_page)

    assert snapshot["currentStep"] == {
        "current": 1,
        "total": 4,
        "title": "My Information",
    }


def test_readiness_detects_duplicated_submit_text_and_uses_visible_step(
    browser_page,
):
    html = """
        <html><body>
          <div>current step 4 of 4
Review</div>
          <div data-automation-id="progressBarActiveStep">
            <label>Review</label>
          </div>
          <button data-automation-id="bottom-navigation-next-button">
            Submit
          </button>
        </body></html>
        """
    browser_page.route(
        "**/*",
        lambda route: route.fulfill(status=200, content_type="text/html", body=html),
    )
    browser_page.goto("https://tenant.wd3.myworkdayjobs.com/en-US/jobs/apply/applyManually")

    readiness = _readiness(browser_page)

    assert readiness["currentStep"] == {
        "current": 4,
        "total": 4,
        "title": "Review",
    }
    assert readiness["finalSubmitVisible"] is True


def test_page_walk_preserves_initial_apply_entry_telemetry():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index("function compactPageWalkApplyEntryTelemetry(")
    end = source.index("async function runV2PageWalkAfterFill(", start)
    script = f"""
      const vm = require("node:vm");
      const context = {{}};
      vm.createContext(context);
      vm.runInContext({json.dumps(source[start:end])}, context);
      const telemetry = context.compactPageWalkApplyEntryTelemetry({{
        workflow: {{
          applyEntry: {{
            ok: true,
            skipped: false,
            clicked: true,
            navigationStarted: true,
            reason: "clicked_apply",
            label: "Apply",
            detection: {{
              pageKind: "apply_entry",
              href: "https://tenant.test/job/1"
            }}
          }}
        }}
      }});
      console.log(JSON.stringify(telemetry));
    """
    result = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    telemetry = json.loads(result.stdout)

    assert telemetry == {
        "available": True,
        "attempted": True,
        "ok": True,
        "clicked": True,
        "skipped": False,
        "navigationStarted": True,
        "reason": "clicked_apply",
        "label": "Apply",
        "pageKind": "apply_entry",
        "href": "https://tenant.test/job/1",
    }


def test_page_walk_does_not_infer_missing_apply_entry_telemetry():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index("function compactPageWalkApplyEntryTelemetry(")
    end = source.index("async function runV2PageWalkAfterFill(", start)
    script = f"""
      const vm = require("node:vm");
      const context = {{}};
      vm.createContext(context);
      vm.runInContext({json.dumps(source[start:end])}, context);
      console.log(JSON.stringify(
        context.compactPageWalkApplyEntryTelemetry({{ ok: true }})
      ));
    """
    result = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(result.stdout) == {"available": False}


def test_page_snapshot_selection_prefers_direct_evidence_over_blank_frame():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index("function chooseBestPageSnapshot(")
    end = source.index("async function getPageSnapshot(", start)
    script = source[start:end]
    assert "directEvidenceScore" in script


def test_auth_transition_preserves_explicit_rejection_and_defers_unknown_state():
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
        isAuthPage: true,
        authState: "login",
        authUiState: "credential_form",
        pageKind: "auth_form",
        href: "https://tenant.test/login",
      }};
      const rejected = decide({{
        beforeDetection: before,
        afterDetection: {{
          ...before,
          pageKind: "credential_rejected",
          hasLoginFailure: true,
        }},
        visibleValidationErrors: [
          "You may have entered the wrong email address or password or your account might be locked."
        ],
      }});
      const unknown = decide({{
        beforeDetection: before,
        afterDetection: {{
          isAuthPage: false,
          pageKind: "unknown",
          phase: "unknown",
          href: "https://tenant.test/login",
        }},
      }});
      console.log(JSON.stringify({{ rejected, unknown }}));
    """

    result = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)

    assert payload["rejected"]["terminal"] is True
    assert payload["rejected"]["kind"] == "auth_credential_rejected"
    assert payload["rejected"]["stoppedReason"] == "credential_rejected"
    assert payload["unknown"]["terminal"] is False
    assert payload["unknown"]["kind"] == "auth_transition_pending"
    assert payload["unknown"]["stoppedReason"] == ""


def test_page_walk_checks_direct_auth_result_before_cycle_detection():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index("async function runV2PageWalkAfterFill(")
    end = source.index("function chooseBestV2ClearFrame", start)
    page_walk = source[start:end]

    decision_index = page_walk.index(
        "const immediateAuthTransitionDecision = decideAuthTransitionAfterAction({"
    )
    history_index = page_walk.index("authPageWalkState.recordTransition({")
    assert decision_index < history_index
    assert "auth_credential_rejected" in page_walk[decision_index:history_index]


def test_auth_transition_waits_for_two_stable_non_loading_observations():
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    start = source.index("function pageSnapshotChangedAfterAction(")
    end = source.index("class C3JobFillWorkflow", start)
    script = f"""
      const vm = require("node:vm");
      const detections = [
        {{ ok: true, phase: "unknown", pageKind: "unknown", isAuthPage: false,
           href: "https://tenant.test/apply", stillLoading: true }},
        {{ ok: true, phase: "job_fill", pageKind: "application_page",
           isAuthPage: false, href: "https://tenant.test/apply",
           currentStep: {{ title: "My Information" }} }},
        {{ ok: true, phase: "job_fill", pageKind: "application_page",
           isAuthPage: false, href: "https://tenant.test/apply",
           currentStep: {{ title: "My Information" }} }},
      ];
      let detectionCalls = 0;
      const context = {{
        Date,
        setTimeout: (callback) => callback(),
        detectEmailVerificationCodePage: async () => ({{ ok: false }}),
        detectWorkflowForTab: async () =>
          detections[Math.min(detectionCalls++, detections.length - 1)],
        getPageSnapshot: async () => ({{
          href: "https://tenant.test/apply",
          currentStep: {{ title: detectionCalls > 1 ? "My Information" : "" }},
          documentReadyState: detectionCalls > 1 ? "complete" : "interactive",
          visibleValidationErrors: [],
        }}),
        inspectApplicationFieldReadiness: async () => ({{
          applicationFieldCount: detectionCalls > 1 ? 4 : 0,
          meaningfulControlCount: detectionCalls > 1 ? 4 : 0,
          currentStep: detectionCalls > 1 ? {{ title: "My Information" }} : null,
        }}),
      }};
      vm.createContext(context);
      vm.runInContext({json.dumps(source[start:end])}, context);
      context.waitForAuthActionTransitionForTab(1, {{
        beforeDetection: {{
          ok: true, isAuthPage: true, pageKind: "auth_form",
          authState: "login", authUiState: "credential_form",
          href: "https://tenant.test/login"
        }},
        beforeSnapshot: {{ href: "https://tenant.test/login" }},
        timeoutMs: 1000,
        intervalMs: 0,
      }}).then((result) => console.log(JSON.stringify({{ result, detectionCalls }})));
    """

    result = subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)

    assert payload["detectionCalls"] >= 3
    assert payload["result"]["reason"] == "stable_page_state"
    assert len(payload["result"]["observationSamples"]) >= 3
