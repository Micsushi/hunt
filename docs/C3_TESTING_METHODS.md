# C3 Testing Methods

Reusable commands for p Chrome and C3 live testing. Prefer these methods over
ad hoc terminal or CDP snippets.

## Testing Priority

For C3 Workday tests, fill completion is more important than fill correctness.
The runner and lane agents should try to reach Review whenever the UI is usable,
then stop before final Submit. Wrong answers, questionable defaults, and profile
gaps should be captured in Review/audit instead of stopping the flow, unless the
answer creates required follow-up fields, validation, or another blocker.

## Launch Primary P Chrome

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch_c3_chrome.ps1
```

Defaults:

- DevTools: `http://127.0.0.1:9222`
- profile: Playwright Chromium profile under `%LOCALAPPDATA%\Hunt`
- extension: repo `executioner`
- window: secondary monitor when available
- password manager disabled

## Main-Agent Batch Setup Order

Use this order for a rolling queue. Active capacity and hard-failure threshold
come from the main-agent prompt:

1. Create `logs\<batch-id>\current_debug.md`.
2. For a large batch, create the full assignment table. Mark all jobs queued and
   mark jobs active up to the configured active capacity.
3. Pick active Workday-compatible jobs up to the configured capacity and assign
   unused ports.
4. Do not set up Chrome profiles, windows, tabs, or subagents for queued jobs.
5. Run `scripts\setup_c3_parallel_lanes.ps1` for the selected active ports.
6. Confirm `logs\<batch-id>\lane_setup_summary.json` exists and every lane
   passed preflight.
7. Spawn one subagent per active lane with `docs/C3_LANE_AGENT.md`,
   `docs/C3_ERROR_TAXONOMY.md`, lane port, job URL, and batch id.
8. When any lane reports, close that subagent thread and update the batch
   counters. Review lanes should close their p Chrome. Hard pre-Review failures
   and non-C3/site/posting stops should preserve their p Chrome for user
   inspection. If the hard-failure count is below the configured threshold,
   promote the next queued job to active on a different unused port, set up one
   fresh p Chrome lane, and spawn one new subagent. If the threshold has been
   reached, stop promoting queued jobs and let already-active lanes finish.

Do not open visible helper terminals. Use the existing Codex shell or hidden
background processes with redirected logs.

For larger requests, do not launch every row at once. Keep a rolling queue with
active p Chrome lanes/subagents capped by the main-agent prompt. Queued future
rows exist only in the debug assignment table until promoted into a free active
slot. A hard failure is only a pre-Review failure: reaching Review with bad
fills still counts as Review reached, not as a hard failure.
Site/posting stops such as Workday maintenance, dead/closed postings,
non-application pages, CAPTCHA/MFA, external assessment, or tenant outage do
not count as hard C3 failures.

Before picking ports, inspect active p Chrome lane owners and avoid any ports
already used by another batch:

```powershell
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "chrome.exe" -and
    $_.CommandLine -match "ChromeC3PlaywrightParallel|--remote-debugging-port=9\d\d\d"
  } |
  Select-Object ProcessId, CommandLine
```

## Lane-Agent First-Pass Order

Subagents should use this order for their assigned lane:

1. Verify `/json/list` for the assigned port.
2. Confirm Playwright Chromium, lane profile, extension target, seeded profile,
   and `browserContext: p_chrome`.
3. Open the assigned job URL.
4. Wait for the C3 detection prompt.
5. If the prompt appears, click it and start fill.
6. If the prompt likely timed out, open the extension popup and click fill once.
7. If detection should have happened but did not, classify with
   `docs/C3_ERROR_TAXONOMY.md`.
8. Run `scripts\c3_workday_live_smoke.js` once as the full-flow runner.
9. Write findings to `logs\<batch-id>\current_debug.md`.

## Set Up Parallel Lanes

Use this for normal rolling-batch setup. Replace placeholders with values from
the main-agent prompt:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup_c3_parallel_lanes.ps1 -BatchId "<batch-id>" -Ports "<comma-separated-ports>" -MaxActiveLanes <active-capacity>
```

The setup script:

- refuses to set up more than the configured active-lane limit unless
  `-AllowLargeBatch` is supplied for intentional launcher debugging
- refuses to reuse a port owned by another active Chrome lane/process
- closes stale p Chrome lanes on the selected ports
- uses fresh batch-specific profiles
- resets those profiles by default
- launches Playwright Chromium minimized during setup and leaves it in the
  background by default
- restores/cascades windows only when `-RestoreWindows` is explicitly supplied
  for manual inspection
- clamps windows inside the visible secondary-monitor working area
- closes blocked extension-root tabs
- seeds the Workday test profile
- verifies extension target, profile counts, `browserContext: p_chrome`,
  Playwright Chromium, expected port, expected profile, and no blocked tabs
- writes `logs\<batch-id>\lane_setup_summary.json`

Fresh p Chrome launch already loads the current unpacked extension. Do not
reload during normal setup. Use `-ReloadExtension` only for focused launcher
debugging, because reload can invalidate an already-open Options tab.

Do not spawn subagents until this setup command succeeds for every selected
active lane.

If setup fails because another batch owns a port, choose unused ports. Do not
kill or overwrite another active batch unless the user explicitly asks for
cleanup.

## Move Existing P Chrome Windows Back On-Screen

Use this when old p Chrome windows were launched off-screen or onto the wrong
monitor. It restores and cascades matching p Chrome windows onto a secondary
monitor without closing pages or changing tabs:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\move_c3_parallel_windows.ps1 -Monitor right
```

