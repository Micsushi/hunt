import { generatedOperationId } from "../../../src/contracts/index.ts";
import type {
  ClassifiedAccountObservation,
} from "../../../src/ats/workday/live/index.ts";
import type {
  AccountLifecycleAccountStateObserver,
  AccountLifecycleVerificationEmailRequester,
} from "../../../src/account/lifecycle/index.ts";
import { liveFixtures } from "../../../src/testing/live/index.ts";

export const operation = (suffix: string) =>
  generatedOperationId(`operation_${suffix.padStart(16, "0")}`);

export function lifecycleInput() {
  return {
    schemaVersion: 1 as const,
    operationId: operation("lifecycle"),
    approvalId: "approval_abcdefghijklmnop",
    journeyId: liveFixtures.journeyId,
    session: liveFixtures.session,
    target: liveFixtures.target,
    credential: liveFixtures.accountSecret,
    mailboxRequest: liveFixtures.mailboxPollRequest,
    now: liveFixtures.issuedAt,
    accountIntent: "sign_in" as const,
    operations: {
      initialCredentialMutation: operation("initial"),
      createCredentialMutation: operation("create"),
      accountExistsSignIn: operation("exists-sign-in"),
      requestVerificationEmail: operation("request-email"),
      navigateVerification: operation("navigate"),
      postVerificationSignIn: operation("sign-in"),
      postVerificationCredentialSubmit: operation("post-verification-submit"),
      showPasswordReset: operation("show-password-reset"),
      requestPasswordReset: operation("request-password-reset"),
      completePasswordReset: operation("complete-password-reset"),
      postPasswordResetSignIn: operation("post-password-reset-sign-in"),
    },
  };
}

export type ObservedState = "application_ready" | "existing_account" |
  "create_account" | "verification_required" | "password_reset_request" |
  "password_reset_email_sent" | "password_reset_set" | "account_absent" |
  "account_exists" | "password_reset_required";

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
      const accountFact = next === "account_absent"
        ? "absent"
        : next === "account_exists"
          ? "exists"
          : next === "password_reset_required"
            ? "password_reset_required"
          : undefined;
      const kind = next === "account_absent"
        ? "existing_account"
        : next === "account_exists"
          ? "create_account"
          : next === "password_reset_required"
            ? "existing_account"
          : next;
      return {
        ok: true,
        value: {
          kind: "classified_account",
          state: {
            kind,
            ...(accountFact === undefined ? {} : { accountFact }),
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

export function verificationEmailRequester(options: {
  readonly result?: Awaited<ReturnType<AccountLifecycleVerificationEmailRequester["request"]>>;
  readonly order?: string[];
} = {}) {
  const calls: unknown[] = [];
  const port: AccountLifecycleVerificationEmailRequester = {
    async request(request, signal) {
      calls.push(request);
      options.order?.push("request_verification_email");
      if (signal.aborted) {
        return { ok: false, error: { code: "operation_cancelled", retryable: false } };
      }
      return options.result ?? { ok: true, value: { kind: "not_required" } };
    },
  };
  return { calls, port };
}
