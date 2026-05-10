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
                  previousEmployers: "University of Alberta",
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
                  previousEmployers: "University of Alberta",
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
                  previousEmployers: "University of Alberta",
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
