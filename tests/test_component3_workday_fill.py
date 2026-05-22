import json
from pathlib import Path

import pytest  # type: ignore[reportMissingImports]

try:
    from playwright.sync_api import Error as PlaywrightError  # type: ignore[reportMissingImports]
    from playwright.sync_api import sync_playwright  # type: ignore[reportMissingImports]
except ImportError:  # pragma: no cover
    sync_playwright = None

    class PlaywrightError(Exception):
        """Fallback used only when Playwright is not installed."""


REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_script(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _module_to_browser_script(source: str) -> str:
    return source.replace("export function", "function").replace("export const", "const")


def _load_v2_workday_scripts(page):
    for path in [
        "executioner/src/shared/injected.js",
        "executioner/src/shared/v2/audit.js",
        "executioner/src/shared/v2/field-catalog.js",
        "executioner/src/shared/v2/ui-inspector.js",
        "executioner/src/ats/workday/workday-ui-v2.js",
        "executioner/src/shared/v2/field-state.js",
        "executioner/src/shared/v2/option-collector.js",
        "executioner/src/shared/v2/option-matcher.js",
        "executioner/src/shared/v2/question-identifier.js",
        "executioner/src/shared/v2/answer-resolver.js",
        "executioner/src/shared/v2/field-drivers.js",
        "executioner/src/ats/workday/workday-drivers-v2.js",
        "executioner/src/shared/v2/field-pipeline.js",
        "executioner/src/shared/v2/clear-pipeline.js",
        "executioner/src/ats/workday/workday-repeatables-v2.js",
    ]:
        page.add_script_tag(content=_load_script(REPO_ROOT / path))


def test_workday_v2_empty_popup_accepts_matching_committed_button_value():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <div data-automation-id="applyFlowMyInfoPage">
                  <div data-automation-id="formField-phoneType">
                    Phone Device Type*
                    <button id="phoneNumber--phoneType" name="phoneType" type="button" aria-haspopup="listbox" aria-label="Phone Device Type Select One Required">Mobile</button>
                  </div>
                </div>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: { phoneDeviceType: "Mobile" },
                settings: { fillRequiredOnly: true, useFieldPipelineV2: true },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_empty_popup_committed_match",
              });
            }
            """
        )
        browser.close()

    fields = {entry["fieldId"]: entry for entry in result["v2Audit"]["fields"]}
    phone_type = fields["phoneNumber--phoneType"]
    fill_steps = [
        event
        for event in result["v2Audit"]["events"]
        if event.get("fieldId") == "phoneNumber--phoneType"
        and event.get("action") == "field_fill_result"
    ]

    assert phone_type["filled"] is True
    assert phone_type["valueSource"] == "profile:phoneDeviceType"
    assert fill_steps[-1]["reason"] in {
        "committed_workday_selection",
        "popup_empty_already_committed",
    }


def test_workday_v2_empty_popup_rejects_wrong_committed_button_value():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <div data-automation-id="applyFlowMyInfoPage">
                  <div data-automation-id="formField-phoneType">
                    Phone Device Type*
                    <button id="phoneNumber--phoneType" name="phoneType" type="button" aria-haspopup="listbox" aria-label="Phone Device Type Select One Required">Fax</button>
                  </div>
                </div>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: { phoneDeviceType: "Mobile" },
                settings: { fillRequiredOnly: true, useFieldPipelineV2: true },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_empty_popup_committed_mismatch",
              });
            }
            """
        )
        browser.close()

    fields = {entry["fieldId"]: entry for entry in result["v2Audit"]["fields"]}
    phone_type = fields["phoneNumber--phoneType"]
    fill_steps = [
        event
        for event in result["v2Audit"]["events"]
        if event.get("fieldId") == "phoneNumber--phoneType"
        and event.get("action") == "field_fill_result"
    ]

    assert phone_type["filled"] is False
    assert fill_steps[-1]["reason"] == "workday_popup_options_missing"


def test_workday_v2_phone_type_uses_controlled_listbox_and_ordered_fallback():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <head>
                <style>
                  .menu { display: none; border: 1px solid #999; padding: 4px; }
                  .menu.open { display: block; }
                  [role="option"] { display: block; min-height: 20px; padding: 4px; }
                </style>
              </head>
              <body>
                <div data-automation-id="applyFlowMyInfoPage">
                  <div data-automation-id="formField-prefix">
                    Prefix
                    <button id="name--legalName--title" name="legalName--title" type="button" aria-haspopup="listbox" aria-controls="prefix-menu">Select One</button>
                    <div id="prefix-menu" role="listbox" class="menu open">
                      <div role="option">Dr.</div>
                      <div role="option">Ms.</div>
                    </div>
                  </div>
                  <div data-automation-id="formField-phoneType">
                    Phone Device Type*
                    <button id="phoneNumber--phoneType" name="phoneType" type="button" aria-haspopup="listbox" aria-controls="phone-type-menu" aria-label="Phone Device Type Select One Required">Select One</button>
                    <div id="phone-type-menu" role="listbox" class="menu">
                      <div role="option">Home</div>
                      <div role="option">Work</div>
                    </div>
                  </div>
                </div>
                <script>
                  function wire(buttonSelector, menuSelector) {
                    const control = document.querySelector(buttonSelector);
                    const menu = document.querySelector(menuSelector);
                    control.addEventListener("click", () => menu.classList.add("open"));
                    menu.querySelectorAll("[role=option]").forEach((option) => {
                      option.addEventListener("click", () => {
                        control.textContent = option.textContent;
                        control.value = option.textContent;
                        menu.classList.remove("open");
                      });
                    });
                  }
                  wire("#phoneNumber--phoneType", "#phone-type-menu");
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: {},
                settings: { fillRequiredOnly: true, useFieldPipelineV2: true },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_phone_type_controlled_listbox",
              });
            }
            """
        )
        value = page.evaluate(
            """() => document.querySelector("#phoneNumber--phoneType").textContent"""
        )
        browser.close()

    fields = {entry["fieldId"]: entry for entry in result["v2Audit"]["fields"]}
    phone_type = fields["phoneNumber--phoneType"]

    assert phone_type["filled"] is True
    assert phone_type["questionType"] == "phone_device_type"
    assert phone_type["valueSource"] == "default:phone_device_type"
    assert value == "Work"


def test_workday_v2_source_prompt_drills_into_category_and_selects_leaf():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <div data-automation-id="applyFlowMyInfoPage">
                  <div data-automation-id="formField-source" data-fkit-id="source--source">
                    <label for="source--source">How Did You Hear About Us?*</label>
                    <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
                      <div data-automation-id="multiselectInputContainer">
                        <input id="source--source" placeholder="Search" aria-required="true" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="source-list" />
                        <button type="button" data-automation-id="promptSearchButton">List</button>
                      </div>
                    </div>
                  </div>
                </div>
                <script>
                  const container = document.querySelector("[data-automation-id='multiSelectContainer']");
                  function showCategories() {
                    if (document.querySelector("#source-menu")) return;
                    setTimeout(() => {
                      if (document.querySelector("#source-menu")) return;
                      document.body.insertAdjacentHTML(
                        "beforeend",
                        `<div id="source-menu" role="listbox" data-automation-id="activeListContainer">
                          <div role="option" data-automation-id="promptOption" data-hunt-prompt-category="true" onclick="showSourceChildren('Alumni Portal')">Alumni Portal <svg></svg></div>
                          <div role="option" data-automation-id="promptOption" data-hunt-prompt-category="true" onclick="showSourceChildren('Job Sites')">Job Sites <svg></svg></div>
                          <div role="option" data-automation-id="promptOption" data-hunt-prompt-category="true" onclick="showSourceChildren('Social Media')">Social Media <svg></svg></div>
                        </div>`
                      );
                    }, 420);
                  }
                  window.showSourceChildren = (category) => {
                    const menu = document.querySelector("#source-menu");
                    menu.innerHTML = `<button type="button" data-automation-id="promptBackButton">Back</button><h4>${category}</h4>`;
                    setTimeout(() => {
                      const leaf = category === "Social Media" ? "LinkedIn" : `${category} Generic`;
                      menu.insertAdjacentHTML(
                        "beforeend",
                        `<div role="option" data-automation-id="promptOption" onclick="selectSource('${leaf}')">
                          <input type="radio" data-automation-id="radioBtn" onclick="event.stopPropagation()" /> ${leaf}
                        </div>`
                      );
                    }, 380);
                  };
                  window.selectSource = (leaf) => {
                    container.insertAdjacentHTML(
                      "beforeend",
                      `<div role="option" data-automation-id="selectedItem" aria-label="${leaf}, press delete to clear value.">${leaf}</div>`
                    );
                    document.querySelector("#source-menu")?.remove();
                  };
                  document.querySelector("#source--source").addEventListener("click", showCategories);
                  document.querySelector("[data-automation-id='promptSearchButton']").addEventListener("click", showCategories);
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: {
                  applicationSourceCategory: "Job Board",
                  applicationSource: "LinkedIn",
                },
                settings: { fillRequiredOnly: true, useFieldPipelineV2: true },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_source_tree",
              });
            }
            """
        )
        selected = page.evaluate(
            """
            () => document.querySelector("[data-automation-id='selectedItem']")?.textContent.trim() || ""
            """
        )
        browser.close()

    fields = {entry["fieldId"]: entry for entry in result["v2Audit"]["fields"]}
    source = fields["source--source"]
    category_events = [
        event
        for event in result["v2Audit"]["events"]
        if event.get("action") == "workday_prompt_category_options"
    ]

    assert result["ok"] is True
    assert selected == "LinkedIn"
    assert source["filled"] is True
    assert category_events
    assert any("LinkedIn" in event["detail"]["options"] for event in category_events)


