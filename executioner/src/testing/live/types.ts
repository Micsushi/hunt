import type {
  CredentialMutationAdapter,
  LiveCheckpointStore,
  LiveEvidenceSink,
  MailboxProvider,
  PersistentBrowserSession,
  PrivilegedGmailAuthExecutor,
  PrivilegedVerificationNavigator,
  SecretStore,
  VerificationArtifact,
} from "../../contracts/live/index.ts";

export interface LivePortMap {
  readonly PersistentBrowserSession: PersistentBrowserSession;
  readonly SecretStore: SecretStore;
  readonly CredentialMutationAdapter: CredentialMutationAdapter;
  readonly PrivilegedGmailAuthExecutor: PrivilegedGmailAuthExecutor;
  readonly MailboxProvider: MailboxProvider;
  readonly VerificationArtifact: VerificationArtifact;
  readonly PrivilegedVerificationNavigator: PrivilegedVerificationNavigator;
  readonly LiveCheckpointStore: LiveCheckpointStore;
  readonly LiveEvidenceSink: LiveEvidenceSink;
}

export type LivePortName = keyof LivePortMap;

type AsyncPortMethod = (
  request: never,
  signal: AbortSignal,
) => Promise<unknown>;

export type LiveFakeResponses<P> = {
  readonly [K in keyof P]: P[K] extends AsyncPortMethod
    ? Awaited<ReturnType<P[K]>>
    : never;
};

export type LiveFakeHandlers<P> = {
  readonly [K in keyof P]: P[K] extends (
    request: infer R,
    signal: AbortSignal,
  ) => Promise<unknown>
    ? | LiveFakeResponses<P>[K]
      | ((
          request: R,
          signal: AbortSignal,
          callIndex: number,
        ) =>
          | LiveFakeResponses<P>[K]
          | Promise<LiveFakeResponses<P>[K]>)
    : never;
};

export type LiveFakeResponseOverrides<P> = Partial<LiveFakeHandlers<P>>;

export interface LiveCall {
  readonly operation: string;
  readonly request: unknown;
}

export interface LiveFake<P> {
  readonly port: P;
  readonly calls: readonly LiveCall[];
}

export interface LiveScenarioReport<N extends string = string> {
  readonly name: N;
  readonly ports: readonly LivePortName[];
  readonly edges: readonly string[];
}
