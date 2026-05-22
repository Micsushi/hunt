# C3 Parallel Batch

Reusable main-agent protocol for parallel C3 Workday testing. The user prompt
should only name the batch target and any special stop rules. Per-lane subagent
behavior lives in `docs/C3_LANE_AGENT.md`.

## Scope

- Default batch size: five Workday-compatible rows from `wd_test_jobs.csv`.
- Non-Workday hosts are classified separately unless a different harness is
  explicitly requested.
- Run the normal C3 full flow once per lane from the detected page/popup before
  manual/CDP investigation.
- Never click final Submit.
- Reusable launch/reload/seed/capture commands live in
  `docs/C3_TESTING_METHODS.md`.
- Main agent must run `scripts\setup_c3_parallel_lanes.ps1` successfully before
  spawning lane agents.

## Lane Isolation

Each job gets one isolated p Chrome lane:

- Playwright Chromium from `AppData\Local\ms-playwright`, not normal Chrome.
- Separate remote-debugging port.
- Separate fresh batch-specific `ChromeC3PlaywrightParallel...` profile.
- Separate stdout/stderr, audit, console, and debug-log files.
- Hunt extension reachable in that lane.
- Seeded extension profile.
- Runtime reports `browserContext: p_chrome`.
- No blocked extension-root tab such as `<extension-id> is blocked`.

Before testing, verify the lane process command line includes the expected
`ms-playwright` executable, remote-debugging port, profile path, and extension.
The profile path must include the current batch id. Do not reuse old bare
per-port profiles like `ChromeC3PlaywrightParallel_9401` across batches.

## Batch Lifecycle

- A five-job batch has one fixed job set and one fixed subagent set.
- Do not spawn replacement or duplicate subagents for the same jobs while that
  batch is still running.
- Start new subagents only when starting a new job set, replacing a crashed
  agent, or doing a clearly separate post-batch investigation.
- If the same jobs need a fresh p Chrome run, close unused old p Chrome lanes
  for those jobs before launching new ones.
- If a profile is reused intentionally, launch with
  `HUNT_C3_CHROME_RESET_PROFILE=1` so stale extension-disabled state is cleared.
- Do not leave stale p Chrome lanes open after their lane is finished,
  abandoned, or superseded.
- If an extension-root blocked tab appears, close it with
  `scripts\c3_close_blocked_extension_tabs.js` and use the full Options URL or
  setup scripts instead.

## No-Focus Rule

- Place p Chrome windows off the main monitor.
- Use launcher auto-placement or lane-specific window position/size env vars.
- Before launching a fresh lane for the same job, close any unused old lane
  windows so duplicate p Chromes do not pile up on the main monitor.
- Do not use normal Chrome or the user's main Chrome profile for agent testing.
- Do not open visible Terminal, Windows Terminal, PowerShell, cmd, or log-tail
  windows for lanes or helper processes.
- Run helpers from the existing Codex shell or hidden/background processes with
  stdout/stderr redirected to lane log files.
- Do not launch visible helper windows and then move them.

## Subagent Ownership

- Assign one subagent per job/lane from the start.
- Spawn subagents only after `scripts\setup_c3_parallel_lanes.ps1` succeeds for
  every selected lane.
- Each subagent must read and follow `docs/C3_LANE_AGENT.md`.
- Each subagent runs `scripts\c3_workday_live_smoke.js` once for its lane before
  any failure-specific probing.
- Subagents may add narrow proof/probe scripts for new UI behavior, but they
  must not modify C3 product code or the live-smoke runner.
- The main agent coordinates lanes, waits for all lane reports, synthesizes
  findings, proposes code changes, and patches only after user review.

## Current Debug File

- Create one batch-local current debug file before lanes start, for example
  `logs\<batch-id>\current_debug.md`.
- All lane findings go into that file while the batch is active.
- Subagents add or update only their lane section.
- The main agent uses this file as the live issue board while fixing C3.
- When the main agent fixes and verifies an issue, remove that issue from the
  current debug file.
- Keep only unresolved findings, active proof notes, and retest needs in the
  current debug file.
- At the end of the batch, move only durable lessons or final results into a
  focused summary. Do not preserve resolved scratch findings as permanent docs.

## Lane Flow

1. Start from the initial job page and use C3 detection/popup flow when it
   appears. If timing likely missed the prompt, use the extension popup fill
   once.
2. Let the normal C3 full flow try to reach Review.
3. If the lane reaches Review: inspect Review UI and audit for bad fills.
4. If the lane fails: preserve the page when possible, interact with the live UI
   like a user, then use CDP/Playwright to prove the exact behavior C3 needs.
5. Classify the lane as Review, failed, non-Workday, dead posting,
   verification/auth gate, or timeout.

Unknown question or answer type is acceptable only when C3 logs a warning and
continues without bad fill. Unknowns that block progress or create bad fills are
failures.

## Review Answer Triage

When Review exposes a bad fill, classify the fix before proposing code changes:

- Candidate-specific or preference-specific answer: add or reuse a visible
  profile field, then route the question through that profile field.
- Supported question category with new option wording: add matcher aliases,
  neutral/non-disclosure wording, or exact leaf-option matching.
- Missing question category: add a reusable catalog category and focused tests.
- UI failed to commit a correct answer: classify/prove the widget behavior
  before changing drivers.
- Hardcoded/default answer: use only when it is a reusable safe fallback and a
  profile override exists.

Examples from replacement Workday lanes:

- Legal-name prefix is profile-backed by `namePrefix`; blank profile must not
  fall through to `Not Mapped`.
- Accommodation request is profile-backed by `accommodationRequest`; blank
  profile stays neutral and resolves to `No` only for required yes/no prompts
  that need a concrete answer.
- Hourly compensation prompts use explicit/calculated hourly profile data, not
  raw annual salary.

## Error Taxonomy

Every lane owner must classify failures with `docs/C3_ERROR_TAXONOMY.md` before
recommending a fix.

## Spawning Subagents

Spawn prompt must include:

```text
You own lane <lane> for <job>. Read docs/C3_LANE_AGENT.md and
docs/C3_ERROR_TAXONOMY.md before acting. Use docs/C3_TESTING_METHODS.md
lane-agent first-pass order. Setup already passed through
scripts\setup_c3_parallel_lanes.ps1. Use only your assigned isolated p Chrome
lane on port <port>. Do not use normal Chrome. Do not open visible helper
terminals. Do not move/focus windows onto the main monitor. Do not spawn other
agents for this same job. Do not modify C3 code. Write findings to
logs\<batch-id>\current_debug.md under your lane section.
```

## Final Batch Report

The main agent reports only after all lanes reach Review, fail, classify, or
time out, unless there is a safety issue. The final report should include:

- lane result table
- Review correctness issues
- failed-lane root causes
- proven UI behaviors
- new/unclassified error types proposed by subagents
- planned C3 changes for user review
- artifacts directory