def test_workday_v2_source_prompt_drills_flat_category_to_radio_leaf():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <div data-automation-id="applyFlowMyInfoPage">
                  <div data-automation-id="formField-source" data-fkit-id="source--source">
                    <label for="source--source">How Did You Hear About Us?*</label>
                    <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
                      <div data-automation-id="multiselectInputContainer">
                        <input id="source--source" placeholder="Search" aria-required="true" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="source-list" />
                      </div>
                    </div>
                  </div>
                </div>
                <script>
                  const container = document.querySelector("[data-automation-id='multiSelectContainer']");
                  function showSourceMenu() {
                    if (document.querySelector("#source-menu")) return;
                    document.body.insertAdjacentHTML(
                      "beforeend",
                      `<div id="source-menu" role="listbox" data-automation-id="activeListContainer">
                        <div id="source-campus" role="option" data-automation-id="menuItem">Campus Campaign</div>
                        <div id="source-career" role="option" data-automation-id="menuItem">Career Websites</div>
                        <div id="source-board" role="option" data-automation-id="menuItem">Job Board</div>
                        <div id="source-sites" role="option" data-automation-id="menuItem">Job Sites</div>
                      </div>`
                    );
                    document.querySelector("#source-board").addEventListener("click", () => {
                      const menu = document.querySelector("#source-menu");
                      setTimeout(() => {
                        menu.innerHTML =
                          `<div id="source-industry" role="option" data-automation-id="menuItem">
                            <input type="radio" data-automation-id="radioBtn" onclick="selectSource('Industry Job Board')" />
                            <span data-automation-id="promptOption">Industry Job Board</span>
                          </div>`;
                      }, 160);
                    });
                  }
                  window.selectSource = (leaf) => {
                    container.insertAdjacentHTML(
                      "beforeend",
                      `<div role="option" data-automation-id="selectedItem" aria-label="${leaf}, press delete to clear value.">${leaf}</div>`
                    );
                    document.querySelector("#source-menu")?.remove();
                  };
                  document.querySelector("#source--source").addEventListener("click", showSourceMenu);
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: {
                  applicationSourceCategory: "Job Board",
                  applicationSource: "LinkedIn",
                  applicationSourceDetail: "LinkedIn",
                },
                settings: { fillRequiredOnly: true, useFieldPipelineV2: true },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_source_flat_category",
              });
            }
            """
        )
        selected = page.evaluate(
            """
            () => document.querySelector("[data-automation-id='selectedItem']")?.textContent.trim() || ""
            """
        )
        browser.close()

    fields = {entry["fieldId"]: entry for entry in result["v2Audit"]["fields"]}
    source = fields["source--source"]
    category_events = [
        event
        for event in result["v2Audit"]["events"]
        if event.get("action") == "workday_prompt_category_options"
    ]

    assert result["ok"] is True
    assert selected == "Industry Job Board"
    assert source["filled"] is True
    assert category_events
    assert any(
        "Industry Job Board" in event["detail"]["options"]
        for event in category_events
    )


def test_workday_v2_source_prompt_prefers_safe_job_site_leaf():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <div data-automation-id="applyFlowMyInfoPage">
                  <div data-automation-id="formField-source" data-fkit-id="source--source">
                    <label for="source--source">How Did You Hear About Us?*</label>
                    <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
                      <input id="source--source" placeholder="Search" aria-required="true" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="source-list" />
                    </div>
                  </div>
                </div>
                <script>
                  const container = document.querySelector("[data-automation-id='multiSelectContainer']");
                  function showSourceMenu() {
                    if (document.querySelector("#source-menu")) return;
                    document.body.insertAdjacentHTML(
                      "beforeend",
                      `<div id="source-menu" role="listbox" data-automation-id="activeListContainer">
                        <div id="source-email" role="option" data-automation-id="promptOption" data-hunt-prompt-category="true">Email <svg></svg></div>
                        <div id="source-job-sites" role="option" data-automation-id="promptOption" data-hunt-prompt-category="true">Job Sites <svg></svg></div>
                      </div>`
                    );
                    document.querySelector("#source-job-sites").addEventListener("click", () => {
                      const menu = document.querySelector("#source-menu");
                      setTimeout(() => {
                        menu.innerHTML =
                          `<div role="option" data-automation-id="promptOption" onclick="selectSource('Glassdoor')">Glassdoor</div>
                           <div role="option" data-automation-id="promptOption" onclick="selectSource('Google')">Google</div>
                           <div role="option" data-automation-id="promptOption" onclick="selectSource('Indeed')">Indeed</div>
                           <div role="option" data-automation-id="promptOption" onclick="selectSource('Other Job Site')">Other Job Site</div>
                           <div role="option" data-automation-id="promptOption" onclick="selectSource('Zip Recruiter')">Zip Recruiter</div>`;
                      }, 120);
                    });
                  }
                  window.selectSource = (leaf) => {
                    container.insertAdjacentHTML(
                      "beforeend",
                      `<div role="option" data-automation-id="selectedItem" aria-label="${leaf}, press delete to clear value.">${leaf}</div>`
                    );
                    document.querySelector("#source-menu")?.remove();
                  };
                  document.querySelector("#source--source").addEventListener("click", showSourceMenu);
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: {
                  applicationSourceCategory: "Job Board",
                  applicationSource: "LinkedIn",
                  applicationSourceDetail: "LinkedIn",
                },
                settings: { fillRequiredOnly: true, useFieldPipelineV2: true },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_source_safe_leaf",
              });
            }
            """
        )
        selected = page.evaluate(
            """
            () => document.querySelector("[data-automation-id='selectedItem']")?.textContent.trim() || ""
            """
        )
        browser.close()

    fields = {entry["fieldId"]: entry for entry in result["v2Audit"]["fields"]}
    source = fields["source--source"]

    assert result["ok"] is True
    assert selected == "Indeed"
    assert source["filled"] is True


