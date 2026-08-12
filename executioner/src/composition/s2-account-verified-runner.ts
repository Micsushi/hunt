import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAccountEntryCredentialMutationAdapter,
} from "../account/entry/index.ts";
import {
  AccountVerificationLifecycle,
  type AccountLifecycleDependencies,
  type AccountLifecycleAccountStateObserver,
  type AccountLifecycleObservationRequest,
  type AccountLifecycleInput,
  type AccountLifecycleResult,
} from "../account/lifecycle/index.ts";
import {
  createClassifiedAccountObservationSource,
  createLiveEntryVerifier,
  type ClassifiedAccountObservationSource,
} from "../ats/workday/live/index.ts";
import { createPlaywrightPersistentBrowserSession } from "../browser/playwright-live/index.ts";
import type { PlaywrightPersistentBrowserSession } from "../browser/playwright-live/session.ts";
import type {
  OperationId,
  ProfileLeaseId,
  RecipientBindingId,
  SecretHandleId,
  TargetHostId,
  TargetPostingId,
  TargetTenantId,
  VerificationHandleId,
} from "../contracts/index.ts";
import { stage2StorageRootForOwnerBinding } from "./private/s2-owner-storage-binding.ts";
import { createVerificationEmailRequestAdapter } from "./private/s2-verification-email-request.ts";
import { Stage2VerificationReplayLedger } from "./private/s2-verification-replay-ledger.ts";
import type {
  ActiveAccountSecretHandle,
  ActiveGmailSecretHandle,
  LiveBrowserSessionV1,
  LiveIdentifier,
  LiveSessionId,
  LivePortResult,
  PersistentBrowserCloseRequest,
  PersistentBrowserErrorCode,
  PersistentBrowserOpenRequest,
  PersistentBrowserOpenResult,
  PersistentBrowserReconcileRequest,
  PersistentBrowserReconcileResult,
  SecretInspectRequest,
  SecretHandleMetadataV1,
  SecretStore,
  TargetIdentityV1,
  VerificationNavigationResult,
} from "../contracts/live/index.ts";
import { s2StableErrorPolicy } from "../contracts/s2-common-wire.ts";
import {
  createBoundedVerificationMailboxPolling,
} from "../account/lifecycle/mailbox-polling.ts";
import { writeAccountVerifiedEvidence } from "../live/evidence/account-verified-evidence.ts";
import {
  createOperatorMonitorInspectionHold,
} from "../live/evidence/operator-monitor-ack.ts";
import { createPrivateRealRunAdmission } from "../live/preflight/private/runtime-binding.ts";
import type { RealRunOwnerInputsV1 } from "../live/preflight/types.ts";
import {
  runStage2AccountVerified,
  type AccountVerifiedFact,
  type AccountVerifiedAcceptance,
  type AccountVerifiedEvidenceWriter,
  type AccountVerifiedLifecycleResult,
  type AccountVerifiedLifecycleRunner,
  type Stage2AccountVerifiedInput,
  type Stage2AccountVerifiedResult,
} from "../live/runner/account-verified.ts";
import { createBoundedMailboxPolicy, type SenderPolicyId } from "../mailbox/policy.ts";
import {
  GmailApiAuthExecutor,
  type GmailApprovedPolicyCapability,
} from "../mailbox/providers/gmail/auth-executor.ts";
import { GmailHttpClient } from "../mailbox/providers/gmail/http-client.ts";
import { GmailAtomicArtifactConsumer } from "../mailbox/providers/gmail/private/atomic-artifact-consumer.ts";
import {
  createGmailPrivilegedVerificationNavigator,
  type ByteScopedVerificationBrowserCapability,
  type GmailVerificationPolicyCapability,
} from "../mailbox/providers/gmail/private/privileged-verification-navigator.ts";
import { GmailRawArtifactVault } from "../mailbox/providers/gmail/private/raw-artifact-vault.ts";
import { GmailMailboxProvider } from "../mailbox/providers/gmail/provider.ts";
import { GmailSafeArtifactRegistry } from "../mailbox/providers/gmail/safe-artifact-registry.ts";
import { WindowsDpapiSecretResolver } from "../secrets/windows-dpapi/private/resolver.ts";
import { WindowsDpapiSecretStore } from "../secrets/windows-dpapi/store.ts";
import { deriveSenderPolicyId } from "./private/s2-gmail-bootstrap-binding.ts";
import { inspectCleanSourceRevision } from "./private/s2-clean-source-revision.ts";
import { createPlaywrightLiveEntryStructuralSource } from "./s2-live-entry-source.ts";

export interface Stage2AccountVerifiedProductionOptions {
  readonly configPath: string;
  readonly evidenceRoot: string;
}

export interface AccountVerifiedOperationIds {
  readonly browserOpen: OperationId;
  readonly browserReconcile: OperationId;
  readonly accountAdvance: OperationId;
  readonly lifecycle: OperationId;
  readonly initialCredentialMutation: OperationId;
  readonly createCredentialMutation: OperationId;
  readonly accountExistsSignIn: OperationId;
  readonly requestVerificationEmail: OperationId;
  readonly navigateVerification: OperationId;
  readonly postVerificationSignIn: OperationId;
  readonly browserClose: OperationId;
  readonly mailboxQuery: LiveIdentifier<"mailbox_query">;
}

interface GmailRuntimeBinding {
  readonly journeyId: Stage2AccountVerifiedInput["journeyId"];
  readonly recipientBindingId: RecipientBindingId;
  readonly senderPolicyId: SenderPolicyId;
  readonly target: TargetIdentityV1;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly verificationOperationId: OperationId;
}

