import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { OperationId } from "../../src/contracts/index.ts";
import type {
  LiveBrowserSessionV1,
  LivePortResult,
  PersistentBrowserErrorCode,
  PersistentBrowserReconcileResult,
} from "../../src/contracts/live/index.ts";
import type { RealRunOwnerInputsV1 } from "../../src/live/preflight/types.ts";
import {
  createAccountVerifiedBindings,
  createBoundAccountStateObserver,
  createCleanupBoundAccountVerifiedLifecycle,
  runSessionBoundAccountVerifiedLifecycle,
} from "../../src/composition/s2-account-verified-runner.ts";
import { runStage2AccountVerified } from "../../src/live/runner/account-verified.ts";

const now = "2026-08-02T02:05:29.000Z";
const sourceRevision = "0123456789abcdef0123456789abcdef01234567";

test("account-verified bindings share the one navigation operation with Gmail", () => {
  const operations = operationIds();
  const value = createAccountVerifiedBindings(
    ownerInputs(),
    sourceRevision,
    now,
    operations,
  );

  assert.equal(value.gmail.verificationOperationId, operations.navigateVerification);
  assert.equal(
    value.lifecycle.operations.navigateVerification,
    operations.navigateVerification,
  );
  assert.equal(
    value.lifecycle.operations.createCredentialMutation,
    operations.createCredentialMutation,
  );
  assert.equal(
    value.lifecycle.operations.accountExistsSignIn,
    operations.accountExistsSignIn,
  );
  assert.equal(
    value.lifecycle.operations.requestVerificationEmail,
    operations.requestVerificationEmail,
  );
  assert.equal(value.lifecycle.approvalId, ownerInputs().approval.approvalId);
  assert.notEqual(
    value.lifecycle.operations.initialCredentialMutation,
    value.lifecycle.operations.createCredentialMutation,
  );
  assert.notEqual(
    value.lifecycle.operations.createCredentialMutation,
    value.lifecycle.operations.accountExistsSignIn,
  );
  assert.notEqual(
    value.lifecycle.operations.requestVerificationEmail,
    value.lifecycle.operations.navigateVerification,
  );
  assert.equal(value.lifecycle.mailboxRequest, value.mailboxRequest);
  assert.equal(value.lifecycle.target, value.target);
  assert.equal(value.runner.targetHandleId, "target_ref_abcdefghijklmnop");
  assert.equal(value.mailboxRequest.notBefore, "2026-08-02T01:05:29.000Z");
  assert.equal(value.gmail.notBefore, "2026-08-02T01:05:29.000Z");
  assert.equal(value.mailboxRequest.notAfter, now);
  assert.equal(value.gmail.notAfter, value.mailboxRequest.notAfter);
  assert.equal(
    Date.parse(value.mailboxRequest.notAfter) - Date.parse(value.mailboxRequest.notBefore),
    60 * 60 * 1_000,
  );
  assert.match(value.mailboxRequest.queryId, /^mailbox_query_/u);
  assert.notEqual(value.mailboxRequest.queryId, operations.navigateVerification);
  assert.equal(JSON.stringify(value).includes("myworkdayjobs.com"), false);
});

test("cleanup-bound lifecycle closes before returning success", async () => {
  const events: string[] = [];
  const session = browserSession();
  const lifecycle = createCleanupBoundAccountVerifiedLifecycle({
    browser: fakeBrowser(session, events),
    openRequest: openRequest(),
    reconcileOperationId: "operation_reconcileabcdef" as OperationId,
    advanceOperationId: "operation_advanceabcdefghijkl" as OperationId,
    closeOperationId: "operation_close_abcdefghijkl" as OperationId,
    now,
    runLifecycle: async (opened) => {
      assert.equal(opened, session);
      events.push("lifecycle");
      return {
        ok: true,
        value: {
          kind: "account_ready",
          path: "verified_account",
          independentlyObserved: true,
          verificationCandidateCount: 1,
          verificationConsumed: true,
        },
      };
    },
  });

  const result = await lifecycle.run(new AbortController().signal);
  events.push("returned");
  assert.deepEqual(events, [
    "open", "reconcile", "advance", "lifecycle", "close", "returned",
  ]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.cleanup, "pass");
});