def test_workday_v2_source_prompt_uses_react_click_for_category_and_leaf():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <div data-automation-id="applyFlowMyInfoPage">
                  <div data-automation-id="formField-source" data-fkit-id="source--source">
                    <label for="source--source">How Did You Hear About Us?*</label>
                    <div id="source-container" data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
                      <input id="source--source" placeholder="Search" aria-required="true" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="source-list" />
                    </div>
                  </div>
                </div>
                <script>
                  const container = document.querySelector("#source-container");
                  function attachReactClick(el, handler) {
                    el["__reactFiber$hunt"] = {
                      memoizedProps: { onClick: handler },
                      return: null,
                    };
                  }
                  function showMenu() {
                    if (document.querySelector("#source-menu")) return;
                    document.body.insertAdjacentHTML(
                      "beforeend",
                      `<div id="source-menu" role="listbox" data-automation-id="activeListContainer">
                        <div id="external-row" role="option" data-automation-id="menuItem" data-hunt-prompt-category="true">
                          <span id="external-leaf" data-automation-id="promptLeafNode">External Career Site Sources</span>
                        </div>
                      </div>`
                    );
                    attachReactClick(document.querySelector("#external-leaf"), showChildren);
                  }
                  function showChildren() {
                    const menu = document.querySelector("#source-menu");
                    menu.innerHTML =
                      `<div id="job-row" role="option" data-automation-id="menuItem">
                        <span id="job-leaf" data-automation-id="promptLeafNode">Job Board</span>
                      </div>`;
                    attachReactClick(document.querySelector("#job-leaf"), () => {
                      container.insertAdjacentHTML(
                        "beforeend",
                        `<div role="option" data-automation-id="selectedItem" aria-label="Job Board, press delete to clear value.">Job Board</div>`
                      );
                      document.querySelector("#source-menu")?.remove();
                    });
                  }
                  document.querySelector("#source--source").addEventListener("click", showMenu);
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: {
                  applicationSourceCategory: "Job Board",
                  applicationSource: "Job Board",
                },
                settings: { fillRequiredOnly: true, useFieldPipelineV2: true },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_source_react_category",
              });
            }
            """
        )
        selected = page.evaluate(
            """
            () => document.querySelector("[data-automation-id='selectedItem']")?.textContent.trim() || ""
            """
        )
        browser.close()

    fields = {entry["fieldId"]: entry for entry in result["v2Audit"]["fields"]}
    source = fields["source--source"]

    assert result["ok"] is True
    assert selected == "Job Board"
    assert source["filled"] is True


def test_workday_v2_uses_specific_identity_for_grouped_my_info_fields():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <head>
                <style>
                  body { font-family: system-ui, sans-serif; margin: 24px; }
                  [data-automation-id^="formField-"] { margin: 12px 0; }
                  input, button { display: block; width: 320px; min-height: 32px; }
                  .menu { display: none; border: 1px solid #ccc; padding: 4px; width: 320px; }
                  .menu.open { display: block; }
                  [role="option"] { display: block; padding: 4px; }
                </style>
              </head>
              <body>
                <div data-automation-id="applyFlowMyInfoPage">
                  <div role="group">
                    Legal Name
                    <div data-automation-id="formField-legalName--firstName">
                      First Name*
                      <input id="name--legalName--firstName" name="legalName--firstName" aria-required="true" />
                    </div>
                    <div data-automation-id="formField-legalName--lastName">
                      Last Name*
                      <input id="name--legalName--lastName" name="legalName--lastName" aria-required="true" />
                    </div>
                    <div data-automation-id="formField-preferredCheck">
                      I have a preferred name
                      <input id="name--preferredCheck" type="checkbox" name="preferredCheck" aria-required="false" />
                    </div>
                  </div>
                  <div role="group">
                    Address
                    <div data-automation-id="formField-addressLine1">
                      Address Line 1
                      <input id="address--addressLine1" name="addressLine1" aria-required="false" />
                    </div>
                    <div data-automation-id="formField-city">
                      City*
                      <input id="address--city" name="city" aria-required="true" />
                    </div>
                    <div data-automation-id="formField-countryRegion">
                      Province or Territory*
                      <button id="address--countryRegion" name="countryRegion" type="button" aria-haspopup="listbox" aria-label="Province or Territory Select One Required">Select One</button>
                      <div id="province-menu" class="menu">
                        <div role="option">Alberta</div>
                        <div role="option">British Columbia</div>
                      </div>
                    </div>
                    <div data-automation-id="formField-postalCode">
                      Postal Code
                      <input id="address--postalCode" name="postalCode" aria-required="false" />
                    </div>
                  </div>
                  <div data-automation-id="formField-emailAddress">
                    Email*
                    <input id="emailAddress--emailAddress" name="emailAddress" aria-required="true" />
                  </div>
                  <div role="group">
                    Phone
                    <div data-automation-id="formField-phoneType">
                      Phone Device Type*
                      <button id="phoneNumber--phoneType" name="phoneType" type="button" aria-haspopup="listbox" aria-label="Phone Device Type Select One Required">Select One</button>
                      <div id="phone-type-menu" class="menu">
                        <div role="option">Fax</div>
                        <div role="option">Mobile</div>
                        <div role="option">Telephone</div>
                      </div>
                    </div>
                    <div data-automation-id="formField-countryPhoneCode">
                      Country Phone Code*
                      <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
                        <div data-automation-id="selectedItemList" role="listbox">
                          <div data-automation-id="selectedItem" role="option" aria-label=""></div>
                        </div>
                        <input id="phoneNumber--countryPhoneCode" data-automation-id="searchBox" data-uxi-widget-type="selectinput" aria-required="true" placeholder="Search" />
                      </div>
                      <div id="country-code-menu" class="menu">
                        <div role="option">Canada (+1)</div>
                        <div role="option">United States of America (+1)</div>
                      </div>
                    </div>
                    <div data-automation-id="formField-phoneNumber">
                      Phone Number*
                      <input id="phoneNumber--phoneNumber" name="phoneNumber" aria-required="true" />
                    </div>
                    <div data-automation-id="formField-extension">
                      Phone Extension
                      <input id="phoneNumber--extension" name="extension" aria-required="false" />
                    </div>
                  </div>
                </div>
                <script>
                  function wire(buttonSelector, menuSelector) {
                    const control = document.querySelector(buttonSelector);
                    const menu = document.querySelector(menuSelector);
                    control.addEventListener("click", () => menu.classList.add("open"));
                    menu.querySelectorAll("[role=option]").forEach((option) => {
                      option.addEventListener("click", () => {
                        control.textContent = option.textContent;
                        control.value = option.textContent;
                        menu.classList.remove("open");
                      });
                    });
                  }
                  wire("#address--countryRegion", "#province-menu");
                  wire("#phoneNumber--phoneType", "#phone-type-menu");
                  const countryInput = document.querySelector("#phoneNumber--countryPhoneCode");
                  const countryMenu = document.querySelector("#country-code-menu");
                  countryInput.addEventListener("click", () => countryMenu.classList.add("open"));
                  countryInput.addEventListener("input", () => countryMenu.classList.add("open"));
                  countryMenu.querySelectorAll("[role=option]").forEach((option) => {
                    option.addEventListener("click", () => {
                      document.querySelector("[data-automation-id=selectedItem]").textContent = option.textContent;
                      countryMenu.classList.remove("open");
                    });
                  });
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: {
                  fullName: "Michael Shi",
                  lastName: "Michael Shi",
                  email: "wenjian2@ualberta.ca",
                  phone: "7804923111",
                  phoneDeviceType: "Mobile",
                  phoneCountryCode: "Canada (+1)",
                  location: "Edmonton, Alberta, Canada",
                },
                settings: {
                  fillRequiredOnly: true,
                  useFieldPipelineV2: true,
                  llmAnswerFallbackEnabled: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_v2_my_info",
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              firstName: document.querySelector("#name--legalName--firstName").value,
              lastName: document.querySelector("#name--legalName--lastName").value,
              preferredChecked: document.querySelector("#name--preferredCheck").checked,
              addressLine1: document.querySelector("#address--addressLine1").value,
              city: document.querySelector("#address--city").value,
              province: document.querySelector("#address--countryRegion").textContent,
              postalCode: document.querySelector("#address--postalCode").value,
              email: document.querySelector("#emailAddress--emailAddress").value,
              phoneType: document.querySelector("#phoneNumber--phoneType").textContent,
              phoneCode: document.querySelector("[data-automation-id=selectedItem]").textContent,
              phoneNumber: document.querySelector("#phoneNumber--phoneNumber").value,
              extension: document.querySelector("#phoneNumber--extension").value,
            })
            """
        )
        browser.close()

    fields = {entry["fieldId"]: entry for entry in result["v2Audit"]["fields"]}
    skipped = {
        event["fieldId"]
        for event in result["v2Audit"]["events"]
        if event["action"] == "field_skipped" and event["reason"] == "not_required"
    }

    assert result["ok"] is True
    assert values == {
        "firstName": "Michael",
        "lastName": "Shi",
        "preferredChecked": False,
        "addressLine1": "",
        "city": "Edmonton",
        "province": "Alberta",
        "postalCode": "",
        "email": "wenjian2@ualberta.ca",
        "phoneType": "Mobile",
        "phoneCode": "Canada (+1)",
        "phoneNumber": "7804923111",
        "extension": "",
    }
    assert fields["name--legalName--lastName"]["questionType"] == "last_name"
    assert fields["phoneNumber--phoneType"]["questionType"] == "phone_device_type"
    assert fields["phoneNumber--countryPhoneCode"]["questionType"] == "phone_country_code"
    assert "name--preferredCheck" in skipped
    assert "address--addressLine1" in skipped
    assert "address--postalCode" in skipped
    assert "phoneNumber--extension" in skipped


def test_workday_v2_text_fill_uses_per_character_framework_events():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <div data-automation-id="applyFlowMyInfoPage">
                  <div data-automation-id="formField-firstName">
                    First Name*
                    <input id="name--legalName--firstName" name="legalName--firstName" aria-required="true" />
                  </div>
                  <script>
                    window.__frameworkModel = { firstName: "" };
                    const firstName = document.querySelector("#name--legalName--firstName");
                    firstName.addEventListener("input", (event) => {
                      if (event.data && event.data.length === 1) {
                        window.__frameworkModel.firstName += event.data;
                      }
                    });
                  </script>
                </div>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: { fullName: "Michael Shi", firstName: "Michael" },
                settings: { fillRequiredOnly: true, useFieldPipelineV2: true },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_text_framework_events",
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              dom: document.querySelector("#name--legalName--firstName").value,
              model: window.__frameworkModel.firstName,
            })
            """
        )
        browser.close()

    assert result["ok"] is True
    assert values == {"dom": "Michael", "model": "Michael"}


def test_workday_v2_does_not_fill_optional_preferred_name_checkbox_by_fallback():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <div data-automation-id="applyFlowMyInfoPage">
                  <div data-automation-id="formField-preferredCheck">
                    I have a preferred name
                    <input id="name--preferredCheck" type="checkbox" name="preferredCheck" aria-required="false" />
                  </div>
                </div>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: { fullName: "Michael Shi", firstName: "Michael", lastName: "Shi" },
                settings: {
                  fillRequiredOnly: false,
                  useFieldPipelineV2: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_optional_preferred_checkbox",
              });
            }
            """
        )
        checked = page.evaluate(
            '() => document.querySelector("#name--preferredCheck").checked'
        )
        browser.close()

    inventory = {entry["id"]: entry for entry in result["fieldInventory"]}
    assert checked is False
    assert inventory["name--preferredCheck"]["filled"] is False
    assert inventory["name--preferredCheck"]["skippedReason"] in {
        "checkbox_no_safe_match",
        "no_options",
    }


