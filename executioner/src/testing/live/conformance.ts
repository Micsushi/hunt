import { isDeepStrictEqual } from "node:util";

import { livePortNames } from "../../contracts/live/index.ts";
import { liveFixtures } from "./fixtures.ts";
import type { LivePortMap, LivePortName } from "./types.ts";

const operations = liveFixtures.operationIds;

export const liveOperationCases = {
  PersistentBrowserSession: {
    open: {
      request: {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: operations.browserOpen,
        profileLeaseId: liveFixtures.session.profileLeaseId,
        target: liveFixtures.target,
      },
      expected: { kind: "opened", session: liveFixtures.session },
    },
    reconcile: {
      request: {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: operations.browserReconcile,
        session: liveFixtures.session,
        expectedTarget: liveFixtures.target,
      },
      expected: { kind: "matched", session: liveFixtures.session },
    },
    close: {
      request: {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: operations.browserClose,
        sessionId: liveFixtures.session.sessionId,
      },
      expected: undefined,
    },
  },
  SecretStore: {
    inspect: {
      request: liveFixtures.secretInspectRequest,
      expected: liveFixtures.accountSecret,
    },
    revoke: {
      request: {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: operations.secretRevoke,
        handleId: liveFixtures.accountSecret.handleId,
      },
      expected: undefined,
    },
  },
  CredentialMutationAdapter: {
    mutate: {
      request: {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: operations.credentialMutation,
        sessionId: liveFixtures.session.sessionId,
        mode: "create_account",
        credential: liveFixtures.accountSecret,
        fields: ["email", "password"],
      },
      expected: {
        kind: "verification_required",
        attemptedFields: ["email", "password"],
      },
    },
  },
  PrivilegedGmailAuthExecutor: {
    query: {
      request: {
        ...liveFixtures.mailboxPollRequest,
        authorization: liveFixtures.gmailSecret,
      },
      expected: liveFixtures.mailboxAvailable,
    },
  },
  MailboxProvider: {
    poll: {
      request: liveFixtures.mailboxPollRequest,
      expected: liveFixtures.mailboxAvailable,
    },
  },
  VerificationArtifact: {
    inspect: {
      request: {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        handleId: liveFixtures.verificationArtifact.handleId,
        expectedRecipientBindingId:
          liveFixtures.verificationArtifact.recipientBindingId,
        expectedTarget: liveFixtures.target,
      },
      expected: liveFixtures.verificationArtifact,
    },
    invalidate: {
      request: {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: operations.artifactInvalidate,
        handleId: liveFixtures.verificationArtifact.handleId,
      },
      expected: undefined,
    },
  },
  PrivilegedVerificationNavigator: {
    navigate: {
      request: {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: operations.verificationNavigation,
        sessionId: liveFixtures.session.sessionId,
        artifact: liveFixtures.verificationArtifact,
      },
      expected: { kind: "navigated" },
    },
  },
  LiveCheckpointStore: {
    load: {
      request: {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        expectedRevisionId: liveFixtures.checkpoint.revisionId,
      },
      expected: liveFixtures.checkpoint,
    },
    save: {
      request: {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: operations.checkpointSave,
        checkpoint: liveFixtures.checkpoint,
      },
      expected: liveFixtures.checkpoint,
    },
    remove: {
      request: {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: operations.checkpointRemove,
        checkpointId: liveFixtures.checkpoint.checkpointId,
      },
      expected: undefined,
    },
  },
  LiveEvidenceSink: {
    seal: {
      request: {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: operations.evidenceSeal,
        manifestId: liveFixtures.evidenceSeal.manifestId,
        admittedRecordIds: ["admitted_record_0123456789abcdef"],
      },
      expected: liveFixtures.evidenceSeal,
    },
    cleanupPartials: {
      request: {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: operations.evidenceCleanup,
      },
      expected: undefined,
    },
  },
} as const;

export const livePortOperations = Object.fromEntries(
  livePortNames.map((name) => [name, Object.keys(liveOperationCases[name])]),
) as unknown as {
  readonly [N in LivePortName]: readonly (keyof LivePortMap[N] & string)[];
};

export const liveConformanceRegistry = livePortNames.map((name) => ({
  name,
  operations: livePortOperations[name],
  skip: false as const,
}));

export async function assertLiveProviderConformance<N extends LivePortName>(
  name: N,
  provider: LivePortMap[N],
): Promise<void> {
  const dynamicProvider = provider as unknown as Record<
    string,
    (request: unknown, signal: AbortSignal) => Promise<unknown>
  >;
  const cases = liveOperationCases[name] as Record<
    string,
    { readonly request: unknown; readonly expected: unknown }
  >;

  for (const [operation, operationCase] of Object.entries(cases)) {
    const invoke = dynamicProvider[operation];
    const coordinate = `${name}.${operation}`;
    if (typeof invoke !== "function") {
      throw new TypeError(`${coordinate} must be a function`);
    }
    const result = await invoke.call(
      provider,
      operationCase.request,
      new AbortController().signal,
    );
    assertSuccess(coordinate, result, operationCase.expected);
    const cancelledResult = await invoke.call(
      provider,
      operationCase.request,
      AbortSignal.abort(),
    );
    assertCancellation(coordinate, cancelledResult);
  }
}

function assertSuccess(
  coordinate: string,
  result: unknown,
  expected: unknown,
): void {
  if (
    typeof result !== "object" ||
    result === null ||
    Object.keys(result).length !== 2 ||
    (result as { readonly ok?: unknown }).ok !== true ||
    !Object.hasOwn(result, "value") ||
    !isDeepStrictEqual(
      (result as { readonly value: unknown }).value,
      expected,
    )
  ) {
    throw new TypeError(`${coordinate} must return the exact success fixture`);
  }
}

function assertCancellation(coordinate: string, result: unknown): void {
  if (
    typeof result !== "object" ||
    result === null ||
    Object.keys(result).length !== 2 ||
    (result as { readonly ok?: unknown }).ok !== false ||
    !Object.hasOwn(result, "error")
  ) {
    throw new TypeError(`${coordinate} must return cancellation`);
  }
  const error = (result as { readonly error: unknown }).error;
  if (
    typeof error !== "object" ||
    error === null ||
    Object.keys(error).length !== 2 ||
    (error as { readonly code?: unknown }).code !== "operation_cancelled" ||
    (error as { readonly retryable?: unknown }).retryable !== false
  ) {
    throw new TypeError(`${coordinate} must return non-retryable cancellation`);
  }
}
