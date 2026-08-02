import assert from "node:assert/strict";
import test from "node:test";

import type {
  LivePortResult,
  VerificationArtifact,
  VerificationNavigationErrorCode,
  VerificationNavigationResult,
} from "../../../../src/contracts/live/index.ts";
import { liveFixtures } from "../../../../src/testing/live/index.ts";
import { GmailAtomicArtifactConsumer } from "../../../../src/mailbox/providers/gmail/private/atomic-artifact-consumer.ts";
import {
  createGmailPrivilegedVerificationNavigator,
  type ByteScopedVerificationBrowserCapability,
  type GmailVerificationPolicyCapability,
} from "../../../../src/mailbox/providers/gmail/private/privileged-verification-navigator.ts";
import { GmailRawArtifactVault } from "../../../../src/mailbox/providers/gmail/private/raw-artifact-vault.ts";
import { GmailSafeArtifactRegistry } from "../../../../src/mailbox/providers/gmail/safe-artifact-registry.ts";

const text = (value: string) => new TextEncoder().encode(value);
const rawTarget = () => text("https://tenant.example.invalid/verify?token=private");
const approvedHost = () => text("tenant.example.invalid");
const approvedTenant = () => text("example-tenant");

function navigationRequest() {
  return {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    operationId: liveFixtures.operationIds.verificationNavigation,
    sessionId: liveFixtures.session.sessionId,
    expectedRecipientBindingId:
      liveFixtures.verificationArtifact.recipientBindingId,
    expectedTarget: liveFixtures.target,
    now: liveFixtures.issuedAt,
    artifact: liveFixtures.verificationArtifact,
  };
}

function harness(options: {
  readonly browserResult?: LivePortResult<
    VerificationNavigationResult,
    Exclude<VerificationNavigationErrorCode, "verification_artifact_replayed">
  >;
  readonly policyHost?: string;
  readonly policyTenant?: string;
  readonly policyThrows?: boolean;
} = {}) {
  const rawVault = new GmailRawArtifactVault();
  const artifacts = new GmailSafeArtifactRegistry();
  const delegate: VerificationArtifact = {
    async inspect() {
      return { ok: true, value: liveFixtures.verificationArtifact };
    },
    async invalidate() {
      return { ok: true, value: undefined };
    },
  };
  const target = rawTarget();
  const boundHost = approvedHost();
  const boundTenant = approvedTenant();
  const pending = rawVault.stage([{
    metadata: liveFixtures.verificationArtifact,
    operationId: liveFixtures.operationIds.verificationNavigation,
    target,
    policy: { host: boundHost, tenant: boundTenant },
  }]);
  assert.equal(pending.commit(liveFixtures.verificationArtifact.handleId), true);
  assert.equal(
    artifacts.register(
      liveFixtures.verificationArtifact.handleId,
      delegate,
      () => rawVault.invalidate(liveFixtures.verificationArtifact.handleId),
    ),
    true,
  );

  let policyCalls = 0;
  let browserCalls = 0;
  let browserViews: readonly Readonly<Uint8Array>[] = [];
  const policyViews: Uint8Array[] = [];
  const approvedPolicy: GmailVerificationPolicyCapability = {
    async use(operation) {
      policyCalls += 1;
      if (options.policyThrows) throw new Error("private-policy-detail");
      const host = text(options.policyHost ?? "tenant.example.invalid");
      const tenant = text(options.policyTenant ?? "example-tenant");
      policyViews.push(host, tenant);
      try {
        return await operation({ host, tenant });
      } finally {
        host.fill(0);
        tenant.fill(0);
      }
    },
  };
  const browser: ByteScopedVerificationBrowserCapability = {
    async navigateVerificationTarget(request) {
      browserCalls += 1;
      browserViews = [
        request.verificationTarget,
        request.approvedHost,
        request.approvedTenant,
      ];
      return options.browserResult ?? {
        ok: true,
        value: { kind: "navigated", accountState: "private" },
      } as never;
    },
  };
  const navigator = createGmailPrivilegedVerificationNavigator({
    consumer: new GmailAtomicArtifactConsumer({ rawVault, artifacts }),
    approvedPolicy,
    browser,
  });
  return {
    navigator,
    rawVault,
    target,
    boundHost,
    boundTenant,
    policyViews,
    browserViews: () => browserViews,
    policyCalls: () => policyCalls,
    browserCalls: () => browserCalls,
  };
}

