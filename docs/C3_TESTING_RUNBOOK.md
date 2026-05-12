# C3 Testing Runbook

This runbook is the safe operator path for testing C3 (Executioner). C3 is still
not live-proven, so test it in layers: automated baseline first, standalone
extension proof second, DB/C4 handoff third, and only then a low-risk live ATS
pilot.

## Baseline Checks

Run from the repo root:

```powershell
.\.venv\Scripts\python.exe test.py c3
.\.venv\Scripts\python.exe -m pytest tests\test_component4_c3_bridge.py -q
.\.venv\Scripts\python.exe ci.py c3
```

Expected coverage:

- `test.py c3`: C3 apply-context prep, resume parser, and fill-route naming.
- `test_component3_generic_fill.py`: browser-backed generic required-field fixtures, including basic HTML and Greenhouse-like hosted careers markup.
- `test_component4_c3_bridge.py`: C4 pending-fill and fill-result bridge.
- `ci.py c3`: Executioner JS syntax lint, Prettier check, and C3 tests.

Do not call C3 locally green unless `ci.py c3` passes.

Current local baseline: `python ci.py c3` passed on 2026-05-11. This proves
formatting, JS syntax, route/profile stage tests, and the browser-backed generic
filler fixtures. It does not prove the unpacked Chrome extension UI or C4
polling/postback.

Current live ATS baseline: Jonas Software Canada Workday passed both
`Autofill with Resume` and `Apply Manually` on 2026-05-11 in the controlled
browser. Both paths reached Review with Submit visible and no page errors. The
smoke did not click Submit.

## Controlled Browser Setup

For repeatable C3 extension testing, use the dedicated controlled browser first:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch_c3_chrome.ps1
```

This starts Playwright Chromium with the unpacked Hunt extension loaded from
`executioner`, a dedicated profile, and a DevTools endpoint at
`http://127.0.0.1:9222`.

The launcher tries to place the test browser on a non-primary monitor so it
does not cover the main working screen. Override placement when needed:

```powershell
$env:HUNT_C3_CHROME_WINDOW_POSITION = "2000,80"
$env:HUNT_C3_CHROME_WINDOW_SIZE = "1400,1000"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch_c3_chrome.ps1
```

Unset those variables to return to automatic placement.

Status on 2026-05-11:

- A local Greenhouse-like fixture showed the Hunt detected-page prompt in the
  controlled browser, proving the unpacked extension content script is active.
- The dedicated browser path is verified.
- The dedicated browser path also drove the Jonas Workday live smoke through
  every `Next` page on both resume-upload and manual entry paths.
- Regular Chrome can expose the debug endpoint while ignoring unpacked extension
  loading, so the launcher prefers Playwright Chromium.

Use this browser for repeatable extension reloads, fixture smokes, DOM/iframe
inspection, screenshots, and Hootsuite-style debugging.

After navigating to a new step in the same application, C3 should re-run page
detection and show the in-page fill prompt again if the new step has visible
fillable controls. Fill Current Page and Clear Current Page from the popup
dismiss existing Hunt prompts/toasts before running.

Detailed change history: `docs\C3_CHANGES_SO_FAR.md`.

## Standalone Extension Setup

The first practical C3 mode does not need C0, C1, C2, or C4. It uses the
extension-local profile and default resume saved in Chrome extension storage.

Manual Chrome setup:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Select Load unpacked.
4. Choose `c:\Users\sushi\Documents\Github\hunt\executioner`.

Then open C3 Options and configure:

- candidate profile
- default resume PDF
- manual fill enabled
- prompt on signup/ATS pages enabled for prompt testing, disabled if it gets noisy
- fill required fields only enabled for first tests; disable it later to test filling optional known fields
- local debug log sink enabled for C3 testing so logs stream into the repo while the backend is running
- download JSON logs after fills disabled by default; enable only when you want a Downloads backup
- autofill on load disabled for early testing
- C4 polling disabled until the standalone fixture tests pass

Profile shortcut: in Options, use Import profile from TeX resume, choose
`main.tex`, then click Import Profile From TeX. The extension parses the resume
header into profile fields and reports any fields still missing.

