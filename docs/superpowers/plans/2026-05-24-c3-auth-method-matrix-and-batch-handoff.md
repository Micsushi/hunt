# C3 Auth Method Matrix And Batch Handoff 2026-05-24

## Read First

Goal: help next agent continue C3 Workday auth fixes and full-batch testing no redoing investigation.

Project motto: fill completion > fill correctness. Reaching Review = main success. Bad answers on Review = audit issues unless they block flow. Never click final Submit.

Core docs:

- `docs/C3_PARALLEL_BATCH.md`
- `docs/C3_TESTING_METHODS.md`
- `docs/C3_LANE_AGENT.md`
- `docs/C3_ERROR_TAXONOMY.md`

Current auth artifacts:

- `logs/parallel_2026-05-24_auth_method_matrix_all/current_debug.md`
- `logs/parallel_2026-05-24_auth_method_matrix_all/method_matrix_summary_all.json`
- `logs/parallel_2026-05-24_auth_other_methods/current_debug.md`
- `logs/parallel_2026-05-23_auth_rtx_boeing_fix4/current_debug.md`

## Current Auth Conclusion

This = not random tenant luck. C3 can use progress-gated auth submit ladder.

Correct-route matrix result:

| Method | Success | Meaning |
| --- | ---: | --- |
| `A3_dom_target_click` | 7/7 | DOM `.click()` on matched visible submit or `click_filter` |
| `B2_dom_pointer_click_filter` | 7/7 | full DOM pointer/mouse chain on visible `click_filter` |
| `D2_blur_settle_dom_pointer_click_filter` | 7/7 | blur/settle, then full DOM pointer/mouse chain |
| `B3_react_fiber_click_filter` | 6/7 | React handler path, useful but more invasive |
| `E2_nocaptcha_wrapper_then_click_filter` | 6/7 | wrapper click then `click_filter` |
| `A2_form_request_submit` | 3/7 | cheap win on some tenants only |

Meaningful runs:

- RTX: `signin` route
- Boeing: `signup` route
- Amgen: `signup` route
- Thermo: `signup` route
- Cox: `signup` route
- TD: `signup` route
- RBC: `signup` route

RTX `signup` = tested and failed 0/18 cause it = wrong route. RTX needs `Sign in with email`, then credential form submit. Do not interpret RTX signup as submit-method failure.

## Auth Ladder To Keep

C3 must not tenant-sniff. It must try methods in order and verify real progress after each.

Progress signals:

- URL changed
- Workday step changed
- page kind changed out of auth
- visible validation or bad-credential error appeared
- email verification appeared
- My Information or other application step appeared

Suggested runtime order:

1. Fill email, password, verify password when applicable.
2. Commit required terms/privacy checkbox and verify checked state.
3. Try `form.requestSubmit()` cause it = cheap and worked for Boeing, Amgen, RBC.
4. If no progress, try DOM `target.click()` on matched submit or visible `click_filter`. This = broadest first winner.
5. If no progress, run full DOM pointer/mouse sequence on visible `click_filter`. This = robust 7/7 fallback.
6. If no progress, blur/settle and repeat full DOM pointer/mouse sequence on visible `click_filter`.
7. If no progress, try wrapper/hidden-submit fallbacks only as traceable last resorts.
8. Classify `auth_no_captcha_gate` only after all real user-like methods made no URL/step/error/verification progress.

Do not mark JavaScript call as success cause it returned `ok`. Success means page state changed or Workday produced real error/verification state.

## Code Already Changed

Files touched in this auth work:

- `scripts/proofs/workday_auth_fix_approaches_probe.js`
  - added `--independent-variants`
  - creates/opens Workday tab if none exists
  - resets session per method
  - uses fresh plus-alias email per method
  - records method matrix no stopping on first success
- `scripts/lib/c3_workday_auth_workflow.js`
  - verifies progress after `requestSubmit`
  - tries DOM target click after no-progress `requestSubmit`
  - added `dom_pointer_click_filter_after_no_progress`
  - added `delayed_click_filter_cdp_after_no_progress`
  - keeps auth submit trace
- `scripts/c3_workday_live_smoke.js`
  - classifies bad credentials as `auth_bad_credentials`
  - on bad credentials, tries one fresh plus-alias Create Account fallback if visible
