# C3 Lane Agent

Use this doc for a subagent that owns one C3 parallel batch lane. The lane
agent investigates and reports. It does not change C3 code.

## Priority

Fill completion beats fill correctness. The lane goal is to reach Review and
stop before final Submit. If C3 can interact with a required field, do not stop
only because the answer might be wrong. Use the progress-first fallback policy,
continue, and report the questionable answer as a Review/audit issue. Treat it
as a lane failure only when it blocks progress, creates unsupported required
follow-up fields, or leaves validation uncleared.

## Token Budget Policy

Use terse/caveman-lite reporting. No narrative logs. Paste only decisive
evidence, not full audit or console output. Prefer artifact paths. If Review is
reached, do not deep-investigate bad fills. If the lane fails before Review, use
the failed-lane probe budget from the main-agent prompt. The first mutating
probe should be live UI/user-like. Later attempts may use focused CDP/Playwright
proof or rescue scripts. Stop early when Review is reached, root cause is
proven, the page becomes unsafe to mutate, or the next attempt would repeat the
same evidence. When the budget is exhausted, preserve the lane and report
`needs_deeper_probe`.

## Role

- Own exactly one job/lane.
- Classify the failure by UI primitive before recommending a fix. Use
  `docs/C3_PRIMITIVE_DEBUGGING.md`.
- Use only the assigned isolated p Chrome lane.
- Do not use normal Chrome or the user's main Chrome profile.
- Do not open a bare `chrome-extension://<extension-id>` URL. Use the full C3
  Options URL or setup scripts from `docs/C3_TESTING_METHODS.md`.
- Do not open visible Terminal, Windows Terminal, PowerShell, cmd, or log-tail
  windows.
- Do not move browser/helper windows onto the main monitor or steal focus.
- Keep p Chrome in the background. Do not use browser, CDP, Playwright, or
  script actions that bring the lane to the foreground unless the user
  explicitly asks to inspect it.
- Do not use `Page.bringToFront`, Playwright `page.bringToFront()`,
  `--bring-to-front`, restore/cascade, or focus-moving actions unless the user
  explicitly asks to inspect the lane.
- Write findings only to the assigned lane section in
  `logs\<batch-id>\current_debug.md`.
- Do not modify C3 code.
- Do not spawn additional agents or duplicate your lane for the same job. A new
  agent set starts only with a new job set or an explicit main-agent handoff.
- After a Review result, capture final UI, proof, console, and audit artifacts,
  then report. Do not close p Chrome.
- After a hard pre-Review failure, preserve your assigned p Chrome lane for the
  user to inspect. Do not close it unless the main-agent prompt explicitly says
  cleanup is allowed.
- After a non-C3/site/posting stop such as Workday maintenance, dead posting,
  non-application site, CAPTCHA/MFA, external assessment, or tenant outage,
  preserve the lane for inspection and classify it separately. It is not a hard
  C3 fill failure.
- If your assigned job is rerun in a fresh p Chrome lane, tell the main agent
  which old lane needs cleanup.

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
12. After your report and artifacts are complete, leave p Chrome open and
    return. The main agent owns all p Chrome cleanup.

## If Review Is Reached

- Inspect the final Review UI.
- Inspect the audit output.
- Verify filled answers are correct.
- Mark the lane as Review reached even when bad fills are present. Bad fills
  are Review/audit quality issues, not hard failures, unless they prevented
  Review.
- Check for bad deterministic mappings, bad unknown fallbacks, wrong disclosure
  choices, wrong source, wrong eligibility, wrong date, wrong salary, and bad
  multiselect fills.
- Unknown required prompts should not stop solely because the answer is unknown
  when C3 can interact with the UI. Group fallback uses as Review-quality risks
  and catalog/profile gaps, but treat failure to continue through a usable
  control as a fallback-pipeline or UI interaction failure.
- Do not spend lane time trying to perfect answer correctness after Review is
  reached. Record bad fills clearly and keep the browser away from Submit.
- For Workday `How Did You Hear About Us?` / Source fields, do not mark every
  non-LinkedIn Review value as a bug when the URL or profile source is
  LinkedIn. C3's intended policy is progress-safe source selection: prefer an
  exact/alias match when it commits, otherwise a nonblocked source such as a job
  board, job site, careers/company website, internet, or other safe source is
  acceptable. Treat referral, employee, recruiter, agency, or empty/Select One
  values as bad unless profile evidence explicitly supports them.
- When a bad answer is found, classify whether the fix belongs in a visible
  profile field, answer-option matching, question classification, or UI driver
  behavior before recommending code changes.