First-stage route names:

- `filler`: extension-local profile/resume, generic required-field fill for ordinary pages
- `ats_filler`: extension-local profile/resume, ATS adapter

The `filler` route is not job-site-only. It fills obvious required fields such as
name, email, phone, links, and resume upload on ordinary pages too, one field or
field group at a time. It skips optional fields and unknown custom fields.

## First Standalone Browser Test

Start with a safe local/static form or a throwaway page. Do not start with a real
irreversible application.

Recommended first target:
`c:\Users\sushi\Documents\Github\hunt\executioner\fixtures\generic\basic_required.html`.
This mirrors the automated generic filler fixture but exercises the real loaded
extension path.

Additional manual fixtures:

- `executioner\fixtures\generic\signup_account.html`: confirms generic filler skips username/password while filling known required contact fields.
- `executioner\fixtures\generic\two_step_application.html`: confirms the current-step-only behavior. C3 should not click Next or Review yet; after manually moving to step two, trigger Fill again.
- `executioner\fixtures\generic\greenhouse_like.html`: confirms Greenhouse-style sibling labels, required stars, contenteditable links, and hidden resume file inputs behind Attach-style controls.

Real hosted careers pages may embed the actual application form in an iframe.
Hootsuite does this: the top page is `careers.hootsuite.com`, while the form is
loaded from `job-boards.greenhouse.io/embed/job_app`. Popup/manual fill now
injects into all same-tab frames and keeps the frame result with the most filled
fields.

Detected-page prompt: the extension now injects a Hunt prompt on all ordinary
URLs when it detects likely ATS, signup, or application form signals. Chrome
does not reliably allow extensions to force-open the toolbar popup on arbitrary
web pages, so the prompt is an in-page extension banner with Fill known fields
and Not now buttons.

Operator checklist:

- Open a safe form page.
- Confirm the popup says `Standalone`.
- Trigger Fill.
- Inspect every filled field.
- Confirm only required identity/contact/job-context/resume fields were filled.
- Confirm optional fields and unknown custom questions were left alone.
- Stop before any final submit.

Success criteria:

- Correct identity/contact fields are filled.
- Resume is attached when a resume/CV file input exists and a default resume is saved, including hidden file inputs behind Attach-style controls.
- Optional fields are skipped.
- Unknown required fields remain for manual review instead of being guessed.
- No final submit click occurs.
- The Activity Log and latest attempt record the fill.
- Latest attempt includes field inventory: field id/name/descriptor, required flag, skip reason, and value source.

Descriptor matching currently uses deterministic phrase matching. It considers
input type, autocomplete, data-testid, data-automation-id, name, id, aria-label,
placeholder, nearby label/container text, sibling label text, and wrapper text.
Value setting uses native browser setters so React-style controlled inputs can
observe the change. Shared profile matching chooses the earliest strong field
identity in the descriptor, so `last name ... first name` resolves to last name
and `email ... first name` resolves to email. Workday inventory logs exact value
sources such as `profile:firstName` or `profile:lastName`. There is no LLM field
decisioner in the generic filler yet.

Fill required fields only: enabled by default. When disabled, C3 still does not
guess unknown fields, but it may fill optional fields that match known safe
profile/job-context rules.

Local debug log sink: Options has Local debug log sink and Test Log Sink. When
enabled, extension activity and fill results post to the local backend endpoint
`/api/c3/debug-log`; the backend appends JSONL entries to
`logs/c3_extension_debug.jsonl` in the repo. This is the preferred testing path
because logs stay in the repo without a manual download. The sink
requires the backend URL to point at the running local backend and, if the
backend is using `HUNT_SERVICE_TOKEN`, the same service token must be saved in
C3 Options.

Manual log export: Options still has Download JSON logs after fills and Export
Logs Now. Download JSON logs after fills is disabled by default. When enabled,
Chrome saves JSON through the Downloads API under the folder prefix in
Auto-export folder, default `hunt-c3-logs/`. Use this only as backup evidence if
the local backend sink is unavailable.

