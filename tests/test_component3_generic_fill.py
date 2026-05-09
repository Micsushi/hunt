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
