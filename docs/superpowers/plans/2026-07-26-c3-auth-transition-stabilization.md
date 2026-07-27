# C3 Auth Transition Stabilization Implementation Plan

> REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** Prevent a transient post-auth Workday shell from becoming an
`auth_transition_unclassified` terminal result when bounded repeated
observations prove that an application page emerged.

**Architecture:** Keep stabilization at the existing post-auth observation
boundary. The polling function must require two matching authoritative
observations, while direct proven terminal states may short-circuit. The page
walk must consume that stabilized observation rather than overwrite it with an
extra unsynchronized probe. Existing timeout, same-page, auth-cycle, and direct
unavailable behavior remains unchanged.

**Tech stack:** JavaScript MV3 background worker, Python `unittest`, Node `vm`
behavior harness.

## Task 1: Reproduce the stale post-auth overwrite

**Files:**

- Create: `tests/test_c3_auth_transition_stabilization.py`
- Read: `executioner/src/background/index.js`

- [x] Add a Node-backed test that feeds the waiter one transient unknown shell
      followed by two matching `My Information` application observations.
- [x] Assert the waiter returns the later application observation, the bounded
      sample history, and `stable_page_state`.
- [x] Add a selector test proving a stable application observation wins over a
      later unsynchronized unknown probe, while timeout falls back to the fresh
      probe.
- [x] Run:
      `python -m pytest tests/test_c3_auth_transition_stabilization.py -q`
      and confirm the selector test fails because the selector is absent.

## Task 2: Preserve the stabilized observation

**Files:**

- Modify: `executioner/src/background/index.js`

- [x] Add a small pure selector that accepts only bounded stable known states
      or directly proven terminal observations as authoritative.
- [x] Use the selector after the auth wait; probe again only if the wait did not
      yield an authoritative observation.
- [x] Keep the existing two-sample bound, deadline, direct terminal
      short-circuit, same-page, and cycle decisions unchanged.
- [x] Run:
      `python -m pytest tests/test_c3_auth_transition_stabilization.py -q`
      and confirm it passes.

## Task 3: Verify affected behavior

**Files:**

- Verify: `tests/test_component3_stage1.py`
- Verify: `tests/test_component3_workday_fill.py`
- Verify: `tests/test_c3_terminal_driver_evidence.py`

- [x] Run the focused auth-transition/state-machine tests.
- [x] Run the full affected suites.
- [x] Review the exact diff for unrelated changes.
- [x] Leave the patch uncommitted for parent integration; no commit permission
      was requested.
