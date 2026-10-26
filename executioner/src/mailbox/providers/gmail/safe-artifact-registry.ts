import type {
  AvailableVerificationArtifact,
  VerificationArtifact,
  VerificationArtifactInspectRequest,
  VerificationHandleId,
} from "../../../contracts/live/index.ts";

const replayed = {
  ok: false,
  error: { code: "verification_artifact_replayed", retryable: false },
} as const;

const cancelled = {
  ok: false,
  error: { code: "operation_cancelled", retryable: false },
} as const;

export class GmailSafeArtifactRegistry {
  readonly #delegates = new Map<
    VerificationHandleId,
    { readonly port: VerificationArtifact; readonly cleanup: () => void }
  >();

  readonly port: VerificationArtifact = {
    inspect: async (request, signal) => {
      if (signal.aborted) return Promise.resolve(cancelled);
      const delegate = this.#delegates.get(request.handleId);
      if (delegate === undefined) return replayed;
      try {
        const result = await delegate.port.inspect(request, signal);
        if (!result.ok || result.value.state !== "available") {
          this.#delegates.delete(request.handleId);
          delegate.cleanup();
        }
        return result;
      } catch (error) {
        this.#delegates.delete(request.handleId);
        delegate.cleanup();
        throw error;
      }
    },
    invalidate: async (request, signal) => {
      if (signal.aborted) return Promise.resolve(cancelled);
      const delegate = this.#delegates.get(request.handleId);
      if (delegate === undefined) return replayed;
      try {
        return await delegate.port.invalidate(request, signal);
      } finally {
        this.#delegates.delete(request.handleId);
        delegate.cleanup();
      }
    },
  };

  register(
    handleId: VerificationHandleId,
    delegate: VerificationArtifact,
    cleanup: () => void = () => undefined,
  ): boolean {
    if (this.#delegates.has(handleId)) return false;
    this.#delegates.set(handleId, { port: delegate, cleanup });
    return true;
  }

  unregister(handleId: VerificationHandleId): void {
    this.#delegates.delete(handleId);
  }

  discard(handleId: VerificationHandleId): void {
    const delegate = this.#delegates.get(handleId);
    if (delegate === undefined) return;
    this.#delegates.delete(handleId);
    delegate.cleanup();
  }

  async inspectForAtomicConsume(
    request: VerificationArtifactInspectRequest,
    signal: AbortSignal,
  ): Promise<AvailableVerificationArtifact | null> {
    const delegate = this.#delegates.get(request.handleId);
    if (delegate === undefined) return null;
    if (signal.aborted) {
      this.discard(request.handleId);
      return null;
    }
    try {
      const result = await delegate.port.inspect(request, signal);
      if (!result.ok || result.value.state !== "available") {
        this.discard(request.handleId);
        return null;
      }
      return { ...result.value, state: "available" };
    } catch {
      this.discard(request.handleId);
      return null;
    }
  }

  async takeForAtomicConsume(
    request: VerificationArtifactInspectRequest,
    signal: AbortSignal,
  ): Promise<AvailableVerificationArtifact | null> {
    const delegate = this.#delegates.get(request.handleId);
    if (delegate === undefined) return null;
    if (signal.aborted) {
      this.discard(request.handleId);
      return null;
    }
    try {
      const result = await delegate.port.inspect(request, signal);
      this.#delegates.delete(request.handleId);
      if (!result.ok || result.value.state !== "available") {
        delegate.cleanup();
        return null;
      }
      return { ...result.value, state: "available" };
    } catch {
      this.#delegates.delete(request.handleId);
      delegate.cleanup();
      return null;
    }
  }
}
