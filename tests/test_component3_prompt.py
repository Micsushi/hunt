from pathlib import Path

import pytest

try:
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None
    PlaywrightError = Exception


REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_script(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _new_prompt_page(playwright, body_html: str):
    browser = playwright.chromium.launch()
    page = browser.new_page()
    page.route(
        "**/*",
        lambda route: route.fulfill(
            status=200,
            content_type="text/html",
            body=f"<html><body>{body_html}</body></html>",
        ),
    )
    page.add_init_script(
        """
        window.chrome = {
          runtime: {
            onMessage: { addListener: () => {} },
            sendMessage: async (message) => {
              window.__huntMessages = window.__huntMessages || [];
              window.__huntMessages.push(message);
              if (message.type === "hunt.apply.get_state") {
                return {
                  ok: true,
                  settings: {
                    autoPromptEnabled: true,
                    manualFillEnabled: true,
                  },
                };
              }
              return { ok: true };
            },
          },
        };
        """
    )
    page.goto("https://jobs.lever.co/acme/123")
    page.add_script_tag(content=_load_script(REPO_ROOT / "executioner/src/content/bootstrap.js"))
    page.wait_for_timeout(100)
    return browser, page


def test_detected_page_prompt_gate_requires_visible_controls():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")

    assert 'detection.inputCount > 0 ||' in content
    assert 'detection.kind === "apply_entry"' in content
    assert 'detection.kind === "signin"' in content
    assert 'detection.kind === "signup"' in content


def test_career_apply_button_pages_can_prompt_without_visible_fields():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")

    assert "CAREER_APPLY_TERMS" in content
    assert "hasCareerApplyEntry" in content
    assert '"apply_entry"' in content
    assert "Open application" in content
    assert "genericApplyEntry" in background
    assert "generic_apply_navigation_started" in background


def test_detected_page_prompt_rechecks_after_page_readiness():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")

    assert "watchPageReadinessForPrompt" in content
    assert "DOMContentLoaded" in content
    assert "readystatechange" in content
    assert "window_load" in content
    assert "post_bootstrap_settled" in content


def test_page_ui_actions_are_logged():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")

    assert "logPageUiEvent" in content
    assert "ui.detect_prompt.show" in content
    assert "ui.detect_prompt.dismiss" in content
    assert "ui.toast.show" in content
    assert "ui.fill_progress.show" in content
    assert "ui.fill_summary.show" in content
    assert "ui.fill_progress.hide" in content
    assert "ui.llm_prompt.show" in content
    assert "ui.llm_prompt.use_click" in content
    assert "logUiEvent" in background
    assert "ui.toast.requested" in background
    assert "ui.fill_progress.show_requested" in background
    assert "ui.fill_summary.requested" in background
    assert "ui.transient.dismiss_requested" in background
    assert "ui.llm_prompt.requested" in background


def test_background_ui_messages_use_central_logged_sender():
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")

    assert "async function sendPageUiMessage" in background
    assert "failedAction" in background
    assert "failedSummary" in background
    assert "notePageFillCompleted" in background
    assert 'type: "hunt.apply.note_fill_completed"' in background


def test_fill_commit_failure_can_refresh_and_retry_once():
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")

    assert "function fillNeedsRefreshRetry" in background
    assert 'reason.includes("commit_not_verified")' in background
    assert "async function runFillWithOneRefreshRetry" in background
    assert "chrome.tabs.reload(tabId)" in background
    assert "maxRefreshRetries: 1" in background
    assert "fill.refresh_retry" in background
    assert "refreshRetry: result.refreshRetry || null" in background


def test_workday_runtime_error_recovery_stops_before_safe_next_click():
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")
    runner = _load_script(REPO_ROOT / "executioner/src/background/fill-runner.js")
    safe_next = _load_script(REPO_ROOT / "executioner/src/background/safe-next.js")
    runtime = _load_script(REPO_ROOT / "executioner/src/background/workday-runtime.js")
    live_smoke = _load_script(REPO_ROOT / "scripts/c3_workday_live_smoke.js")

    assert "Something went wrong" in runtime or "something went wrong" in runtime
    assert "please refresh the page and then try again" in runtime
    assert "chrome.tabs.reload(tabId)" in runtime
    assert "allFrames: true" in runtime
    assert "workday_runtime_error" in runtime
    assert "workday_application_shell_empty" in runtime
    assert "signedInShell" in runtime
    assert "RecoverWorkdayRuntimeErrorStep" in runner
    assert "workdayRuntimeRecovery" in runner
    assert "recoverWorkdayRuntimeErrorForTab" in background
    assert "safe_next_probe_workday_runtime_error" in background
    assert "next.workday_runtime_recovered_before_probe" in background
    assert "detectWorkdayRuntimeErrorForTab" in background
    assert "safe_next_workday_runtime_error" in background
    assert "next.workday_runtime_blocked" in background
    assert "C3 stopped before clicking Next" in background
    assert "workday_runtime_error_after_fill" in background
    assert "markWorkdayRuntimeErrorFill" in background
    assert "clicked_safe_next_recovered_workday_runtime_error" in background
    assert "clicked_safe_next_recovered_workday_runtime_error" in safe_next
    assert "workdayRuntimeError" in live_smoke
    assert "recoverWorkdayRuntimeError" in live_smoke
    assert "start_step_workday_runtime_error" in live_smoke
    assert "prefill_workday_runtime_error" in live_smoke


def test_fill_progress_can_request_cancel():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")
    runner = _load_script(REPO_ROOT / "executioner/src/background/fill-runner.js")
    field_pipeline = _load_script(REPO_ROOT / "executioner/src/shared/v2/field-pipeline.js")

    assert "hunt-apply-fill-progress-cancel" in content
    assert 'type: "hunt.apply.cancel_fill"' in content
    assert "ui.fill_progress.cancel_click" in content
    assert 'case "hunt.apply.cancel_fill"' in background
    assert "activeFillRuns" in background
    assert "activeFillRunByTab" in background
    assert "cancelActiveFillRunsForTab" in background
    assert "fill.supersede_previous" in background
    assert "superseded_by_new_fill" in background
    assert "markPageFillCancelled" in background
    assert "isCancelled" in background
    assert "buildCancelledPipelineResponse" in runner
    assert "context.cancelled" in runner
    assert "fillRunId: context.options.fillRunId" in runner
    assert "__huntApplyCancelAllFills" in field_pipeline
    assert "__huntApplyActiveFillRunId" in field_pipeline
    assert "__huntApplyActiveFillRunId" in background
    assert "__huntApplyCancelledFillRunIds" in background
    assert "__huntApplyCancelledFillRunIds" in field_pipeline
    assert "activeFillRequestId" in content
    assert "ui.detect_prompt.stale_fill_response" in content
    assert "Fill did not start. Open the popup and try Fill Current Page." not in content
    assert "user_cancelled" in field_pipeline


def test_fill_progress_restores_across_apply_navigation():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")

    assert "activeFillProgressByTab" in background
    assert "activeFillProgressByTab.set(tabId" in background
    assert "activeFillProgressByTab.delete(tabId)" in background
    assert 'case "hunt.apply.get_active_fill_progress"' in background
    assert 'type: "hunt.apply.get_active_fill_progress"' in content
    assert "async function restoreActiveFillProgress" in content
    assert "ui.fill_progress.restore" in content
    assert "await restoreActiveFillProgress();" in content


def test_fill_run_cancels_when_user_reloads_same_page():
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")
    compact_background = "".join(background.split())

    assert "cancelFillRunForUserReload" in background
    assert 'changeInfo.status === "loading"' in background
    assert 'cancelActiveFillRunsForTab(tabId,"page_reloaded"' in compact_background
    assert "normalizeComparableUrl" in background
    assert "expectedReloads" in background
    assert "markFillRunExpectedReload(fillRunId)" in background
    assert "fill.cancel_page_reload" in background
    assert "fill_cancelled_page_reload" in background


def test_apply_entry_progress_uses_start_application_language():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")

    assert "Trying to start application" in content
    assert "Trying to start application" in background
    assert "Filling application page: attempt 1" in background
    assert "Filling current page: attempt 1" in background
    assert "chooseBestWorkflowActionResult" in background


def test_apply_entry_prompt_click_suppresses_transition_reprompts():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")

    assert "PROMPT_SUPPRESS_AFTER_APPLY_ENTRY_MS" in content
    assert "function suppressDetectedPrompts" in content
    assert '"apply_entry_transition"' in content
    assert 'kind === "apply_entry"' in content
    assert "Date.now() < detectedPromptSuppressedUntil" in content
    assert "!transitionCooldownActive" in content


def test_apply_entry_uses_condition_waits_instead_of_mandatory_sleep():
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")
    apply_entry = background[
        background.index("function createClickWorkdayApplyManuallyFunction")
        : background.index("class C3WorkflowSection")
    ]
    workflow = background[
        background.index("class C3ApplyEntryWorkflow")
        : background.index("class C3JobFillWorkflow")
    ]

    assert "waitForApplyEntryState" in apply_entry
    assert "waitForApplyEntryTransitionForTab" in workflow
    assert "waitForApplicationFieldsReadyAfterAuth" in workflow
    assert 'pageLabel: "application page"' in workflow
    assert "setTimeout(resolve, 900)" not in apply_entry
    assert "setTimeout(resolve, 3600)" not in apply_entry
    assert "setTimeout(resolve, result.navigationStarted ? 5000 : 2500)" not in workflow


def test_application_readiness_requires_application_fields_not_generic_controls():
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")
    readiness = background[
        background.index("async function inspectApplicationFieldReadiness")
        : background.index("async function waitForApplicationFieldsReadyAfterAuth")
    ]
    wait_ready = background[
        background.index("async function waitForApplicationFieldsReadyAfterAuth")
        : background.index("function compactStopDetails")
    ]

    assert "applicationFieldCount" in readiness
    assert "requiredApplicationFieldCount" in readiness
    assert "entry.applicationFieldCount > 0" in readiness
    assert "skip to main content" in readiness
    assert "lastProbe.applicationFieldCount > 0" in wait_ready
    assert "lastProbe.meaningfulControlCount >= 2" not in wait_ready


def test_page_ui_message_recovers_when_content_script_missing():
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")
    ui_message = background[
        background.index("async function sendPageUiMessage")
        : background.index("function safeFilePart")
    ]

    assert "__huntApplyContentBootstrapLoaded" in content
    assert "chrome.scripting.executeScript" in ui_message
    assert 'files: ["src/content/bootstrap.js"]' in ui_message
    assert "recoveredViaInjection" in ui_message


def test_page_walk_next_uses_condition_waits_instead_of_mandatory_sleep():
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")
    safe_next_click = background[
        background.index("async function clickSafeNextForTab")
        : background.index("async function maybeHandleSafeNextAfterFill")
    ]
    page_walk = background[
        background.index("async function runV2PageWalkAfterFill")
        : background.index("async function runFillWithOneRefreshRetry")
    ]

    assert "waitForPostNextSignalForTab" in background
    assert "pageSnapshotChangedAfterAction" in background
    assert "setTimeout(resolve, 1800)" not in safe_next_click
    assert "setTimeout(resolve, 650)" not in page_walk
    assert "setTimeout(resolve, 900)" not in page_walk


def test_auth_flow_uses_condition_waits_instead_of_mandatory_sleep():
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")
    combined_workflow = background[
        background.index("class C3CombinedFillWorkflow")
        : background.index("async function logUiEvent")
    ]
    page_walk = background[
        background.index("async function runV2PageWalkAfterFill")
        : background.index("async function runFillWithOneRefreshRetry")
    ]

    assert "waitForAuthActionTransitionForTab" in background
    assert "authDetectionChangedAfterAction" in background
    assert "inspectApplicationFieldReadiness" in background
    assert "setTimeout(resolve, 1800)" not in combined_workflow
    assert "setTimeout(resolve, 1800)" not in page_walk
    assert "setTimeout(resolve, 1600)" not in page_walk


def test_workday_apply_detection_checks_all_visible_buttons_before_log_cap():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")

    assert "var buttonLabels = Array.from" in background
    assert "var buttons = buttonLabels.slice(0, 80)" in background
    assert "buttonLabels.some(function (label)" in background
    assert "/^apply(?:\\s+apply)?$/i.test(label)" in content
    assert "/^apply\\b/i.test(label) && /\\/apply(?:$|[/?#\\s])/i.test(label)" in content


def test_v2_page_walk_counts_successful_pages_and_shows_summary():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")

    assert "hunt.apply.show_fill_summary" in content
    assert "hunt-apply-fill-summary" in content
    assert "ui.fill_summary.show" in content
    assert "async function showFillSummary" in background
    assert "function buildFillSummaryPayload" in background
    assert "function uniqueReviewIssues" in background
    assert "pagesAdvancedThisRun" in background
    assert "Math.max(lastPageNumber, successfulPageCount)" in background
    assert "async function getPageSnapshot" in background
    assert "successfulPageCount += 1" in background
    assert "failedPageNumber" in background
    assert "visible_validation_errors_after_next" in background
    assert "page_did_not_advance_after_next" in background
    assert "`Filling page ${pageIndex + 1}`" not in background
    assert "describePageWalkAttempt(" in background
    assert '"Filling"' in background


def test_clear_page_shows_progress_and_scrolls_while_clearing():
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")
    clear_pipeline = _load_script(REPO_ROOT / "executioner/src/shared/v2/clear-pipeline.js")
    field_drivers = _load_script(REPO_ROOT / "executioner/src/shared/v2/field-drivers.js")

    assert 'await showFillProgress(tabId, "Clearing page")' in background
    assert "return clearCurrentPageV2(tabId, state)" in background
    assert "runHuntV2Clear" in background
    assert "clearGenericIconControls" in clear_pipeline
    assert "clearUploadedFileControls" in clear_pipeline
    assert "fieldDrivers.clearField" in clear_pipeline
    assert "field_clear_failed" in clear_pipeline
    assert "uploaded_file_clear_result" in clear_pipeline
    assert "uploadedFileClears" in clear_pipeline
    assert "genericIconClears" in clear_pipeline
    assert "async function clearField" in field_drivers
    assert "await sleep(250)" in clear_pipeline
    assert "await sleep(420)" in clear_pipeline
    assert (
        "await sleep(1000)"
        not in background[
            background.index("async function clearCurrentPage") : background.index(
                "function alarmPeriodMinutes"
            )
        ]
    )


def test_popup_clear_dispatches_then_closes_menu():
    popup = _load_script(REPO_ROOT / "executioner/src/popup/popup.js")
    handler = popup[
        popup.index('document.getElementById("clear-page")') : popup.index("loadState().catch")
    ]

    assert 'setStatus("Clearing page...", "info")' in handler
    assert 'triggeredBy: "popup_clear_current_page"' in handler
    assert "const responsePromise = chrome.runtime.sendMessage" in handler
    assert "window.close()" in handler


def test_v2_already_filled_text_inputs_do_not_count_as_changed():
    field_state = _load_script(REPO_ROOT / "executioner/src/shared/v2/field-state.js")
    field_pipeline = _load_script(REPO_ROOT / "executioner/src/shared/v2/field-pipeline.js")

    assert "readFieldState" in field_state
    assert "isEmptyState" in field_state
    assert "field_fill_result" in field_pipeline


def test_v2_phone_and_legal_name_specific_guards():
    catalog = _load_script(REPO_ROOT / "executioner/src/shared/v2/field-catalog.js")
    workday_ui = _load_script(REPO_ROOT / "executioner/src/ats/workday/workday-ui-v2.js")

    assert '"phone"' in catalog
    assert '"phone_country_code"' in catalog
    assert "legal name" in workday_ui
    assert "first name" in workday_ui
    assert "last name" in workday_ui


def test_workday_logs_field_and_dropdown_actions():
    field_pipeline = _load_script(REPO_ROOT / "executioner/src/shared/v2/field-pipeline.js")
    field_drivers = _load_script(REPO_ROOT / "executioner/src/shared/v2/field-drivers.js")
    workday_v2_drivers = _load_script(
        REPO_ROOT / "executioner/src/ats/workday/workday-drivers-v2.js"
    )
    workday_repeatables = _load_script(
        REPO_ROOT / "executioner/src/ats/workday/workday-repeatables-v2.js"
    )

    assert "field_start" in field_pipeline
    assert "field_fill_result" in field_pipeline
    assert "field_skipped" in field_pipeline
    assert "fillField" in field_drivers
    assert "workday_phone_country_code_option" in workday_v2_drivers
    assert "workday_phone_country_code_missing" in workday_v2_drivers
    assert "workday_phone_country_code_commit_failed" in workday_v2_drivers
    assert "select_virtualized_phone_country_code" in workday_v2_drivers
    assert "workdayActiveListboxFor" in workday_v2_drivers
    assert "workdayClickOptionCommitTarget" in workday_v2_drivers
    assert "workdayOptionRadioTarget" in workday_v2_drivers
    assert "isApplicationSourceField" in workday_v2_drivers
    assert "source--source" in workday_v2_drivers
    assert "sourceOptionFailureKind" in workday_v2_drivers
    assert "workday_source_options_unavailable" in workday_v2_drivers
    assert "findHierarchicalWorkdayOption" in workday_v2_drivers
    assert "workday_prompt_category_open" in workday_v2_drivers
    assert "workday_prompt_category_options" in workday_v2_drivers
    assert "waitForWorkdayOptions" in workday_v2_drivers
    assert "sourceCategoryScore" in workday_v2_drivers
    assert "data-uxi-multiselectlistitem-hassidecharm" in workday_v2_drivers
    assert "data-uxi-multiselectlistitem-type" in workday_v2_drivers
    assert "var aliasTexts = answerTexts(answer, option)" in workday_v2_drivers
    assert "optionMatchesAny(candidate, aliasTexts)" in workday_v2_drivers
    assert "preferredSourceFallbackOption" in workday_v2_drivers
    assert "isReferralSourceOption" in workday_v2_drivers
    assert "isSalaryField(field, answer)" in workday_v2_drivers
    assert "preferredWorkdayOption(flatOptions, option, answer, field)" in workday_v2_drivers
    assert "await clearWorkdayField(field, audit, fieldAudit)" in workday_v2_drivers
    assert 'label.includes("linkedin")' in workday_v2_drivers
    assert 'label.includes("employee referral")' in workday_v2_drivers
    assert "document.elementFromPoint" in workday_v2_drivers
    assert "var options = await collectWorkdayOptions" in workday_v2_drivers
    assert "isSelectInputPrompt" in workday_repeatables
    assert "fillSelectInputPrompt" in workday_repeatables
    assert "waitForPromptTarget" in workday_repeatables
    assert "promptOptionCommitTarget" in workday_repeatables
    assert "clickPromptOption" in workday_repeatables
    assert 'input[data-automation-id="radioBtn"]' in workday_repeatables
    assert "data-uxi-widget-type" in workday_repeatables
    assert "data-uxi-multiselect-id" in workday_repeatables
    assert "field.options || []" not in workday_v2_drivers[
        workday_v2_drivers.index("async function fillWorkdayPopup") : workday_v2_drivers.index(
            "async function fillPhoneCountryCode"
        )
    ]
    assert "preferredSourceFallbackOption" in workday_v2_drivers


def test_post_fill_prompt_cooldown_blocks_detected_prompt():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")

    assert "PROMPT_SUPPRESS_AFTER_FILL_MS" in content
    assert "lastFillCompletedAt" in content
    assert "lastFillCompletedUrl" in content
    assert "lastFillCompletedStep" in content
    assert 'message?.type === "hunt.apply.note_fill_completed"' in content
    assert "!fillCooldownActive" in content
    assert "lastFillCompletedStep === currentStepText()" in content


def test_workday_step_change_clears_post_fill_prompt_cooldown():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")

    context_change = content[
        content.index("function handlePageContextChange") : content.index("function canPrompt")
    ]
    assert "currentStepText() !== lastFillCompletedStep" in context_change
    assert "lastFillCompletedAt = 0" in context_change


def test_detected_page_prompt_auto_dismisses_and_clears_on_spa_navigation():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")
    signature_fn = content[
        content.index("function promptSignature") : content.index("function pageContextKey")
    ]

    assert "PROMPT_AUTO_DISMISS_MS = 5000" in content
    assert "promptAutoDismissTimer" in content
    assert "ui.detect_prompt.auto_dismiss" in content
    assert "detection.inputCount" not in signature_fn
    assert "dismissedPromptSignatures.add(promptSignature({ kind, inputCount }))" in content
    assert "function handlePageContextChange" in content
    assert "ui.transient.dismiss_on_page_change" in content
    assert '["pushState", "replaceState"]' in content
    assert 'window.addEventListener("popstate"' in content
    assert 'window.addEventListener("hashchange"' in content
    assert 'lastPromptSignature = ""' in content


def test_fill_progress_dismisses_detected_page_prompt():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")

    show_fill_progress = content[
        content.index("function showFillProgress") : content.index("function showExtensionToast")
    ]

    assert "removePrompt();" in show_fill_progress


def test_page_walk_transient_dismissal_can_preserve_fill_progress():
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")

    dismiss_fn = content[
        content.index("function dismissTransientUi") : content.index("function escapeHtml")
    ]
    dismiss_message = content[
        content.index('message?.type === "hunt.apply.dismiss_transient_ui"') : content.index(
            'message?.type === "hunt.apply.show_toast"'
        )
    ]
    page_walk = background[
        background.index("async function runV2PageWalkAfterFill") : background.index(
            "function chooseBestV2ClearFrame"
        )
    ]

    assert "preserveFillProgress = false" in dismiss_fn
    assert "if (!preserveFillProgress)" in dismiss_fn
    assert "hideFillProgress();" in dismiss_fn
    assert "preserveFillProgress: Boolean(message.preserveFillProgress)" in dismiss_message
    assert "dismissPageTransientUi(tabId, { preserveFillProgress: true })" in page_walk
    assert "page_walk.advance_observed" in page_walk


def test_fill_startup_cleanup_preserves_prompt_progress():
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")
    fill_handler = background[
        background.index('case "hunt.apply.fill_current_page"')
        : background.index('case "hunt.apply.fill_remaining_with_llm"')
    ]

    assert "dismissPageTransientUi(tabId, { preserveFillProgress: true })" in fill_handler
    assert "dismissPageTransientUi(tabId);" not in fill_handler


def test_apply_entry_startup_skips_non_entry_checks_before_click():
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")
    fill_handler = background[
        background.index('case "hunt.apply.fill_current_page"')
        : background.index('case "hunt.apply.fill_remaining_with_llm"')
    ]
    apply_entry_run = background[
        background.index("class C3ApplyEntryWorkflow")
        : background.index("class C3JobFillWorkflow")
    ]

    assert "const startupDetection = await detectWorkflowForTab(tabId);" in fill_handler
    assert "const startsAtApplyEntry = Boolean(startupDetection?.isApplyEntryPage);" in fill_handler
    assert "startupRuntimeRecovery = startsAtApplyEntry" in fill_handler
    assert "directVerificationGate = startsAtApplyEntry" in fill_handler
    assert "initialDetection: startupDetection" in fill_handler
    assert "isApplyEntryRequest" not in fill_handler
    assert "const detectLogPromise = this.log(" in apply_entry_run
    assert apply_entry_run.index("const detectLogPromise = this.log(") < apply_entry_run.index(
        "chrome.scripting.executeScript"
    )
    assert apply_entry_run.index("await detectLogPromise;") > apply_entry_run.index(
        "chooseBestWorkflowActionResult"
    )


def test_prompt_fill_click_cannot_leave_prompt_stuck_filling():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")

    fill_message = 'type: "hunt.apply.fill_current_page"'
    llm_message = 'type: "hunt.apply.fill_remaining_with_llm"'
    show_toast = "showExtensionToast("
    fill_click_start = content.rindex(
        "showFillProgress({ message: promptProgressMessage(kind) });",
        0,
        content.index(fill_message),
    )
    fill_handler = content[
        fill_click_start : content.index("setTimeout(removePrompt", content.index(fill_message))
    ]
    llm_handler = content[
        content.index(llm_message) : content.index(
            "setTimeout(removeLlmPrompt", content.index(llm_message)
        )
    ]

    assert "PROMPT_FILL_REQUEST_TIMEOUT_MS = 65000" in content
    assert "runtimeMessageWithTimeout" in content
    assert "try {\n      runtimeMessage = chrome.runtime.sendMessage(message);" in content
    assert "try {\n      chrome.runtime" in content
    assert "detected_prompt_fill_timeout" in fill_handler
    assert "promptProgressMessage(kind)" in fill_handler
    assert fill_handler.index(
        "showFillProgress({ message: promptProgressMessage(kind) });"
    ) < fill_handler.index("ui.detect_prompt.fill_click")
    assert "ui.detect_prompt.fill_response" in fill_handler
    assert "Still waiting for fill result" in fill_handler
    assert content.index(fill_message) > content.rindex(show_toast, 0, content.index(fill_message))
    assert show_toast in fill_handler
    assert show_toast not in llm_handler


def test_detected_prompt_cleanup_runs_before_logging():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")

    dismiss_handler = content[
        content.index('getElementById("dismiss").addEventListener') : content.index(
            "host.shadowRoot", content.index('getElementById("dismiss").addEventListener')
        )
    ]
    auto_dismiss_handler = content[
        content.index("promptAutoDismissTimer = setTimeout") : content.index(
            'logPageUiEvent("ui.detect_prompt.show"'
        )
    ]

    assert dismiss_handler.index("removePrompt();") < dismiss_handler.index(
        "ui.detect_prompt.dismiss"
    )
    assert auto_dismiss_handler.index("dismissedPromptSignatures.add") < auto_dismiss_handler.index(
        "removePrompt();"
    )
    assert auto_dismiss_handler.index("removePrompt();") < auto_dismiss_handler.index(
        "ui.detect_prompt.auto_dismiss"
    )


def test_detected_page_prompt_skips_zero_visible_controls():
    if sync_playwright is None:
        pytest.skip("playwright is required for the C3 prompt fixture")

    with sync_playwright() as playwright:
        try:
            browser, page = _new_prompt_page(
                playwright,
                """
                <main>
                  <h1>Apply for Junior AI Software Engineer</h1>
                  <p>Submit your resume and application when the form is available.</p>
                </main>
                """,
            )
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        prompt_exists = page.evaluate(
            """() => Boolean(document.getElementById("hunt-apply-detected-page-prompt"))"""
        )
        browser.close()

    assert prompt_exists is False


def test_detected_page_prompt_allows_visible_controls():
    if sync_playwright is None:
        pytest.skip("playwright is required for the C3 prompt fixture")

    with sync_playwright() as playwright:
        try:
            browser, page = _new_prompt_page(
                playwright,
                """
                <main>
                  <h1>Apply for Junior AI Software Engineer</h1>
                  <label>Email <input id="email" name="email" /></label>
                </main>
                """,
            )
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        prompt_exists = page.evaluate(
            """() => Boolean(document.getElementById("hunt-apply-detected-page-prompt"))"""
        )
        browser.close()

    assert prompt_exists is True