def test_workday_v2_repeatables_match_profile_and_clear_deletes_rows_and_resume():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <head>
                <style>
                  body { font-family: system-ui, sans-serif; margin: 24px; }
                  section { border-top: 1px solid #ddd; padding: 16px 0; }
                  .row { margin: 12px 0; padding: 8px 0; }
                  label { display: block; margin: 6px 0; }
                  input { display: block; width: 320px; min-height: 30px; }
                  button { margin: 4px 0; min-height: 30px; }
                </style>
              </head>
              <body>
                <h2>My Experience</h2>
                <section id="work">
                  <h3>Work Experience</h3>
                  <button id="work-add" type="button" data-automation-id="add-button" onclick="addWorkRow()">Add Another</button>
                  <div class="row" data-kind="work">
                    <h4>Work Experience 1</h4>
                    <label>Job Title<input id="workExperience-1--jobTitle" value="Old Title"></label>
                    <label>Company<input id="workExperience-1--companyName" value="Old Company"></label>
                    <label>From Month<input id="workExperience-1--startDate-dateSectionMonth-input" data-automation-id="dateSectionMonth-input"></label>
                    <label>From Year<input id="workExperience-1--startDate-dateSectionYear-input" data-automation-id="dateSectionYear-input"></label>
                    <label>To Month<input id="workExperience-1--endDate-dateSectionMonth-input" data-automation-id="dateSectionMonth-input"></label>
                    <label>To Year<input id="workExperience-1--endDate-dateSectionYear-input" data-automation-id="dateSectionYear-input"></label>
                    <button type="button" aria-label="Delete Work Experience 1" onclick="this.closest('.row').remove()">Delete</button>
                  </div>
                  <div class="row" data-kind="work">
                    <h4>Work Experience 2</h4>
                    <label>Job Title<input id="workExperience-2--jobTitle"></label>
                    <label>Company<input id="workExperience-2--companyName"></label>
                    <label>From Month<input id="workExperience-2--startDate-dateSectionMonth-input" data-automation-id="dateSectionMonth-input"></label>
                    <label>From Year<input id="workExperience-2--startDate-dateSectionYear-input" data-automation-id="dateSectionYear-input"></label>
                    <label>To Month<input id="workExperience-2--endDate-dateSectionMonth-input" data-automation-id="dateSectionMonth-input"></label>
                    <label>To Year<input id="workExperience-2--endDate-dateSectionYear-input" data-automation-id="dateSectionYear-input"></label>
                    <button type="button" aria-label="Delete Work Experience 2" onclick="this.closest('.row').remove()">Delete</button>
                  </div>
                  <div class="row" data-kind="work">
                    <h4>Work Experience 3</h4>
                    <label>Job Title<input id="workExperience-3--jobTitle" value="Surplus"></label>
                    <label>Company<input id="workExperience-3--companyName" value="Extra"></label>
                    <button type="button" aria-label="Delete Work Experience 3" onclick="this.closest('.row').remove()">Delete</button>
                  </div>
                </section>
                <section id="education">
                  <h3>Education</h3>
                  <button id="education-add" type="button" data-automation-id="add-button" onclick="addEducationRow()">Add</button>
                </section>
                <section id="resume">
                  <h3>Resume/CV</h3>
                  <div id="resume-row">
                    main.pdf Successfully Uploaded!
                    <button type="button" aria-label="Delete Resume" onclick="document.querySelector('#resume-row').remove()">Delete</button>
                  </div>
                </section>
                <section id="websites">
                  <h3>Websites</h3>
                  <button id="website-add" type="button" data-automation-id="add-button" onclick="addWebsiteRow()">Add Another</button>
                  <div class="row" data-kind="website">
                    <h4>Websites 1</h4>
                    <label>URL<input id="webAddress-1--url"></label>
                    <button type="button" aria-label="Delete Website 1" onclick="this.closest('.row').remove()">Delete</button>
                  </div>
                </section>
                <section id="social-websites">
                  <h3>Social Network URLs</h3>
                  <button id="social-website-add" type="button" data-automation-id="add-button" onclick="addSocialWebsiteRow()">Add Another</button>
                </section>
                <script>
                  function countRows(section, kind) {
                    return document.querySelectorAll(section + " .row[data-kind='" + kind + "']").length + 1;
                  }
                  function addWorkRow() {
                    const count = countRows("#work", "work");
                    document.querySelector("#work").insertAdjacentHTML(
                      "beforeend",
                      `<div class="row" data-kind="work">
                        <h4>Work Experience ${count}</h4>
                        <label>Job Title<input id="workExperience-${count}--jobTitle"></label>
                        <label>Company<input id="workExperience-${count}--companyName"></label>
                        <label>From Month<input id="workExperience-${count}--startDate-dateSectionMonth-input" data-automation-id="dateSectionMonth-input"></label>
                        <label>From Year<input id="workExperience-${count}--startDate-dateSectionYear-input" data-automation-id="dateSectionYear-input"></label>
                        <label>To Month<input id="workExperience-${count}--endDate-dateSectionMonth-input" data-automation-id="dateSectionMonth-input"></label>
                        <label>To Year<input id="workExperience-${count}--endDate-dateSectionYear-input" data-automation-id="dateSectionYear-input"></label>
                        <button type="button" aria-label="Delete Work Experience ${count}" onclick="this.closest('.row').remove()">Delete</button>
                      </div>`
                    );
                  }
                  function addEducationRow() {
                    const count = countRows("#education", "education");
                    document.querySelector("#education").insertAdjacentHTML(
                      "beforeend",
                      `<div class="row" data-kind="education">
                        <h4>Education ${count}</h4>
                        <label>School or University<input id="education-${count}--schoolName"></label>
                        <label>Degree<input id="education-${count}--degree"></label>
                        <button type="button" aria-label="Delete Education ${count}" onclick="this.closest('.row').remove()">Delete</button>
                      </div>`
                    );
                  }
                  function addWebsiteRow() {
                    const count = countRows("#websites", "website");
                    document.querySelector("#websites").insertAdjacentHTML(
                      "beforeend",
                      `<div class="row" data-kind="website">
                        <h4>Websites ${count}</h4>
                        <label>URL<input id="webAddress-${count}--url"></label>
                        <button type="button" aria-label="Delete Website ${count}" onclick="this.closest('.row').remove()">Delete</button>
                      </div>`
                    );
                  }
                  function addSocialWebsiteRow() {
                    const count = countRows("#social-websites", "website");
                    document.querySelector("#social-websites").insertAdjacentHTML(
                      "beforeend",
                      `<div class="row" data-kind="website">
                        <h4>Social Network URLs ${count}</h4>
                        <label>Social Network<input id="socialNetwork-${count}--type"></label>
                        <label>URL<input id="socialNetwork-${count}--url"></label>
                        <button type="button" aria-label="Delete Social Network URL ${count}" onclick="this.closest('.row').remove()">Delete</button>
                      </div>`
                    );
                  }
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              const fillResult = await fill({
                profile: {
                  pastJobs: [
                    {
                      job_title: "Software Developer Intern",
                      company_name: "INVIDI Technologies",
                      start_month: "5",
                      start_year: "2025",
                      end_month: "8",
                      end_year: "2025",
                    },
                    {
                      title: "Research Assistant",
                      employer: "University of Alberta",
                      startMonth: "09",
                      startYear: "2024",
                      endMonth: "02",
                      endYear: "2026",
                    },
                  ],
                  educationHistory: [
                    { university: "University of Alberta", degree: "BSc Computer Science" },
                  ],
                  websites: [
                    { url: "https://mshi.ca" },
                    "https://linkedin.com/in/wjshi",
                    "https://github.com/micsushi",
                  ],
                },
                settings: {
                  fillRequiredOnly: true,
                  useFieldPipelineV2: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_v2_repeatables",
              });
              const collect = () => ({
                work: Array.from(document.querySelectorAll("#work .row")).map((row) => ({
                  title: row.querySelector("[id$='--jobTitle']")?.value || "",
                  company: row.querySelector("[id$='--companyName']")?.value || "",
                  startMonth: row.querySelector("[id*='--startDate-dateSectionMonth-input']")?.value || "",
                  startYear: row.querySelector("[id*='--startDate-dateSectionYear-input']")?.value || "",
                  endMonth: row.querySelector("[id*='--endDate-dateSectionMonth-input']")?.value || "",
                  endYear: row.querySelector("[id*='--endDate-dateSectionYear-input']")?.value || "",
                })),
                education: Array.from(document.querySelectorAll("#education .row")).map((row) => ({
                  school: row.querySelector("[id$='--schoolName']")?.value || "",
                  degree: row.querySelector("[id$='--degree']")?.value || "",
                })),
                websites: Array.from(document.querySelectorAll("#websites .row")).map((row) => (
                  row.querySelector("input")?.value || ""
                )),
                socialWebsites: Array.from(document.querySelectorAll("#social-websites .row")).map((row) => ({
                  type: row.querySelector("[id$='--type']")?.value || "",
                  url: row.querySelector("[id$='--url']")?.value || "",
                })),
                resumeUploaded: Boolean(document.querySelector("#resume-row")),
              });
              const valuesAfterFill = collect();
              const clearResult = await window.__huntV2.clearPipeline.runHuntV2Clear({
                atsType: "workday",
                fillRunId: "workday_v2_repeatables_clear",
              });
              const valuesAfterClear = collect();
              return { fillResult, clearResult, valuesAfterFill, valuesAfterClear };
            }
            """
        )
        browser.close()

    fill_events = [
        event
        for event in result["fillResult"]["v2Audit"]["events"]
        if event["action"] == "workday_repeatables_fill"
    ]
    clear_events = [
        event
        for event in result["clearResult"]["v2Audit"]["events"]
        if event["action"] == "workday_repeatables_clear"
    ]

    assert result["fillResult"]["ok"] is True
    assert result["valuesAfterFill"] == {
        "work": [
            {
                "title": "Software Developer Intern",
                "company": "INVIDI Technologies",
                "startMonth": "05",
                "startYear": "2025",
                "endMonth": "08",
                "endYear": "2025",
            },
            {
                "title": "Research Assistant",
                "company": "University of Alberta",
                "startMonth": "09",
                "startYear": "2024",
                "endMonth": "02",
                "endYear": "2026",
            },
        ],
        "education": [
            {
                "school": "University of Alberta",
                "degree": "BSc Computer Science",
            }
        ],
        "websites": ["https://mshi.ca"],
        "socialWebsites": [
            {"type": "LinkedIn", "url": "https://www.linkedin.com/in/wjshi/"},
            {"type": "GitHub", "url": "https://github.com/micsushi"},
        ],
        "resumeUploaded": True,
    }
    assert fill_events
    assert fill_events[-1]["detail"]["deletedRowCount"] == 1
    assert result["clearResult"]["ok"] is True
    assert result["valuesAfterClear"] == {
        "work": [],
        "education": [],
        "websites": [],
        "socialWebsites": [],
        "resumeUploaded": False,
    }
    assert result["clearResult"]["clearedFieldCount"] >= 6
    assert clear_events
    assert clear_events[-1]["detail"]["deletedResume"] == 1


def test_workday_v2_social_account_inputs_receive_urls_not_labels():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <h2>My Experience</h2>
                <section id="social-websites">
                  <h3>Social Network URLs</h3>
                  <div class="row" data-kind="website">
                    <label>Linkedin<input id="socialNetworkAccounts--linkedInAccount" name="linkedInAccount"></label>
                  </div>
                  <div class="row" data-kind="website">
                    <label>X<input id="socialNetworkAccounts--twitterAccount" name="twitterAccount"></label>
                  </div>
                </section>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              const fillResult = await fill({
                profile: {
                  websites: [
                    "https://linkedin.com/in/wjshi",
                    "https://github.com/micsushi",
                  ],
                },
                settings: {
                  fillRequiredOnly: true,
                  useFieldPipelineV2: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_v2_social_accounts",
              });
              return {
                fillResult,
                linkedIn: document.querySelector("#socialNetworkAccounts--linkedInAccount")?.value || "",
                twitter: document.querySelector("#socialNetworkAccounts--twitterAccount")?.value || "",
              };
            }
            """
        )
        browser.close()

    assert result["fillResult"]["ok"] is True
    assert result["linkedIn"] == "https://www.linkedin.com/in/wjshi/"
    assert result["twitter"] == ""


