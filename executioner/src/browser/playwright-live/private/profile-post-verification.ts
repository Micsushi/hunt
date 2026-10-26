export const profilePostVerificationPhases = [
  "acceptance",
  "pending_owner_learning",
  "review_expectations",
  "stable_page",
  "authorization",
] as const;

export type ProfilePostVerificationPhase =
  (typeof profilePostVerificationPhases)[number];

export interface ProfilePostVerificationTrace {
  readonly phase: ProfilePostVerificationPhase;
  readonly status: "started" | "completed" | "failed";
  readonly failureName?: string;
}

export async function completeProfilePostVerification(input: {
  readonly recordAcceptance: () => void;
  readonly recordPendingOwnerLearning: () => void;
  readonly recordReviewExpectations: () => void;
  readonly verifyStablePage: () => Promise<boolean>;
  readonly assertAuthorized: () => void;
  readonly trace?: (event: "profile_post_verification_phase", details: ProfilePostVerificationTrace) => void;
}): Promise<void> {
  await phase("acceptance", input.recordAcceptance, input.trace);
  await phase("pending_owner_learning", input.recordPendingOwnerLearning, input.trace);
  await phase("review_expectations", input.recordReviewExpectations, input.trace);
  await phase("stable_page", async () => {
    if (!await input.verifyStablePage()) {
      throw new TypeError("profile reconciliation page drift denied");
    }
  }, input.trace);
  await phase("authorization", input.assertAuthorized, input.trace);
}

async function phase(
  name: ProfilePostVerificationPhase,
  action: () => void | Promise<void>,
  trace: ((event: "profile_post_verification_phase", details: ProfilePostVerificationTrace) => void) | undefined,
): Promise<void> {
  safeTrace(trace, { phase: name, status: "started" });
  try {
    await action();
    safeTrace(trace, { phase: name, status: "completed" });
  } catch (error) {
    safeTrace(trace, {
      phase: name,
      status: "failed",
      failureName: error instanceof Error ? error.name : "unknown",
    });
    throw error;
  }
}

function safeTrace(
  trace: ((event: "profile_post_verification_phase", details: ProfilePostVerificationTrace) => void) | undefined,
  details: ProfilePostVerificationTrace,
): void {
  try {
    trace?.("profile_post_verification_phase", Object.freeze(details));
  } catch {
    // Value-free diagnostics never change the application outcome.
  }
}
