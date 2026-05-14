# C3 Workday Widget Hardening Plan

> REQUIRED SUB-SKILL: Use systematic-debugging during implementation. Use executing-plans or subagent-driven-development only if this is split across workers.

## Goal

Make Workday page walks robust enough to continue through every required page, even when a value is a default or later-correctness issue. The user-facing behavior should be:

- Required fields get a committed page value whenever there is any safe default.
- Questionable defaults are logged and notified, not allowed to silently disappear.
- JSON audit records every page, retry, field, value attempted, value committed, option list, fallback, warning, and visible validation error.
- Extension-side proof must stand without CDP-only repairs. The p chrome/CDP harness can remain as a diagnostic path, but it cannot be counted as shipped extension proof.

## Evidence From Current Runs

### 1. Phone country code: dedicated handler still fails extension-only commit

Evidence:

- `logs/c3_workday_audit_2026-05-14T08-49-07-122Z.json`: SNDL page 1 stayed on `My Information` with `manualReviewReasons: required_field_unresolved:phone_country_code_commit_failed`.
- The same audit shows normal phone text was filled as `(780) 492-3111`, device type was `Mobile`, and Workday buttons had `Canada`, `Alberta`, and `Mobile`, but `phoneNumber--countryPhoneCode` remained unfilled.
- `executioner/src/ats/workday/fill.js` has a dedicated `fillPhoneCountryCode` path at `fill.js:3015` through `fill.js:3414`. It searches for Canada, clicks the visible option, tries React handler invocation, then verifies committed selected text.
- `scripts/c3_workday_live_smoke.js` has a separate CDP repair at `c3_workday_live_smoke.js:1369` through `c3_workday_live_smoke.js:1605`. That repair can click and type like a real browser, which means a p chrome pass can hide an extension-only failure.

Root cause hypothesis:

- Workday's country-phone widget is an editable combobox/multiselect. Setting input text and synthetic-clicking the visible option is not always enough to update Workday's controlled state.
- The current extension tries to call React internals after clicking the option. That is brittle because the content script lives outside the page's normal app execution model and Workday may re-render or virtualize options between the click and verification.
- The current verifier is correct to reject visual-ish state unless the committed `Canada (+1)` selection is discoverable, but the interaction path still needs to look more like real keyboard/pointer input.

External sources:

- React documents controlled inputs/selects as values backed by `onChange` state. If the backing value is not updated, React can keep or revert its own value.
- WAI-ARIA combobox guidance treats typing, Down Arrow, and Enter as the standard path for editable combobox/listbox selection.
- Playwright notes that character-by-character typing is needed on pages with special keyboard handling because it emits the full keyboard event sequence.
- Chrome extension content scripts run in isolated worlds while sharing DOM access, which is exactly why "DOM changed" and "page app accepted state" are separate concerns.

Fix plan:

1. Build a Workday widget driver for `selectinput`, `multiselect`, and button-listbox controls instead of one-off paths.
2. For phone country code, use this ordered commit sequence:
   - Identify exact field by id/name/ARIA first: `phoneNumber--countryPhoneCode`, `countryPhoneCode`, `Country Phone Code`.
   - Clear any existing selected item if it is not `Canada (+1)`.
   - Focus the input.
   - Dispatch trusted-looking keyboard sequence as far as extension APIs allow: `Control+A`, `Backspace`, printable `Canada`, wait for option list.
   - Prefer exact option text containing both `Canada` and `+1`; reject every other `+1` country.
   - Commit by focused-option Enter first, then option mousedown/pointerdown/mouseup/click fallback.
   - Blur/focusout and wait for Workday to close the listbox.
   - Verify by selected pill/selected item/aria-checked/aria-selected/container text, not by input text alone.
3. In p chrome, keep CDP repair only as `diagnosticRepair`, and log whether extension-only failed before CDP fixed it.
4. Add a hard audit flag when CDP was required: `extensionCommit: false`, `cdpRepairUsed: true`.

Tests:

- Add a browser fixture in `tests/test_component3_workday_fill.py` that simulates a Workday phone-country combobox where input text alone does not commit. It should pass only when the driver selects a real option and the page state changes.
- Add a static guard in `tests/test_component3_prompt.py` for `cdpRepairUsed` and extension-only phone commit trace names.
- Add a JSON-audit fixture asserting phone country logs include `intendedValue`, `options`, `attempts`, `committedValue`, and `verified`.

### 2. Source and other Workday search widgets: option selection can look filled but remain invalid

Evidence:

- C3 status notes AMA My Information still had a stubborn Source prompt: extension scored the right option but got `commit_not_verified`; the CDP keyboard path advanced the page and selected `AMA Careers`.
- Sun Life source lessons show force-setting raw URL tokens like `LINKEDIN_GLOBAL` or visible `LinkedIn` can leave Workday invalid when the tenant expects a real listbox option like `Job Board`.
- Public GitHub Workday scripts mostly hard-code tenant selectors and use click/type/Enter. That confirms this class of widget needs real option commit, not just value injection.

Root cause hypothesis:

- Workday widgets have tenant-specific option labels and stable ids that matter more than our normalized intended label.
- Descriptor text can be contaminated by neighboring fields. For example, phone device type descriptors include "Country Phone Code" because they share the phone group.
- Our generic `fillWorkdaySearchInputChoice` and button dropdown code has several paths: keyboard, pointer, force-commit, best-effort. These paths do not yet share one verification contract.

Fix plan:

1. Centralize option collection:
   - Search visible `[role="option"]`, `data-automation-id="promptOption"`, `promptLeafNode`, and checked/selected markers.
   - Save normalized text, raw text, DOM id, aria state, bounding rect, and owning field id.
2. Centralize scoring:
   - First exact tenant option aliases from profile/app context.
   - Then field-specific aliases such as Source: `LinkedIn Corporate Page`, `Job Board`, `AMA Careers`, `Industry Job Board`.
   - Then safe default pass-through.
3. Centralize verification:
   - Button text changed to selected option.
   - Input/multiselect has selected pill/item.
   - Option has aria-selected/aria-checked where exposed.
   - Visible validation errors for that field are gone after Save/Continue attempt or immediate validation settle.
4. Remove normal reliance on `forceSetWorkdayButtonChoice` for Workday listboxes. Keep it as a diagnostic trace only when real commit fails.

Tests:

- Fixture: Source selectinput with options `AMA Careers`, `LinkedIn Corporate Page`, `Job Board`; assert real selected option is used, not input text.
- Fixture: wrong raw source token `LINKEDIN_GLOBAL`; assert it maps to a real tenant option and logs alias source.
- Fixture: descriptor contamination from phone group; assert phone device type does not get classified as phone country code.

### 3. Best-effort pass-through works, but correctness and L-check replacement need stronger contracts

Evidence:

- `executioner/src/ats/workday/fill.js:2480` through `fill.js:2535` chooses a best-effort Workday button default when no structured choice exists.
- `executioner/src/ats/workday/fill.js:2638` through `fill.js:2689` chooses a best-effort default when the intended choice has no matching option.
- `executioner/src/shared/injected.js:1810` through `injected.js:1890` does the same for native selects.
- `executioner/src/background/fill-runner.js:148` through `fill-runner.js:168` now includes required fields that were filled with `bestEffortWarning` in the answer-router/L-check inventory.
- NAIT audit reached Review but used defaults: basic requirements `Yes`, highest education `None`, related experience `0-1 years`.
- SNDL audit reached Review but used defaults: legal age/cannabis-liquor `Yes`, background check `No`, driver-license/transport `Yes`, plus salary text `90,000 - 105,000`.

Root cause hypothesis:

- Pass-through is doing the right product thing: continue to Review and flag questionable answers.
- Correctness is underfit because answer camps and profile-derived values are not yet broad enough.
- The L-check fallback is structurally wired, but it needs better evidence in the audit and tests proving it replaced a default when provider output is available.

Fix plan:

1. Implement the answer-camps plan as the canonical classifier:
   - `positive_eligibility`: legal age, work authorization, background-check willingness, can meet basic requirements.
   - `negative_conflict`: family employed at company, prior restricted employer, conflict of interest, sponsorship need.
   - `profile_value`: education level, related years, language, salary, location, driver license, reliable transportation.
   - `non_disclosure`: voluntary demographic/disability/veteran questions unless saved profile says otherwise.
   - `manual_review`: ambiguous or legal claims not covered by profile/default policy.
2. Under the current assumption that the user is eligible and a prime candidate:
   - Background/security check willingness should default to affirmative when phrased as willingness or ability.
   - Highest education should come from saved education profile, not `None`.
   - Related years should derive from resume/profile experience, with a conservative nonzero default when profile data exists.
3. L-check replacement:
   - Preserve best-effort selected value.
   - Send question, options, field id, selected default, and warning to answer-router.
   - If answer-router returns an exact option, replace and log `llmReplacement`.
   - If it returns no exact option or provider unavailable, keep default and log `llmReplacement: unavailable` or `rejected`.

