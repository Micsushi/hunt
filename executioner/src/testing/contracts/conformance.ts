import type { PortResult } from "../../contracts/index.ts";
import { contractFixtures } from "./fixtures.ts";
import {
  successResultValidators,
  type SuccessValidator,
} from "./success-results.ts";
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

const redactionCodes = [
  "credential_forbidden",
  "token_forbidden",
  "raw_text_forbidden",
  "selector_forbidden",
  "policy_override_forbidden",
  "submit_forbidden",
  "payload_too_large",
] as const;

const declaredErrorCodes = {
  FixtureRuntime: [
    "fixture_not_found",
    "fixture_already_started",
    "fixture_transition_illegal",
    "fixture_transition_replayed",
    "fixture_timeout",
  ],
  BrowserSession: [
    "browser_target_invalid",
    "browser_page_owned",
    "browser_session_missing",
    "browser_target_stale",
    "browser_target_ambiguous",
    "browser_operation_replayed",
    "browser_timeout",
  ],
  JourneyIntake: [
    "journey_input_invalid",
    "resume_identity_mismatch",
  ],
  ProfileQuery: ["profile_missing", "profile_revision_mismatch"],
  JourneyStateStore: [
    "journey_state_invalid",
    "journey_transition_illegal",
    "journey_revision_conflict",
    "journey_state_unavailable",
  ],
  PageUnderstanding: ["page_observation_invalid"],
  AnswerResolver: [
    "question_unknown",
    "question_ambiguous",
    "protected_answer_denied",
  ],
  FieldDriver: [
    "driver_intent_invalid",
    "driver_behavior_unsupported",
    "driver_target_invalid",
    "driver_operation_replayed",
  ],
  FieldVerifier: [
    "verification_input_invalid",
    "verification_timeout",
  ],
  CompletionNavigation: [
    "page_incomplete",
    "navigation_illegal",
    "navigation_uncertain",
  ],
  JourneyControl: [
    "journey_operation_replayed",
    "journey_not_found",
    "journey_already_terminal",
    "journey_busy",
    "journey_retry_exhausted",
  ],
  McpJourneyApi: [
    "mcp_request_invalid",
    "mcp_method_unknown",
    "mcp_internal_error",
  ],
  EventSink: [
    "event_invalid",
    "event_store_unavailable",
    "progress_not_found",
  ],
  ProgressReader: [
    "event_invalid",
    "event_store_unavailable",
    "progress_not_found",
  ],
  FailureReporter: [
    "failure_context_invalid",
    "notification_unavailable",
  ],
  PrivacyGuard: redactionCodes,
  SafetyGuard: redactionCodes,
  EvidenceStore: [
    "evidence_denied",
    "evidence_limit_exceeded",
    "evidence_unavailable",
  ],
  ModelController: [
    "model_request_denied",
    "model_result_denied",
    "model_unavailable",
  ],
} as const satisfies Record<ContractPortName, readonly string[]>;

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
    const coordinate = `${name}.${operation}`;
    const result = await invoke.call(
      provider,
      request,
      new AbortController().signal,
    );
    const validator = (
      successResultValidators[name] as Record<string, SuccessValidator>
    )[operation];
    if (validator === undefined) {
      throw new TypeError(`${coordinate} has no success validator`);
    }
    assertLiveResult(
      coordinate,
      result,
      validator,
      declaredErrorCodes[name],
    );

    const cancelledResult = await invoke.call(
      provider,
      request,
      AbortSignal.abort(),
    );
    assertCancelledResult(coordinate, cancelledResult);
  }
}

function assertLiveResult(
  coordinate: string,
  value: unknown,
  validateSuccess: SuccessValidator,
  allowedErrors: readonly string[],
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
    if (
      !validateSuccess(
        (value as unknown as { readonly value: unknown }).value,
      )
    ) {
      throw new TypeError(`${coordinate} returned an invalid success result`);
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

  const code = (error as { readonly code: string }).code;
  if (code === "operation_cancelled") {
    throw new TypeError(
      `${coordinate} live signal returned operation_cancelled`,
    );
  }
  if (!allowedErrors.includes(code)) {
    throw new TypeError(
      `${coordinate} returned ${code}, which is not a declared error`,
    );
  }
}

function assertCancelledResult(
  coordinate: string,
  value: unknown,
): void {
  if (
    !(
      typeof value === "object" &&
      value !== null &&
      Object.keys(value).length === 2 &&
      (value as { readonly ok?: unknown }).ok === false &&
      Object.hasOwn(value, "error")
    )
  ) {
    throw new TypeError(
      `${coordinate} aborted signal must return operation_cancelled`,
    );
  }
  const error = (value as { readonly error: unknown }).error;
  if (
    !(
      typeof error === "object" &&
      error !== null &&
      Object.keys(error).length === 2 &&
      (error as { readonly code?: unknown }).code ===
        "operation_cancelled" &&
      (error as { readonly retryable?: unknown }).retryable === false
    )
  ) {
    throw new TypeError(
      `${coordinate} aborted signal must return operation_cancelled`,
    );
  }
}
