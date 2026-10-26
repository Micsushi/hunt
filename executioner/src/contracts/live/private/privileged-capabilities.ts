import type {
  CredentialMutationResult,
  MailboxPollResultV1,
  VerificationNavigationResult,
} from "../types.ts";

export type EphemeralPrivilegedResult =
  | { readonly kind: "completed" }
  | CredentialMutationResult
  | MailboxPollResultV1
  | VerificationNavigationResult;

export async function useEphemeralBytes<
  const Result extends EphemeralPrivilegedResult,
>(
  bytes: Uint8Array,
  operation: (value: Readonly<Uint8Array>) => Promise<Result>,
): Promise<Result> {
  try {
    return await operation(bytes);
  } finally {
    bytes.fill(0);
  }
}

export async function useEphemeralByteBatch<
  const Result extends EphemeralPrivilegedResult,
>(
  values: readonly Uint8Array[],
  operation: (bytes: readonly Readonly<Uint8Array>[]) => Promise<Result>,
): Promise<Result> {
  try {
    return await operation(values);
  } finally {
    for (const value of values) value.fill(0);
  }
}

export interface AccountCredentialCapability {
  use<Result extends CredentialMutationResult>(
    operation: (values: readonly Readonly<Uint8Array>[]) => Promise<Result>,
  ): Promise<Result>;
}

export interface GmailAuthorizationCapability {
  use<Result extends MailboxPollResultV1>(
    operation: (authorization: Readonly<Uint8Array>) => Promise<Result>,
  ): Promise<Result>;
}

export interface VerificationTargetCapability {
  use<Result extends VerificationNavigationResult>(
    operation: (target: Readonly<Uint8Array>) => Promise<Result>,
  ): Promise<Result>;
}