- Do not recommend a one-off hardcoded answer for candidate-specific or
  preference-specific data. Use or add a profile field. Examples:
  `namePrefix` controls legal-name prefix, `accommodationRequest` controls
  accommodation-request questions, and hourly prompts use calculated/explicit
  hourly profile data rather than annual salary.
- Defaults are acceptable only when they are reusable safe fallbacks and the
  profile can override them. Blank `accommodationRequest` resolves to `No` only
  when a required yes/no prompt needs a concrete answer.
- Record any issue in `current_debug.md` using `docs/C3_ERROR_TAXONOMY.md`.

## If The Lane Fails

If the lane did not reach Review/Submit visibility after the normal C3 flow and
required investigation, mark it as a hard failure for batch-stop counting unless
the final classification is non-Workday, dead posting, external assessment,
CAPTCHA/MFA, or another site/posting state outside C3 fill completion.
Preserve the p Chrome for every hard failure and every site/posting-state stop.
The user wants to see these lanes.

Probe budget:

- Use the failed-lane probe budget from the main-agent prompt.
- The normal C3 full-flow run does not count against the probe budget.
- Read-only inspect, snapshot, audit, or console capture does not count.
- Count each mutating UI/CDP action or script that tries to clear the blocker,
  prove a commit path, or rescue progress.
- The first mutating probe should be live UI/user-like.
- Later attempts may use focused CDP/Playwright proof or rescue scripts.
- Each attempt must test a new hypothesis and write an artifact path.
- Stop early if Review is reached, root cause is proven, the page becomes
  unsafe to mutate, or the next attempt would repeat the same evidence.
- When the budget is exhausted, preserve the lane and report
  `needs_deeper_probe`.

1. Preserve the page state when possible.
2. Classify the failure with `docs/C3_ERROR_TAXONOMY.md`.
3. Classify the failing UI primitive: Source, Skills, phone, text input,
   repeatable rows, required checkbox, auth gate, apply-entry/session routing,
   or unknown option fallback.
4. Interact with the live p Chrome UI like a user before inspecting DOM/source.
   If a required unknown prompt blocked progress, prove whether the UI was
   usable. If it was usable, identify why the progress-first fallback ladder did
   not continue: neutral/non-disclosure first, then `No`, then first real
   non-placeholder option.
5. Use CDP/Playwright to inspect the exact page behavior after the user-like
   probe: active element, popup/listbox owner, clicked row, selected pill,
   hidden/backing value, validation text, and fields touched by repair.
6. Use the narrow proof scripts listed in `docs/C3_TESTING_METHODS.md` when one
   matches the failure. If none fits, create a new narrow proof/probe script or
   one-off snippet for that exact UI behavior.
7. Keep proof/probe code separate from `c3_workday_live_smoke.js`.
8. Do not modify C3 product code, extension code, or live-smoke flow while
   investigating. Proof/probe scripts are allowed.
9. Record proof: visible UI result, committed state, selected pill, hidden
   value, validation cleared, or successful navigation.
10. Recommend a generalized C3 behavior change, not a job-specific hack.
11. Recommend generalized fixes that keep the run moving: better question
   matching, answer matching, profile routing, option ranking, or Workday commit
   behavior. If the correct answer is unknown but the UI is usable, recommend
   the progress-first fallback ladder and mark the result for Review instead of
   stopping before Review.
12. If a wrong answer caused the failure by opening unsupported required
    follow-up fields, report the progress-safe alternative that avoids the
    follow-up. Examples: active clearance should default to `No` without
    explicit active-clearance evidence; AI consent should be treated as an
    application question, not as resume upload.
13. Do not close the lane after a hard failure or site/posting stop unless the
    main agent explicitly says cleanup is allowed.

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
primitive:
user_like_probe:
cdp_probe:
field_focused:
popup_owner:
option_clicked:
value_saved:
repair_touched:
commit_proof:
loop_check:
probe_budget:
probe_attempts:
ui_probe:
proof_script:
recommended_c3_change:
agent_feedback:
new_error_type:
artifacts:
```

For Review lanes, focus on `bad_fills` and `unknowns`. For failed lanes, focus
on `primitive`, `failure_point`, `user_like_probe`, `cdp_probe`,
`commit_proof`, `loop_check`, and `recommended_c3_change`. `agent_feedback`
must tell the next agent what to try next or what not to repeat. Use
`new_error_type` when the existing taxonomy does not describe the failure;
suggest whether the main agent should document the new error type, add code
handling, or both.
