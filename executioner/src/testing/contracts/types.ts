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
  PageUnderstanding,
  PrivacyGuard,
  ProfileQuery,
  ProgressReader,
  SafetyGuard,
} from "../../contracts/index.ts";

export interface ContractPortMap {
  readonly FixtureRuntime: FixtureRuntime;
  readonly BrowserSession: BrowserSession;
  readonly JourneyIntake: JourneyIntake;
  readonly ProfileQuery: ProfileQuery;
  readonly JourneyStateStore: JourneyStateStore;
  readonly PageUnderstanding: PageUnderstanding;
  readonly AnswerResolver: AnswerResolver;
  readonly FieldDriver: FieldDriver;
  readonly FieldVerifier: FieldVerifier;
  readonly CompletionNavigation: CompletionNavigation;
  readonly JourneyControl: JourneyControl;
  readonly McpJourneyApi: McpJourneyApi;
  readonly EventSink: EventSink;
  readonly ProgressReader: ProgressReader;
  readonly FailureReporter: FailureReporter;
  readonly PrivacyGuard: PrivacyGuard;
  readonly SafetyGuard: SafetyGuard;
  readonly EvidenceStore: EvidenceStore;
}

export type ContractPortName = keyof ContractPortMap;

type AsyncPortMethod = (
  request: never,
  signal: AbortSignal,
) => Promise<unknown>;

export type FakeResponses<P> = {
  readonly [K in keyof P]: P[K] extends AsyncPortMethod
    ? Awaited<ReturnType<P[K]>>
    : never;
};

export type FakeResponseOverrides<P> = Partial<{
  readonly [K in keyof P]: P[K] extends (
    request: infer R,
    signal: AbortSignal,
  ) => Promise<unknown>
    ? | FakeResponses<P>[K]
      | ((
          request: R,
          signal: AbortSignal,
          callIndex: number,
        ) =>
          | FakeResponses<P>[K]
          | Promise<FakeResponses<P>[K]>)
    : never;
}>;

export interface ContractCall {
  readonly operation: string;
  readonly request: unknown;
}

export interface ContractFake<P> {
  readonly port: P;
  readonly calls: readonly ContractCall[];
}
