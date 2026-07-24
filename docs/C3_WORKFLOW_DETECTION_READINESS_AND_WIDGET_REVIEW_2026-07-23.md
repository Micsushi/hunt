# C3 workflow detection, readiness, and Workday widget review

Date: 2026-07-23

## Verdict

It is **not yet fair to trust C3 as an end-to-end application navigator**.

The recent 40-job replay supports a narrower statement:

- C3 reached an application-ready page on 29 of 40 current Workday jobs.
- It crossed an authentication boundary on 27 of those 29.
- Two jobs did not require authentication.
- Eleven jobs showed a maintenance/unavailable surface.
- The run intentionally stopped at My Information. It did **not** prove that C3 could fill every page, commit every Workday widget, reach Review, or submit.

The current popup is also not reliable evidence that the current page is an application page. The popup detector runs on every website and can classify an entire ATS host, a broadly job-like URL, or a generic form as an application without proving which page is actually visible.

The right goal is:

> C3 should identify a semantic page state, wait until that state is stable and usable, take one state-appropriate action, verify the resulting state, and stop when progress cannot be proved.

This does not require a fixed page order. It requires a state machine that reevaluates the page after every transition.

## Findings, ordered by severity

### P0 — C3 may deliberately click a Workday Next button marked `aria-disabled`

**Confidence: confirmed directly in code**

`isVisibleEnabled()` correctly rejects `aria-disabled="true"` controls, but `findBestCandidate()` separately gathers disabled Workday footer buttons and uses one when no enabled candidate exists. It labels this path `ariaDisabledBypass`.

Source:

- `executioner/src/background/safe-next.js:153`
- `executioner/src/background/safe-next.js:426`
- `executioner/src/background/safe-next.js:444`
- `executioner/src/background/safe-next.js:468`
- `executioner/src/background/safe-next.js:507`

In simple terms: Workday is saying “Next is not ready,” and C3 has a fallback that may try to click it anyway.

This can produce several symptoms:

- C3 clicks while a required dropdown has not committed.
- Nothing happens, so C3 tries another click method.
- Validation appears after the click and C3 starts a repair pass.
- A still-loading page is mistaken for a failed navigation.

**Required fix**

- Never bypass `disabled`, `aria-disabled`, or `pointer-events: none` during normal page walking.
- Only click Next after:
  - the page state is stable;
  - the button is visibly enabled;
  - no visible required validation errors remain;
  - every visible required field has either a verified committed value or a terminal, reported failure.
- Click once, then wait for a verified state transition. Do not send Enter/Space fallbacks while a transition may still be in progress.

### P0 — The popup treats “this is an ATS host” as “this is an application”

**Confidence: confirmed directly in code**

The content script is injected on all URLs:

- `executioner/manifest.json:18`
- `executioner/manifest.json:32`

The popup classifier then:

- checks ATS hosts with substring matching, `host.includes(pattern)`;
- returns `kind: "ats"` for any recognized ATS host even when it has not found an application surface;
- displays `Detected job application` for both `ats` and `application`;
- also accepts broad career/job URL and button-text combinations;
- also accepts a generic page with three controls and broad words such as application, applicant, candidate, resume, or CV.

Source:

- `executioner/src/content/bootstrap.js:32`
- `executioner/src/content/bootstrap.js:138`
- `executioner/src/content/bootstrap.js:160`
- `executioner/src/content/bootstrap.js:231`
- `executioner/src/content/bootstrap.js:262`
- `executioner/src/content/bootstrap.js:268`
- `executioner/src/content/bootstrap.js:1872`

This explains the false positives. A Workday maintenance page, tenant search page, candidate home, expired posting, or unrelated page on a recognized host can receive the same application popup.

The proposed rule “the URL contains Workday” is useful as one signal but is not sufficient. It proves the site family, not the current page.

**Required fix**

Use exact hostname or hostname-suffix matching, for example:

```text
host === "myworkdayjobs.com"
or
host.endsWith(".myworkdayjobs.com")
```

Do not use a raw substring match because a hostname such as `notworkday.com.example.org` could match.

Then require both:

1. a supported ATS/site identity; and
2. structural evidence for a recognized page state.

Do not show “Detected job application” for `unknown`, `catalog_or_search`, `maintenance`, or `posting_unavailable`.

### P0 — C3 starts filling without a general “page is stable” contract

**Confidence: confirmed directly in code**

