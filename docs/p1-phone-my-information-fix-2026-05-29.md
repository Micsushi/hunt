# P1 My Information Phone Fix 2026-05-29

## High Level

- Primitive: Workday My Information phone controls.
- Status: fixed for tested Revera lane and not reproduced in fresh Coca-Cola
  lane.
- Outcome: Revera reached Review with phone saved as `(780) 492-3111 (Mobile)`.
- Still separate: Coca-Cola later moved to My Experience repeatable rows and
  Skills.

## Failed Sites

| Site | Lane | What failed | Primitive classification |
| --- | ---: | --- | --- |
| Coca-Cola original | 9736 | Posting not found. | Site/posting state |
| Boeing | 9723 | Hidden noCaptcha gate before phone. | Auth gate |
| Revera | 9724 | Phone country committed, later text/session issue. | Text/session, not phone |
| Coca-Cola replacement | 9738 | Phone country committed, other My Information values failed. | Phone/text/select progression |
| Coca-Cola fresh | 9741 | My Information advanced, later blocked on repeat rows and Skills. | Repeatables and Skills |

Rule learned: phone-looking failures can be stale popup focus, text commit,
select commit, site routing, or later repeatables. Classify primitive first.

## Probe Proof

- User-like probe: agents ran real C3 in isolated p Chrome lanes and watched
  phone fields plus repair behavior.
- CDP/Playwright inspect: audits and final UI were captured for phone selected
  state, phone text, validation, and current step.
- Field focused: phone country/device controls and phone number text field after
  stale Workday popup focus was closed.
- Popup/listbox owner: active phone-country/device listbox scoped to the phone
  field owner, not a stale Source popup.
- Option clicked: phone country/device commits were inspected through the active
  phone controls; Revera Review saved Mobile phone state.
- Value saved: Revera final Review showed `(780) 492-3111 (Mobile)`.
- Repair touched: same-field popup close/commit settle, active listbox scoping,
  phone-country option scoping, and selected-state reader.
- Commit proof: Revera final Review showed `(780) 492-3111 (Mobile)`.
- Loop proof: no phone repair/refill loop observed in the successful Revera
  retest. Fresh Coca-Cola did not reproduce My Information phone blocker.

## Root Cause

- Cause: shared Workday popup/listbox focus and selected-state weakness could
  affect phone country and phone type after Source or other prompts.
- Not cause in latest fresh lanes: Coca-Cola's active blocker moved to My
  Experience repeat rows and Skills.

## Code Change

- File: `executioner/src/ats/workday/workday-drivers-v2.js`
- Generic behavior:
  - Escape and blur same-field text/search inputs after popup close/commit.
  - Scope active listbox lookup by owner and proximity to the current field.
  - Scope phone-country option lookup to active phone listbox.
  - Read selected state from Workday prompt selection labels.

## Tests

- `node --check executioner\src\ats\workday\workday-drivers-v2.js`
- `python -m pytest tests\test_component3_prompt.py -k "workday_logs_field_and_dropdown_actions" -q`
- `python -m pytest tests\test_component3_workday_fill.py -k "phone_fields_ignore_stale_source_popup" -q`
- Result: JS check and prompt guard passed. Browser fixture skipped locally
  because Python Playwright was unavailable.

## Actual Extension Retest

| Site | Lane | Result |
| --- | ---: | --- |
| Revera | 9739 | Reached Review, Submit visible, phone `(780) 492-3111 (Mobile)`. |
| Coca-Cola | 9741 | Advanced past My Information. Later blocker: repeat rows and Skills. |

## Artifacts

- `logs/p1_phone_cocacola_fix_2026-05-29/current_debug.md`
- `logs/p1_replacement_widgets_2026-05-29/current_debug.md`
- `logs/p1_regression_retest_2026-05-29/lane_9741_cocacola.audit.json`
- `logs/p1_regression_retest_2026-05-29/final_ui/port_9741.final_ui.txt`
- `logs/p1_replacement_widgets_2026-05-29/lane_9739_revera_postpatch.audit.json`

## Agent Feedback

Next agents should not call all My Information stops "phone bug." Use
`docs/C3_PRIMITIVE_DEBUGGING.md`: classify phone country, phone type, phone
text, province, text commit, or session routing separately. Probe in p Chrome,
then inspect with CDP before patching generic driver behavior.
