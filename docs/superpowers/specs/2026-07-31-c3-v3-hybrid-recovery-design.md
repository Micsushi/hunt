# C3 v3 Hybrid Recovery Design

Date: 2026-07-31
Status: approved
Supersedes: `2026-07-30-c3-v3-parallel-stage-one-design.md`

## Outcome

C3 v3 remains a local, Workday-only executioner that accepts one prepared job,
selected resume, and applicant profile; owns the browser journey; reaches
Review with independently verified mutations; reports factual failures; and
never exposes final Submit.

The rushed F2-F11 implementations are prototype evidence. They are neither the
contract authority nor accepted feature tips. Recovery may reuse any proven
test, fixture, parser, or small implementation unit, and may discard any code
whose behavior or structure is harder to prove than to replace.

## Evidence from the prototype batch

- Accepted F1 tip: `c57c24ef59aec6dd6e2ee8f222aa64695777a0dd`.
- Frozen F1 contract-source revision:
  `d95e845e61bcf0a030b3b07c6d6261e3d95c1fad`.
- F2-F11 prototypes were all created directly from the contract-source
  revision rather than the accepted F1 tip.
- The ten prototypes apply together without text conflicts and produced 331
  passing tests, four failures, and one skip in the disposable integrated
  audit.
- Static review found additional cross-feature incompatibilities that the
  aggregate test count did not exercise: structural control loss, unsafe
  choice/toggle semantics, fixture/catalog mismatch, disconnected fault
  injection, incomplete error propagation, resume identity ambiguity,
  terminal-event mismatch, and inconsistent admission rules.

The conclusion is not “continue and fix four tests.” The conclusion is “retain
the learning, repair the contract baseline, prove two vertical slices, then
recover components selectively.”

## Design authority

Product requirements and explicit owner decisions outrank prototype behavior.
Every proposed F1 change must be classified as one of:

1. required by an existing approved outcome or invariant;
2. a missing decision resolved by this design; or
3. a prototype invention that must be rejected.

No prototype type, error, retry, or state transition becomes a contract merely
because code already exists for it.

## Recovery flow

### 1. Preserve and classify

Record the accepted F1 tip, contract-source revision, serialized versions, and
all prototype snapshot hashes in one recovery manifest. Snapshot refs remain
reachable until their replacement features pass Tier 2. Prototypes are read-only
patch sources and regression oracles; they are never merged as accepted tips.

### 2. Reopen F1 as revision R2

The accepted F1 kernel remains the baseline. A bounded amendment must:

- freeze the executable data/control-flow and source ownership;
- add the minimal structural browser data needed for textarea, date, grouped
  choices, and idempotent checked-state mutation;
- define a verifiable resume-artifact boundary;
- close provider error propagation and the owner/retryability matrix;
- bound identifiers and define collision-safe derivation;
- distinguish duplicate request, replay, cancellation, uncertain mutation,
  terminalization, and retry behavior;
- admit immutable exact-shape snapshots at trust boundaries; and
- replace shallow conformance cases with stateful negative, replay,
  cancellation, concurrency, and cleanup scenarios.

R2 records the accepted component base SHA and `contractTreeOids`: Git tree
object IDs, computed from that base with `git rev-parse <base>:<path>`, for
`executioner/src/contracts`, `executioner/src/testing/contracts`,
`executioner/tests/contracts`, and `executioner/tests/security/privacy`.
Serialized schema versions remain separate.

### 3. Prove compatibility before parallel recovery

Two real-provider walking skeletons exercise draft R2:

1. fixture/server -> browser -> understanding -> answer resolution -> driver
   -> independent readback;
2. MCP -> orchestrator -> journey state -> events/failure reporting -> privacy
   and evidence admission.

The first slice is backed by a field-flow matrix for every required fixture
control: HTML structure, browser observation, semantic field, answer source,
mutation, and independent readback. No required control may have an unsupported
cell.

These are disposable compatibility probes, not canonical feature work. They run
in isolated noncanonical worktrees from draft R2. Component owners may adapt a
prototype diff or replace it with the minimum throwaway R2-conformant spike
needed to prove a named boundary. The spike skeleton must pass and every
prototype result is classified; prototypes need not pass. Probe/spike commits
never enter F1 or feature tips. The vault records draft R2, prototype SHA,
temporary files, invariant/result, and disposition. Canonical recovery remains
blocked until R2 acceptance.

R2 freezes only after both slices compile, contract probes pass, and two
independent reviews find no P0/P1 issue.

### 4. Recover components selectively

Each canonical F2-F11 branch starts from the exact accepted R2 tip in an
isolated worktree. The prototype diff is reference input. Tests and scenarios
are ported first; implementation is transplanted only where it remains the
smallest provable solution. Task history is reconstructed with task-scoped
changes rather than carrying the rushed single-snapshot commit.

Default disposition:

| Feature | Default recovery |
| --- | --- |
| F2 | Repair fixture/server shell; reconnect visible faults and conformance. |
| F3 | Reuse browser helpers; repair structure, grouping, and cancellation. |
| F4 | Reuse reducer/store; repair identity, queries, persistence, and resume proof. |
| F5 | Reuse detection/discovery pattern; repair structural classification. |
| F6 | Reuse normalization/catalog; align fixture facts and propagate errors. |
| F7 | Reuse registry mechanics; repair choice/toggle and browser-error behavior. |
| F8 | Reuse comparison/completion; repair ambiguous/unavailable verification. |
| F9 | Rebuild loop/state machine; reuse only independently proven shell and tests. |
| F10 | Reuse store/projector; align producer and terminal-event contracts. |
| F11 | Reuse evidence/guard ideas; repair exact-shape and concurrent admission. |

No classification prevents a feature owner from deleting more prototype code.
Every known P1 receives a replacement regression. Where R2 remains compatible,
a preserved old-base reproducer must fail against prototype behavior. Where R2
shape changes make that impossible, the manifest records the compile/contract
incompatibility as the old-behavior oracle. Required conformance suites may not
be skipped or empty.

### 5. Integrate progressively in F12

F12 begins with manifest tooling, a coordinator-owned human acceptance ledger,
and exact-base checks, then admits accepted components into progressive clusters:

1. F2/F3/F5 surface semantics;
2. F4/F5/F6 intake, profile, and answers;
3. F2-F8 interaction and independent verification;
4. F4/F9/F10/F11 control, persistence/reload, cancellation, terminal
   idempotence, privacy, and factual failure;
5. one exact full candidate rerun through every connection suite.

T2 and T3 each record their own cluster-candidate SHA in isolated worktrees.
T6 alone records the complete candidate after assembling every accepted tip and
admitted test-only commit. F12 owns assembly and connection tests only. A
component defect returns to its owner and produces a new accepted tip and
manifest.

### 6. Accept the controlled journey in F13

F13 owns constructor wiring and acceptance only; F9 remains the sole loop. The
happy path and one named provider failure run three times from clean state.
Stage 1 closes at Tier 2 only when component, connection, acceptance, privacy,
architecture, typecheck, and quality gates pass on one revision.

Publication to `main`, hosted CI, push, and live proof are separate Tier 3
promotion actions. S2 remains blocked until Tier 2 is accepted.

## Approved ownership decisions

- F9 emits value-free, provider-attributed phase events; F10 validates,
  persists, and projects them.
- IDs have three classes: upstream opaque handles validated and never re-derived
  by C3; C3-generated journey/session IDs allocated by an injected non-sensitive
  source; and closed coordinate enums. MCP `requestId` is a bounded caller
  idempotency key, not a generated operation ID. No retained ID is raw/hash-
  derived from job/resume/profile data, URLs, credentials, text, selectors,
  paths, or provider messages.
- Admission occurs at serialized, orchestration, and retention boundaries.
  Lower ports make unsafe capabilities, including Submit, unrepresentable.
- The unused Local Model Controller is deferred from S1. It may return in S3
  only for a concrete suggestion-review need.
- F2 uses browser-driven fixture navigation with start/reset/close lifecycle.
  The acceptance harness owns an explicit provider-failure wrapper.
- A cancelled or uncertain browser mutation invalidates the owned session; F9
  must reconcile or restart before another mutation.
- The same MCP `requestId` and identical request returns the recorded result.
  The same `requestId` with changed input fails closed.
- While operation A is active, replaying A's identical `requestId`/request returns A's
  accepted/recorded state or result. A distinct operation B is recorded once as
  busy, and replaying B remains busy after A completes. Neither path repeats a
  side effect.
- S1 proves deterministic local persistence and reload within a run. Crash and
  process-restart recovery is deferred to S2 unless a persisted-result read
  boundary is approved during R2.
- Admission first proves an ordinary side-effect-free data graph without
  executing getters or proxy traps, then copies allowed primitive JSON data to
  a new deep-frozen snapshot. The caller object is irrelevant afterward and
  later mutation cannot alter or invalidate the snapshot. Its opaque one-use
  capability is bound to journey, attempt, guard revision, and exact snapshot;
  stale/reused/crossed capability or any substitute graph causes no retention
  or side effect.
- Resume resolution produces one immutable bounded artifact handle covering the
  exact bytes, size, and digest. Upload consumes that handle/stream and never
  reopens a path. Source mutation after resolution either cannot alter the
  private captured bytes or yields `artifact_changed` before browser side
  effect; changed bytes are never silently read/uploaded. Bytes are disposed
  after the operation.

## Parallelism and review

With four agent slots, use one coordinator and at most three isolated task
agents. Parallel work is allowed only when owned files do not overlap and every
branch passes the exact-base check.

Each component, F12, and F13 receives one independent acceptance review and at
most two targeted repair/recheck cycles. Review rechecks findings, affected
paths, and connected behavior rather than restarting an unbounded repository
audit. Any remaining P0/P1 after the budget yields `not accepted`.

## Downstream stages

S2 and S3 remain shaped but provisional. After S1, S2 first freezes live
browser lifecycle, secure credential typing, mailbox, and recovery contracts.
S3 freezes any corpus-driven contract delta before parallel variant closure.
Neither stage begins implementation from draft S1 interfaces.
