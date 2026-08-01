import { s2StableErrorPolicy } from "../contracts/s2-common-wire.ts";
import type { JourneyId } from "../contracts/types.ts";
import type {
  GmailAuthErrorCode,
  LiveIdentifier,
  LivePortResult,
  MailboxPollRequest,
  MailboxPollResultV1,
  MailboxProvider,
  MailboxProviderErrorCode,
  RecipientBindingId,
  S2PortError,
  TargetIdentityV1,
  VerificationArtifact,
  VerificationArtifactMetadataV1,
  VerificationHandleId,
} from "../contracts/live/index.ts";

export type SenderPolicyId = LiveIdentifier<"sender_policy">;

export type BoundedMailboxCandidateState =
  | "available"
  | "expired"
  | "consumed"
  | "invalidated";

export interface BoundedMailboxCandidate {
  readonly provider: "gmail_api_v1";
  readonly journeyId: JourneyId;
  readonly recipientBindingId: RecipientBindingId;
  readonly senderPolicyId: SenderPolicyId;
  readonly target: TargetIdentityV1;
  readonly receivedAt: string;
  readonly expiresAt: string;
  readonly verificationHandle: VerificationHandleId;
  readonly state: BoundedMailboxCandidateState;
}

export interface BoundedMailboxBinding {
  readonly journeyId: JourneyId;
  readonly recipientBindingId: RecipientBindingId;
  readonly senderPolicyId: SenderPolicyId;
  readonly target: TargetIdentityV1;
  readonly notBefore: string;
  readonly notAfter: string;
}

export interface BoundedMailboxSourceRequest extends MailboxPollRequest {
  readonly senderPolicyId: SenderPolicyId;
}

type MailboxPolicyErrorCode = MailboxProviderErrorCode | GmailAuthErrorCode;

const maximumTimeoutMs = 60_000;
const sourceErrorCodes = new Set<string>([
  "gmail_auth_denied",
  "gmail_rate_limited",
  "gmail_network_unavailable",
  "mailbox_query_invalid",
  "mailbox_timeout",
  "verification_artifact_replayed",
  "secret_handle_invalid",
  "secret_handle_expired",
  "secret_handle_mismatched",
  "secret_consumer_forbidden",
  "secret_store_unavailable",
]);

export interface BoundedMailboxCandidateSource {
  query(
    request: BoundedMailboxSourceRequest,
    signal: AbortSignal,
  ): Promise<
    LivePortResult<readonly BoundedMailboxCandidate[], MailboxPolicyErrorCode>
  >;
}

export interface BoundedMailboxPolicyOptions {
  readonly binding: BoundedMailboxBinding;
  readonly candidateSource: BoundedMailboxCandidateSource;
  readonly clock: () => string;
  readonly timeoutMs: number;
}

export interface BoundedMailboxPolicy {
  readonly mailboxProvider: MailboxProvider;
  readonly verificationArtifact: VerificationArtifact;
}

