import { s2StableErrorPolicy } from "../../../contracts/s2-common-wire.ts";
import type { JourneyId, OperationId } from "../../../contracts/index.ts";
import type {
  ActiveGmailSecretHandle,
  GmailAuthErrorCode,
  LiveIdentifier,
  LivePortResult,
  MailboxPollRequest,
  MailboxPollResultV1,
  MailboxProvider,
  PrivilegedGmailAuthExecutor,
  PrivilegedGmailQueryRequest,
  RecipientBindingId,
  S2PortError,
  TargetIdentityV1,
  VerificationArtifact,
  VerificationHandleId,
} from "../../../contracts/live/index.ts";
import {
  GmailProviderFailure,
  type GmailProviderFailureCode,
} from "./http-parser.ts";
import { GmailHttpClient } from "./http-client.ts";
import {
  GmailImapClient,
  GmailImapFailure,
} from "./private/imap-client.ts";
import {
  parseSealedGmailBundle,
  SealedGmailAuthorizationFailure,
} from "./private/sealed-authorization.ts";
import { GmailRawArtifactVault } from "./private/raw-artifact-vault.ts";

type SenderPolicyId = LiveIdentifier<"sender_policy">;

interface GmailBinding {
  readonly journeyId: JourneyId;
  readonly recipientBindingId: RecipientBindingId;
  readonly senderPolicyId: SenderPolicyId;
  readonly target: TargetIdentityV1;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly verificationOperationId: OperationId;
}

interface GmailSafeCandidate {
  readonly provider: "gmail_api_v1";
  readonly journeyId: JourneyId;
  readonly recipientBindingId: RecipientBindingId;
  readonly senderPolicyId: SenderPolicyId;
  readonly target: TargetIdentityV1;
  readonly receivedAt: string;
  readonly expiresAt: string;
  readonly verificationHandle: VerificationHandleId;
  readonly state: "available" | "expired";
}

interface GmailCandidateSource {
  query(
    request: MailboxPollRequest & { readonly senderPolicyId: SenderPolicyId },
    signal: AbortSignal,
  ): Promise<
    LivePortResult<
      readonly GmailSafeCandidate[],
      GmailAuthErrorCode | "mailbox_query_invalid"
    >
  >;
}

interface GmailPolicyFactory {
  create(source: GmailCandidateSource, admittedNow: string): {
    readonly mailboxProvider: MailboxProvider;
    readonly verificationArtifact: VerificationArtifact;
  };
}

interface SafeArtifactAdmission {
  register(
    handleId: VerificationHandleId,
    delegate: VerificationArtifact,
    cleanup?: () => void,
  ): boolean;
  unregister(handleId: VerificationHandleId): void;
}

export type GmailApiAuthTraceEvent =
  | "gmail_auth_query_started"
  | "gmail_auth_secret_resolved"
  | "gmail_auth_policy_resolved"
  | "gmail_auth_bundle_admitted"
  | "gmail_auth_messages_none"
  | "gmail_auth_messages_one"
  | "gmail_auth_messages_multiple"
  | "gmail_auth_candidates_staged"
  | "gmail_auth_policy_failed"
  | "gmail_auth_policy_succeeded"
  | "gmail_auth_artifact_registration_failed"
  | "gmail_auth_artifact_registered"
  | "gmail_auth_artifact_commit_failed"
  | "gmail_auth_artifact_committed"
  | "gmail_auth_query_succeeded_without_handle"
  | "gmail_auth_query_succeeded_with_handle"
  | "gmail_auth_query_failed";

export interface GmailAuthorizationResolver {
  useGmailAuthorization(
    handle: ActiveGmailSecretHandle,
    signal: AbortSignal,
    operation: (
      authorization: Readonly<Uint8Array>,
    ) => Promise<MailboxPollResultV1>,
  ): Promise<LivePortResult<MailboxPollResultV1, GmailAuthErrorCode>>;
}

export interface GmailApprovedPolicyCapability {
  use(
    operation: (policy: {
      readonly host: Readonly<Uint8Array>;
      readonly tenant: Readonly<Uint8Array>;
    }) => Promise<MailboxPollResultV1>,
  ): Promise<MailboxPollResultV1>;
}

