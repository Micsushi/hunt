# C3 Changes So Far

Updated: 2026-05-11

This document summarizes the current C3 work in this branch. It is intended as
the quick operator and developer map before the next Hootsuite/Greenhouse debug
pass.

## Browser Control Status

Verified:

- `playwright_c3` MCP is configured in `C:\Users\sushi\.codex\config.toml`.
- `scripts\launch_c3_chrome.ps1` launches a dedicated controllable browser on
  `http://127.0.0.1:9222`.
- The launcher prefers Playwright Chromium because regular Chrome 137+ can
  expose CDP while ignoring `--load-extension`.
- The dedicated profile is
  `C:\Users\sushi\AppData\Local\Hunt\ChromeC3PlaywrightProfile`.
- The endpoint responds at `/json/version`.
- A local Greenhouse-like fixture shows `hunt-apply-detected-page-prompt`,
  proving the unpacked Hunt extension content script is active in the controlled
  browser.

Configured but not fully verified in this running Codex session:

- `playwright_live` MCP is configured with Playwright MCP extension mode.
- It needs a Codex restart and the Playwright browser extension attached to a
  normal Chrome tab before Codex can prove it controls the user's logged-in
  Chrome session.

Primary use:

- Use `playwright_c3` for repeatable C3 extension reloads, fixture checks,
  Hootsuite-like debugging, screenshots, DOM and iframe inspection, and console
  logs.
- Use `playwright_live` only when the bug depends on the user's existing
  logged-in normal Chrome session.

## ATS Detection And Routing

Added:

- ATS registry for common systems including Greenhouse, Workday, Lever, Ashby,
  Workable, SmartRecruiters, iCIMS, Taleo, ADP, UKG, Jobvite, BambooHR, Breezy,
  JazzHR, Recruitee, and Pinpoint.
- ATS support matrix with levels such as dedicated adapter, generic-backed
  adapter, and detected-only.
- Embedded ATS detection for Hootsuite-style Greenhouse iframes.
- Frame signal collection so a hosted careers page can route based on embedded
  frame URLs and selectors such as `#grnhse_app`.
- Route selection that can use ATS-specific generic-backed routes for
  Greenhouse, Lever, Ashby, Workable, and SmartRecruiters.

Why it matters:

- Hootsuite is not just a plain `careers.hootsuite.com` page. The actual form can
  live in a `job-boards.greenhouse.io` iframe, so C3 must detect and fill across
  frames.

## Dropdown Selection Fixes

Added:

- React-safe option click sequence: mouseover, mousemove, pointerdown,
  mousedown, pointerup, mouseup, click.
- Keyboard fallback: focus/highlight option and send Enter when pointer click
  does not verify a committed value.
- Commit verification that distinguishes typed search input from selected value.
- Menu closing after selection with Escape, blur, and outside-click events.
- Pending inventory update after verified LLM or deterministic option commits.

Why it matters:

- Yes/no dropdowns worked more often because the selected label is short and
  exact.
- Long searchable values such as co-op terms and graduation years can look
  selected while the React Select control only changed search text or left a
  stale listbox open.

## Clear Page Fixes

Added:

- Native value and checked setters for React-controlled inputs.
- Realistic pointer/mouse sequence for clear and remove controls.
- Clear indicator detection for blank selected controls that show only an X.
- Deduplicated clear clicks with a `WeakSet`.
- Safer fallback for unlabeled select indicators: only click them when the field
  still has selected value evidence.
- Pre-clear and post-clear dropdown close passes.
- Transient React Select menu cleanup that hides or removes `.select__menu`,
  `.select__menu-list`, `react-select` listboxes, and `[role='listbox']` nodes.
- Post-clear diagnostics: `closedDropdowns`, `hiddenDropdownMenus`,
  `openDropdownsBefore`, `remainingOpenDropdowns`, `remainingFilledControls`,
  and `clearIndicatorClicks`.

Verified:

- Isolated real Chrome CDP smoke showed after clear: visible menus 0, selected
  values 0, expanded controls 0.
- Current dedicated C3 browser fixture smoke proves the extension loads in the
  controlled browser.

## LLM Help And Counts

Added:

- Backend answer-decision route for unresolved required fixed-choice fields.
- Popup and in-page LLM confirmation flow.
- Pending LLM summaries in fill results.
- LLM decision diagnostics in activity logs.
- Recomputed `pendingLlmFieldCount` from updated field inventory after fill,
  instead of trusting stale pre-fill counts.
- Guardrail: LLM help should not reduce remaining counts unless the browser
  verifies a committed answer.

## Gap Report And Measurement

Added:

- `scripts\c3_gap_report.py`.
- Schema: `hunt.c3.gap_report.v1`.
- Summaries by host, ATS, support level, route, status, field counts, skipped
  reasons, widget kinds, pending LLM count, and failure buckets.
- Latest Clear section with clear metrics including `hidden_menus`.
- C3 test target includes `tests\test_component3_gap_report.py`.

Primary command:

```powershell
python scripts\c3_gap_report.py --limit 3 --include-fields
```

## UI And Operator Changes

Added:

- Popup support-level and latest-attempt details.
- LLM help confirmation in popup and page prompt.
- Clear Current Page controls and diagnostics.
- Options autosave for profile/settings.
- Activity log detail expansion.
- Local debug log sink into `logs\c3_extension_debug.jsonl`.
- Safer default posture: manual fill and review before submit remain the normal
  workflow.

## Tests And Verification

Recent verification commands that passed:

```powershell
node --check executioner\src\background\index.js
python -m pytest tests\test_component3_gap_report.py tests\test_component3_stage1.py -q
python -m ruff check scripts\c3_gap_report.py tests\test_component3_gap_report.py tests\test_component3_stage1.py
python -m ruff format --check scripts\c3_gap_report.py tests\test_component3_gap_report.py tests\test_component3_stage1.py
python ci.py c3
```

Recent browser-control verification that passed:

```powershell
codex mcp list
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch_c3_chrome.ps1
Invoke-RestMethod -Uri http://127.0.0.1:9222/json/version
```

The controlled browser fixture smoke loaded
`executioner\fixtures\generic\greenhouse_like.html` and confirmed the Hunt prompt
was present.

## Known Limits

- `playwright_live` is configured but needs a Codex restart and Playwright
  browser extension attachment before it can be called proven.
- The current session cannot use the newly added MCP tools until Codex restarts.
- Dedicated browser login state is separate from the user's normal Chrome.
- Hootsuite should be retested in the controlled browser with the latest clear
  and dropdown fixes.
- Direct final submit remains out of scope. C3 is review-first.