Tests:

- Unit tests in `tests/test_component3_answer_router.py` for the above camps.
- Workday fixture tests for NAIT education/experience and SNDL background/legal-age/transport.
- Audit-shape test: a best-effort field has both `bestEffortWarning` and `answerRouterAttempt`.

### 4. Audit JSON is close, but needs retry-level attempt objects and review comparison

Evidence:

- Current audit JSON includes `pages[]`, field inventory, filled fields, values, generated answers, after-errors, remaining values, and best-effort warnings.
- User asked for page/retry objects in JSON, with every value and what C3 put.
- Current SNDL page 1 audit exposed stale middle-name overfill: `profile:fullName` wrote `Michael Shi` into middle name. Code now maps middle name only from `profile.middleName`, but full-start proof after that patch is still needed.
- Review pages can reveal correctness bugs that field fill did not classify as blockers.

Fix plan:

1. Add per-field attempt objects:
   - `attemptIndex`
   - `method`: profile, structuredChoice, answerRouter, bestEffortDefault, generatedText, cdpRepair
   - `intendedValue`
   - `optionsSeen`
   - `selectedOption`
   - `valueBefore`
   - `valueAfter`
   - `commitVerified`
   - `warning`
   - `visibleErrorsAfter`
2. Add page retry wrapper:
   - `pageIndex`, `retryIndex`, `refillIndex`
   - `stepBefore`, `stepAfter`
   - `fillResult`
   - `repairs`
   - `nextAction`
3. Add Review scraper comparison:
   - Scrape final Review labels/values into `reviewValues`.
   - Compare against audit selected values where labels can be matched.
   - Flag mismatches such as middle name, source, phone, education, salary.
4. Keep raw logs local but summarize durable lessons in vault.

Tests:

- JSON schema snapshot for one page with retries.
- Fixture where review value differs from field audit value: assert `reviewMismatches` is populated.

## Implementation Order

1. Add failing fixtures first:
   - Phone country controlled-combobox commit.
   - Source selectinput real option commit.
   - Best-effort plus answer-router replacement audit.
   - Review mismatch scraper.
2. Implement shared Workday widget driver inside `executioner/src/ats/workday/fill.js` first to minimize module churn. Extract later only if the code becomes too hard to navigate.
3. Route phone country, Source, citizenship country, and generic search inputs through the same driver.
4. Implement answer-camp classifier replacement for the known NAIT/SNDL/Sun Life/BDO/AMA question classes.
5. Expand JSON audit with attempt objects and review comparison.
6. Retest in this order:
   - Static/syntax: `node --check executioner/src/ats/workday/fill.js`, `node --check executioner/src/shared/injected.js`, `node --check scripts/c3_workday_live_smoke.js`.
   - Focused tests: `python -m pytest -q tests/test_component3_workday_fill.py tests/test_component3_answer_router.py tests/test_component3_prompt.py -k "workday or answer_router or phone"`.
   - C3 suite: `python ci.py c3` unless blocked by existing dirty formatting warnings.
   - Live p chrome extension-only: NAIT, SNDL, AMA, Sun Life, BDO. Do not count a pass that required `--cdp-repair-phone-country` as extension proof.

## Acceptance Criteria

- Every Workday page can move forward with either high-confidence values or logged best-effort defaults.
- `phoneNumber--countryPhoneCode` commits `Canada (+1)` extension-side on a fresh My Information page.
- Source/citizenship/search widgets commit real Workday options, not just visible input text.
- Best-effort defaults never block page progress, but always produce user notification and JSON audit entries.
- L-check/answer-router tries to replace best-effort defaults and logs the result.
- Review page audit flags fields that reached Review but look wrong.
- Final live run reaches Review with Submit visible and no final Submit click for NAIT and SNDL from a fresh page 1 rerun.

## Online Sources Checked

- React input docs: https://react.dev/reference/react-dom/components/input
- React select docs: https://react.dev/reference/react-dom/components/select
- WAI-ARIA combobox pattern: https://www.w3.org/WAI/ARIA/apg/patterns/combobox/
- Playwright input actions: https://playwright.dev/docs/input
- Chrome extension content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- GitHub Autofill-Jobs: https://github.com/andrewmillercode/Autofill-Jobs
- GitHub Workday Selenium script: https://github.com/raghuboosetty/workday
- GitHub Workday Application Automator: https://github.com/ubangura/Workday-Application-Automator
