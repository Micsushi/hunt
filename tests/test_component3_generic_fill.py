import json
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


def _module_to_browser_script(source: str) -> str:
    return source.replace("export function", "function").replace("export const", "const")


def _load_v2_scripts(page):
    for path in [
        "executioner/src/shared/injected.js",
        "executioner/src/shared/v2/audit.js",
        "executioner/src/shared/v2/field-catalog.js",
        "executioner/src/shared/v2/ui-inspector.js",
        "executioner/src/shared/v2/field-state.js",
        "executioner/src/shared/v2/option-collector.js",
        "executioner/src/shared/v2/option-matcher.js",
        "executioner/src/shared/v2/question-identifier.js",
        "executioner/src/shared/v2/answer-resolver.js",
        "executioner/src/shared/v2/field-drivers.js",
        "executioner/src/shared/v2/field-pipeline.js",
        "executioner/src/shared/v2/clear-pipeline.js",
    ]:
        page.add_script_tag(content=_load_script(REPO_ROOT / path))


def test_generic_v2_radio_options_use_associated_labels_before_group_text():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 V2 fixture")

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
                <fieldset role="group">
                  <legend>Have you previously worked for this organization?</legend>
                  <input id="previous-yes" name="candidateIsPreviousWorker" type="radio" value="true" />
                  <label for="previous-yes">Yes</label>
                  <input id="previous-no" name="candidateIsPreviousWorker" type="radio" value="false" />
                  <label for="previous-no">No</label>
                </fieldset>
              </body>
            </html>
            """
        )
        _load_v2_scripts(page)
        result = page.evaluate(
            """
            async () => {
              const root = window.__huntV2;
              const field = root.uiInspector.collectCandidates()
                .find((candidate) => candidate.fieldId === "candidateIsPreviousWorker");
              const options = await root.optionCollector.collectOptions(field, {});
              const match = root.optionMatcher.matchOption({
                options,
                answer: { value: "No", answerType: "yes_no" },
                field,
                audit: null,
                fieldAudit: null,
              });
              const fill = await root.fieldDrivers.fillField({
                field,
                answer: { value: "No", answerType: "yes_no" },
                option: match.option,
                audit: null,
                fieldAudit: null,
              });
              return {
                labels: options.map((option) => option.label),
                optionSource: match.source,
                selectedOption: match.option && match.option.label,
                filled: fill.ok,
                yes: document.querySelector("#previous-yes").checked,
                no: document.querySelector("#previous-no").checked,
              };
            }
            """
        )
        browser.close()

    assert result == {
        "labels": ["Yes", "No"],
        "optionSource": "exact",
        "selectedOption": "No",
        "filled": True,
        "yes": False,
        "no": True,
    }


def test_generic_v2_unknown_option_defaults_to_neutral_yes_then_first_real():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 V2 fixture")

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.set_content("<html><body></body></html>")
        _load_v2_scripts(page)
        result = page.evaluate(
            """
            () => {
              const root = window.__huntV2;
              const firstReal = root.optionMatcher.matchOption({
                options: [
                  { label: "Yes", value: "Yes" },
                  { label: "No", value: "No" },
                ],
                answer: { value: "", answerType: "unknown" },
                field: {},
                audit: null,
                fieldAudit: null,
              });
              const neutralWins = root.optionMatcher.matchOption({
                options: [
                  { label: "Yes", value: "Yes" },
                  { label: "Prefer not to disclose", value: "Prefer not to disclose" },
                  { label: "No", value: "No" },
                ],
                answer: { value: "", answerType: "unknown" },
                field: {},
                audit: null,
                fieldAudit: null,
              });
              const firstRealFallback = root.optionMatcher.matchOption({
                options: [
                  { label: "Maybe", value: "Maybe" },
                  { label: "No", value: "No" },
                ],
                answer: { value: "", answerType: "unknown" },
                field: {},
                audit: null,
                fieldAudit: null,
              });
              return {
                firstRealLabel: firstReal.option && firstReal.option.label,
                firstRealSource: firstReal.source,
                neutralLabel: neutralWins.option && neutralWins.option.label,
                neutralSource: neutralWins.source,
                fallbackLabel: firstRealFallback.option && firstRealFallback.option.label,
                fallbackSource: firstRealFallback.source,
              };
            }
            """
        )
        browser.close()

    assert result == {
        "firstRealLabel": "Yes",
        "firstRealSource": "unknown_yes_fallback",
        "neutralLabel": "Prefer not to disclose",
        "neutralSource": "neutral_fallback",
        "fallbackLabel": "Maybe",
        "fallbackSource": "unknown_first_real_option",
    }


def test_generic_v2_option_matcher_keeps_checkbox_guard_before_aliases():
    option_matcher = _load_script(REPO_ROOT / "executioner/src/shared/v2/option-matcher.js")

    assert option_matcher.index('source: "affirmative_checkbox"') < option_matcher.index(
        "var aliases = optionAliases(answer);"
    )


def test_generic_v2_fill_logs_profile_defaults_and_text_fallbacks():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 V2 fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/fill-v2.js")
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
                <form>
                  <label>First name * <input id="first-name" required /></label>
                  <label>
                    Gender *
                    <select id="gender" required>
                      <option value="">Select One</option>
                      <option value="woman">Woman</option>
                      <option value="not_disclose">I choose not to disclose</option>
                    </select>
                  </label>
                  <label>
                    Explain your operating mode *
                    <input id="unknown-text" required />
                  </label>
                </form>
              </body>
            </html>
            """
        )
        _load_v2_scripts(page)
        page.add_script_tag(content=fill_v2_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createGenericFillV2Function();
              return await fill({
                profile: {
                  fullName: "Michael Shi",
                  email: "michael@example.test",
                  location: "Edmonton, AB, Canada",
                },
                settings: {
                  fillRequiredOnly: true,
                  useFieldPipelineV2: true,
                  allowGeneratedAnswers: true,
                  llmAnswerFallbackEnabled: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fillRoute: { adapterName: "generic" },
                fillRunId: "test_v2",
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              firstName: document.querySelector("#first-name").value,
              gender: document.querySelector("#gender").value,
              unknownRaw: document.querySelector("#unknown-text").value,
            })
            """
        )
        browser.close()

    assert result["ok"] is True
    assert values["firstName"] == "Michael"
    assert values["gender"] == "not_disclose"
    assert values["unknownRaw"] == " "
    assert result["manualReviewRequired"] is True
    assert result["v2Audit"]["schemaVersion"] == "c3-v2-audit-1"
    issue_kinds = {issue["kind"] for issue in result["v2Audit"]["permanentIssues"]}
    assert "derived_profile_pairing" in issue_kinds
    assert "neutral_disclosure_default" in issue_kinds
    assert "generated_or_placeholder_text_fallback" in issue_kinds


def test_generic_v2_fills_oracle_email_and_hidden_terms_checkbox():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 V2 fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/fill-v2.js")
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
                <form>
                  <label class="input-row__label input-row__label--required" for="primary-email-0">
                    Email Address
                  </label>
                  <input id="primary-email-0" name="primary-email" type="email" required />
                  <label for="honey-pot-1">honeypot</label>
                  <input id="honey-pot-1" name="honey-pot" />
                  <label class="input-row legal-disclaimer-container" for="legal-disclaimer-checkbox">
                    <input
                      id="legal-disclaimer-checkbox"
                      class="input-row__hidden-control"
                      type="checkbox"
                      required
                      style="width:0;height:0;position:absolute;"
                    />
                    <span>I agree with the terms and conditions</span>
                  </label>
                </form>
              </body>
            </html>
            """
        )
        _load_v2_scripts(page)
        page.add_script_tag(content=fill_v2_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createGenericFillV2Function();
              return await fill({
                profile: {
                  email: "michael@example.test",
                },
                settings: {
                  fillRequiredOnly: true,
                  useFieldPipelineV2: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fillRoute: { adapterName: "oracle" },
                fillRunId: "test_oracle_v2",
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              email: document.querySelector("#primary-email-0").value,
              honeypot: document.querySelector("#honey-pot-1").value,
              terms: document.querySelector("#legal-disclaimer-checkbox").checked,
            })
            """
        )
        browser.close()

    assert result["ok"] is True
    assert values == {
        "email": "michael@example.test",
        "honeypot": "",
        "terms": True,
    }
    ids = {entry["id"]: entry for entry in result["fieldInventory"]}
    assert "honey-pot-1" not in ids
    assert ids["legal-disclaimer-checkbox"]["filled"] is True
    assert ids["legal-disclaimer-checkbox"]["valueSource"] == "profile:terms_acceptance"


def test_generic_v2_does_not_upload_resume_to_cover_letter():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 V2 fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/fill-v2.js")
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
                <form>
                  <label for="resume-file">Resume/CV *</label>
                  <input id="resume-file" type="file" required />
                  <label for="cover-letter-file">Cover Letter *</label>
                  <input id="cover-letter-file" type="file" required />
                </form>
              </body>
            </html>
            """
        )
        _load_v2_scripts(page)
        page.add_script_tag(content=fill_v2_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createGenericFillV2Function();
              return await fill({
                profile: {},
                settings: { fillRequiredOnly: true },
                activeApplyContext: {},
                defaultResume: {
                  pdfFileName: "main.pdf",
                  pdfMimeType: "application/pdf",
                  pdfDataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
                },
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              resumeFileName: document.querySelector("#resume-file").files[0]?.name || "",
              coverLetterFileName: document.querySelector("#cover-letter-file").files[0]?.name || "",
            })
            """
        )
        browser.close()

    assert values == {
        "resumeFileName": "main.pdf",
        "coverLetterFileName": "",
    }
    resume = [entry for entry in result["fieldInventory"] if entry["id"] == "resume-file"][0]
    cover_letter = [
        entry for entry in result["fieldInventory"] if entry["id"] == "cover-letter-file"
    ][0]
    assert resume["filled"] is True
    assert resume["valueSource"] == "resume_upload"
    assert cover_letter["filled"] is False
    assert cover_letter["skippedReason"] == "not_resume_input"
    assert result["manualReviewRequired"] is True


def test_generic_v2_file_driver_requires_resume_upload_answer():
    field_drivers = _load_script(REPO_ROOT / "executioner/src/shared/v2/field-drivers.js")

    assert 'answer?.answerType !== "file"' in field_drivers
    assert 'String(answer?.value || "") !== "resume_upload"' in field_drivers
    assert 'reason: "not_resume_input"' in field_drivers


def test_generic_v2_oracle_grid_combobox_guards():
    option_collector = _load_script(REPO_ROOT / "executioner/src/shared/v2/option-collector.js")
    option_matcher = _load_script(REPO_ROOT / "executioner/src/shared/v2/option-matcher.js")
    field_catalog = _load_script(REPO_ROOT / "executioner/src/shared/v2/field-catalog.js")

    assert 'document.execCommand("insertText"' in option_collector
    assert '[role="gridcell"]' in option_collector
    assert ".cx-select__list-item" in option_collector
    assert "hasOptionMatch(options, answerText)" in option_collector
    assert 'label.startsWith(target + ",")' in option_matcher
    assert 'source: "boundary"' in option_matcher
    assert "strict_province_no_match" in option_matcher
    assert "isStrictAliasMatch" in option_matcher
    assert "stateSatisfiesAnswer" in _load_script(
        REPO_ROOT / "executioner/src/shared/v2/field-drivers.js"
    )
    assert 'Alberta: ["AB"]' in field_catalog


def test_generic_v2_clear_removes_oracle_uploaded_attachment_card():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 V2 fixture")

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
                <section class="apply-flow-block apply-flow-block--file-upload">
                  <h2>Supporting Documents and URLs</h2>
                  <div class="file-upload-wrapper__section">
                    <div
                      role="application"
                      class="attachment-upload-button attachment-upload-button--filled"
                    >
                      <span>main.pdf</span>
                      <button
                        class="attachment-upload-button__bottom-button"
                        aria-label="Remove attachment: main.pdf"
                        title="Remove attachment: main.pdf"
                      >
                        REMOVE
                      </button>
                    </div>
                  </div>
                  <div
                    role="application"
                    class="attachment-upload-button attachment-upload-button--waiting"
                  >
                    Drop Cover Letter Here or Upload Cover Letter
                  </div>
                  <label>Link 1 <input id="link-1" /></label>
                </section>
                <script>
                  document
                    .querySelector(".attachment-upload-button__bottom-button")
                    .addEventListener("click", (event) => {
                      event
                        .target
                        .closest(".attachment-upload-button--filled")
                        .remove();
                    });
                </script>
              </body>
            </html>
            """
        )
        _load_v2_scripts(page)
        result = page.evaluate(
            """
            async () => {
              return await window.__huntV2.clearPipeline.runHuntV2Clear({
                fillRunId: "oracle_upload_clear",
                atsType: "oracle",
              });
            }
            """
        )
        remaining = page.evaluate(
            """
            () => ({
              pdfText: document.body.innerText.includes("main.pdf"),
              coverUpload: document.body.innerText.includes("Upload Cover Letter"),
            })
            """
        )
        browser.close()

    assert result["uploadedFileClears"] == 1
    assert remaining == {"pdfText": False, "coverUpload": True}


def test_generic_v2_clear_clicks_custom_select_x_and_trash_icons():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 V2 fixture")

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
                <section class="application-field">
                  <label for="legal-combo">Are you legally allowed to work in Canada? *</label>
                  <div id="legal-combo" class="cx-select" role="combobox" aria-haspopup="listbox">
                    <span class="cx-select__value">Yes</span>
                    <button
                      class="cx-select__clear-icon"
                      aria-label="Clear selected value"
                      type="button"
                    >
                      x
                    </button>
                    <button class="cx-select__toggle" aria-label="Open options" type="button">
                      v
                    </button>
                  </div>
                </section>
                <section class="application-field">
                  <label>Website</label>
                  <div class="selected-row">
                    <span class="selected-row__value">https://example.test</span>
                    <button
                      class="selected-row__trash"
                      aria-label="Delete website row"
                      type="button"
                    >
                      trash
                    </button>
                  </div>
                </section>
                <script>
                  document.querySelector(".cx-select__clear-icon").addEventListener("click", () => {
                    document.querySelector(".cx-select__value").textContent = "";
                  });
                  document.querySelector(".selected-row__trash").addEventListener("click", (event) => {
                    event.target.closest(".selected-row").remove();
                  });
                </script>
              </body>
            </html>
            """
        )
        _load_v2_scripts(page)
        result = page.evaluate(
            """
            async () => {
              return await window.__huntV2.clearPipeline.runHuntV2Clear({
                fillRunId: "oracle_select_clear",
                atsType: "oracle",
              });
            }
            """
        )
        remaining = page.evaluate(
            """
            () => ({
              legalValue: document.querySelector(".cx-select__value").textContent,
              websiteRow: Boolean(document.querySelector(".selected-row")),
            })
            """
        )
        browser.close()

    assert result["genericIconClears"] >= 2
    assert remaining == {"legalValue": "", "websiteRow": False}


def test_generic_v2_fills_oracle_segmented_yes_no_buttons():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 V2 fixture")

    fill_v2_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/fill-v2.js")
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
                <form>
                  <div class="application-field" aria-required="true">
                    <div>
                      Are you able to legally work, within the country and
                      state/province/territory in which you are applying, for an
                      extended period of time?<span>*</span>
                    </div>
                    <ul
                      class="cx-select-pills-container"
                      aria-label="Are you able to legally work, within the country and state/province/territory in which you are applying, for an extended period of time?"
                    >
                      <li><button class="cx-select-pill-section" type="button" aria-pressed="false">No</button></li>
                      <li><button class="cx-select-pill-section" type="button" aria-pressed="false">Yes</button></li>
                    </ul>
                    <div role="alert">This info is required.</div>
                  </div>
                  <div class="application-field" aria-required="true">
                    <div>Are you a current ATCO Employee? <span>*</span></div>
                    <ul
                      class="cx-select-pills-container"
                      aria-label="Are you a current ATCO Employee?"
                    >
                      <li><button class="cx-select-pill-section" type="button" aria-pressed="false">Yes</button></li>
                      <li><button class="cx-select-pill-section" type="button" aria-pressed="false">No</button></li>
                    </ul>
                    <div role="alert">This info is required.</div>
                  </div>
                  <div class="application-field" aria-required="true" id="previous-atco-field" hidden>
                    <div>
                      Have you ever worked for ATCO as either an employee or as
                      a contractor? <span>*</span>
                    </div>
                    <ul
                      class="cx-select-pills-container"
                      aria-label="Have you ever worked for ATCO as either an employee or as a contractor?"
                    >
                      <li><button class="cx-select-pill-section" type="button" aria-pressed="false">Yes</button></li>
                      <li><button class="cx-select-pill-section" type="button" aria-pressed="false">No</button></li>
                    </ul>
                    <div role="alert">This info is required.</div>
                  </div>
                  <div class="application-field" aria-required="true">
                    <div>Are you a member of CEWA? <span>*</span></div>
                    <ul
                      class="cx-select-pills-container"
                      aria-label="Are you a member of CEWA?"
                    >
                      <li><button class="cx-select-pill-section" type="button" aria-pressed="false">No</button></li>
                      <li><button class="cx-select-pill-section" type="button" aria-pressed="false">Yes</button></li>
                    </ul>
                    <div role="alert">This info is required.</div>
                  </div>
                </form>
                <script>
                  document.querySelectorAll(".cx-select-pills-container").forEach((field) => {
                    field.querySelectorAll("button").forEach((button) => {
                      button.addEventListener("click", () => {
                        field.querySelectorAll("button").forEach((other) => {
                          other.classList.remove("cx-select-pill-section--selected");
                          other.setAttribute("aria-pressed", "false");
                        });
                        button.classList.add("cx-select-pill-section--selected");
                        button.setAttribute("aria-pressed", "true");
                        field.dataset.selected = button.textContent.trim();
                        if (
                          field.getAttribute("aria-label") ===
                            "Are you a current ATCO Employee?" &&
                          button.textContent.trim() === "No"
                        ) {
                          document.querySelector("#previous-atco-field").hidden = false;
                        }
                      });
                    });
                  });
                </script>
              </body>
            </html>
            """
        )
        _load_v2_scripts(page)
        page.add_script_tag(content=fill_v2_js)
        result = page.evaluate(
            """
            async () => {
              const fill = createGenericFillV2Function();
              return await fill({
                profile: {
                  workAuthorized: true,
                  previousEmployers: "",
                },
                settings: { fillRequiredOnly: true, useFieldPipelineV2: true },
                activeApplyContext: { company: "ATCO" },
                defaultResume: {},
                fillRoute: { adapterName: "oracle" },
                fillRunId: "oracle_segmented_buttons",
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => [...document.querySelectorAll(".cx-select-pills-container")]
              .map((field) => field.dataset.selected || "")
            """
        )
        browser.close()

    assert result["ok"] is True
    assert values == ["Yes", "No", "No", "No"]
    segmented = [
        entry for entry in result["fieldInventory"] if entry["kind"] == "segmentedButtonGroup"
    ]
    assert len(segmented) == 4
    assert all(entry["filled"] for entry in segmented)
    cewa = next(entry for entry in segmented if "CEWA" in entry["descriptor"])
    assert cewa["questionType"] == "union_membership"
    issue_descriptors = [
        issue.get("descriptor", "") for issue in result["v2Audit"]["permanentIssues"]
    ]
    assert not any("CEWA" in descriptor for descriptor in issue_descriptors)


def test_generic_v2_clear_has_uploaded_file_card_guard():
    clear_pipeline = _load_script(REPO_ROOT / "executioner/src/shared/v2/clear-pipeline.js")

    assert "collectUploadedFileNodes" in clear_pipeline
    assert "clearUploadedFileControls" in clear_pipeline
    assert "clearGenericIconControls" in clear_pipeline
    assert "remove attachment:" in clear_pipeline
    assert ".attachment-upload-button__bottom-button" in clear_pipeline
    assert "cx-select" in clear_pipeline
    assert "containsUploadedFileText" in clear_pipeline
    assert clear_pipeline.count("await clearGenericIconControls(audit)") == 1


def test_generic_v2_segmented_button_guards():
    ui_inspector = _load_script(REPO_ROOT / "executioner/src/shared/v2/ui-inspector.js")
    option_collector = _load_script(REPO_ROOT / "executioner/src/shared/v2/option-collector.js")
    field_drivers = _load_script(REPO_ROOT / "executioner/src/shared/v2/field-drivers.js")

    assert "segmented_button_group" in ui_inspector
    assert "collectSegmentedButtonGroups" in ui_inspector
    assert "selectedChoiceButtons" in ui_inspector
    assert "ul.cx-select-pills-container" in ui_inspector
    assert "[aria-label][class*='select-pills']" in ui_inspector
    assert "segmented_button_group" in option_collector
    assert "fillSegmentedButtonGroup" in field_drivers


def test_generic_v2_segmented_pill_groups_are_collected_before_broad_parents():
    ui_inspector = _load_script(REPO_ROOT / "executioner/src/shared/v2/ui-inspector.js")
    collector = ui_inspector[ui_inspector.index("function collectSegmentedButtonGroups") :]
    explicit_pill_index = collector.index("ul.cx-select-pills-container")
    broad_parent_index = collector.index('"fieldset"')

    assert explicit_pill_index < broad_parent_index
    assert ui_inspector.count(".filter(visible)\n      .forEach(collectFromContainer)") >= 2
    assert "container.contains(group.container)" in ui_inspector
    assert "isSegmentedGroupRequired" in ui_inspector
    assert ".input-row" in ui_inspector
    field_pipeline = _load_script(REPO_ROOT / "executioner/src/shared/v2/field-pipeline.js")
    assert "page_rescanned" in field_pipeline
    assert "conditional_fields_check" in field_pipeline
    assert "post_submit_validation_signature_guard" in field_pipeline


def test_safe_next_clicks_next_controls_only():
    if sync_playwright is None:
        pytest.skip("playwright is required for the safe next fixture")

    safe_next_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/background/safe-next.js")
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
                <form>
                  <input id="email" value="candidate@example.test" />
                  <button id="next" type="submit">Next</button>
                </form>
                <script>
                  document.querySelector("#next").addEventListener("click", (event) => {
                    event.preventDefault();
                    document.body.dataset.nextClicked = "1";
                  });
                </script>
              </body>
            </html>
            """
        )
        page.add_script_tag(content=safe_next_js)
        result = page.evaluate(
            """
            () => {
              const safeNext = createSafeNextFunction();
              return safeNext({ click: true });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              nextClicked: document.body.dataset.nextClicked || "",
              url: window.location.href,
            })
            """
        )
        browser.close()

    assert result["ok"] is True
    assert result["clicked"] is True
    assert result["candidate"]["label"] == "Next"
    assert values["nextClicked"] == "1"


def test_safe_next_ignores_workday_upload_success_alerts():
    if sync_playwright is None:
        pytest.skip("playwright is required for the safe next fixture")

    safe_next_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/background/safe-next.js")
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
                <div role="alert">main.pdf successfully uploaded</div>
                <button id="next" type="button">Next</button>
                <script>
                  document.querySelector("#next").addEventListener("click", () => {
                    document.body.dataset.nextClicked = "1";
                  });
                </script>
              </body>
            </html>
            """
        )
        page.add_script_tag(content=safe_next_js)
        result = page.evaluate(
            """
            () => {
              const safeNext = createSafeNextFunction();
              return safeNext({ click: true });
            }
            """
        )
        next_clicked = page.evaluate('document.body.dataset.nextClicked || ""')
        browser.close()

    assert result["ok"] is True
    assert result["clicked"] is True
    assert result["candidate"]["label"] == "Next"
    assert next_clicked == "1"


