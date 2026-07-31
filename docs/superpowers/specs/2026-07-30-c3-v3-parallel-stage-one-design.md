# C3 v3 Parallel Stage One Design

Status: approved by the owner on 2026-07-30

## Goal

Implement every Stage 1 C3 component in parallel worktrees after one shared
contract freeze, test each component without another component implementation,
then verify real connections and the complete controlled journey.

The Stage 1 product outcome is unchanged: one bounded MCP request traverses
controlled Workday fixtures, independently verifies every mutation, reaches
mock Review, emits useful value-free progress, reports injected failure
factually, and never exposes final Submit.

## Chosen structure

Stage 1 uses component-aligned features:

1. Contract kernel and component test kit.
2. Controlled fixture runtime.
3. Browser session adapter.
4. Intake, profile, bootstrap, and journey state.
5. Workday page understanding.
6. Question, answer, and option resolution.
7. Field interaction drivers.
8. Independent verification, completion, and navigation.
9. Orchestrator and MCP facade.
10. Events, progress, and factual failure reporting.
11. Privacy, safety, and sanitized evidence.
12. Cross-component connection verification.
13. Integrated controlled-journey acceptance.

F1 lands first and freezes the shared boundary. F2-F11 then branch from the
same contract revision and run independently. F12 connects accepted component
implementations. F13 proves the unchanged end-to-end Stage 1 outcome.

## Boundary model

Every component boundary names:

- provider and consumer;
- request and result types;
- closed stable error variants;
- side-effect owner;
- cancellation, retry, and idempotency behavior;
- frozen F1 revision for in-process ports;
- explicit version for serialized contracts;
- fake implementation;
- provider conformance tests; and
- consumer tests that run against the fake.

In-process boundaries use TypeScript types and interfaces. JSON Schema is used
only where data crosses a serialization boundary: MCP, fixtures, persisted
journey state, events, errors, evidence manifests, and terminal results.

No component imports another component's implementation. The composition root
is the only place that joins real implementations.

## Parallel worktree model

- F1 has one shared-contract owner.
- F2-F11 each have one feature branch and primary worktree owner.
- Multiple agents may work inside a feature only when its task file and source
  ownership are disjoint.
- A feature branch starts from the frozen F1 revision.
- Completed component branches wait unchanged until connection verification.
- Contract changes are not made from component branches. A missing or defective
  contract is escalated to the owner and frozen at a new F1 revision;
  serialized schemas are versioned when they change.
- F12 has the integration-candidate and connection-suite owner. It combines
  exact accepted F2-F11 tips in numeric order without editing component code;
  conflicts return to component owners.
- F13 branches from the accepted F12 connection revision and has the
  composition and acceptance owner.

## Testing model

Each component feature must pass before integration:

1. focused unit tests;
2. provider conformance against the frozen port;
3. consumer behavior against shared fakes;
4. malformed-input and stable-error cases;
5. side-effect and ownership checks;
6. import-boundary checks; and
7. the common TypeScript quality gate.

F12 starts only after every F2-F11 component is accepted and owns real
connection tests:

- fixtures to browser;
- browser to page understanding;
- intake/profile to answer resolution;
- understanding/answers to drivers;
- real browser operations to drivers and independent verification/navigation;
- verification to completion/navigation;
- every real runtime component port to orchestrator; and
- events to observability, safety, and evidence.

F13 alone owns the complete multi-page journey and injected-failure acceptance.

## Unavoidable cross-component blockers

Only these blockers are planned:

- F2-F11 wait for the F1 contract freeze.
- An affected feature pauses for an approved F1 contract correction.
- F12 waits for all F2-F11 component features and combines their accepted tips.
- F13 waits for the complete F12 connection gate.
- S2 waits for F13 Stage 1 acceptance.

No component implementation task may depend on another component
implementation. If one does, the plan must be corrected rather than allowing
an implementation import.

## Ponytail rules

Ponytail full is required for every implementation and review task.

- Keep one `executioner` TypeScript package.
- Use Node, TypeScript, Playwright, and installed dependencies before adding a
  package.
- Use one shared fake and conformance kit.
- Do not create component services, plugin systems, generic workflow engines,
  factories for one implementation, or post-S3 extension points.
- Do not duplicate normalization, retry, ID, event, or error helpers.
- Add the smallest test that proves each non-trivial behavior.
- Preserve validation, privacy, safety, independent verification, and Submit
  denial even when a shorter implementation is available.

## Ownership boundaries

Feature source ownership is disjoint:

- F1: contracts, contract tests, test kit, dependency rules.
- F2: fixture assets and fixture server.
- F3: browser/session adapter.
- F4: intake, profile, bootstrap, journey reducer/store.
- F5: ATS detection, Workday page handling, field/UI reading.
- F6: questions, answers, options, narrative template.
- F7: field drivers and driver registry.
- F8: verification, completion, navigation, Review stop.
- F9: orchestrator and MCP.
- F10: events, progress, errors, failure context, notifications.
- F11: privacy, safety, model admission, evidence, replay.
- F12: integration-candidate assembly and connection tests; no component edits.
- F13: composition wiring, acceptance runner, public S1 verification; no loop
  or retry policy.

Shared source outside F1 is changed only through explicit contract-owner
coordination.

## Rejected structures

- Keeping the four serial implementation features was rejected because it
  produces fifteen dependency waves for sixteen tasks.
- One branch per tiny class was rejected because coordination and duplicate
  scaffolding would exceed useful parallelism.
- Separate packages or services were rejected because C3 is one local process
  and needs only in-process ports.
