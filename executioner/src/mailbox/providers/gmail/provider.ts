import { s2StableErrorPolicy } from "../../../contracts/s2-common-wire.ts";
import type {
  ActiveGmailSecretHandle,
  GmailAuthErrorCode,
  LivePortResult,
  MailboxPollRequest,
  MailboxPollResultV1,
  MailboxProvider,
  MailboxProviderErrorCode,
  PrivilegedGmailAuthExecutor,
  SecretHandleMetadataV1,
  SecretStore,
  S2PortError,
  TargetIdentityV1,
  VerificationArtifact,
} from "../../../contracts/live/index.ts";

interface GmailMailboxProviderOptions {
  readonly authorization: ActiveGmailSecretHandle;
  readonly binding: MailboxPollRequest;
  readonly now: () => string;
  readonly secretStore: SecretStore;
  readonly authExecutor: PrivilegedGmailAuthExecutor;
  readonly artifacts: VerificationArtifact;
  readonly timeoutMs?: number;
}

type GmailProviderError = GmailAuthErrorCode | MailboxProviderErrorCode;

export class GmailMailboxProvider implements MailboxProvider {
  readonly #authorization: ActiveGmailSecretHandle;
  readonly #binding: MailboxPollRequest;
  readonly #now: () => string;
  readonly #secretStore: SecretStore;
  readonly #authExecutor: PrivilegedGmailAuthExecutor;
  readonly #artifacts: VerificationArtifact;
  readonly #timeoutMs: number;
  readonly #queries = new Map<
    string,
    { readonly fingerprint: string; readonly result: MailboxPollResultV1 }
  >();

  constructor(options: GmailMailboxProviderOptions) {
    this.#authorization = options.authorization;
    this.#binding = options.binding;
    this.#now = options.now;
    this.#secretStore = options.secretStore;
    this.#authExecutor = options.authExecutor;
    this.#artifacts = options.artifacts;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > 60_000
    ) {
      throw new TypeError("invalid Gmail provider timeout");
    }
  }

  poll(request: MailboxPollRequest, signal: AbortSignal) {
    if (signal.aborted) return Promise.resolve(cancelled());
    return runBoundedPoll(
      (boundedSignal) => this.#poll(request, boundedSignal),
      signal,
      this.#timeoutMs,
    );
  }

  async #poll(request: MailboxPollRequest, signal: AbortSignal) {
    if (!validRequest(request, this.#binding)) {
      return failure("mailbox_query_invalid");
    }
    const fingerprint = requestFingerprint(request);
    const replay = this.#queries.get(request.queryId);
    if (replay !== undefined && replay.fingerprint !== fingerprint) {
      return failure("mailbox_query_invalid");
    }
    const now = readClock(this.#now);
    if (now === null) return failure("mailbox_query_invalid");
    const inspected = await this.#secretStore.inspect(
      {
        schemaVersion: 1,
        journeyId: request.journeyId,
        handleId: this.#authorization.handleId,
        expectedPurpose: "gmail_oauth",
        expectedConsumer: "gmail_auth_executor",
      },
      signal,
    );
    if (!inspected.ok) return inspected;
    if (!sameMetadata(inspected.value, this.#authorization)) {
      return failure("secret_handle_mismatched");
    }
    if (replay !== undefined) {
      const handleId = replay.result.verificationHandle;
      if (handleId === null) return { ok: true, value: replay.result } as const;
      const artifact = await this.#artifacts.inspect(
        {
          schemaVersion: 1,
          journeyId: request.journeyId,
          handleId,
          expectedRecipientBindingId: request.recipientBindingId,
          expectedTarget: request.target,
        },
        signal,
      );
      if (!artifact.ok) return artifact;
      return {
        ok: true,
        value: artifact.value.state === "available"
          ? replay.result
          : { ...replay.result, verificationHandle: null },
      } as const;
    }

    const result = await this.#authExecutor.query(
      { ...request, now, authorization: this.#authorization },
      signal,
    );
    if (!result.ok) return result;
    this.#queries.set(request.queryId, { fingerprint, result: result.value });
    return result;
  }
}

function runBoundedPoll(
  operation: (
    signal: AbortSignal,
  ) => Promise<LivePortResult<MailboxPollResultV1, GmailProviderError>>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<LivePortResult<MailboxPollResultV1, GmailProviderError>> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (
      result: LivePortResult<MailboxPollResultV1, GmailProviderError>,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      resolve(result);
    };
    const cancel = () => {
      controller.abort();
      finish(cancelled());
    };
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      controller.abort();
      finish(failure("mailbox_timeout"));
    }, timeoutMs);
    void operation(controller.signal).then(
      finish,
      () => finish(failure("gmail_network_unavailable")),
    );
  });
}

function readClock(clock: () => string): string | null {
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

function validRequest(
  request: MailboxPollRequest,
  binding: MailboxPollRequest,
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

function requestFingerprint(request: MailboxPollRequest): string {
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

function sameMetadata(
  left: SecretHandleMetadataV1,
  right: SecretHandleMetadataV1,
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.handleId === right.handleId &&
    left.journeyId === right.journeyId &&
    left.provider === right.provider &&
    left.purpose === right.purpose &&
    left.consumer === right.consumer &&
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt &&
    left.state === right.state;
}

function sameTarget(left: TargetIdentityV1, right: TargetIdentityV1): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.atsFamily === right.atsFamily &&
    left.hostId === right.hostId &&
    left.tenantId === right.tenantId &&
    left.postingId === right.postingId;
}

function validInstant(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function cancelled() {
  return {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  } as const;
}

function failure<const Code extends GmailProviderError>(code: Code) {
  return {
    ok: false,
    error: {
      code,
      retryable: s2StableErrorPolicy[code].retryable,
    } as S2PortError<Code>,
  } as const;
}
