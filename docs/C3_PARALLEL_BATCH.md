# C3 Parallel Batch

Reusable main-agent protocol for parallel C3 Workday testing. The user prompt
should only name the batch target and any special stop rules. Per-lane subagent
behavior lives in `docs/C3_LANE_AGENT.md`.

## Priority

C3 batch testing optimizes for fill completion over fill correctness. Reaching
Review is the primary success criterion; final Submit remains blocked. Wrong or
questionable answers on Review are recorded as audit issues, not treated as
reasons to stop early, unless they prevent reaching Review by creating
validation or unsupported required follow-up fields.

## Token Budget Policy

Use terse/caveman-lite lane reporting. No narrative logs. Paste only decisive
evidence, not full audit or console output. Prefer artifact paths. If Review is
reached, do not deep-investigate bad fills. If a lane fails, do one live UI probe
and one focused CDP/Playwright proof max, then report root cause or
`needs_deeper_probe`.

## Scope

- Default active capacity: up to six Workday-compatible rows from the selected
  CSV at once.
- Large batch requests are a rolling queue. Launch up to six p Chrome
  lanes/subagents, then start the next queued job as soon as one lane has
  finished analysis, written its report, captured artifacts, and closed its
  p Chrome.
- Hard active-lane limit: no more than six p Chrome lanes and six lane
  subagents at once.
- Hard failure stop rule: stop promoting new queued jobs once the batch has five
  hard failures. A hard failure means the lane did not reach Review/Submit
  visibility after the normal C3 flow and required failure investigation. A lane
  that reaches Review with bad fills, questionable answers, stale audit
  warnings, or Review-quality issues is not a hard failure.
- Non-C3/site/posting states do not count as hard failures: Workday
  maintenance, dead/closed posting, non-application site, CAPTCHA/MFA,
  external assessment, tenant outage, or a posting that never exposes an
  application flow. Classify them separately as `site_or_posting_state` or the
  closest taxonomy type.
- Already-active lanes may finish and report after the fifth hard failure, but
  the main agent must not launch additional queued jobs for that batch unless
  the user explicitly overrides the stop rule.
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

- Create the full large-batch assignment table first. Mark all jobs queued, then
  mark up to six jobs active.
- Set up Chrome only for active jobs. Do not pre-create profiles, windows, tabs,
  or subagents for queued future jobs.
- When a lane reaches Review, it must capture final UI/audit/console artifacts,
  write its report to `current_debug.md`, close its assigned p Chrome, and
  return. The main agent then closes the completed subagent thread and starts
  the next queued job immediately if capacity is available and the batch has
  fewer than five hard failures.
- When a lane hard-fails before Review or stops on a non-C3/site/posting state,
  preserve that p Chrome after capture so the user can inspect it. Do not close
  it unless the main agent or user explicitly says cleanup is allowed. Preserved
  lanes still free no capacity; after they are reported, the main agent may
  launch the next queued job on a different unused port only while the hard
  failure count is below five.
- Do not wait for all active lanes to finish before launching the next queued
  job. Keep the active lane count at or below six.
- After every lane report, update the batch counters: `review_reached`,
  `review_reached_with_bad_fills`, `hard_failures`, and `other_non_review`
  such as dead posting, external assessment, CAPTCHA/MFA, or non-Workday.
  Stop new promotions when `hard_failures >= 5`.
- Do not spawn replacement or duplicate subagents for the same job while that
  job's lane is still active.
- Start a new subagent only when a queued job is promoted into a free active
  slot, replacing a crashed agent, or doing a clearly separate post-batch
  investigation.
- If the same jobs need a fresh p Chrome run, close unused old p Chrome lanes
  for those jobs before launching new ones.
- If a profile is reused intentionally, launch with
  `HUNT_C3_CHROME_RESET_PROFILE=1` so stale extension-disabled state is cleared.
- Do not leave stale p Chrome lanes open after Review lanes, abandoned lanes, or
  superseded successful lanes. Preserve hard-failure and site/posting-state
  lanes for inspection until the user or main agent explicitly cleans them up.
  Use `scripts\close_c3_parallel_lanes.ps1` with explicit ports for cleanup.
