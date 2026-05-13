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

    assert "detection.inputCount > 0" in content


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
    assert "ui.fill_progress.hide" in content
    assert "ui.llm_prompt.show" in content
    assert "ui.llm_prompt.use_click" in content
    assert "logUiEvent" in background
    assert "ui.toast.requested" in background
    assert "ui.fill_progress.show_requested" in background
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


def test_fill_progress_can_request_cancel():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")
    runner = _load_script(REPO_ROOT / "executioner/src/background/fill-runner.js")
    generic = _load_script(REPO_ROOT / "executioner/src/ats/generic/fill.js")
    workday = _load_script(REPO_ROOT / "executioner/src/ats/workday/fill.js")

    assert "hunt-apply-fill-progress-cancel" in content
    assert 'type: "hunt.apply.cancel_fill"' in content
    assert "ui.fill_progress.cancel_click" in content
    assert 'case "hunt.apply.cancel_fill"' in background
    assert "activeFillRuns" in background
    assert "markPageFillCancelled" in background
    assert "isCancelled" in background
    assert "buildCancelledPipelineResponse" in runner
    assert "context.cancelled" in runner
    assert "fillRunId: context.options.fillRunId" in runner
    assert "__huntApplyCancelAllFills" in generic
    assert "__huntApplyCancelAllFills" in workday
    assert "user_cancelled" in generic
    assert "user_cancelled" in workday


def test_clear_page_shows_progress_and_scrolls_while_clearing():
    background = _load_script(REPO_ROOT / "executioner/src/background/index.js")

    assert 'await showFillProgress(tabId, "Clearing page")' in background
    assert "function scrollToClearingTarget" in background
    assert "const clearTrace = []" in background
    assert 'traceClear("field_clear"' in background
    assert 'traceClear("clear_click"' in background
    assert 'traceClear("clear_key"' in background
    assert 'traceClear("dropdown_close_start"' in background
    assert 'traceClear("dropdown_select_attempt"' in background
    assert "selectAlternateWorkdayOptionBeforeForceClear" in background
    assert "select_alternate_before_force_clear" in background
    assert "clearTraceTruncated" in background
    assert 'behavior: "smooth"' in background
    assert "await sleep(250)" in background
    assert "await sleep(400)" in background
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


def test_workday_already_filled_text_inputs_do_not_count_as_changed():
    workday = _load_script(REPO_ROOT / "executioner/src/ats/workday/fill.js")

    assert "markTextInputAlreadyFilled" in workday
    assert 'reason: "text_input_matches_value"' in workday
    city_branch = workday[
        workday.index("if (isExactCityField(elem, desc) && profile.location)") : workday.index(
            "var profileMatch = u.chooseProfileMatch", workday.index("if (isExactCityField")
        )
    ]
    profile_branch = workday[
        workday.index("var profileValue = profileMatch") : workday.index(
            "u.setElementValue(elem, profileValue"
        )
    ]
    assert "markTextInputAlreadyFilled" in city_branch
    assert "filledFields.push" not in city_branch[: city_branch.index("u.setElementValue")]
    assert "markTextInputAlreadyFilled" in profile_branch


def test_workday_logs_field_and_dropdown_actions():
    workday = _load_script(REPO_ROOT / "executioner/src/ats/workday/fill.js")

    assert "traceInteractionLimit = 1000" in workday
    assert '"field_consider"' in workday
    assert '"field_filled"' in workday
    assert '"field_already_filled"' in workday
    assert '"field_skipped"' in workday
    assert '"field_count_recorded"' in workday
    assert '"dropdown_fill_start"' in workday
    assert '"dropdown_open_attempt"' in workday
    assert '"dropdown_options_scored"' in workday
    assert '"dropdown_keyboard_select_attempt"' in workday
    assert '"dropdown_keyboard_active_option"' in workday
    assert '"dropdown_keyboard_select_failed"' in workday
    assert '"dropdown_select_attempt"' in workday
    assert '"dropdown_select_fallback_enter"' in workday
    assert '"dropdown_select_failed"' in workday
    assert '"dropdown_close_start"' in workday
    assert '"dropdown_close_end"' in workday
    assert '"phone_country_code_fill_start"' in workday
    assert '"phone_country_code_select_attempt"' in workday
    assert '"phone_country_code_select_failed"' in workday
    assert "keyboard_commit_phone_country_code_option" in workday
    assert "force_commit_diagnostic_only" in workday
    assert "reacquireBestVisibleOption" in workday
    assert "cycleWorkdayButtonChoice" in workday
    assert "select_alternate_before_correct_workday_button_option" in workday
    assert "candidate.score >= 100" in workday
    assert "traceInteractionLimit: traceInteractionLimit" in workday


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
        content.index("function handlePageContextChange") : content.index(
            "function canPrompt"
        )
    ]
    assert "currentStepText() !== lastFillCompletedStep" in context_change
    assert "lastFillCompletedAt = 0" in context_change


def test_detected_page_prompt_auto_dismisses_and_clears_on_spa_navigation():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")

    assert "PROMPT_AUTO_DISMISS_MS = 10000" in content
    assert "promptAutoDismissTimer" in content
    assert "ui.detect_prompt.auto_dismiss" in content
    assert "function handlePageContextChange" in content
    assert "ui.transient.dismiss_on_page_change" in content
    assert '["pushState", "replaceState"]' in content
    assert 'window.addEventListener("popstate"' in content
    assert 'window.addEventListener("hashchange"' in content
    assert 'lastPromptSignature = ""' in content


def test_prompt_fill_results_use_background_toast_only():
    content = _load_script(REPO_ROOT / "executioner/src/content/bootstrap.js")

    fill_message = 'type: "hunt.apply.fill_current_page"'
    llm_message = 'type: "hunt.apply.fill_remaining_with_llm"'
    show_toast = "showExtensionToast("
    fill_handler = content[
        content.index(fill_message) : content.index(
            "setTimeout(removePrompt", content.index(fill_message)
        )
    ]
    llm_handler = content[
        content.index(llm_message) : content.index(
            "setTimeout(removeLlmPrompt", content.index(llm_message)
        )
    ]

    assert content.index(fill_message) > content.rindex(show_toast, 0, content.index(fill_message))
    assert show_toast not in fill_handler
    assert show_toast not in llm_handler


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