def test_safe_next_blocks_final_submit_controls():
    if sync_playwright is None:
        pytest.skip("playwright is required for the safe next fixture")

    safe_next_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/background/safe-next.js")
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
                <button id="submit" type="submit">Submit application</button>
                <button id="apply" type="button">Apply now</button>
                <script>
                  document.querySelector("#submit").addEventListener("click", () => {
                    document.body.dataset.submitted = "1";
                  });
                  document.querySelector("#apply").addEventListener("click", () => {
                    document.body.dataset.applied = "1";
                  });
                </script>
              </body>
            </html>
            """
        )
        page.add_script_tag(content=safe_next_js)
        result = page.evaluate(
            """
            () => {
              const safeNext = createSafeNextFunction();
              return safeNext({ click: true });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              submitted: document.body.dataset.submitted || "",
              applied: document.body.dataset.applied || "",
            })
            """
        )
        browser.close()

    assert result["ok"] is False
    assert result["clicked"] is False
    assert result["reason"] == "final_submit_visible"
    assert values == {"submitted": "", "applied": ""}


def test_shared_radio_group_selects_no_with_workday_true_false_values():
    if sync_playwright is None:
        pytest.skip("playwright is required for the injected utility fixture")

    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")

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
                <fieldset role="group">
                  <legend>
                    Have you previously been employed or a student at UBC? If yes,
                    please provide details.
                  </legend>
                  <input id="previous-yes" name="candidateIsPreviousWorker" type="radio" value="true" />
                  <label for="previous-yes">Yes</label>
                  <input id="previous-no" name="candidateIsPreviousWorker" type="radio" value="false" />
                  <label for="previous-no">No</label>
                </fieldset>
              </body>
            </html>
            """
        )
        page.add_script_tag(content=injected_js)
        result = page.evaluate(
            """
            () => {
              const radios = [...document.querySelectorAll("input[type='radio']")];
              const descriptor = radios.map((radio) => window.__huntApplyUtils.getDescriptor(radio, ["label", "[role='group']")).join(" ");
              return {
                filled: window.__huntApplyUtils.fillRadioGroup(
                  radios,
                  descriptor,
                  { previousEmployers: "" },
                  ["label", "[role='group']"]
                ),
                yes: document.querySelector("#previous-yes").checked,
                no: document.querySelector("#previous-no").checked,
              };
            }
            """
        )
        browser.close()

    assert result == {"filled": True, "yes": False, "no": True}


