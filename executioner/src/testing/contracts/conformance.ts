import type { PortResult } from "../../contracts/index.ts";
import { contractFixtures } from "./fixtures.ts";
import type {
  ContractPortMap,
  ContractPortName,
} from "./types.ts";

type PortRequests<P> = {
  readonly [K in keyof P]: P[K] extends (
    request: infer R,
    signal: AbortSignal,
  ) => Promise<unknown>
    ? R
    : never;
};

const requests = {
  FixtureRuntime: {
    start: { fixtureRunId: "fixture-run-synthetic" },
    transition: {
      fixtureRunId: "fixture-run-synthetic",
      transitionId: "transition-synthetic",
      toPageId: "fixture-profile",
    },
    reset: { fixtureRunId: "fixture-run-synthetic" },
    setFault: {
      fixtureRunId: "fixture-run-synthetic",
      fault: "component_failure",
    },
  },
  BrowserSession: {
    start: {
      journeyId: contractFixtures.journeyState.journeyId,
      target: "https://fixture.invalid/account",
    },
    observe: {
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: contractFixtures.browserObservation.pageId,
    },
    mutate: {
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: contractFixtures.browserObservation.pageId,
      operationId: contractFixtures.mutationReceipt.operationId,
      mutation: {
        kind: "type",
        target: contractFixtures.field.target,
        text: "Synthetic",
      },
    },
    navigate: {
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: contractFixtures.browserObservation.pageId,
      operationId: contractFixtures.mutationReceipt.operationId,
      action: "next",
    },
    close: {
      sessionId: contractFixtures.browserObservation.sessionId,
    },
  },
  JourneyIntake: {
    bootstrap: {
      operationId: "operation-synthetic",
      jobId: contractFixtures.job.jobId,
      resumeId: contractFixtures.resume.resumeId,
      profileId: contractFixtures.profile.profileId,
    },
  },
  ProfileQuery: {
    query: {
      profileId: contractFixtures.profile.profileId,
      profileRevision: contractFixtures.profile.revision,
      factId: "given_name",
    },
  },
  JourneyStateStore: {
    load: {
      journeyId: contractFixtures.journeyState.journeyId,
    },
    transition: {
      journeyId: contractFixtures.journeyState.journeyId,
      operationId: "operation-synthetic",
      expectedRevision: contractFixtures.journeyState.revision,
      status: "running",
      pageId: contractFixtures.journeyState.pageId,
    },
  },
  PageUnderstanding: {
    understand: {
      observation: contractFixtures.browserObservation,
    },
  },
  AnswerResolver: {
    resolve: {
      field: contractFixtures.field,
      profileId: contractFixtures.profile.profileId,
      profileRevision: contractFixtures.profile.revision,
      resume: contractFixtures.resume,
    },
  },
  FieldDriver: {
    drive: {
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: contractFixtures.browserObservation.pageId,
      operationId: contractFixtures.mutationReceipt.operationId,
      intent: contractFixtures.intent,
    },
  },
  FieldVerifier: {
    verify: {
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: contractFixtures.browserObservation.pageId,
      intent: contractFixtures.intent,
      receipt: contractFixtures.mutationReceipt,
    },
  },
  CompletionNavigation: {
    complete: {
      page: contractFixtures.pageSnapshot,
      verification: [contractFixtures.verification],
    },
    reconcile: {
      operationId: contractFixtures.mutationReceipt.operationId,
      decision: { kind: "next", expectedPage: "questionnaire" },
      observation: {
        operationId: contractFixtures.mutationReceipt.operationId,
        fromPageId: contractFixtures.browserObservation.pageId,
        pageId: "page-questionnaire",
      },
      expected: { kind: "workday", page: "questionnaire" },
      observed: { kind: "workday", page: "questionnaire" },
    },
  },
  JourneyControl: {
    start: {
      operationId: "operation-synthetic",
      jobId: contractFixtures.job.jobId,
      resumeId: contractFixtures.resume.resumeId,
      profileId: contractFixtures.profile.profileId,
    },
    cancel: {
      operationId: "operation-cancel-synthetic",
      journeyId: contractFixtures.journeyState.journeyId,
    },
    status: {
      journeyId: contractFixtures.journeyState.journeyId,
    },
    result: {
      journeyId: contractFixtures.journeyState.journeyId,
    },
  },
  McpJourneyApi: {
    handle: {
      schemaVersion: 1,
      requestId: "request-synthetic",
      method: "journey_result",
      params: {
        journeyId: contractFixtures.journeyState.journeyId,
      },
    },
  },
  EventSink: {
    append: {
      event: contractFixtures.event,
    },
  },
  ProgressReader: {
    read: {
      journeyId: contractFixtures.journeyState.journeyId,
    },
  },
  FailureReporter: {
    report: {
      reportId: "report-synthetic",
      context: {
        journeyId: contractFixtures.journeyState.journeyId,
        component: "F9",
        phase: "orchestration",
        step: "start",
        code: "journey_not_found",
        retryable: false,
        source: {
          kind: "operation",
          id: "operation-synthetic",
        },
      },
    },
  },
  PrivacyGuard: {
    admit: {
      policyRevision: "policy-s1",
      semanticPayload: { fixture: "synthetic" },
    },
  },
  SafetyGuard: {
    admit: {
      policyRevision: "policy-s1",
      capability: "observe",
    },
  },
  EvidenceStore: {
    write: {
      journeyId: contractFixtures.journeyState.journeyId,
      record: contractFixtures.evidenceRecord,
    },
    read: {
      journeyId: contractFixtures.journeyState.journeyId,
    },
  },
  ModelController: {
    suggest: {
      attemptId: "attempt-synthetic",
      questionId: "question-synthetic",
      allowedOptionIds: ["option-synthetic"],
    },
  },
} as const satisfies {
  readonly [N in ContractPortName]: PortRequests<ContractPortMap[N]>;
};

