import type {
  VerificationArtifact,
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
      const result = await delegate.port.inspect(request, signal);
      if (!result.ok || result.value.state !== "available") delegate.cleanup();
      return result;
    },
    invalidate: async (request, signal) => {
      if (signal.aborted) return Promise.resolve(cancelled);
      const delegate = this.#delegates.get(request.handleId);
      if (delegate === undefined) return replayed;
      const result = await delegate.port.invalidate(request, signal);
      delegate.cleanup();
      return result;
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
}
