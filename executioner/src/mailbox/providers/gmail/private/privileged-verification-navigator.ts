import type {
  LivePortResult,
  LiveSessionId,
  PrivilegedVerificationNavigator,
  TargetIdentityV1,
  VerificationNavigationErrorCode,
  VerificationNavigationRequest,
  VerificationNavigationResult,
} from "../../../../contracts/live/index.ts";
import type { JourneyId, OperationId } from "../../../../contracts/index.ts";
import { GmailAtomicArtifactConsumer } from "./atomic-artifact-consumer.ts";

type BrowserNavigationErrorCode = Exclude<
  VerificationNavigationErrorCode,
  "verification_artifact_replayed"
>;

export interface ByteScopedVerificationBrowserRequest {
  readonly schemaVersion: 1;
  readonly journeyId: JourneyId;
  readonly operationId: OperationId;
  readonly sessionId: LiveSessionId;
  readonly expectedTarget: TargetIdentityV1;
  readonly now: string;
  readonly verificationTarget: Readonly<Uint8Array>;
  readonly approvedHost: Readonly<Uint8Array>;
  readonly approvedTenant: Readonly<Uint8Array>;
}

export interface ByteScopedVerificationBrowserCapability {
  navigateVerificationTarget(
    request: ByteScopedVerificationBrowserRequest,
    signal: AbortSignal,
  ): Promise<
    LivePortResult<VerificationNavigationResult, BrowserNavigationErrorCode>
  >;
}

export interface GmailVerificationPolicyCapability {
  use<Result>(
    operation: (policy: {
      readonly host: Readonly<Uint8Array>;
      readonly tenant: Readonly<Uint8Array>;
    }) => Promise<Result>,
  ): Promise<Result>;
}

export interface GmailPrivilegedVerificationNavigatorOptions {
  readonly consumer: GmailAtomicArtifactConsumer;
  readonly approvedPolicy: GmailVerificationPolicyCapability;
  readonly browser: ByteScopedVerificationBrowserCapability;
}

export function createGmailPrivilegedVerificationNavigator(
  options: GmailPrivilegedVerificationNavigatorOptions,
): PrivilegedVerificationNavigator {
  return Object.freeze({
    async navigate(
      request: VerificationNavigationRequest,
      signal: AbortSignal,
    ) {
      if (request.schemaVersion !== 1) return denied();
      return options.consumer.consume(
        {
          operationId: request.operationId,
          journeyId: request.journeyId,
          recipientBindingId: request.expectedRecipientBindingId,
          target: request.expectedTarget,
          handleId: request.artifact.handleId,
          now: request.now,
          artifact: request.artifact,
        },
        signal,
        async (values) => {
          if (values.length !== 3) return denied();
          let browserStarted = false;
          try {
            return await options.approvedPolicy.use(async (policy) => {
              if (
                !sameBytes(values[1]!, policy.host) ||
                !sameBytes(values[2]!, policy.tenant)
              ) return denied();
              browserStarted = true;
              try {
                return exactBrowserResult(
                  await options.browser.navigateVerificationTarget(
                    {
                      schemaVersion: 1,
                      journeyId: request.journeyId,
                      operationId: request.operationId,
                      sessionId: request.sessionId,
                      expectedTarget: request.expectedTarget,
                      now: request.now,
                      verificationTarget: values[0]!,
                      approvedHost: policy.host,
                      approvedTenant: policy.tenant,
                    },
                    signal,
                  ),
                );
              } catch {
                return effectUncertain();
              }
            });
          } catch {
            return browserStarted ? effectUncertain() : denied();
          }
        },
      );
    },
  });
}

function exactBrowserResult(
  result: LivePortResult<VerificationNavigationResult, BrowserNavigationErrorCode>,
): LivePortResult<VerificationNavigationResult, BrowserNavigationErrorCode> {
  if (result.ok) {
    if (result.value.kind === "navigated") {
      return { ok: true, value: { kind: "navigated" } };
    }
    if (result.value.kind === "target_unavailable") {
      return { ok: true, value: { kind: "target_unavailable" } };
    }
    return denied();
  }
  const expectedRetryability = {
    verification_navigation_denied: false,
    browser_timeout: true,
    browser_effect_uncertain: false,
    operation_cancelled: false,
  } as const;
  const retryable = expectedRetryability[
    result.error.code as keyof typeof expectedRetryability
  ];
  return retryable !== undefined && retryable === result.error.retryable
    ? { ok: false, error: { code: result.error.code, retryable } } as typeof result
    : denied();
}

function sameBytes(
  left: Readonly<Uint8Array>,
  right: Readonly<Uint8Array>,
): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function denied() {
  return {
    ok: false,
    error: { code: "verification_navigation_denied", retryable: false },
  } as const;
}

function effectUncertain() {
  return {
    ok: false,
    error: { code: "browser_effect_uncertain", retryable: false },
  } as const;
}
