import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { componentBoundaries } from "../../src/contracts/ownership.ts";

const expectedComponents = {
  F2: {
    sourceOwnership: [
      "fixtures/workday/s1/**",
      "src/testing/fixture-server.ts",
      "src/testing/fixture-state.ts",
    ],
    ports: { FixtureRuntime: ["F12/F13 composition"] },
  },
  F3: {
    sourceOwnership: ["src/browser/**"],
    ports: {
      BrowserSession: [
        "F7 Field Drivers",
        "F8 Verification/Navigation",
        "F9 Orchestrator",
      ],
    },
  },
  F4: {
    sourceOwnership: ["src/intake/**", "src/profile/**", "src/journey/**"],
    ports: {
      JourneyIntake: ["F9 Orchestrator"],
      ProfileQuery: ["F6 Answer Resolver"],
      JourneyStateStore: ["F9 Orchestrator"],
    },
  },
  F5: {
    sourceOwnership: [
      "src/ats/**",
      "src/form/discovery/**",
      "src/form/ui/**",
      "src/form/semantic-snapshot.ts",
    ],
    ports: { PageUnderstanding: ["F9 Orchestrator"] },
  },
  F6: {
    sourceOwnership: [
      "src/form/questions/**",
      "src/form/answers/**",
      "src/form/options/**",
    ],
    ports: { AnswerResolver: ["F9 Orchestrator"] },
  },
  F7: {
    sourceOwnership: ["src/interaction/drivers/**"],
    ports: { FieldDriver: ["F9 Orchestrator"] },
  },
  F8: {
    sourceOwnership: [
      "src/interaction/verification/**",
      "src/interaction/completion/**",
      "src/interaction/navigation/**",
    ],
    ports: {
      FieldVerifier: ["F9 Orchestrator"],
      CompletionNavigation: ["F9 Orchestrator"],
    },
  },
  F9: {
    sourceOwnership: ["src/control/orchestrator/**", "src/control/mcp/**"],
    ports: {
      JourneyControl: ["F9 MCP Facade"],
      McpJourneyApi: ["External MCP Client"],
    },
  },
  F10: {
    sourceOwnership: ["src/observability/**"],
    ports: {
      EventSink: [
        "F2 Fixture Runtime",
        "F3 Browser Adapter",
        "F4 Journey State",
        "F5 Page Understanding",
        "F6 Answer Resolver",
        "F7 Field Drivers",
        "F8 Verification/Navigation",
        "F9 Orchestrator",
        "F11 Safety/Evidence",
      ],
      ProgressReader: ["F9 MCP Facade"],
      FailureReporter: ["F9 Orchestrator"],
    },
  },
  F11: {
    sourceOwnership: [
      "src/safety/**",
      "src/evidence/**",
      "src/control/model/**",
    ],
    ports: {
      PrivacyGuard: [
        "F2 Fixture Runtime",
        "F4 Intake/Profile",
        "F9 MCP Facade",
        "F10 Observability",
      ],
      SafetyGuard: [
        "F3 Browser Adapter",
        "F7 Field Drivers",
        "F8 Verification/Navigation",
        "F9 Orchestrator",
      ],
      EvidenceStore: ["F9 Orchestrator", "F10 Failure Reporter"],
      ModelController: ["F9 Orchestrator"],
    },
  },
} as const;