export const contractPortOperations = Object.fromEntries(
  Object.entries(requests).map(([name, portRequests]) => [
    name,
    Object.keys(portRequests),
  ]),
) as unknown as {
  readonly [N in ContractPortName]: readonly (keyof ContractPortMap[N] & string)[];
};

export async function assertProviderConformance<N extends ContractPortName>(
  name: N,
  provider: ContractPortMap[N],
): Promise<void> {
  const dynamicProvider = provider as unknown as Record<
    string,
    (request: unknown, signal: AbortSignal) => Promise<unknown>
  >;

  for (const [operation, request] of Object.entries(requests[name])) {
    const invoke = dynamicProvider[operation];
    if (typeof invoke !== "function") {
      throw new TypeError(`${name}.${operation} must be a function`);
    }
    const result = await invoke.call(
      provider,
      request,
      new AbortController().signal,
    );
    assertPortResult(`${name}.${operation}`, result);
  }
}

function assertPortResult(
  coordinate: string,
  value: unknown,
): asserts value is PortResult<unknown, unknown> {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    throw new TypeError(`${coordinate} must return a PortResult object`);
  }

  if (value.ok === true) {
    if (
      !Object.hasOwn(value, "value") ||
      Object.hasOwn(value, "error") ||
      Object.keys(value).some((key) => key !== "ok" && key !== "value")
    ) {
      throw new TypeError(
        `${coordinate} success must contain only ok and value`,
      );
    }
    return;
  }

  if (
    value.ok !== false ||
    !Object.hasOwn(value, "error") ||
    Object.hasOwn(value, "value") ||
    Object.keys(value).some((key) => key !== "ok" && key !== "error")
  ) {
    throw new TypeError(
      `${coordinate} failure must contain only ok and error`,
    );
  }

  const error = (value as unknown as { readonly error: unknown }).error;
  if (
    typeof error !== "object" ||
    error === null ||
    typeof (error as { code?: unknown }).code !== "string" ||
    typeof (error as { retryable?: unknown }).retryable !== "boolean"
  ) {
    throw new TypeError(
      `${coordinate} error must contain code and retryable`,
    );
  }

  if (
    Object.keys(error).some(
      (key) => key !== "code" && key !== "retryable",
    )
  ) {
    throw new TypeError(
      `${coordinate} error must contain only code and retryable`,
    );
  }
}
