import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAccountEntryCredentialMutationAdapter,
} from "../account/entry/index.ts";
import {
  AccountVerificationLifecycle,
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
  SecretHandleMetadataV1,
  TargetIdentityV1,
  VerificationNavigationResult,
} from "../contracts/live/index.ts";
import { writeAccountVerifiedEvidence } from "../live/evidence/account-verified-evidence.ts";
import { createPrivateRealRunAdmission } from "../live/preflight/private/runtime-binding.ts";
import type { RealRunOwnerInputsV1 } from "../live/preflight/types.ts";
import {
  runStage2AccountVerified,
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
  const notBefore = new Date(Date.parse(now) - 24 * 60 * 60 * 1_000).toISOString();
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
    journeyId: owner.journeyId as never,
    target,
    mailboxRequest,
    now,
    operations: Object.freeze({
      initialCredentialMutation: operations.initialCredentialMutation,
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
    notAfter: now,
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

interface CleanupBrowser {
  open(
    request: PersistentBrowserOpenRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<PersistentBrowserOpenResult, PersistentBrowserErrorCode>>;
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
    | { readonly kind: "posting_unavailable"; readonly reason: "not_found" | "closed" | "removed" | "unavailable" },
    PersistentBrowserErrorCode
  >>;
  close(
    request: PersistentBrowserCloseRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<void, PersistentBrowserErrorCode>>;
  reconcile(
    request: PersistentBrowserReconcileRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<PersistentBrowserReconcileResult, PersistentBrowserErrorCode>>;
}

export function createCleanupBoundAccountVerifiedLifecycle(options: {
  readonly browser: CleanupBrowser;
  readonly openRequest: PersistentBrowserOpenRequest;
  readonly reconcileOperationId: OperationId;
  readonly advanceOperationId: OperationId;
  readonly closeOperationId: OperationId;
  readonly now: string;
  readonly runLifecycle: (
    session: LiveBrowserSessionV1,
    signal: AbortSignal,
  ) => Promise<AccountLifecycleResult>;
}): AccountVerifiedLifecycleRunner {
  return Object.freeze({
    async run(signal: AbortSignal): Promise<AccountVerifiedLifecycleResult> {
      const opened = await options.browser.open(options.openRequest, signal);
      if (!opened.ok) return lifecycleFailure(opened.error.code);
      const session = opened.value.session;
      let result: AccountVerifiedLifecycleResult;
      try {
        const reconciled = await options.browser.reconcile({
          schemaVersion: 1,
          journeyId: options.openRequest.journeyId,
          operationId: options.reconcileOperationId,
          session,
          expectedTarget: options.openRequest.target,
        }, signal);
        if (!reconciled.ok) {
          result = lifecycleFailure(reconciled.error.code);
        } else if (reconciled.value.kind !== "matched") {
          result = factualLifecycleResult(reconciled.value);
        } else {
          const advanced = await options.browser.advanceToAccountEntry({
          schemaVersion: 1,
          journeyId: options.openRequest.journeyId,
          operationId: options.advanceOperationId,
          sessionId: session.sessionId,
          target: options.openRequest.target,
          now: options.now,
        }, signal);
          if (!advanced.ok) {
            result = lifecycleFailure(advanced.error.code);
          } else if (advanced.value.kind !== "account_boundary") {
            result = factualLifecycleResult(advanced.value);
          } else {
            const lifecycle = await options.runLifecycle(session, signal);
            result = lifecycle.ok
              ? { ok: true, cleanup: "pass", value: lifecycle.value }
              : lifecycleFailure(lifecycle.error.code);
          }
        }
      } catch {
        result = lifecycleFailure(
          signal.aborted ? "operation_cancelled" : "account_proof_invalid",
        );
      }
      try {
        const closed = await options.browser.close({
          schemaVersion: 1,
          journeyId: options.openRequest.journeyId,
          operationId: options.closeOperationId,
          sessionId: session.sessionId,
        }, new AbortController().signal);
        if (closed.ok) return result;
        if (!result.ok && closed.error.code === "browser_session_missing") {
          return result;
        }
        return lifecycleFailure("browser_profile_cleanup_failed");
      } catch {
        return lifecycleFailure("browser_profile_cleanup_failed");
      }
    },
  });
}

export async function runStage2AccountVerifiedFromOwnerConfig(
  options: Stage2AccountVerifiedProductionOptions,
  signal: AbortSignal,
): Promise<Stage2AccountVerifiedResult> {
  try {
    const executionerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const source = inspectCleanSourceRevision(executionerRoot);
    const configPath = admittedFile(options.configPath);
    const value = readOwnerConfig(configPath);
    const now = new Date().toISOString();
    const admission = createPrivateRealRunAdmission(value, {
      now,
      forbiddenRoots: [source.repositoryRoot],
      ownerConfigPath: configPath,
    });
    if (!admission.ok) return failure(admission.error.code);
    const owner = value as RealRunOwnerInputsV1;
    if (!inside(owner.roots.runtime.path, configPath) ||
        !samePath(owner.roots.evidence.path, options.evidenceRoot)) {
      return failure("owner_config_invalid");
    }
    const secretStore = new WindowsDpapiSecretStore({
      root: owner.roots.secrets.path,
      forbiddenRoots: [source.repositoryRoot],
      now: () => now,
    });
    const [accountInspection, gmailInspection] = await Promise.all([
      secretStore.inspect({
        schemaVersion: 1,
        journeyId: owner.journeyId as never,
        handleId: owner.accountSecret.handleId as SecretHandleId,
        expectedPurpose: "account_credentials",
        expectedConsumer: "credential_mutation_adapter",
      }, signal),
      secretStore.inspect({
        schemaVersion: 1,
        journeyId: owner.journeyId as never,
        handleId: owner.gmailAuthorization.handleId as SecretHandleId,
        expectedPurpose: "gmail_oauth",
        expectedConsumer: "gmail_auth_executor",
      }, signal),
    ]);
    if (!accountInspection.ok) return failure(accountInspection.error.code);
    if (!gmailInspection.ok) return failure(gmailInspection.error.code);
    if (!exactAccountMetadata(accountInspection.value, owner) ||
        !exactGmailMetadata(gmailInspection.value, owner)) {
      return failure("secret_handle_mismatched");
    }
    const account = accountInspection.value as ActiveAccountSecretHandle;
    const authorization = gmailInspection.value as ActiveGmailSecretHandle;
    const operations = operationIds();
    const bindings = createAccountVerifiedBindings(
      owner,
      source.sourceRevision,
      now,
      operations,
    );
    const valueFreeTrace = process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1"
      ? (event: string) => process.stderr.write(`${JSON.stringify({ trace: event })}\n`)
      : undefined;
    const browser = createPlaywrightPersistentBrowserSession({
      binding: admission.binding,
      accountTrace: valueFreeTrace,
    });
    const structural = createPlaywrightLiveEntryStructuralSource(browser);
    const classified = createClassifiedAccountObservationSource(
      createLiveEntryVerifier(structural),
    );
    const resolver = new WindowsDpapiSecretResolver({
      root: owner.roots.secrets.path,
      forbiddenRoots: [source.repositoryRoot],
      now: () => now,
    });
    const credentialMutation = createAccountEntryCredentialMutationAdapter({
      accountPage: browser,
      classifiedAccount: classified,
      credentials: resolver,
      trace: valueFreeTrace,
    });
    const rawVault = new GmailRawArtifactVault();
    const artifacts = new GmailSafeArtifactRegistry();
    const authExecutor = new GmailApiAuthExecutor({
      binding: bindings.gmail,
      resolver,
      httpClient: new GmailHttpClient(),
      rawVault,
      artifactRegistry: artifacts,
      approvedPolicy: approvedPolicy(owner),
      createHandle: () =>
        `verification_handle_${randomBytes(16).toString("hex")}` as VerificationHandleId,
      policyFactory: {
        create(candidateSource, admittedNow) {
          return createBoundedMailboxPolicy({
            binding: bindings.gmail,
            candidateSource,
            clock: () => admittedNow,
            timeoutMs: 60_000,
          });
        },
      },
    });
    const mailbox = new GmailMailboxProvider({
      authorization,
      binding: bindings.mailboxRequest,
      now: () => now,
      secretStore,
      authExecutor,
      artifacts: artifacts.port,
      timeoutMs: 60_000,
    });
    const consumer = new GmailAtomicArtifactConsumer({ rawVault, artifacts });
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
      now,
      runLifecycle: (session, lifecycleSignal) => {
        const lifecycle = new AccountVerificationLifecycle({
          credentialMutation,
          mailbox,
          artifacts: artifacts.port,
          navigator,
          accountState: createBoundAccountStateObserver(classified, {
            journeyId: bindings.lifecycle.journeyId,
            sessionId: session.sessionId,
            target: bindings.target,
          }),
        });
        return lifecycle.run({
          ...bindings.lifecycle,
          session,
          credential: account,
        }, lifecycleSignal);
      },
    });
    return await runStage2AccountVerified(bindings.runner, {
      lifecycle: cleanupBoundLifecycle,
      evidence: {
        write: async (acceptance) => writeAccountVerifiedEvidence({
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
      },
    }, signal);
  } catch {
    return failure(signal.aborted ? "operation_cancelled" : "owner_config_invalid");
  }
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

function inside(root: string, child: string): boolean {
  const path = relative(realpathSync.native(root), realpathSync.native(child));
  return path !== "" && path !== ".." &&
    !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(path);
}

function samePath(left: string, right: string): boolean {
  try {
    return comparable(realpathSync.native(left)) === comparable(realpathSync.native(right));
  } catch {
    return false;
  }
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
    navigateVerification: next(),
    postVerificationSignIn: next(),
    browserClose: next(),
    mailboxQuery: `mailbox_query_${randomBytes(16).toString("hex")}` as never,
  });
}

type TargetFact =
  | { readonly kind: "target_mismatch"; readonly dimension: "host" | "tenant" | "posting" }
  | { readonly kind: "target_ambiguous" }
  | { readonly kind: "posting_unavailable"; readonly reason: "not_found" | "closed" | "removed" | "unavailable" };

function factualLifecycleResult(
  value: TargetFact,
): AccountVerifiedLifecycleResult {
  return {
    ok: true,
    cleanup: "pass",
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

function lifecycleFailure(code: string): AccountVerifiedLifecycleResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function failure(code: string): Stage2AccountVerifiedResult {
  return Object.freeze({ ok: false, code });
}
