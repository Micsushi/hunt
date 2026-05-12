# C3 Autofill Process And Current Status

Updated: 2026-05-12

This document explains what C3 does during autofill, which tools it uses at
each step, what is verified, and what is still risky. It is written for a human
operator or developer working on the Hunt extension.

## What C3 Is

C3 is the browser executioner for Hunt. It fills application pages in Chrome,
uses saved profile and resume data, detects supported ATSs, logs what happened,
asks before using LLM help, and stops before final submit.

The safety model is simple:

- Fill known fields first.
- Ask before using LLM help.
- Leave unknown or sensitive fields for review.
- Never click final submit.

## 2026-05-12 Workday Clear And Fill Fixes

Live Workday testing found three related issues:

- `Clear Current Page` did not clear Workday button dropdowns such as source,
  country, province, and phone device type.
- Workday phone country code could reappear after clear because the page
  auto-populated it after the first clear pass.
- Fill could look frozen because post-fill page messages, Safe Next probing, or
  fill execution could wait too long on Workday.

Fixes now in this batch:

- Clear handles Workday `button[aria-haspopup="listbox"]` controls, including
  disabled placeholder cases.
- Clear handles Workday selected pills by focusing the selected item and sending
  Delete/Backspace.
- Clear does stabilization passes so late Workday dependent values are cleared
  before the result is counted.
- Fill Current Page has bounded in-page progress/toast, Safe Next probe, auto
  log export, and fill-run timeouts so the popup does not look stuck forever.
- The shared input setter now simulates character-by-character typed input for
  native inputs/textareas so Workday validation sees committed text values.
- The live smoke seeder now writes profile/resume context after the Options page
  settles, avoiding fresh-profile test races.

Verification:

- `python ci.py c3`: passed with 23 passed and 19 skipped.
- Live controlled Chrome page-1 verify-clear smoke: clear returned no Workday
  buttons, no selected pills, and no native values; refill restored source,
  country, province, phone type, name, city, email, and phone.
- Normal live Workday smoke now gets past My Information into later steps when
  the page is hydrated before fill. A timing-only smoke that fills too early can
  still hit Workday validation errors, so live operators should wait for the
  page fields to finish rendering before clicking Fill Current Page.

Still open:

- My Experience live fill still needs a fresh live retest after broadening the
  Add-button finder to include focusable Workday controls. The synthetic and
  static guards pass, but the latest full live run did not conclusively verify
  work and education insertion.

## 2026-05-12 Step Prompt Refresh

C3 now watches same-page application navigation. When a Workday or other ATS
step changes without a full reload, the content script re-runs fillable-page
detection after the DOM settles and shows the Hunt fill prompt again for the new
step. It keys prompts by URL, current step text, page kind, and visible form
control count, so dismissing a prompt suppresses only that exact step.

Popup actions now also dismiss existing in-page Hunt prompts/toasts before
running Fill Current Page or Clear Current Page. Fill then shows the in-page
spinner as before.

Verification:

- `python ci.py c3`: passed with 23 passed and 19 skipped.

## 2026-05-12 Test Browser Placement

The C3 test Chrome launcher now tries to open on a non-primary monitor by
default, so local browser smokes do not cover the main working monitor when a
secondary display is available.

Controls:

- `HUNT_C3_CHROME_WINDOW_POSITION`: optional `x,y` override.
- `HUNT_C3_CHROME_WINDOW_SIZE`: optional `width,height` override. Default is
  `1400,1000`.

Verification:

- `scripts\launch_c3_chrome.ps1` parses successfully as PowerShell.

## Code Structure

The background autofill runner is organized as a step pipeline in
`executioner\src\background\fill-runner.js`. Each handoff has its own class:

- `ResolveActiveTabStep`: find the tab and URL.
- `DetectAtsStep`: detect the ATS from the page and frames.
- `SelectFillRouteStep`: choose standalone, DB, or C4 fill route.
- `ResolveFillAdapterStep`: pick the generic or ATS-specific adapter.
- `InjectSharedUtilitiesStep`: inject shared page utilities.
- `RunAdapterFillStep`: run the selected filler in every frame.
- `PrepareLlmHelpStep`: count remaining answerable fields and stage LLM help.
- `PersistFillAttemptStep`: write attempt and generated-answer records.
- `BuildFillResponseStep`: return the popup/background response.

This is meant to keep the autofill process easy to trace from one step to the
next without hiding browser behavior inside one large function.

## Step 1: Start A Browser With The Extension

What happens:

- C3 runs as a Chrome extension from the `executioner` folder.
- For repeatable local testing, the project has a dedicated browser launcher.
- The launcher starts Playwright Chromium, loads the unpacked Hunt extension,
  and opens a DevTools endpoint on `http://127.0.0.1:9222`.

Tools used:

- `scripts\launch_c3_chrome.ps1`
- Playwright Chromium
- Chrome DevTools Protocol endpoint
- Chrome extension APIs

Status:

- Verified with a local Greenhouse-like fixture.
- Regular Chrome can expose the debug endpoint while ignoring
  `--load-extension`, so the launcher prefers Playwright Chromium.
- The normal logged-in Chrome attachment path is configured separately but is
  not fully verified yet.

## Step 2: Detect Whether The Page Looks Fillable

What happens:

- The content script reads the page title, visible text, visible inputs, and
  field attributes.
- It checks whether the page looks like an ATS page, signup page, or application
  page.
- If the page looks fillable and prompting is enabled, it shows a Hunt prompt on
  the page.

Tools used:

- `executioner\src\content\bootstrap.js`
- DOM text and input scanning
- Hostname checks
- Embedded ATS selectors such as `#grnhse_app`

Status:

- Verified on local fixtures.
- Broad prompt detection may still be noisy on some ordinary sites.

## Step 3: Detect ATS And Embedded Frames

What happens:

- The background script scans the active tab and all same-tab frames.
- It collects frame URLs and embedded ATS signals.
- It detects pages like Hootsuite where the outer page is a company careers
  page but the form is inside a Greenhouse iframe.

Tools used:

- `chrome.scripting.executeScript({ allFrames: true })`
- `executioner\src\ats\registry.js`
- `executioner\src\ats\support-matrix.js`
- Frame URL and iframe selector scanning

Status:

- Hootsuite-style embedded Greenhouse detection exists.
- Direct Greenhouse, Workday, Lever, Ashby, Workable, and SmartRecruiters are
  detected.
- iCIMS, Taleo, ADP, UKG, Jobvite, BambooHR, Breezy, JazzHR, Recruitee, and
  Pinpoint are detection-only for now.

## Step 4: Choose The Fill Route

What happens:

- C3 decides whether the run is standalone, DB-backed, or C4-backed.
- It then chooses a generic filler or an ATS-specific route.

Route names:

- `filler`: standalone generic fill
- `ats_filler`: standalone ATS route
- `db_filler`: DB context plus generic fill
- `db_ats_filler`: DB context plus ATS route
- `c4_filler`: C4 request plus generic fill
- `c4_ats_filler`: C4 request plus ATS route

Tools used:

- `executioner\src\background\fill-routes.js`
- Extension state
- Active apply context
- Detected ATS type
- Available adapter list

Status:

- Route selection is covered by tests.
- C4 end-to-end browser execution is still not live-proven.

## Step 5: Read The Site Into A Field Inventory

What happens:

- C3 scans inputs, textareas, native selects, contenteditable textboxes, file
  inputs, and radio groups.
- For each field it builds a field inventory entry.
- The inventory records what the field appears to be, whether it is required,
  what options exist, whether it was filled, why it was skipped, and where the
  answer came from.

Tools used:

- `executioner\src\ats\generic\fill.js`
- `executioner\src\shared\injected.js`
- Label, placeholder, name, id, autocomplete, ARIA, wrapper text, nearby text,
  and option extraction

Status:

- Works for common forms and Greenhouse-like fixtures.
- Dynamic forms that reveal new required fields after earlier answers need a
  stronger observe/fill/observe loop.

## Step 6: Decide Which Answer To Use

What happens:

- C3 first uses deterministic rules.
- It maps fields to saved profile facts, job context, or the default resume.
- It fills obvious fields such as name, email, phone, location, links, resume,
  work authorization, sponsorship, relocation, co-op terms, graduation year, and
  availability.

Tools used:

- Extension profile storage
- Default resume storage
- Active apply context
- Generic field rules
- ATS-specific adapter logic where available

Status:

- Good for common identity, contact, resume, and logistics fields.
- Novel custom questions still need manual review or LLM help.

## Step 7: Fill Normal Fields

What happens:

- Text fields are filled with native browser setters so React-style pages notice
  the value change.
- Native selects choose matching options.
- Radio groups choose known safe answers.
- Optional fields are skipped by default when required-only mode is enabled.

Tools used:

- Native value and checked setters
- `input`, `change`, and blur events
- Deterministic field matching

Status:

