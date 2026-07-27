# C3 Terminal Envelope Truncation Implementation Plan

> REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** Keep bounded event truncation from replacing string-only operation
fields with structured markers, while preserving Review-ready completion and
the bounded result payload.

**Architecture:** Normalize scalar leaves conservatively at the event
sanitization boundary and retain structured truncation markers only inside
structured payloads. Classify a directly proven `final_submit_visible` Review
response as a successful safe stop, then persist it as
`completed/review_ready` with its bounded result. All other bridge failures
keep their current path.

**Tech stack:** Python, Pydantic operation models, append-only JSONL operation
store, pytest.

## Task 1: Reproduce scalar-marker corruption

**Files:**

- Create: `tests/test_c3_terminal_envelope_truncation.py`
- Read: `backend/c3_operations.py`

- [x] Add a sanitizer test that exhausts the shared node budget before
      `terminal_reason`, `reason`, and string `error`.
- [x] Require those source strings to remain bounded strings.
- [x] Require structured truncation evidence to remain inside the structured
      result.
- [x] Run:
      `python -m pytest tests/test_c3_terminal_envelope_truncation.py -q`
      and confirm the current sanitizer fails.

## Task 2: Reproduce Review-ready envelope loss

**Files:**

- Modify: `tests/test_c3_terminal_envelope_truncation.py`

- [x] Return an oversized, directly proven Review/final-Submit bridge response.
- [x] Require the manager to finish `completed/review_ready`.
- [x] Require the bounded result payload and terminal event to survive.
- [x] Confirm final Submit is evidence only; no Submit capability or activation
      is introduced.

## Task 3: Implement the boundary fix

**Files:**

- Modify: `backend/c3_operations.py`

- [x] Preserve scalar source types when the structure/depth/node budget is
      exhausted.
- [x] Prioritize top-level terminal text leaves so exact short reasons survive
      a large earlier structured value.
- [x] Keep structured truncation markers inside result/error structures.
- [x] Recognize only directly proven Review plus visible final Submit as the
      `review_ready` safe completion.
- [x] Use one completion decision in normal and cancellation-race branches.

## Task 4: Verify adjacent paths

**Files:**

- Verify: `tests/test_c3_operations.py`
- Verify: `tests/test_c3_control_plane.py`
- Verify: `tests/test_c3_failure_context.py`
- Verify: `tests/test_c3_operation_monitor.py`

- [x] Run the new focused regression.
- [x] Run focused lifecycle, cancellation, deadline, and recovery tests.
- [x] Run full affected suites.
- [x] Run Ruff and diff checks.
- [x] Leave the patch uncommitted for parent integration.