def test_workday_v2_repeatables_repairs_missing_degree_choice_on_dirty_row():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <h2>My Experience</h2>
                <section id="education">
                  <h3>Education</h3>
                  <div class="row" data-kind="education">
                    <h4>Education 1</h4>
                    <label>School or University*<input id="education-38--schoolName" value="University of Alberta"></label>
                    <label>Degree*
                      <button id="education-38--degree" type="button" aria-haspopup="listbox" aria-label="Degree Select One Required">Select One</button>
                    </label>
                    <label>Overall Result (GPA)<input id="education-38--gradeAverage" value="3.7"></label>
                  </div>
                  <button id="education-add" type="button" data-automation-id="add-button">Add Another</button>
                </section>
                <script>
                  document.querySelector("#education-38--degree").addEventListener("click", () => {
                    if (document.querySelector("#degree-options")) return;
                    document.body.insertAdjacentHTML(
                      "beforeend",
                      `<div id="degree-options" role="listbox">
                        <div role="option" onclick="document.querySelector('#education-38--degree').textContent='BS'; this.closest('#degree-options').remove()">BS</div>
                        <div role="option" onclick="document.querySelector('#education-38--degree').textContent='Masters'; this.closest('#degree-options').remove()">Masters</div>
                      </div>`
                    );
                  });
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: {
                  educationHistory: [
                    {
                      university: "University of Alberta",
                      degree: "Bachelor's Degree",
                      degreeLevel: "Bachelors",
                      fieldOfStudy: "Computer Science",
                      gpa: "3.7",
                    },
                  ],
                },
                settings: {
                  fillRequiredOnly: true,
                  useFieldPipelineV2: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_degree_repair",
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              school: document.querySelector("#education-38--schoolName").value,
              degree: document.querySelector("#education-38--degree").textContent.trim(),
              gpa: document.querySelector("#education-38--gradeAverage").value,
            })
            """
        )
        browser.close()

    sections = {
        entry["name"]: entry
        for entry in result["fieldInventory"]
        if entry["kind"] == "workdaySection"
    }

    assert result["ok"] is True
    assert values == {
        "school": "University of Alberta",
        "degree": "BS",
        "gpa": "3.7",
    }
    assert sections["Education"]["filled"] is True
    assert sections["Education"]["skippedReason"] == ""


def test_workday_v2_repeatables_uses_keyboard_fallback_for_degree_choice():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <h2>My Experience</h2>
                <section id="education">
                  <h3>Education</h3>
                  <div class="row" data-kind="education">
                    <h4>Education 1</h4>
                    <label>School or University*<input id="education-98--schoolName" value="University of Alberta"></label>
                    <label>Degree*
                      <button id="education-98--degree" name="degree" type="button" aria-haspopup="listbox" aria-label="Degree Select One Required">Select One</button>
                    </label>
                  </div>
                </section>
                <script>
                  const button = document.querySelector("#education-98--degree");
                  button.addEventListener("click", () => {
                    if (document.querySelector("#degree-options")) return;
                    document.body.insertAdjacentHTML(
                      "beforeend",
                      `<ul id="degree-options" role="listbox" tabindex="0">
                        <li role="option">Select One</li>
                        <li role="option">Other</li>
                        <li role="option">Not applicable</li>
                        <li role="option">Some Secondary / HighSchool</li>
                        <li role="option">Secondary / High School / General Equivalency Diploma</li>
                        <li role="option">Some College</li>
                        <li role="option">Trade, Technical School or Apprenticeship</li>
                        <li role="option">Associate Degree</li>
                        <li role="option">Executive / Management Development Program</li>
                        <li role="option" data-value="bachelor">Bachelor / Undergraduate Degree</li>
                        <li role="option">Master / Graduate Degree</li>
                      </ul>`
                    );
                    const listbox = document.querySelector("#degree-options");
                    let active = 0;
                    listbox.addEventListener("keydown", (event) => {
                      if (event.key === "Home") active = 0;
                      if (event.key === "ArrowDown") active = Math.min(active + 1, listbox.children.length - 1);
                      if (event.key === "Enter") {
                        const option = listbox.children[active];
                        button.textContent = option.textContent;
                        button.value = option.getAttribute("data-value") || option.textContent;
                        listbox.remove();
                      }
                    });
                  });
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: {
                  educationHistory: [
                    {
                      university: "University of Alberta",
                      degree: "Bachelor's Degree",
                      degreeLevel: "Bachelors",
                      fieldOfStudy: "Computer Science",
                    },
                  ],
                },
                settings: {
                  fillRequiredOnly: true,
                  useFieldPipelineV2: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_degree_keyboard_fallback",
              });
            }
            """
        )
        degree = page.evaluate(
            """() => document.querySelector("#education-98--degree").textContent.trim()"""
        )
        browser.close()

    assert result["ok"] is True
    assert degree == "Bachelor / Undergraduate Degree"


def test_workday_v2_repeatable_skills_use_trusted_click_when_dom_click_does_not_commit():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <main data-automation-id="applyFlowMyExperiencePage">
                  <h4>Skills</h4>
                  <div data-automation-id="formField-skills">
                    <label for="skills--skills">Type to Add Skills</label>
                    <input id="skills--skills" data-automation-id="searchBox" />
                    <div id="selected-skills" data-automation-id="selectedItemList">0 items selected</div>
                  </div>
                </main>
                <script>
                  const input = document.querySelector("#skills--skills");
                  const selected = document.querySelector("#selected-skills");
                  window.trustedInputRequests = [];
                  function renderOptions() {
                    document.querySelector("#skills-menu")?.remove();
                    document.body.insertAdjacentHTML(
                      "beforeend",
                      `<div id="skills-menu" role="listbox" data-automation-id="activeListContainer">
                        <div id="communication-option" role="option" data-automation-id="menuItem">
                          <input id="communication-checkbox" type="checkbox" data-automation-id="checkboxPanel" />
                          Communication
                        </div>
                      </div>`
                    );
                  }
                  function commitTrusted(label) {
                    selected.innerHTML =
                      `<div data-automation-id="selectedItem">${label}</div>`;
                    input.value = "";
                    document.querySelector("#skills-menu")?.remove();
                  }
                  window.chrome = {
                    runtime: {
                      lastError: null,
                      sendMessage(message, callback) {
                        window.trustedInputRequests.push(message);
                        if (message?.type === "hunt.apply.trusted_input") {
                          commitTrusted(message.payload.label);
                          callback({ ok: true, reason: "test_trusted_click" });
                          return;
                        }
                        callback({ ok: false, reason: "unexpected_message" });
                      },
                    },
                  };
                  input.addEventListener("click", renderOptions);
                  input.addEventListener("input", renderOptions);
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)

        result = page.evaluate(
            """
            async () => {
              return await window.__huntV2.workdayRepeatables.fillWorkdayRepeatables({
                profile: { skills: ["Communication"] },
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              selected: document.querySelector("[data-automation-id='selectedItem']")?.textContent.trim() || "",
              trustedInputCount: window.trustedInputRequests.length,
              trustedInputType: window.trustedInputRequests[0]?.type || "",
              trustedPurpose: window.trustedInputRequests[0]?.payload?.purpose || "",
              trustedLabel: window.trustedInputRequests[0]?.payload?.label || "",
            })
            """
        )
        browser.close()

    assert result["filledFieldCount"] == 1
    assert values == {
        "selected": "Communication",
        "trustedInputCount": 1,
        "trustedInputType": "hunt.apply.trusted_input",
        "trustedPurpose": "repeatable_skill_option",
        "trustedLabel": "Communication",
    }


def test_workday_v2_repeatable_skills_reject_fuzzy_suggestions_before_commit():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <main data-automation-id="applyFlowMyExperiencePage">
                  <h4>Skills</h4>
                  <div data-automation-id="formField-skills">
                    <label for="skills--skills">Type to Add Skills</label>
                    <input id="skills--skills" data-automation-id="searchBox" />
                    <div id="selected-skills" data-automation-id="selectedItemList">0 items selected</div>
                  </div>
                </main>
                <script>
                  const input = document.querySelector("#skills--skills");
                  const selected = document.querySelector("#selected-skills");
                  window.enterPressed = false;
                  window.clickedOptions = [];
                  function option(label) {
                    return `<div role="option" data-automation-id="menuItem" data-label="${label}">
                      <input type="checkbox" data-automation-id="checkboxPanel" />${label}
                    </div>`;
                  }
                  function renderOptions() {
                    document.querySelector("#skills-menu")?.remove();
                    document.body.insertAdjacentHTML(
                      "beforeend",
                      `<div id="skills-menu" role="listbox" data-automation-id="activeListContainer">
                        ${option("Stani's Python Editor")}
                        ${option("Python Automation")}
                        ${option("Python")}
                      </div>`
                    );
                    document.querySelectorAll("[role='option']").forEach((el) => {
                      el.addEventListener("click", () => {
                        const label = el.getAttribute("data-label");
                        window.clickedOptions.push(label);
                        selected.innerHTML = `<div data-automation-id="selectedItem">${label}</div>`;
                        input.value = "";
                        document.querySelector("#skills-menu")?.remove();
                      });
                    });
                  }
                  input.addEventListener("input", renderOptions);
                  input.addEventListener("click", renderOptions);
                  input.addEventListener("keydown", (event) => {
                    if (event.key === "Enter") {
                      window.enterPressed = true;
                      selected.innerHTML = `<div data-automation-id="selectedItem">Stani's Python Editor</div>`;
                    }
                  });
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)

        result = page.evaluate(
            """
            async () => {
              return await window.__huntV2.workdayRepeatables.fillWorkdayRepeatables({
                profile: { skills: ["Python"] },
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              selected: document.querySelector("[data-automation-id='selectedItem']")?.textContent.trim() || "",
              enterPressed: window.enterPressed,
              clickedOptions: window.clickedOptions,
            })
            """
        )
        browser.close()

    assert result["filledFieldCount"] == 1
    assert values == {
        "selected": "Python",
        "enterPressed": False,
        "clickedOptions": ["Python"],
    }


