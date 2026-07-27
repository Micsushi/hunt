# C3 Testing Methods

Reusable commands for p Chrome and C3 live testing. Prefer these methods over
ad hoc terminal or CDP snippets.

Start at `docs/C3_PRIMITIVE_DEBUGGING.md` for C3 Workday debugging policy and
the indexed subdocs. This page is only reusable commands.

## Testing Priority

For C3 Workday tests, fill completion is more important than fill correctness.
The runner and lane agents should try to reach Review whenever the UI is usable,
then stop before final Submit. Wrong answers, questionable defaults, and profile
gaps should be captured in Review/audit instead of stopping the flow, unless the
answer creates required follow-up fields, validation, or another blocker.

## Launch Primary P Chrome

```powershell
$env:HUNT_C3_CHROME_START_MINIMIZED = "1"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch_c3_chrome.ps1
Remove-Item Env:\HUNT_C3_CHROME_START_MINIMIZED -ErrorAction SilentlyContinue
```

Defaults:

- DevTools: `http://127.0.0.1:9222`
- profile: Playwright Chromium profile under `%LOCALAPPDATA%\Hunt`
- extension: repo `executioner`
- window: minimized/background requested; secondary monitor only if explicitly
  restored for inspection
- password manager disabled

## Main-Agent Batch Setup Order

Use this order for a rolling queue. Active capacity and hard-failure threshold
come from the main-agent prompt:

1. Create `logs\<batch-id>\current_debug.md`.
2. Inventory all existing p Chrome lane windows and live job-testing tabs.
   Record project, batch, port/profile, job, owner/agent, activity, report,
   evidence, and preserve status.
3. Apply the browser caps before choosing ports: preferred maximum 10, absolute
   non-bypassable maximum 20. At or below 10 use normal checks. Above 10,
   aggressively review and close eligible oldest inactive same-project lanes
   before opening more; never bypass ownership, activity, documentation, or
   preserve gates.
4. For a large batch, create the full assignment table. Mark all jobs queued and
   mark jobs active up to the configured active capacity.
5. Pick active Workday-compatible jobs up to the configured capacity and assign
   unused ports.
6. Do not set up Chrome profiles, windows, tabs, or subagents for queued jobs.
7. Run `scripts\setup_c3_parallel_lanes.ps1` for the selected active ports.
8. Confirm `logs\<batch-id>\lane_setup_summary.json` exists and every lane
   passed preflight.
9. Verify each lane is actually minimized, no p Chrome window became the
   foreground window, and the user's pre-launch foreground application retained
   focus. A smaller visible window fails this check.
10. Spawn one subagent per active lane with `docs/C3_LANE_AGENT.md`,
   `docs/C3_ERROR_TAXONOMY.md`, lane port, job URL, and batch id.
11. When any lane reports, close that subagent thread and update the batch
   counters. Subagents do not close p Chrome. If the hard-failure count is below
   the configured threshold and the 10/20 browser policy permits it, promote the
   next queued job to active on a different unused port, set up one fresh p
   Chrome lane, and spawn one new subagent. If a threshold has been reached,
   stop promoting queued jobs and let already-active lanes finish.

Do not open visible helper terminals. Use the existing Codex shell or hidden
background processes with redirected logs.

For larger requests, do not launch every row at once. Keep a rolling queue with
concurrent lane subagents capped by the main-agent prompt. Open p Chrome lanes
persist past their subagent. They no longer consume subagent capacity after the
terminal report, but they continue to count toward the p Chrome soft/hard caps.
Queued future rows exist only in the debug assignment table until promoted into
a free active slot. A hard failure is only a pre-Review failure: reaching Review
with bad fills still counts as Review reached, not as a hard failure.
Site/posting stops such as Workday maintenance, dead/closed postings,
non-application pages, CAPTCHA/MFA, external assessment, or tenant outage do
not count as hard C3 failures.

Default active capacity is `6` unless the main-agent prompt or future config
sets a lower value. This number comes from Codex subagent capacity, not from C3
product logic, and should not be hardcoded into the C3 command layer.

### Future MCP/Command-Ledger Order

Once `tools/hunt_mcp` and the C3 command bus are available, keep steps 1-6 for
p Chrome setup, then use this control path:

1. Main agent reads `C:\Users\sushi\Documents\hunt-logs\LEDGER_STRUCTURE.md`
   and `active.json`.
2. Main agent creates or selects `agent_id`, `lane_id`, and `session_id` for
   each active p Chrome lane.
3. Subagent claims a session mutation lease through MCP before mutating the
   page.
4. Subagent starts fill/inspect/probe through MCP C3 commands, not direct
   smoke-script workflow control.
5. Subagent may use CDP and temporary probe scripts only through logged command
   paths for its owned session.
6. Subagent reports event ids, command ids, probe ids, and artifact paths.

Current scripts remain useful for launch, preflight, one-off proof, and
compatibility while the command path is landing. New reusable behavior should
move into commands rather than long-lived scripts.

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
9. If it fails, classify primitive first, then probe: user-like p Chrome action
   first, CDP/Playwright inspect second.
10. Record active element, popup/listbox owner, option clicked, committed value,
    validation state, fields touched by repair, and repair-loop count.
11. Write findings to `logs\<batch-id>\current_debug.md`.

## Set Up Parallel Lanes