def test_shared_structured_choice_handles_workday_missing_s_equity_text():
    if sync_playwright is None:
        pytest.skip("playwright is required for the injected utility fixture")

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
              const descriptors = [
                "Do you identify your elf a an Indigenou per on of Canada?",
                "Do you identify a omeone who i racialized, a vi ible minority, per on of colour?",
                "Referring to the definition above, do you identify a a Di abled Per on?",
              ];
              return descriptors.map((descriptor) => {
                const choice = u.chooseStructuredChoice(descriptor, {}, true);
                return {
                  text: choice && choice.text,
                  score: u.optionScoreForChoice("I choo e not to di clo e", "", choice || {}, true),
                };
              });
            }
            """
        )
        browser.close()

    assert result == [
        {"text": "I choose not to disclose", "score": 90},
        {"text": "I choose not to disclose", "score": 90},
        {"text": "I choose not to disclose", "score": 90},
    ]


def test_generic_fill_populates_required_fields_only():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 fill fixture")

    fixture = REPO_ROOT / "executioner/fixtures/generic/basic_required.html"
    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")
    fill_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/fill-v2.js")
    )
    rules_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/field-rules.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.goto(fixture.as_uri())
        _load_v2_scripts(page)
        page.add_script_tag(content=fill_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createGenericFillV2Function();
              return await fill({
                profile: {
                  fullName: "Michael Shi",
                  email: "wenjian2@ualberta.ca",
                  phone: "555-555-0100",
                  location: "Edmonton, AB",
                  linkedinUrl: "https://linkedin.com/in/wjshi",
                  githubUrl: "https://github.com/micsushi",
                  websiteUrl: "https://mshi.ca",
                  workAuthorized: true,
                  sponsorshipRequired: false,
                  willingToRelocate: true,
                  openToAnyLocation: true,
                  salaryFlexible: true,
                  coOpTermsCompleted: "0",
                  availableSummer2026: "yes",
                  availableInterviewWindow: "yes",
                  expectedGraduationYear: "2026",
                  previousEmployers: "",
                  notes: "",
                },
                settings: {
                  stripLongDash: true,
                  allowGeneratedAnswers: true,
                  flagLowConfidenceAnswers: true,
                },
                activeApplyContext: {
                  title: "Software Engineer",
                  company: "Example Corp",
                  jobUrl: "https://example.test/jobs/1",
                  applyUrl: "https://example.test/apply/1",
                },
                defaultResume: {
                  pdfFileName: "resume.pdf",
                  pdfMimeType: "application/pdf",
                  pdfDataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
                },
                fieldRules: GENERIC_FIELD_RULES,
              });
            }
            """
        )

        values = page.evaluate(
            """
            () => ({
              firstName: document.querySelector("#first-name").value,
              surname: document.querySelector("#surname").value,
              preferredName: document.querySelector("#preferred-name").value,
              email: document.querySelector("#email").value,
              phone: document.querySelector("#phone").value,
              company: document.querySelector("#company").value,
              position: document.querySelector("#position").value,
              resumeFileName: document.querySelector("#resume").files[0]?.name || "",
              authorized: document.querySelector("#authorized").value,
              relocateYes: document.querySelector("#relocate-yes").checked,
              optionalQuestion: document.querySelector("#optional-question").value,
            })
            """
        )
        browser.close()

    assert result["ok"] is True
    assert result["atsType"] == "generic"
    assert result["generatedAnswerCount"] == 0
    assert result["filledFieldCount"] == 9, json.dumps(result["filledFields"], indent=2)
    assert result["fieldInventory"]
    email_inventory = [entry for entry in result["fieldInventory"] if entry["id"] == "email"][0]
    assert "email" in email_inventory["descriptor"]
    assert email_inventory["required"] is True
    assert email_inventory["filled"] is True
    assert values == {
        "firstName": "Michael",
        "surname": "Shi",
        "preferredName": "",
        "email": "wenjian2@ualberta.ca",
        "phone": "555-555-0100",
        "company": "Example Corp",
        "position": "Software Engineer",
        "resumeFileName": "resume.pdf",
        "authorized": "yes",
        "relocateYes": True,
        "optionalQuestion": "",
    }