test("session-bound lifecycle preserves factual account blocks without owning session cleanup", async () => {
  const events: string[] = [];
  const session = browserSession();
  type SessionBrowser = Parameters<
    typeof runSessionBoundAccountVerifiedLifecycle
  >[0]["browser"];
  const browser: SessionBrowser & {
    open(): Promise<never>;
    close(): Promise<never>;
  } = {
    async open() {
      events.push("open");
      throw new Error("session-bound helper must not open");
    },
    async close() {
      events.push("close");
      throw new Error("session-bound helper must not close");
    },
    async reconcile(request) {
      assert.equal(request.session, session);
      assert.equal(request.expectedTarget, session.target);
      events.push("reconcile");
      return { ok: true, value: { kind: "matched", session } };
    },
    async advanceToAccountEntry(request) {
      assert.equal(request.sessionId, session.sessionId);
      assert.equal(request.target, session.target);
      events.push("advance");
      return { ok: true, value: { kind: "account_boundary" } };
    },
  };
  const factual = {
    kind: "blocked" as const,
    factualOutcome: {
      source: "account_access" as const,
      result: { kind: "manual_intervention" as const, reason: "mfa" as const },
    },
  };

  const result = await runSessionBoundAccountVerifiedLifecycle({
    browser,
    session,
    journeyId: session.journeyId,
    expectedTarget: session.target,
    reconcileOperationId: "operation_reconcile_session1" as OperationId,
    advanceOperationId: "operation_advance_session123" as OperationId,
    now,
    runLifecycle: async (ownedSession) => {
      assert.equal(ownedSession, session);
      events.push("lifecycle");
      return { ok: true, value: factual };
    },
  }, new AbortController().signal);

  assert.deepEqual(result, { ok: true, value: factual });
  assert.deepEqual(events, ["reconcile", "advance", "lifecycle"]);
});

test("runner writes evidence only after cleanup has closed the browser", async () => {
  const events: string[] = [];
  const session = browserSession();
  const lifecycle = createCleanupBoundAccountVerifiedLifecycle({
    browser: fakeBrowser(session, events),
    openRequest: openRequest(),
    reconcileOperationId: "operation_reconcileabcdef" as OperationId,
    advanceOperationId: "operation_advanceabcdefghijkl" as OperationId,
    closeOperationId: "operation_close_abcdefghijkl" as OperationId,
    now,
    runLifecycle: async () => {
      events.push("lifecycle");
      return {
        ok: true,
        value: {
          kind: "account_ready",
          path: "verified_account",
          independentlyObserved: true,
          verificationCandidateCount: 1,
          verificationConsumed: true,
        },
      };
    },
  });
  const result = await runStage2AccountVerified({
    sourceRevision,
    revisionId: "revision_abcdefghijklmnop",
    approvalId: "approval_abcdefghijklmnop",
    journeyId: session.journeyId,
    targetHandleId: "target_ref_abcdefghijklmnop",
  }, {
    lifecycle,
    evidence: { write: async () => { events.push("evidence"); } },
  }, new AbortController().signal);

  assert.equal(result.ok, true);
  assert.deepEqual(events, [
    "open", "reconcile", "advance", "lifecycle", "close", "evidence",
  ]);
});

test("target facts stop before lifecycle credential or mailbox effects", async () => {
  const session = browserSession();
  const browser = fakeBrowser(session, [], {
    kind: "target_mismatch",
    dimension: "tenant",
  });
  let lifecycleCalls = 0;
  const lifecycle = createCleanupBoundAccountVerifiedLifecycle({
    browser,
    openRequest: openRequest(),
    reconcileOperationId: "operation_reconcileabcdef" as OperationId,
    advanceOperationId: "operation_advanceabcdefghijkl" as OperationId,
    closeOperationId: "operation_close_abcdefghijkl" as OperationId,
    now,
    runLifecycle: async () => {
      lifecycleCalls += 1;
      throw new Error("must not run");
    },
  });
  assert.deepEqual(await lifecycle.run(new AbortController().signal), {
    ok: true,
    cleanup: "pass",
    value: {
      kind: "blocked",
      factualOutcome: {
        source: "target_identity",
        result: { kind: "target_mismatch", dimension: "tenant" },
      },
    },
  });
  assert.equal(lifecycleCalls, 0);
});