const expectedBehaviors = {
  FixtureRuntime: [
    "F2 owns fixture-server lifecycle, fixture transition state, reset, and fault activation.",
    "Callers may retry start and reset after a timeout; transitions are never retried automatically.",
    "Start accepts cancellation and stops only F2-owned server or state work.",
    "Start is keyed by fixture-run ID, reset is repeatable, and a transition ID applies at most once.",
  ],
  BrowserSession: [
    "F3 alone owns browser/page lifecycle, observation, mutation, navigation, and cleanup.",
    "F3 performs no policy retry; F9 may retry only contract-declared retryable operations.",
    "Every bounded browser operation accepts cancellation and stops at its declared safe boundary.",
    "Duplicate page ownership is rejected, close is repeatable, and a mutation operation ID applies at most once.",
  ],
  JourneyIntake: [
    "F4 validates immutable intake before the JourneyStateStore may persist bootstrap state.",
    "A caller may retry an identical bootstrap request; changed inputs require a new request identity.",
    "Cancellation before persistence leaves no journey state.",
    "An identical bootstrap request returns the same journey identity.",
  ],
  ProfileQuery: [
    "Profile queries are read-only; F4 alone owns profile data.",
    "Read-only queries may be retried with the same request.",
    "Cancellation may stop a query without changing profile data.",
    "The same profile revision and query return the same result.",
  ],
  JourneyStateStore: [
    "F4 alone validates and persists durable journey state; F9 supplies legal transition commands.",
    "Loads are retryable; transition retries require the same operation ID.",
    "Cancellation before commit leaves state unchanged; an acknowledged commit remains committed.",
    "Transition operation IDs and terminal states are idempotent.",
  ],
  PageUnderstanding: [
    "F5 is read-only and owns only semantic classification of bounded F3 observations.",
    "The same immutable browser observation may be classified again.",
    "Cancellation stops classification without mutation.",
    "The same observation produces the same semantic result.",
  ],
  AnswerResolver: [
    "F6 is read-only and never mutates profiles, browser state, or reviewed catalogs.",
    "Resolution may be retried against the same catalog and profile revisions.",
    "Cancellation stops resolution without mutation.",
    "The same semantic field and authoritative inputs return the same result.",
  ],
  FieldDriver: [
    "F7 owns one-driver dispatch and receipt creation; F3 alone performs the requested browser mutation.",
    "F7 never retries mutation; F9 may issue a new attempt only after verification and policy allow it.",
    "Cancellation is forwarded to F3 and returns without claiming verification.",
    "A driver operation ID dispatches at most once and its receipt never claims verification.",
  ],
  FieldVerifier: [
    "F8 owns bounded readback comparison; F3 owns browser reads and F8 never calls F7.",
    "F8 owns only bounded verification polling; F9 owns any mutation retry.",
    "Cancellation stops polling without changing browser state.",
    "Verification is repeatable for the same intent, receipt, and observed state.",
  ],
  CompletionNavigation: [
    "F8 owns completion and navigation decisions; F3 owns navigation and F9 owns the loop.",
    "F8 does not retry navigation; F9 reconciles an uncertain result before another attempt.",
    "Cancellation stops decision or reconciliation work without authorizing navigation.",
    "Completion is pure and reconciliation returns one result per navigation operation ID.",
  ],
  JourneyControl: [
    "F9 alone owns journey/page loop scheduling, operation ownership, retry policy, and cancellation propagation.",
    "F9 applies the only bounded retries and only to errors declared retryable by the providing port.",
    "F9 owns cancellation and propagates it to active bounded operations before terminal state.",
    "Start and cancel are keyed by operation ID; status and terminal reads are repeatable; terminal state is final.",
  ],
  McpJourneyApi: [
    "The F9 MCP facade only validates and forwards commands to JourneyControl.",
    "The facade performs no retry; duplicate transport requests retain their request ID.",
    "Only the explicit cancel operation requests journey cancellation.",
    "Status and result reads are repeatable; mutating requests use operation IDs.",
  ],
  EventSink: [
    "F10 alone admits and appends value-free events and projects monotonic progress.",
    "An append may be retried only with the same event ID.",
    "Cancellation before append leaves no event; an acknowledged append remains recorded.",
    "Event IDs deduplicate appends and terminal events never duplicate terminal progress.",
  ],
  ProgressReader: [
    "Progress reads are side-effect free.",
    "Reads may be retried.",
    "Cancellation stops only the read.",
    "A read never changes progress.",
  ],
  FailureReporter: [
    "F10 owns factual report projection and bounded value-free notification delivery.",
    "Notification retry is bounded and reuses the failure report ID.",
    "Cancellation may stop undelivered notification work but never rewrites the factual report.",
    "A failure report ID produces one terminal report and at most one delivered notification.",
  ],
  PrivacyGuard: [
    "F11 privacy admission is pure and denied content is never retained.",
    "The same bounded payload may be checked again.",
    "Cancellation stops admission without retention.",
    "The same payload and policy revision return the same decision.",
  ],
  SafetyGuard: [
    "F11 safety admission is pure; denied capabilities never reach a side-effect owner.",
    "The same semantic request may be checked again.",
    "Cancellation stops admission without authorization.",
    "The same request and policy revision return the same decision.",
  ],
  EvidenceStore: [
    "F11 alone admits and stores bounded sanitized evidence and replay manifests.",
    "Writes may be retried only with the same evidence record ID.",
    "Cancellation before commit retains nothing; denied content is never written.",
    "Evidence record IDs deduplicate writes and reads never mutate retention.",
  ],
  ModelController: [
    "F11 owns admitted local-model invocation; returned suggestions cannot mutate or choose policy.",
    "F9 may request another suggestion only within its retry budget and with a new attempt ID.",
    "Cancellation stops the bounded model request.",
    "A completed attempt ID returns its recorded semantic result without reinvocation.",
  ],
} as const;