def test_workday_bdo_questionnaire_defaults_and_location_answer():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content("<html><body></body></html>")
        page.add_script_tag(content=injected_js)
        result = page.evaluate(
            """
            () => {
              const u = window.__huntApplyUtils;
              const profile = {
                location: "Edmonton, AB, Canada",
                salaryExpectation: "95000",
                salaryExpectationRange: "90,000 - 105,000",
                preferredLanguage: "English",
              };
              const salary = u.chooseStructuredChoice(
                "What is your target salary range?*",
                profile,
                true
              );
              return {
                salary,
                salaryScores: {
                  lower: u.optionScoreForChoice("$85000 - $95000", "", salary, true),
                  target: u.optionScoreForChoice("$95000 - $105000", "", salary, true),
                },
                background: u.chooseStructuredChoice(
                  "Would you be willing to complete a background security check, including criminal record and references?*",
                  profile,
                  true
                ),
                aiConsent: u.chooseStructuredChoice(
                  "BDO Canada may use artificial intelligence enabled tools to support certain aspects of the recruitment process. Do you consent to the use of AI-enabled tools as described above?*",
                  profile,
                  true
                ),
                preferredLanguage: u.chooseStructuredChoice(
                  "What is your preferred language?*",
                  profile,
                  true
                ),
                locationAnswer: u.generateAnswer(
                  "Please indicate your top BDO location(s) (minimum 1, maximum 3) in order of preference.",
                  profile,
                  {
                    title: "Business Analyst, Data & Analytics - New Grad",
                    company: "BDO",
                    jobUrl: "https://bdo.wd3.myworkdayjobs.com/en-US/BDO/job/Toronto---Bay-St/Business-Analyst--Data---Analytics---New-Grad--May-2026-_JR5658-1/apply/applyManually?source=LinkedIn",
                  },
                  true
                ),
              };
            }
            """
        )
        browser.close()

    assert result["salaryScores"]["target"] > result["salaryScores"]["lower"]
    assert result["background"]["text"] == "Yes"
    assert result["aiConsent"]["text"] == "Yes"
    assert result["preferredLanguage"]["text"] == "English"
    assert result["locationAnswer"]["answerText"] == "Toronto - Bay St"
    assert "Junior AI" not in result["locationAnswer"]["answerText"]


def test_workday_required_only_skips_optional_generated_textareas():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <head>
                <style>
                  body { font-family: system-ui, sans-serif; margin: 24px; }
                  [data-automation-id="formField"] { margin: 16px 0; }
                  textarea { display: block; width: 460px; min-height: 48px; }
                </style>
              </head>
              <body>
                <div data-automation-id="formField">
                  <div>Please indicate your desired salary range.<span>*</span></div>
                  <textarea id="salary-range" aria-required="true"></textarea>
                </div>
                <div data-automation-id="formField">
                  <div>If Yes, Which Company ?</div>
                  <textarea id="prior-company"></textarea>
                </div>
                <div data-automation-id="formField">
                  <div>If you were referred, how do you know the employee who referred you?</div>
                  <textarea id="referred-how"></textarea>
                </div>
                <div data-automation-id="formField">
                  <div>If Yes, please explain.<span>*</span></div>
                  <textarea id="conditional-required" aria-required="true"></textarea>
                </div>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: {
                  fullName: "Michael Shi",
                  email: "wenjian2@ualberta.ca",
                  phone: "555-555-0100",
                  location: "Edmonton, AB, Canada",
                  linkedinUrl: "https://linkedin.com/in/wjshi",
                  githubUrl: "https://github.com/micsushi",
                  websiteUrl: "https://mshi.ca",
                  workAuthorized: true,
                  sponsorshipRequired: false,
                  willingToRelocate: true,
                  openToAnyLocation: true,
                  salaryFlexible: true,
                  previousEmployers: "",
                  notes: "",
                },
                settings: {
                  stripLongDash: true,
                  fillRequiredOnly: true,
                  allowGeneratedAnswers: true,
                  flagLowConfidenceAnswers: true,
                },
                activeApplyContext: {
                  title: "Junior AI Software Engineer",
                  company: "Jonas Software Canada",
                  description: "Build practical AI software for customers.",
                  selectedResumeSummary: "Software engineering and AI projects.",
                },
                defaultResume: {},
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              salary: document.querySelector("#salary-range").value,
              priorCompany: document.querySelector("#prior-company").value,
              referredHow: document.querySelector("#referred-how").value,
              conditionalRequired: document.querySelector("#conditional-required").value,
            })
            """
        )
        browser.close()

    inventory = {entry["id"]: entry for entry in result["fieldInventory"]}

    assert result["ok"] is True
    assert result["filledFieldCount"] == 2, json.dumps(result["fieldInventory"], indent=2)
    assert values["salary"] == (
        "I am flexible and open to discussing compensation based on the role and overall package."
    )
    assert values["priorCompany"] == ""
    assert values["referredHow"] == ""
    assert values["conditionalRequired"] == "Not applicable."
    assert inventory["salary-range"]["required"] is True
    assert inventory["salary-range"]["filled"] is True
    assert inventory["prior-company"]["required"] is False
    assert inventory["prior-company"]["skippedReason"] == "not_required"
    assert inventory["referred-how"]["required"] is False
    assert inventory["referred-how"]["skippedReason"] == "not_required"
    assert inventory["conditional-required"]["required"] is True
    assert inventory["conditional-required"]["filled"] is True
    assert inventory["conditional-required"]["valueSource"] == "best_effort:default_text"
    assert result["manualReviewRequired"] is False
    assert result["bestEffortWarnings"]


def test_workday_required_only_still_adds_my_experience_sections_from_aliases():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <head>
                <style>
                  body { font-family: system-ui, sans-serif; margin: 24px; }
                  section { border-top: 1px solid #ddd; padding: 16px 0; }
                  input { display: block; margin: 8px 0; width: 320px; }
                </style>
              </head>
              <body>
                <h3>My Experience</h3>
                <section id="work">
                  <h4>Work Experience</h4>
                  <button type="button" data-automation-id="add-button" onclick="addWork()">Add</button>
                </section>
                <section id="education">
                  <h4>Education</h4>
                  <button type="button" data-automation-id="add-button" onclick="addEducation()">Add</button>
                </section>
                <section id="skills">
                  <h4>Skills</h4>
                  <label>Type to Add Skills<input id="skill-input"></label>
                  <div id="skill-values"></div>
                </section>
                <section id="websites">
                  <h4>Websites</h4>
                  <button type="button" data-automation-id="add-button" onclick="addWebsite()">Add</button>
                </section>
                <script>
                  function addWork() {
                    const count = document.querySelectorAll("#work input[id$='--jobTitle']").length + 1;
                    document.querySelector("#work").insertAdjacentHTML(
                      "beforeend",
                      '<label>Job Title<input id="workExperience-' + count + '--jobTitle"></label>' +
                      '<label>Company<input id="workExperience-' + count + '--companyName"></label>'
                    );
                    document.querySelector("#work button").textContent = "Add Another";
                  }
                  function addEducation() {
                    const count = document.querySelectorAll("#education input[id$='--schoolName']").length + 1;
                    document.querySelector("#education").insertAdjacentHTML(
                      "beforeend",
                      '<label>School or University<input id="education-' + count + '--schoolName"></label>' +
                      '<label>Degree<input id="education-' + count + '--degree"></label>'
                    );
                  }
                  function addWebsite() {
                    const count = document.querySelectorAll("#websites input").length + 1;
                    document.querySelector("#websites").insertAdjacentHTML(
                      "beforeend",
                      '<label>URL<input id="website-' + count + '"></label>'
                    );
                  }
                  document.querySelector("#skill-input").addEventListener("keyup", (event) => {
                    if (event.key === "Enter" && event.target.value) {
                      document.querySelector("#skill-values").insertAdjacentHTML(
                        "beforeend",
                        "<span>" + event.target.value + "</span>"
                      );
                      event.target.value = "";
                    }
                  });
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              const payload = {
                profile: {
                  fullName: "Michael Shi",
                  email: "wenjian2@ualberta.ca",
                  pastJobs: [
                    {
                      title: "Software Developer Intern",
                      employer: "INVIDI Technologies",
                    },
                    {
                      title: "Research Assistant",
                      employer: "University of Alberta",
                    },
                  ],
                  educationHistory: [
                    {
                      university: "University of Alberta",
                      credential: "Bachelor of Science",
                    },
                  ],
                  skillList: ["Python"],
                  websites: ["https://mshi.ca"],
                },
                settings: {
                  stripLongDash: true,
                  fillRequiredOnly: true,
                  allowGeneratedAnswers: true,
                  flagLowConfidenceAnswers: true,
                },
                activeApplyContext: {},
                defaultResume: {},
              };
              const first = await fill(payload);
              const second = await fill(payload);
              return { first, second };
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              workRowCount: document.querySelectorAll("#work input[id$='--jobTitle']").length,
              educationRowCount: document.querySelectorAll("#education input[id$='--schoolName']").length,
              jobTitle1: document.querySelector("#workExperience-1--jobTitle")?.value || "",
              company1: document.querySelector("#workExperience-1--companyName")?.value || "",
              jobTitle2: document.querySelector("#workExperience-2--jobTitle")?.value || "",
              company2: document.querySelector("#workExperience-2--companyName")?.value || "",
              addButtonText: document.querySelector("#work button")?.innerText || "",
              school: document.querySelector("#education-1--schoolName")?.value || "",
              degree: document.querySelector("#education-1--degree")?.value || "",
              skills: document.querySelector("#skill-values")?.innerText || "",
              website: document.querySelector("#website-1")?.value || "",
              websiteRowCount: document.querySelectorAll("#websites input").length,
            })
            """
        )
        browser.close()

    sections = {
        entry["name"]: entry
        for entry in result["first"]["fieldInventory"]
        if entry["kind"] == "workdaySection"
    }
    second_sections = {
        entry["name"]: entry
        for entry in result["second"]["fieldInventory"]
        if entry["kind"] == "workdaySection"
    }

    assert result["first"]["ok"] is True
    assert result["second"]["ok"] is True
    assert values == {
        "workRowCount": 2,
        "educationRowCount": 1,
        "jobTitle1": "Software Developer Intern",
        "company1": "INVIDI Technologies",
        "jobTitle2": "Research Assistant",
        "company2": "University of Alberta",
        "addButtonText": "Add Another",
        "school": "University of Alberta",
        "degree": "Bachelors",
        "skills": "Python",
        "website": "https://mshi.ca",
        "websiteRowCount": 1,
    }
    assert sections["Work Experience"]["filled"] is True
    assert sections["Education"]["filled"] is True
    assert sections["Skills"]["filled"] is True
    assert sections["Websites"]["filled"] is True
    assert second_sections["Work Experience"]["skippedReason"] == "already_filled"
    assert second_sections["Education"]["skippedReason"] == "already_filled"


