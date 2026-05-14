# C3 Answer Camps Implementation Plan
> REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans.

Goal: Replace ad hoc yes/no dropdown logic with a deterministic answer-camp classifier that chooses the safest answer class before mapping to tenant-specific option labels.

Architecture: Add a small answer-camp layer in shared injected utilities. It classifies a normalized question descriptor into a camp such as positive eligibility, negative conflict, negative prior-affiliation, neutral non-disclosure, salary range, or manual-review. Existing Workday and generic fillers then ask this layer for a structured choice, and option scoring maps the camp to real visible options without force-setting fake text.

Tech Stack: JavaScript extension code, Workday injected adapter, pytest static/browser guards, existing `python ci.py c3`.

## Camp Model

Use explicit camps rather than direct text first:

- `positive_eligibility`: answers Yes for things the applicant needs or has, such as work authorization, eligibility to work in Canada, required clearance capability, consent/terms.
- `negative_conflict`: answers No for conflicts and disqualifiers, such as family member at company, prior employment at company, EY/Deloitte conflict, relatives currently employed.
- `negative_need`: answers No for needs the applicant does not have, such as sponsorship required, accommodation unless profile says otherwise.
- `profile_value`: answers from saved profile, such as salary range, language statement, citizen/permanent resident, SIN status.
- `non_disclosure`: answers prefer-not-to-disclose for voluntary demographic questions.
- `manual_review`: no safe deterministic answer.

## Task 1: Add Camp Classifier

Files: Modify `executioner/src/shared/injected.js`.

- [ ] Step 1: Write test in `tests/test_component3_generic_fill.py`.

```python
def test_answer_camps_classify_required_yes_and_conflict_no(page):
    html = "<html><body></body></html>"
    page.set_content(html)
    source = _module_to_browser_script((REPO_ROOT / "executioner" / "src" / "shared" / "injected.js").read_text(encoding="utf-8"))
    page.evaluate(source)
    result = page.evaluate(
        """
        () => {
          const u = window.__huntApplyUtils;
          const profile = {
            workAuthorized: true,
            sponsorshipRequired: false,
            canadianCitizenOrPermanentResident: "yes",
            familyMemberAtCompany: "",
            previousEmployers: "",
          };
          return {
            work: u.classifyAnswerCamp("Are you legally eligible to work in Canada?", profile),
            family: u.classifyAnswerCamp("Do you have a family member employed with Sun Life?", profile),
            previous: u.classifyAnswerCamp("Have you previously worked directly or indirectly for Sun Life?", profile),
            sponsor: u.classifyAnswerCamp("Will you now or in the future require sponsorship?", profile),
          };
        }
        """
    )
    assert result["work"]["camp"] == "positive_eligibility"
    assert result["family"]["camp"] == "negative_conflict"
    assert result["previous"]["camp"] == "negative_conflict"
    assert result["sponsor"]["camp"] == "negative_need"
```

- [ ] Step 2: Run test and expect fail.

```powershell
python -m pytest -q tests\test_component3_generic_fill.py -k answer_camps_classify
```

- [ ] Step 3: Add `u.classifyAnswerCamp(descriptor, profile)` with ordered rules.

```javascript
u.classifyAnswerCamp = function (descriptor, profile) {
  var lowered = u.normalizeText(descriptor).toLowerCase();
  if (lowered.includes("sponsor")) {
    return {
      camp: "negative_need",
      value: profile.sponsorshipRequired ? "Yes" : "No",
      source: "profile:sponsorshipRequired",
    };
  }
  if (
    lowered.includes("family member") ||
    lowered.includes("relative") ||
    lowered.includes("previously worked") ||
    lowered.includes("previously employed") ||
    lowered.includes("ernst & young") ||
    lowered.includes("deloitte")
  ) {
    return { camp: "negative_conflict", value: "No", source: "default:noConflict" };
  }
  if (
    lowered.includes("legally eligible") ||
    lowered.includes("authorized to work") ||
    lowered.includes("work authorization")
  ) {
    return {
      camp: "positive_eligibility",
      value: profile.workAuthorized ? "Yes" : "No",
      source: "profile:workAuthorized",
    };
  }
  return { camp: "manual_review", value: "", source: "" };
};
```

- [ ] Step 4: Run test and expect pass.

```powershell
python -m pytest -q tests\test_component3_generic_fill.py -k answer_camps_classify
```

- [ ] Step 5: Commit.

```powershell
git add executioner/src/shared/injected.js tests/test_component3_generic_fill.py
git commit -m "Add C3 answer camp classifier"
```

## Task 2: Route Structured Choices Through Camps

Files: Modify `executioner/src/shared/injected.js`.

- [ ] Step 1: Write test in `tests/test_component3_generic_fill.py`.

