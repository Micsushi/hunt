import { useEphemeralByteBatch } from "../../../../contracts/live/private/privileged-capabilities.ts";
import type {
  AvailableVerificationArtifact,
  LivePortResult,
  RecipientBindingId,
  TargetIdentityV1,
  VerificationArtifactInspectRequest,
  VerificationHandleId,
  VerificationNavigationResult,
} from "../../../../contracts/live/index.ts";
import type { JourneyId, OperationId } from "../../../../contracts/index.ts";
import { GmailRawArtifactVault } from "./raw-artifact-vault.ts";

export interface AtomicArtifactConsumeRequest {
  readonly operationId: OperationId;
  readonly journeyId: JourneyId;
  readonly recipientBindingId: RecipientBindingId;
  readonly target: TargetIdentityV1;
  readonly handleId: VerificationHandleId;
  readonly now: string;
  readonly artifact: AvailableVerificationArtifact;
}

interface AtomicSafeArtifactStore {
  takeForAtomicConsume(
    request: VerificationArtifactInspectRequest,
    signal: AbortSignal,
  ): Promise<AvailableVerificationArtifact | null>;
  discard(handleId: VerificationHandleId): void;
}

interface GmailAtomicArtifactConsumerOptions {
  readonly rawVault: GmailRawArtifactVault;
  readonly artifacts: AtomicSafeArtifactStore;
}

type ConsumeResult = LivePortResult<
  VerificationNavigationResult,
  "verification_artifact_replayed"
>;

export class GmailAtomicArtifactConsumer {
  readonly #rawVault: GmailRawArtifactVault;
  readonly #artifacts: AtomicSafeArtifactStore;
  readonly #receipts = new Map<
    OperationId,
    { readonly fingerprint: string; readonly result: VerificationNavigationResult }
  >();

  constructor(options: GmailAtomicArtifactConsumerOptions) {
    this.#rawVault = options.rawVault;
    this.#artifacts = options.artifacts;
  }

  async consume<Result extends VerificationNavigationResult>(
    request: AtomicArtifactConsumeRequest,
    signal: AbortSignal,
    operation: (values: readonly Readonly<Uint8Array>[]) => Promise<Result>,
  ): Promise<ConsumeResult> {
    const fingerprint = requestFingerprint(request);
    const replay = this.#receipts.get(request.operationId);
    if (replay !== undefined) {
      if (replay.fingerprint === fingerprint) {
        return { ok: true, value: replay.result };
      }
      this.#clearRequest(request);
      return replayed();
    }
    if (!validRequest(request)) {
      this.#clearRequest(request);
      return replayed();
    }
    const artifact = await this.#artifacts.takeForAtomicConsume(
      {
        schemaVersion: 1,
        journeyId: request.journeyId,
        handleId: request.handleId,
        expectedRecipientBindingId: request.recipientBindingId,
        expectedTarget: request.target,
      },
      signal,
    );
    if (artifact === null) {
      this.#clearRequest(request);
      return replayed();
    }
    const values = this.#rawVault.takeForAtomicConsume(
      request.operationId,
      artifact,
      request.now,
    );
    if (values === null) return replayed();
    try {
      const result = await useEphemeralByteBatch(values, operation);
      this.#receipts.set(request.operationId, { fingerprint, result });
      return { ok: true, value: result };
    } catch {
      for (const value of values) value.fill(0);
      return replayed();
    }
  }

  #clearRequest(request: AtomicArtifactConsumeRequest): void {
    this.#artifacts.discard(request.handleId);
    this.#artifacts.discard(request.artifact.handleId);
    this.#rawVault.invalidate(request.handleId);
    this.#rawVault.invalidate(request.artifact.handleId);
  }
}

function validRequest(request: AtomicArtifactConsumeRequest): boolean {
  return request.handleId === request.artifact.handleId &&
    request.journeyId === request.artifact.journeyId &&
    request.recipientBindingId === request.artifact.recipientBindingId &&
    sameTarget(request.target, request.artifact.target) &&
    request.artifact.state === "available" &&
    validInstant(request.now) &&
    Date.parse(request.artifact.expiresAt) > Date.parse(request.now);
}

function requestFingerprint(request: AtomicArtifactConsumeRequest): string {
  return JSON.stringify([
    request.operationId,
    request.journeyId,
    request.recipientBindingId,
    request.target.schemaVersion,
    request.target.atsFamily,
    request.target.hostId,
    request.target.tenantId,
    request.target.postingId,
    request.handleId,
    request.now,
    request.artifact.issuedAt,
    request.artifact.expiresAt,
    request.artifact.state,
  ]);
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

function replayed() {
  return {
    ok: false,
    error: { code: "verification_artifact_replayed", retryable: false },
  } as const;
}