def test_generic_fill_retries_text_fields_that_lose_committed_value():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 fill fixture")

    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")
    fill_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/fill-v2.js")
    )
    rules_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/field-rules.js")
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
                <label>First Name* <input id="first-name" autocomplete="given-name" required /></label>
                <label>Last Name* <input id="last-name" autocomplete="family-name" required /></label>
                <script>
                  const first = document.querySelector("#first-name");
                  first.addEventListener("input", () => {
                    if (first.dataset.clearedOnce) return;
                    first.dataset.clearedOnce = "1";
                    setTimeout(() => { first.value = ""; }, 180);
                  });
                </script>
              </body>
            </html>
            """
        )
        _load_v2_scripts(page)
        page.add_script_tag(content=fill_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createGenericFillV2Function();
              return await fill({
                profile: {
                  fullName: "Michael Shi",
                  email: "",
                  phone: "",
                  location: "",
                  linkedinUrl: "",
                  githubUrl: "",
                  websiteUrl: "",
                },
                settings: {
                  stripLongDash: true,
                  fillRequiredOnly: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fieldRules: GENERIC_FIELD_RULES,
              });
            }
            """
        )
        values = page.evaluate(
            """
            () => ({
              firstName: document.querySelector("#first-name").value,
              lastName: document.querySelector("#last-name").value,
            })
            """
        )
        browser.close()

    assert result["ok"] is True
    assert result["filledFieldCount"] == 2
    assert values == {"firstName": "Michael", "lastName": "Shi"}
    first = [entry for entry in result["fieldInventory"] if entry["id"] == "first-name"][0]
    assert first["filled"] is True
    assert first["skippedReason"] == ""


