# C3 Workday Auth noCaptcha Handoff

Goal: Let next agent implement remaining safe auth fix no redoing research or looping on dead submit clicks.

## Current Status

- Batch: `logs\parallel_2026-05-23_auth_loop_fix`
- Lanes:
  - RTX: port 9592, loop8 audit `logs\parallel_2026-05-23_auth_loop_fix\lane_9592_rtx_loop8.audit.json`
  - Boeing: port 9593, loop8 audit `logs\parallel_2026-05-23_auth_loop_fix\lane_9593_boeing_loop8.audit.json`
- Current code now:
  - Detects Workday auth pages including `signin_form`.
  - Commits create-account checkbox with input, label, proxy, and native setter fallback.
  - Falls back from inert landing-choice auth to tenant-scoped login URL.
  - Fills email/password.
  - Targets credential form submit.
  - Stops with `auth_no_captcha_gate` when form stays unchanged and `noCaptchaWrapper` exists.

## What Failed

Both RTX and Boeing still stay on Workday Sign In after credentials = filled and submit = activated.

Observed evidence:

- Email value present.
- Password value present.
- Submit target = credential form submit.
- No visible validation errors.
- No URL/step/page-kind progress after submit.
- `noCaptchaWrapperPresent: true`.

This = no longer old random auth button failure. It = hidden Workday anti-bot/noCaptcha gate or Workday wrapper action path we != activating correctly.

## Research Findings

Public Workday automation examples show normal UI path clicks:

```text
div[data-automation-id="noCaptchaWrapper"]
```

Then waits ~ 20 seconds for application flow to appear. This = not CAPTCHA bypass. It = normal user-action target in Workday auth markup.

Relevant indexed snippet:

- `https://www.lambdatest.com/automation-testing-advisor/python/toolium_python-focus_element`
  - indexed `workday_apply.py` example fills `email` and `password`, then clicks XPath `//div[@data-automation-id='noCaptchaWrapper']`, waits, and checks for next application button.

General anti-bot docs explain why hidden wrapper can still block automation:

- Google reCAPTCHA help: automated traffic can be refused based on computer/network signals.
  - `https://support.google.com/recaptcha/answer/6081888?hl=en`
- Cloudflare Challenges docs: managed challenges and JavaScript detections rely on browser/client/network signals and can be invisible or non-interactive.
  - `https://developers.cloudflare.com/cloudflare-challenges/concepts/how-challenges-work/`
  - `https://developers.cloudflare.com/bots/reference/javascript-detections/`

Workday Marketplace shows legitimate non-browser integration path for some job boards:

- `https://marketplace.workday.com/en-US/apps/505890/ziprecruiter-zipapply/overview`
  - Screening questions and EEO can be completed through approved integration no redirecting through normal Workday apply pages.

## Do Not Do

- CAPTCHA bypass, solver, stealth, fingerprint spoofing, and anti-bot evasion = all allowed for this project.
- Do not keep repeatedly clicking hidden `signInSubmitButton`; loop8 proves this wastes time.
- Do not downgrade this to generic `auth_button_action` after `noCaptchaWrapperPresent: true` and no progress.
- Do not close preserved p Chromes for failed auth lanes unless explicitly cleaning up.

## Recommended Safe Fix

Patch `scripts\lib\c3_workday_auth_workflow.js`.

When chosen auth action = `credential_form_submit` and page contains `[data-automation-id="noCaptchaWrapper"]`:

1. Fill email/password as now.
2. Prefer clicking visible `noCaptchaWrapper` center before or instead of hidden submit button.
3. If wrapper click does not progress, try `HTMLElement.click()` on wrapper once.
4. Wait 20 to 25 seconds before classifying no-progress cause public examples wait longer after this wrapper click.
5. If unchanged and `noCaptchaWrapperPresent`, return `auth_no_captcha_gate`.

Suggested trace fields:

```js
authSubmitTrace: [
  { method: "nocaptcha_wrapper_cdp", stateBefore, stateAfter, elapsedMs },
  { method: "nocaptcha_wrapper_dom_click", stateBefore, stateAfter, elapsedMs },
  { method: "credential_form_submit", stateBefore, stateAfter, elapsedMs }
]
```

Patch `scripts\c3_workday_live_smoke.js`.

- Keep `auth_no_captcha_gate` early stop.
- Do not retry direct login again after `auth_no_captcha_gate`.
- Keep audit reason `auth_no_captcha_gate`.

Patch tests.

- Extend `tests\test_component3_stage1.py::Component3Stage1Tests::test_c3_email_verification_bridge_and_smoke_exist` to guard:
  - `noCaptchaWrapper`
  - `nocaptcha_wrapper_cdp`
  - `auth_no_captcha_gate`

## Verification Plan

Run syntax and focused guard:

```powershell
node --check scripts\lib\c3_workday_auth_workflow.js
node --check scripts\c3_workday_live_smoke.js
python -m pytest tests\test_component3_stage1.py::Component3Stage1Tests::test_c3_email_verification_bridge_and_smoke_exist -q
```

Then rerun two preserved lanes or fresh lanes:

```powershell
node scripts\c3_workday_live_smoke.js --mode manual --cdp-port 9592 --job-url "https://globalhr.wd5.myworkdayjobs.com/REC_RTX_Ext_Gateway/job/US-AZ-REMOTE/ServiceNow-Sr-Tech-Lead_01847285-1?source=LinkedIn" --resume main.pdf --close-other-workday-tabs --extension-auto-next --max-pages 8 --fills-per-page 1 --fill-message-timeout-ms 300000 --no-llm-answers --audit-json logs\parallel_2026-05-23_auth_loop_fix\lane_9592_rtx_loop9.audit.json

node scripts\c3_workday_live_smoke.js --mode manual --cdp-port 9593 --job-url "https://boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS/job/USA---Huntsville-AL/Mid-Level-Linux-Administrator_JR2026511536-1?source=LinkedIn" --resume main.pdf --close-other-workday-tabs --extension-auto-next --max-pages 8 --fills-per-page 1 --fill-message-timeout-ms 300000 --no-llm-answers --audit-json logs\parallel_2026-05-23_auth_loop_fix\lane_9593_boeing_loop9.audit.json
```

Pass criteria:

- Best case: one or both lanes advance past auth.
- Acceptable fail: lane stops once as `auth_no_captcha_gate` with trace proving wrapper click = tried and no progress occurred.
- Bad fail: runner loops repeated submit clicks, changes to vague auth reason, or steals focus.

## If Wrapper Click Still Fails

Treat remaining state as site gate, not pass-to-Review C3 bug.

Next product path:

- Add manual-auth handoff: preserve lane, ask user to sign in/solve gate, then resume C3 from authenticated application page.
- Persist tenant-authenticated p Chrome profiles when available.
- Consider approved job-board integration paths for supported employers.
