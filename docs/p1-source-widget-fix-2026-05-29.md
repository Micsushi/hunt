# P1 Source Widget Fix 2026-05-29

## High Level

- Primitive: Workday Source prompt.
- Status: fixed for tested Target and Revera lanes.
- Outcome: fresh actual-extension p Chrome runs reached Review with Submit.
- Still separate: Target Skills, Visa auth gate, Boeing disclosure checkbox,
  Coca-Cola repeatable rows.

## Failed Sites

| Site | Lane | What failed | Primitive classification |
| --- | ---: | --- | --- |
| Target | 9721 | Later stopped on Skills. Source had selected value evidence. | Skills, not Source |
| Visa | 9722 | Hidden noCaptcha gate before Source. | Auth gate |
| Boeing | 9723 | Hidden noCaptcha gate before Source. | Auth gate |
| Revera | 9724 | Source selected safe value, later text/session issue. | Text/session, not Source |

Rule learned: site name is not bug. Source was only the suspected primitive.
Agents must classify the primitive before patching.

## Probe Proof

- User-like probe: lane agents ran normal C3 in isolated p Chrome and observed
  the live pages.
- CDP/Playwright inspect: agents captured final UI, audit, console, and
  current page state. Source-reachable lanes showed selected Source values.
- Field focused: Workday Source/search input focus was the inspected failure
  surface; fix blurs same-field inputs after popup close/commit.
- Popup/listbox owner: active Workday popup/listbox scoped to the same field by
  owner/proximity, not stale page/footer text.
- Option clicked: Target saved `LinkedIn Jobs`; Revera saved
  `Corporate Website`.
- Value saved: final Review UI showed the saved Source values above.
- Repair touched: same-field popup close/commit settle, input blur, active
  listbox scoping, and selected-state reader.
- Commit proof: post-fix final UI showed Target Source `LinkedIn Jobs` and
  Revera Source `Corporate Website`.
- Loop proof: no infinite Source repair/refill loop observed. Reached pages had
  bounded retry indexes.

## Root Cause

- Cause: C3 popup close/settle only blurred the primary field element. Workday
  Source can keep a sibling search/text input focused. C3 also missed some
  Workday selected-state labels.
- Not cause in tested lanes: Target's active blocker was Skills, Visa/Boeing
  were auth gates, Revera's old later failure was not Source.

## Code Change

- File: `executioner/src/ats/workday/workday-drivers-v2.js`
- Generic behavior:
  - Escape and blur same-field Workday text/search inputs on popup close.
  - Blur same-field inputs during commit settle.
  - Read selected state from `promptSelectionLabel` and
    `promptAriaInstruction`.
  - Ignore placeholder selected text such as `0 items selected`.

## Tests

- `node --check executioner\src\ats\workday\workday-drivers-v2.js`
- `python -m pytest tests\test_component3_stage1.py -k "workday_source" -q`
- Result: passed.

## Actual Extension Retest

Fresh p Chrome lanes loaded the changed unpacked extension.

| Site | Lane | Result |
| --- | ---: | --- |
| Target | 9731 | Reached Review, Submit visible, Source `LinkedIn Jobs`. |
| Revera | 9732 | Reached Review, Submit visible, Source `Corporate Website`. |

## Artifacts

- `logs/p1_source_widget_fix_2026-05-29/current_debug.md`
- `logs/p1_source_widget_postfix_2026-05-29/lane_9731_target.audit.json`
- `logs/p1_source_widget_postfix_2026-05-29/lane_9732_revera.audit.json`
- `logs/p1_source_widget_postfix_2026-05-29/final_ui/port_9731.final_ui.txt`
- `logs/p1_source_widget_postfix_2026-05-29/final_ui/port_9732.final_ui.txt`

## Agent Feedback

Next agents should not reopen Source as a site-specific Target/Revera bug
unless new proof shows Source failing again. Use
`docs/C3_PRIMITIVE_DEBUGGING.md`: classify primitive, p Chrome first, user-like
probe first, CDP inspect second, patch generic behavior, retest actual
extension.