def test_workday_repeatable_skills_uses_generic_remote_checkbox_fallback():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <head>
                <style>
                  body { font-family: system-ui, sans-serif; margin: 24px; }
                  section { border-top: 1px solid #ddd; padding: 16px 0; }
                  input { display: block; margin: 8px 0; width: 320px; }
                  [role="option"] { display: block; min-height: 28px; }
                </style>
              </head>
              <body>
                <h3>My Experience</h3>
                <section id="skills-section">
                  <h4>Skills</h4>
                  <div data-automation-id="formField-skills">
                    <label>Type to Add Skills
                      <input
                        id="skills--skills"
                        aria-required="true"
                        data-uxi-widget-type="selectinput"
                        data-uxi-multiselect-id="skill-list"
                      />
                    </label>
                    <div id="selected-skills" data-automation-id="selectedItemList"></div>
                  </div>
                </section>
                <script>
                  const input = document.querySelector("#skills--skills");
                  const selected = document.querySelector("#selected-skills");
                  function attachReactClick(el, handler) {
                    el["__reactFiber$hunt"] = {
                      memoizedProps: { onClick: handler },
                      return: null,
                    };
                  }
                  function selectSkill(label) {
                    selected.innerHTML =
                      `<div data-automation-id="selectedItem" aria-label="${label}, press delete to clear value.">${label}</div>`;
                    document.querySelector("#skill-menu")?.remove();
                    input.value = "";
                    input.removeAttribute("aria-invalid");
                  }
                  function renderOptions() {
                    const query = input.value || "";
                    document.querySelector("#skill-menu")?.remove();
                    if (!/communication/i.test(query)) return;
                    document.body.insertAdjacentHTML(
                      "beforeend",
                      `<div id="skill-menu" role="listbox" data-automation-id="activeListContainer">
                        <div id="communication-row" role="option" data-automation-id="menuItem" aria-label="Communication not checked">
                          <input id="communication-checkbox" type="checkbox" data-automation-id="checkboxPanel" />
                          <span>Communication</span>
                        </div>
                      </div>`
                    );
                    attachReactClick(
                      document.querySelector("#communication-checkbox"),
                      () => selectSkill("Communication")
                    );
                  }
                  input.addEventListener("input", () => setTimeout(renderOptions, 80));
                  input.addEventListener("click", renderOptions);
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: { skillList: ["Python"] },
                settings: {
                  fillRequiredOnly: true,
                  useFieldPipelineV2: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_remote_skill_fallback",
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              selected: document.querySelector("[data-automation-id='selectedItem']")?.textContent.trim() || "",
              inputValue: document.querySelector("#skills--skills")?.value || "",
              openMenu: Boolean(document.querySelector("#skill-menu")),
            })
            """
        )
        browser.close()

    sections = {
        entry["name"]: entry
        for entry in result["fieldInventory"]
        if entry["kind"] == "workdaySection"
    }

    assert result["ok"] is True
    assert values == {
        "selected": "Communication",
        "inputValue": "",
        "openMenu": False,
    }
    assert sections["Skills"]["filled"] is True


def test_workday_ethnicity_prompt_selects_prefer_not_to_respond_canada():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <head>
                <style>
                  body { font-family: system-ui, sans-serif; margin: 24px; }
                  [role="option"] { min-height: 28px; display: block; }
                  input { display: block; width: 320px; }
                </style>
              </head>
              <body>
                <main data-automation-id="applyFlowVoluntaryDisclosuresPage">
                  <h3>Voluntary Disclosures</h3>
                  <div data-automation-id="formField-personalInfoPerson--ethnicities">
                    <label for="personalInfoPerson--ethnicities">Ethnicity*</label>
                    <div id="selected-ethnicities" data-automation-id="selectedItemList">0 items selected</div>
                    <input
                      id="personalInfoPerson--ethnicities"
                      aria-required="true"
                      aria-invalid="true"
                      placeholder="Search"
                      data-uxi-widget-type="selectinput"
                      data-uxi-multiselect-id="ethnicity-list"
                    />
                    <div id="ethnicity-error">Error: The field Ethnicity is required and must have a value.</div>
                  </div>
                  <label>
                    <input id="termsAndConditions--acceptTermsAndAgreements" type="checkbox" required />
                    Yes, I have read and acknowledge Autodesk's Candidate Privacy Statement.*
                  </label>
                </main>
                <script>
                  const input = document.querySelector("#personalInfoPerson--ethnicities");
                  const selected = document.querySelector("#selected-ethnicities");
                  function attachReactClick(el, handler) {
                    el["__reactFiber$hunt"] = {
                      memoizedProps: { onClick: handler },
                      return: null,
                    };
                  }
                  function selectEthnicity(label) {
                    selected.innerHTML =
                      `<div data-automation-id="selectedItem" aria-label="${label}, press delete to clear value.">${label}</div>`;
                    document.querySelector("#ethnicity-menu")?.remove();
                    document.querySelector("#ethnicity-error").remove();
                    input.value = "";
                    input.removeAttribute("aria-invalid");
                  }
                  function renderOptions() {
                    document.querySelector("#ethnicity-menu")?.remove();
                    document.body.insertAdjacentHTML(
                      "beforeend",
                      `<div id="ethnicity-menu" role="listbox" data-automation-id="activeListContainer">
                        <div id="asian-option" role="option" data-automation-id="menuItem">Asian (Canada)</div>
                        <div id="prefer-not-option" role="option" data-automation-id="menuItem">Prefer not to respond (Canada)</div>
                      </div>`
                    );
                    attachReactClick(
                      document.querySelector("#prefer-not-option"),
                      () => selectEthnicity("Prefer not to respond (Canada)")
                    );
                  }
                  input.addEventListener("click", renderOptions);
                  input.addEventListener("input", renderOptions);
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: {},
                settings: {
                  fillRequiredOnly: true,
                  useFieldPipelineV2: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_ethnicity_prompt_neutral",
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              selected: document.querySelector("[data-automation-id='selectedItem']")?.textContent.trim() || "",
              inputValue: document.querySelector("#personalInfoPerson--ethnicities")?.value || "",
              invalid: document.querySelector("#personalInfoPerson--ethnicities")?.getAttribute("aria-invalid") || "",
              errorPresent: Boolean(document.querySelector("#ethnicity-error")),
              termsChecked: document.querySelector("#termsAndConditions--acceptTermsAndAgreements")?.checked || false,
            })
            """
        )
        browser.close()

    fields = {entry["fieldId"]: entry for entry in result["v2Audit"]["fields"]}
    ethnicity = fields["personalInfoPerson--ethnicities"]

    assert result["ok"] is True
    assert values == {
        "selected": "Prefer not to respond (Canada)",
        "inputValue": "",
        "invalid": "",
        "errorPresent": False,
        "termsChecked": True,
    }
    assert ethnicity["questionType"] == "ethnicity_disclosure_neutral"
    assert ethnicity["selectedOption"] == "Prefer not to respond (Canada)"
    assert ethnicity["filled"] is True


