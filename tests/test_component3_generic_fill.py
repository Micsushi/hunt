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


def test_generic_fill_populates_required_fields_only():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 fill fixture")

    fixture = REPO_ROOT / "executioner/fixtures/generic/basic_required.html"
    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")
    fill_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/fill.js")
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
        page.add_script_tag(content=injected_js)
        page.add_script_tag(content=rules_js)
        page.add_script_tag(content=fill_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createGenericFillFunction();
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
    email_inventory = [
        entry for entry in result["fieldInventory"] if entry["id"] == "email"
    ][0]
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


def test_generic_fill_can_fill_optional_known_fields_when_required_only_is_off():
    if sync_playwright is None:
        pytest.skip("playwright is required for the generic C3 fill fixture")

    fixture = REPO_ROOT / "executioner/fixtures/generic/basic_required.html"
    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")
    fill_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/generic/fill.js")
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
        page.add_script_tag(content=injected_js)
        page.add_script_tag(content=rules_js)
        page.add_script_tag(content=fill_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createGenericFillFunction();
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
        preferred_name = page.evaluate(
            """() => document.querySelector("#preferred-name").value"""
        )
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
        _load_script(REPO_ROOT / "executioner/src/ats/generic/fill.js")
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
        page.add_script_tag(content=injected_js)
        page.add_script_tag(content=rules_js)
        page.add_script_tag(content=fill_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createGenericFillFunction();
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
    hidden_resume = [
        entry for entry in result["fieldInventory"] if entry["id"] == "resume-file"
    ][0]
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
        _load_script(REPO_ROOT / "executioner/src/ats/generic/fill.js")
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
        page.add_script_tag(content=injected_js)
        page.add_script_tag(content=rules_js)
        page.add_script_tag(content=fill_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createGenericFillFunction();
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
    city = [entry for entry in result["fieldInventory"] if entry["id"] == "city-combo"][
        0
    ]
    assert city["valueSource"] == "profile:location"
    legal = [entry for entry in result["fieldInventory"] if entry["id"] == "legal-combo"][
        0
    ]
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