- If an extension-root blocked tab appears, close it with
  `scripts\c3_close_blocked_extension_tabs.js` and use the full Options URL or
  setup scripts instead.
- If old p Chrome windows are off-screen, restore them with
  `scripts\move_c3_parallel_windows.ps1` instead of relaunching duplicate lanes.

## No-Focus Rule

- Place p Chrome windows off the main monitor.
- Use launcher auto-placement or lane-specific window position/size env vars.
  The setup script must verify a secondary monitor and keep every window inside
  the visible working area. Do not tile lanes downward beyond the desktop.
- During setup, p Chrome lanes launch minimized and stay in the background by
  default. Do not restore/cascade windows during automated batches. Use
  `scripts\move_c3_parallel_windows.ps1` or `setup_c3_parallel_lanes.ps1
  -RestoreWindows` only when the user explicitly wants to inspect the lane.
- `scripts\c3_workday_live_smoke.js` must not use `Page.bringToFront` during
  batch runs. The opt-in `--bring-to-front` flag is for manual debugging only.
- Before launching a fresh lane for the same job, close any unused old lane
  windows so duplicate p Chromes do not pile up on the main monitor.
- Do not use normal Chrome or the user's main Chrome profile for agent testing.
- Do not open visible Terminal, Windows Terminal, PowerShell, cmd, or log-tail
  windows for lanes or helper processes.
- Run helpers from the existing Codex shell or hidden/background processes with
  stdout/stderr redirected to lane log files.
- Do not launch visible helper windows and then move them.

## Subagent Ownership

- Assign one subagent per active job/lane. For large batches, assign queued jobs
  in the table from the start, but spawn only when a job becomes active.
- Spawn subagents only after `scripts\setup_c3_parallel_lanes.ps1` succeeds for
  every selected lane.
- Never spawn more than six lane subagents at once. For larger user requests,
  use one batch id and one `current_debug.md` assignment table unless the user
  asks to split the work.
- Each subagent must read and follow `docs/C3_LANE_AGENT.md`.
- Each subagent runs `scripts\c3_workday_live_smoke.js` once for its lane before
  any failure-specific probing.
- Each subagent closes its p Chrome lane after a Review result. Each subagent
  preserves its p Chrome after a hard pre-Review failure or non-C3/site/posting
  stop unless the main-agent prompt explicitly permits cleanup.
- The main agent owns rolling-queue coordination: when a subagent reports and
  closes its p Chrome, close that subagent thread and launch the next queued
  lane if any remain.
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

Required unknown question or answer type should use the progress-first fallback
policy when C3 can identify and interact with the UI. The goal is to complete
the full run to Review as often as possible, even when the fallback answer may
be wrong. For unknown required option prompts, choose neutral/non-disclosure or
prefer-not-to-answer wording first, then `No`, then the first real
non-placeholder option. Record the question, visible options, chosen fallback,
and reason as Review/audit evidence.

Unknowns that still block progress are UI interaction, matching, or fallback
pipeline failures unless the site itself blocks the flow. Bad fallback fills on
Review are still failures to fix, but they are Review-quality bugs rather than
pre-Review stop policy. Final Submit remains blocked.

For the next pass of C3 fixes, prioritize only issues that stop C3 before
Review: identifier/auth startup races, Skills/catalog no-match loops, Workday
widget commit failures, repeatable rows, conditional answers that open
unsupported required follow-ups, AI-consent misclassification, and footer
progression. Defer pure answer-quality improvements until completion is stable.

## Review Answer Triage

When Review exposes a bad fill, classify the fix before proposing code changes:

- Candidate-specific or preference-specific answer: add or reuse a visible
  profile field, then route the question through that profile field.
- Supported question category with new option wording: add matcher aliases,
  neutral/non-disclosure wording, or exact leaf-option matching.
- Missing question category: add a reusable catalog category and focused tests,
  but keep the progress-first fallback path working until the category is
  explicit.
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
agents for this same job. After you finish analysis, capture required
artifacts, write your report, close only your assigned p Chrome lane, and
return. Do not modify C3 code. Write findings to
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
- planned C3 changes for user review, grouped as pass-to-Review blockers first
  and answer-quality/audit-only issues second
- artifacts directory
