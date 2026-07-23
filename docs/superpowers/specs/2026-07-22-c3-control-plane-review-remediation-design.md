# C3 Control-Plane Review Remediation Design

## Status

Approved direction: bounded control-plane hardening. This document defines the remediation contract for every finding from the 2026-07-22 full review.

## Goal

Make C3 autonomous testing reliably terminate, preserve exact failure evidence, isolate agents, and expose enough retained context for diagnosis without routine direct Playwright inspection.

## Non-Goals

- Replace JSONL operation authority with SQLite or Postgres.
- Bypass Workday account, email-verification, or tenant gates.
- Enable final Submit or foreground activation.
- Add broad new ATS behavior unrelated to reviewed defects.

## Invariants

1. Final Submit and foreground activation remain blocked.
2. Stable browser identity means the exact registered tab/CDP target, not its initial URL forever.
3. Every wait, capture, read, response, and rebuild has a time, count, and/or byte bound.
4. A timeout disables future mutations before returning control.
5. First terminal operation event remains authoritative for state, result, error, and cause.
6. Late observability may enrich evidence but cannot replace the terminal cause.
7. Operation reads require stored agent and lease identity, including after lease release.
8. Persisted and returned diagnostics exclude applicant-entered values and unsafe DOM text.
9. Recovery is idempotent across any crash boundary.
10. One planned lane maps to one unique canonical job URL.

## Architecture

### 1. Browser identity and navigation

Keep immutable operation pins for browser kind, debug endpoint, extension ID, registered tab ID, and CDP target ID. Treat URL as observed versioned state rather than immutable identity.

The browser selector must:

- resolve the extension-owned tab ID to one CDP target ID;
- require the resolved target ID to match the operation pin;
- accept URL changes on that same target;
- return the current sanitized URL and URL hash;
- append a navigation-observed event when the hash changes;
- reject target replacement, missing identity, ambiguity, or cross-tab movement.

Probe mutations retain stricter checks: active lease, exact operation ownership, exact target, current page observation, and predicate proof.

Remote/container CDP diagnostics reuse the bridge candidate-host resolution instead of hardcoding localhost.

### 2. Bounded timeout and cancellation lifecycle

Page and extension drivers use a permanent run guard. On timeout:

1. Mark the run cancelled with a stable reason code.
2. Disable all guarded mutations immediately.
3. Emit timeout and last-action evidence.
4. Wait only for a short bounded unwind window.
5. If still pending, return a timeout result and retain a cancelled tombstone until the original promise settles.

The returned command may acknowledge cancellation once mutation authority is revoked; it must not wait forever for the original promise. Late promise completion is ignored except for bounded telemetry.

Trusted CDP input tracks pressed keys/buttons. A `finally` cleanup emits best-effort releases even after cancellation or command failure.

Backend safeguards:

- bridge evaluation gets a finite timeout derived from the operation deadline;
- queued operations evaluate their deadline before returning `operation_queued`;
- queued deadline expiry terminalizes orphans/failures without needing a worker;
- stuck/late worker results remain ignored after terminalization;
- operation executor capacity cannot be permanently consumed by page-side joins.

### 3. Terminal evidence capture

Every transition observed as `failed` schedules `operation_failed` capture before monitor cleanup, including terminal transitions that race with progress, heartbeat, health, checkpoint, or watchdog work.

Capture deduplication remains per `(operation_id, reason_code)`. Cleanup must not invalidate an in-flight capture callback.

Late artifact linkage becomes an atomic store operation:

- lock operation directory;
- reload projection;
- union existing and new IDs in order;
- append additive artifact event;
- rebuild diagnosis from the bounded evidence view;
- keep all previously linked IDs downloadable.

### 4. Bounded event access and diagnosis

Operation event API becomes cursor-paginated with explicit limits. Default and maximum limits are finite. Responses return `next_after_seq`, `has_more`, and `truncated`.

MCP waiting advances the cursor until it sees relevant events or reaches its time bound. It never repeatedly materializes the entire stream.

Diagnosis generation uses a bounded evidence window containing:

- operation request snapshot;
- first authoritative terminal event;
- bounded recent pre-terminal action/validation/navigation evidence;
- bounded post-terminal artifact/monitor evidence;
- explicitly referenced evidence IDs/checkpoints when within scan bounds.

Cause selection and resolution use precomputed indexes keyed by sequence, event ID, field ID, action ID, checkpoint ID, and selector token. No nested full-list scans.

`diagnosis.json` remains atomic and rebuildable. Recovery reuses valid projections and diagnoses; it rebuilds only missing/corrupt projections. One malformed operation is isolated and cannot prevent the C3 manager from starting.

### 5. Diagnostic privacy and artifact safety

DOM snapshots reconstruct structural HTML from an allowlist:

- allowed tags needed for UI identity;
- safe attribute names such as role, input type, autocomplete, stable IDs, and approved automation IDs;
- selector-like attributes with value redaction;
- no arbitrary `data-*`, `aria-description`, `aria-valuetext`, title, href query, style, or event attributes;
- label/legend text only after ledger redaction and length bounds;
- all other text replaced with `[REDACTED]`.

Direct browser-control snapshots and persisted artifacts use the same sanitizer.

Artifact limits cover DOM bytes, each JSON section, each list, total bundle bytes, manifest bytes, file bytes, file count, and artifact count. Validation streams file hashes instead of unbounded `read_bytes()`.