```python
def test_structured_choice_uses_answer_camps_for_option_text(page):
    page.set_content("<html><body></body></html>")
    source = _module_to_browser_script((REPO_ROOT / "executioner" / "src" / "shared" / "injected.js").read_text(encoding="utf-8"))
    page.evaluate(source)
    result = page.evaluate(
        """
        () => {
          const u = window.__huntApplyUtils;
          const profile = {
            workAuthorized: true,
            canadianCitizenOrPermanentResident: "yes",
            sponsorshipRequired: false,
          };
          const choice = u.chooseStructuredChoice("Are you legally eligible to work in Canada?", profile, true);
          return {
            text: choice.text,
            source: choice.source,
            citizenScore: u.optionScoreForChoice("Yes, I am a citizen or permanent resident of Canada", "", choice, true),
            permitScore: u.optionScoreForChoice("Yes, I possess a temporary work permit", "", choice, true),
          };
        }
        """
    )
    assert result["text"] == "Yes, I am a citizen or permanent resident of Canada"
    assert result["citizenScore"] > result["permitScore"]
```

- [ ] Step 2: Run test and expect fail if routing is not centralized.

```powershell
python -m pytest -q tests\test_component3_generic_fill.py -k structured_choice_uses_answer_camps
```

- [ ] Step 3: Refactor `chooseStructuredChoice()` to call `classifyAnswerCamp()` first for yes/no-like categories, then map camp to structured choice.

```javascript
var camp = u.classifyAnswerCamp(descriptor, profile);
if (camp.camp === "positive_eligibility" && lowered.includes("canada")) {
  return {
    text: "Yes, I am a citizen or permanent resident of Canada",
    source: "profile:canadianCitizenOrPermanentResident",
    aliases: [
      "Yes, I am a citizen or permanent resident of Canada",
      "citizen or permanent resident of Canada",
      "permanent resident of Canada",
      "Yes",
    ],
  };
}
if (camp.camp === "negative_conflict" || camp.camp === "negative_need") {
  return { text: camp.value || "No", source: camp.source, aliases: ["No"] };
}
```

- [ ] Step 4: Run focused tests and expect pass.

```powershell
python -m pytest -q tests\test_component3_generic_fill.py -k "answer_camps or structured_choice_uses_answer_camps"
```

- [ ] Step 5: Commit.

```powershell
git add executioner/src/shared/injected.js tests/test_component3_generic_fill.py
git commit -m "Route C3 choices through answer camps"
```

## Task 3: Add Workday Primary Questionnaire Fixture

Files: Create `executioner/fixtures/workday/primary_questionnaire_answer_camps.html`, modify `tests/test_component3_workday_fill.py`.

- [ ] Step 1: Add fixture with Workday-like primary questionnaire buttons and options.

```html
<!doctype html>
<html>
  <body>
    <div data-automation-id="formField">
      <div>Do you have a family member employed with Sun Life?*</div>
      <button id="primaryQuestionnaire--family" name="family" aria-haspopup="listbox" aria-label="Select One Required">Select One</button>
    </div>
    <ul role="listbox">
      <li role="option">Select One</li>
      <li role="option">Yes</li>
      <li role="option">No</li>
    </ul>
    <div data-automation-id="formField">
      <div>Are you legally eligible to work in Canada?*</div>
      <button id="primaryQuestionnaire--work" name="work" aria-haspopup="listbox" aria-label="Select One Required">Select One</button>
    </div>
    <ul role="listbox">
      <li role="option">Select One</li>
      <li role="option">Yes, I am a citizen or permanent resident of Canada</li>
      <li role="option">Yes, I possess a temporary work permit</li>
      <li role="option">No, I require sponsorship</li>
    </ul>
  </body>
</html>
```

- [ ] Step 2: Add a browser test that verifies descriptor enrichment sees prompt text.

```python
def test_workday_primary_questionnaire_descriptors_include_prompt_text(page):
    fixture = (REPO_ROOT / "executioner" / "fixtures" / "workday" / "primary_questionnaire_answer_camps.html").read_text(encoding="utf-8")
    page.set_content(fixture)
    shared = _module_to_browser_script((REPO_ROOT / "executioner" / "src" / "shared" / "injected.js").read_text(encoding="utf-8"))
    workday = _module_to_browser_script((REPO_ROOT / "executioner" / "src" / "ats" / "workday" / "fill.js").read_text(encoding="utf-8"))
    page.evaluate(shared)
    page.evaluate(workday)
    descriptors = page.evaluate(
        """
        async () => {
          const fill = createWorkdayFillFunction();
          const result = await fill({
            profile: { workAuthorized: true, canadianCitizenOrPermanentResident: "yes" },
            settings: { fillRequiredOnly: true },
            activeApplyContext: {},
            defaultResume: {}
          });
          return result.fieldInventory.map((entry) => entry.descriptor);
        }
        """
    )
    assert any("family member employed" in d for d in descriptors)
    assert any("legally eligible to work in canada" in d for d in descriptors)
```

