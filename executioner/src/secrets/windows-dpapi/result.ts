import { s2StableErrorPolicy } from "../../contracts/s2-common-wire.ts";
import type {
  LivePortResult,
  SecretStoreErrorCode,
} from "../../contracts/live/index.ts";

export const ok = <T>(value: T) => ({ ok: true, value }) as const;

export function secretError<const Code extends SecretStoreErrorCode>(code: Code) {
  return {
    ok: false,
    error: { code, retryable: s2StableErrorPolicy[code].retryable },
  } as unknown as Extract<LivePortResult<never, Code>, { readonly ok: false }>;
}

export const cancelled = {
  ok: false,
  error: { code: "operation_cancelled", retryable: false },
} as const;