def test_generic_fill_can_fill_optional_known_fields_when_required_only_is_off():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 fill fixture")

    fixture = REPO_ROOT / "executioner/fixtures/generic/basic_required.html"
    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")
    fill_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/fill-v2.js")
    )
    rules_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/field-rules.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.goto(fixture.as_uri())
        _load_v2_scripts(page)
        page.add_script_tag(content=fill_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createGenericFillV2Function();
              return await fill({
                profile: {
                  fullName: "Michael Shi",
                  email: "wenjian2@ualberta.ca",
                  phone: "555-555-0100",
                  location: "Edmonton, AB",
                  linkedinUrl: "https://linkedin.com/in/wjshi",
                  githubUrl: "https://github.com/micsushi",
                  websiteUrl: "https://mshi.ca",
                  workAuthorized: true,
                  sponsorshipRequired: false,
                  willingToRelocate: true,
                  openToAnyLocation: true,
                  salaryFlexible: true,
                  coOpTermsCompleted: "2",
                  availableSummer2026: "yes",
                  availableInterviewWindow: "yes",
                  expectedGraduationYear: "2026",
                  previousEmployers: "",
                  notes: "",
                },
                settings: {
                  stripLongDash: true,
                  fillRequiredOnly: false,
                  allowGeneratedAnswers: true,
                  flagLowConfidenceAnswers: true,
                },
                activeApplyContext: {
                  title: "Software Engineer",
                  company: "Example Corp",
                  jobUrl: "https://example.test/jobs/1",
                  applyUrl: "https://example.test/apply/1",
                },
                defaultResume: {
                  pdfFileName: "resume.pdf",
                  pdfMimeType: "application/pdf",
                  pdfDataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
                },
                fieldRules: GENERIC_FIELD_RULES,
              });
            }
            """
        )
        preferred_name = page.evaluate("""() => document.querySelector("#preferred-name").value""")
        optional_question = page.evaluate(
            """() => document.querySelector("#optional-question").value"""
        )
        browser.close()

    assert result["ok"] is True
    assert result["filledFieldCount"] == 10, json.dumps(result["filledFields"], indent=2)
    assert preferred_name == "Michael"
    assert optional_question == ""
    preferred_inventory = [
        entry for entry in result["fieldInventory"] if entry["id"] == "preferred-name"
    ][0]
    assert preferred_inventory["required"] is False
    assert preferred_inventory["filled"] is True
    assert preferred_inventory["valueSource"] == "profile:preferredName"


def test_generic_fill_reads_sibling_labels_and_hidden_resume_inputs():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 fill fixture")

    fixture = REPO_ROOT / "executioner/fixtures/generic/greenhouse_like.html"
    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")
    fill_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/fill-v2.js")
    )
    rules_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/field-rules.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.goto(fixture.as_uri())
        _load_v2_scripts(page)
        page.add_script_tag(content=fill_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createGenericFillV2Function();
              return await fill({
                profile: {
                  fullName: "Michael Shi",
                  email: "wenjian2@ualberta.ca",
                  phone: "555-555-0100",
                  location: "Edmonton, AB",
                  linkedinUrl: "https://linkedin.com/in/wjshi",
                  githubUrl: "https://github.com/micsushi",
                  websiteUrl: "https://mshi.ca",
                  workAuthorized: true,
                  sponsorshipRequired: false,
                  willingToRelocate: true,
                  openToAnyLocation: true,
                  salaryFlexible: true,
                  notes: "",
                },
                settings: {
                  stripLongDash: true,
                  fillRequiredOnly: true,
                  allowGeneratedAnswers: true,
                  flagLowConfidenceAnswers: true,
                },
                activeApplyContext: {
                  title: "Software Engineer",
                  company: "Example Corp",
                  jobUrl: "https://example.test/jobs/1",
                  applyUrl: "https://example.test/apply/1",
                },
                defaultResume: {
                  pdfFileName: "resume.pdf",
                  pdfMimeType: "application/pdf",
                  pdfDataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
                },
                fieldRules: GENERIC_FIELD_RULES,
              });
            }
            """
        )

        values = page.evaluate(
            """
            () => ({
              firstName: document.querySelector("#first-name").value,
              lastName: document.querySelector("#last-name").value,
              preferredFirstName: document.querySelector("#preferred-first-name").value,
              email: document.querySelector("#email-address").value,
              phone: document.querySelector("#phone-number").value,
              linkedin: document.querySelector("#linkedin-box").textContent,
              resumeFileName: document.querySelector("#resume-file").files[0]?.name || "",
              coverLetterFileName: document.querySelector("#cover-letter-file").files[0]?.name || "",
            })
            """
        )
        browser.close()

    assert result["ok"] is True
    assert result["filledFieldCount"] == 5, json.dumps(result["fieldInventory"], indent=2)
    assert result["manualReviewRequired"] is False
    assert values == {
        "firstName": "Michael",
        "lastName": "Shi",
        "preferredFirstName": "",
        "email": "wenjian2@ualberta.ca",
        "phone": "",
        "linkedin": "https://linkedin.com/in/wjshi",
        "resumeFileName": "resume.pdf",
        "coverLetterFileName": "",
    }
    hidden_resume = [entry for entry in result["fieldInventory"] if entry["id"] == "resume-file"][0]
    assert hidden_resume["filled"] is True
    assert hidden_resume["valueSource"] == "resume_upload"
    cover_letter = [
        entry for entry in result["fieldInventory"] if entry["id"] == "cover-letter-file"
    ][0]
    assert cover_letter["filled"] is False
    assert cover_letter["skippedReason"] in {
        "not_resume_input",
        "resume_already_uploaded",
    }


