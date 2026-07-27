# C3 Auth-Success Transient R3 Implementation Plan

> REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** Prevent the immediate post-login `unknown/unknown` shell from
terminalizing before the existing bounded application-readiness waiter can
prove a stable Workday destination.

**Architecture:** Keep direct credential rejection and unavailable states
terminal at the immediate decision boundary. Mark a non-auth unknown
observation as pending unless bounded timeout evidence is explicitly supplied,
then let `runV2PageWalkAfterFill` enter the existing two-sample
`waitForApplicationFieldsReadyAfterAuth` path. If that waiter expires, retain
its bounded wait duration and final probe in the terminal evidence.

**Tech stack:** JavaScript MV3 background worker, Python pytest, Node `vm`
behavior harness.

## Task 1: Reproduce the r3 bypass

**Files:**

- Create: `tests/test_c3_auth_success_transient_r3.py`
- Read: `executioner/src/background/index.js`

- [x] Extract `createAuthTransitionDecisionFunction` in a Node `vm`.
- [x] Feed the exact r3 transition:
      `login/credential_form -> non-auth unknown/unknown`.
- [x] Require the immediate decision to be nonterminal and
      `auth_transition_pending`.
- [x] Require the page-walk source to reach the bounded application-readiness
      waiter after the immediate decision.
- [x] Run the focused test and observe the current
      `auth_transition_unclassified` failure.

## Task 2: Implement the bounded deferral

**Files:**

- Modify: `executioner/src/background/index.js`

- [x] Add conservative timeout-evidence normalization to the auth transition
      decision.
- [x] Return `auth_transition_pending` for immediate non-auth unknown state.
- [x] Preserve `auth_transition_unclassified` only when explicit bounded
      timeout evidence accompanies the unknown state.
- [x] Pass no timeout evidence in the immediate post-action decision.
- [x] Include readiness wait/probe evidence when the downstream bounded waiter
      expires.

## Task 3: Preserve adjacent rules

**Files:**

- Modify: `tests/test_c3_auth_success_transient_r3.py`
- Verify: `tests/test_c3_auth_transition_stabilization.py`
- Verify: `tests/test_c3_evidence_detection.py`
- Verify: `tests/test_component3_stage1.py`
- Verify: `tests/test_component3_workday_fill.py`

- [x] Prove direct credential rejection remains terminal.
- [x] Prove directly observed maintenance/unavailable remains terminal.
- [x] Prove unknown plus bounded timeout evidence remains terminal and retains
      the timeout reason, duration, and last probe.
- [x] Run focused auth state-machine tests.
- [x] Run full affected component suites.
- [x] Run syntax/format/diff checks.
- [x] Leave the patch uncommitted for parent integration.