export function createAccountVerifiedBindings(
  owner: RealRunOwnerInputsV1,
  sourceRevision: string,
  now: string,
  operations: AccountVerifiedOperationIds,
) {
  const targetSuffix = opaqueSuffix(owner.target.handleId, "target_ref_");
  const profileSuffix = opaqueSuffix(owner.profileRef, "profile_ref_");
  const target = Object.freeze({
    schemaVersion: 1 as const,
    atsFamily: "workday" as const,
    hostId: `host_${targetSuffix}` as TargetHostId,
    tenantId: `tenant_${targetSuffix}` as TargetTenantId,
    postingId: `posting_${targetSuffix}` as TargetPostingId,
  });
  const notBefore = new Date(Date.parse(now) - 60 * 60 * 1_000).toISOString();
  const mailboxRequest = Object.freeze({
    schemaVersion: 1 as const,
    journeyId: owner.journeyId as never,
    queryId: operations.mailboxQuery as never,
    recipientBindingId: owner.recipientBindingId as RecipientBindingId,
    target,
    notBefore,
    notAfter: now,
  });
  const lifecycle = Object.freeze({
    schemaVersion: 1 as const,
    operationId: operations.lifecycle,
    approvalId: owner.approval.approvalId,
    journeyId: owner.journeyId as never,
    target,
    mailboxRequest,
    now,
    operations: Object.freeze({
      initialCredentialMutation: operations.initialCredentialMutation,
      createCredentialMutation: operations.createCredentialMutation,
      accountExistsSignIn: operations.accountExistsSignIn,
      requestVerificationEmail: operations.requestVerificationEmail,
      navigateVerification: operations.navigateVerification,
      postVerificationSignIn: operations.postVerificationSignIn,
    }),
  });
  const gmail = Object.freeze({
    journeyId: lifecycle.journeyId,
    recipientBindingId: mailboxRequest.recipientBindingId,
    senderPolicyId: deriveSenderPolicyId({
      revisionId: owner.revisionId,
      journeyId: owner.journeyId,
      gmailHandleId: owner.gmailAuthorization.handleId,
      recipientBindingId: owner.recipientBindingId,
    }) as SenderPolicyId,
    target,
    notBefore,
    notAfter: mailboxRequest.notAfter,
    verificationOperationId: operations.navigateVerification,
  });
  const runner: Stage2AccountVerifiedInput = Object.freeze({
    sourceRevision,
    revisionId: owner.revisionId,
    approvalId: owner.approval.approvalId,
    journeyId: lifecycle.journeyId,
    targetHandleId: owner.target.handleId,
  });
  const openRequest = Object.freeze({
    schemaVersion: 1 as const,
    journeyId: lifecycle.journeyId,
    operationId: operations.browserOpen,
    profileLeaseId: `profile_lease_${profileSuffix}` as ProfileLeaseId,
    target,
  });
  return Object.freeze({
    runner,
    target,
    profileLeaseId: openRequest.profileLeaseId,
    openRequest,
    mailboxRequest,
    lifecycle,
    gmail,
  });
}