C3 has a good partial readiness helper after authentication. It waits for two identical probes and rejects a visible loading indicator:

- `executioner/src/background/index.js:5195`
- `executioner/src/background/index.js:5202`
- `executioner/src/background/index.js:5249`
- `executioner/src/background/index.js:5257`

But that helper is mainly used after authentication or application entry. It is not applied consistently after every application-page Next action.

The field pipeline immediately inventories whatever controls exist at that moment:

- `executioner/src/shared/v2/field-pipeline.js:1178`
- `executioner/src/shared/v2/field-pipeline.js:1210`

Post-Next waits can be only 1.55–2.2 seconds:

- `executioner/src/background/index.js:3180`
- `executioner/src/background/index.js:6461`
- `executioner/src/background/index.js:6538`
- `executioner/src/background/index.js:8423`

For a React application, `document.readyState === "complete"` only means the document loaded. It does not prove that Workday finished rendering, hydrating, loading dropdown choices, or enabling Next.

This directly explains both reported timing cases:

- C3 fills too early and operates on incomplete controls.
- A slow page has no detectable fields yet, so C3 concludes there is nothing to fill or no safe way forward.

**Required fix**

Add one shared readiness gate before every classification-dependent action and after every navigation:

- no visible loading overlay or skeleton;
- semantic page state is unchanged for at least two probes;
- normalized URL, step title, and application identity are stable;
- expected controls for that state exist;
- for an application step, the actionable field inventory is stable for at least two probes;
- the deadline extends when measurable progress occurs, rather than relying on one fixed sleep.

A page that never stabilizes should return a typed result such as:

```text
page_readiness_timeout
last_state=application_step
last_step=My Information
loading_visible=true
field_counts=0,0,3,7
```

That is different from `no_safe_next_button`, a dropdown failure, or an authentication failure.

### P1 — Popup detection and workflow detection are separate classifiers that can disagree

**Confidence: confirmed directly in code**

The popup uses `detectPageKind()` in the content script:

- `executioner/src/content/bootstrap.js:138`

The background runner uses a separate `createC3WorkflowDetectionFunction()`:

- `executioner/src/background/index.js:1077`

The background detector has more detailed authentication logic, but its page-state vocabulary is still incomplete. Its major phases are effectively:

- `loading`
- `apply_entry`
- `auth`
- `job_fill`

It defaults to `job_fill` before that has been proven:

- `executioner/src/background/index.js:1317`

It does not have first-class states for:

- job posting/details;
- apply-method choice;
- maintenance;
- posting closed/not found;
- catalog/search/candidate home;
- review.

In simple terms: the popup and the runner can look at the same page, apply different rules, and tell different stories.

**Required fix**

Create one shared classifier contract used by both the popup and the page walker:

| State | Minimum proof | Allowed next action |
|---|---|---|
| `unknown` | No other state has enough evidence | Wait, report, or request manual review |
| `job_posting` | Supported host/path plus job title/details and a job-specific Apply action | Click Apply |
| `apply_choice` | Apply-method controls such as Apply Manually or Apply with Resume | Choose configured method |
| `auth_landing` | Account choice actions, but no complete credential form | Choose Sign In or Create Account |
| `signin_form` | Visible email/password login structure | Fill and submit sign-in |
| `signup_form` | Visible account-creation fields | Fill and submit sign-up |
| `email_verification` | Explicit email verification instructions | Stop with verification-required result |
| `application_step` | Stable application step plus actionable application controls | Fill verified fields, then safe Next |
| `review` | Review step/final-submit evidence | Stop for review; never auto-submit |
| `catalog_or_search` | Search/listing/candidate-home structure without a job-specific application | Do not prompt as application |
| `maintenance` | Maintenance/unavailable structure | Report maintenance |
| `posting_unavailable` | Closed, removed, expired, or job-not-found structure | Report unavailable posting |

Each detection should return its evidence, not only a label:

```json
{
  "state": "application_step",
  "confidence": 0.97,
  "evidence": [
    "workday_host_suffix",
    "progress_step:My Information",
    "visible_application_fields:12"
  ],
  "negativeEvidence": [],
  "stableProbeCount": 2
}
```

### P1 — Existing loop detection only understands authentication transitions

**Confidence: confirmed directly in code**

C3 already records authentication transitions and detects repeating suffixes with periods one through four:

- `executioner/src/background/index.js:7045`
- `executioner/src/background/index.js:7137`
- `executioner/src/background/index.js:7281`

