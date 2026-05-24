# Auth Fix

## Purpose

This doc records the C3 Workday auth/noCaptcha investigation, what each probe proved, which fixes were tried, why the standalone probe diverged from full C3, and the final Boeing auth fix.

Short version: the auth method itself was not random. The missing C3-specific piece was page activation. Standalone probes ran against an active Workday page. Full C3 could submit from a background p Chrome target. Boeing noCaptcha submit needed the Workday page brought to front before the credential submit ladder.

## Final Current Status

- Boeing: C3 now passes auth by default.
- Boeing proof: `logs\source_boeing_auto_front_fix_2026-05-24\lane_9633_boeing.stdout.log`.
- Boeing audit: `logs\source_boeing_auto_front_fix_2026-05-24\lane_9633_boeing.audit.json`.
- Final Boeing state in audit: My Experience, step 3 of 8.
- Auth trace proof in stdout: `broughtToFrontBeforeAuthSubmit: true`.
- Source proof in stdout: My Information showed `How Did You Hear About Us?* 1 item selected, LinkedIn`.
- RTX: auth routing still uses the correct `SignInWithEmailButton` path. The later RTX rerun reached the email sign-in form but showed empty-field validation in one limited max-page run, so the final Boeing fix did not prove a new RTX full pass. Prior RTX proof still stands: email sign-in route is correct, and credential rejection must be classified separately from noCaptcha.

## Other Six Auth-Risk Tenant Retest

Batch: `logs\auth_fix_other6_2026-05-24`.

Run shape: full C3 live smoke, fresh p Chrome lanes, max two pages, no final Submit, fresh plus-alias per lane.

| Tenant | Lane | Outcome |
| --- | --- | --- |
| RTX signin | 9635 | Correct signin route and submit path ran. Credential submit logged `broughtToFrontBeforeAuthSubmit: true`, then Workday returned `You may have entered the wrong email address or password or your account might be locked.` Not noCaptcha. |
| Amgen signup | 9636 | Auth passed to My Information and continued to My Experience. |
| Thermo signup | 9637 | Create-account submit worked and reached email verification. IMAP bridge opened verification link, but post-verify returned to Create Account/Sign In. Verification-continuation issue, not noCaptcha submit failure. |
| Cox signup | 9638 | Auth passed to My Information and continued to My Experience. |
| TD signup | 9639 | Create-account submit worked and reached email verification. IMAP bridge opened verification link, but post-verify returned to Create Account/Sign In. Verification-continuation issue, not noCaptcha submit failure. |
| RBC signup | 9640 | Auth passed to My Information and continued to My Experience. |

Summary: after the Boeing active-page fix, no retested tenant stopped as `auth_no_captcha_gate`. Amgen, Cox, and RBC passed auth to application pages. Thermo and TD need verification-continuation follow-up. RTX needs real account/credential handling, not a noCaptcha click fix.

## Verification Continuation Fix

Batch: `logs\auth_verify_login_retry_2026-05-24`.

Thermo and TD showed the same post-activation behavior:

1. C3 created the account.
2. Workday required email verification.
3. IMAP opened the verification link.
4. Workday redirected back to the original apply URL.
5. Page showed Create Account/Sign In again with no verification error.
6. C3 needed to sign in with the now-verified account.

Patch:

- `scripts\c3_workday_live_smoke.js` now records `verifiedAccountLoginRequiredByScope` after `auth_verification_link_opened` if the post-verification page is still auth.
- `routeAfterSignupAttempt()` then forces the next route to login mode and marks it with `verifiedAccountRetryAsLogin: true`.
- Timeline records `postVerificationLogin.reason = verified_account_returned_to_auth_require_login`.

Retest:

| Tenant | Lane | Outcome |
| --- | --- | --- |
| Thermo | 9641 | Passed. Verification opened, returned to auth, forced login, reached My Information, continued to My Experience. |
| TD | 9642 | Passed. Verification opened, returned to auth, forced login, reached My Information, continued to My Experience. |

This confirms the intended behavior: activation link verifies the account, then C3 signs in again on the original application flow and continues.

## Main Files Changed

- `scripts\lib\c3_workday_auth_workflow.js`
  - Added progress-gated submit ladder behavior from prior auth work.
  - Added checkbox-row overlap handling for Boeing privacy checkbox.
  - Added refilling and checkbox re-sync after a noCaptcha primer click.
  - Added hidden-submit and click-filter fallbacks after no-progress submit attempts.
  - Final fix: calls `Page.bringToFront` before credential submit ladders when Workday `noCaptchaWrapper` is present.
- `scripts\c3_workday_live_smoke.js`
  - Added extension storage readiness before seeding options.
  - Added typed bad-credential handling and fresh plus-alias create-account fallback from prior auth work.
- `tests\test_component3_stage1.py`
  - Added regression guards for auth ladder behavior and the bring-to-front hook.
