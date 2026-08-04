import type {
  AvailableVerificationArtifact,
  LivePortResult,
  RecipientBindingId,
  TargetIdentityV1,
  VerificationArtifactInspectRequest,
  VerificationHandleId,
  VerificationNavigationErrorCode,
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
  readonly replayGuard: DurableVerificationReplayGuard;
}

export interface DurableVerificationReplayGuard {
  claim(
    coordinate: Readonly<Uint8Array>,
    signal: AbortSignal,
  ): Promise<"claimed" | "replayed">;
}

type DownstreamNavigationErrorCode = Exclude<
  VerificationNavigationErrorCode,
  "verification_artifact_replayed" | "recovery_checkpoint_unavailable"
>;

type ConsumeResult<Code extends DownstreamNavigationErrorCode> = LivePortResult<
  VerificationNavigationResult,
  Code | "verification_artifact_replayed" | "recovery_checkpoint_unavailable"
>;

export class GmailAtomicArtifactConsumer {
  readonly #rawVault: GmailRawArtifactVault;
  readonly #artifacts: AtomicSafeArtifactStore;
  readonly #replayGuard: DurableVerificationReplayGuard;
  readonly #receipts = new Map<
    OperationId,
    { readonly fingerprint: string; readonly result: VerificationNavigationResult }
  >();

  constructor(options: GmailAtomicArtifactConsumerOptions) {
    this.#rawVault = options.rawVault;
    this.#artifacts = options.artifacts;
    this.#replayGuard = options.replayGuard;
  }

  async consume<
    Result extends VerificationNavigationResult,
    Code extends DownstreamNavigationErrorCode,
  >(
    request: AtomicArtifactConsumeRequest,
    signal: AbortSignal,
    operation: (
      values: readonly Readonly<Uint8Array>[],
    ) => Promise<LivePortResult<Result, Code>>,
  ): Promise<ConsumeResult<Code>> {
    const fingerprint = requestFingerprint(request);
    const replay = this.#receipts.get(request.operationId);
    if (replay !== undefined) {
      if (replay.fingerprint === fingerprint) {
        return { ok: true, value: replay.result };
      }
      this.#clearRequest(request);
      return replayed();
    }
    if (signal.aborted) {
      this.#clearRequest(request);
      return cancelled();
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
    const raw = this.#rawVault.takeForAtomicConsume(
      request.operationId,
      artifact,
      request.now,
    );
    if (raw === null) return replayed();
    const { values, replayCoordinate } = raw;
    try {
      let claim: "claimed" | "replayed";
      try {
        claim = await this.#replayGuard.claim(replayCoordinate, signal);
      } catch {
        return checkpointUnavailable();
      }
      if (claim !== "claimed") return replayed();
      const result = await operation(values);
      if (!result.ok) return result;
      const safeResult = exactResult(result.value);
      this.#receipts.set(request.operationId, { fingerprint, result: safeResult });
      return { ok: true, value: safeResult };
    } catch {
      return replayed();
    } finally {
      for (const value of values) value.fill(0);
      replayCoordinate.fill(0);
    }
  }

  #clearRequest(request: AtomicArtifactConsumeRequest): void {
    this.#artifacts.discard(request.handleId);
    this.#artifacts.discard(request.artifact.handleId);
    this.#rawVault.invalidate(request.handleId);
    this.#rawVault.invalidate(request.artifact.handleId);
  }
}

function exactResult(value: VerificationNavigationResult): VerificationNavigationResult {
  if (value.kind === "navigated") return { kind: "navigated" };
  if (value.kind === "target_unavailable") return { kind: "target_unavailable" };
  throw new TypeError("invalid verification navigation result");
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

function cancelled() {
  return {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  } as const;
}

function checkpointUnavailable() {
  return {
    ok: false,
    error: { code: "recovery_checkpoint_unavailable", retryable: true },
  } as const;
}
