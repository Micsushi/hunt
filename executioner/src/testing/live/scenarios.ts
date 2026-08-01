import { generatedOperationId } from "../../contracts/index.ts";
import { s2StableErrorPolicy } from "../../contracts/s2-common-wire.ts";
import type {
  CredentialMutationRequest,
  LiveCheckpointV1,
  PersistentBrowserOpenRequest,
  S2PortError,
  VerificationNavigationRequest,
} from "../../contracts/live/index.ts";
import {
  createCredentialMutationAdapterFake,
  createLiveCheckpointStoreFake,
  createLiveEvidenceSinkFake,
  createMailboxProviderFake,
  createPersistentBrowserSessionFake,
  createPrivilegedGmailAuthExecutorFake,
  createPrivilegedVerificationNavigatorFake,
  createSecretStoreFake,
  createVerificationArtifactFake,
} from "./fakes.ts";
import { liveFixtures } from "./fixtures.ts";
import type { LiveCall, LiveScenarioReport } from "./types.ts";

export interface LiveScenarioExecution<N extends string = string> {
  readonly report: LiveScenarioReport<N>;
  readonly calls: readonly LiveCall[];
}

const signal = () => new AbortController().signal;
const failure = <const C extends keyof typeof s2StableErrorPolicy>(code: C) =>
  ({
    ok: false as const,
    error: { code, retryable: s2StableErrorPolicy[code].retryable },
  }) as { readonly ok: false; readonly error: S2PortError<C> };

export async function runPersistentBrowserLifecycle(): Promise<
  LiveScenarioExecution<"persistent-browser-lifecycle">
> {
  const seen = new Map<string, PersistentBrowserOpenRequest>();
  const fake = createPersistentBrowserSessionFake({
    open: (request) => {
      const previous = seen.get(request.operationId);
      if (previous !== undefined) {
        return JSON.stringify(previous) === JSON.stringify(request)
          ? { ok: true, value: { kind: "opened", session: liveFixtures.session } }
          : failure("browser_operation_replayed");
      }
      seen.set(request.operationId, request);
      return {
        ok: true,
        value: {
          kind: seen.size === 1 ? "opened" : "reattached",
          session: liveFixtures.session,
        },
      };
    },
    reconcile: (request) =>
      request.expectedTarget.postingId === request.session.target.postingId
        ? { ok: true, value: { kind: "matched", session: request.session } }
        : {
            ok: true,
            value: { kind: "target_mismatch", dimension: "posting" },
          },
  });
  const openRequest = liveOperationRequest("browserOpen");
  const first = await fake.port.open(openRequest, signal());
  const replay = await fake.port.open(openRequest, signal());
  const reattach = await fake.port.open(
    {
      ...openRequest,
      operationId: generatedOperationId("operation_1000000000000001"),
    },
    signal(),
  );
  const mismatch = await fake.port.reconcile(
    {
      schemaVersion: 1,
      journeyId: liveFixtures.journeyId,
      operationId: generatedOperationId("operation_1000000000000002"),
      session: liveFixtures.session,
      expectedTarget: liveFixtures.otherTarget,
    },
    signal(),
  );
  if (
    !first.ok ||
    !replay.ok ||
    !reattach.ok ||
    reattach.value.kind !== "reattached" ||
    !mismatch.ok ||
    mismatch.value.kind !== "target_mismatch"
  ) {
    throw new TypeError("persistent browser lifecycle failed");
  }
  return execution(
    "persistent-browser-lifecycle",
    "PersistentBrowserSession",
    ["operation-replayed", "profile-reattached", "target-mismatch-factual"],
    fake.calls,
  );
}

export async function runSecretHandleScope(): Promise<
  LiveScenarioExecution<"secret-handle-scope">
> {
  const fake = createSecretStoreFake();
  const accepted = await fake.port.inspect(liveFixtures.secretInspectRequest, signal());
  const wrongJourney = await fake.port.inspect(
    { ...liveFixtures.secretInspectRequest, journeyId: liveFixtures.otherJourneyId },
    signal(),
  );
  await fake.port.revoke(
    {
      schemaVersion: 1,
      journeyId: liveFixtures.journeyId,
      operationId: liveFixtures.operationIds.secretRevoke,
      handleId: liveFixtures.accountSecret.handleId,
    },
    signal(),
  );
  const revoked = await fake.port.inspect(liveFixtures.secretInspectRequest, signal());
  if (
    !accepted.ok ||
    wrongJourney.ok ||
    wrongJourney.error.code !== "secret_handle_mismatched" ||
    revoked.ok ||
    revoked.error.code !== "secret_handle_invalid"
  ) {
    throw new TypeError("secret scope lifecycle failed");
  }
  return execution(
    "secret-handle-scope",
    "SecretStore",
    ["journey-mismatch-rejected", "revoked-handle-rejected"],
    fake.calls,
  );
}

export async function runCredentialMutationIdempotency(): Promise<
  LiveScenarioExecution<"credential-mutation-idempotency">
