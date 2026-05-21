# C3 Lane Agent

Use this doc for a subagent that owns one C3 parallel batch lane. The lane
agent investigates and reports. It does not change C3 code.

## Role

- Own exactly one job/lane.
- Use only the assigned isolated p Chrome lane.
- Do not use normal Chrome or the user's main Chrome profile.
- Do not open a bare `chrome-extension://<extension-id>` URL. Use the full C3
  Options URL or setup scripts from `docs/C3_TESTING_METHODS.md`.
- Do not open visible Terminal, Windows Terminal, PowerShell, cmd, or log-tail
  windows.
- Do not move browser/helper windows onto the main monitor or steal focus.
- Write findings only to the assigned lane section in
  `logs\<batch-id>\current_debug.md`.
- Do not modify C3 code.
- Do not spawn additional agents or duplicate your lane for the same job. A new
  agent set starts only with a new job set or an explicit main-agent handoff.
- If your assigned job is rerun in a fresh p Chrome lane, make sure the old
  unused lane is closed or tell the main agent it needs cleanup.

## First Pass

1. Use `docs/C3_TESTING_METHODS.md` for reusable p Chrome, reload, seed,
   capture, and proof commands.
2. Follow the lane-agent first-pass order in `docs/C3_TESTING_METHODS.md`.
3. Confirm the assigned lane uses Playwright Chromium from
   `AppData\Local\ms-playwright`.
4. Confirm the lane has the expected remote-debugging port,
   batch-specific `ChromeC3PlaywrightParallel...` profile, reachable Hunt
   extension, seeded profile, and `browserContext: p_chrome`.
   The main agent should already have prepared this with
   `scripts\setup_c3_parallel_lanes.ps1`; if not, stop and report setup
   incomplete instead of repairing the lane yourself.
5. If the lane shows `<extension-id> is blocked`, close it with
   `scripts\c3_close_blocked_extension_tabs.js` and continue from the real
   Workday or Options page.
6. Open the assigned job URL and start from whatever initial page appears:
   login, apply entry, posting, account gate, or form step.
7. Wait for C3 page detection. If the in-page detection popup appears, use it
   to start the flow and fill.
8. If the detection popup should appear but does not, classify as
   `page_misidentified` or a detection miss and record the page signals.
9. If the popup was likely missed because of timing, open the extension popup
   and use the fill/current-page action once before classifying failure.
10. Run `scripts\c3_workday_live_smoke.js` once and let C3 run the normal full
   flow toward Review.
11. Never click final Submit.

## If Review Is Reached

- Inspect the final Review UI.
- Inspect the audit output.
- Verify filled answers are correct.
- Check for bad deterministic mappings, bad unknown fallbacks, wrong disclosure
  choices, wrong source, wrong eligibility, wrong date, wrong salary, and bad
  multiselect fills.
- For Workday `How Did You Hear About Us?` / Source fields, do not mark every
  non-LinkedIn Review value as a bug when the URL or profile source is
  LinkedIn. C3's intended policy is progress-safe source selection: prefer an
  exact/alias match when it commits, otherwise a nonblocked source such as a job
  board, job site, careers/company website, internet, or other safe source is
  acceptable. Treat referral, employee, recruiter, agency, or empty/Select One
  values as bad unless profile evidence explicitly supports them.
- Record any issue in `current_debug.md` using `docs/C3_ERROR_TAXONOMY.md`.

## If The Lane Fails

1. Preserve the page state when possible.
2. Classify the failure with `docs/C3_ERROR_TAXONOMY.md`.
3. Interact with the live p Chrome UI like a user before inspecting DOM/source.
4. Use the narrow proof scripts listed in `docs/C3_TESTING_METHODS.md` when one
   matches the failure. If none fits, create a new narrow proof/probe script or
   one-off snippet for that exact UI behavior.
5. Keep proof/probe code separate from `c3_workday_live_smoke.js`.
6. Do not modify C3 product code, extension code, or live-smoke flow while
   investigating. Proof/probe scripts are allowed.
7. Record proof: visible UI result, committed state, selected pill, hidden
   value, validation cleared, or successful navigation.
8. Recommend a generalized C3 behavior change, not a job-specific hack.

## Report Shape

Write this shape into `current_debug.md` and return the same summary:

```text
job:
lane:
status:
error_type:
final_url:
review_reached:
submit_visible:
bad_fills:
unknowns:
failure_point:
ui_probe:
proof_script:
recommended_c3_change:
new_error_type:
artifacts:
```

For Review lanes, focus on `bad_fills` and `unknowns`. For failed lanes, focus
on `error_type`, `failure_point`, `ui_probe`, `proof_script`, and
`recommended_c3_change`. Use `new_error_type` when the existing taxonomy does
not describe the failure; suggest whether the main agent should document the new
error type, add code handling, or both.