export interface GmailApiAuthExecutorOptions {
  readonly binding: GmailBinding;
  readonly resolver: GmailAuthorizationResolver;
  readonly httpClient: GmailHttpClient;
  readonly imapClient?: GmailImapClient;
  readonly rawVault: GmailRawArtifactVault;
  readonly artifactRegistry: SafeArtifactAdmission;
  readonly approvedPolicy: GmailApprovedPolicyCapability;
  readonly createHandle: () => VerificationHandleId;
  readonly policyFactory: GmailPolicyFactory;
  readonly trace?: (event: GmailApiAuthTraceEvent) => void;
}

export class GmailApiAuthExecutor implements PrivilegedGmailAuthExecutor {
  readonly #options: GmailApiAuthExecutorOptions;

  constructor(options: GmailApiAuthExecutorOptions) {
    this.#options = options;
  }

  async query(request: PrivilegedGmailQueryRequest, signal: AbortSignal) {
    if (signal.aborted) return cancelled();
    const admission = admitRequest(request, this.#options.binding);
    if (admission !== null) return failure(admission);
    this.#emit("gmail_auth_query_started");
    try {
      return await this.#options.resolver.useGmailAuthorization(
        request.authorization,
        signal,
        async (authorization) => {
          this.#emit("gmail_auth_secret_resolved");
          return this.#options.approvedPolicy.use(async (approvedPolicy) => {
            this.#emit("gmail_auth_policy_resolved");
            const authority = parseSealedGmailBundle(
              authorization,
              this.#options.binding,
              approvedPolicy,
            );
            this.#emit("gmail_auth_bundle_admitted");
            const messages = authority.kind === "imap"
              ? await (this.#options.imapClient ?? new GmailImapClient()).query(
                authority,
                { notBefore: request.notBefore, notAfter: request.notAfter },
                signal,
              )
              : await this.#options.httpClient.query(
                authority,
                { notBefore: request.notBefore, notAfter: request.notAfter },
                signal,
              );
            this.#emit(
              messages.length === 0
                ? "gmail_auth_messages_none"
                : messages.length === 1
                  ? "gmail_auth_messages_one"
                  : "gmail_auth_messages_multiple",
            );
            const candidates = messages.map((message) => {
              const verificationHandle = this.#options.createHandle();
              const expiresAt = new Date(
                Date.parse(message.receivedAt) +
                  authority.verificationTtlSeconds * 1_000,
              ).toISOString();
              const candidate: GmailSafeCandidate = {
                provider: "gmail_api_v1",
                journeyId: request.journeyId,
                recipientBindingId: request.recipientBindingId,
                senderPolicyId: this.#options.binding.senderPolicyId,
                target: request.target,
                receivedAt: message.receivedAt,
                expiresAt,
                verificationHandle,
                state: Date.parse(expiresAt) <= Date.parse(request.now)
                  ? "expired"
                  : "available",
              };
              return {
                candidate,
                target: message.verificationTarget,
                replayCoordinate: message.replayCoordinate,
              };
            });
            const pending = this.#options.rawVault.stage(
              candidates.map(({ candidate, target, replayCoordinate }) => ({
                metadata: {
                  schemaVersion: 1,
                  handleId: candidate.verificationHandle,
                  journeyId: candidate.journeyId,
                  provider: candidate.provider,
                  recipientBindingId: candidate.recipientBindingId,
                  target: candidate.target,
                  issuedAt: candidate.receivedAt,
                  expiresAt: candidate.expiresAt,
                  state: "available",
                },
                operationId: this.#options.binding.verificationOperationId,
                target,
                replayCoordinate,
                policy: {
                  host: Uint8Array.from(approvedPolicy.host),
                  tenant: Uint8Array.from(approvedPolicy.tenant),
                },
              })),
            );
            this.#emit("gmail_auth_candidates_staged");
            try {
              const source = oneShotSource(
                candidates.map(({ candidate }) => candidate),
                this.#options.binding,
              );
              const policy = this.#options.policyFactory.create(source, request.now);
              const safeResult = await policy.mailboxProvider.poll(request, signal);
              if (!safeResult.ok) {
                this.#emit("gmail_auth_policy_failed");
                throw new GmailProviderFailure(
                  safeResult.error.code === "operation_cancelled"
                    ? "operation_cancelled"
                    : "mailbox_query_invalid",
                );
              }
              this.#emit("gmail_auth_policy_succeeded");
              const handleId = safeResult.value.verificationHandle;
              if (handleId === null) {
                this.#emit("gmail_auth_query_succeeded_without_handle");
                return safeResult.value;
              }
              if (
                !this.#options.artifactRegistry.register(
                  handleId,
                  policy.verificationArtifact,
                  () => this.#options.rawVault.invalidate(handleId),
                )
              ) {
                this.#emit("gmail_auth_artifact_registration_failed");
                throw new GmailProviderFailure("mailbox_query_invalid");
              }
              this.#emit("gmail_auth_artifact_registered");
              if (!pending.commit(handleId)) {
                this.#options.artifactRegistry.unregister(handleId);
                this.#emit("gmail_auth_artifact_commit_failed");
                throw new GmailProviderFailure("mailbox_query_invalid");
              }
              this.#emit("gmail_auth_artifact_committed");
              this.#emit("gmail_auth_query_succeeded_with_handle");
              return safeResult.value;
            } finally {
              pending.discard();
            }
          });
        },
      );
    } catch (error) {
      this.#emit("gmail_auth_query_failed");
      return error instanceof GmailProviderFailure ||
          error instanceof GmailImapFailure ||
          error instanceof SealedGmailAuthorizationFailure
        ? failure(error.code)
        : failure("gmail_network_unavailable");
    }
  }

  #emit(event: GmailApiAuthTraceEvent): void {
    try {
      this.#options.trace?.(event);
    } catch {
      // Value-free diagnostics cannot alter mailbox behavior.
    }
  }
}