> {
  const applied = new Map<string, string>();
  const fake = createCredentialMutationAdapterFake({
    mutate: (request) => {
      const fingerprint = JSON.stringify(request);
      const previous = applied.get(request.operationId);
      if (previous !== undefined && previous !== fingerprint) {
        return failure("credential_effect_uncertain");
      }
      applied.set(request.operationId, fingerprint);
      return {
        ok: true,
        value: {
          kind: "verification_required",
          attemptedFields: request.fields,
        },
      };
    },
  });
  const request = credentialRequest();
  const first = await fake.port.mutate(request, signal());
  const replay = await fake.port.mutate(request, signal());
  const conflict = await fake.port.mutate(
    { ...request, mode: "sign_in" },
    signal(),
  );
  if (!first.ok || !replay.ok || conflict.ok || conflict.error.code !== "credential_effect_uncertain") {
    throw new TypeError("credential idempotency failed");
  }
  return execution(
    "credential-mutation-idempotency",
    "CredentialMutationAdapter",
    ["mutation-applied-once", "duplicate-replayed", "changed-replay-uncertain"],
    fake.calls,
  );
}

export async function runGmailAuthCancellation(): Promise<
  LiveScenarioExecution<"gmail-auth-cancellation">
> {
  const fake = createPrivilegedGmailAuthExecutorFake();
  const request = {
    ...liveFixtures.mailboxPollRequest,
    now: liveFixtures.issuedAt,
    authorization: liveFixtures.gmailSecret,
  };
  const accepted = await fake.port.query(request, signal());
  const cancelled = await fake.port.query(request, AbortSignal.abort());
  const wrongJourney = await fake.port.query(
    { ...request, journeyId: liveFixtures.otherJourneyId },
    signal(),
  );
  if (
    !accepted.ok ||
    cancelled.ok ||
    cancelled.error.code !== "operation_cancelled" ||
    wrongJourney.ok ||
    wrongJourney.error.code !== "secret_handle_mismatched"
  ) {
    throw new TypeError("Gmail auth cancellation failed");
  }
  return execution(
    "gmail-auth-cancellation",
    "PrivilegedGmailAuthExecutor",
    ["safe-result", "pre-effect-cancelled", "journey-mismatch-rejected"],
    fake.calls,
  );
}

export async function runMailboxFactualPreservation(): Promise<
  LiveScenarioExecution<"mailbox-factual-preservation">
> {
  const values = liveFixtures.mailboxFactualResults;
  const fake = createMailboxProviderFake({
    responses: {
      poll: (_request, _signal, callIndex) => ({
        ok: true,
        value: values[callIndex] ?? values.at(-1)!,
      }),
    },
  });
  for (const expected of values) {
    const result = await fake.port.poll(liveFixtures.mailboxPollRequest, signal());
    if (!result.ok || JSON.stringify(result.value) !== JSON.stringify(expected)) {
      throw new TypeError("mailbox factual result was remapped");
    }
  }
  return execution(
    "mailbox-factual-preservation",
    "MailboxProvider",
    ["none-preserved", "ambiguous-preserved", "available-preserved"],
    fake.calls,
  );
}

export async function runVerificationArtifactSingleUse(): Promise<
  LiveScenarioExecution<"verification-artifact-single-use">
> {
  const calls: LiveCall[] = [];
  for (const state of liveFixtures.artifactFactualStates) {
    const fake = createVerificationArtifactFake({
      metadata: { ...liveFixtures.verificationArtifact, state },
    });
    const inspected = await fake.port.inspect(artifactInspectRequest(), signal());
    if (!inspected.ok || inspected.value.state !== state) {
      throw new TypeError("artifact factual state was remapped");
    }
    calls.push(...fake.calls);
  }
  const fake = createVerificationArtifactFake();
  const invalidateRequest = {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    operationId: liveFixtures.operationIds.artifactInvalidate,
    handleId: liveFixtures.verificationArtifact.handleId,
  };
  const first = await fake.port.invalidate(invalidateRequest, signal());
  const replay = await fake.port.invalidate(invalidateRequest, signal());
  if (!first.ok || replay.ok || replay.error.code !== "verification_artifact_replayed") {
    throw new TypeError("artifact single-use failed");
  }
  calls.push(...fake.calls);
  return execution(
    "verification-artifact-single-use",
    "VerificationArtifact",
    ["all-factual-states-preserved", "invalidation-single-use"],
    calls,
  );
}

export async function runVerificationNavigationIdempotency(): Promise<
  LiveScenarioExecution<"verification-navigation-idempotency">
