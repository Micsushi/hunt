# C3 Error Taxonomy

Use this taxonomy when classifying C3 lane failures, Review-page bad fills, or
live p Chrome investigation results. Classify before recommending a code change.

| Error type | Meaning | What to do |
| --- | --- | --- |
| `page_misidentified` | C3 chose the wrong phase or page type: job posting, auth, apply entry, form step, review, dead posting, or catalog. | Capture URL/title/body signals, audit phase, and expected phase. Recommend identifier/routing fix. |
| `detection_prompt_missing` | C3 should have detected the page and shown an in-page prompt, but no prompt appeared. | Record initial URL, visible page type, detection signals, extension/content-script state, and whether extension popup fill still worked. Recommend detection/content-script fix. |
| `detection_prompt_timing` | Detection prompt likely appeared too early/late or was missed, but extension popup fill can still start the flow. | Record timing, reload/navigation behavior, and popup fallback result. Recommend prompt timing or re-detection fix only if repeatable. |
| `auth_email_verification` | Account flow reached email verification or failed to verify email. | Record tenant, mailbox/provider state, visible verification UI, bridge logs, and whether this is expected gate or bridge bug. |
| `auth_button_action` | Correct auth page, but C3 clicked wrong button or button click did not advance. | Interact with live UI first. Prove trusted click target with CDP/Playwright. Recommend auth action target fix. |
| `apply_entry_action` | Signed-in page needed Apply/Apply Manually/start action and C3 missed or mis-clicked it. | Capture available buttons/links and exact action that enters the application. Recommend apply-entry fix. |
| `unknown_question_type` | C3 has no category for the question. | Decide if answer belongs in deterministic catalog, user profile, or manual review. Add wording examples. |
| `question_wording_miss` | C3 supports the category, but unique wording was not recognized. | Add keyword/phrase mapping or classifier alias. Include exact label and matched wrong type if any. |
| `unknown_answer_type` | C3 recognized question but does not know how to choose/write answer. | Decide deterministic default, user-profile field, generated answer, or manual review. |
| `answer_wording_miss` | C3 knows the answer type, but visible options use new wording. | Add answer aliases/option mapping. Prefer neutral/non-disclosure where policy says so. |
| `profile_gap` | Correct answer needs data not currently in profile. | Recommend user profile field/default only if reusable and safe; otherwise manual review. |
| `bad_deterministic_mapping` | C3 answered, but Review/audit shows wrong value. | Record question, chosen value, expected value, source path, and policy reason. Recommend mapping priority/fallback fix. |
| `ui_type_misidentified` | C3 treated the control as the wrong UI type. | Interact with UI, inspect DOM, classify actual widget, then recommend driver selection fix. |
| `ui_interaction_failed` | Correct UI type, but C3 used wrong mechanics or did not commit state. | Prove commit path with live UI and CDP. Report selected pill/hidden value/validation clear proof. |
| `new_ui_type` | Widget behavior does not match known drivers. | Document behavior, minimal DOM signature, successful user interaction, and proof script before proposing support. |
| `runner_or_lane_setup` | Failure comes from p Chrome, extension load, profile seed, logs, port, or wrong browser. | Fix lane setup first. Do not classify as C3 fill bug. |
| `site_or_posting_state` | Posting dead, maintenance, CAPTCHA/MFA, tenant outage, or external block. | Classify and stop. Do not patch C3 unless detection/routing should improve. |

When unsure, use the narrowest proven type. Do not jump from symptom to code
change without live UI proof for UI/action errors.

## Answer Fix Policy

When Review exposes a bad deterministic answer, classify the fix before changing
code:

- If the answer is candidate-specific or preference-specific, add or reuse a
  visible profile field and route matching through that field.
- If the question category is right but option text is new, add matcher aliases
  or neutral/non-disclosure option wording.
- If the question category is missing, add the reusable catalog category and
  tests before adding field-label-specific logic.
- Use a default answer only when it is a reusable safe default and there is a
  profile override for users who need the opposite value.

Examples: legal-name prefix uses profile `namePrefix`; accommodation request
uses profile `accommodationRequest`, blank means neutral and resolves to `No`
only when a required yes/no application prompt needs a concrete answer.

## Workday Source Policy

Workday Source / `How Did You Hear About Us?` answers are policy-checked by
safety, not by exact `source=LinkedIn` mirroring. Exact `LinkedIn` is preferred
when the option is visible and commits, but a nonblocked fallback such as job
board, job site, careers/company website, internet, or other safe source is not
`bad_deterministic_mapping` by itself. Bad source fills are `Select One`/empty,
referral/employee/referrer, recruiter, agency, or any source that contradicts
explicit profile evidence.

Source commit warnings are review prompts, not automatic failures. If an earlier
audit warning says Source was not committed or verified, but the final Review UI
shows a nonblocked Source value such as job board, careers/company website,
internet, company website, or LinkedIn, classify the lane by the Review value and
record the earlier warning as inspected/resolved. Keep the warning only as a cue
to inspect the Review answer carefully.

## Basic Qualifications Policy

Questions asking whether the applicant meets the basic, minimum, or required
qualifications for the role should be a supported yes/no question type. Examples
include `Do you meet all the basic requirements/qualifications for this role?`
and `Do you meet the minimum qualifications?`. The progress-safe answer is
`Yes` unless saved profile facts or explicit job-specific review evidence say
otherwise. A `No` answer on Review for this class is
`bad_deterministic_mapping`, not merely a role-specific caveat.
