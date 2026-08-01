import {
  s2StableErrorPolicy,
  type S2StableErrorCode,
} from "../../contracts/s2-common-wire.ts";
import type {
  CredentialMutationAdapter,
  LiveCheckpointStore,
  LiveEvidenceSink,
  MailboxPollResultV1,
  MailboxProvider,
  PersistentBrowserSession,
  PrivilegedGmailAuthExecutor,
  PrivilegedVerificationNavigator,
  S2PortError,
  SecretHandleMetadataV1,
  SecretStore,
  VerificationArtifact,
  VerificationArtifactMetadataV1,
} from "../../contracts/live/index.ts";
import { liveFixtures } from "./fixtures.ts";
import type {
  LiveCall,
  LiveFake,
  LiveFakeHandlers,
  LiveFakeResponseOverrides,
  LiveFakeResponses,
  LivePortMap,
} from "./types.ts";

const cancelled = {
  ok: false,
  error: { code: "operation_cancelled", retryable: false },
} as const;

const ok = <T>(value: T) => ({ ok: true, value }) as const;

function error<const C extends S2StableErrorCode>(code: C) {
  return {
    ok: false,
    error: {
      code,
      retryable: s2StableErrorPolicy[code].retryable,
    } as S2PortError<C>,
  } as const;
}

function createFake<P extends object>(
  defaults: LiveFakeHandlers<P>,
  overrides: LiveFakeResponseOverrides<P> = {},
): LiveFake<P> {
  const calls: LiveCall[] = [];
  const callCounts = new Map<string, number>();
  const responses = { ...defaults, ...overrides };
  const port = Object.fromEntries(
    Object.keys(defaults).map((operation) => [
      operation,
      async (request: unknown, signal: AbortSignal) => {
        const callIndex = callCounts.get(operation) ?? 0;
        callCounts.set(operation, callIndex + 1);
        calls.push({ operation, request });
        if (signal.aborted) return cancelled;
        const response = responses[operation as keyof LiveFakeHandlers<P>];
        return typeof response === "function"
          ? response(request as never, signal, callIndex)
          : response;
      },
    ]),
  ) as P;
  return { port, calls };
}

export function createPersistentBrowserSessionFake(
  overrides: LiveFakeResponseOverrides<PersistentBrowserSession> = {},
): LiveFake<PersistentBrowserSession> {
  return createFake<PersistentBrowserSession>(
    {
      open: ok({ kind: "opened", session: liveFixtures.session }),
      reconcile: (request) => {
        for (const dimension of ["host", "tenant", "posting"] as const) {
          if (
            request.expectedTarget[`${dimension}Id`] !==
            request.session.target[`${dimension}Id`]
          ) {
            return ok({ kind: "target_mismatch", dimension });
          }
        }
        return ok({ kind: "matched", session: request.session });
      },
      close: ok(undefined),
    },
    overrides,
  );
}

export interface SecretStoreFakeOptions {
  readonly metadata?: SecretHandleMetadataV1;
  readonly responses?: LiveFakeResponseOverrides<SecretStore>;
}

export function createSecretStoreFake(
  options: SecretStoreFakeOptions = {},
): LiveFake<SecretStore> {
  let metadata = options.metadata ?? liveFixtures.accountSecret;
  return createFake<SecretStore>(
    {
      inspect: (request) => {
        if (metadata.provider !== "windows_dpapi_current_user_v1") {
          return error("secret_handle_mismatched");
        }
        if (metadata.handleId !== request.handleId) {
          return error("secret_handle_invalid");
        }
        if (metadata.journeyId !== request.journeyId) {
          return error("secret_handle_mismatched");
        }
        if (metadata.state === "expired" || metadata.expiresAt <= liveFixtures.issuedAt) {
          return error("secret_handle_expired");
        }
        if (metadata.state !== "active") {
          return error("secret_handle_invalid");
        }
        if (metadata.purpose !== request.expectedPurpose) {
          return error("secret_handle_mismatched");
        }
        if (metadata.consumer !== request.expectedConsumer) {
          return error("secret_consumer_forbidden");
        }
        return ok(metadata);
      },
      revoke: (request) => {
        if (
          request.journeyId !== metadata.journeyId ||
          request.handleId !== metadata.handleId
        ) {
          return error("secret_handle_mismatched");
        }
        metadata = { ...metadata, state: "revoked" };
        return ok(undefined);
      },
    },
    options.responses,
  );
}

export function createCredentialMutationAdapterFake(
  overrides: LiveFakeResponseOverrides<CredentialMutationAdapter> = {},
): LiveFake<CredentialMutationAdapter> {
  return createFake<CredentialMutationAdapter>(
    {
      mutate: (request) => {
        if (
          request.credential.journeyId !== request.journeyId ||
          request.credential.provider !== "windows_dpapi_current_user_v1" ||
          request.credential.purpose !== "account_credentials"
        ) {
          return error("secret_handle_mismatched");
        }
        if (request.credential.consumer !== "credential_mutation_adapter") {
          return error("secret_consumer_forbidden");
        }
        return ok({
          kind: "verification_required",
          attemptedFields: request.fields,
        });
      },
    },
    overrides,
  );
}