- [ ] Step 3: Run test and expect fail before descriptor fix, pass after.

```powershell
python -m pytest -q tests\test_component3_workday_fill.py -k primary_questionnaire
```

- [ ] Step 4: Ensure `getDescriptor()` enriches both `primaryQuestionnaire--` and `secondaryQuestionnaire--` buttons with nearest form-field text.

```javascript
String(el.id || "").includes("primaryQuestionnaire--") ||
String(el.id || "").includes("secondaryQuestionnaire--")
```

- [ ] Step 5: Commit.

```powershell
git add executioner/src/ats/workday/fill.js executioner/fixtures/workday/primary_questionnaire_answer_camps.html tests/test_component3_workday_fill.py
git commit -m "Handle Workday questionnaire answer camps"
```

## Task 4: Add Profile-Safe Overrides

Files: Modify `executioner/src/shared/settings.js`, `executioner/src/shared/storage.js`, `executioner/src/options/options.html`, `executioner/src/options/options.js`, `scripts/c3_p_chrome_defaults.js`.

- [ ] Step 1: Add static test in `tests/test_component3_stage1.py`.

```python
def test_c3_answer_camp_profile_fields_exist(self):
    settings = (REPO_ROOT / "executioner" / "src" / "shared" / "settings.js").read_text(encoding="utf-8")
    storage = (REPO_ROOT / "executioner" / "src" / "shared" / "storage.js").read_text(encoding="utf-8")
    options = (REPO_ROOT / "executioner" / "src" / "options" / "options.js").read_text(encoding="utf-8")
    defaults = (REPO_ROOT / "scripts" / "c3_p_chrome_defaults.js").read_text(encoding="utf-8")
    for field in [
        "familyMemberAtCompany",
        "previousDeloitteErnstYoung",
        "reliabilityStatusClearance",
        "languageSkillStatement",
        "salaryExpectationRange",
    ]:
        assert field in settings
        assert field in storage
        assert field in options
        assert field in defaults
```

- [ ] Step 2: Run test and expect fail.

```powershell
python -m pytest -q tests\test_component3_stage1.py -k answer_camp_profile_fields
```

- [ ] Step 3: Add fields and option controls:

```javascript
familyMemberAtCompany: "",
previousDeloitteErnstYoung: "",
reliabilityStatusClearance: "Yes, I meet the requirements to obtain Reliability Status Clearance.",
languageSkillStatement: "English only",
salaryExpectationRange: "90,000 - 105,000",
```

- [ ] Step 4: Run test and C3 CI.

```powershell
python -m pytest -q tests\test_component3_stage1.py -k answer_camp_profile_fields
python ci.py c3
```

- [ ] Step 5: Commit.

```powershell
git add executioner/src/shared/settings.js executioner/src/shared/storage.js executioner/src/options/options.html executioner/src/options/options.js scripts/c3_p_chrome_defaults.js tests/test_component3_stage1.py
git commit -m "Add C3 answer camp profile defaults"
```

## Task 5: Live Retest

Files: No code files unless retest exposes a gap. Update vault after run.

- [ ] Step 1: Reload C3 extension in p chrome.

```powershell
node scripts\configure_c3_debug_sink.js --seed-workday-profile
```

- [ ] Step 2: Navigate/stage Sun Life Application Questions 1 of 2.

```powershell
node scripts\c3_workday_live_smoke.js --preserve-current --target-step "Application Questions 1 of 2" --require-target --stop-at-target --max-pages 3
```

- [ ] Step 3: Fill only current page.

```powershell
node scripts\c3_workday_live_smoke.js --preserve-current --target-step "Application Questions 1 of 2" --require-target --stop-after-fill --max-pages 1
```

- [ ] Step 4: Inspect result.

Expected:
- family member: No
- Canada eligibility: citizen/permanent resident or configured profile option
- Reliability Status: configured clearance answer
- EY/Deloitte: No
- language skills: configured profile language statement
- salary: configured profile salary range
- no `required_field_unresolved:no_known_choice`
- no `required_field_unresolved:no_matching_option`

- [ ] Step 5: Commit vault update only if no code changes, or code plus vault if fixes are needed.

```powershell
git add docs/superpowers/plans/2026-05-13-c3-answer-camps.md
git commit -m "Plan C3 answer camps"
```

## Execution Handoff

1. Subagent-Driven: Use `superpowers:subagent-driven-development` to split classifier, profile UI/storage, and Workday fixture tests.
2. Inline Execution: Use `superpowers:executing-plans` and do the tasks sequentially in this workspace.