Use this for normal rolling-batch setup. Replace placeholders with values from
the main-agent prompt:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup_c3_parallel_lanes.ps1 -BatchId "<batch-id>" -Ports "<comma-separated-ports>" -MaxActiveLanes <active-capacity>
```

The setup script:

- must be preceded by the inventory and 10/20 capacity preflight above
- refuses to reuse a port owned by another active Chrome lane/process
- must not be allowed to close a stale selected-port lane until its
  project/owner, inactivity, terminal report/evidence, and preserve status have
  been verified
- uses fresh batch-specific profiles
- resets those profiles by default
- launches each pChrome on a named, unswitched Windows desktop, starts it
  minimized/non-activating, and preserves active-desktop foreground ownership
- restores/cascades windows only when `-RestoreWindows` is explicitly supplied
  for manual inspection
- clamps windows inside the visible secondary-monitor working area
- closes blocked extension-root tabs
- seeds the Workday test profile
- verifies extension target, profile counts, `browserContext: p_chrome`,
  Playwright Chromium, expected port, expected profile, and no blocked tabs
- writes `logs\<batch-id>\lane_setup_summary.json`

Current enforcement gap: `setup_c3_parallel_lanes.ps1` isolates each launched
lane, but it still checks only the new wave, permits `-AllowLargeBatch`, and can
stop a selected stale lane process. The main agent must perform the global
inventory manually, must never use `-AllowLargeBatch` to exceed 20, and must
stop before setup if a selected port has not passed the cleanup gate.

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
monitor and the user explicitly asks to inspect them. It restores and cascades
matching p Chrome windows onto a secondary monitor without closing pages or
changing tabs. Never use it during automated testing; a restored smaller window
is not compliant with the default minimized/no-focus policy.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\move_c3_parallel_windows.ps1 -Monitor right
```

Optional filters:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\move_c3_parallel_windows.ps1 -BatchId "parallel_2026-05-22_last20_wd_rows22_41"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\move_c3_parallel_windows.ps1 -Ports "9461,9462,9463,9464,9465"
```

## Main-Agent Cleanup

Only the main agent closes p Chrome, and only while preparing to start more
testing when capacity or exact port/profile reuse requires cleanup. Do not close
lanes merely because a subagent, job, wave, patch, or retest finished.

Before cleanup:

1. Inventory every p Chrome lane and job-testing tab.
2. Confirm the candidate belongs to Hunt and identify its batch, port/profile,
   job, and prior agent.
3. Verify it is inactive. If it may still be running, check the owning
   agent/thread and current progress. If work stopped, determine and document
   why.
4. Verify a terminal success/failure/site-stop report and its evidence paths.
5. Confirm there is no user preserve instruction and no active investigation
   still needs the page.
6. Write a closure receipt containing identity, result, prior agent state,
   report/evidence paths, reason, and timestamp.

At or below 10, use these normal checks and normally keep existing lanes. Above
10, apply the same checks aggressively to eligible oldest inactive same-project
lanes and close as many as practical to return to 10 or fewer. Never allow
existing plus proposed lanes or job-testing tabs to exceed 20. Never close
other-project, active, user-preserved, undocumented, or uncertain lanes.

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

Until the close script validates reports and writes closure receipts itself,
the main agent must perform and record those checks before running it. Prefer
explicit ports; use a batch selector only after verifying every matched lane.

## Launch One Isolated Lane Manually

Use this only for focused manual work or when debugging the setup script itself.
Set lane-specific env vars before launching:

```powershell
$batchId="parallel_2026-05-21_first5"
$env:HUNT_C3_CHROME_REMOTE_DEBUGGING_PORT="9401"
$env:HUNT_C3_CHROME_PROFILE="$env:LOCALAPPDATA\Hunt\ChromeC3PlaywrightParallel_${batchId}_9401"
$env:HUNT_C3_CHROME_WINDOW_POSITION="2200,80"
$env:HUNT_C3_CHROME_WINDOW_SIZE="1400,1000"
$env:HUNT_C3_CHROME_START_MINIMIZED="1"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch_c3_chrome.ps1
Remove-Item Env:\HUNT_C3_CHROME_START_MINIMIZED -ErrorAction SilentlyContinue
```

Only omit `HUNT_C3_CHROME_START_MINIMIZED` when the user explicitly asks to
inspect the restored secondary-monitor window.

Use a new profile name for every batch. Do not reuse bare per-port profiles
such as `ChromeC3PlaywrightParallel_9401` across batches because Chrome can keep
stale extension-disabled state and restore blocked extension tabs.

If you intentionally need to reuse a parallel profile name, reset it first:

```powershell
$env:HUNT_C3_CHROME_RESET_PROFILE="1"
$env:HUNT_C3_CHROME_START_MINIMIZED="1"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch_c3_chrome.ps1
Remove-Item Env:\HUNT_C3_CHROME_RESET_PROFILE -ErrorAction SilentlyContinue
Remove-Item Env:\HUNT_C3_CHROME_START_MINIMIZED -ErrorAction SilentlyContinue
```

For background helpers, use the existing Codex shell or `Start-Process
-WindowStyle Hidden` with stdout/stderr redirected. Do not open visible helper
terminals.

## Emergency Clean Up Stale Parallel Lanes

There is no ownership-blind emergency cleanup. Use this process list only to
inventory dedicated parallel p Chrome candidates that cannot yet be matched by
batch id or active ports:

```powershell
$stale = Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -match 'ChromeC3PlaywrightParallel' -or
    $_.CommandLine -match '--remote-debugging-port=9\d\d\d'
  }
$stale | Select-Object ProcessId, CommandLine
```

Do not terminate these processes from this broad list. Resolve exact
project/batch/port/profile ownership, agent activity, terminal documentation,
evidence, and preserve state first. If ownership or documentation remains
uncertain, preserve the lane and use a different port or stop before the hard
cap. After a candidate passes the cleanup gate, preview and close it through
`scripts\close_c3_parallel_lanes.ps1` with an explicit port.

Do not launch a new p Chrome lane for the same job until the old lane is safely
closed or a different unused port is selected. Fresh lanes must still be
actually minimized and non-activating.

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