test("bridge rechecks current policy, forwards bytes once, strips private output, and replays exact success", async () => {
  const current = harness();
  const first = await current.navigator.navigate(
    navigationRequest(),
    new AbortController().signal,
  );
  assert.deepEqual(first, { ok: true, value: { kind: "navigated" } });
  assert.equal(current.policyCalls(), 1);
  assert.equal(current.browserCalls(), 1);
  assert.equal(current.rawVault.committedCount, 0);
  for (const value of [
    current.target,
    current.boundHost,
    current.boundTenant,
    ...current.browserViews(),
    ...current.policyViews,
  ]) {
    assert.deepEqual([...value], new Array(value.length).fill(0));
  }

  assert.deepEqual(
    await current.navigator.navigate(
      navigationRequest(),
      new AbortController().signal,
    ),
    first,
  );
  assert.equal(current.policyCalls(), 1);
  assert.equal(current.browserCalls(), 1);
  assert.deepEqual(
    await current.navigator.navigate(
      { ...navigationRequest(), now: "2026-08-01T12:00:00.001Z" },
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "verification_artifact_replayed", retryable: false },
    },
  );
});

test("bridge preserves every exact browser failure and cancellation after one consume", async () => {
  const failures = [
    { code: "verification_navigation_denied", retryable: false },
    { code: "browser_timeout", retryable: true },
    { code: "browser_effect_uncertain", retryable: false },
    { code: "operation_cancelled", retryable: false },
  ] as const;
  for (const error of failures) {
    const current = harness({ browserResult: { ok: false, error } });
    assert.deepEqual(
      await current.navigator.navigate(
        navigationRequest(),
        new AbortController().signal,
      ),
      { ok: false, error },
    );
    assert.equal(current.policyCalls(), 1, error.code);
    assert.equal(current.browserCalls(), 1, error.code);
    assert.equal(current.rawVault.committedCount, 0, error.code);
    assert.deepEqual(
      await current.navigator.navigate(
        navigationRequest(),
        new AbortController().signal,
      ),
      {
        ok: false,
        error: { code: "verification_artifact_replayed", retryable: false },
      },
    );
  }
});

test("policy mismatch or failure denies navigation without exposing or retaining values", async () => {
  for (const current of [
    harness({ policyHost: "other.example.invalid" }),
    harness({ policyTenant: "other-tenant" }),
    harness({ policyThrows: true }),
  ]) {
    const result = await current.navigator.navigate(
      navigationRequest(),
      new AbortController().signal,
    );
    assert.deepEqual(result, {
      ok: false,
      error: { code: "verification_navigation_denied", retryable: false },
    });
    assert.equal(current.browserCalls(), 0);
    assert.equal(current.rawVault.committedCount, 0);
    assert.doesNotMatch(JSON.stringify(result), /private|example|tenant|verify|token/u);
    for (const value of [
      current.target,
      current.boundHost,
      current.boundTenant,
      ...current.policyViews,
    ]) {
      assert.deepEqual([...value], new Array(value.length).fill(0));
    }
  }
});

test("malformed browser results are denied instead of crossing the safe port", async () => {
  for (const browserResult of [
    { ok: true, value: { kind: "private" } },
    { ok: false, error: { code: "private_error" } },
    { ok: false, error: { code: "browser_timeout", retryable: false } },
  ] as const) {
    const current = harness({ browserResult: browserResult as never });
    assert.deepEqual(
      await current.navigator.navigate(
        navigationRequest(),
        new AbortController().signal,
      ),
      {
        ok: false,
        error: { code: "verification_navigation_denied", retryable: false },
      },
    );
    assert.equal(current.rawVault.committedCount, 0);
  }
});
