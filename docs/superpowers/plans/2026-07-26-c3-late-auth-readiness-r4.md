# C3 Late Auth Readiness R4 Implementation Plan

> REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** Keep a slow Workday login-to-application transition alive long
enough to recognize a stable application page without turning the wait into an
unbounded retry or weakening direct terminal and auth-loop rules.

**Observed evidence:** Lane 17 r4 recorded readiness attempts through the
10-second base window and then terminalized as
`auth_transition_unclassified`. The independent browser capture proved
`My Information` step 1 of 4 with nine application fields about 17 seconds
after that terminal event. No retained per-probe sample proves whether the
application surface appeared during the original wait, so the evidence
supports a late-readiness boundary but does not prove a detector miss.

**Architecture:** Keep the existing 10-second base window. Allow one bounded
20-second grace window only when a probe supplies transition evidence: a
Workday `/apply` route, a visible loading indicator, a changing probe
signature, or positive application evidence from either detector. Merge
positive application evidence from the field-readiness and workflow detectors
so a disagreement cannot cause a false timeout. Keep two stable, non-loading
observations before success. Retain bounded observation samples in the result
and debug evidence.

**Tech stack:** JavaScript MV3 background worker, Python pytest, Node `vm`
behavior harness.

## Task 1: Reproduce r4 late readiness and detector disagreement

**Files:**

- Create: `tests/test_c3_late_auth_readiness_r4.py`
- Read: `executioner/src/background/index.js`

- [x] Simulate the exact Workday `/apply` shell remaining fieldless beyond the
      base timeout, then becoming stable `My Information`.
- [x] Require success during a bounded grace window.
- [x] Simulate a blank field probe while workflow detection consistently sees
      a job-fill step; require the combined detector to succeed.
- [x] Run the focused test and observe failures before implementation.

## Task 2: Implement bounded adaptive readiness

**Files:**

- Modify: `executioner/src/background/index.js`

- [x] Add explicit base, grace, and hard deadlines.
- [x] Permit grace only from concrete transition/loading/application evidence.
- [x] Combine both detectors' positive application evidence.
- [x] Preserve the two-stable-sample and non-loading requirements.
- [x] Return bounded observation samples and grace reasons for diagnosis.

## Task 3: Preserve safety and adjacent behavior

**Files:**

- Modify: `tests/test_c3_late_auth_readiness_r4.py`
- Verify: `tests/test_c3_auth_success_transient_r3.py`
- Verify: `tests/test_c3_auth_transition_stabilization.py`
- Verify: `tests/test_c3_evidence_detection.py`
- Verify: `tests/test_component3_prompt.py`
- Verify: `tests/test_component3_stage1.py`
- Verify: `tests/test_component3_workday_fill.py`

- [x] Prove no transition evidence receives no grace.
- [x] Prove cancellation stops during grace.
- [x] Prove auth same-page exits immediately for existing loop accounting.
- [x] Prove the hard deadline is never extended by changing/loading probes.
- [x] Run focused and affected suites plus syntax/format/diff checks.
- [x] Leave the patch uncommitted for parent integration.
