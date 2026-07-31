import type {
  AnswerResolver,
  BrowserSession,
  CompletionNavigation,
  EvidenceStore,
  EventSink,
  FailureReporter,
  FieldDriver,
  FieldVerifier,
  FixtureRuntime,
  JourneyControl,
  JourneyIntake,
  JourneyStateStore,
  McpJourneyApi,
  ModelController,
  PageUnderstanding,
  PrivacyGuard,
  ProfileQuery,
  ProgressReader,
  SafetyGuard,
} from "../../contracts/index.ts";
import { contractFixtures } from "./fixtures.ts";
import type {
  ContractCall,
  ContractFake,
  ContractPortMap,
  FakeResponseOverrides,
  FakeResponses,
} from "./types.ts";

const cancelled = {
  ok: false,
  error: { code: "operation_cancelled", retryable: false },
} as const;

function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

function createFake<P extends object>(
  defaults: FakeResponses<P>,
  overrides: FakeResponseOverrides<P>,
): ContractFake<P> {
  const calls: ContractCall[] = [];
  const responses = { ...defaults, ...overrides };
  const port = Object.fromEntries(
    Object.keys(defaults).map((operation) => [
      operation,
      async (request: unknown, signal: AbortSignal) => {
        calls.push({ operation, request });
        return signal.aborted
          ? cancelled
          : responses[operation as keyof FakeResponses<P>];
      },
    ]),
  ) as P;

  return { port, calls };
}

export function createFixtureRuntimeFake(
  overrides: FakeResponseOverrides<FixtureRuntime> = {},
): ContractFake<FixtureRuntime> {
  return createFake<FixtureRuntime>(
    {
      start: ok({
        fixtureRunId: "fixture-run-synthetic",
        origin: "https://fixture.invalid",
        pageId: "fixture-account",
      }),
      transition: ok({
        transitionId: "transition-synthetic",
        pageId: "fixture-profile",
        semanticHash: "sha256:fixture-profile",
      }),
      reset: ok({
        fixtureRunId: "fixture-run-synthetic",
        semanticHash: "sha256:fixture-reset",
      }),
      setFault: ok(undefined),
    },
    overrides,
  );
}

export function createBrowserSessionFake(
  overrides: FakeResponseOverrides<BrowserSession> = {},
): ContractFake<BrowserSession> {
  return createFake<BrowserSession>(
    {
      start: ok({
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
      }),
      observe: ok(contractFixtures.browserObservation),
      mutate: ok({
        operationId: contractFixtures.mutationReceipt.operationId,
        pageId: contractFixtures.browserObservation.pageId,
        attempted: true,
      }),
      navigate: ok({
        operationId: contractFixtures.mutationReceipt.operationId,
        fromPageId: contractFixtures.browserObservation.pageId,
        pageId: "page-questionnaire",
      }),
      close: ok(undefined),
    },
    overrides,
  );
}

export function createJourneyIntakeFake(
  overrides: FakeResponseOverrides<JourneyIntake> = {},
): ContractFake<JourneyIntake> {
  return createFake<JourneyIntake>(
    {
      bootstrap: ok({
        journeyId: contractFixtures.journeyState.journeyId,
        inputs: contractFixtures.journeyInputs,
        state: contractFixtures.journeyState,
      }),
    },
    overrides,
  );
}

export function createProfileQueryFake(
  overrides: FakeResponseOverrides<ProfileQuery> = {},
): ContractFake<ProfileQuery> {
  return createFake<ProfileQuery>(
    {
      query: ok({
        kind: "answered",
        value: "Synthetic",
        provenance: "owner_provided",
      }),
    },
    overrides,
  );
}

export function createJourneyStateStoreFake(
  overrides: FakeResponseOverrides<JourneyStateStore> = {},
): ContractFake<JourneyStateStore> {
  return createFake<JourneyStateStore>(
    {
      load: ok({ state: contractFixtures.journeyState }),
      transition: ok({
        state: contractFixtures.journeyState,
        applied: true,
      }),
    },
    overrides,
  );
}

export function createPageUnderstandingFake(
  overrides: FakeResponseOverrides<PageUnderstanding> = {},
): ContractFake<PageUnderstanding> {
  return createFake<PageUnderstanding>(
    {
      understand: ok({
        kind: "understood",
        snapshot: contractFixtures.pageSnapshot,
      }),
    },
    overrides,
  );
}

export function createAnswerResolverFake(
  overrides: FakeResponseOverrides<AnswerResolver> = {},
): ContractFake<AnswerResolver> {
  return createFake<AnswerResolver>(
    {
      resolve: ok({
        kind: "resolved",
        intent: contractFixtures.intent,
      }),
    },
    overrides,
  );
}

export function createFieldDriverFake(
  overrides: FakeResponseOverrides<FieldDriver> = {},
): ContractFake<FieldDriver> {
  return createFake<FieldDriver>(
    { drive: ok(contractFixtures.mutationReceipt) },
    overrides,
  );
}

export function createFieldVerifierFake(
  overrides: FakeResponseOverrides<FieldVerifier> = {},
): ContractFake<FieldVerifier> {
  return createFake<FieldVerifier>(
    { verify: ok(contractFixtures.verification) },
    overrides,
  );
}

