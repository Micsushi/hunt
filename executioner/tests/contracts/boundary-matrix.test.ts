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
    dataOwnership: [
      "FixtureManifest",
      "FixturePageId",
      "FixtureSemanticHash",
      "FixtureRunState",
    ],
    ports: {
      FixtureRuntime: {
        consumers: ["F12/F13 composition"],
        requests: [
          "FixtureStartRequest",
          "FixtureTransitionRequest",
          "FixtureResetRequest",
          "FixtureFaultRequest",
        ],
        results: [
          "FixtureStartResult",
          "FixtureTransitionResult",
          "FixtureResetResult",
        ],
        errors: ["FixtureRuntimeError"],
      },
    },
  },
  F3: {
    sourceOwnership: ["src/browser/**"],
    dataOwnership: [
      "BrowserSessionId",
      "BrowserPageId",
      "BrowserTargetToken",
      "BrowserObservation",
      "BrowserOperationReceipt",
    ],
    ports: {
      BrowserSession: {
        consumers: [
          "F7 Field Drivers",
          "F8 Verification/Navigation",
          "F9 Orchestrator",
        ],
        requests: [
          "BrowserStartRequest",
          "BrowserObservationRequest",
          "BrowserMutationRequest",
          "BrowserNavigationRequest",
          "BrowserCloseRequest",
        ],
        results: [
          "BrowserSessionResult",
          "BrowserObservation",
          "BrowserOperationReceipt",
          "BrowserNavigationObservation",
        ],
        errors: ["BrowserSessionError"],
      },
    },
  },
  F4: {
    sourceOwnership: ["src/intake/**", "src/profile/**", "src/journey/**"],
    dataOwnership: [
      "JobIntake",
      "ResumeSelection",
      "JourneyInputs",
      "JourneyId",
      "ApplicantProfile",
      "ProfileAnswerProvenance",
      "DurableJourneyState",
    ],
    ports: {
      JourneyIntake: {
        consumers: ["F9 Orchestrator"],
        requests: ["JourneyBootstrapRequest"],
        results: ["JourneyInputs", "JourneyBootstrapResult"],
        errors: ["JourneyInputError"],
      },
      ProfileQuery: {
        consumers: ["F6 Answer Resolver"],
        requests: ["ProfileQueryRequest"],
        results: ["ProfileAnswerResult"],
        errors: ["ProfileQueryError"],
      },
      JourneyStateStore: {
        consumers: ["F9 Orchestrator"],
        requests: [
          "JourneyStateLoadRequest",
          "JourneyStateTransitionCommand",
        ],
        results: [
          "JourneyStateLoadResult",
          "JourneyStateTransitionResult",
        ],
        errors: ["JourneyStateError"],
      },
    },
  },
  F5: {
    sourceOwnership: [
      "src/ats/**",
      "src/form/discovery/**",
      "src/form/ui/**",
      "src/form/semantic-snapshot.ts",
    ],
    dataOwnership: [
      "PageIdentity",
      "FieldObservation",
      "SemanticPageSnapshot",
      "UiBehaviorId",
    ],
    ports: {
      PageUnderstanding: {
        consumers: ["F9 Orchestrator"],
        requests: ["PageUnderstandingRequest"],
        results: ["PageUnderstandingResult", "SemanticPageSnapshot"],
        errors: ["PageUnderstandingError"],
      },
    },
  },
  F6: {
    sourceOwnership: [
      "src/form/questions/**",
      "src/form/answers/**",
      "src/form/options/**",
    ],
    dataOwnership: [
      "QuestionId",
      "OptionId",
      "AnswerProvenance",
      "FieldIntent",
    ],
    ports: {
      AnswerResolver: {
        consumers: ["F9 Orchestrator"],
        requests: ["AnswerResolutionRequest"],
        results: ["AnswerResolutionResult", "FieldIntent"],
        errors: ["AnswerResolutionError"],
      },
    },
  },
  F7: {
    sourceOwnership: ["src/interaction/drivers/**"],
    dataOwnership: ["DriverBehaviorId", "MutationReceipt"],
    ports: {
      FieldDriver: {
        consumers: ["F9 Orchestrator"],
        requests: ["DriverRequest"],
        results: ["MutationReceipt"],
        errors: ["DriverError"],
      },
    },
  },
  F8: {
    sourceOwnership: [
      "src/interaction/verification/**",
      "src/interaction/completion/**",
      "src/interaction/navigation/**",
    ],
    dataOwnership: [
      "VerificationResult",
      "PageCompletionResult",
      "NavigationDecision",
      "NavigationResult",
    ],
    ports: {
      FieldVerifier: {
        consumers: ["F9 Orchestrator"],
        requests: ["VerificationRequest"],
        results: ["VerificationResult"],
        errors: ["VerificationError"],
      },
      CompletionNavigation: {
        consumers: ["F9 Orchestrator"],
        requests: [
          "PageCompletionRequest",
          "NavigationReconciliationRequest",
        ],
        results: [
          "PageCompletionResult",
          "NavigationDecision",
          "NavigationResult",
        ],
        errors: ["NavigationError"],
      },
    },
  },
  F9: {
    sourceOwnership: ["src/control/orchestrator/**", "src/control/mcp/**"],
    dataOwnership: [
      "OperationId",
      "JourneyStatus",
      "TerminalResult",
      "McpRequest",
      "McpResponse",
    ],
    ports: {
      JourneyControl: {
        consumers: ["F9 MCP Facade"],
        requests: [
          "StartJourneyCommand",
          "CancelJourneyCommand",
          "JourneyStatusQuery",
          "JourneyResultQuery",
        ],
        results: [
          "JourneyOperationResult",
          "JourneyStatus",
          "TerminalResult",
        ],
        errors: ["OrchestratorError"],
      },
      McpJourneyApi: {
        consumers: ["External MCP Client"],
        requests: ["McpRequest"],
        results: ["McpResponse"],
        errors: ["McpTransportError"],
      },
    },
  },
  F10: {
    sourceOwnership: ["src/observability/**"],
    dataOwnership: [
      "EventEnvelope",
      "JourneyProgress",
      "FailureContext",
      "FailureReport",
      "NotificationRecord",
    ],
    ports: {
      EventSink: {
        consumers: [
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
        requests: ["EventAppendRequest"],
        results: ["EventAppendResult", "JourneyProgress"],
        errors: ["ObservabilityError"],
      },
      ProgressReader: {
        consumers: ["F9 MCP Facade"],
        requests: ["ProgressReadRequest"],
        results: ["JourneyProgress"],
        errors: ["ObservabilityError"],
      },
      FailureReporter: {
        consumers: ["F9 Orchestrator"],
        requests: ["FailureReportRequest"],
        results: ["FailureReport", "NotificationRecord"],
        errors: ["FailureReportingError"],
      },
    },
  },
  F11: {
    sourceOwnership: [
      "src/safety/**",
      "src/evidence/**",
      "src/control/model/**",
    ],
    dataOwnership: [
      "AdmissionDecision",
      "RedactionCode",
      "EvidenceManifest",
      "EvidenceRecord",
      "ModelSuggestion",
    ],
    ports: {
      PrivacyGuard: {
        consumers: [
          "F2 Fixture Runtime",
          "F4 Intake/Profile",
          "F9 MCP Facade",
          "F10 Observability",
        ],
        requests: ["PrivacyAdmissionRequest"],
        results: ["AdmissionDecision"],
        errors: ["PrivacyDenial"],
      },
      SafetyGuard: {
        consumers: [
          "F3 Browser Adapter",
          "F7 Field Drivers",
          "F8 Verification/Navigation",
          "F9 Orchestrator",
        ],
        requests: ["SafetyAdmissionRequest"],
        results: ["AdmissionDecision"],
        errors: ["SafetyDenial"],
      },
      EvidenceStore: {
        consumers: ["F9 Orchestrator", "F10 Failure Reporter"],
        requests: ["EvidenceAdmissionRequest", "EvidenceReadRequest"],
        results: ["EvidenceWriteResult", "EvidenceManifest"],
        errors: ["EvidenceError"],
      },
      ModelController: {
        consumers: ["F9 Orchestrator"],
        requests: ["ModelSuggestionRequest"],
        results: ["ModelSuggestionResult"],
        errors: ["ModelAdmissionError"],
      },
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
    assert.deepEqual(component.dataOwnership, expected.dataOwnership);
    assert.deepEqual(
      Object.fromEntries(
        component.ports.map(({ name, consumers, requests, results, errors }) => [
          name,
          { consumers, requests, results, errors },
        ]),
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
  assert.deepEqual(expectedComponents.F6.ports.AnswerResolver.consumers, [
    "F9 Orchestrator",
  ]);
  assert.deepEqual(expectedComponents.F7.ports.FieldDriver.consumers, [
    "F9 Orchestrator",
  ]);
});

function portSection(document: string, name: string): string {
  const heading = `**${name}**`;
  const start = document.indexOf(heading);
  assert.notEqual(start, -1, `missing port section: ${name}`);

  const contentStart = start + heading.length;
  const ends = [
    document.indexOf("\n**", contentStart),
    document.indexOf("\n###", contentStart),
    document.indexOf("\n## ", contentStart),
  ].filter((index) => index >= 0);
  return document.slice(
    contentStart,
    ends.length === 0 ? undefined : Math.min(...ends),
  );
}

function bullet(
  section: string,
  singular: string,
  plural = singular,
): string {
  const prefixes = [`- ${singular}: `, `- ${plural}: `];
  const lines = section.split(/\r?\n/);
  const index = lines.findIndex((line) =>
    prefixes.some((prefix) => line.startsWith(prefix)),
  );
  assert.notEqual(index, -1, `missing ${singular} bullet`);

  const line = lines[index];
  assert.ok(line !== undefined);
  const prefix = prefixes.find((candidate) => line.startsWith(candidate));
  assert.ok(prefix !== undefined);

  let value = line.slice(prefix.length);
  for (let next = index + 1; lines[next]?.startsWith("  "); next += 1) {
    value += ` ${lines[next]?.trim()}`;
  }
  return value;
}

function listBullet(
  section: string,
  singular: string,
  plural: string,
): string[] {
  return bullet(section, singular, plural).replace(/\.$/, "").split(", ");
}

test("each human port section exactly matches the frozen matrix", () => {
  const document = readFileSync("docs/component-boundaries.md", "utf8");
  const requiredTerms = componentBoundaries.flatMap((component) => [
    component.feature,
    component.component,
    ...component.sourceOwnership,
    ...component.dataOwnership,
  ]);

  for (const term of requiredTerms) {
    assert.ok(document.includes(term), `missing boundary documentation: ${term}`);
  }

  for (const component of componentBoundaries) {
    for (const port of component.ports) {
      const section = portSection(document, port.name);
      assert.deepEqual(
        listBullet(section, "Consumer", "Consumers"),
        port.consumers,
      );
      assert.deepEqual(
        listBullet(section, "Request", "Requests"),
        port.requests,
      );
      assert.deepEqual(listBullet(section, "Result", "Results"), port.results);
      assert.deepEqual(listBullet(section, "Error", "Errors"), port.errors);
      assert.equal(bullet(section, "Side effect owner"), port.sideEffect);
      assert.equal(bullet(section, "Retry"), port.retry);
      assert.equal(bullet(section, "Cancellation"), port.cancellation);
      assert.equal(bullet(section, "Idempotency"), port.idempotency);
    }
  }

  assert.ok(document.includes("F6-owned FieldIntent to FieldDriver"));
  assert.ok(document.includes("F7-owned MutationReceipt to FieldVerifier"));
});
