import assert from "node:assert/strict";
import test from "node:test";

import type {
  CredentialMutationAdapter,
  LiveBrowserSessionV1,
  PersistentBrowserSession,
  SecretHandleMetadataV1,
  SecretStore,
  TargetIdentityV1,
} from "../../../src/contracts/live/index.ts";
import {
  runStage2AccountAccess,
  type AccountAccessEvidenceWriter,
  type AccountEntryNavigator,
  type Stage2AccountAccessInput,
} from "../../../src/live/runner/account-access.ts";

const target = {
  schemaVersion: 1,
  atsFamily: "workday",
  hostId: "host_abcdefghijklmnop",
  tenantId: "tenant_abcdefghijklmnop",
  postingId: "posting_abcdefghijklmnop",
} as TargetIdentityV1;

const session = {
  schemaVersion: 1,
  journeyId: "journey_abcdefghijklmnop",
  sessionId: "live_session_abcdefghijklmnop",
  profileLeaseId: "profile_abcdefghijklmnop",
  target,
  leaseExpiresAt: "2026-08-02T12:00:00.000Z",
} as LiveBrowserSessionV1;

function input(): Stage2AccountAccessInput {
  return {
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    revisionId: "revision_abcdefghijklmnop",
    approvalId: "approval_abcdefghijklmnop",
    journeyId: "journey_abcdefghijklmnop" as never,
    accountMode: "fresh_create",
    targetHandleId: "target_ref_abcdefghijklmnop",
    profileLeaseId: "profile_abcdefghijklmnop" as never,
    target,
    accountSecretHandleId: "secret_handle_accountabcdefghijkl" as never,
    accountSecretExpiresAt: "2026-08-02T11:00:00.000Z",
    now: "2026-08-01T12:00:00.000Z",
  };
}

function metadata(
  purpose: "account_credentials" | "gmail_oauth",
): SecretHandleMetadataV1 {
  return {
    schemaVersion: 1,
    handleId: purpose === "account_credentials"
      ? input().accountSecretHandleId
      : "secret_handle_gmailabcdefghijklxx" as never,
    journeyId: input().journeyId,
    provider: "windows_dpapi_current_user_v1",
    purpose,
    consumer: purpose === "account_credentials"
      ? "credential_mutation_adapter"
      : "gmail_auth_executor",
    issuedAt: "2026-08-01T11:00:00.000Z",
    expiresAt: "2026-08-02T11:00:00.000Z",
    state: "active",
  };
}

test("account access inspects only the account handle before browser and seals after fresh-signal cleanup", async () => {
  const order: string[] = [];
  const signals: AbortSignal[] = [];
  const secretStore: SecretStore = {
    async inspect(request) {
      order.push(`inspect:${request.expectedPurpose}`);
      return {
        ok: true,
        value: metadata(request.expectedPurpose),
      };
    },
    async revoke() {
      throw new Error("runner must not revoke durable handles");
    },
  };
  const browser: PersistentBrowserSession = {
    async open() {
      order.push("open");
      return { ok: true, value: { kind: "opened", session } };
    },
    async reconcile() {
      order.push("reconcile");
      return { ok: true, value: { kind: "matched", session } };
    },
    async close(_request, signal) {
      order.push("close");
      signals.push(signal);
      return { ok: true, value: undefined };
    },
  };
  const navigator: AccountEntryNavigator = {
    async advanceToAccountEntry(request) {
      order.push("advance");
      assert.deepEqual(Object.keys(request), [
        "schemaVersion", "journeyId", "operationId", "sessionId", "target", "now",
      ]);
      assert.equal(request.sessionId, session.sessionId);
      return { ok: true, value: { kind: "account_boundary" } };
    },
  };
  const credentials: CredentialMutationAdapter = {
    async mutate(request) {
      order.push("mutate");
      assert.equal(request.sessionId, session.sessionId);
      return {
        ok: true,
        value: {
          kind: "verification_required",
          attemptedFields: ["email", "password"],
        },
      };
    },
  };
  const evidence: AccountAccessEvidenceWriter = {
    async write(value) {
      order.push("evidence");
      assert.equal(value.sourceRevision, input().sourceRevision);
      assert.equal(value.submitActivated, false);
      assert.deepEqual(value.independentlyVerifiedFields, ["email", "password"]);
    },
  };

  const result = await runStage2AccountAccess(input(), {
    secretStore,
    browser,
    navigator,
    credentials,
    evidence,
    nextOperationId: ids(),
  }, new AbortController().signal);

  assert.equal(result.ok, true);
  assert.deepEqual(order, [
    "inspect:account_credentials",
    "open",
    "reconcile",
    "advance",
    "mutate",
    "close",
    "evidence",
  ]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, false);
});