def test_generic_fill_commits_greenhouse_style_custom_selects():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 fill fixture")

    fixture = REPO_ROOT / "executioner/fixtures/generic/greenhouse_custom_selects.html"
    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")
    fill_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/fill-v2.js")
    )
    rules_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/field-rules.js")
    )

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as error:
            pytest.skip(f"playwright chromium is unavailable: {error}")

        page = browser.new_page()
        page.goto(fixture.as_uri())
        _load_v2_scripts(page)
        page.add_script_tag(content=fill_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createGenericFillV2Function();
              return await fill({
                profile: {
                  fullName: "Michael Shi",
                  email: "wenjian2@ualberta.ca",
                  phone: "555-555-0100",
                  location: "Edmonton, AB",
                  linkedinUrl: "https://linkedin.com/in/wjshi",
                  githubUrl: "https://github.com/micsushi",
                  websiteUrl: "https://mshi.ca",
                  workAuthorized: true,
                  sponsorshipRequired: false,
                  willingToRelocate: true,
                  openToAnyLocation: true,
                  salaryFlexible: true,
                  coOpTermsCompleted: "0",
                  availableSummer2026: "yes",
                  availableInterviewWindow: "yes",
                  expectedGraduationYear: "2026",
                  previousEmployers: "",
                  notes: "",
                },
                settings: {
                  stripLongDash: true,
                  fillRequiredOnly: true,
                  allowGeneratedAnswers: true,
                  flagLowConfidenceAnswers: true,
                },
                activeApplyContext: {},
                defaultResume: {},
                fieldRules: GENERIC_FIELD_RULES,
              });
            }
            """
        )

        values = page.evaluate(
            """
            () => ({
              city: document.querySelector("#city-field").dataset.selected || "",
              legal: document.querySelector("#legal-field").dataset.selected || "",
              salary: document.querySelector("#salary-field").dataset.selected || "",
              coop: document.querySelector("#coop-field").dataset.selected || "",
              term: document.querySelector("#term-field").dataset.selected || "",
              interview: document.querySelector("#interview-field").dataset.selected || "",
              graduation: document.querySelector("#graduation-field").dataset.selected || "",
              previous: document.querySelector("#previous-field").dataset.selected || "",
              cityInput: document.querySelector("#city-combo").value,
            })
            """
        )
        browser.close()

    assert result["ok"] is True
    assert result["filledFieldCount"] == 8, json.dumps(result["fieldInventory"], indent=2)
    assert values == {
        "city": "Elsewhere in Canada",
        "legal": "Yes",
        "salary": "Yes",
        "coop": "0 terms completed, this will be my 1st term",
        "term": "Yes",
        "interview": "Yes",
        "graduation": "2026",
        "previous": "No",
        "cityInput": "Elsewhere in Canada",
    }
    city = [entry for entry in result["fieldInventory"] if entry["id"] == "city-combo"][0]
    assert city["valueSource"] == "profile:location"
    legal = [entry for entry in result["fieldInventory"] if entry["id"] == "legal-combo"][0]
    assert legal["valueSource"] == "profile:workAuthorized"


def test_profile_value_matching_prefers_specific_field_identity():
    if sync_playwright is None:
        pytest.skip("playwright is required for the injected utility fixture")

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
              const profile = {
                fullName: "Michael Shi",
                email: "wenjian2@ualberta.ca",
                phone: "555-555-0100",
                location: "Edmonton, AB",
                linkedinUrl: "https://linkedin.com/in/wjshi",
                githubUrl: "",
                websiteUrl: "",
              };
              const u = window.__huntApplyUtils;
              return {
                lastName: u.chooseProfileMatch("text last name * first name * legal name", profile),
                email: u.chooseProfileMatch("email email address * preferred first name", profile),
                phone: u.chooseProfileMatch("text phone number email address first name", profile),
                firstName: u.chooseProfileMatch("text first name * legal name", profile),
              };
            }
            """
        )
        browser.close()

    assert result["lastName"] == {"value": "Shi", "key": "profile:lastName"}
    assert result["email"] == {
        "value": "wenjian2@ualberta.ca",
        "key": "profile:email",
    }
    assert result["phone"] == {"value": "555-555-0100", "key": "profile:phone"}
    assert result["firstName"] == {"value": "Michael", "key": "profile:firstName"}


def test_location_text_fields_use_requested_location_shape():
    if sync_playwright is None:
        pytest.skip("playwright is required for the injected utility fixture")

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
              const profile = { location: "Edmonton, AB" };
              const u = window.__huntApplyUtils;
              return {
                combined: u.chooseProfileMatch("What City, Province are you located in?", profile),
                city: u.chooseProfileMatch("City", profile),
                province: u.chooseProfileMatch("Province or Territory", profile),
                location: u.chooseProfileMatch("Current location", profile),
              };
            }
            """
        )
        browser.close()

    assert result["combined"] == {"value": "Edmonton, AB", "key": "profile:location"}
    assert result["city"] == {"value": "Edmonton", "key": "profile:location"}
    assert result["province"] == {"value": "Alberta", "key": "profile:location"}
    assert result["location"] == {"value": "Edmonton, AB", "key": "profile:location"}


def test_phone_fields_do_not_receive_location_values():
    if sync_playwright is None:
        pytest.skip("playwright is required for the injected utility fixture")

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
              const profile = {
                phone: "7800000000",
                location: "Edmonton, AB, Canada",
              };
              const u = window.__huntApplyUtils;
              return {
                phone: u.chooseProfileMatch("Phone Number", profile),
                phoneWithTerritory: u.chooseProfileMatch(
                  "Phone Phone Device Type Mobile Country / Territory Phone Code 0 items selected Phone Number",
                  profile,
                ),
              };
            }
            """
        )
        browser.close()

    assert result["phone"] == {"value": "7800000000", "key": "profile:phone"}
    assert result["phoneWithTerritory"] == {
        "value": "7800000000",
        "key": "profile:phone",
    }


