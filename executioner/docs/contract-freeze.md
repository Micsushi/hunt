# C3 Stage 1 contract freeze

The in-process contract source is frozen at Git revision
`f75c5b5e483fc1e58372e6872a284fb7782a5390`. The conformance suite rejects
changes under `executioner/src/contracts` until this record is deliberately
updated.

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
They do not simulate component behavior or replace F12 connection tests.
