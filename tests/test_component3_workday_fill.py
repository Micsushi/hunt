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


def test_workday_required_only_skips_optional_generated_textareas():
    if sync_playwright is None:
        pytest.skip("playwright is required for the Workday C3 fill fixture")

    injected_js = _load_script(REPO_ROOT / "executioner/src/shared/injected.js")
    fill_js = _module_to_browser_script(
        _load_script(REPO_ROOT / "executioner/src/ats/workday/fill.js")
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
        page.add_script_tag(content=injected_js)
        page.add_script_tag(content=fill_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillFunction();
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
    assert result["filledFieldCount"] == 1, json.dumps(result["fieldInventory"], indent=2)
    assert values["salary"] == (
        "I am flexible and open to discussing compensation based on the role and overall package."
    )
    assert values["priorCompany"] == ""
    assert values["referredHow"] == ""
    assert values["conditionalRequired"] == ""
    assert inventory["salary-range"]["required"] is True
    assert inventory["salary-range"]["filled"] is True
    assert inventory["prior-company"]["required"] is False
    assert inventory["prior-company"]["skippedReason"] == "not_required"
    assert inventory["referred-how"]["required"] is False
    assert inventory["referred-how"]["skippedReason"] == "not_required"
    assert inventory["conditional-required"]["required"] is True
    assert inventory["conditional-required"]["skippedReason"] == "unsafe_generated_answer_context"