def test_location_dropdowns_rank_city_province_country_then_other():
    if sync_playwright is None:
        pytest.skip("playwright is required for the injected utility fixture")

    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")

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
                <div id="case-city" class="select__control">
                  <input id="combo-city" role="combobox" aria-autocomplete="list" />
                </div>
                <div id="case-province" class="select__control">
                  <input id="combo-province" role="combobox" aria-autocomplete="list" />
                </div>
                <div id="case-country" class="select__control">
                  <input id="combo-country" role="combobox" aria-autocomplete="list" />
                </div>
                <div id="case-other" class="select__control">
                  <input id="combo-other" role="combobox" aria-autocomplete="list" />
                </div>
                <script>
                  const optionSets = {
                    city: ["Canada", "Not in Edmonton", "Located in Edmonton, Alberta", "Other"],
                    province: ["Canada", "Not in Alberta", "Lives in Alberta", "Other"],
                    country: ["Vancouver, British Columbia", "Not in Canada", "Elsewhere in Canada", "Other"],
                    other: ["Elsewhere in USA", "Other"],
                  };
                  Object.entries(optionSets).forEach(([key, options]) => {
                    options.forEach((text) => {
                      const option = document.createElement("div");
                      option.setAttribute("role", "option");
                      option.dataset.case = key;
                      option.style.display = "none";
                      option.textContent = text;
                      option.addEventListener("click", () => {
                        document.querySelector(`#combo-${key}`).dataset.selected = text;
                      });
                      document.body.appendChild(option);
                    });
                  });
                </script>
              </body>
            </html>
            """
        )
        page.add_script_tag(content=injected_js)
        result = page.evaluate(
            """
            async () => {
              const profile = { location: "Edmonton, AB" };
              const u = window.__huntApplyUtils;
              const fill = async (id) => {
                document.querySelectorAll("[role=option]").forEach((option) => {
                  option.style.display = option.dataset.case === id ? "block" : "none";
                });
                const input = document.querySelector(`#combo-${id}`);
                await u.fillComboboxElement(
                  input,
                  "What City, Province are you located in?",
                  profile,
                  true,
                );
                return input.dataset.selected || "";
              };
              return {
                city: await fill("city"),
                province: await fill("province"),
                country: await fill("country"),
                other: await fill("other"),
              };
            }
            """
        )
        browser.close()

    assert result == {
        "city": "Located in Edmonton, Alberta",
        "province": "Lives in Alberta",
        "country": "Elsewhere in Canada",
        "other": "",
    }


def test_location_dropdown_searches_terms_before_giving_up():
    if sync_playwright is None:
        pytest.skip("playwright is required for the injected utility fixture")

    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")

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
                <div class="select__container">
                  <div class="select__control">
                    <input id="combo" role="combobox" aria-autocomplete="list" />
                  </div>
                  <div class="select__indicators">
                    <button type="button" aria-label="Toggle flyout"></button>
                  </div>
                </div>
                <div role="option" data-match="canada" style="display:none">Not in Canada</div>
                <div role="option" data-match="canada" style="display:none">Elsewhere in Canada</div>
                <script>
                  const input = document.querySelector("#combo");
                  const options = Array.from(document.querySelectorAll("[role=option]"));
                  input.addEventListener("input", () => {
                    options.forEach((option) => {
                      option.style.display = input.value.toLowerCase().includes(option.dataset.match)
                        ? "block"
                        : "none";
                    });
                  });
                  options.forEach((option) => {
                    option.addEventListener("click", () => {
                      input.dataset.selected = option.textContent.trim();
                    });
                  });
                </script>
              </body>
            </html>
            """
        )
        page.add_script_tag(content=injected_js)
        result = page.evaluate(
            """
            async () => {
              const input = document.querySelector("#combo");
              const fill = await window.__huntApplyUtils.fillComboboxElement(
                input,
                "What City, Province are you located in?",
                { location: "Edmonton, AB" },
                true,
              );
              return {
                fill,
                selected: input.dataset.selected || "",
                value: input.value,
              };
            }
            """
        )
        browser.close()

    assert result["fill"]["filled"] is True
    assert result["selected"] == "Elsewhere in Canada"


def test_combobox_fill_requires_visible_commit_before_reporting_filled():
    if sync_playwright is None:
        pytest.skip("playwright is required for the injected utility fixture")

    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")

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
                <div class="select__container">
                  <div class="select__control">
                    <input id="legal-combo" role="combobox" aria-autocomplete="list" />
                  </div>
                </div>
                <div id="react-select-other-option-0" role="option">Yes</div>
                <script>
                  document.querySelector("[role=option]").addEventListener("click", () => {
                    document.body.dataset.clicked = "stale";
                  });
                </script>
              </body>
            </html>
            """
        )
        page.add_script_tag(content=injected_js)
        result = page.evaluate(
            """
            async () => {
              const input = document.querySelector("#legal-combo");
              const fill = await window.__huntApplyUtils.fillComboboxElement(
                input,
                "Are you legally eligible to work in the location you are applying for?",
                { workAuthorized: true },
                true,
              );
              return {
                fill,
                clicked: document.body.dataset.clicked || "",
                value: input.value,
              };
            }
            """
        )
        browser.close()

    assert result["clicked"] == "stale"
    assert result["value"] == ""
    assert result["fill"] == {"filled": False, "reason": "no_matching_option"}


def test_combobox_fill_closes_menu_after_committed_selection():
    if sync_playwright is None:
        pytest.skip("playwright is required for the injected utility fixture")

    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")

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
                <div class="select__container open">
                  <div class="select__control">
                    <div class="select__single-value"></div>
                    <input id="legal-combo" role="combobox" aria-autocomplete="list" />
                  </div>
                  <div id="legal-listbox">
                    <div id="legal-combo-option-0" role="option">Yes</div>
                  </div>
                </div>
                <script>
                  const field = document.querySelector(".select__container");
                  const input = document.querySelector("#legal-combo");
                  const selected = document.querySelector(".select__single-value");
                  const option = document.querySelector("[role=option]");
                  const close = () => {
                    field.classList.remove("open");
                    option.style.display = "none";
                  };
                  input.addEventListener("keydown", (event) => {
                    if (event.key === "Escape") close();
                  });
                  option.addEventListener("click", () => {
                    selected.textContent = option.textContent.trim();
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                  });
                </script>
              </body>
            </html>
            """
        )
        page.add_script_tag(content=injected_js)
        result = page.evaluate(
            """
            async () => {
              const input = document.querySelector("#legal-combo");
              const fill = await window.__huntApplyUtils.fillComboboxElement(
                input,
                "Are you legally eligible to work in the location you are applying for?",
                { workAuthorized: true },
                true,
              );
              return {
                fill,
                open: document.querySelector(".select__container").classList.contains("open"),
                optionDisplay: window.getComputedStyle(document.querySelector("[role=option]")).display,
                selected: document.querySelector(".select__single-value").textContent.trim(),
              };
            }
            """
        )
        browser.close()

    assert result["fill"]["filled"] is True
    assert result["selected"] == "Yes"
    assert result["open"] is False
    assert result["optionDisplay"] == "none"