def test_workday_prompt_uses_trusted_input_fallback_when_dom_click_does_not_commit():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <main data-automation-id="applyFlowVoluntaryDisclosuresPage">
                  <div data-automation-id="formField-personalInfoPerson--ethnicities">
                    <label for="personalInfoPerson--ethnicities">Ethnicity*</label>
                    <div id="selected-ethnicities" data-automation-id="selectedItemList">0 items selected</div>
                    <input
                      id="personalInfoPerson--ethnicities"
                      aria-required="true"
                      aria-invalid="true"
                      placeholder="Search"
                      data-uxi-widget-type="selectinput"
                      data-uxi-multiselect-id="ethnicity-list"
                    />
                    <div id="ethnicity-error">Error: The field Ethnicity is required and must have a value.</div>
                  </div>
                </main>
                <script>
                  const input = document.querySelector("#personalInfoPerson--ethnicities");
                  const selected = document.querySelector("#selected-ethnicities");
                  window.trustedInputRequests = [];
                  function commitTrusted(label) {
                    selected.innerHTML =
                      `<div data-automation-id="selectedItem" aria-label="${label}, press delete to clear value.">${label}</div>`;
                    document.querySelector("#ethnicity-menu")?.remove();
                    document.querySelector("#ethnicity-error")?.remove();
                    input.value = "";
                    input.removeAttribute("aria-invalid");
                  }
                  window.chrome = {
                    runtime: {
                      lastError: null,
                      sendMessage(message, callback) {
                        window.trustedInputRequests.push(message);
                        if (message?.type === "hunt.apply.trusted_input") {
                          commitTrusted(message.payload.label);
                          callback({ ok: true, reason: "test_trusted_click" });
                          return;
                        }
                        callback({ ok: false, reason: "unexpected_message" });
                      },
                    },
                  };
                  function renderOptions() {
                    document.querySelector("#ethnicity-menu")?.remove();
                    document.body.insertAdjacentHTML(
                      "beforeend",
                      `<div id="ethnicity-menu" role="listbox" data-automation-id="activeListContainer">
                        <div id="asian-option" role="option" data-automation-id="menuItem">Asian (Canada)</div>
                        <div id="prefer-not-option" role="option" data-automation-id="menuItem">Prefer not to respond (Canada)</div>
                      </div>`
                    );
                  }
                  input.addEventListener("click", renderOptions);
                  input.addEventListener("input", renderOptions);
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: {},
                settings: {
                  fillRequiredOnly: true,
                  useFieldPipelineV2: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_prompt_trusted_input",
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              selected: document.querySelector("[data-automation-id='selectedItem']")?.textContent.trim() || "",
              trustedInputCount: window.trustedInputRequests.length,
              trustedInputType: window.trustedInputRequests[0]?.type || "",
              trustedPurpose: window.trustedInputRequests[0]?.payload?.purpose || "",
            })
            """
        )
        browser.close()

    fields = {entry["fieldId"]: entry for entry in result["v2Audit"]["fields"]}
    ethnicity = fields["personalInfoPerson--ethnicities"]

    assert result["ok"] is True
    assert values == {
        "selected": "Prefer not to respond (Canada)",
        "trustedInputCount": 1,
        "trustedInputType": "hunt.apply.trusted_input",
        "trustedPurpose": "option",
    }
    assert ethnicity["filled"] is True


def test_workday_disclosure_dropdown_scrolls_to_virtualized_neutral_option():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <head>
                <style>
                  body { font-family: system-ui, sans-serif; margin: 24px; }
                  #ethnicity-menu {
                    position: absolute;
                    top: 120px;
                    left: 24px;
                    width: 520px;
                    height: 72px;
                    overflow-y: auto;
                    border: 1px solid #999;
                  }
                  [role="option"] { height: 32px; padding: 4px; }
                </style>
              </head>
              <body>
                <div data-automation-id="applyFlowVoluntaryDisclosuresPage">
                  <div data-automation-id="formField-ethnicity">
                    <label for="personalInfoUS--ethnicity">Please select the ethnicity which most accurately describes you.*</label>
                    <button id="personalInfoUS--ethnicity" type="button" aria-haspopup="listbox" aria-label="Please select the ethnicity which most accurately describes you. Select One Required">Select One</button>
                    <div id="ethnicity-error" data-automation-id="inputAlert">Required</div>
                  </div>
                </div>
                <script>
                  const button = document.querySelector("#personalInfoUS--ethnicity");
                  function commit(label) {
                    button.textContent = label;
                    button.setAttribute("aria-label", label);
                    document.querySelector("#ethnicity-error")?.remove();
                    document.querySelector("#ethnicity-menu")?.remove();
                  }
                  function renderInitial() {
                    if (document.querySelector("#ethnicity-menu")) return;
                    document.body.insertAdjacentHTML(
                      "beforeend",
                      `<div id="ethnicity-menu" role="listbox" data-automation-id="activeListContainer">
                         <div role="option" data-automation-id="menuItem" onclick="commit('Asian (Not Hispanic or Latino) (United States of America)')">Asian (Not Hispanic or Latino) (United States of America)</div>
                         <div role="option" data-automation-id="menuItem" onclick="commit('White (Not Hispanic or Latino) (United States of America)')">White (Not Hispanic or Latino) (United States of America)</div>
                         <div style="height: 260px"></div>
                       </div>`
                    );
                    const menu = document.querySelector("#ethnicity-menu");
                    menu.addEventListener("scroll", () => {
                      if (menu.scrollTop < 200 || document.querySelector("#not-specified-option")) return;
                      menu.insertAdjacentHTML(
                        "beforeend",
                        `<div id="not-specified-option" role="option" data-automation-id="menuItem" onclick="commit('Not Specified (United States of America)')">Not Specified (United States of America)</div>`
                      );
                    });
                  }
                  button.addEventListener("click", renderInitial);
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: {},
                settings: {
                  fillRequiredOnly: true,
                  useFieldPipelineV2: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_disclosure_virtualized_neutral",
              });
            }
            """
        )
        value = page.evaluate(
            """
            () => document.querySelector("#personalInfoUS--ethnicity")?.textContent.trim() || ""
            """
        )
        browser.close()

    fields = {entry["fieldId"]: entry for entry in result["v2Audit"]["fields"]}
    ethnicity = fields["personalInfoUS--ethnicity"]

    assert result["ok"] is True
    assert value == "Not Specified (United States of America)"
    assert ethnicity["filled"] is True


def test_workday_sanctioned_country_checkbox_selects_actual_none_input():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <body>
                <div data-automation-id="applyFlowQuestionnairePage">
                  <fieldset aria-required="true">
                    <legend>Please indicate which, if any, where you are a citizen.*</legend>
                    <label for="citizen-cuba">Cuba</label>
                    <input id="citizen-cuba" type="checkbox" aria-label="Please indicate which, if any, where you are a citizen. Cuba Required" />
                    <label for="citizen-syria">Syria</label>
                    <input id="citizen-syria" type="checkbox" aria-label="Please indicate which, if any, where you are a citizen. Syria Required" />
                    <label for="citizen-none">None of these</label>
                    <input id="citizen-none" type="checkbox" aria-label="Please indicate which, if any, where you are a citizen. None of these Required" />
                    <div id="citizenship-error" data-automation-id="inputAlert">Required</div>
                  </fieldset>
                </div>
                <script>
                  for (const input of document.querySelectorAll("input[type='checkbox']")) {
                    input.addEventListener("change", () => {
                      if (document.querySelector("#citizen-none").checked) {
                        document.querySelector("#citizenship-error")?.remove();
                      }
                    });
                  }
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: {},
                settings: {
                  fillRequiredOnly: true,
                  useFieldPipelineV2: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_sanctioned_country_none",
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              cuba: document.querySelector("#citizen-cuba").checked,
              syria: document.querySelector("#citizen-syria").checked,
              none: document.querySelector("#citizen-none").checked,
            })
            """
        )
        browser.close()

    assert result["ok"] is True
    assert values == {
        "cuba": False,
        "syria": False,
        "none": True,
    }


def test_workday_repeatable_skills_does_not_write_into_active_name_field():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    repeatables_source = _load_script(
        REPO_ROOT / "executioner/src/ats/workday/workday-repeatables-v2.js"
    )
    assert 'execCommand("insertText"' not in repeatables_source
    assert "document.execCommand" not in repeatables_source

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill-v2.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content(
            """
            <html>
              <head>
                <style>
                  body { font-family: system-ui, sans-serif; margin: 24px; }
                  section { border-top: 1px solid #ddd; padding: 16px 0; }
                  input { display: block; margin: 8px 0; width: 320px; }
                  [role="option"] { display: block; min-height: 28px; }
                </style>
              </head>
              <body>
                <h3>My Experience</h3>
                <input id="self-identify-name" value="Michael Shi" />
                <section id="skills-section">
                  <h4>Skills</h4>
                  <div data-automation-id="formField-skills">
                    <label>Type to Add Skills
                      <input
                        id="skills--skills"
                        aria-required="true"
                        data-uxi-widget-type="selectinput"
                        data-uxi-multiselect-id="skill-list"
                      />
                    </label>
                    <div id="selected-skills" data-automation-id="selectedItemList"></div>
                  </div>
                </section>
                <script>
                  const nameInput = document.querySelector("#self-identify-name");
                  const skillInput = document.querySelector("#skills--skills");
                  const selected = document.querySelector("#selected-skills");
                  nameInput.focus();
                  document.execCommand = (command, _showUi, value) => {
                    if (command === "insertText" && document.activeElement) {
                      document.activeElement.value += value;
                    }
                    return true;
                  };
                  function attachReactClick(el, handler) {
                    el["__reactFiber$hunt"] = {
                      memoizedProps: { onClick: handler },
                      return: null,
                    };
                  }
                  function selectSkill(label) {
                    selected.innerHTML =
                      `<div data-automation-id="selectedItem" aria-label="${label}, press delete to clear value.">${label}</div>`;
                    document.querySelector("#skill-menu")?.remove();
                    skillInput.value = "";
                    skillInput.removeAttribute("aria-invalid");
                  }
                  function renderOptions() {
                    const query = skillInput.value || "";
                    document.querySelector("#skill-menu")?.remove();
                    if (!/communication/i.test(query)) return;
                    document.body.insertAdjacentHTML(
                      "beforeend",
                      `<div id="skill-menu" role="listbox" data-automation-id="activeListContainer">
                        <div id="communication-row" role="option" data-automation-id="menuItem" aria-label="Communication not checked">
                          <input id="communication-checkbox" type="checkbox" data-automation-id="checkboxPanel" />
                          <span>Communication</span>
                        </div>
                      </div>`
                    );
                    attachReactClick(
                      document.querySelector("#communication-checkbox"),
                      () => selectSkill("Communication")
                    );
                  }
                  skillInput.addEventListener("input", () => setTimeout(renderOptions, 80));
                  skillInput.addEventListener("click", renderOptions);
                </script>
              </body>
            </html>
            """
        )
        _load_v2_workday_scripts(page)
        page.add_script_tag(content=fill_v2_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillV2Function();
              return await fill({
                profile: {
                  fullName: "Michael Shi",
                  skillList: ["Python"],
                },
                settings: {
                  fillRequiredOnly: true,
                  useFieldPipelineV2: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fillRunId: "workday_skill_no_name_pollution",
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              name: document.querySelector("#self-identify-name")?.value || "",
              selected: document.querySelector("[data-automation-id='selectedItem']")?.textContent.trim() || "",
              inputValue: document.querySelector("#skills--skills")?.value || "",
            })
            """
        )
        browser.close()

    assert result["ok"] is True
    assert values == {
        "name": "Michael Shi",
        "selected": "Communication",
        "inputValue": "",
    }
