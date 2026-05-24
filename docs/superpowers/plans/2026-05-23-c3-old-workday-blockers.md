# C3 Old Workday Blockers Implementation Plan
> REQUIRED SUB-SKILL: Use superpowers:executing-plans.

Goal: Close the old pass-to-Review blockers from the latest Workday batches while keeping fill completion above fill correctness.

Architecture: Keep fixes in reusable C3 Workday mechanics, not tenant-only patches. Prefer widget behavior, page-walk recovery, and answer catalog routing that lets C3 continue to Review and records bad or low-confidence fills for audit.

Tech Stack: Chrome extension JavaScript, Workday injected scripts, Python pytest guards.

## Issues And Fixes

### Task 1: Skills Search And Commit

Files: Modify `executioner/src/ats/workday/workday-repeatables-v2.js`.

- [x] Step 1: Root cause
  - Required Skills can stay at `0 items selected`.
  - Previous retries typed search text but did not consistently press Enter, log each attempt, or stop within a bounded total time.
- [x] Step 2: Code
  - Type skill text like a user, press Enter, wait for options, click checkbox/option, verify selected pill.
  - Add `workday_skill_attempt_start`, `workday_skill_attempt_result`, and `workday_skills_time_budget_exceeded` logs.
  - Add a 25 second Skills section budget.
- [x] Step 3: Test
  - Guarded by `tests/test_component3_stage1.py::test_workday_first20_batch_section_fix_guards`.

### Task 2: Education Degree Commit

Files: Modify `executioner/src/ats/workday/workday-repeatables-v2.js`.

- [x] Step 1: Root cause
  - Workday Degree controls are repeatable-row dropdowns and can remain `Select One`.
  - Tenant options vary: `Bachelor's Degree`, `Bachelors Degree or University`, `Bachelor / Undergraduate Degree`, `University`, and similar labels.
- [x] Step 2: Code
  - Expand bachelor aliases.
  - Add `repairMissingRequiredRows` to re-run required repeatable controls that remain blank after the first fill pass.
  - Add first-real-option fallback for repeatable required choices so usable required dropdowns do not hard-stop.
  - Persist education year aliases `firstYearAttended` and `lastYearAttended`.
- [x] Step 3: Test
  - Guarded by `tests/test_component3_stage1.py::test_workday_first20_batch_section_fix_guards`.

### Task 3: Footer Save/Continue Misses

Files: Modify `executioner/src/background/safe-next.js`, `executioner/src/background/index.js`.

- [x] Step 1: Root cause
  - Some pages have a usable footer action, but C3 either misses the actual footer button or a click no-ops.
- [x] Step 2: Code
  - Include stable Workday footer selectors such as `[data-automation-id='pageFooterNextButton']`.
  - After a no-progress click, try DOM click, Enter, and Space fallback paths, each with post-click page-change proof.
- [x] Step 3: Test
  - Guarded by stage test and safe-next focused tests.

### Task 4: Generic Required Dropdown Repair

Files: Modify `executioner/src/shared/v2/field-pipeline.js`.

- [x] Step 1: Root cause
  - Validation repair skipped usable required controls when visible errors were generic, such as `Select One is required`.
- [x] Step 2: Code
  - Add `genericRequiredError` handling so required fields or fields with validation state are eligible for repair even when the error text does not name the exact field.
- [x] Step 3: Test
  - Guarded by `tests/test_component3_stage1.py::test_workday_first20_batch_section_fix_guards`.

### Task 5: Auth Create-Account-To-Sign-In Sink

Files: Modify `executioner/src/background/index.js`.

- [x] Step 1: Root cause
  - Boeing/Thermo style flows redirected from Create Account to Sign In without verification or application fields, then C3 kept retrying sign-in.
- [x] Step 2: Code
  - Track whether a signup attempt occurred.
  - If signup redirects into login with no visible validation, stop with typed `auth_create_account_to_signin_sink` and `auth_no_progress` classification.
  - Add auth shell still-settling signals in background workflow detection.
- [x] Step 3: Test
  - Guarded by `tests/test_component3_stage1.py::test_workday_first20_batch_section_fix_guards`.

### Task 6: Conditional Defaults That Open Follow-Ups

Files: Modify `executioner/src/shared/v2/field-catalog.js`, `tests/test_component3_stage1.py`.

- [x] Step 1: Root cause
  - PEP/close-associate and insurance-license-history questions can open required detail fields if answered `Yes`.
- [x] Step 2: Code
  - Add `politically_exposed_person` with profile-overridable default `No`.
  - Expand professional-license discipline aliases to cover insurance license refused/revoked/suspended wording.
- [x] Step 3: Test
  - Covered by deterministic answer-router tests for PEP and insurance license history.

## Live Retest Needed

- RTX/RBC: Education Degree should be retested.
- Target/Capital One/Comcast/Autodesk: Skills should be retested for selected-pill behavior and Review visibility.
- Amgen/BMS/Autodesk: footer fallback should be retested.
- Cox: generic required dropdown repair should be retested.
- Boeing/Thermo: auth sink should now classify cleanly; it may still not reach Review if the tenant account state is truly stuck.