Artifact listing uses the same validated, contained, bounded manifest reader as failure context. Symlinks and paths outside the operation artifact root fail closed. Returned summaries never expose arbitrary manifest fields.

### 6. Agent isolation and identity ownership

Operation projection and event reads require `agent_id` and `lease_id`, checked against the stored operation. Released leases remain valid read credentials only for their owning operation.

Reserved command identity keys use one canonical normalized set shared by MCP validation and backend sanitization. Backend outer identity always overwrites nested command payload values before extension dispatch. Reserved keys include operation, command, trace, agent, lane, session, lease, run/fill, submit, foreground, and bridge-timeout controls.

### 7. Terminal marker and restart recovery

Terminal marker creation redacts reason/result before disk persistence. The marker owns the canonical terminal payload.

On retry after partial completion:

- identity and terminal payload must match the marker, or the request conflicts;
- event append uses marker values, never retry-body values;
- lease release recovery remains idempotent;
- corrupt markers return a bounded explicit error.

Operation recovery rules:

- terminal event present: retain first terminal truth;
- cancellation acknowledged but cancellation terminal event missing: append/derive `operation.cancelled`;
- other nonterminal operation after restart: orphan with `backend_restart_nonterminal`;
- recovery errors affect only their operation and produce safe diagnostics.

### 8. Runner and planner reliability

Replacement discovery seeds its canonical exclusion set from already selected CSV jobs. It continues searching until it finds the requested number of unique available jobs or exhausts candidates.

Lane preparation owns every created target ID. Any validation or preparation failure closes the newly created inactive job tab and temporary extension target.

Completed operation state is removed from live maps after bounded retention. Cancelled tombstones remain only until their late promise settles or a capped expiry is reached.

Runner failure-context flow:

1. Fetch terminal context.
2. If artifact status is `capturing`, `partial`, or `idle` for a failed operation, poll the failure-context MCP tool for a short bounded late-artifact window.
3. Store full compact evidence tails and artifact summaries needed for agent diagnosis.
4. `resume-report` refreshes completed results when retained operation credentials exist.
5. Failure-context refresh failure is explicit and does not erase the original context.

### 9. API compatibility

MCP methods gain required read identities for operation/event reads. Existing internal callers are updated together. Event responses retain the existing `events` field and add pagination metadata.

Failure-context response remains backward-compatible; new evidence freshness fields may be additive.

## Failure Handling

- Target changed: `registered_target_identity_mismatch`.
- Expected same-target URL change: accepted and ledgered.
- Queue deadline: `operation_queue_deadline_exceeded`.
- Driver unwind exceeded: `driver_unwind_timeout`, with mutation guard disabled.
- Evidence scan capped: `evidence_truncated=true`.
- Artifact rejected: typed safe reason without linking it.
- Ownership mismatch: HTTP 403.
- Corrupt isolated operation: manager stays available; operation returns safe recovery failure.

## Test Strategy

Each item starts with a failing regression test.

### Backend

- same target plus changed URL succeeds; changed target fails;
- remote CDP candidate host is used;
- queued deadline terminalizes with no free worker;
- terminal-during-probe schedules exactly one capture;
- two simultaneous late artifacts preserve both IDs and downloads;
- event pagination stays within count/byte limits;
- 500 correlated failure events complete within a fixed performance ceiling;
- malformed operation does not block manager recovery;
- acknowledged cancellation recovers as cancelled;
- cross-agent reads fail and owner reads after release pass;
- terminal marker redaction and crash retry are deterministic;
- symlink, oversized manifest, oversized file, and oversized section fail safely.

### Extension JavaScript

- timeout returns after bounded unwind while late promise cannot mutate;
- queued/background command receives a bounded timeout result;
- mouse/key release occurs after cancellation between input events;
- DOM sanitizer removes custom values and retains stable structural identity;
- nested spoofed identities are overwritten;
- completed state/tombstones are bounded;
- JS syntax checks pass.

### Runner and planner

- replacements never duplicate selected jobs;
- failed preparation closes created job tabs;
- waiter consumes paginated events without replay;
- late artifact refresh updates completed lane result;
- completed `resume-report` refreshes retained failure context;
- five-lane plans contain five unique canonical URLs.

## Live Acceptance

After code verification:

1. Restart/reload backend from this worktree and verify PID/source.
2. Reload isolated C3 extension profiles; do not alter regular Chrome profile without user request.
3. Run one controlled failure that navigates from posting to auth/application page.
4. Confirm current-page DOM, health, validation, navigation, and artifact evidence are available without direct Playwright inspection.
5. Run five jobs sequentially, one at a time.
6. For each failure, confirm terminal cause, exact UI identity when available, bounded unknown-cause declaration when not, and no stuck operation/worker.
7. Confirm no final Submit and no foreground activation.

## Acceptance Criteria

- All reviewed P1/P2 findings have regression coverage and implemented fixes.
- No unbounded join remains in C3 fill/cancel timeout paths.
- Queue deadlines work under worker saturation.
- Expected navigation no longer blanks failure artifacts.
- Owner agent can diagnose terminal failures from MCP evidence; other agents cannot read them.
- No persisted DOM sample contains seeded sensitive custom-attribute/text values.
- Event/diagnosis/artifact work stays within declared limits.
- Full focused, broader C3, component-3, lint, syntax, and PowerShell gates pass.
- Live sequential five-job acceptance produces no undetected stall.