It also has bounded safety limits:

- 12 page-walk pages: `executioner/src/background/index.js:50`
- 3 same-page auth attempts: `executioner/src/background/index.js:52`
- a validation repair key set: `executioner/src/background/index.js:7402`

However, the transition signature contains authentication states and the chosen auth control. It does not record the full sequence:

```text
signin_form -> apply_choice -> application_step -> signin_form
```

That means the proposed cross-page loop is not reliably identified as one explainable loop. C3 may eventually stop because a broad attempt limit was reached, but the resulting reason is less accurate.

**Required fix**

Record every stable semantic transition:

```text
state
+ normalized URL path
+ step title
+ job/application identity
+ action taken
```

Keep the last 12 transitions. Stop with `workflow_cycle_detected` when the same cycle of two to four states repeats three times without new progress.

Only count stable states. Do not let transient `loading` snapshots create a fake loop.

This permits Workday tenants to skip or reorder pages while still catching a real cycle.

### P1 — A fill run can be `ok: true` while required widget problems still need review

**Confidence: confirmed directly in code**

The field pipeline marks `manualReviewRequired` when warning, blocked, or error issues exist, but still returns `ok: true`:

- `executioner/src/shared/v2/field-pipeline.js:1546`
- `executioner/src/shared/v2/field-pipeline.js:1550`
- `executioner/src/shared/v2/field-pipeline.js:1560`

Page-walk eligibility only requires the fill response to be `ok` and not cancelled/runtime-failed:

- `executioner/src/background/index.js:6718`

The safe-Next precheck treats only `blocked` and `error` issues as hard blockers:

- `executioner/src/background/safe-next.js:1`
- `executioner/src/background/safe-next.js:13`

Many required Workday widget commit failures are warnings. Therefore, C3 can report manual review is needed and still proceed toward Next.

**Required fix**

Separate these results:

- `fill_completed`: all required visible fields have verified values;
- `fill_partial`: optional fields or permitted review items remain;
- `fill_blocked`: at least one required field is unverified;
- `fill_failed`: runtime or driver failure.

Safe Next should require `fill_completed` or an explicit policy-approved `fill_partial`. A required dropdown with `workday_commit_not_verified` must be `fill_blocked`.

### P1 — Workday dropdown verification accepts weak evidence

**Confidence: confirmed design flaw; exact dominant failure varies by tenant**

Workday dropdowns have at least five different states:

1. text was typed into the search box;
2. an option is highlighted;
3. an option was clicked;
4. a selected pill/backing value was committed;
5. validation cleared.

C3 currently accepts several weak signals:

- If an option element disappears from the DOM, `workdaySelectionEvidence()` returns true. A React rerender or popup close can remove the option without saving it.
- `aria-activedescendant` can count as evidence. That normally means “highlighted/focused,” not necessarily “selected and committed.”
- `workdayCommittedState()` can treat human-readable button or sibling-input text as selected. That text may only be the search text.

Source:

- `executioner/src/ats/workday/workday-drivers-v2.js:3059`
- `executioner/src/ats/workday/workday-drivers-v2.js:3065`
- `executioner/src/ats/workday/workday-drivers-v2.js:3100`
- `executioner/src/ats/workday/workday-drivers-v2.js:3150`

The commit fallback sends Enter, Escape, and blur, then waits a fixed 240 ms:

- `executioner/src/ats/workday/workday-drivers-v2.js:3106`

Popup closing is aggressive: Escape is sent to several targets three times and the inputs are blurred:

- `executioner/src/ats/workday/workday-drivers-v2.js:2284`

This can make a visually selected option disappear before Workday finishes committing it.

**Required fix**

Use a two-phase widget protocol:

1. **Choose**
   - open the popup owned by this exact field;
   - wait for its options to stabilize;
   - click the intended option once.
2. **Commit and prove**
   - wait until the owned popup closes or changes state;
   - require an in-field selected pill, backing value, or selected-item structure matching the intended value;
   - require the search input not to be the only matching text;
   - require `aria-invalid`/field validation to clear;
   - rescan after a short stable interval and confirm the value is still present.

Do not treat a disconnected option or active descendant alone as success.

### P1 — Failed widgets can be retried across multiple mechanisms

**Confidence: confirmed directly in code**

The field pipeline runs up to three passes:

- `executioner/src/shared/v2/field-pipeline.js:1265`

A field identity is marked processed only after it was successfully filled:

- `executioner/src/shared/v2/field-pipeline.js:1518`

If another field was filled during a pass, a failed widget may be seen again on the next rescan. After Next exposes validation, the background page walker also allows a keyed repair attempt:

- `executioner/src/background/index.js:7402`
- `executioner/src/background/index.js:8157`
- `executioner/src/background/index.js:8335`
- `executioner/src/background/index.js:8504`

This is bounded, not literally infinite, but it looks like C3 is trying the same dropdown again and again. React rerenders can also change a selector/identity and weaken the duplicate-attempt guard.

**Required fix**

Give each semantic field a primitive-specific retry budget:

- one normal attempt;
- one retry only if new evidence appeared, such as a newly loaded option list or changed popup owner;
- otherwise stop with a typed, field-specific failure.

The retry key should use stable field meaning—step, label/question hash, Workday automation ID, and application identity—not a fragile generated selector alone.

### P1 — Skills can exceed the per-field time budget and may select an unrelated fallback

**Confidence: strong code-based diagnosis; needs a fresh failing lane to measure frequency**

For a required Skills field, C3 appends ten generic fallback skills and permits up to ten attempts:

- `executioner/src/ats/workday/workday-drivers-v2.js:637`

The default total timeout for one field is 15 seconds:

- `executioner/src/shared/v2/field-pipeline.js:21`
- `executioner/src/shared/v2/field-pipeline.js:26`

Each skill attempt can open/search options, wait for a virtualized list, click, verify a pill, and close the popup. Ten such attempts cannot reliably fit in the same 15-second budget.

If no exact match is found, the code may choose the first non-category, non-empty option:

- `executioner/src/ats/workday/workday-drivers-v2.js:720`

That can select an unrelated skill and then fail verification against the requested skill. A partial React pill is not fully covered by the basic timeout rollback.

**Required fix**

- Only select exact or explicitly approved normalized matches.
- Do not choose the first unrelated option.
- Use a small ranked set from the actual résumé/profile, not ten generic fallbacks.
- Give multi-value Skills its own operation budget, with a per-skill cap.
- Verify every selected pill and remove any value that was not part of the intended set.

### P2 — Phone country selection can fall back outside the owning field

**Confidence: confirmed risk; current dedicated fix passed limited lanes**

The dedicated phone-country driver now scopes to the active listbox first and has passed limited My Information tests. It is an improvement, not proof across all Workday tenants.

If the scoped search fails, `bestVisiblePhoneCountryOption()` searches every visible option in the document:

- `executioner/src/ats/workday/workday-drivers-v2.js:2950`

If another popup is stale or open, C3 could click Canada in the wrong widget. Several waits are also fixed at 120–350 ms:

- `executioner/src/ats/workday/workday-drivers-v2.js:3812`
- `executioner/src/ats/workday/workday-drivers-v2.js:3831`
- `executioner/src/ats/workday/workday-drivers-v2.js:3881`

**Required fix**

- Remove the document-wide option fallback.
- Require a popup ownership relationship through `aria-controls`, `aria-owns`, a Workday field container, or an unambiguous proximity/identity rule.
- Wait on observable option-list and selected-pill transitions instead of fixed short sleeps.

### P2 — Application Source has limited proof, not universal proof

**Confidence: known limited success; tenant-specific recurrence needs a fresh artifact**

The Source driver fixes previously passed the tested Target and Revera paths and reached later application steps. That proves those fixtures/lane states, not every Workday version.

The shared weak commit signals, popup ownership fallback, and fixed timing still apply to new tenant variants. A new Source failure could be:

- a different hierarchical prompt structure;
- the wrong owned listbox;
- a slow virtualized result set;
- a selection that looked committed but was only typed/highlighted.

We cannot identify which one dominates a current failing site without its current interaction trace and HTML snapshot.

## Recommended architecture

### 1. One detector, used everywhere

Create one shared semantic detector and expose it to:

- the initial popup;
- auth/apply handling;
- application page walking;
- readiness checks;
- error reporting.

The popup should show the actual state:

- “Job posting detected — Start application”
- “Sign-in page detected — Continue”
- “Application step detected — Fill this page”
- “Workday maintenance detected”

It should not collapse every supported-host page into “Detected job application.”

### 2. Reevaluate after every action; do not prescribe a fixed order

The control loop should be:

```text
observe -> wait until stable -> classify -> choose allowed action
        -> perform one action -> verify transition -> observe again
```