test("cleanup failure denies the lifecycle result with the stable cleanup code", async () => {
  const session = browserSession();
  const browser = fakeBrowser(session, []);
  browser.close = async () => ({
    ok: false,
    error: { code: "browser_profile_cleanup_failed", retryable: false },
  });
  const lifecycle = createCleanupBoundAccountVerifiedLifecycle({
    browser,
    openRequest: openRequest(),
    reconcileOperationId: "operation_reconcileabcdef" as OperationId,
    advanceOperationId: "operation_advanceabcdefghijkl" as OperationId,
    closeOperationId: "operation_close_abcdefghijkl" as OperationId,
    now,
    runLifecycle: async () => ({
      ok: true,
      value: {
        kind: "account_ready",
        path: "verified_account",
        independentlyObserved: true,
        verificationCandidateCount: 1,
        verificationConsumed: true,
      },
    }),
  });

  assert.deepEqual(await lifecycle.run(new AbortController().signal), {
    ok: false,
    error: { code: "browser_profile_cleanup_failed" },
  });
});

test("monitor uncertainty during close is preserved after successful cleanup", async () => {
  const session = browserSession();
  const browser = fakeBrowser(session, []);
  browser.close = async () => ({
    ok: false,
    error: { code: "browser_effect_uncertain", retryable: false },
  });
  const lifecycle = createCleanupBoundAccountVerifiedLifecycle({
    browser,
    openRequest: openRequest(),
    reconcileOperationId: "operation_reconcilemonitor1" as OperationId,
    advanceOperationId: "operation_advancemonitor1234" as OperationId,
    closeOperationId: "operation_close_monitor123456" as OperationId,
    now,
    runLifecycle: async () => ({
      ok: true,
      value: {
        kind: "account_ready",
        path: "verified_account",
        independentlyObserved: true,
        verificationCandidateCount: 1,
        verificationConsumed: true,
      },
    }),
  });

  assert.deepEqual(await lifecycle.run(new AbortController().signal), {
    ok: false,
    error: { code: "browser_effect_uncertain" },
  });
});

test("thrown cleanup is the same stable cleanup denial", async () => {
  const session = browserSession();
  const browser = fakeBrowser(session, []);
  browser.close = async () => { throw new Error("private cleanup detail"); };
  const lifecycle = createCleanupBoundAccountVerifiedLifecycle({
    browser,
    openRequest: openRequest(),
    reconcileOperationId: "operation_reconcileabcdef" as OperationId,
    advanceOperationId: "operation_advanceabcdefghijkl" as OperationId,
    closeOperationId: "operation_close_abcdefghijkl" as OperationId,
    now,
    runLifecycle: async () => ({
      ok: true,
      value: {
        kind: "account_ready",
        path: "verified_account",
        independentlyObserved: true,
        verificationCandidateCount: 1,
        verificationConsumed: true,
      },
    }),
  });
  assert.deepEqual(await lifecycle.run(new AbortController().signal), {
    ok: false,
    error: { code: "browser_profile_cleanup_failed" },
  });
});

test("an already-failed invalidated session preserves its original failure", async () => {
  const session = browserSession();
  const browser = fakeBrowser(session, []);
  browser.close = async () => ({
    ok: false,
    error: { code: "browser_session_missing", retryable: false },
  });
  const lifecycle = createCleanupBoundAccountVerifiedLifecycle({
    browser,
    openRequest: openRequest(),
    reconcileOperationId: "operation_reconcileabcdef" as OperationId,
    advanceOperationId: "operation_advanceabcdefghijkl" as OperationId,
    closeOperationId: "operation_close_abcdefghijkl" as OperationId,
    now,
    runLifecycle: async () => ({
      ok: false,
      error: { code: "browser_effect_uncertain", retryable: false },
    }),
  });
  assert.deepEqual(await lifecycle.run(new AbortController().signal), {
    ok: false,
    error: { code: "browser_effect_uncertain" },
  });
});

test("authorization expiry cancels before the next privileged effect and still closes", async () => {
  const events: string[] = [];
  const session = browserSession();
  let current = now;
  const browser = fakeBrowser(session, events);
  const originalOpen = browser.open;
  browser.open = async () => {
    const opened = await originalOpen();
    current = "2026-08-02T02:30:00.000Z";
    return opened;
  };
  const lifecycle = createCleanupBoundAccountVerifiedLifecycle({
    browser,
    openRequest: openRequest(),
    reconcileOperationId: "operation_reconcileabcdef" as OperationId,
    advanceOperationId: "operation_advanceabcdefghijkl" as OperationId,
    closeOperationId: "operation_close_abcdefghijkl" as OperationId,
    now,
    clock: () => current,
    authorizationExpiresAt: "2026-08-02T02:30:00.000Z",
    runLifecycle: async () => {
      events.push("lifecycle");
      throw new Error("must not run after authorization expiry");
    },
  });

  assert.deepEqual(await lifecycle.run(new AbortController().signal), {
    ok: false,
    error: { code: "operation_cancelled" },
  });
  assert.deepEqual(events, ["open", "close"]);
});