def test_combobox_fill_treats_search_text_commit_as_filled():
    if sync_playwright is None:
        pytest.skip("playwright is required for the injected utility fixture")

    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")

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
                <div class="select__container open">
                  <div class="select__control">
                    <div class="select__single-value"></div>
                    <input id="grad-combo" role="combobox" aria-autocomplete="list" />
                  </div>
                  <div id="grad-listbox">
                    <div id="grad-combo-option-0" role="option" style="display:none">2026</div>
                  </div>
                </div>
                <script>
                  const field = document.querySelector(".select__container");
                  const input = document.querySelector("#grad-combo");
                  const selected = document.querySelector(".select__single-value");
                  const option = document.querySelector("[role=option]");
                  const close = () => {
                    field.classList.remove("open");
                    option.style.display = "none";
                  };
                  input.addEventListener("input", () => {
                    option.style.display = input.value.includes("2026") ? "block" : "none";
                  });
                  input.addEventListener("keydown", (event) => {
                    if (event.key === "Escape") close();
                  });
                  document.body.addEventListener("mousedown", close);
                  option.addEventListener("click", () => {
                    selected.textContent = option.textContent.trim();
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                  });
                </script>
              </body>
            </html>
            """
        )
        page.add_script_tag(content=injected_js)
        result = page.evaluate(
            """
            async () => {
              const input = document.querySelector("#grad-combo");
              const fill = await window.__huntApplyUtils.fillComboboxElement(
                input,
                "When is your expected graduation date?",
                { expectedGraduationYear: "2026" },
                true,
              );
              return {
                fill,
                open: document.querySelector(".select__container").classList.contains("open"),
                optionDisplay: window.getComputedStyle(document.querySelector("[role=option]")).display,
                selected: document.querySelector(".select__single-value").textContent.trim(),
              };
            }
            """
        )
        browser.close()

    assert result["fill"]["filled"] is True
    assert result["selected"] == "2026"
    assert result["open"] is False
    assert result["optionDisplay"] == "none"


def test_combobox_fill_counts_already_committed_matching_value():
    if sync_playwright is None:
        pytest.skip("playwright is required for the injected utility fixture")

    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")

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
                <div class="select__container">
                  <div class="select__control">
                    <div class="select__single-value">Yes</div>
                    <input
                      id="interview-combo"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-expanded="false"
                    />
                  </div>
                </div>
              </body>
            </html>
            """
        )
        page.add_script_tag(content=injected_js)
        result = page.evaluate(
            """
            async () => {
              const input = document.querySelector("#interview-combo");
              return await window.__huntApplyUtils.fillComboboxElement(
                input,
                "Are you available to interview (45 minutes) from April 14-24?",
                { availableInterviewWindow: "yes" },
                true,
              );
            }
            """
        )
        browser.close()

    assert result == {"filled": True, "valueSource": "profile:availableInterviewWindow"}


def test_combobox_fill_ignores_stale_options_from_other_open_listboxes():
    if sync_playwright is None:
        pytest.skip("playwright is required for the injected utility fixture")

    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")

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
                <div id="stale-listbox">
                  <div id="stale-option-0" role="option">No</div>
                </div>
                <div class="select__container">
                  <div class="select__control">
                    <div class="select__single-value"></div>
                    <input
                      id="legal-combo"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-controls="legal-listbox"
                    />
                  </div>
                </div>
                <div id="legal-listbox">
                  <div id="legal-combo-option-0" role="option">Yes</div>
                </div>
                <script>
                  const selected = document.querySelector(".select__single-value");
                  document.querySelector("#stale-option-0").addEventListener("click", () => {
                    selected.textContent = "No";
                  });
                  document.querySelector("#legal-combo-option-0").addEventListener("click", () => {
                    selected.textContent = "Yes";
                  });
                </script>
              </body>
            </html>
            """
        )
        page.add_script_tag(content=injected_js)
        result = page.evaluate(
            """
            async () => {
              const input = document.querySelector("#legal-combo");
              const fill = await window.__huntApplyUtils.fillComboboxElement(
                input,
                "Are you legally eligible to work in the location you are applying for?",
                { workAuthorized: true },
                true,
              );
              return {
                fill,
                selected: document.querySelector(".select__single-value").textContent.trim(),
              };
            }
            """
        )
        browser.close()

    assert result["fill"]["filled"] is True
    assert result["selected"] == "Yes"


def test_candidate_options_ignore_stale_open_listboxes_for_closed_field():
    if sync_playwright is None:
        pytest.skip("playwright is required for the injected utility fixture")

    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")

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
                <div id="stale-listbox">
                  <div role="option">Yes</div>
                  <div role="option">No</div>
                </div>
                <div class="select__container">
                  <div class="select__control">
                    <input
                      id="privacy-combo"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-expanded="false"
                    />
                  </div>
                </div>
                <div class="select__container">
                  <div class="select__control">
                    <input
                      id="legal-combo"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-controls="legal-listbox"
                      aria-expanded="true"
                    />
                  </div>
                </div>
                <div id="legal-listbox">
                  <div role="option">Yes</div>
                  <div role="option">No</div>
                </div>
              </body>
            </html>
            """
        )
        page.add_script_tag(content=injected_js)
        result = page.evaluate(
            """
            () => {
              const u = window.__huntApplyUtils;
              return {
                privacy: u.getCandidateOptions(document.querySelector("#privacy-combo")),
                legal: u.getCandidateOptions(document.querySelector("#legal-combo")),
              };
            }
            """
        )
        browser.close()

    assert result["privacy"] == []
    assert result["legal"] == ["Yes", "No"]


def test_location_dropdown_does_not_search_other_after_location_terms_fail():
    if sync_playwright is None:
        pytest.skip("playwright is required for the injected utility fixture")

    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")

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
                <div class="select__container">
                  <div class="select__control">
                    <input id="city-combo" role="combobox" aria-autocomplete="list" />
                  </div>
                </div>
                <div role="option" style="display:none">Other</div>
                <script>
                  const input = document.querySelector("#city-combo");
                  const option = document.querySelector("[role=option]");
                  input.addEventListener("input", () => {
                    option.style.display = input.value.toLowerCase().includes("other")
                      ? "block"
                      : "none";
                  });
                  option.addEventListener("click", () => {
                    input.dataset.selected = "Other";
                  });
                </script>
              </body>
            </html>
            """
        )
        page.add_script_tag(content=injected_js)
        result = page.evaluate(
            """
            async () => {
              const input = document.querySelector("#city-combo");
              const fill = await window.__huntApplyUtils.fillComboboxElement(
                input,
                "What City, Province are you located in?",
                { location: "Edmonton, AB" },
                true,
              );
              return {
                fill,
                selected: input.dataset.selected || "",
                value: input.value,
              };
            }
            """
        )
        browser.close()

    assert result["fill"] == {"filled": False, "reason": "no_matching_option"}
    assert result["selected"] == ""
    assert result["value"] == ""