The action table defines what is valid from a state, but the next state can be any recognized state. This allows:

- job posting -> apply choice -> sign in -> application;
- job posting -> sign in -> apply choice -> application;
- already signed in -> application;
- application -> additional auth -> application;
- tenants that skip any optional page.

### 3. Make progress explicit

A transition counts as progress only when at least one of these changes:

- semantic state;
- stable URL/path;
- Workday step number/title;
- verified committed required-field count;
- application/job identity;
- terminal result.

A spinner appearing, DOM rerender, popup opening, or option highlight is activity, not progress.

### 4. Use typed terminal results

At minimum:

- `maintenance`
- `posting_unavailable`
- `email_verification_required`
- `invalid_credentials`
- `account_locked`
- `page_readiness_timeout`
- `workflow_cycle_detected`
- `required_field_commit_failed`
- `no_safe_next`
- `review_ready`

This prevents a readiness failure or stale job from being reported as CAPTCHA, auth failure, or generic fill failure.

## Test plan

### Detector fixtures

Add positive and negative browser fixtures for:

- Workday job details with Apply;
- Workday apply-method choice;
- sign-in landing and credential form;
- sign-up form;
- My Information and later application steps;
- Review;
- maintenance;
- closed/removed posting;
- tenant search/catalog;
- candidate home;
- ordinary non-job form containing words such as “candidate,” “apply,” or “resume”;
- a fake hostname containing the string `workday` but not a Workday suffix;
- popup/background classifier agreement for every fixture.

Current popup tests contain useful source assertions, but they do not prove these negative browser cases.

### Readiness fixtures

Simulate:

- fields appearing in stages over 1, 3, 8, and 20 seconds;
- a loading overlay disappearing after controls are present;
- a React rerender replacing controls after the first inventory;
- Next becoming enabled only after a committed dropdown;
- a page that never stabilizes.

Assert that C3 does not fill or click Next before stable readiness.

### Loop fixtures

Test:

- valid repeated page types with real progress;
- `signin -> apply_choice -> application -> signin` repeated three times;
- `application_step` rerenders with no step/progress change;
- transient loading between every state.

Assert that only no-progress semantic cycles stop as loops.

### Widget fixtures

For Source, phone country, and Skills, test:

- option highlighted but not selected;
- clicked option removed by rerender without a saved pill;
- selected pill appears and then disappears;
- validation remains after apparent selection;
- two visible listboxes, only one owned by the field;
- slow virtualized options;
- exact skill missing;
- field timeout after a partial multi-value selection.

Success requires persistent committed state plus cleared validation, not just a click event.

## Implementation order

1. Remove the `ariaDisabledBypass` path and block Next on unverified required fields.
2. Replace the popup’s ATS-wide positive classification with the shared semantic detector.
3. Add terminal maintenance/unavailable/catalog states.
4. Apply the stable readiness gate after every navigation and before every fill/click.
5. Add whole-workflow state history and semantic cycle detection.
6. Strengthen Workday commit verification and popup ownership.
7. Bound retries by semantic field and new evidence.
8. Fix the Skills matching and timing model.
9. Expand negative, slow-render, loop, and widget fixtures.

## What is proven versus what still needs evidence

### Proven from code

- The popup can false-positive solely because the host is recognized.
- The popup and runner use separate classifiers.
- The page walker can select an `aria-disabled` Workday Next button.
- stable readiness is not applied consistently after every page transition;
- fill can return `ok: true` with warning-level required-widget issues;
- dropdown success can be inferred from weak evidence;
- failed fields can receive multiple attempts through pipeline passes and page repair;
- Skills has a timeout/attempt-budget mismatch.

### Proven only on limited tested lanes

- Current-job Workday authentication/application entry worked on 29 of 40 jobs, with 11 maintenance results.
- The dedicated Source and phone-country fixes worked on the previously tested lanes.

### Needs fresh lane evidence before claiming a specific root cause

- Which weak commit signal causes the newest Source failure.
- Whether a current phone-country failure is wrong popup ownership, slow options, or failed commit.
- How often the Skills timeout versus unrelated fallback selection causes the observed failure.
- Which real non-application pages are producing the user’s current popup false positives.

Useful inputs, but not blockers for implementing the confirmed fixes:

- two or three exact false-positive URLs;
- one recent preserved lane or trace for each recurring Source, phone-code, and Skills failure;
- the preferred initial product scope: Workday-only strict detection or strict detection across every currently supported ATS.
