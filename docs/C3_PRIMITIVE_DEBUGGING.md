# C3 Workday Debugging Start

Start here for C3 Workday failures. This page owns the canonical rules. Subdocs
add detail, but should not redefine process.

## Doc Index

- `docs/C3_PRIMITIVE_DEBUGGING.md`: this start page, canonical rules, and fix
  template.
- `docs/C3_LANE_AGENT.md`: subagent lane role and report shape.
- `docs/C3_PARALLEL_BATCH.md`: main-agent rolling batch orchestration.
- `docs/C3_TESTING_METHODS.md`: p Chrome setup, runner, capture, proof, and
  cleanup commands.
- `docs/C3_ERROR_TAXONOMY.md`: failure and Review-quality classification.
- `docs/C3_TESTING_RUNBOOK.md`: broader C3 test layering and older operator
  context.

Fix records and open issues (one primitive each):

- `docs/auth-fix.md`: Workday auth/noCaptcha primitive investigation and fix.
- `docs/p1-source-widget-fix-2026-05-29.md`: Source prompt primitive fix.
- `docs/p1-phone-my-information-fix-2026-05-29.md`: My Information phone
  primitive fix.
- `docs/c3-p1-open-issues-research-2026-05-29.md`: open primitives (Skills,
  repeat rows, disclosure checkbox, Visa auth gate) with next steps.

When changing C3 Workday debugging policy, update this page first, then update
only the subdoc sections that directly implement that policy.

## Rule

One bug means one primitive first:

- Source prompt
- Skills multiselect
- Phone country selectinput
- Phone device type listbox
- Text input commit
- Repeatable rows
- Required checkbox
- Auth gate
- Apply-entry or session routing
- Unknown required option fallback

Sites are evidence. The primitive is the fix target.

## Flow

1. Classify primitive.
2. Launch fresh isolated p Chrome lanes for failed sites.
3. Use one agent per bug or per failed site when lanes can run independently.
4. Run normal C3 once with the actual extension.
5. If it fails, preserve lane and probe behavior.
6. First probe like a user in live p Chrome.
7. Then use CDP or Playwright to inspect DOM, focus, selected state, listbox
   ownership, validation, and backing values.
8. Write proof before code change.
9. Patch generic C3 driver behavior, not tenant-specific labels.
10. Add a local fixture or static guard for the primitive.
11. Retest actual extension in fresh p Chrome.
12. Document result and feed findings back to the next agent.

## P Chrome Rules

- Use p Chrome actual extension for C3 proof.
- Keep p Chrome off the main monitor, minimized/backgrounded when possible, and
  never steal focus.
- Do not use `Page.bringToFront`, Playwright `page.bringToFront()`,
  `--bring-to-front`, restore/cascade, or focus-moving browser actions unless
  the user explicitly asks to inspect the lane.
- User-like probe means using realistic clicks/typing/keyboard paths through
  CDP/Playwright without activating the OS window.
- Subagents never close p Chrome. They capture artifacts, report, and leave the
  lane for the main agent.
- Main agent closes p Chrome only after the C3 change is patched, local checks
  pass, fresh p Chrome retest is done, and no further inspection is needed, or
  when the user explicitly asks for cleanup.
- Main agent may also close a passing Review-reached lane mid-batch once its
  page is no longer needed. This is the main agent's judgment call, not a
  requirement.
- Preserve hard failures and site/auth/posting gates until the main agent has
  used them or the user permits cleanup. Do not close these on discretion.

## Agent Pattern

Use subagents when sites are independent:

- One primitive, multiple failed sites: one lane agent per site.
- One bug with many hypotheses: one agent probes live UI, one reads audit/logs,
  main agent owns code patch.
- Do not let subagents edit product code.
- Each agent owns one p Chrome lane and writes only its lane report.
- Main agent synthesizes, patches once, retests with actual extension, then
  closes no-longer-needed p Chrome lanes.

## Required Proof

Every fix doc must record:

- Primitive: UI type being fixed.
- Sites: lanes used as evidence.
- Pre-fix behavior: what failed and what did not reproduce.
- Probe: user-like action first, then CDP/Playwright evidence.
- Audit proof: what field focused, what popup/listbox owned the options, what
  option was clicked, what value saved, and what repair touched.
- Root cause: field focus, option ownership, commit path, validation, routing,
  auth, or answer mapping.
- Code fix: generic behavior changed.
- Tests: local fixture or static guard.
- Live proof: fresh p Chrome, actual extension, final result.
- Loop check: whether repair/refill repeated and how many attempts occurred.
- Remaining issues: separate primitives only.

## Fix Doc Template

```text
# P1 <Primitive> Fix <Date>

## High Level
- Primitive:
- Status:
- Outcome:
- Still separate:

## Failed Sites
| Site | Lane | What failed | Primitive classification |
| --- | ---: | --- | --- |

## Probe Proof
- User-like probe:
- CDP/Playwright inspect:
- Field focused:
- Popup/listbox owner:
- Option clicked:
- Value saved:
- Repair touched:
- Commit proof:
- Loop proof:

## Root Cause
- Cause:
- Not cause:

## Code Change
- Files:
- Generic behavior:

## Tests
- Commands:
- Result:

## Actual Extension Retest
| Site | Lane | Result |
| --- | ---: | --- |

## Artifacts
- audit:
- final UI:
- console:
```

## Feedback Rule

After each fix:

- Update the fix doc.
- Update `current_debug.md` or close resolved items.
- Update the issue ledger or smallest vault status page.
- Tell next agent which primitive remains next and which lanes prove it.
