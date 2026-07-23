# C3 Lane Terminal Identity Remediation

**Goal:** Prevent a fresh C3 run from discovering a reused terminal lane identity only after browser work completes, while retaining backend idempotence for identical terminal retries and conflicts for different terminal outcomes.

## Tasks

1. Add focused tests proving a fresh supervisor run rejects an already-terminal session before target preparation/bootstrap.
2. Preserve the existing terminal conflict warning for a different operation/lease; do not suppress a real conflict.
3. Add the smallest runner preflight using the session ledger, reusing the prior authoritative terminal operation and avoiding browser work or a second terminal write.
4. Run runner/control-plane tests, Ruff, and diff checks; report the live root cause and whether a reload is required.