## Pick A Safe Job For DB/C4 Context

Before preparing a C3 run, choose one job that is safe for manual testing. It
must have:

- `apply_type = external_apply`
- `auto_apply_eligible = true`
- `enrichment_status = done` or `done_verified`
- a real `apply_url`
- a selected resume
- `selected_resume_ready_for_c3 = true`

Check readiness and create the apply packet:

```powershell
.\hunter.ps1 c4-ready --job-id <JOB_ID>
.\hunter.ps1 apply-prep <JOB_ID> --browser-lane isolated --embed-resume-data
.\hunter.ps1 c4-runs
```

Success means C4 has created a run and written a C3-compatible
`c3_apply_context.json` artifact for the browser handoff.

DB/C4 route names:

- `db_filler`: DB/job context plus generic required-field fill
- `db_ats_filler`: DB/job context plus ATS adapter
- `c4_filler`: C4 fill request plus generic fallback
- `c4_ats_filler`: C4 fill request plus ATS adapter

## Test The Bridge Before The Browser

Request a fill only after the run is in `apply_prepared`:

```powershell
.\hunter.ps1 c4-request-fill --run-id <RUN_ID>
.\.venv\Scripts\python.exe -m pytest tests\test_component4_c3_bridge.py -q
```

Expected state behavior:

- `apply_prepared` moves to `fill_requested`.
- C4 exposes exactly one pending fill.
- A fill result moves the run to `awaiting_submit_approval` or `manual_review`.
- Final submit remains human-gated.

Dev reload shortcuts:

- In C3 Options, click Reload Extension to call `chrome.runtime.reload()`.
- From the terminal, run `.\hunter.ps1 c3-reload` or `.\hunt.ps1 c3-reload`.
- Terminal reload requires Chrome to be running with remote debugging enabled,
  for example `chrome.exe --remote-debugging-port=9222`.
- Live Hootsuite testing found that runtime reload can leave the unpacked
  extension disabled in a test profile. When verifying code changes, the safer
  path is to restart the dedicated browser or use a fresh
  `HUNT_C3_CHROME_PROFILE`.

Current manifest scope: `manifest.json` grants `<all_urls>` for the testing
build so generic prompt detection and manual fill can run on ordinary sites.
Keep prompt-noise testing conservative before treating this as release-ready.

Activity logging: C3 Options includes an Activity Log panel. It records extension
state changes such as settings/profile/resume saves, TeX profile import, apply
context import/clear, fill attempts, and reload requests. Use Export JSON to
download the log or Clear Log to reset it.

C4 polling scaffold: Options now exposes backend URL, service token, polling
enabled, poll interval, heartbeat interval, one-active-run lock, and Poll C4
Once. Treat this as unproven until a loaded-extension smoke shows the extension
polling `/api/c3/pending-fills`, opening the claimed apply URL, filling the page,
and posting `/api/c3/fill-result`.

Extension quality commands:

```powershell
.\hunter.ps1 c3-quality
.\hunter.ps1 c3-test
.\hunter.ps1 c3-ci
.\hunter.ps1 c3-lint
.\hunter.ps1 c3-format-check
.\hunter.ps1 c3-format
.\hunter.ps1 c3-package
.\hunter.ps1 c3-store-deploy
```

`quality.py c3` now runs extension JS syntax lint plus Prettier style checks.

## Package For Download

After `.\hunter.ps1 c3-ci` passes, package C3:

```powershell
.\hunter.ps1 c3-package
```

This creates:

- `dist/c3/hunt-apply-extension-v<version>/`: unpacked folder for Chrome Load unpacked
- `dist/c3/hunt-apply-extension-v<version>.zip`: downloadable/shareable archive

For another user, send the zip. They unzip it, open `chrome://extensions`,
enable Developer Mode, click Load unpacked, and select the unpacked folder.

## Upload To Chrome Web Store

Use this only after you have created a Chrome Web Store developer account and a
new item in the Developer Dashboard.

Required environment:

```powershell
$env:CWS_PUBLISHER_ID = "<publisher-id>"
$env:CWS_EXTENSION_ID = "<extension-id>"
$env:CWS_ACCESS_TOKEN = "<oauth-access-token>"
```

Upload the package to the existing item:

```powershell
.\hunter.ps1 c3-store-deploy --status
```

Upload and submit for review:

```powershell
.\hunter.ps1 c3-store-deploy --publish --status
```

The Chrome Web Store listing and privacy tabs must still be completed in the
Developer Dashboard before a first publish can succeed.

## First ATS Browser Test

Start with a local fixture or copied static Workday-like page when possible. If
using a real Workday page, stop before submit.

Before testing Workday resume upload, open Options and save a Default Resume PDF.
The popup must show Default Resume as a filename or Cached PDF, not Not set.
If C3 reaches a Workday resume page without cached resume data, latest attempt
should become manual_review with `resume_upload:missing_resume_data`.
Options should show a top-right toast after Save Default Resume. If no PDF is
cached or selected, it should show a warning toast. During page fills, warnings
such as missing default resume should appear as top-right page toasts.

Operator checklist:

- Open the apply URL.
- Confirm the extension detects the page.
- Import or confirm the apply context if testing a DB/C4-backed route.
- Trigger Fill.
- Inspect every filled field.
- Confirm resume upload behavior if a file input exists.
- Stop before final submit.
- Record the result as `manual_review` or `ok`, never submitted.

Success criteria:

- Correct identity/contact fields are filled.
- Resume is attached when supported.
- Optional EEO/demographic fields are skipped.
- Unknown required fields are flagged instead of guessed.
- No final submit click occurs.
- Evidence is captured or manually noted.

## Workday Live Smoke

Use a fresh dedicated browser profile after extension source edits. The smoke
script seeds the extension profile and `main.pdf`, navigates to the selected
Workday path, sends `hunt.apply.fill_current_page`, clicks only `Next`, and
stops at Review when Submit is visible.

Resume-upload path:

```powershell
node scripts\c3_workday_live_smoke.js --mode resume --resume main.pdf
```

Manual path:

```powershell
node scripts\c3_workday_live_smoke.js --mode manual --resume main.pdf
```

Expected result for the Jonas Software Canada posting:

- Resume path: final step 6 of 6, `Review`, `hasSubmit: true`, no page errors.
- Manual path: final step 5 of 5, `Review`, `hasSubmit: true`, no page errors.
- Review text includes `How Did You Hear About Us? Linkedin`, `Edmonton, AB
  Canada`, `Phone +1 7800000000 (Mobile)`, and `main.pdf`.

Workday details that matter:

- `Apply Manually` initially exposes a Country dropdown before the rest of the
  form. C3 primes Country first, then fills the dependent fields.
- Workday button dropdown commits can be delayed. C3 polls committed button text
  before treating a selection as saved.
- Workday phone country code is a separate search control. It must select
  `Canada (+1)` and must not receive the raw phone number. If it is already
  selected, the trace should show `phone_country_code_precheck` followed by
  `phone_country_code_matches_choice`, with no
  `open_phone_country_code_picker` click.
- Required terms and consent checkboxes are filled only for narrow required
  terms/agreement descriptors.

Diagnostic repeated fill without clicking Next:

```powershell
node scripts\c3_workday_live_smoke.js --mode manual --resume main.pdf --max-pages 1 --fills-per-page 3 --stop-after-fill
```

Use this when checking idempotency. It should show already-correct controls as
`already_filled` on repeated fills.

## First Live ATS Pilot

Only run this after the baseline checks and first manual browser test pass.

Pilot rules:

- Use an isolated browser profile.
- Use one low-risk external Workday job.
- Keep the operator watching the browser.
- Stop on CAPTCHA, MFA, account creation, required custom questions,
  unsupported widgets, or final submit.
- Deny or hold submit approval unless the final page was personally inspected.

Record:

- job id
- run id
- apply URL
- fields that filled correctly
- fields that failed or required manual work
- screenshot or HTML evidence paths when available
- final C4 status