- `tests/test_component3_stage1.py`
  - added guard strings for new auth ladder behavior

Verification already run:

```powershell
node --check scripts\lib\c3_workday_auth_workflow.js
node --check scripts\proofs\workday_auth_fix_approaches_probe.js
node --check scripts\c3_workday_live_smoke.js
python -m pytest tests\test_component3_stage1.py::Component3Stage1Tests::test_c3_email_verification_bridge_and_smoke_exist -q
```

## Auth Matrix How To Reproduce

Use fresh p Chrome lanes and independent variants. This is a specific auth
matrix reproduction example, not the rolling-batch policy. Current rolling-batch
capacity comes from the launch prompt.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup_c3_parallel_lanes.ps1 -BatchId parallel_YYYY-MM-DD_auth_method_matrix -Ports "9621,9622,9623,9624,9625,9626,9627" -MaxActiveLanes 7 -AllowLargeBatch -AllowPrimaryMonitor
```

Use `.env` credentials no printing them:

```powershell
$base=(Get-Content .env | Where-Object { $_ -match '^HUNT_C3_TEST_ACCOUNT_EMAIL=' } | Select-Object -First 1) -replace '^HUNT_C3_TEST_ACCOUNT_EMAIL=',''
$pw=(Get-Content .env | Where-Object { $_ -match '^HUNT_C3_TEST_ACCOUNT_PASSWORD=' } | Select-Object -First 1) -replace '^HUNT_C3_TEST_ACCOUNT_PASSWORD=',''
```

Run one matrix per tenant:

```powershell
node scripts/proofs/workday_auth_fix_approaches_probe.js --independent-variants --cdp-port <port> --apply-url "<apply-url>" --mode signup --email $base --password $pw --out logs/<batch-id>/<lane>.signup.matrix.json 1> logs/<batch-id>/<lane>.signup.matrix.stdout.log 2> logs/<batch-id>/<lane>.signup.matrix.stderr.log
```

RTX needs signin mode:

```powershell
node scripts/proofs/workday_auth_fix_approaches_probe.js --independent-variants --cdp-port <rtx-port> --apply-url "<rtx-apply-url>" --mode signin --email $base --password $pw --out logs/<batch-id>/rtx.signin.matrix.json 1> logs/<batch-id>/rtx.signin.matrix.stdout.log 2> logs/<batch-id>/rtx.signin.matrix.stderr.log
```

Close matrix lanes when done:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\close_c3_parallel_lanes.ps1 -Ports "9621,9622,9623,9624,9625,9626,9627"
```

## Tenant Results From This Run

artifacts live in `logs/parallel_2026-05-24_auth_method_matrix_all`.

| Tenant | Route | First winner | Notes |
| --- | --- | --- | --- |
| RTX | signin | `A3_dom_target_click` | Signup route is wrong and fails. Signin route shows real bad-credential/progress state. |
| Boeing | signup | `A2_form_request_submit` | Auth boundary can pass. Remaining blocker after auth is normal form fill. |
| Amgen | signup | `A2_form_request_submit` | Auth can pass to My Information. |
| Thermo | signup | `A3_dom_target_click` in full matrix | Earlier first-success run showed delayed `click_filter` can also reach verification. |
| Cox | signup | `A3_dom_target_click` | Auth can pass to My Information. |
| TD | signup | `A3_dom_target_click` | Auth progresses to tenant login redirect. |
| RBC | signup | `A2_form_request_submit` | Auth can pass to My Information. |

## Current Caveats

- Matrix method success does not mean final full application success. It only proves auth submit mechanics.
- Email verification = expected auth state, not C3 failure if bridge can verify it.
- `auth_bad_credentials` = real result. C3 now tries one fresh plus-alias Create Account fallback where available.
- Do not bypass real CAPTCHA, MFA, or true anti-bot gates. Classify them as site/auth gate after ladder has no progress.
- Avoid normal Chrome. Use p Chrome lanes only.

## Full Batch Testing Handoff

Use rolling queue policy from `docs/C3_PARALLEL_BATCH.md`.

Prompt shape for user-facing batch requests. Put run-specific values here; do
not copy them into the reusable C3 docs:

```text
Run Workday-compatible rows from <csv> using the current C3 rolling-batch policy.

Follow docs/C3_PARALLEL_BATCH.md and docs/C3_TESTING_METHODS.md for main-agent setup. Each lane subagent must follow docs/C3_LANE_AGENT.md and docs/C3_ERROR_TAXONOMY.md.

Run settings:
- rows: Workday-compatible only
- active capacity: <N> lanes/subagents
- stop promotion when CSV is exhausted or hard pre-Review failures reach <N>
- failed-lane probe budget: <N> mutating probe/rescue attempts per lane
- artifact: logs\<batch-id>\current_debug.md
- do not modify C3 code during the batch

After active lanes finish, summarize: Review clean, Review with bad fills, hard pre-Review failures by error type, site/posting stops, and planned fixes with pass-to-Review blockers first.
```

Main-agent setup order:

1. Pick batch id: `parallel_YYYY-MM-DD_<short_name>`.
2. Create `logs\<batch-id>\current_debug.md`.
3. Build assignment table for all rows. Mark queued/active.
4. Pick active Workday rows up to the prompt-provided active capacity.
5. Check active ports:

```powershell
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "chrome.exe" -and
    $_.CommandLine -match "ChromeC3PlaywrightParallel|--remote-debugging-port=9\d\d\d"
  } |
  Select-Object ProcessId, CommandLine
```

6. Setup lanes:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup_c3_parallel_lanes.ps1 -BatchId "<batch-id>" -Ports "<comma-separated-ports>" -MaxActiveLanes <active-capacity>
```

7. Confirm `logs\<batch-id>\lane_setup_summary.json`.
8. Spawn one lane agent per active lane only.
9. Promote queued jobs only when lane report = complete and hard failures remain below the prompt-provided threshold.

## Lane Agent Command Pattern

Use one full-flow run first:

```powershell
$env:HUNT_C3_AUDIT_JSON="logs\<batch-id>\lane_<port>_<slug>.audit.json"
node scripts/c3_workday_live_smoke.js --mode manual --cdp-port <port> --job-url "<job-url>" --resume "main.pdf" --max-pages 8 --fills-per-page 1 --extension-auto-next --no-llm-answers --manual-auth-timeout-ms 0 1> logs\<batch-id>\lane_<port>_<slug>.stdout.log 2> logs\<batch-id>\lane_<port>_<slug>.stderr.log
```

If auth = failure, use auth matrix probe only after normal flow and one live UI check:

```powershell
node scripts/proofs/workday_auth_fix_approaches_probe.js --independent-variants --cdp-port <port> --apply-url "<apply-url>" --mode signup --email $base --password $pw --out logs\<batch-id>\lane_<port>_<slug>.auth_matrix.json 1> logs\<batch-id>\lane_<port>_<slug>.auth_matrix.stdout.log 2> logs\<batch-id>\lane_<port>_<slug>.auth_matrix.stderr.log
```

Use `--mode signin` when tenant route = explicitly email sign-in, such as RTX.

## What Counts As Hard Failure

Hard pre-Review failure:

- C3 had usable application flow.
- C3 did not reach Review/Submit visibility.
- Normal flow plus required investigation = complete.

Not hard failure:

- Review reached with bad fills
- Workday maintenance
- dead or closed posting
- non-application site
- CAPTCHA/MFA/external assessment
- true noCaptcha/manual auth gate after ladder has no progress
- tenant outage

Preserve hard failures and site/posting stops for inspection unless cleanup = allowed.

## Known Next Fix Areas Beyond Auth

Do pass-to-Review blockers first:

- Source / How Did You Hear ~ Us commit and verification
- Skills multiselect search and selected-pill verification
- Education Degree association and repair
- Repeatable blank Work Experience rows
- Workday footer safe-next reconciliation
- Runtime page recovery after auth/save
- Application-question fallback ladder for unknown required dropdowns
- Conditional answers open required follow-up fields

Defer pure answer-quality issues until completion = stable.

## Cleanup

Close completed or superseded p Chrome lanes:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\close_c3_parallel_lanes.ps1 -Ports "<comma-separated-ports>"
```

Check none remain:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "chrome.exe" -and $_.CommandLine -match "ChromeC3PlaywrightParallel" -and $_.CommandLine -notmatch " --type=" } |
  Select-Object ProcessId, CommandLine
```

At end of this auth matrix work, all p Chrome matrix lanes = closed.
