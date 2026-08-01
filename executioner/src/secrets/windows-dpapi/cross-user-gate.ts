import { randomBytes } from "node:crypto";

import { WindowsDpapiBridge } from "./bridge.ts";

export interface SecondaryWindowsUserProbeRequest {
  readonly schemaVersion: 1;
  readonly ciphertext: Uint8Array;
  readonly entropy: Uint8Array;
}

export type SecondaryWindowsUserProbeResult = {
  readonly schemaVersion: 1;
  readonly context: "current_windows_user" | "different_windows_user";
  readonly outcome: "rejected" | "decrypted";
};

export interface SecondaryWindowsUserContext {
  attempt(
    request: SecondaryWindowsUserProbeRequest,
    signal: AbortSignal,
  ): Promise<SecondaryWindowsUserProbeResult>;
}

export type CrossWindowsUserDpapiGateResult =
  | {
      readonly schemaVersion: 1;
      readonly kind: "passed";
      readonly scope: "windows_dpapi_current_user_v1";
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "environment_prerequisite";
      readonly code: "authorized_secondary_user_context_unavailable";
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "failed";
      readonly code:
        | "dpapi_cross_user_isolation_failed"
        | "dpapi_cross_user_probe_failed";
    };

export interface CrossWindowsUserDpapiGateOptions {
  readonly bridge?: Pick<WindowsDpapiBridge, "protect">;
  readonly context?: SecondaryWindowsUserContext;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export async function runCrossWindowsUserDpapiGate(
  options: CrossWindowsUserDpapiGateOptions,
  signal: AbortSignal,
): Promise<CrossWindowsUserDpapiGateResult> {
  if (options.context === undefined) {
    return prerequisite();
  }
  if (signal.aborted) return probeFailed();

  const bytes = options.randomBytes ?? ((size) => new Uint8Array(randomBytes(size)));
  const value = bytes(32);
  const entropy = bytes(32);
  let ciphertext: Uint8Array | undefined;
  try {
    const bridge = options.bridge ?? new WindowsDpapiBridge();
    ciphertext = await bridge.protect(value, entropy, signal);
    if (signal.aborted) return probeFailed();
    const observed = await options.context.attempt({
      schemaVersion: 1,
      ciphertext,
      entropy,
    }, signal);
    if (!validProbeResult(observed)) return probeFailed();
    return observed.context === "different_windows_user" &&
        observed.outcome === "rejected"
      ? {
          schemaVersion: 1,
          kind: "passed",
          scope: "windows_dpapi_current_user_v1",
        }
      : {
          schemaVersion: 1,
          kind: "failed",
          code: "dpapi_cross_user_isolation_failed",
        };
  } catch {
    return probeFailed();
  } finally {
    value.fill(0);
    entropy.fill(0);
    ciphertext?.fill(0);
  }
}

function validProbeResult(value: unknown): value is SecondaryWindowsUserProbeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<SecondaryWindowsUserProbeResult>;
  return Object.keys(value).length === 3 &&
    candidate.schemaVersion === 1 &&
    (candidate.context === "current_windows_user" ||
      candidate.context === "different_windows_user") &&
    (candidate.outcome === "rejected" || candidate.outcome === "decrypted");
}

function prerequisite(): CrossWindowsUserDpapiGateResult {
  return {
    schemaVersion: 1,
    kind: "environment_prerequisite",
    code: "authorized_secondary_user_context_unavailable",
  };
}

function probeFailed(): CrossWindowsUserDpapiGateResult {
  return {
    schemaVersion: 1,
    kind: "failed",
    code: "dpapi_cross_user_probe_failed",
  };
}
