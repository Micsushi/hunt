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
        page.add_script_tag(content=injected_js)
        page.add_script_tag(content=fill_js)

        result = page.evaluate(
            """
            async () => {
              const fill = createWorkdayFillFunction();
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