export function createBoundedMailboxPolicy(
  options: BoundedMailboxPolicyOptions,
): BoundedMailboxPolicy {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > maximumTimeoutMs ||
    !/^sender_policy_[A-Za-z0-9_-]{16,64}$/u.test(
      options.binding.senderPolicyId,
    ) ||
    !validInstant(options.binding.notBefore) ||
    !validInstant(options.binding.notAfter) ||
    Date.parse(options.binding.notBefore) >= Date.parse(options.binding.notAfter)
  ) {
    throw new TypeError("invalid mailbox policy configuration");
  }
  const queries = new Map<
    string,
    { readonly fingerprint: string; readonly value: MailboxPollResultV1 }
  >();
  const artifacts = new Map<string, VerificationArtifactMetadataV1>();
  return {
    mailboxProvider: {
      async poll(request, signal) {
        if (signal.aborted) return cancelled();
        if (!validRequest(request, options.binding)) {
          return error("mailbox_query_invalid");
        }
        const currentTime = readClock(options.clock);
        if (currentTime === null) {
          return error("mailbox_query_invalid");
        }
        const fingerprint = queryFingerprint(request);
        const replay = queries.get(request.queryId);
        if (replay !== undefined) {
          return replay.fingerprint === fingerprint
            ? ok(withCurrentArtifactState(replay.value, artifacts, currentTime))
            : error("mailbox_query_invalid");
        }
        const sourceResult = await runBoundedQuery(
          options.candidateSource,
          { ...request, senderPolicyId: options.binding.senderPolicyId },
          signal,
          options.timeoutMs,
        );
        if (!sourceResult.ok) return sanitizeSourceFailure(sourceResult.error);
        if (
          sourceResult.value.some(
            (candidate) =>
              !validCandidate(candidate, options.binding, currentTime),
          )
        ) {
          return error("mailbox_query_invalid");
        }
        if (sourceResult.value.length === 0) {
          const value: MailboxPollResultV1 = {
            provider: "gmail_api_v1",
            receivedTimeBucket: null,
            expiresAt: null,
            candidateCount: 0,
            verificationHandle: null,
          };
          queries.set(request.queryId, { fingerprint, value });
          return ok(value);
        }
        const candidate = [...sourceResult.value].sort(
          (left, right) =>
            Date.parse(right.receivedAt) - Date.parse(left.receivedAt),
        )[0]!;
        if (
          sourceResult.value.length === 1 &&
          !registerCandidate(candidate, artifacts)
        ) {
          return error("mailbox_query_invalid");
        }
        const isOnlyAvailable =
          sourceResult.value.length === 1 &&
          candidate.state === "available" &&
          Date.parse(candidate.expiresAt) > Date.parse(currentTime);
        const value: MailboxPollResultV1 = {
          provider: "gmail_api_v1",
          receivedTimeBucket: minuteBucket(candidate.receivedAt),
          expiresAt: candidate.expiresAt,
          candidateCount: sourceResult.value.length,
          verificationHandle: isOnlyAvailable
            ? candidate.verificationHandle
            : null,
        };
        queries.set(request.queryId, { fingerprint, value });
        return ok(value);
      },
    },
    verificationArtifact: {
      async inspect(request, signal) {
        if (signal.aborted) return cancelled();
        const metadata = artifacts.get(request.handleId);
        if (
          metadata === undefined ||
          request.schemaVersion !== 1 ||
          request.journeyId !== metadata.journeyId ||
          request.expectedRecipientBindingId !== metadata.recipientBindingId
        ) {
          return error("verification_artifact_replayed");
        }
        if (!sameTarget(request.expectedTarget, metadata.target)) {
          return error("mailbox_query_invalid");
        }
        const now = readClock(options.clock);
        if (now === null) return error("mailbox_query_invalid");
        const current = currentMetadata(metadata, now);
        artifacts.set(request.handleId, current);
        return ok(current);
      },
      async invalidate(request, signal) {
        if (signal.aborted) return cancelled();
        const metadata = artifacts.get(request.handleId);
        if (
          metadata === undefined ||
          request.schemaVersion !== 1 ||
          request.journeyId !== metadata.journeyId
        ) {
          return error("verification_artifact_replayed");
        }
        const now = readClock(options.clock);
        if (now === null) return error("mailbox_query_invalid");
        const current = currentMetadata(metadata, now);
        if (current.state !== "available") {
          artifacts.set(request.handleId, current);
          return error("verification_artifact_replayed");
        }
        artifacts.set(request.handleId, { ...current, state: "invalidated" });
        return ok(undefined);
      },
    },
  };
}

function readClock(clock: () => string): string | null {
  try {
    const value = clock();
    return validInstant(value) ? value : null;
  } catch {
    return null;
  }
}

function sanitizeSourceFailure(value: unknown) {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    return error("mailbox_query_invalid");
  }
  const code = value.code;
  if (code === "operation_cancelled") return cancelled();
  return typeof code === "string" && sourceErrorCodes.has(code)
    ? error(code as MailboxPolicyErrorCode)
    : error("mailbox_query_invalid");
}

function runBoundedQuery(
  source: BoundedMailboxCandidateSource,
  request: BoundedMailboxSourceRequest,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<
  LivePortResult<readonly BoundedMailboxCandidate[], MailboxPolicyErrorCode>
> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      result: LivePortResult<
        readonly BoundedMailboxCandidate[],
        MailboxPolicyErrorCode
      >,
    ) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      resolve(result);
    };
    const cancel = () => {
      controller.abort();
      finish(cancelled());
    };
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      finish(error("mailbox_timeout"));
    }, timeoutMs);
    try {
      void source.query(request, controller.signal).then(
        finish,
        () => finish(error("gmail_network_unavailable")),
      );
    } catch {
      finish(error("gmail_network_unavailable"));
    }
  });
}