export function createCompletionNavigationFake(
  overrides: FakeResponseOverrides<CompletionNavigation> = {},
): ContractFake<CompletionNavigation> {
  return createFake<CompletionNavigation>(
    {
      complete: ok({
        kind: "complete",
        decision: { kind: "next", expectedPage: "questionnaire" },
      }),
      reconcile: ok({
        kind: "advanced",
        expected: { kind: "workday", page: "questionnaire" },
        observed: { kind: "workday", page: "questionnaire" },
      }),
    },
    overrides,
  );
}

export function createJourneyControlFake(
  overrides: FakeResponseOverrides<JourneyControl> = {},
): ContractFake<JourneyControl> {
  return createFake<JourneyControl>(
    {
      start: ok({
        operationId: "operation-synthetic",
        journeyId: contractFixtures.journeyState.journeyId,
        accepted: true,
      }),
      cancel: ok({
        operationId: "operation-cancel-synthetic",
        journeyId: contractFixtures.journeyState.journeyId,
        accepted: true,
      }),
      status: ok("running"),
      result: ok(contractFixtures.terminalResult),
    },
    overrides,
  );
}

export function createMcpJourneyApiFake(
  overrides: FakeResponseOverrides<McpJourneyApi> = {},
): ContractFake<McpJourneyApi> {
  return createFake<McpJourneyApi>(
    {
      handle: ok({
        schemaVersion: 1,
        requestId: "request-synthetic",
        ok: true,
        result: {
          kind: "terminal",
          terminal: contractFixtures.terminalResult,
        },
      }),
    },
    overrides,
  );
}

export function createEventSinkFake(
  overrides: FakeResponseOverrides<EventSink> = {},
): ContractFake<EventSink> {
  return createFake<EventSink>(
    {
      append: ok({
        appended: true,
        progress: contractFixtures.progress,
      }),
    },
    overrides,
  );
}

export function createProgressReaderFake(
  overrides: FakeResponseOverrides<ProgressReader> = {},
): ContractFake<ProgressReader> {
  return createFake<ProgressReader>(
    { read: ok(contractFixtures.progress) },
    overrides,
  );
}

export function createFailureReporterFake(
  overrides: FakeResponseOverrides<FailureReporter> = {},
): ContractFake<FailureReporter> {
  const context = {
    journeyId: contractFixtures.journeyState.journeyId,
    component: "F9",
    phase: "orchestration",
    step: "start",
    code: "journey_not_found",
    retryable: false,
    source: { kind: "operation", id: "operation-synthetic" },
  } as const;

  return createFake<FailureReporter>(
    {
      report: ok({
        report: { reportId: "report-synthetic", context },
        notification: {
          reportId: "report-synthetic",
          delivered: true,
        },
      }),
    },
    overrides,
  );
}

export function createPrivacyGuardFake(
  overrides: FakeResponseOverrides<PrivacyGuard> = {},
): ContractFake<PrivacyGuard> {
  return createFake<PrivacyGuard>(
    {
      admit: ok({
        kind: "admitted",
        policyRevision: "policy-s1",
      }),
    },
    overrides,
  );
}

export function createSafetyGuardFake(
  overrides: FakeResponseOverrides<SafetyGuard> = {},
): ContractFake<SafetyGuard> {
  return createFake<SafetyGuard>(
    {
      admit: ok({
        kind: "admitted",
        policyRevision: "policy-s1",
      }),
    },
    overrides,
  );
}

export function createEvidenceStoreFake(
  overrides: FakeResponseOverrides<EvidenceStore> = {},
): ContractFake<EvidenceStore> {
  return createFake<EvidenceStore>(
    {
      write: ok({
        recordId: contractFixtures.evidenceRecord.id,
        written: true,
      }),
      read: ok(contractFixtures.evidenceManifest),
    },
    overrides,
  );
}

export function createModelControllerFake(
  overrides: FakeResponseOverrides<ModelController> = {},
): ContractFake<ModelController> {
  return createFake<ModelController>(
    {
      suggest: ok({
        attemptId: "attempt-synthetic",
        suggestion: {
          kind: "option_ranking",
          optionIds: ["option-synthetic"],
        },
      }),
    },
    overrides,
  );
}

export const contractFakeFactories = {
  FixtureRuntime: createFixtureRuntimeFake,
  BrowserSession: createBrowserSessionFake,
  JourneyIntake: createJourneyIntakeFake,
  ProfileQuery: createProfileQueryFake,
  JourneyStateStore: createJourneyStateStoreFake,
  PageUnderstanding: createPageUnderstandingFake,
  AnswerResolver: createAnswerResolverFake,
  FieldDriver: createFieldDriverFake,
  FieldVerifier: createFieldVerifierFake,
  CompletionNavigation: createCompletionNavigationFake,
  JourneyControl: createJourneyControlFake,
  McpJourneyApi: createMcpJourneyApiFake,
  EventSink: createEventSinkFake,
  ProgressReader: createProgressReaderFake,
  FailureReporter: createFailureReporterFake,
  PrivacyGuard: createPrivacyGuardFake,
  SafetyGuard: createSafetyGuardFake,
  EvidenceStore: createEvidenceStoreFake,
  ModelController: createModelControllerFake,
} as const satisfies {
  readonly [N in keyof ContractPortMap]: (
    overrides?: FakeResponseOverrides<ContractPortMap[N]>,
  ) => ContractFake<ContractPortMap[N]>;
};