test("production assembly shares raw vault and artifact registry without owner mode locking", async () => {
  const source = await readFile(
    new URL("../../src/composition/s2-account-verified-runner.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /const rawVault = new GmailRawArtifactVault\(\)/u);
  assert.match(source, /const artifacts = new GmailSafeArtifactRegistry\(\)/u);
  assert.match(source, /new GmailApiAuthExecutor\(\{[\s\S]*?rawVault,[\s\S]*?artifactRegistry: artifacts,/u);
  assert.match(source, /new GmailAtomicArtifactConsumer\(\{[\s\S]*?replayGuard: new Stage2VerificationReplayLedger/u);
  assert.match(source, /createGmailPrivilegedVerificationNavigator\(\{[\s\S]*?consumer,/u);
  assert.match(source, /createAccountEntryCredentialMutationAdapter\(\{/u);
  assert.match(source, /createVerificationEmailRequestAdapter\(\{[\s\S]*?approvalId: owner\.approval\.approvalId,[\s\S]*?operationId: operations\.requestVerificationEmail,[\s\S]*?sessionId: session\.sessionId,/u);
  assert.equal(source.includes("createStage2AccountEntryCredentialMutationAdapter"), false);
  assert.equal(source.includes("verificationTarget.toString"), false);
  assert.equal(source.includes("credential.email.toString"), false);
  assert.equal(source.includes("credential.password.toString"), false);
});

test("production assembly refreshes authorization time at every privileged boundary", async () => {
  const source = await readFile(
    new URL("../../src/composition/s2-account-verified-runner.ts", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("const now = new Date().toISOString()"), false);
  assert.match(source, /const liveClock = systemClock/u);
  assert.match(source, /new WindowsDpapiSecretStore\(\{[\s\S]*?now: liveClock,/u);
  assert.match(source, /new WindowsDpapiSecretResolver\(\{[\s\S]*?now: liveClock,/u);
  assert.match(source, /new GmailMailboxProvider\(\{[\s\S]*?now: liveClock,/u);
  assert.match(source, /createAuthorizationBoundLifecycleDependencies\(/u);
  assert.match(source, /createAuthorizationBoundEvidenceWriter\(/u);
  assert.match(source, /signal\.aborted \|\| authorizationSignal\?\.aborted/u);
});

test("account observer denies mismatched ownership before classified inspection", async () => {
  const session = browserSession();
  let inspections = 0;
  const observer = createBoundAccountStateObserver({
    async inspectClassifiedAccount() {
      inspections += 1;
      return { ok: true, value: { kind: "classification_stopped" } as never };
    },
  }, {
    journeyId: session.journeyId,
    sessionId: session.sessionId,
    target: session.target,
  });
  const result = await observer.observe({
    schemaVersion: 1,
    journeyId: "journey_wrongwrongwrongx" as never,
    sessionId: session.sessionId,
    target: session.target,
  }, new AbortController().signal);
  assert.deepEqual(result, {
    ok: false,
    error: { code: "browser_target_invalid", retryable: false },
  });
  assert.equal(inspections, 0);
});

function fakeBrowser(
  session: LiveBrowserSessionV1,
  events: string[],
  reconcileResult: PersistentBrowserReconcileResult = { kind: "matched", session },
) {
  return {
    async open() {
      events.push("open");
      return { ok: true, value: { kind: "opened", session } } as const;
    },
    async advanceToAccountEntry() {
      events.push("advance");
      return { ok: true, value: { kind: "account_boundary" } } as const;
    },
    async reconcile(): Promise<
      LivePortResult<PersistentBrowserReconcileResult, PersistentBrowserErrorCode>
    > {
      events.push("reconcile");
      return { ok: true, value: reconcileResult };
    },
    async close(): Promise<LivePortResult<void, PersistentBrowserErrorCode>> {
      events.push("close");
      return { ok: true, value: undefined };
    },
  };
}

function openRequest() {
  const session = browserSession();
  return {
    schemaVersion: 1 as const,
    journeyId: session.journeyId,
    operationId: "operation_open_abcdefghijkl" as OperationId,
    profileLeaseId: session.profileLeaseId,
    target: session.target,
  };
}

function browserSession(): LiveBrowserSessionV1 {
  return {
    schemaVersion: 1,
    journeyId: "journey_abcdefghijklmnop" as never,
    sessionId: "live_session_abcdefghijklmnop" as never,
    profileLeaseId: "profile_lease_abcdefghijklmnop" as never,
    target: {
      schemaVersion: 1,
      atsFamily: "workday",
      hostId: "host_abcdefghijklmnop" as never,
      tenantId: "tenant_abcdefghijklmnop" as never,
      postingId: "posting_abcdefghijklmnop" as never,
    },
    leaseExpiresAt: "2026-08-02T02:30:00.000Z",
  };
}

function operationIds() {
  return {
    browserOpen: "operation_open_abcdefghijkl" as OperationId,
    browserReconcile: "operation_reconcileabcdef" as OperationId,
    accountAdvance: "operation_advanceabcdefghijkl" as OperationId,
    lifecycle: "operation_lifecycleabcdefg" as OperationId,
    initialCredentialMutation: "operation_initial_abcdefgh" as OperationId,
    createCredentialMutation: "operation_create_abcdefgh" as OperationId,
    accountExistsSignIn: "operation_exists_abcdefgh" as OperationId,
    requestVerificationEmail: "operation_request_abcdefg" as OperationId,
    navigateVerification: "operation_navigateabcdefg" as OperationId,
    postVerificationSignIn: "operation_signin_abcdefgh" as OperationId,
    browserClose: "operation_close_abcdefghijkl" as OperationId,
    mailboxQuery: "mailbox_query_abcdefghijklmnop" as never,
  };
}

function ownerInputs(): RealRunOwnerInputsV1 {
  return {
    schemaVersion: 1,
    contractRevision: "s2-owner-inputs-v1",
    revisionId: "revision_abcdefghijklmnop",
    journeyId: "journey_abcdefghijklmnop",
    accountMode: "fresh_create",
    target: {
      handleId: "target_ref_abcdefghijklmnop",
      url: "https://cmu.wd5.myworkdayjobs.com/en-US/CMU/job/Test_2024584",
      host: "cmu.wd5.myworkdayjobs.com",
      tenant: "cmu",
      posting: "2024584",
    },
    profileRef: "profile_ref_abcdefghijklmnop",
    resumeRef: "resume_ref_abcdefghijklmnop",
    recipientBindingId: "recipient_abcdefghijklmnop",
    roots: {
      runtime: { rootId: "runtime_root_abcdefghijklmnop", path: "C:\\runtime", access: "current_user_only" },
      secrets: { rootId: "secrets_root_abcdefghijklmnop", path: "C:\\secrets", access: "current_user_only" },
      evidence: { rootId: "evidence_root_abcdefghijklmnop", path: "C:\\evidence", access: "current_user_only" },
    },
    policy: { cleanupLeaseHours: 24, retentionDays: 30 },
    approval: {
      schemaVersion: 1,
      approvalId: "approval_abcdefghijklmnop",
      journeyId: "journey_abcdefghijklmnop",
      revisionId: "revision_abcdefghijklmnop",
      approved: true,
      liveAccess: true,
      approvedAt: "2026-08-02T02:00:00.000Z",
      expiresAt: "2026-08-02T02:30:00.000Z",
      ownerId: "owner_abcdefghijklmnop",
      runtimeOperatorId: "owner_abcdefghijklmnop",
      secretCustodianId: "owner_abcdefghijklmnop",
      evidenceCustodianId: "owner_abcdefghijklmnop",
    },
    adapters: { secretStore: "windows-dpapi-current-user-v1", mailboxProvider: "gmail-api-v1" },
    accountSecret: {
      schemaVersion: 1,
      handleId: "secret_handle_accountabcdefghijkl",
      journeyId: "journey_abcdefghijklmnop",
      provider: "windows-dpapi-current-user-v1",
      purpose: "account_credentials",
      consumer: "credential_mutation_adapter",
      scope: "account_access",
      expiresAt: "2026-08-02T02:30:00.000Z",
    },
    gmailAuthorization: {
      schemaVersion: 1,
      handleId: "secret_handle_gmailabcdefghijklxx",
      journeyId: "journey_abcdefghijklmnop",
      provider: "windows-dpapi-current-user-v1",
      purpose: "gmail_oauth",
      consumer: "gmail_auth_executor",
      scope: "mailbox_verification",
      expiresAt: "2026-08-02T02:30:00.000Z",
    },
  };
}