> {
  const applied = new Map<string, string>();
  let consumed = false;
  const fake = createPrivilegedVerificationNavigatorFake({
    navigate: (request) => {
      const fingerprint = JSON.stringify(request);
      const previous = applied.get(request.operationId);
      if (previous === fingerprint) return { ok: true, value: { kind: "navigated" } };
      if (previous !== undefined || consumed) return failure("verification_artifact_replayed");
      applied.set(request.operationId, fingerprint);
      consumed = true;
      return { ok: true, value: { kind: "navigated" } };
    },
  });
  const request = navigationRequest();
  const first = await fake.port.navigate(request, signal());
  const replay = await fake.port.navigate(request, signal());
  const second = await fake.port.navigate(
    {
      ...request,
      operationId: generatedOperationId("operation_7000000000000001"),
    },
    signal(),
  );
  if (!first.ok || !replay.ok || second.ok || second.error.code !== "verification_artifact_replayed") {
    throw new TypeError("verification navigation idempotency failed");
  }
  return execution(
    "verification-navigation-idempotency",
    "PrivilegedVerificationNavigator",
    ["navigation-applied-once", "operation-replayed", "artifact-reuse-rejected"],
    fake.calls,
  );
}

export async function runCheckpointRestart(): Promise<
  LiveScenarioExecution<"checkpoint-restart">
> {
  let persisted: LiveCheckpointV1 | null = null;
  const writer = createLiveCheckpointStoreFake({
    save: (request) => {
      persisted = request.checkpoint;
      return { ok: true, value: request.checkpoint };
    },
  });
  const saved = await writer.port.save(checkpointSaveRequest(), signal());
  const reader = createLiveCheckpointStoreFake({
    load: (request) =>
      persisted?.journeyId === request.journeyId &&
      persisted.revisionId === request.expectedRevisionId
        ? { ok: true, value: persisted }
        : failure("recovery_state_ambiguous"),
  });
  const loaded = await reader.port.load(
    {
      schemaVersion: 1,
      journeyId: liveFixtures.journeyId,
      expectedRevisionId: liveFixtures.checkpoint.revisionId,
    },
    signal(),
  );
  if (!saved.ok || !loaded.ok || JSON.stringify(saved.value) !== JSON.stringify(loaded.value)) {
    throw new TypeError("checkpoint restart failed");
  }
  return execution(
    "checkpoint-restart",
    "LiveCheckpointStore",
    ["safe-checkpoint-persisted", "restart-loaded-exact-state"],
    [...writer.calls, ...reader.calls],
  );
}

export async function runEvidenceCleanupIdempotency(): Promise<
  LiveScenarioExecution<"evidence-cleanup-idempotency">
> {
  const fake = createLiveEvidenceSinkFake();
  const sealRequest = evidenceSealRequest();
  const first = await fake.port.seal(sealRequest, signal());
  const replay = await fake.port.seal(sealRequest, signal());
  const cleanupRequest = {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    operationId: liveFixtures.operationIds.evidenceCleanup,
  };
  const cleanup = await fake.port.cleanupPartials(cleanupRequest, signal());
  const cleanupReplay = await fake.port.cleanupPartials(cleanupRequest, signal());
  if (!first.ok || !replay.ok || !cleanup.ok || !cleanupReplay.ok) {
    throw new TypeError("evidence cleanup idempotency failed");
  }
  return execution(
    "evidence-cleanup-idempotency",
    "LiveEvidenceSink",
    ["seal-replayed", "cleanup-idempotent", "no-record-values-exposed"],
    fake.calls,
  );
}

function execution<const N extends string, const P extends LiveScenarioReport["ports"][number]>(
  name: N,
  port: P,
  edges: readonly string[],
  calls: readonly LiveCall[],
): LiveScenarioExecution<N> {
  return { report: { name, ports: [port], edges }, calls };
}

function liveOperationRequest(_kind: "browserOpen"): PersistentBrowserOpenRequest {
  return {
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: liveFixtures.operationIds.browserOpen,
    profileLeaseId: liveFixtures.session.profileLeaseId,
    target: liveFixtures.target,
  };
}

function credentialRequest(): CredentialMutationRequest {
  return {
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: liveFixtures.operationIds.credentialMutation,
    sessionId: liveFixtures.session.sessionId,
    target: liveFixtures.target,
    now: liveFixtures.issuedAt,
    mode: "create_account",
    credential: liveFixtures.accountSecret,
    fields: ["email", "password"],
  };
}

function artifactInspectRequest() {
  return {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    handleId: liveFixtures.verificationArtifact.handleId,
    expectedRecipientBindingId: liveFixtures.verificationArtifact.recipientBindingId,
    expectedTarget: liveFixtures.target,
  };
}

function navigationRequest(): VerificationNavigationRequest {
  return {
    schemaVersion: 1,
    journeyId: liveFixtures.journeyId,
    operationId: liveFixtures.operationIds.verificationNavigation,
    sessionId: liveFixtures.session.sessionId,
    expectedRecipientBindingId:
      liveFixtures.verificationArtifact.recipientBindingId,
    expectedTarget: liveFixtures.target,
    now: liveFixtures.issuedAt,
    artifact: liveFixtures.verificationArtifact,
  };
}

function checkpointSaveRequest() {
  return {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    operationId: liveFixtures.operationIds.checkpointSave,
    checkpoint: liveFixtures.checkpoint,
  };
}

function evidenceSealRequest() {
  return {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    operationId: liveFixtures.operationIds.evidenceSeal,
    manifestId: liveFixtures.evidenceSeal.manifestId,
    admittedRecordIds: ["admitted_record_0123456789abcdef" as never],
  };
}
