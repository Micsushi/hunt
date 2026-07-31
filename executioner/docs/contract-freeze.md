# C3 Stage 1 contract freeze

Status: R2 draft, not accepted

The historical R1 contract source is Git revision
`d95e845e61bcf0a030b3b07c6d6261e3d95c1fad`. R2 amends that source and does
not yet have an accepted F1 base. T8 records the accepted SHA and contract tree
object IDs after authorized commit and review. Until then, no component may
claim this draft as its accepted base.

## Serialized versions

All accepted serialized boundaries are schema version 2. Error envelopes and
terminal results changed their closed stable-error enum. MCP request and
response removed caller operation IDs and retain the bounded `requestId` as
the sole caller idempotency key. Fixture manifests, durable journey state,
event envelopes, and evidence manifests now enforce tighter bounded coordinate
or generated-identifier grammars used by their TypeScript contracts. Those
stricter grammars are also incompatible with their version 1 wire shapes.

F2 through F11 must start from the final accepted F1 tip recorded in the Hunt
handoff. That tip contains this contract revision and the shared test kit. A
component branch may use the types, fixtures, fakes, and conformance helper. It
must not edit the contract or import a peer implementation.

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