- `scripts\proofs\workday_auth_fix_approaches_probe.js`
  - Probe used to compare submit approaches independently across tenants.

## Workday noCaptcha Mental Model

Workday auth pages can expose a visible submit wrapper and a hidden real submit button:

```html
<div data-automation-id="noCaptchaWrapper">
  <div role="button" data-automation-id="click_filter"></div>
  <button type="submit" data-automation-id="createAccountSubmitButton" aria-hidden="true">
    Create Account
  </button>
</div>
```

Important pieces:

- `noCaptchaWrapper`: Workday wrapper around the submit path.
- `click_filter`: visible human-click layer.
- `createAccountSubmitButton` or `signInSubmitButton`: hidden submitter.
- `form.requestSubmit()`: plain browser form submit path.

The bug class: C3 treated a JavaScript method returning `ok` as success even when the page did not move. Correct behavior is progress-gated: after each submit attempt, C3 must check URL, step, page kind, visible errors, verification state, or app-page transition.

## Probe Findings Before Final Fix

### Submit Variants Tested

Probe script: `scripts\proofs\workday_auth_submit_click_variants_probe.js`.

Artifacts:

- RTX: `logs\parallel_2026-05-23_auth_rtx_boeing_fix4\lane_9610_rtx.click_variants.proof.json`.
- Boeing Create Account: `logs\parallel_2026-05-23_auth_rtx_boeing_fix4\lane_9611_boeing.click_variants.proof.json`.
- Boeing Sign In link switch: `logs\parallel_2026-05-23_auth_rtx_boeing_fix4\lane_9611_boeing.signin_link_probe.json`.
- Boeing Sign In submit: `logs\parallel_2026-05-23_auth_rtx_boeing_fix4\lane_9611_boeing.signin_click_variants.proof.json`.

Variants tested:

- CDP click visible `click_filter`.
- CDP offset click.
- Focus wrapper plus Space.
- Focus wrapper plus Enter.
- Full DOM pointer/mouse sequence on wrapper.
- `form.requestSubmit()`.
- DOM `target.click()`.
- CDP click `noCaptchaWrapper`.
- Tab until submit, then Enter.

Findings:

- RTX: full DOM pointer/mouse sequence on visible `click_filter` advanced to My Information.
- RTX: generic Sign In route is unsafe because it can route to Google. Use `SignInWithEmailButton`.
- Boeing Create Account: early variants did not advance in the preserved full-C3 lane.
- Boeing Sign In link itself worked, but sign-in credentials could still produce real bad-credential state.

### Entry Method Probe

Probe script: `scripts\proofs\workday_auth_entry_method_probe.js`.

Artifacts:

- RTX email sign-in: `logs\parallel_2026-05-23_auth_rtx_boeing_fix4\lane_9606_rtx.entry_methods.signin.proof.json`.
- Boeing Create Account: `logs\parallel_2026-05-23_auth_rtx_boeing_fix4\lane_9602_boeing.entry_methods.signup.proof.json`.
- Boeing Sign In: `logs\parallel_2026-05-23_auth_rtx_boeing_fix4\lane_9611_boeing.entry_methods.signin.proof.json`.

Findings:

- RTX email sign-in: native setter and DOM-focus `Input.insertText` both submitted. Workday returned `You may have entered the wrong email address or password or your account might be locked.` That means submit mechanics worked, but credentials were rejected.
- Boeing Sign In: similar result. Submit mechanics worked, credentials rejected.
- Boeing Create Account: checkbox was not the core blocker. It could be committed. The form could be valid. But the full C3 path still did not advance.
- CDP coordinate typing became unreliable after scroll. DOM focus before `Input.insertText` was more reliable in probes.

### Fix Approaches Probe

Probe script: `scripts\proofs\workday_auth_fix_approaches_probe.js`.

Important Boeing artifact:

- `logs\source_boeing_alias_retest_2026-05-24\lane_9626_boeing.fix_approaches_after.json`.

Important result:

- Boeing standalone probe winner: `A2_form_request_submit`.
- Result: advanced from Create Account to My Information.

This created the important contradiction:

- Probe: Boeing passed with `form.requestSubmit()`.
- Full C3: Boeing still stopped at `auth_no_captcha_gate`.

That contradiction was the real unresolved bug.

## Full Method Matrix Findings

Primary handoff: `docs\superpowers\plans\2026-05-24-c3-auth-method-matrix-and-batch-handoff.md`.

Matrix artifact directory:

- `logs\parallel_2026-05-24_auth_method_matrix_all`.

Correct-route success rates:

| Method | Result | Meaning |
| --- | ---: | --- |
| `A3_dom_target_click` | 7/7 | DOM `.click()` on matched visible submit or `click_filter` |
| `B2_dom_pointer_click_filter` | 7/7 | full DOM pointer/mouse chain on visible `click_filter` |
| `D2_blur_settle_dom_pointer_click_filter` | 7/7 | blur and settle, then full DOM pointer/mouse chain |
| `A2_form_request_submit` | 3/7 | cheap win on some tenants |

Tenants/routes:

- RTX: signin route.
- Boeing: signup route.
- Amgen: signup route.
- Thermo: signup route.
- Cox: signup route.
- TD: signup route.
- RBC: signup route.

Key conclusion: not lottery. C3 should use a progress-gated ladder and stop at first real page progress.

## C3 Fix Attempts Before Final Root Cause

These were tried because each matched a plausible probe finding. They helped instrumentation and narrowed the issue, but they did not fully fix Boeing full C3 until page activation was added.

### Attempt 1: Progress-check `requestSubmit`

Change:

- After `form.requestSubmit()`, C3 inspects page state.
- If URL, step, page kind, verification, or errors do not change, C3 continues to another method.

Why:

- `requestSubmit()` returning `ok` does not mean Workday accepted auth.

Result:

- Correct architectural fix.
- Not enough by itself for Boeing full C3.

### Attempt 2: Target DOM click after no-progress submit

Change:

- If `requestSubmit()` makes no progress, try `target.click()`.

Why:

- Matrix showed `A3_dom_target_click` was a broad winner.

Result:

- Needed for other tenants.
- Not enough by itself for Boeing full C3.

### Attempt 3: DOM pointer chain on visible `click_filter`

Change:

- After no-progress target click, dispatch pointer and mouse events on visible `click_filter`.

Why:

- RTX proof showed DOM pointer/mouse sequence advanced.
- Matrix showed `B2_dom_pointer_click_filter` was 7/7.

Result:

- Needed generalized fallback.
- Not enough by itself for Boeing full C3.

### Attempt 4: Blur-settle then DOM pointer chain

Change:

- Blur active element.
- Wait for Workday validation state to settle.
- Repeat DOM pointer/mouse chain on `click_filter`.

Why:

- Workday validation can lag behind input events.
- Matrix showed `D2_blur_settle_dom_pointer_click_filter` was 7/7.

Result:

- Useful fallback.
- Not enough by itself for Boeing full C3.

### Attempt 5: Hidden submit fallback after no-progress submit

Change:

- Try hidden `createAccountSubmitButton` or `signInSubmitButton` after no-progress request submit.

Why:

- Boeing proof had shown direct hidden submit could move page in one focused scenario.

Result:

- Useful last-resort trace.
- Not sufficient by itself in full C3.

### Attempt 6: Checkbox-row overlap detection

Change:

- Detect when C3's chosen `click_filter` point overlaps the Boeing privacy checkbox row.
- Avoid treating privacy-row clicks as submit fallbacks.

Why:

- Some Boeing full-C3 runs clicked the privacy checkbox row and produced `Please check the box to continue`.

Result:

- Fixed a real false path.
- Not the final auth pass.

### Attempt 7: Refill credentials after noCaptcha primer

Change:

- If C3 uses a noCaptcha primer click, refill email/password/verify password.
- Re-sync privacy checkbox with native checked setter.

Why:

- Some click/filter/checkbox sequences can disturb field or checkbox state.

Result:

- Helpful hardening.
- Not the final auth pass.

### Attempt 8: Wait after `form.requestSubmit`

Change:

- If `requestSubmit()` returned `ok` with noCaptcha wrapper present, wait 3500 ms before deciding no progress.

Why:

- Workday can transition slowly.

Result:

- Good guard.
- Not the final auth pass.

### Attempt 9: Options-page storage readiness

Change:

- `scripts\c3_workday_live_smoke.js` waits for extension storage APIs before seeding extension options.

Why:

- Some runs crashed on options setup with storage unavailable.

Result:

- Fixed setup hazard.
- Not the final auth issue.

## Final Root Cause: Probe vs C3 Difference

Working probe and failing full C3 were not equivalent.

Probe conditions:

- Standalone script connected to a Workday page target.
- Probe navigated and tested on an active browser page.
- Boeing `A2_form_request_submit` advanced to My Information.

Full C3 failing conditions:

- C3 batch lanes can run minimized/background p Chrome.
- C3 opened/options-seeded via extension and then drove the Workday page through CDP.
- The Workday auth submit ladder could run while the target page was not fronted.
- Boeing noCaptcha auth did not reliably advance from a background target.

Minimal proof:

1. Run C3 with existing `--bring-to-front`.
2. Boeing passed auth and reached My Information.
3. Patch auth workflow to call `Page.bringToFront` before noCaptcha credential submit.
4. Run default C3 without `--bring-to-front`.
5. Boeing passed auth and advanced to My Experience.

