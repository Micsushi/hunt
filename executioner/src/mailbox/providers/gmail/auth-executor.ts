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
  readonly rawVault: GmailRawArtifactVault;
  readonly artifactRegistry: SafeArtifactAdmission;
  readonly approvedPolicy: GmailApprovedPolicyCapability;
  readonly createHandle: () => VerificationHandleId;
  readonly policyFactory: GmailPolicyFactory;
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
    try {
      return await this.#options.resolver.useGmailAuthorization(
        request.authorization,
        signal,
        async (authorization) => {
          return this.#options.approvedPolicy.use(async (approvedPolicy) => {
            const authority = parseSealedBundle(
              authorization,
              this.#options.binding,
              approvedPolicy,
            );
            const messages = await this.#options.httpClient.query(
              authority,
              { notBefore: request.notBefore, notAfter: request.notAfter },
              signal,
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
              return { candidate, target: message.verificationTarget };
            });
            const pending = this.#options.rawVault.stage(
              candidates.map(({ candidate, target }) => ({
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
                policy: {
                  host: Uint8Array.from(approvedPolicy.host),
                  tenant: Uint8Array.from(approvedPolicy.tenant),
                },
              })),
            );
            try {
              const source = oneShotSource(
                candidates.map(({ candidate }) => candidate),
                this.#options.binding,
              );
              const policy = this.#options.policyFactory.create(source, request.now);
              const safeResult = await policy.mailboxProvider.poll(request, signal);
              if (!safeResult.ok) {
                throw new GmailProviderFailure(
                  safeResult.error.code === "operation_cancelled"
                    ? "operation_cancelled"
                    : "mailbox_query_invalid",
                );
              }
              const handleId = safeResult.value.verificationHandle;
              if (handleId === null) return safeResult.value;
              if (
                !this.#options.artifactRegistry.register(
                  handleId,
                  policy.verificationArtifact,
                  () => this.#options.rawVault.invalidate(handleId),
                )
              ) {
                throw new GmailProviderFailure("mailbox_query_invalid");
              }
              if (!pending.commit(handleId)) {
                this.#options.artifactRegistry.unregister(handleId);
                throw new GmailProviderFailure("mailbox_query_invalid");
              }
              return safeResult.value;
            } finally {
              pending.discard();
            }
          });
        },
      );
    } catch (error) {
      return error instanceof GmailProviderFailure
        ? failure(error.code)
        : failure("gmail_network_unavailable");
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

interface SealedGmailBundle {
  readonly accessValue: string;
  readonly senderAddress: string;
  readonly recipientAddress: string;
  readonly verificationHost: string;
  readonly verificationTtlSeconds: number;
}

function parseSealedBundle(
  bytes: Readonly<Uint8Array>,
  binding: GmailBinding,
  approvedPolicy: {
    readonly host: Readonly<Uint8Array>;
    readonly tenant: Readonly<Uint8Array>;
  },
): SealedGmailBundle {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new GmailProviderFailure("gmail_auth_denied");
  }
  if (!record(value)) throw new GmailProviderFailure("gmail_auth_denied");
  const exactKeys = [
    "accessValue",
    "format",
    "journeyId",
    "recipientAddress",
    "recipientBindingId",
    "scope",
    "senderAddress",
    "senderPolicyId",
    "target",
    "verificationHost",
    "verificationTenant",
    "verificationTtlSeconds",
  ];
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(exactKeys) ||
    value.format !== "gmail-oauth-bundle-v1" ||
    value.scope !== "https://www.googleapis.com/auth/gmail.readonly" ||
    typeof value.accessValue !== "string" ||
    value.accessValue.length < 1 ||
    value.accessValue.length > 4_096 ||
    typeof value.recipientAddress !== "string" ||
    !email(value.recipientAddress) ||
    typeof value.senderAddress !== "string" ||
    !email(value.senderAddress) ||
    typeof value.verificationHost !== "string" ||
    !host(value.verificationHost) ||
    typeof value.verificationTenant !== "string" ||
    !tenant(value.verificationTenant) ||
    !Number.isSafeInteger(value.verificationTtlSeconds) ||
    Number(value.verificationTtlSeconds) < 60 ||
    Number(value.verificationTtlSeconds) > 86_400
  ) {
    throw new GmailProviderFailure("gmail_auth_denied");
  }
  if (
    value.journeyId !== binding.journeyId ||
    value.recipientBindingId !== binding.recipientBindingId ||
    value.senderPolicyId !== binding.senderPolicyId ||
    !sameTarget(value.target, binding.target)
  ) {
    throw new GmailProviderFailure("mailbox_query_invalid");
  }
  let approvedHost: string;
  let approvedTenant: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    approvedHost = decoder.decode(approvedPolicy.host);
    approvedTenant = decoder.decode(approvedPolicy.tenant);
  } catch {
    throw new GmailProviderFailure("mailbox_query_invalid");
  }
  if (
    !host(approvedHost) ||
    !tenant(approvedTenant) ||
    value.verificationHost !== approvedHost ||
    value.verificationTenant !== approvedTenant
  ) {
    throw new GmailProviderFailure("mailbox_query_invalid");
  }
  return {
    accessValue: value.accessValue,
    recipientAddress: value.recipientAddress,
    senderAddress: value.senderAddress,
    verificationHost: value.verificationHost,
    verificationTtlSeconds: Number(value.verificationTtlSeconds),
  };
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

function email(value: string): boolean {
  return value === value.toLowerCase() &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+$/u.test(value);
}

function host(value: string): boolean {
  return value === value.toLowerCase() &&
    value.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}

function tenant(value: string): boolean {
  return value === value.toLowerCase() &&
    value.length >= 1 &&
    value.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(value);
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
