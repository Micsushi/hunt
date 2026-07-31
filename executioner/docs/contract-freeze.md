# C3 Stage 1 contract freeze

Status: R2.n frozen component baseline

The historical R1 baseline is
`c57c24ef59aec6dd6e2ee8f222aa64695777a0dd`, its contract source is
`d95e845e61bcf0a030b3b07c6d6261e3d95c1fad`, and the recovery planning
revision is `8c5785abf4f0d08dba871744cda006e906dab051`.
The accepted predecessor base is
`13eab5a4cde3e369291d52ca1533f4c82470c820`.

The machine-readable freeze record is `docs/contract-revision.json`. It stores
the four named contract tree object IDs and every authoritative serialized
version. It deliberately does not store the accepted F1 commit because a commit
cannot contain its own hash. After review, the coordinator records that commit
and review evidence in the private acceptance ledger.

## Serialized versions

Fixture manifests, events, errors, evidence, and MCP requests remain schema
version 2. Durable journey state, terminal results, and MCP responses are
schema version 3. MCP requests retain bounded `requestId` as the sole caller
idempotency key.

Version 3 adds the terminal `blocked` status and one separate closed factual
outcome channel. Page-understanding outcomes retain `unknown` or `ambiguous`
with the current page ID. Answer-resolution outcomes retain only
`profile_answer_missing` with its question ID or `unsupported` with its field
ID. Option mismatch and ambiguity are not factual terminal outcomes. No
factual outcome is a `StableErrorCode`, `FailureContext`, `ErrorEnvelope`, or
verified failure cause. Failed terminals require an error code, blocked
terminals require a factual outcome, and the channels are mutually exclusive.

Provider-attributed terminal events at F5 page-understanding classify or F6
answer-resolution resolve project value-free `blocked` progress. The event and
progress wires remain version 2 because their field shapes did not change.
`step_failed` remains failure-path evidence and never projects a factual block.

F2 through F11 must start from the accepted F1 tip recorded by the coordinator.
That tip contains this contract revision and the shared test kit. A component
branch may use the types, fixtures, fakes, and conformance helper. It must not
edit the contract or import a peer implementation.

## Ownership and changes

The F1 owner is the only contract owner. If a component finds a missing or
defective boundary:

1. Pause only the affected component work.
2. Report the exact provider, consumer, request, result, error, or invariant
   that cannot be implemented.
3. Change the contract and its tests on F1, then run the full F1 quality gate
   and independent review.
4. Increase the serialized `schemaVersion` when compatibility breaks. Plain
   TypeScript ports remain pinned by Git revision and have no runtime version
   field.
5. Record the newly accepted contract revision here. Resume affected component
   branches only from the accepted F1 revision.

Fakes are narrow contract examples. They record calls and return one synthetic
success per declared operation, or an explicitly supplied result override.
Provider conformance requires exact deterministic synthetic results or the
case's narrow runtime-owned invariants, plus the exact cancellation result for
each aborted operation. Fakes do not simulate component behavior or replace
F12 connection tests.

## Shared suite ownership

F1 owns `tests/contracts/consumers/browser/**` and
`tests/security/privacy/**`. Component branches run these suites but do not
redefine or independently edit them. Required changes route through the F1
contract owner.