This proved the missing delta was not the tenant, not the password fields, not Source, and not only submit method order. It was active-page state at the Workday noCaptcha auth boundary.

## Final Patch

Location:

- `scripts\lib\c3_workday_auth_workflow.js`.

Core logic:

```js
const shouldBringAuthPageToFront =
  shouldDeferPrimaryCdpClick &&
  Boolean(result.noCaptchaWrapperPresent || result.noCaptchaWrapper?.present);
if (shouldBringAuthPageToFront) {
  try {
    await this.pageClient.send("Page.bringToFront");
    result.broughtToFrontBeforeAuthSubmit = true;
    await this.sleep(250);
  } catch (error) {
    result.broughtToFrontBeforeAuthSubmit = false;
    result.bringToFrontBeforeAuthSubmitError = String(error?.message || error);
  }
}
```

Why scoped this way:

- It only runs for credential-submit flows where noCaptcha wrapper is present.
- It does not front every fill page.
- It preserves background batch behavior for ordinary form pages.
- It records a trace field so future audits can prove whether the hook ran.

## Final Verification

Static checks:

```powershell
node --check scripts\lib\c3_workday_auth_workflow.js
node --check scripts\c3_workday_live_smoke.js
python -m pytest tests\test_component3_stage1.py::Component3Stage1Tests::test_c3_email_verification_bridge_and_smoke_exist -q
```

Live Boeing verification:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup_c3_parallel_lanes.ps1 -BatchId source_boeing_auto_front_fix_2026-05-24 -Ports "9633" -MaxActiveLanes 1

$base=(Get-Content .env | Where-Object { $_ -match '^HUNT_C3_TEST_ACCOUNT_EMAIL=' } | Select-Object -First 1) -replace '^HUNT_C3_TEST_ACCOUNT_EMAIL=',''
$pw=(Get-Content .env | Where-Object { $_ -match '^HUNT_C3_TEST_ACCOUNT_PASSWORD=' } | Select-Object -First 1) -replace '^HUNT_C3_TEST_ACCOUNT_PASSWORD=',''
$parts=$base.Split('@')
$alias="$($parts[0])+c3boeing$(Get-Date -Format 'HHmmss')@$($parts[1])"
$env:HUNT_C3_AUDIT_JSON='logs\source_boeing_auto_front_fix_2026-05-24\lane_9633_boeing.audit.json'

node scripts\c3_workday_live_smoke.js --mode manual --cdp-port 9633 --job-url "https://boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS/job/USA---Huntsville-AL/Mid-Level-Linux-Administrator_JR2026511536-1" --resume "main.pdf" --max-pages 2 --fills-per-page 1 --extension-auto-next --no-llm-answers --manual-auth-timeout-ms 0 --account-email $alias --account-password $pw 1> logs\source_boeing_auto_front_fix_2026-05-24\lane_9633_boeing.stdout.log 2> logs\source_boeing_auto_front_fix_2026-05-24\lane_9633_boeing.stderr.log
```

Observed:

- Exit code: `0`.
- Top-level reason: `max_pages_before_terminal`, expected because run stopped after `--max-pages 2`.
- Final page: My Experience, step 3 of 8.
- No `auth_no_captcha_gate`.
- Stdout includes `broughtToFrontBeforeAuthSubmit: true`.
- Stdout includes My Information Source as `LinkedIn`.

## What Not To Regress

- Do not classify `auth_no_captcha_gate` just because a method returned `ok`.
- Do not click generic RTX Sign In when `SignInWithEmailButton` exists.
- Do not treat Workday wrong-password text as noCaptcha. Use `auth_bad_credentials`.
- Do not click final Submit in live smokes.
- Do not remove the progress-gated ladder. Some tenants need methods later than `requestSubmit`.
- Do not remove `Page.bringToFront` for noCaptcha credential submit without proving background p Chrome works on Boeing again.

## Remaining Non-Auth Issues Seen During Boeing Runs

These are not the auth bug, but they appear after auth succeeds:

- My Information fields can still generate review/manual-review items.
- Source must be verified by selected pill/text, not just audit intent.
- Later page runs may stop because the smoke was intentionally capped by `--max-pages`.
- Review-quality issues should be handled as normal C3 fill/review work, not as noCaptcha/auth work.

## Next Agent Checklist

1. Read this doc.
2. Read `docs\superpowers\plans\2026-05-24-c3-auth-method-matrix-and-batch-handoff.md` for full matrix/batch protocol.
3. For any auth failure, first check whether `broughtToFrontBeforeAuthSubmit` appears in stdout/audit.
4. If it does not appear on a noCaptcha credential submit, inspect route classification and `noCaptchaWrapperPresent`.
5. If it appears but auth fails, inspect per-method `authSubmitTrace` and visible Workday errors before changing code.
6. If a page reaches My Information, stop calling it auth. Debug form fill separately.