Optional filters:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\move_c3_parallel_windows.ps1 -BatchId "parallel_2026-05-22_last20_wd_rows22_41"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\move_c3_parallel_windows.ps1 -Ports "9461,9462,9463,9464,9465"
```

## Close Completed Lane

Use this after an individual Review lane has reported, proof artifacts are
captured, and no preserved live UI is still needed. Do not close hard-failure or
site/posting-stop lanes until the user or main agent explicitly allows cleanup.
In rolling batches, lane agents close Review lanes only. The main agent can run
the same command as a backstop before promoting the next queued job.

Preview first:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\close_c3_parallel_lanes.ps1 -BatchId "<batch-id>" -DryRun
```

Then close only that lane or matching batch lanes:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\close_c3_parallel_lanes.ps1 -BatchId "<batch-id>"
```

Or close explicit ports:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\close_c3_parallel_lanes.ps1 -Ports "9401"
```

## Launch One Isolated Lane Manually

Use this only for focused manual work or when debugging the setup script itself.
Set lane-specific env vars before launching:

```powershell
$batchId="parallel_2026-05-21_first5"
$env:HUNT_C3_CHROME_REMOTE_DEBUGGING_PORT="9401"
$env:HUNT_C3_CHROME_PROFILE="$env:LOCALAPPDATA\Hunt\ChromeC3PlaywrightParallel_${batchId}_9401"
$env:HUNT_C3_CHROME_WINDOW_POSITION="2200,80"
$env:HUNT_C3_CHROME_WINDOW_SIZE="1400,1000"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch_c3_chrome.ps1
```

Use a new profile name for every batch. Do not reuse bare per-port profiles
such as `ChromeC3PlaywrightParallel_9401` across batches because Chrome can keep
stale extension-disabled state and restore blocked extension tabs.

If you intentionally need to reuse a parallel profile name, reset it first:

```powershell
$env:HUNT_C3_CHROME_RESET_PROFILE="1"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch_c3_chrome.ps1
Remove-Item Env:\HUNT_C3_CHROME_RESET_PROFILE -ErrorAction SilentlyContinue
```

For background helpers, use the existing Codex shell or `Start-Process
-WindowStyle Hidden` with stdout/stderr redirected. Do not open visible helper
terminals.

## Emergency Clean Up Stale Parallel Lanes

Prefer `scripts\close_c3_parallel_lanes.ps1` for normal lane cleanup. Use this
manual process list only when abandoning old lanes that cannot be matched by
batch id or active ports. It targets only dedicated parallel p Chrome
profiles, not normal Chrome:

```powershell
$stale = Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -match 'ChromeC3PlaywrightParallel' -or
    $_.CommandLine -match '--remote-debugging-port=9\d\d\d'
  }
$stale | Select-Object ProcessId, CommandLine
$stale | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Do not launch a new p Chrome lane for the same job until the old lane is
closed. Fresh lanes must still use off-main-monitor window placement.

## Verify DevTools Target

```powershell
Invoke-RestMethod http://127.0.0.1:9222/json/list
Invoke-RestMethod http://127.0.0.1:9401/json/list
```

Expected lane process:

- executable path includes `ms-playwright`
- command line has the expected remote-debugging port
- profile path includes `ChromeC3PlaywrightParallel`
- profile path includes the current batch id, not just the port
- Hunt extension target is reachable

## Reload Extension

```powershell
python scripts\reload_c3_extension.py --port 9222
python scripts\reload_c3_extension.py --port 9401
```

If reload cannot find the extension target, open the C3 Options page only by
running `scripts\configure_c3_debug_sink.js` or by navigating to the full
Options URL:

```text
chrome-extension://<extension-id>/src/options/options.html
```

Do not open `chrome-extension://<extension-id>`, the background/service-worker
URL, or a bare extension target URL as a page. Chromium blocks those with
`ERR_BLOCKED_BY_CLIENT`.

## Close Blocked Extension Tabs

If a p Chrome lane shows `<extension-id> is blocked`, close the bad tab:

```powershell
node scripts\c3_close_blocked_extension_tabs.js --port 9401
```

This cleanup targets only blocked extension-root error tabs. It does not close
Workday pages or the real C3 Options page.

## Seed Or Inspect Extension Profile