export function createPrivilegedGmailAuthExecutorFake(
  overrides: LiveFakeResponseOverrides<PrivilegedGmailAuthExecutor> = {},
): LiveFake<PrivilegedGmailAuthExecutor> {
  return createFake<PrivilegedGmailAuthExecutor>(
    {
      query: (request) => {
        if (
          request.authorization.journeyId !== request.journeyId ||
          request.authorization.provider !== "windows_dpapi_current_user_v1" ||
          request.authorization.purpose !== "gmail_oauth"
        ) {
          return error("secret_handle_mismatched");
        }
        if (request.authorization.consumer !== "gmail_auth_executor") {
          return error("secret_consumer_forbidden");
        }
        return ok(liveFixtures.mailboxAvailable);
      },
    },
    overrides,
  );
}

export interface MailboxProviderFakeOptions {
  readonly result?: MailboxPollResultV1;
  readonly responses?: LiveFakeResponseOverrides<MailboxProvider>;
}

export function createMailboxProviderFake(
  options: MailboxProviderFakeOptions = {},
): LiveFake<MailboxProvider> {
  return createFake<MailboxProvider>(
    {
      poll: (request) =>
        Date.parse(request.notBefore) < Date.parse(request.notAfter)
          ? ok(options.result ?? liveFixtures.mailboxAvailable)
          : error("mailbox_query_invalid"),
    },
    options.responses,
  );
}

export interface VerificationArtifactFakeOptions {
  readonly metadata?: VerificationArtifactMetadataV1;
  readonly responses?: LiveFakeResponseOverrides<VerificationArtifact>;
}

export function createVerificationArtifactFake(
  options: VerificationArtifactFakeOptions = {},
): LiveFake<VerificationArtifact> {
  let metadata = options.metadata ?? liveFixtures.verificationArtifact;
  return createFake<VerificationArtifact>(
    {
      inspect: (request) => {
        if (
          request.handleId !== metadata.handleId ||
          request.journeyId !== metadata.journeyId ||
          request.expectedRecipientBindingId !== metadata.recipientBindingId
        ) {
          return error("verification_artifact_replayed");
        }
        if (
          request.expectedTarget.hostId !== metadata.target.hostId ||
          request.expectedTarget.tenantId !== metadata.target.tenantId ||
          request.expectedTarget.postingId !== metadata.target.postingId
        ) {
          return error("mailbox_query_invalid");
        }
        return ok(metadata);
      },
      invalidate: (request) => {
        if (
          request.handleId !== metadata.handleId ||
          request.journeyId !== metadata.journeyId ||
          metadata.state !== "available"
        ) {
          return error("verification_artifact_replayed");
        }
        metadata = { ...metadata, state: "invalidated" };
        return ok(undefined);
      },
    },
    options.responses,
  );
}

export function createPrivilegedVerificationNavigatorFake(
  overrides: LiveFakeResponseOverrides<PrivilegedVerificationNavigator> = {},
): LiveFake<PrivilegedVerificationNavigator> {
  return createFake<PrivilegedVerificationNavigator>(
    {
      navigate: (request) =>
        request.artifact.state === "available" &&
        request.artifact.journeyId === request.journeyId
          ? ok({ kind: "navigated" })
          : error("verification_artifact_replayed"),
    },
    overrides,
  );
}

export function createLiveCheckpointStoreFake(
  overrides: LiveFakeResponseOverrides<LiveCheckpointStore> = {},
): LiveFake<LiveCheckpointStore> {
  let checkpoint = liveFixtures.checkpoint;
  return createFake<LiveCheckpointStore>(
    {
      load: (request) => {
        if (request.journeyId !== checkpoint.journeyId) {
          return error("recovery_checkpoint_invalid");
        }
        if (request.expectedRevisionId !== checkpoint.revisionId) {
          return error("recovery_state_ambiguous");
        }
        return ok(checkpoint);
      },
      save: (request) => {
        if (request.journeyId !== request.checkpoint.journeyId) {
          return error("recovery_checkpoint_invalid");
        }
        checkpoint = request.checkpoint;
        return ok(checkpoint);
      },
      remove: (request) => {
        if (
          request.journeyId !== checkpoint.journeyId ||
          request.checkpointId !== checkpoint.checkpointId
        ) {
          return error("recovery_checkpoint_invalid");
        }
        return ok(undefined);
      },
    },
    overrides,
  );
}

export function createLiveEvidenceSinkFake(
  overrides: LiveFakeResponseOverrides<LiveEvidenceSink> = {},
): LiveFake<LiveEvidenceSink> {
  return createFake<LiveEvidenceSink>(
    {
      seal: (request) =>
        request.journeyId === liveFixtures.journeyId
          ? ok({
              ...liveFixtures.evidenceSeal,
              manifestId: request.manifestId,
              recordCount: request.admittedRecordIds.length,
            })
          : error("evidence_denied"),
      cleanupPartials: (request) =>
        request.journeyId === liveFixtures.journeyId
          ? ok(undefined)
          : error("evidence_denied"),
    },
    overrides,
  );
}

export const liveFakeFactories = {
  PersistentBrowserSession: createPersistentBrowserSessionFake,
  SecretStore: createSecretStoreFake,
  CredentialMutationAdapter: createCredentialMutationAdapterFake,
  PrivilegedGmailAuthExecutor: createPrivilegedGmailAuthExecutorFake,
  MailboxProvider: createMailboxProviderFake,
  VerificationArtifact: createVerificationArtifactFake,
  PrivilegedVerificationNavigator: createPrivilegedVerificationNavigatorFake,
  LiveCheckpointStore: createLiveCheckpointStoreFake,
  LiveEvidenceSink: createLiveEvidenceSinkFake,
} as const satisfies {
  readonly [N in keyof LivePortMap]: () => LiveFake<LivePortMap[N]>;
};
