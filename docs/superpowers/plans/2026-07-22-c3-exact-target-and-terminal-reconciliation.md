# C3 Exact Target and Terminal Reconciliation Implementation Plan

> REQUIRED SUB-SKILL: Use systematic debugging and test-driven development inline in the existing isolated worktree.

Goal: Preserve the exact registered browser target identity through operation dispatch and return an authoritative terminal report when cancellation reconciliation completes within the bounded window.

Architecture: The backend operation request must pin the authoritative registered target without canonicalizing its query string or redacting strict ownership identifiers. The runner must continue bounded read-only reconciliation after a transient read/cancel failure, then fetch terminal diagnosis and late artifacts before reporting. No page mutation is added.

Tech Stack: Python, FastAPI/Pydantic control plane, pytest.

## Task 1: Exact registered target identity

Files: Modify `tests/test_c3_command_endpoint.py`, `backend/c3_commands.py`, and narrowly shared identifier/redaction helpers if the strict ownership-ID test requires it.

- [ ] Add a failing endpoint test where the registered URL includes `?source=LinkedIn` and assert the stored/dispatch target URL, hash, lease ID, and CDP target ID remain exact.
- [ ] Run the focused test and confirm the query/identity mismatch failure.
- [ ] Preserve the exact registered target and strict ownership identifiers; fail operation preflight when authoritative selectors are unavailable.
- [ ] Re-run the focused command/control tests.

## Task 2: Authoritative cancellation terminal reconciliation

Files: Modify `tests/test_c3_agent_runner.py` and `tools/c3_agent_testing/runner.py`.

- [ ] Add a live-shaped failing test where cancel/read temporarily return identity errors, then the backend becomes orphaned with late diagnosis/artifact evidence within the reconciliation window.
- [ ] Run the focused test and confirm the runner returns stale cancelling/unavailable evidence.
- [ ] Add bounded read-only terminal refresh and terminal failure-context refresh without another page mutation.
- [ ] Re-run runner and CLI tests.

## Task 3: Verification

- [ ] Run runner, CLI, command/control-plane, MCP contract suites.
- [ ] Run Ruff format/check and `git diff --check` for touched files.
- [ ] Hand off root cause, changed files, verification, and live-reload requirement without committing shared worktree changes.
