# C3 Testing Runbook

This runbook is the safe operator path for testing C3 (Executioner). C3 is still
not proven end to end with a live browser-backed application, so test in layers:
automated baseline first, C4 handoff second, manual extension proof third, and
only then a low-risk live Workday pilot.

## Baseline Checks

Run from the repo root:

```powershell
.\.venv\Scripts\python.exe test.py c3
.\.venv\Scripts\python.exe -m pytest tests\test_component4_c3_bridge.py -q
.\.venv\Scripts\python.exe ci.py c3
```

Expected coverage:

- `test.py c3`: C3 apply-context prep.
- `test_component4_c3_bridge.py`: C4 pending-fill and fill-result bridge.
- `ci.py c3`: Executioner JS syntax lint, Prettier check, and C3 tests.

Do not call C3 locally green unless `ci.py c3` passes.

## Pick A Safe Job

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

## Test The Bridge Before The Browser

Request a fill only after the run is in `apply_prepared`:

```powershell
.\hunter.ps1 c4-request-fill --run-id <RUN_ID>
.\.venv\Scripts\python.exe -m pytest tests\test_component4_c3_bridge.py -q
```

For a protocol-only worker check without launching a browser:

```powershell
.\.venv\Scripts\python.exe -m coordinator.agent_worker --runtime openclaw_isolated --mock-result
```

Expected state behavior:

- `apply_prepared` moves to `fill_requested`.
- C4 exposes exactly one pending fill.
- A fill result moves the run to `awaiting_submit_approval` or `manual_review`.
- Final submit remains human-gated.

## Load The Extension

Manual Chrome setup:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Select Load unpacked.
4. Choose `c:\Users\sushi\Documents\Github\hunt\executioner`.

Then configure the extension options or popup with the candidate profile, resume
context, generated-answer preferences, and the safe apply context.

Profile shortcut: in Options, use Import profile from TeX resume, choose
`main.tex`, then click Import Profile From TeX. The extension parses the resume
header into profile fields and reports any fields still missing.

Dev reload shortcuts:

- In C3 Options, click Reload Extension to call `chrome.runtime.reload()`.
- From the terminal, run `.\hunter.ps1 c3-reload` or `.\hunt.ps1 c3-reload`.
- Terminal reload requires Chrome to be running with remote debugging enabled,
  for example `chrome.exe --remote-debugging-port=9222`.

Current limitation: `manifest.json` only grants Workday host permissions, so
non-Workday pages need manifest and adapter work before extension injection will
run there.

Activity logging: C3 Options includes an Activity Log panel. It records extension
state changes such as settings/profile/resume saves, TeX profile import, apply
context import/clear, fill attempts, and reload requests. Use Export JSON to
download the log or Clear Log to reset it.

Extension quality commands:

```powershell
.\hunter.ps1 c3-quality
.\hunter.ps1 c3-test
.\hunter.ps1 c3-ci
.\hunter.ps1 c3-lint
.\hunter.ps1 c3-format-check
.\hunter.ps1 c3-format
```

`quality.py c3` now runs extension JS syntax lint plus Prettier style checks.

## First Manual Browser Test

Start with a local fixture or copied static Workday-like page when possible. If
using a real Workday page, stop before submit.

Operator checklist:

- Open the apply URL.
- Confirm the extension detects the page.
- Import or confirm the apply context.
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