interface SessionBoundAccountBrowser {
  advanceToAccountEntry(
    request: {
      readonly schemaVersion: 1;
      readonly journeyId: AccountLifecycleInput["journeyId"];
      readonly operationId: OperationId;
      readonly sessionId: LiveBrowserSessionV1["sessionId"];
      readonly target: TargetIdentityV1;
      readonly now: string;
    },
    signal: AbortSignal,
  ): Promise<LivePortResult<
    | { readonly kind: "account_boundary" }
    | { readonly kind: "target_mismatch"; readonly dimension: "host" | "tenant" | "posting" }
    | { readonly kind: "target_ambiguous" }
    | { readonly kind: "posting_unavailable"; readonly reason: "not_found" | "closed" | "removed" | "unavailable" | "maintenance" | "runtime_error" },
    PersistentBrowserErrorCode
  >>;
  reconcile(
    request: PersistentBrowserReconcileRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<PersistentBrowserReconcileResult, PersistentBrowserErrorCode>>;
}

interface CleanupBrowser extends SessionBoundAccountBrowser {
  open(
    request: PersistentBrowserOpenRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<PersistentBrowserOpenResult, PersistentBrowserErrorCode>>;
  close(
    request: PersistentBrowserCloseRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>>;
}

export type SessionBoundAccountVerificationResult =
  | {
      readonly ok: true;
      readonly value: Extract<AccountLifecycleResult, { readonly ok: true }>["value"];
    }
  | { readonly ok: false; readonly error: { readonly code: string } };

export async function runSessionBoundAccountVerifiedLifecycle(options: {
  readonly browser: SessionBoundAccountBrowser;
  readonly session: LiveBrowserSessionV1;
  readonly journeyId: AccountLifecycleInput["journeyId"];
  readonly expectedTarget: TargetIdentityV1;
  readonly reconcileOperationId: OperationId;
  readonly advanceOperationId: OperationId;
  readonly now: string;
  readonly clock?: () => string;
  readonly authorizationExpiresAt?: string;
  readonly trace?: (event: string) => void;
  readonly runLifecycle: (
    session: LiveBrowserSessionV1,
    signal: AbortSignal,
  ) => Promise<AccountLifecycleResult>;
}, signal: AbortSignal): Promise<SessionBoundAccountVerificationResult> {
  try {
    if (authorizedEffectNow(options, signal) === null) {
      return sessionFailure("operation_cancelled");
    }
    emitSessionTrace(options.trace, "account_session_reconcile_started");
    const reconciled = await options.browser.reconcile({
      schemaVersion: 1,
      journeyId: options.journeyId,
      operationId: options.reconcileOperationId,
      session: options.session,
      expectedTarget: options.expectedTarget,
    }, signal);
    if (!reconciled.ok) {
      emitSessionTrace(options.trace, "account_session_reconcile_failed");
      return sessionFailure(reconciled.error.code);
    }
    if (reconciled.value.kind !== "matched") {
      emitSessionTrace(options.trace, "account_session_reconcile_blocked");
      return factualSessionResult(reconciled.value);
    }
    emitSessionTrace(options.trace, "account_session_reconcile_succeeded");
    let operationId = options.advanceOperationId;
    let routed: Extract<
      Extract<AccountLifecycleResult, { readonly ok: true }>["value"],
      { readonly kind: "navigation_required" }
    > | undefined;
    for (let transition = 0; transition < 4; transition += 1) {
      const advanceNow = authorizedEffectNow(options, signal);
      if (advanceNow === null) return sessionFailure("operation_cancelled");
      emitSessionTrace(options.trace, "account_session_advance_started");
      const advanced = await options.browser.advanceToAccountEntry({
        schemaVersion: 1,
        journeyId: options.journeyId,
        operationId,
        sessionId: options.session.sessionId,
        target: options.expectedTarget,
        now: advanceNow,
      }, signal);
      if (!advanced.ok) {
        emitSessionTrace(options.trace, "account_session_advance_failed");
        return sessionFailure(advanced.error.code);
      }
      if (advanced.value.kind !== "account_boundary") {
        emitSessionTrace(options.trace, "account_session_advance_blocked");
        return factualSessionResult(advanced.value);
      }
      emitSessionTrace(options.trace, "account_session_advance_succeeded");
      if (authorizedEffectNow(options, signal) === null) {
        return sessionFailure("operation_cancelled");
      }
      emitSessionTrace(options.trace, "account_session_lifecycle_started");
      const lifecycle = await options.runLifecycle(options.session, signal);
      emitSessionTrace(options.trace, lifecycle.ok
        ? "account_session_lifecycle_succeeded"
        : "account_session_lifecycle_failed");
      if (!lifecycle.ok) return sessionFailure(lifecycle.error.code);
      if (lifecycle.value.kind === "navigation_required") {
        if (routed !== undefined) return sessionFailure("browser_target_invalid");
        routed = lifecycle.value;
        operationId = `operation_${randomBytes(16).toString("hex")}` as OperationId;
        emitSessionTrace(options.trace, "account_session_page_redispatch_started");
        continue;
      }
      if (
        routed !== undefined && lifecycle.value.kind === "account_ready" &&
        lifecycle.value.path === "already_ready"
      ) {
        return {
          ok: true,
          value: {
            kind: "account_ready",
            path: routed.path,
            independentlyObserved: true,
            verificationCandidateCount: routed.verificationCandidateCount,
            verificationConsumed: routed.verificationConsumed,
          },
        };
      }
      if (routed !== undefined && lifecycle.value.kind === "account_ready") {
        return sessionFailure("account_proof_invalid");
      }
      return { ok: true, value: lifecycle.value };
    }
    return sessionFailure("browser_target_invalid");
  } catch {
    return sessionFailure(
      signal.aborted ? "operation_cancelled" : "account_proof_invalid",
    );
  }
}

function emitSessionTrace(
  trace: ((event: string) => void) | undefined,
  event: string,
): void {
  try { trace?.(event); } catch { /* diagnostics never change account behavior */ }
}

export function createCleanupBoundAccountVerifiedLifecycle(options: {
  readonly browser: CleanupBrowser;
  readonly openRequest: PersistentBrowserOpenRequest;
  readonly reconcileOperationId: OperationId;
  readonly advanceOperationId: OperationId;
  readonly closeOperationId: OperationId;
  readonly now: string;
  readonly clock?: () => string;
  readonly authorizationExpiresAt?: string;
  readonly runLifecycle: (
    session: LiveBrowserSessionV1,
    signal: AbortSignal,
  ) => Promise<AccountLifecycleResult>;
}): AccountVerifiedLifecycleRunner {
  return Object.freeze({
    async run(signal: AbortSignal): Promise<AccountVerifiedLifecycleResult> {
      if (authorizedEffectNow(options, signal) === null) {
        return lifecycleFailure("operation_cancelled");
      }
      const opened = await options.browser.open(options.openRequest, signal);
      if (!opened.ok) return lifecycleFailure(opened.error.code);
      const session = opened.value.session;
      const sessionResult = await runSessionBoundAccountVerifiedLifecycle({
        browser: options.browser,
        session,
        journeyId: options.openRequest.journeyId,
        expectedTarget: options.openRequest.target,
        reconcileOperationId: options.reconcileOperationId,
        advanceOperationId: options.advanceOperationId,
        now: options.now,
        clock: options.clock,
        authorizationExpiresAt: options.authorizationExpiresAt,
        runLifecycle: options.runLifecycle,
      }, signal);
      try {
        const closed = await options.browser.close({
          schemaVersion: 1,
          journeyId: options.openRequest.journeyId,
          operationId: options.closeOperationId,
          sessionId: session.sessionId,
        }, new AbortController().signal);
        if (closed.ok) {
          return sessionResult.ok
            ? { ok: true, cleanup: "pass", value: sessionResult.value }
            : sessionResult;
        }
        if (!sessionResult.ok && closed.error.code === "browser_session_missing") {
          return sessionResult;
        }
        return lifecycleFailure(closed.error.code);
      } catch {
        return lifecycleFailure("browser_profile_cleanup_failed");
      }
    },
  });
}

export interface Stage2AccountVerifiedSessionOptions {
  readonly owner: RealRunOwnerInputsV1;
  readonly sourceRevision: string;
  readonly configSha256: string;
  readonly storageRoot: string;
  readonly browser: PlaywrightPersistentBrowserSession;
  readonly session: LiveBrowserSessionV1;
  readonly target: TargetIdentityV1;
  readonly clock?: () => string;
}

export interface Stage2UnsealedAccountProofV1 {
  readonly schemaVersion: 1;
  readonly proofRevision: "s2-account-session-proof-v1";
  readonly status: "unsealed";
  readonly sourceRevision: string;
  readonly configSha256: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly accountState: "application_ready";
  readonly independentlyObservedVerifiedState: true;
  readonly verificationProof: "gmail_candidate_consumed" | "credential_sign_in";
  readonly provider: "gmail-api-v1" | "workday-auth";
  readonly consumedCandidateCount: 0 | 1;
  readonly messageBodyRetained: false;
  readonly submitActivated: false;
}

export type Stage2UnsealedAccountProofResult =
  | { readonly ok: true; readonly proof: Stage2UnsealedAccountProofV1 }
  | { readonly ok: false; readonly code: string; readonly fact?: AccountVerifiedFact };

export async function runStage2AccountVerifiedInSession(
  options: Stage2AccountVerifiedSessionOptions,
  signal: AbortSignal,
): Promise<Stage2UnsealedAccountProofResult> {
  let authorizationSignal: AbortSignal | undefined;
  try {
    const liveClock = options.clock ?? systemClock;
    const executionerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const source = inspectCleanSourceRevision(executionerRoot);
    if (
      source.sourceRevision !== options.sourceRevision ||
      !/^[0-9a-f]{64}$/u.test(options.configSha256) ||
      options.owner.journeyId !== options.session.journeyId ||
      !sameTarget(options.target, options.session.target) ||
      !sameTarget(options.target, createAccountVerifiedBindings(
        options.owner,
        source.sourceRevision,
        liveClock(),
        operationIds(),
      ).target)
    ) return unsealedFailure("owner_config_invalid");
    const admittedNow = liveClock();
    const authorization = createAuthorizationRuntime(
      options.owner.approval.expiresAt,
      signal,
      liveClock,
    );
    authorizationSignal = authorization.signal;
    try {
      if (authorization.current() === null) return unsealedFailure("operation_cancelled");
      const secretStore = new WindowsDpapiSecretStore({
        root: options.owner.roots.secrets.path,
        forbiddenRoots: [source.repositoryRoot],
        now: liveClock,
      });
      const [accountInspection, gmailInspection] = await Promise.all([
        inspectAuthorizedSecret(secretStore, {
          schemaVersion: 1,
          journeyId: options.owner.journeyId as never,
          handleId: options.owner.accountSecret.handleId as SecretHandleId,
          expectedPurpose: "account_credentials",
          expectedConsumer: "credential_mutation_adapter",
        }, authorization),
        inspectAuthorizedSecret(secretStore, {
          schemaVersion: 1,
          journeyId: options.owner.journeyId as never,
          handleId: options.owner.gmailAuthorization.handleId as SecretHandleId,
          expectedPurpose: "gmail_oauth",
          expectedConsumer: "gmail_auth_executor",
        }, authorization),
      ]);
      if (!accountInspection.ok) return unsealedFailure(accountInspection.error.code);
      if (!gmailInspection.ok) return unsealedFailure(gmailInspection.error.code);
      if (!exactAccountMetadata(accountInspection.value, options.owner) ||
          !exactGmailMetadata(gmailInspection.value, options.owner)) {
        return unsealedFailure("secret_handle_mismatched");
      }
      const account = accountInspection.value as ActiveAccountSecretHandle;
      const gmailAuthorization = gmailInspection.value as ActiveGmailSecretHandle;
      const operations = operationIds();
      const bindings = createAccountVerifiedBindings(
        options.owner,
        source.sourceRevision,
        admittedNow,
        operations,
      );
      const valueFreeTrace = process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1"
        ? (event: string) => process.stderr.write(`${JSON.stringify({ trace: event })}\n`)
        : undefined;
      const structural = createPlaywrightLiveEntryStructuralSource(options.browser);
      const classified = createClassifiedAccountObservationSource(
        createLiveEntryVerifier(structural),
      );
      const resolver = new WindowsDpapiSecretResolver({
        root: options.owner.roots.secrets.path,
        forbiddenRoots: [source.repositoryRoot],
        now: liveClock,
      });
      const credentialMutation = createAccountEntryCredentialMutationAdapter({
        accountPage: options.browser,
        classifiedAccount: classified,
        credentials: resolver,
        trace: valueFreeTrace,
      });
      const rawVault = new GmailRawArtifactVault();
      const artifacts = new GmailSafeArtifactRegistry();
      const mailbox = createBoundedVerificationMailboxPolling({
        clock: liveClock,
        authorizationExpiresAt: options.owner.approval.expiresAt,
        maxDurationMs: 5 * 60_000,
        baseDelayMs: 250,
        maxDelayMs: 5_000,
        createQueryId: () =>
          `mailbox_query_${randomBytes(16).toString("hex")}` as LiveIdentifier<"mailbox_query">,
        createAttemptProvider: (attemptRequest) => {
          const attemptBinding = Object.freeze({
            ...bindings.gmail,
            notBefore: attemptRequest.notBefore,
            notAfter: attemptRequest.notAfter,
          });
          const authExecutor = new GmailApiAuthExecutor({
            binding: attemptBinding,
            resolver,
            httpClient: new GmailHttpClient({ trace: valueFreeTrace }),
            rawVault,
            artifactRegistry: artifacts,
            approvedPolicy: approvedPolicy(options.owner),
            createHandle: () =>
              `verification_handle_${randomBytes(16).toString("hex")}` as VerificationHandleId,
            policyFactory: {
              create(candidateSource, current) {
                return createBoundedMailboxPolicy({
                  binding: attemptBinding,
                  candidateSource,
                  clock: () => current,
                  timeoutMs: 60_000,
                });
              },
            },
          });
          return new GmailMailboxProvider({
            authorization: gmailAuthorization,
            binding: attemptRequest,
            now: liveClock,
            secretStore,
            authExecutor,
            artifacts: artifacts.port,
            timeoutMs: 60_000,
          });
        },
        trace: valueFreeTrace,
      });
      const consumer = new GmailAtomicArtifactConsumer({
        rawVault,
        artifacts,
        replayGuard: new Stage2VerificationReplayLedger({
          root: join(options.storageRoot, "bindings", "verification-consumption"),
          recipientBindingId: options.owner.recipientBindingId,
          host: options.owner.target.host,
          tenant: options.owner.target.tenant,
          now: liveClock,
        }),
      });
      const navigator = createGmailPrivilegedVerificationNavigator({
        consumer,
        approvedPolicy: verificationApprovedPolicy(options.owner),
        browser: verificationBrowser(options.browser),
      });
      const sessionResult = await runSessionBoundAccountVerifiedLifecycle({
          browser: options.browser,
          session: options.session,
          journeyId: bindings.lifecycle.journeyId,
          expectedTarget: bindings.target,
          reconcileOperationId: operations.browserReconcile,
          advanceOperationId: operations.accountAdvance,
          now: admittedNow,
          clock: liveClock,
          authorizationExpiresAt: options.owner.approval.expiresAt,
          trace: valueFreeTrace,
          runLifecycle: (session, activeSignal) => {
            const current = authorization.current();
            if (current === null) {
              return Promise.resolve({
                ok: false,
                error: { code: "operation_cancelled", retryable: false },
              });
            }
            return new AccountVerificationLifecycle(
              createAuthorizationBoundLifecycleDependencies({
                credentialMutation: credentialMutation.lifecycle,
                verificationEmail: createVerificationEmailRequestAdapter({
                  accountPage: options.browser,
                  binding: {
                    approvalId: options.owner.approval.approvalId,
                    journeyId: bindings.lifecycle.journeyId,
                    operationId: operations.requestVerificationEmail,
                    sessionId: session.sessionId,
                    target: bindings.target,
                  },
                }),
                mailbox,
                artifacts: artifacts.port,
                navigator,
                accountState: createBoundAccountStateObserver(classified, {
                  journeyId: bindings.lifecycle.journeyId,
                  sessionId: session.sessionId,
                  target: bindings.target,
                }),
                trace: valueFreeTrace,
              }, authorization),
            ).run({
              ...bindings.lifecycle,
              now: current,
              accountIntent: options.owner.accountMode,
              session,
              credential: account,
            }, activeSignal);
          },
        }, authorization.signal);
      return unsealedAccountProof(options, bindings.runner, sessionResult);
    } finally {
      authorization.dispose();
    }
  } catch {
    return unsealedFailure(
      signal.aborted || authorizationSignal?.aborted
        ? "operation_cancelled"
        : "owner_config_invalid",
    );
  }
}

export async function runStage2AccountVerifiedFromOwnerConfig(
  options: Stage2AccountVerifiedProductionOptions,
  signal: AbortSignal,
): Promise<Stage2AccountVerifiedResult> {
  let authorizationSignal: AbortSignal | undefined;
  try {
    const liveClock = systemClock;
    const executionerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const source = inspectCleanSourceRevision(executionerRoot);
    const configPath = admittedFile(options.configPath);
    const value = readOwnerConfig(configPath);
    const admittedNow = liveClock();
    const admission = createPrivateRealRunAdmission(value, {
      now: admittedNow,
      forbiddenRoots: [source.repositoryRoot],
      ownerConfigPath: configPath,
    });
    if (!admission.ok) return failure(admission.error.code);
    const owner = value as RealRunOwnerInputsV1;
    const storageRoot = stage2StorageRootForOwnerBinding({
      ownerConfigPath: configPath,
      runtimeRoot: owner.roots.runtime.path,
      ownerEvidenceRoot: owner.roots.evidence.path,
      requestedEvidenceRoot: options.evidenceRoot,
    });
    if (storageRoot === undefined) {
      return failure("owner_config_invalid");
    }
    const authorization = createAuthorizationRuntime(
      owner.approval.expiresAt,
      signal,
      liveClock,
    );
    authorizationSignal = authorization.signal;
    try {
      if (authorization.current() === null) return failure("operation_cancelled");
      const secretStore = new WindowsDpapiSecretStore({
        root: owner.roots.secrets.path,
        forbiddenRoots: [source.repositoryRoot],
        now: liveClock,
      });
      const [accountInspection, gmailInspection] = await Promise.all([
        inspectAuthorizedSecret(secretStore, {
          schemaVersion: 1,
          journeyId: owner.journeyId as never,
          handleId: owner.accountSecret.handleId as SecretHandleId,
          expectedPurpose: "account_credentials",
          expectedConsumer: "credential_mutation_adapter",
        }, authorization),
        inspectAuthorizedSecret(secretStore, {
          schemaVersion: 1,
          journeyId: owner.journeyId as never,
          handleId: owner.gmailAuthorization.handleId as SecretHandleId,
          expectedPurpose: "gmail_oauth",
          expectedConsumer: "gmail_auth_executor",
        }, authorization),
      ]);
    if (!accountInspection.ok) return failure(accountInspection.error.code);
    if (!gmailInspection.ok) return failure(gmailInspection.error.code);
    if (!exactAccountMetadata(accountInspection.value, owner) ||
        !exactGmailMetadata(gmailInspection.value, owner)) {
      return failure("secret_handle_mismatched");
    }
    const account = accountInspection.value as ActiveAccountSecretHandle;
    const gmailAuthorization = gmailInspection.value as ActiveGmailSecretHandle;
    const operations = operationIds();
    const bindings = createAccountVerifiedBindings(
      owner,
      source.sourceRevision,
      admittedNow,
      operations,
    );
    const valueFreeTrace = process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1"
      ? (event: string) => process.stderr.write(`${JSON.stringify({ trace: event })}\n`)
      : undefined;
    const inspectionHold = process.env.HUNT_C3_LIVE_INSPECTION_HOLD === "1"
      ? createOperatorMonitorInspectionHold({
        runtimeRoot: owner.roots.runtime.path,
        evidenceRoot: owner.roots.evidence.path,
        journeyId: owner.journeyId,
        targetHandleId: owner.target.handleId,
        host: owner.target.host,
        tenant: owner.target.tenant,
        posting: owner.target.posting,
      })
      : undefined;
    const browser = createPlaywrightPersistentBrowserSession({
      binding: admission.binding,
      accountTrace: valueFreeTrace,
      inspectionHold,
    });
    const structural = createPlaywrightLiveEntryStructuralSource(browser);
    const classified = createClassifiedAccountObservationSource(
      createLiveEntryVerifier(structural),
    );
    const resolver = new WindowsDpapiSecretResolver({
      root: owner.roots.secrets.path,
      forbiddenRoots: [source.repositoryRoot],
      now: liveClock,
    });
    const credentialMutation = createAccountEntryCredentialMutationAdapter({
      accountPage: browser,
      classifiedAccount: classified,
      credentials: resolver,
      trace: valueFreeTrace,
    });
    const rawVault = new GmailRawArtifactVault();
    const artifacts = new GmailSafeArtifactRegistry();
    const mailbox = createBoundedVerificationMailboxPolling({
      clock: liveClock,
      authorizationExpiresAt: owner.approval.expiresAt,
      maxDurationMs: 5 * 60_000,
      baseDelayMs: 250,
      maxDelayMs: 5_000,
      createQueryId: () =>
        `mailbox_query_${randomBytes(16).toString("hex")}` as LiveIdentifier<"mailbox_query">,
      createAttemptProvider: (attemptRequest) => {
        const attemptBinding = Object.freeze({
          ...bindings.gmail,
          notBefore: attemptRequest.notBefore,
          notAfter: attemptRequest.notAfter,
        });
        const authExecutor = new GmailApiAuthExecutor({
          binding: attemptBinding,
          resolver,
          httpClient: new GmailHttpClient({ trace: valueFreeTrace }),
          rawVault,
          artifactRegistry: artifacts,
          approvedPolicy: approvedPolicy(owner),
          createHandle: () =>
            `verification_handle_${randomBytes(16).toString("hex")}` as VerificationHandleId,
          policyFactory: {
            create(candidateSource, admittedNow) {
              return createBoundedMailboxPolicy({
                binding: attemptBinding,
                candidateSource,
                clock: () => admittedNow,
                timeoutMs: 60_000,
              });
            },
          },
        });
        return new GmailMailboxProvider({
          authorization: gmailAuthorization,
          binding: attemptRequest,
          now: liveClock,
          secretStore,
          authExecutor,
          artifacts: artifacts.port,
          timeoutMs: 60_000,
        });
      },
      trace: valueFreeTrace,
    });
    const consumer = new GmailAtomicArtifactConsumer({
      rawVault,
      artifacts,
      replayGuard: new Stage2VerificationReplayLedger({
        root: join(storageRoot, "bindings", "verification-consumption"),
        recipientBindingId: owner.recipientBindingId,
        host: owner.target.host,
        tenant: owner.target.tenant,
        now: liveClock,
      }),
    });
    const navigator = createGmailPrivilegedVerificationNavigator({
      consumer,
      approvedPolicy: verificationApprovedPolicy(owner),
      browser: verificationBrowser(browser),
    });
    const cleanupBoundLifecycle = createCleanupBoundAccountVerifiedLifecycle({
      browser,
      openRequest: bindings.openRequest,
      reconcileOperationId: operations.browserReconcile,
      advanceOperationId: operations.accountAdvance,
      closeOperationId: operations.browserClose,
      now: admittedNow,
      clock: liveClock,
      authorizationExpiresAt: owner.approval.expiresAt,
      runLifecycle: (session, lifecycleSignal) => {
        const current = authorization.current();
        if (current === null) {
          return Promise.resolve({
            ok: false,
            error: { code: "operation_cancelled", retryable: false },
          });
        }
        const lifecycle = new AccountVerificationLifecycle(
          createAuthorizationBoundLifecycleDependencies({
            credentialMutation: credentialMutation.lifecycle,
            verificationEmail: createVerificationEmailRequestAdapter({
              accountPage: browser,
              binding: {
                approvalId: owner.approval.approvalId,
                journeyId: bindings.lifecycle.journeyId,
                operationId: operations.requestVerificationEmail,
                sessionId: session.sessionId,
                target: bindings.target,
              },
            }),
            mailbox,
            artifacts: artifacts.port,
            navigator,
            accountState: createBoundAccountStateObserver(classified, {
              journeyId: bindings.lifecycle.journeyId,
              sessionId: session.sessionId,
              target: bindings.target,
            }),
            trace: valueFreeTrace,
          }, authorization),
        );
        return lifecycle.run({
          ...bindings.lifecycle,
          now: current,
          accountIntent: owner.accountMode,
          session,
          credential: account,
        }, lifecycleSignal);
      },
    });
    const evidence = createAuthorizationBoundEvidenceWriter(
      authorization,
      async (acceptance) => writeAccountVerifiedEvidence({
        root: owner.roots.evidence.path,
        acceptance,
        sensitiveValues: [
          owner.target.url,
          owner.target.host,
          owner.target.tenant,
          owner.target.posting,
          owner.roots.runtime.path,
          owner.roots.secrets.path,
          owner.roots.evidence.path,
          configPath,
        ],
      }),
    );
      const result = await runStage2AccountVerified(bindings.runner, {
        lifecycle: cleanupBoundLifecycle,
        evidence: evidence.writer,
      }, authorization.signal);
      return !result.ok && result.code === "evidence_unavailable" && evidence.expired()
        ? failure("operation_cancelled")
        : result;
    } finally {
      authorization.dispose();
    }
  } catch {
    return failure(
      signal.aborted || authorizationSignal?.aborted
        ? "operation_cancelled"
        : "owner_config_invalid",
    );
  }
}

function systemClock(): string {
  return new Date().toISOString();
}

interface AuthorizationRuntime {
  readonly signal: AbortSignal;
  current(): string | null;
  dispose(): void;
}

function createAuthorizationRuntime(
  expiresAt: string,
  parentSignal: AbortSignal,
  clock: () => string,
): AuthorizationRuntime {
  const deadline = Date.parse(expiresAt);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  parentSignal.addEventListener("abort", cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    const current = readExactClock(clock);
    const remaining = current === null ? 0 : deadline - Date.parse(current);
    if (!Number.isFinite(deadline) || remaining <= 0) {
      cancel();
      return;
    }
    const delay = Math.min(remaining, 2_147_483_647);
    timer = setTimeout(remaining > delay ? schedule : cancel, delay);
    timer.unref();
  };
  schedule();
  if (parentSignal.aborted) cancel();
  return Object.freeze({
    signal: controller.signal,
    current() {
      if (controller.signal.aborted) return null;
      const value = readExactClock(clock);
      if (value === null || Date.parse(value) >= deadline) {
        cancel();
        return null;
      }
      return value;
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal.removeEventListener("abort", cancel);
    },
  });
}

function authorizedEffectNow(
  options: {
    readonly now: string;
    readonly clock?: () => string;
    readonly authorizationExpiresAt?: string;
  },
  signal: AbortSignal,
): string | null {
  if (signal.aborted) return null;
  const value = options.clock === undefined
    ? readExactClock(() => options.now)
    : readExactClock(options.clock);
  if (value === null) return null;
  return options.authorizationExpiresAt !== undefined &&
      Date.parse(value) >= Date.parse(options.authorizationExpiresAt)
    ? null
    : value;
}

function readExactClock(clock: () => string): string | null {
  try {
    const value = clock();
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
      ? value
      : null;
  } catch {
    return null;
  }
}

async function inspectAuthorizedSecret(
  store: SecretStore,
  request: SecretInspectRequest,
  authorization: AuthorizationRuntime,
) {
  if (authorization.current() === null) return cancelledPortResult();
  return store.inspect(request, authorization.signal);
}

export function createAuthorizationBoundLifecycleDependencies(
  dependencies: AccountLifecycleDependencies,
  authorization: Pick<AuthorizationRuntime, "signal" | "current">,
): AccountLifecycleDependencies {
  const admit = (signal: AbortSignal) =>
    !signal.aborted && !authorization.signal.aborted
      ? authorization.current()
      : null;
  const credentialMutation: AccountLifecycleDependencies["credentialMutation"] =
    Object.freeze({
      mutate(
        request: Parameters<AccountLifecycleDependencies["credentialMutation"]["mutate"]>[0],
        signal: AbortSignal,
      ) {
        const current = admit(signal);
        return current === null
          ? Promise.resolve(cancelledPortResult())
          : dependencies.credentialMutation.mutate({ ...request, now: current }, signal);
      },
    });
  const mailbox: AccountLifecycleDependencies["mailbox"] = Object.freeze({
    poll(
      request: Parameters<AccountLifecycleDependencies["mailbox"]["poll"]>[0],
      signal: AbortSignal,
    ) {
      return admit(signal) === null
        ? Promise.resolve(cancelledPortResult())
        : dependencies.mailbox.poll(request, signal);
    },
  });
  const verificationEmail = dependencies.verificationEmail === undefined
    ? undefined
    : Object.freeze({
      request(
        request: Parameters<NonNullable<AccountLifecycleDependencies["verificationEmail"]>["request"]>[0],
        signal: AbortSignal,
      ) {
        const current = admit(signal);
        return current === null
          ? Promise.resolve(cancelledPortResult())
          : dependencies.verificationEmail!.request({ ...request, now: current }, signal);
      },
    });
  const artifacts: AccountLifecycleDependencies["artifacts"] = Object.freeze({
    inspect(
      request: Parameters<AccountLifecycleDependencies["artifacts"]["inspect"]>[0],
      signal: AbortSignal,
    ) {
      return admit(signal) === null
        ? Promise.resolve(cancelledPortResult())
        : dependencies.artifacts.inspect(request, signal);
    },
    invalidate(
      request: Parameters<AccountLifecycleDependencies["artifacts"]["invalidate"]>[0],
      signal: AbortSignal,
    ) {
      return admit(signal) === null
        ? Promise.resolve(cancelledPortResult())
        : dependencies.artifacts.invalidate(request, signal);
    },
  });
  const navigator: AccountLifecycleDependencies["navigator"] = Object.freeze({
    navigate(
      request: Parameters<AccountLifecycleDependencies["navigator"]["navigate"]>[0],
      signal: AbortSignal,
    ) {
      const current = admit(signal);
      return current === null
        ? Promise.resolve(cancelledPortResult())
        : dependencies.navigator.navigate({ ...request, now: current }, signal);
    },
  });
  const accountState: AccountLifecycleDependencies["accountState"] = Object.freeze({
    observe(
      request: Parameters<AccountLifecycleDependencies["accountState"]["observe"]>[0],
      signal: AbortSignal,
    ) {
      return admit(signal) === null
        ? Promise.resolve(cancelledPortResult())
        : dependencies.accountState.observe(request, signal);
    },
  });
  const bounded: AccountLifecycleDependencies = {
    credentialMutation,
    ...(verificationEmail === undefined ? {} : { verificationEmail }),
    mailbox,
    artifacts,
    navigator,
    accountState,
    trace: dependencies.trace,
  };
  return Object.freeze(bounded);
}

function createAuthorizationBoundEvidenceWriter(
  authorization: Pick<AuthorizationRuntime, "current">,
  write: (acceptance: AccountVerifiedAcceptance) => Promise<void>,
): { readonly writer: AccountVerifiedEvidenceWriter; expired(): boolean } {
  let expired = false;
  const writer: AccountVerifiedEvidenceWriter = {
    async write(acceptance) {
      if (authorization.current() === null) {
        expired = true;
        throw new Error("authorization expired");
      }
      await write(acceptance);
    },
  };
  return Object.freeze({
    writer: Object.freeze(writer),
    expired: () => expired,
  });
}

function cancelledPortResult() {
  return {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  } as const;
}

export function createBoundAccountStateObserver(
  classified: ClassifiedAccountObservationSource,
  binding: {
    readonly journeyId: AccountLifecycleInput["journeyId"];
    readonly sessionId: LiveSessionId;
    readonly target: TargetIdentityV1;
  },
): AccountLifecycleAccountStateObserver {
  return Object.freeze({
    observe(
      request: AccountLifecycleObservationRequest,
      signal: AbortSignal,
    ) {
      if (
        request.schemaVersion !== 1 ||
        request.journeyId !== binding.journeyId ||
        request.sessionId !== binding.sessionId ||
        !sameTarget(request.target, binding.target)
      ) {
        return Promise.resolve({
          ok: false as const,
          error: {
            code: "browser_target_invalid" as const,
            retryable: false as const,
          },
        });
      }
      return classified.inspectClassifiedAccount({
        schemaVersion: 1,
        sessionId: request.sessionId,
        target: request.target,
      }, signal);
    },
  });
}

function verificationBrowser(
  browser: PlaywrightPersistentBrowserSession,
): ByteScopedVerificationBrowserCapability {
  return Object.freeze({
    async navigateVerificationTarget(request: Parameters<ByteScopedVerificationBrowserCapability["navigateVerificationTarget"]>[0], signal: AbortSignal) {
      let inner: LivePortResult<
        VerificationNavigationResult,
        PersistentBrowserErrorCode
      > | undefined;
      const scoped = await browser.withOwnedVerificationNavigationAccess({
        schemaVersion: 1,
        journeyId: request.journeyId,
        operationId: request.operationId,
        sessionId: request.sessionId,
        target: request.expectedTarget,
        now: request.now,
      }, signal, async (access) => {
        inner = await access.navigateVerificationTarget({
          verificationTarget: request.verificationTarget,
          approvedHost: request.approvedHost,
          approvedTenant: request.approvedTenant,
        }, signal);
      });
      if (!scoped.ok) return mapVerificationBrowserFailure(scoped.error.code);
      if (inner === undefined) return mapVerificationBrowserFailure("browser_effect_uncertain");
      return inner.ok
        ? { ok: true as const, value: inner.value }
        : mapVerificationBrowserFailure(inner.error.code);
    },
  });
}

function mapVerificationBrowserFailure(code: PersistentBrowserErrorCode | "operation_cancelled") {
  if (code === "operation_cancelled") {
    return { ok: false, error: { code, retryable: false } } as const;
  }
  if (code === "browser_timeout") {
    return { ok: false, error: { code, retryable: true } } as const;
  }
  if (code === "browser_effect_uncertain") {
    return { ok: false, error: { code, retryable: false } } as const;
  }
  return {
    ok: false,
    error: { code: "verification_navigation_denied", retryable: false },
  } as const;
}

function approvedPolicy(owner: RealRunOwnerInputsV1): GmailApprovedPolicyCapability {
  return {
    async use(operation) {
      const host = new TextEncoder().encode(owner.target.host);
      const tenant = new TextEncoder().encode(owner.target.tenant);
      try {
        return await operation({ host, tenant });
      } finally {
        host.fill(0);
        tenant.fill(0);
      }
    },
  };
}

function verificationApprovedPolicy(
  owner: RealRunOwnerInputsV1,
): GmailVerificationPolicyCapability {
  return {
    async use(operation) {
      const host = new TextEncoder().encode(owner.target.host);
      const tenant = new TextEncoder().encode(owner.target.tenant);
      try {
        return await operation({ host, tenant });
      } finally {
        host.fill(0);
        tenant.fill(0);
      }
    },
  };
}

function exactAccountMetadata(
  value: SecretHandleMetadataV1,
  owner: RealRunOwnerInputsV1,
): boolean {
  return exactMetadata(value, owner.accountSecret.handleId, owner.accountSecret.expiresAt,
    owner.journeyId, "account_credentials", "credential_mutation_adapter");
}

function exactGmailMetadata(
  value: SecretHandleMetadataV1,
  owner: RealRunOwnerInputsV1,
): boolean {
  return exactMetadata(value, owner.gmailAuthorization.handleId,
    owner.gmailAuthorization.expiresAt, owner.journeyId, "gmail_oauth",
    "gmail_auth_executor");
}

function exactMetadata(
  value: SecretHandleMetadataV1,
  handleId: string,
  expiresAt: string,
  journeyId: string,
  purpose: "account_credentials" | "gmail_oauth",
  consumer: "credential_mutation_adapter" | "gmail_auth_executor",
): boolean {
  return value.schemaVersion === 1 && value.handleId === handleId &&
    value.journeyId === journeyId &&
    value.provider === "windows_dpapi_current_user_v1" &&
    value.purpose === purpose && value.consumer === consumer &&
    value.expiresAt === expiresAt && value.state === "active";
}

function admittedFile(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value ||
      lstatSync(value).isSymbolicLink() || !statSync(value).isFile() ||
      statSync(value).size < 2 || statSync(value).size > 64 * 1024) {
    throw new TypeError("invalid owner config");
  }
  const canonical = realpathSync.native(value);
  if (comparable(canonical) !== comparable(resolve(value))) {
    throw new TypeError("invalid owner config");
  }
  return canonical;
}

function readOwnerConfig(path: string): unknown {
  const bytes = readFileSync(path);
  try {
    if (bytes.byteLength < 2 || bytes.byteLength > 64 * 1024 ||
        (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
      throw new TypeError("invalid owner config");
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    bytes.fill(0);
  }
}

function opaqueSuffix(value: string, prefix: string): string {
  const suffix = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(suffix)) {
    throw new TypeError("invalid opaque reference");
  }
  return suffix;
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function operationIds(): AccountVerifiedOperationIds {
  const next = () => `operation_${randomBytes(16).toString("hex")}` as OperationId;
  return Object.freeze({
    browserOpen: next(),
    browserReconcile: next(),
    accountAdvance: next(),
    lifecycle: next(),
    initialCredentialMutation: next(),
    createCredentialMutation: next(),
    accountExistsSignIn: next(),
    requestVerificationEmail: next(),
    navigateVerification: next(),
    postVerificationSignIn: next(),
    browserClose: next(),
    mailboxQuery: `mailbox_query_${randomBytes(16).toString("hex")}` as never,
  });
}

type TargetFact =
  | { readonly kind: "target_mismatch"; readonly dimension: "host" | "tenant" | "posting" }
  | { readonly kind: "target_ambiguous" }
  | { readonly kind: "posting_unavailable"; readonly reason: "not_found" | "closed" | "removed" | "unavailable" | "maintenance" | "runtime_error" };

function factualSessionResult(
  value: TargetFact,
): SessionBoundAccountVerificationResult {
  return {
    ok: true,
    value: {
      kind: "blocked",
      factualOutcome: {
        source: "target_identity",
        result: Object.freeze({ ...value }),
      },
    },
  };
}

function sameTarget(left: TargetIdentityV1, right: TargetIdentityV1): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.atsFamily === right.atsFamily && left.hostId === right.hostId &&
    left.tenantId === right.tenantId && left.postingId === right.postingId;
}

function unsealedAccountProof(
  options: Stage2AccountVerifiedSessionOptions,
  input: Stage2AccountVerifiedInput,
  result: SessionBoundAccountVerificationResult,
): Stage2UnsealedAccountProofResult {
  if (!result.ok) return unsealedFailure(stableAccountCode(result.error.code));
  const factual = unsealedFactualResult(result.value);
  if (factual !== null) return factual;
  const verified = unsealedVerified(result.value);
  if (verified === null) return unsealedFailure("account_proof_invalid");
  return Object.freeze({
    ok: true as const,
    proof: Object.freeze({
      schemaVersion: 1 as const,
      proofRevision: "s2-account-session-proof-v1" as const,
      status: "unsealed" as const,
      sourceRevision: input.sourceRevision,
      configSha256: options.configSha256,
      revisionId: input.revisionId,
      approvalId: input.approvalId,
      journeyId: input.journeyId,
      targetHandleId: input.targetHandleId,
      accountState: "application_ready" as const,
      independentlyObservedVerifiedState: true as const,
      verificationProof: verified.verificationProof,
      provider: verified.provider,
      consumedCandidateCount: verified.consumedCandidateCount,
      messageBodyRetained: false as const,
      submitActivated: false as const,
    }),
  });
}

function unsealedVerified(value: unknown): Pick<
  Stage2UnsealedAccountProofV1,
  "verificationProof" | "provider" | "consumedCandidateCount"
> | null {
  if (!plainRecord(value) || !exactRecordKeys(value, [
    "kind", "path", "independentlyObserved", "verificationCandidateCount",
    "verificationConsumed",
  ]) || value.kind !== "account_ready" || value.independentlyObserved !== true) return null;
  if (value.path === "verified_account" && value.verificationCandidateCount === 1 &&
      value.verificationConsumed === true) {
    return {
      verificationProof: "gmail_candidate_consumed",
      provider: "gmail-api-v1",
      consumedCandidateCount: 1,
    };
  }
  if (value.path === "reused_account" && value.verificationCandidateCount === 0 &&
      value.verificationConsumed === false) {
    return {
      verificationProof: "credential_sign_in",
      provider: "workday-auth",
      consumedCandidateCount: 0,
    };
  }
  return null;
}

function unsealedFactualResult(
  value: unknown,
): Extract<Stage2UnsealedAccountProofResult, { readonly ok: false }> | null {
  if (!plainRecord(value) || value.kind !== "blocked") return null;
  if (!exactRecordKeys(value, ["kind", "factualOutcome"]) ||
      !plainRecord(value.factualOutcome) ||
      !exactRecordKeys(value.factualOutcome, ["source", "result"]) ||
      !plainRecord(value.factualOutcome.result)) return unsealedFailure("account_proof_invalid");
  const source = value.factualOutcome.source;
  const fact = value.factualOutcome.result;
  if (source === "account_access" && exactRecordKeys(fact, ["kind", "reason"]) &&
      fact.kind === "manual_intervention" &&
      (fact.reason === "captcha" || fact.reason === "mfa" || fact.reason === "access_control")) {
    return { ok: false, code: "manual_intervention", fact: {
      kind: "manual_intervention",
      reason: fact.reason,
    } };
  }
  if (source === "target_identity" && exactRecordKeys(fact, ["kind", "dimension"]) &&
      fact.kind === "target_mismatch" &&
      (fact.dimension === "host" || fact.dimension === "tenant" || fact.dimension === "posting")) {
    return { ok: false, code: "target_mismatch", fact: {
      kind: "target_mismatch",
      dimension: fact.dimension,
    } };
  }
  if (source === "target_identity" && exactRecordKeys(fact, ["kind"]) &&
      fact.kind === "target_ambiguous") {
    return { ok: false, code: "target_ambiguous", fact: { kind: "target_ambiguous" } };
  }
  if (source === "target_identity" && exactRecordKeys(fact, ["kind", "reason"]) &&
      fact.kind === "posting_unavailable" &&
      (fact.reason === "not_found" || fact.reason === "closed" || fact.reason === "removed" ||
        fact.reason === "unavailable" || fact.reason === "maintenance" ||
        fact.reason === "runtime_error")) {
    return { ok: false, code: "posting_unavailable", fact: {
      kind: "posting_unavailable",
      reason: fact.reason,
    } };
  }
  if (typeof fact.kind === "string" && [
    "mailbox_none", "mailbox_ambiguous", "mailbox_expired", "mailbox_consumed",
    "verification_target_unavailable", "ats_unsupported", "ats_unknown", "ats_ambiguous",
    "workday_page_unknown", "workday_page_ambiguous",
  ].includes(fact.kind)) return unsealedFailure(fact.kind);
  return unsealedFailure("account_proof_invalid");
}

function stableAccountCode(code: unknown): string {
  return typeof code === "string" && Object.hasOwn(s2StableErrorPolicy, code)
    ? code
    : "account_proof_invalid";
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecordKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key, index) => keys[index] === key);
}

function lifecycleFailure(code: string): AccountVerifiedLifecycleResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function sessionFailure(code: string): SessionBoundAccountVerificationResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function unsealedFailure(
  code: string,
): Extract<Stage2UnsealedAccountProofResult, { readonly ok: false }> {
  return Object.freeze({ ok: false, code });
}

function failure(code: string): Stage2AccountVerifiedResult {
  return Object.freeze({ ok: false, code });
}