test("an absent or invalid Gmail record is untouched and cannot affect account access", async () => {
  let browserCalls = 0;
  let gmailInspections = 0;
  const dependencies = successfulDependencies();
  dependencies.secretStore = {
    async inspect(request) {
      if (request.expectedPurpose === "gmail_oauth") {
        gmailInspections += 1;
        return { ok: false, error: { code: "secret_handle_invalid", retryable: false } };
      }
      return { ok: true, value: metadata("account_credentials") };
    },
    async revoke() {
      throw new Error("not used");
    },
  };
  dependencies.browser = {
    ...dependencies.browser,
    async open() {
      browserCalls += 1;
      return { ok: true, value: { kind: "opened", session } };
    },
  };
  const result = await runStage2AccountAccess(
    input(),
    dependencies,
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  assert.equal(browserCalls, 1);
  assert.equal(gmailInspections, 0);
});

test("owner and stored account-secret expiry must match before browser", async () => {
  let browserCalls = 0;
  const dependencies = successfulDependencies();
  dependencies.secretStore = {
    async inspect(request) {
      const value = metadata(request.expectedPurpose);
      return {
        ok: true,
        value: {
          ...value,
          expiresAt: "2026-08-02T10:00:00.000Z",
        },
      };
    },
    async revoke() { throw new Error("not used"); },
  };
  dependencies.browser = {
    ...dependencies.browser,
    async open() {
      browserCalls += 1;
      return { ok: true, value: { kind: "opened", session } };
    },
  };
  const result = await runStage2AccountAccess(
    input(), dependencies, new AbortController().signal,
  );
  assert.deepEqual(result, { ok: false, code: "secret_handle_mismatched" });
  assert.equal(browserCalls, 0);
});

test("unproven account fields fail after cleanup and do not seal acceptance", async () => {
  let closed = 0;
  let evidenceCalls = 0;
  const dependencies = successfulDependencies();
  dependencies.credentials = {
    async mutate() {
      return {
        ok: true,
        value: { kind: "application_ready", attemptedFields: [] },
      };
    },
  };
  dependencies.browser = {
    ...dependencies.browser,
    async close(_request, signal) {
      assert.equal(signal.aborted, false);
      closed += 1;
      return { ok: true, value: undefined };
    },
  };
  dependencies.evidence = { async write() { evidenceCalls += 1; } };

  const result = await runStage2AccountAccess(
    input(),
    dependencies,
    new AbortController().signal,
  );
  assert.deepEqual(result, { ok: false, code: "account_proof_invalid" });
  assert.equal(closed, 1);
  assert.equal(evidenceCalls, 0);
});

test("account navigation preserves exact factual target outcomes", async () => {
  for (const value of [
    { kind: "target_mismatch" as const, dimension: "posting" as const },
    { kind: "target_ambiguous" as const },
    { kind: "posting_unavailable" as const, reason: "closed" as const },
  ]) {
    const dependencies = successfulDependencies();
    dependencies.navigator = {
      async advanceToAccountEntry() { return { ok: true, value }; },
    };
    const result = await runStage2AccountAccess(
      input(), dependencies, new AbortController().signal,
    );
    assert.deepEqual(result, { ok: false, code: value.kind, fact: value });
  }
});

test("run cancellation still closes with a separate live cleanup signal", async () => {
  const controller = new AbortController();
  let cleanupSignal: AbortSignal | undefined;
  const dependencies = successfulDependencies();
  dependencies.credentials = {
    async mutate() {
      controller.abort();
      return { ok: false, error: { code: "operation_cancelled", retryable: false } } as never;
    },
  };
  dependencies.browser = {
    ...dependencies.browser,
    async close(_request, signal) {
      cleanupSignal = signal;
      return { ok: true, value: undefined };
    },
  };
  const result = await runStage2AccountAccess(input(), dependencies, controller.signal);
  assert.deepEqual(result, { ok: false, code: "operation_cancelled" });
  assert.equal(cleanupSignal?.aborted, false);
});

test("thrown cleanup is converted to a bounded cleanup failure", async () => {
  const dependencies = successfulDependencies();
  dependencies.browser = {
    ...dependencies.browser,
    async close() { throw new Error("raw cleanup detail"); },
  };
  assert.deepEqual(
    await runStage2AccountAccess(input(), dependencies, new AbortController().signal),
    { ok: false, code: "browser_profile_cleanup_failed" },
  );
});

test("an already-invalidated browser cleanup does not mask credential effect uncertainty", async () => {
  const dependencies = successfulDependencies();
  dependencies.credentials = {
    async mutate() {
      return {
        ok: false,
        error: { code: "credential_effect_uncertain", retryable: false },
      } as const;
    },
  };
  dependencies.browser = {
    ...dependencies.browser,
    async close() {
      return {
        ok: false,
        error: { code: "browser_session_missing", retryable: false },
      } as const;
    },
  };

  assert.deepEqual(
    await runStage2AccountAccess(input(), dependencies, new AbortController().signal),
    { ok: false, code: "credential_effect_uncertain" },
  );
});

function successfulDependencies() {
  return {
    secretStore: {
      async inspect(request) {
        return { ok: true, value: metadata(request.expectedPurpose) };
      },
      async revoke() {
        throw new Error("not used");
      },
    } as SecretStore,
    browser: {
      async open() { return { ok: true, value: { kind: "opened", session } }; },
      async reconcile() { return { ok: true, value: { kind: "matched", session } }; },
      async close() { return { ok: true, value: undefined }; },
    } as PersistentBrowserSession,
    navigator: {
      async advanceToAccountEntry() {
        return { ok: true, value: { kind: "account_boundary" } };
      },
    } as AccountEntryNavigator,
    credentials: {
      async mutate() {
        return {
          ok: true,
          value: {
            kind: "verification_required",
            attemptedFields: ["email", "password"],
          },
        };
      },
    } as CredentialMutationAdapter,
    evidence: { async write() {} } as AccountAccessEvidenceWriter,
    nextOperationId: ids(),
  };
}

function ids(): () => never {
  let value = 0;
  return () => `operation_abcdefghijklmnop${value += 1}` as never;
}
