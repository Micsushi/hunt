import { useEphemeralBytes } from "../../../../contracts/live/private/privileged-capabilities.ts";
import type {
  AvailableVerificationArtifact,
  TargetIdentityV1,
  VerificationHandleId,
  VerificationNavigationResult,
} from "../../../../contracts/live/index.ts";

export interface PendingRawArtifact {
  readonly metadata: AvailableVerificationArtifact;
  readonly target: Uint8Array;
}

interface CommittedRawArtifact extends PendingRawArtifact {}

export class GmailRawArtifactVault {
  readonly #targets = new Map<VerificationHandleId, CommittedRawArtifact>();

  get committedCount(): number {
    return this.#targets.size;
  }

  stage(entries: readonly PendingRawArtifact[]): PendingRawArtifactBatch {
    return new PendingRawArtifactBatch(this.#targets, entries);
  }

  invalidate(handleId: VerificationHandleId): void {
    const entry = this.#targets.get(handleId);
    if (entry === undefined) return;
    this.#targets.delete(handleId);
    entry.target.fill(0);
  }

  async useForNavigator<Result extends VerificationNavigationResult>(
    admission: AvailableVerificationArtifact,
    now: string,
    signal: AbortSignal,
    operation: (target: Readonly<Uint8Array>) => Promise<Result>,
  ): Promise<Result | null> {
    const entry = this.#targets.get(admission.handleId);
    if (entry === undefined) return null;
    if (
      signal.aborted ||
      !validInstant(now) ||
      admission.state !== "available" ||
      Date.parse(admission.expiresAt) <= Date.parse(now) ||
      !sameMetadata(entry.metadata, admission)
    ) {
      this.invalidate(admission.handleId);
      return null;
    }
    this.#targets.delete(admission.handleId);
    return useEphemeralBytes(entry.target, operation);
  }
}

export class PendingRawArtifactBatch {
  readonly #vault: Map<VerificationHandleId, CommittedRawArtifact>;
  #entries: readonly PendingRawArtifact[] | null;

  constructor(
    vault: Map<VerificationHandleId, CommittedRawArtifact>,
    entries: readonly PendingRawArtifact[],
  ) {
    this.#vault = vault;
    this.#entries = entries;
  }

  commit(handleId: VerificationHandleId): boolean {
    const entries = this.#entries;
    if (
      entries === null ||
      entries.length !== 1 ||
      entries[0]!.metadata.handleId !== handleId ||
      this.#vault.has(handleId)
    ) {
      this.discard();
      return false;
    }
    this.#entries = null;
    this.#vault.set(handleId, entries[0]!);
    return true;
  }

  discard(): void {
    const entries = this.#entries;
    this.#entries = null;
    if (entries === null) return;
    for (const entry of entries) entry.target.fill(0);
  }
}

function sameMetadata(
  left: AvailableVerificationArtifact,
  right: AvailableVerificationArtifact,
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