test("every Stage 1 component has complete boundary metadata", () => {
  assert.deepEqual(
    componentBoundaries.map(({ feature }) => feature),
    Object.keys(expectedComponents),
  );

  for (const component of componentBoundaries) {
    const expected = expectedComponents[component.feature];
    assert.deepEqual(component.sourceOwnership, expected.sourceOwnership);
    assert.deepEqual(
      Object.fromEntries(
        component.ports.map(({ name, consumers }) => [name, consumers]),
      ),
      expected.ports,
    );

    assert.ok(component.component);
    assert.ok(component.dataOwnership.length > 0);

    for (const port of component.ports) {
      assert.ok(port.name);
      assert.ok(port.requests.length > 0);
      assert.ok(port.results.length > 0);
      assert.ok(port.errors.length > 0);
      assert.deepEqual(
        [port.sideEffect, port.retry, port.cancellation, port.idempotency],
        expectedBehaviors[port.name],
      );
    }
  }
});

test("source and cross-component data ownership are disjoint", () => {
  const sourceRoots = componentBoundaries.flatMap(
    ({ sourceOwnership }) => sourceOwnership,
  );
  assert.equal(new Set(sourceRoots).size, sourceRoots.length);

  const normalizedRoots = sourceRoots.map((root) => root.replace(/\/\*\*$/, ""));

  for (const [index, root] of normalizedRoots.entries()) {
    assert.ok(!root.startsWith("src/contracts"));
    assert.ok(
      normalizedRoots.every(
        (other, otherIndex) =>
          index === otherIndex ||
          (!root.startsWith(`${other}/`) && !other.startsWith(`${root}/`)),
      ),
      `overlapping source ownership: ${sourceRoots[index]}`,
    );
  }

  const dataNames = componentBoundaries.flatMap(
    ({ dataOwnership }) => dataOwnership,
  );
  assert.equal(new Set(dataNames).size, dataNames.length);

  const portNames = componentBoundaries.flatMap(({ ports }) =>
    ports.map(({ name }) => name),
  );
  assert.equal(new Set(portNames).size, portNames.length);
});

test("F9 coordinates field data without making peers port consumers", () => {
  const dataOwners: Record<string, string> = Object.fromEntries(
    componentBoundaries.flatMap(({ feature, dataOwnership }) =>
      dataOwnership.map((name) => [name, feature]),
    ),
  );

  assert.equal(dataOwners.FieldIntent, "F6");
  assert.equal(dataOwners.MutationReceipt, "F7");
  assert.deepEqual(expectedComponents.F6.ports.AnswerResolver, [
    "F9 Orchestrator",
  ]);
  assert.deepEqual(expectedComponents.F7.ports.FieldDriver, ["F9 Orchestrator"]);
});

test("the human boundary document names the frozen matrix", () => {
  const document = readFileSync("docs/component-boundaries.md", "utf8");
  const requiredTerms = componentBoundaries.flatMap((component) => [
    component.feature,
    component.component,
    ...component.sourceOwnership,
    ...component.dataOwnership,
    ...component.ports.flatMap((port) => [
      port.name,
      ...port.consumers,
      ...port.requests,
      ...port.results,
      ...port.errors,
    ]),
  ]);

  for (const term of requiredTerms) {
    assert.ok(document.includes(term), `missing boundary documentation: ${term}`);
  }

  assert.ok(document.includes("F6-owned FieldIntent to FieldDriver"));
  assert.ok(document.includes("F7-owned MutationReceipt to FieldVerifier"));
});
