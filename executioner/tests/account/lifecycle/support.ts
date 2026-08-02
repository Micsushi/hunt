import { generatedOperationId } from "../../../src/contracts/index.ts";
import type {
  ClassifiedAccountObservation,
} from "../../../src/ats/workday/live/index.ts";
import type {
  AccountLifecycleAccountStateObserver,
} from "../../../src/account/lifecycle/index.ts";
import { liveFixtures } from "../../../src/testing/live/index.ts";

export const operation = (suffix: string) =>
  generatedOperationId(`operation_${suffix.padStart(16, "0")}`);

export function lifecycleInput() {
  return {
    schemaVersion: 1 as const,
    operationId: operation("lifecycle"),
    journeyId: liveFixtures.journeyId,
    session: liveFixtures.session,
    target: liveFixtures.target,
    credential: liveFixtures.accountSecret,
    mailboxRequest: liveFixtures.mailboxPollRequest,
    now: liveFixtures.issuedAt,
    operations: {
      initialCredentialMutation: operation("initial"),
      navigateVerification: operation("navigate"),
      postVerificationSignIn: operation("sign-in"),
    },
  };
}

export type ObservedState = "application_ready" | "existing_account" |
  "create_account" | "verification_required";

export function accountObserver(
  ...states: readonly (ObservedState | ClassifiedAccountObservation)[]
) {
  const calls: unknown[] = [];
  let index = 0;
  const port: AccountLifecycleAccountStateObserver = {
    async observe(request, signal) {
      calls.push(request);
      if (signal.aborted) {
        return {
          ok: false,
          error: { code: "operation_cancelled", retryable: false },
        };
      }
      const next = states[Math.min(index, states.length - 1)] ?? "application_ready";
      index += 1;
      if (typeof next !== "string") return { ok: true, value: next };
      return {
        ok: true,
        value: {
          kind: "classified_account",
          state: {
            kind: next,
            classificationId: "classification_account_test_v1",
            sourceRevisionId: "classification_revision_test_v1",
          },
          classificationId: "classification_account_test_v1",
          sourceRevisionId: "classification_revision_test_v1",
          snapshotId: "live_entry_snapshot_test_v1",
          documentGenerationId: "live_entry_document_test_v1",
        } as never,
      };
    },
  };
  return { calls, port };
}