function oneShotSource(
  initial: readonly GmailSafeCandidate[],
  binding: GmailBinding,
): GmailCandidateSource {
  let candidates: readonly GmailSafeCandidate[] | null = initial;
  return {
    async query(request, signal) {
      if (signal.aborted) return cancelled();
      const current = candidates;
      candidates = null;
      return current === null || !validSourceRequest(request, binding)
        ? failure("mailbox_query_invalid")
        : { ok: true, value: current };
    },
  };
}

function validSourceRequest(
  request: MailboxPollRequest & { readonly senderPolicyId: SenderPolicyId },
  binding: GmailBinding,
): boolean {
  return request.schemaVersion === 1 &&
    request.journeyId === binding.journeyId &&
    request.recipientBindingId === binding.recipientBindingId &&
    request.senderPolicyId === binding.senderPolicyId &&
    sameTarget(request.target, binding.target) &&
    request.notBefore === binding.notBefore &&
    request.notAfter === binding.notAfter;
}

function admitRequest(
  request: PrivilegedGmailQueryRequest,
  binding: GmailBinding,
): GmailAuthErrorCode | null {
  const now = Date.parse(request.now);
  if (request.authorization.state !== "active") {
    return "secret_handle_invalid";
  }
  if (
    request.authorization.provider !== "windows_dpapi_current_user_v1" ||
    request.authorization.purpose !== "gmail_oauth" ||
    request.authorization.consumer !== "gmail_auth_executor" ||
    request.authorization.journeyId !== request.journeyId
  ) {
    return request.authorization.consumer !== "gmail_auth_executor"
      ? "secret_consumer_forbidden"
      : "secret_handle_mismatched";
  }
  if (
    !Number.isFinite(now) ||
    new Date(now).toISOString() !== request.now
  ) {
    return "mailbox_query_invalid";
  }
  if (
    !Number.isFinite(Date.parse(request.authorization.expiresAt)) ||
    Date.parse(request.authorization.expiresAt) <= now
  ) {
    return "secret_handle_expired";
  }
  return request.schemaVersion !== 1 ||
      request.journeyId !== binding.journeyId ||
      request.recipientBindingId !== binding.recipientBindingId ||
      !sameTarget(request.target, binding.target) ||
      request.notBefore !== binding.notBefore ||
      request.notAfter !== binding.notAfter
    ? "mailbox_query_invalid"
    : null;
}

function sameTarget(value: unknown, expected: TargetIdentityV1): boolean {
  return record(value) &&
    value.schemaVersion === expected.schemaVersion &&
    value.atsFamily === expected.atsFamily &&
    value.hostId === expected.hostId &&
    value.tenantId === expected.tenantId &&
    value.postingId === expected.postingId;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cancelled() {
  return {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  } as const;
}

function failure<const Code extends GmailProviderFailureCode | GmailAuthErrorCode>(
  code: Code,
) {
  return {
    ok: false,
    error: {
      code,
      retryable: code === "operation_cancelled"
        ? false
        : s2StableErrorPolicy[code].retryable,
    } as S2PortError<Code>,
  } as const;
}
