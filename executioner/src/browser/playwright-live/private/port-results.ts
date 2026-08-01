import type {
  PersistentBrowserErrorCode,
  S2PortError,
} from "../../../contracts/live/index.ts";
import { s2StableErrorPolicy } from "../../../contracts/s2-common-wire.ts";

export function cancelled() {
  return {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  } as const;
}

export function failure<const C extends PersistentBrowserErrorCode>(
  code: C,
): { readonly ok: false; readonly error: S2PortError<C> } {
  return {
    ok: false,
    error: {
      code,
      retryable: s2StableErrorPolicy[code].retryable,
    } as S2PortError<C>,
  };
}

export type BoundedResult<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timeout" }
  | { readonly kind: "error" };

export function bounded<T>(
  action: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<BoundedResult<T>> {
  if (signal.aborted) {
    void action.catch(() => undefined);
    return Promise.resolve({ kind: "cancelled" });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: BoundedResult<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ kind: "cancelled" });
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    action.then(
      (value) => finish({ kind: "value", value }),
      () => finish({ kind: "error" }),
    );
  });
}