- Verified by C3 tests and local fixtures.
- Unknown fields are intentionally skipped instead of guessed.

## Step 8: Fill Custom Dropdowns

What happens:

- C3 handles React Select-style comboboxes by opening the dropdown, finding the
  best matching visible option, and selecting it.
- C3 handles Workday `button[aria-haspopup="listbox"]` dropdowns by opening the
  button listbox, selecting a scored option, polling until the committed button
  text changes, and closing the menu.
- If Workday already filled a dropdown with the correct value, C3 leaves it
  alone. If the existing value is wrong, C3 clears the old selection before
  selecting the profile-matched value.
- On Workday manual applications, C3 primes the Country dropdown first because
  Workday reveals the rest of the information form only after Country is
  selected.
- It uses human-like pointer and keyboard events.
- It verifies the committed selected value, not just the typed search text.
- It closes menus after selection.

Tools used:

- Pointer events: `pointerdown`, `pointerup`
- Mouse events: `mouseover`, `mousemove`, `mousedown`, `mouseup`, `click`
- Keyboard fallback: `Enter`, `Escape`
- Selected value verification through selected chips, selected option state,
  dataset values, and input state

Status:

- Improved for Hootsuite/Greenhouse-style dropdowns.
- Improved for Workday button dropdowns, including Source, Country, Province or
  Territory, Phone Device Type, legal-work questions, and required agreement
  checkboxes.
- Improved for Workday phone country code: C3 preserves an existing
  `Canada (+1)` value and only clears/reselects when the selected country code
  is wrong. The check reads Workday's multiselect container and selected pill
  text, not only the visible search input.
- Workday interaction traces now record component-level `hover`, `click`,
  `set_value`, `already_filled`, and phone-country-code `inspect` entries so a
  developer can see whether C3 touched a control or skipped it because it was
  already correct.
- Live Hootsuite retest passed on the real Greenhouse iframe. C3 selected the
  exact co-op option `2 terms completed, this will be my 3rd term`, kept all
  deterministic dropdowns closed, and left zero visible listboxes or
  `menu-is-open` controls after fill.

## Step 9: Attach Resume

What happens:

- C3 stores a default resume PDF in extension storage.
- When it finds a resume/CV file input, it tries to attach the PDF.
- It can handle some hidden file inputs behind attach-style controls.

Tools used:

- Extension storage
- `DataTransfer`
- File input events

Status:

- Works in supported fixture paths.
- Live Workday testing confirmed both `Autofill with Resume` and
  `Apply Manually` attach `main.pdf` before Review.
- Needs broader ATS coverage because file-upload widgets vary a lot.

## Step 10: Verify The Fill

What happens:

- C3 chooses the best frame result, usually the frame with the most filled fields
  and useful inventory.
- It records filled counts, manual review reasons, skipped reasons, and
  remaining required fields.
- It avoids treating typed dropdown search text as proof that an option was
  selected.

Tools used:

- Field inventory
- Frame result scoring
- Committed-value checks
- Activity log and attempt history

Status:

- Verification is much stronger than before.
- Live Hootsuite retest confirmed text fields stayed committed after fill:
  first name, last name, email, and LinkedIn were present in the real iframe DOM.
- Live Workday testing now drives every `Next` page until Review and stops
  before Submit.

## Step 11: Ask For LLM Help

What happens:

- If deterministic fill leaves required fixed-choice questions, C3 can offer LLM
  help.
- The operator must approve before LLM help runs.
- The backend receives the question text, options, profile context, job context,
  and ATS info.
- C3 only reduces the remaining count after the browser verifies a committed
  answer.

Tools used:

- Backend answer-decision endpoint
- Popup and in-page confirmation
- Field inventory question hashes
- Browser-side decision application and verification

Status:

- Implemented for unresolved required fixed-choice fields.
- Generated paragraph answers and medium-confidence policy still need more
  product hardening.

## Step 12: Log And Measure

What happens:

- C3 logs activity, fill attempts, field inventory, pending LLM fields, answer
  diagnostics, interaction traces, and clear results.
- Workday interaction traces include the target tag/id/name/text/ARIA/rect plus
  a reason such as `open_workday_button_dropdown`,
  `select_combobox_option`, `phone_country_code_precheck`, or
  `phone_country_code_matches_choice`.
- The gap report command summarizes local JSONL logs.

Tools used:

- `logs\c3_extension_debug.jsonl`
- `scripts\c3_gap_report.py`
- Extension activity log
- Local backend debug-log sink

Useful command:

```powershell
python scripts\c3_gap_report.py --limit 3 --include-fields
```

