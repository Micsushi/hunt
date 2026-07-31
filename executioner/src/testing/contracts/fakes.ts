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
import { contractOperationCases } from "./operation-cases.ts";
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
  const callCounts = new Map<string, number>();
  const responses = { ...defaults, ...overrides };
  const port = Object.fromEntries(
    Object.keys(defaults).map((operation) => [
      operation,
      async (request: unknown, signal: AbortSignal) => {
        const callIndex = callCounts.get(operation) ?? 0;
        callCounts.set(operation, callIndex + 1);
        calls.push({ operation, request });
        if (signal.aborted) {
          return cancelled;
        }
        const response =
          responses[operation as keyof FakeResponses<P>];
        return typeof response === "function"
          ? response(request, signal, callIndex)
          : response;
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
      start: ok(contractOperationCases.FixtureRuntime.start.expected),
      transition: ok(
        contractOperationCases.FixtureRuntime.transition.expected,
      ),
      reset: ok(contractOperationCases.FixtureRuntime.reset.expected),
      setFault: ok(contractOperationCases.FixtureRuntime.setFault.expected),
    },
    overrides,
  );
}

export function createBrowserSessionFake(
  overrides: FakeResponseOverrides<BrowserSession> = {},
): ContractFake<BrowserSession> {
  return createFake<BrowserSession>(
    {
      start: ok(contractOperationCases.BrowserSession.start.expected),
      observe: ok(contractOperationCases.BrowserSession.observe.expected),
      mutate: ok(contractOperationCases.BrowserSession.mutate.expected),
      navigate: ok(contractOperationCases.BrowserSession.navigate.expected),
      close: ok(contractOperationCases.BrowserSession.close.expected),
    },
    overrides,
  );
}

export function createJourneyIntakeFake(
  overrides: FakeResponseOverrides<JourneyIntake> = {},
): ContractFake<JourneyIntake> {
  return createFake<JourneyIntake>(
    {
      bootstrap: ok(contractOperationCases.JourneyIntake.bootstrap.expected),
    },
    overrides,
  );
}

export function createProfileQueryFake(
  overrides: FakeResponseOverrides<ProfileQuery> = {},
): ContractFake<ProfileQuery> {
  return createFake<ProfileQuery>(
    {
      query: ok(contractOperationCases.ProfileQuery.query.expected),
    },
    overrides,
  );
}

export function createJourneyStateStoreFake(
  overrides: FakeResponseOverrides<JourneyStateStore> = {},
): ContractFake<JourneyStateStore> {
  return createFake<JourneyStateStore>(
    {
      load: ok(contractOperationCases.JourneyStateStore.load.expected),
      transition: ok(
        contractOperationCases.JourneyStateStore.transition.expected,
      ),
    },
    overrides,
  );
}

export function createPageUnderstandingFake(
  overrides: FakeResponseOverrides<PageUnderstanding> = {},
): ContractFake<PageUnderstanding> {
  return createFake<PageUnderstanding>(
    {
      understand: ok(
        contractOperationCases.PageUnderstanding.understand.expected,
      ),
    },
    overrides,
  );
}

export function createAnswerResolverFake(
  overrides: FakeResponseOverrides<AnswerResolver> = {},
): ContractFake<AnswerResolver> {
  return createFake<AnswerResolver>(
    {
      resolve: ok(contractOperationCases.AnswerResolver.resolve.expected),
    },
    overrides,
  );
}

export function createFieldDriverFake(
  overrides: FakeResponseOverrides<FieldDriver> = {},
): ContractFake<FieldDriver> {
  return createFake<FieldDriver>(
    { drive: ok(contractOperationCases.FieldDriver.drive.expected) },
    overrides,
  );
}

export function createFieldVerifierFake(
  overrides: FakeResponseOverrides<FieldVerifier> = {},
): ContractFake<FieldVerifier> {
  return createFake<FieldVerifier>(
    { verify: ok(contractOperationCases.FieldVerifier.verify.expected) },
    overrides,
  );
}

export function createCompletionNavigationFake(
  overrides: FakeResponseOverrides<CompletionNavigation> = {},
): ContractFake<CompletionNavigation> {
  return createFake<CompletionNavigation>(
    {
      complete: ok(
        contractOperationCases.CompletionNavigation.complete.expected,
      ),
      reconcile: ok(
        contractOperationCases.CompletionNavigation.reconcile.expected,
      ),
    },
    overrides,
  );
}

export function createJourneyControlFake(
  overrides: FakeResponseOverrides<JourneyControl> = {},
): ContractFake<JourneyControl> {
  return createFake<JourneyControl>(
    {
      start: ok(contractOperationCases.JourneyControl.start.expected),
      cancel: ok(contractOperationCases.JourneyControl.cancel.expected),
      status: ok(contractOperationCases.JourneyControl.status.expected),
      result: ok(contractOperationCases.JourneyControl.result.expected),
    },
    overrides,
  );
}

export function createMcpJourneyApiFake(
  overrides: FakeResponseOverrides<McpJourneyApi> = {},
): ContractFake<McpJourneyApi> {
  return createFake<McpJourneyApi>(
    {
      handle: ok(contractOperationCases.McpJourneyApi.handle.expected),
    },
    overrides,
  );
}

export function createEventSinkFake(
  overrides: FakeResponseOverrides<EventSink> = {},
): ContractFake<EventSink> {
  return createFake<EventSink>(
    {
      append: ok(contractOperationCases.EventSink.append.expected),
    },
    overrides,
  );
}

export function createProgressReaderFake(
  overrides: FakeResponseOverrides<ProgressReader> = {},
): ContractFake<ProgressReader> {
  return createFake<ProgressReader>(
    { read: ok(contractOperationCases.ProgressReader.read.expected) },
    overrides,
  );
}

export function createFailureReporterFake(
  overrides: FakeResponseOverrides<FailureReporter> = {},
): ContractFake<FailureReporter> {
  return createFake<FailureReporter>(
    {
      report: ok(contractOperationCases.FailureReporter.report.expected),
    },
    overrides,
  );
}

export function createPrivacyGuardFake(
  overrides: FakeResponseOverrides<PrivacyGuard> = {},
): ContractFake<PrivacyGuard> {
  return createFake<PrivacyGuard>(
    {
      admit: ok(contractOperationCases.PrivacyGuard.admit.expected),
    },
    overrides,
  );
}

export function createSafetyGuardFake(
  overrides: FakeResponseOverrides<SafetyGuard> = {},
): ContractFake<SafetyGuard> {
  return createFake<SafetyGuard>(
    {
      admit: ok(contractOperationCases.SafetyGuard.admit.expected),
    },
    overrides,
  );
}

export function createEvidenceStoreFake(
  overrides: FakeResponseOverrides<EvidenceStore> = {},
): ContractFake<EvidenceStore> {
  return createFake<EvidenceStore>(
    {
      write: ok(contractOperationCases.EvidenceStore.write.expected),
      read: ok(contractOperationCases.EvidenceStore.read.expected),
    },
    overrides,
  );
}

export function createModelControllerFake(
  overrides: FakeResponseOverrides<ModelController> = {},
): ContractFake<ModelController> {
  return createFake<ModelController>(
    {
      suggest: ok(contractOperationCases.ModelController.suggest.expected),
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
