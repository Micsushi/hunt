# C3 P1 Open Issues Research 2026-05-29

This summarizes the research-only subagent pass over preserved p Chrome lanes and
past Workday runs. No C3 product-code changes were made for this documentation
pass.

Use `docs/C3_PRIMITIVE_DEBUGGING.md` for all follow-up work. Do not fix by site
name first. Each item below is a primitive with site evidence.

## Follow-Up Format

For each open issue, future agents must record:

- Primitive:
- Failed sites and lanes:
- User-like p Chrome probe:
- CDP/Playwright inspect:
- Field focused:
- Popup/listbox owner:
- Option clicked:
- Value saved:
- Repair touched:
- Commit proof:
- Loop proof:
- Generic fix area:
- Next-agent feedback:

## Target: Required Skills

Primitive: Workday Skills search multiselect commit.

Current classification: Workday Skills commit failure, not Source.

Best lane: `9740`

- Source committed on My Information as `LinkedIn Job`.
- My Information advanced.
- My Experience stopped on `Type to Add Skills` required validation.
- `#skills--skills` was visible, `aria-required=true`, `aria-invalid=true`.
- No selected skill pill was present.
- The popup could sit on `No Items`; earlier lane `9721` left partial query
  text `TypeScr` with results visible.

Past mistaken assumption: once Target got past My Information, it was easy to
treat the Source/repair-loop issue as the main Target blocker. The current
evidence says Source is improved; Skills is the active blocker.

Likely failure: C3 searches or opens the Workday Skills multiselect but does not
commit a real selected pill. The repeatables/My Experience path times out
without preserving enough skill-attempt evidence.

Next useful work:

- Probe `9740` with the existing Target skills commit proof before code changes.
- Use live p Chrome user-like interaction first: type/select a skill and watch
  selected pill behavior.
- Then use CDP/Playwright inspect: query value, visible rows, click target,
  selected-pill mutation, validation text, repair count.
- Capture query, visible rows, click target, and selected-pill mutation.
- Fix should require selected-pill verification and classify empty required
  Skills as `required_workday_skill_not_committed`, not generic timeout.

Research note: `logs/p1_issue_research_2026-05-29/target_skills.md`

## Coca-Cola: My Experience Repeat Rows

Primitive: Work Experience repeatable row reconciliation.

Current classification: Work Experience row reconciliation failure, with Skills
also unstable. The old My Information phone/province failure did not reproduce
in the fresh lane.

Best lane: `9741`

- Fresh run advanced from My Information to My Experience.
- Work Experience 1 was filled.
- Work Experience 2 remained visible and blank on required fields.
- Skills showed `0 items selected`.
- Resume upload succeeded.
- Runner made bounded repeated attempts, then stopped with
  `page_fill_and_next_timeout`.

Past mistaken assumption: Coca-Cola was still primarily a phone/province commit
issue. That was true for old lane `9738`, but the latest run moved the blocker
to My Experience.

Likely failure: repeatable row identity/state changes while C3 fills/deletes
rows, leaving or recreating a blank required row. The live-smoke runner may also
misroute application pages as auth because Workday keeps document title
`Sign In`, which can lead to unsafe clicks on row-level `Delete` controls.

Next useful work:

- Read-only row-container probe: map row IDs, required controls, delete buttons,
  footer button metadata, and section bounds.
- Use p Chrome preserved lane first. Use CDP only to inspect row ownership and
  button targets before any deletion proof.
- Mutating proof if approved: remove blank Work Experience 2 and click footer
  Save/Continue, then record whether page advances or Skills becomes terminal.
- Fix should verify every visible required work row after fill/delete and
  tighten `looksLikeAuthPage()` so title `Sign In` alone is insufficient.

Research note: `logs/p1_issue_research_2026-05-29/cocacola_experience_rows.md`

## Boeing: Voluntary Disclosures Checkbox

Primitive: required Workday checkbox commit.

Current classification: required checkbox not inventoried/driven. Not current
auth/noCaptcha.

Best lane: `9743`

- Auth passed with `broughtToFrontBeforeAuthSubmit: true`.
- Application reached Voluntary Disclosures.
- Required checkbox
  `termsAndConditions--acceptTermsAndAgreements` stayed unchecked and invalid.
- Save and Continue stayed disabled.
- Narrow CDP click on the checkbox center did not toggle it.

Past mistaken assumption: Boeing should remain in the auth/noCaptcha bucket.
That was true for old lane `9723`, but false for fresh lane `9743`.

Likely failure: after-fill snapshots can see the required checkbox, but the fill
pass had no field inventory/interaction for it, so the generic checkbox driver
never ran. Workday may also need label/wrapper/native setter behavior rather
than plain CDP input click.

Next useful work:

- Probe field collection before fill on Voluntary Disclosures.
- Use user-like p Chrome label/wrapper click first, then CDP inspect of input,
  label, parent wrapper, native checked state, and validation.
- Compare input click, label click, parent wrapper click, native checked setter,
  and keyboard Space.
- Fix should emit required terms/privacy checkboxes into field inventory and
  block footer Next until checked.

Research note: `logs/p1_issue_research_2026-05-29/boeing_disclosure_checkbox.md`

## Visa: Auth noCaptcha Gate

Primitive: Workday auth hidden noCaptcha gate.

Current classification: true Visa Workday noCaptcha/anti-automation gate after
the latest bypass ladder ran.

Best lane: `9742`

- `audit.timeline` persisted two auth attempts.
- `broughtToFrontBeforeAuthSubmit: true` ran both times.
- Credential fill, privacy checkbox hardening, credential refill, form submit,
  hidden submit, noCaptcha wrapper CDP click, wrapper DOM click, and fresh alias
  retry all ran.
- Workday stayed on Create Account/Sign In with no visible errors.

Past mistaken assumption: the bypass may not have run. The old `9722` audit
could not prove it because it did not persist timeline. The new `9742` audit
proves it ran and still failed.

Likely failure: Visa's tenant requires a noCaptcha or anti-automation acceptance
signal not produced by the current submit ladder. This is not Source, not bad
credentials, and not the Boeing background-target bug.

Next useful work:

- Capture network around submit to see whether no request is sent or a server
  rejection occurs.
- Use p Chrome actual lane. Do not loop submits. Test one variable per probe.
- Do not probe true OS-window focus or CDP `Page.bringToFront` unless the user
  explicitly asks to inspect that lane. If no-focus auth still gates, classify
  it as site/auth gate instead of adding foreground behavior.
- Try cookie consent and Sign In route as separate one-variable tests.
- If network shows rejection, keep this as site/CAPTCHA gate and avoid more
  submit-loop churn.

Research note: `logs/p1_issue_research_2026-05-29/visa_auth_nocaptcha.md`

## Priority Order

1. Target Skills: blocks a current P1 lane after Source is fixed.
2. Coca-Cola Experience rows: blocks after My Information now advances.
3. Boeing disclosure checkbox: auth works; post-auth required checkbox remains.
4. Visa auth gate: prove network/focus details, but likely site/manual gate.