Status:

- Gap report tests pass.
- This is the main way to compare C3 runs without reading raw JSONL.

## Step 13: Clear And Recover

What happens:

- Clear Current Page clears text fields, checkboxes, radios, native selects,
  custom selects, selected chips, blank selected X controls, and some uploaded
  file chips.
- It closes open dropdowns and removes transient React Select menu/listbox DOM
  when needed.
- It reports remaining open dropdowns or filled controls if cleanup is not
  complete.

Tools used:

- Native setters
- Realistic clear clicks
- `Escape`, blur, outside-click events
- React Select menu/listbox cleanup
- Post-clear diagnostics

Status:

- Synthetic real-Chrome smoke reached zero visible menus, zero selected values,
  and zero expanded controls.
- Live Hootsuite retest passed after Clear Current Page: all filled text inputs
  were empty, filled dropdowns returned to `Select...`, all checked dropdown
  inputs had `aria-expanded="false"`, and there were zero visible listboxes or
  `menu-is-open` controls.

## What Is Verified

- C3 CI passes with 23 tests passed and 19 skipped.
- The dedicated controlled browser endpoint works.
- The unpacked extension loads in the controlled browser.
- A local Greenhouse-like fixture shows the Hunt prompt.
- Live Hootsuite fill on `gh_jid=7808288` fills 12 deterministic fields and
  leaves manual review only for missing default resume data.
- Live Hootsuite Clear Current Page clears the same real form back to empty
  state and closes React Select open-state classes.
- Live Workday `Autofill with Resume` on Jonas Software Canada reaches step 6 of
  6, Review, with Submit visible and no page errors.
- Live Workday `Apply Manually` on the same posting reaches step 5 of 5, Review,
  with Submit visible and no page errors.
- The Workday review text shows committed identity, source, location, email,
  phone `+1 7800000000 (Mobile)`, and `main.pdf` resume attachment.
- Gap report tests pass.
- Clear Page synthetic Chrome smoke clears custom dropdown state correctly.
- Route selection, ATS registry, and generic-backed adapter behavior have test
  coverage.
- Workday My Experience follow-up diagnostics identify missing saved
  work/education/skills/websites profile data instead of silently doing
  nothing.
- TeX profile import now extracts education, work experience, skills, website,
  LinkedIn, and GitHub from `main.tex`, so those fields can be saved into the
  extension profile before filling Workday My Experience.
- Workday My Experience fill avoids the stale `My Information` hydration wait
  on later steps and recognizes Add controls rendered as buttons, role-buttons,
  or links.
- Manual Fill Current Page now closes the extension popup after dispatch and
  shows an in-page loading spinner while C3 is actively filling, so slow Workday
  pages no longer look idle.

## What Is Still Untested Or Risky

- Normal logged-in Chrome control path.
- Runtime extension reload in a test profile can leave the unpacked extension
  disabled. Restarting the dedicated browser with a fresh profile is currently
  the safer verification path after code changes.
- C4 polling and fill-result postback as a full end-to-end browser flow.
- Workday across many live Workday variants.
- Greenhouse, Lever, Ashby, Workable, and SmartRecruiters as mature dedicated
  adapters.
- Detected-only ATSs such as iCIMS, Taleo, ADP, UKG, Jobvite, and BambooHR.
- Dynamic multi-step applications beyond the tested Hootsuite and Jonas Workday
  paths.
- File upload widgets beyond the tested paths.
- LLM confidence policy for medium-confidence or generated paragraph answers.

## Human Commands

Run C3 CI:

```powershell
python ci.py c3
```

Launch the dedicated test browser:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch_c3_chrome.ps1
```

Summarize recent C3 logs:

```powershell
python scripts\c3_gap_report.py --limit 3 --include-fields
```

Run the Jonas Workday live smoke in the dedicated browser:

```powershell
node scripts\c3_workday_live_smoke.js --mode resume --resume main.pdf
node scripts\c3_workday_live_smoke.js --mode manual --resume main.pdf
```

The smoke driver seeds only the dedicated C3 browser profile, clicks `Next`, and
stops at Review when Submit is visible.

Diagnostic Workday fill without clicking Next:

```powershell
node scripts\c3_workday_live_smoke.js --mode manual --resume main.pdf --max-pages 1 --fills-per-page 3 --stop-after-fill
```

Use a fresh dedicated browser profile after extension source edits. A reused
profile can keep stale extension service-worker code even when the file fetched
through `chrome.runtime.getURL()` shows the new source.