function registerCandidate(
  candidate: BoundedMailboxCandidate,
  artifacts: Map<string, VerificationArtifactMetadataV1>,
): boolean {
  const metadata: VerificationArtifactMetadataV1 = {
    schemaVersion: 1,
    handleId: candidate.verificationHandle,
    journeyId: candidate.journeyId,
    provider: candidate.provider,
    recipientBindingId: candidate.recipientBindingId,
    target: candidate.target,
    issuedAt: candidate.receivedAt,
    expiresAt: candidate.expiresAt,
    state: candidate.state,
  };
  const existing = artifacts.get(candidate.verificationHandle);
  if (existing !== undefined && !sameArtifactMetadata(existing, metadata)) {
    return false;
  }
  artifacts.set(candidate.verificationHandle, metadata);
  return true;
}

function sameArtifactMetadata(
  left: VerificationArtifactMetadataV1,
  right: VerificationArtifactMetadataV1,
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.handleId === right.handleId &&
    left.journeyId === right.journeyId &&
    left.provider === right.provider &&
    left.recipientBindingId === right.recipientBindingId &&
    sameTarget(left.target, right.target) &&
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt &&
    left.state === right.state;
}

function withCurrentArtifactState(
  value: MailboxPollResultV1,
  artifacts: Map<string, VerificationArtifactMetadataV1>,
  now: string,
): MailboxPollResultV1 {
  if (value.verificationHandle === null) return value;
  const metadata = artifacts.get(value.verificationHandle);
  if (metadata === undefined) return { ...value, verificationHandle: null };
  const current = currentMetadata(metadata, now);
  artifacts.set(value.verificationHandle, current);
  return current.state === "available"
    ? value
    : { ...value, verificationHandle: null };
}

function currentMetadata(
  metadata: VerificationArtifactMetadataV1,
  now: string,
): VerificationArtifactMetadataV1 {
  return metadata.state === "available" &&
    Date.parse(metadata.expiresAt) <= Date.parse(now)
    ? { ...metadata, state: "expired" }
    : metadata;
}

function queryFingerprint(request: MailboxPollRequest): string {
  return JSON.stringify([
    request.schemaVersion,
    request.journeyId,
    request.queryId,
    request.recipientBindingId,
    request.target.schemaVersion,
    request.target.atsFamily,
    request.target.hostId,
    request.target.tenantId,
    request.target.postingId,
    request.notBefore,
    request.notAfter,
  ]);
}

function validRequest(
  request: MailboxPollRequest,
  binding: BoundedMailboxBinding,
): boolean {
  return request.schemaVersion === 1 &&
    request.journeyId === binding.journeyId &&
    request.recipientBindingId === binding.recipientBindingId &&
    sameTarget(request.target, binding.target) &&
    request.notBefore === binding.notBefore &&
    request.notAfter === binding.notAfter &&
    validInstant(request.notBefore) &&
    validInstant(request.notAfter) &&
    Date.parse(request.notBefore) <= Date.parse(request.notAfter);
}

function validCandidate(
  candidate: BoundedMailboxCandidate,
  binding: BoundedMailboxBinding,
  now: string,
): boolean {
  const receivedAt = Date.parse(candidate.receivedAt);
  const expiresAt = Date.parse(candidate.expiresAt);
  return candidate.provider === "gmail_api_v1" &&
    candidate.journeyId === binding.journeyId &&
    candidate.recipientBindingId === binding.recipientBindingId &&
    candidate.senderPolicyId === binding.senderPolicyId &&
    sameTarget(candidate.target, binding.target) &&
    validInstant(candidate.receivedAt) &&
    validInstant(candidate.expiresAt) &&
    receivedAt >= Date.parse(binding.notBefore) &&
    receivedAt <= Date.parse(binding.notAfter) &&
    expiresAt > receivedAt &&
    (candidate.state !== "expired" || expiresAt <= Date.parse(now));
}

function sameTarget(
  left: TargetIdentityV1,
  right: TargetIdentityV1,
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.atsFamily === right.atsFamily &&
    left.hostId === right.hostId &&
    left.tenantId === right.tenantId &&
    left.postingId === right.postingId;
}

function validInstant(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value;
}

function minuteBucket(value: string): string {
  return `${value.slice(0, 16)}Z`;
}

function ok<const T>(value: T) {
  return { ok: true, value } as const;
}

function cancelled() {
  return {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  } as const;
}

function error<const C extends MailboxPolicyErrorCode>(code: C) {
  return {
    ok: false,
    error: {
      code,
      retryable: s2StableErrorPolicy[code].retryable,
    } as S2PortError<C>,
  } as const;
}