```powershell
node scripts\configure_c3_debug_sink.js --port 9222 --seed-workday-profile
node scripts\configure_c3_debug_sink.js --port 9401 --seed-workday-profile
node scripts\configure_c3_debug_sink.js --port 9401 --inspect-only
```

Profile counts should show nonzero Work Experience, Education, Skills, and
Websites before Workday full-flow tests.

## Run Workday Full Flow

```powershell
node scripts\c3_workday_live_smoke.js --mode manual --cdp-port 9401 --job-url "<Workday URL>" --resume main.pdf --close-other-workday-tabs --extension-auto-next --audit-json "logs\<batch-id>\lane_9401.audit.json"
```

`c3_workday_live_smoke.js` is the stable end-to-end runner. It should open or
reuse the lane, seed/resume through C3, let C3 move page-by-page toward Review,
stop before final Submit, and write audit JSON. It should not contain temporary
CDP repairs for individual UI failures.

Use `--stop-after-fill` only for focused current-page debugging, not the first
full-flow pass.

## Detection Prompt Probe

```powershell
node scripts\c3_detected_prompt_flow_probe.js --cdp-port 9401 --job-url "<Workday URL>" --resume main.pdf
```

Use when checking whether the in-page detection prompt appears and can start the
flow.

## Capture Final UI

```powershell
node scripts\c3_capture_final_ui.js --ports 9401 --out-dir "logs\<batch-id>\final_ui"
```

## Collect Console Logs

```powershell
node scripts\c3_collect_console_logs.js --ports 9401 --out-dir "logs\<batch-id>\console"
```

## Failed Lane Proof

```powershell
node scripts\c3_failed_lane_ui_proof.js --cdp-port 9401 --scenario "<short-name>" --out "logs\<batch-id>\lane_9401.proof.json"
```

Use only after live UI interaction identifies the likely behavior to prove. The
dispatcher above exists for old scenario aliases. Prefer the narrow scripts
below for new investigations.

Failed-lane probe budget comes from the main-agent prompt. The normal C3
full-flow run does not count against that budget. Read-only inspection,
snapshot, audit, or console capture does not count. A probe attempt is a
mutating UI/CDP action or script that tries to clear the blocker, prove a
commit path, or rescue progress. The first mutating probe should be live
UI/user-like. Later attempts may use focused CDP/Playwright proof or rescue
scripts. Each attempt must test a new hypothesis and preserve an artifact path.
Stop early if Review is reached, root cause is proven, the page becomes unsafe
to mutate, or the next attempt would repeat the same evidence. When the budget
is exhausted, preserve the lane and report `needs_deeper_probe`.

| Behavior to prove | Script |
| --- | --- |
| Disclosure dropdown commits a chosen option | `scripts\proofs\workday_disclosure_dropdown_proof.js` |
| Checkbox or radio commits from visible label | `scripts\proofs\workday_checkbox_label_proof.js` |
| Email sign-in entry button works | `scripts\proofs\workday_email_signin_entry_proof.js` |
| Required prompt/search input commits an option | `scripts\proofs\workday_required_search_select_proof.js` |
| Phone country code commits Canada `(+1)` | `scripts\proofs\workday_phone_country_commit_proof.js` |
| Source prompt commits a safe source option | `scripts\proofs\workday_source_select_proof.js` |
| Split date section commits month/day/year | `scripts\proofs\workday_date_section_commit_proof.js` |
| Legal name fields commit typed values | `scripts\proofs\workday_name_input_commit_proof.js` |
| Visible validation after safe Next/Save click | `scripts\proofs\workday_visible_validation_clear_proof.js` |

Examples:

```powershell
node scripts\proofs\workday_disclosure_dropdown_proof.js --cdp-port 9401 --question-regex "veteran status" --option-regex "DON'?T WISH|Not Declared" --out "logs\<batch-id>\lane_9401.veteran.proof.json"
node scripts\proofs\workday_required_search_select_proof.js --cdp-port 9401 --field-regex "citizenship" --search-text "Canada" --option-regex "Canada" --out "logs\<batch-id>\lane_9401.citizenship.proof.json"
node scripts\proofs\workday_phone_country_commit_proof.js --cdp-port 9401 --out "logs\<batch-id>\lane_9401.phone_country.proof.json"
```

Each proof script has one narrow purpose: inspect current UI, perform the
minimal user-like CDP interaction, and write proof JSON. Keep proof scripts
separate from the live-smoke runner unless the behavior becomes a generalized
C3 fix.

If no existing proof script matches a failed lane, the lane agent may create a
new narrow proof/probe script under `scripts\proofs` or a lane-local one-off
snippet. New scripts should prove one behavior only and must not patch C3
product code or hide the failure from the batch result.

## Mail And Verification

```powershell
node scripts\c3_mail_verify_bridge.js --check-auth --provider imap
node scripts\c3_email_verification_smoke.js --provider fake --cdp-port 9222
```

Real mailbox credentials belong in local env vars or `.env`, never chat.
