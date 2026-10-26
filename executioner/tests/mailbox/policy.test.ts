import assert from "node:assert/strict";
import test from "node:test";

import {
  generatedOperationId,
  journeyId,
} from "../../src/contracts/index.ts";
import type {
  LiveIdentifier,
  MailboxPollRequest,
  RecipientBindingId,
  TargetHostId,
  TargetIdentityV1,
  TargetPostingId,
  TargetTenantId,
  VerificationHandleId,
} from "../../src/contracts/live/index.ts";
import {
  createBoundedMailboxPolicy,
  type BoundedMailboxCandidate,
  type SenderPolicyId,
} from "../../src/mailbox/policy.ts";

const opaque = <Kind extends string>(value: string) =>
  value as LiveIdentifier<Kind>;

const primaryJourney = journeyId("journey_1111111111111111");
const recipient = opaque<"recipient">(
  "recipient_1111111111111111",
) as RecipientBindingId;
const senderPolicy = opaque<"sender_policy">(
  "sender_policy_1111111111111111",
) as SenderPolicyId;
const target: TargetIdentityV1 = {
  schemaVersion: 1,
  atsFamily: "workday",
  hostId: opaque<"host">("host_1111111111111111") as TargetHostId,
  tenantId: opaque<"tenant">("tenant_1111111111111111") as TargetTenantId,
  postingId: opaque<"posting">("posting_1111111111111111") as TargetPostingId,
};
const notBefore = "2026-08-01T12:00:00.000Z";
const notAfter = "2026-08-01T12:15:00.000Z";
const now = "2026-08-01T12:06:00.000Z";
const handle = opaque<"verification_handle">(
  "verification_handle_1111111111111111",
) as VerificationHandleId;

const request: MailboxPollRequest = {
  schemaVersion: 1,
  journeyId: primaryJourney,
  queryId: opaque<"mailbox_query">("mailbox_query_1111111111111111"),
  recipientBindingId: recipient,
  target,
  notBefore,
  notAfter,
};

const availableCandidate: BoundedMailboxCandidate = {
  provider: "gmail_api_v1",
  journeyId: primaryJourney,
  recipientBindingId: recipient,
  senderPolicyId: senderPolicy,
  target,
  receivedAt: "2026-08-01T12:05:30.000Z",
  expiresAt: "2026-08-01T12:20:00.000Z",
  verificationHandle: handle,
  state: "available",
};

test("returns only the frozen safe fields for one bounded available candidate", async () => {
  const policy = createBoundedMailboxPolicy({
    binding: {
      journeyId: primaryJourney,
      recipientBindingId: recipient,
      senderPolicyId: senderPolicy,
      target,
      notBefore,
      notAfter,
    },
    clock: () => now,
    timeoutMs: 100,
    candidateSource: {
      async query() {
        return { ok: true, value: [availableCandidate] };
      },
    },
  });

  const result = await policy.mailboxProvider.poll(
    request,
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      provider: "gmail_api_v1",
      receivedTimeBucket: "2026-08-01T12:05Z",
      expiresAt: "2026-08-01T12:20:00.000Z",
      candidateCount: 1,
      verificationHandle: handle,
    },
  });
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.value).sort(), [
    "candidateCount",
    "expiresAt",
    "provider",
    "receivedTimeBucket",
    "verificationHandle",
  ]);
});

test("preserves none, ambiguous, expired, consumed, and available facts", async () => {
  const laterCandidate: BoundedMailboxCandidate = {
    ...availableCandidate,
    receivedAt: "2026-08-01T12:07:30.000Z",
    expiresAt: "2026-08-01T12:22:00.000Z",
    verificationHandle: opaque<"verification_handle">(
      "verification_handle_2222222222222222",
    ) as VerificationHandleId,
  };
  const cases = [
    {
      candidates: [],
      expected: {
        provider: "gmail_api_v1",
        receivedTimeBucket: null,
        expiresAt: null,
        candidateCount: 0,
        verificationHandle: null,
      },
    },
    {
      candidates: [availableCandidate, laterCandidate],
      expected: {
        provider: "gmail_api_v1",
        receivedTimeBucket: "2026-08-01T12:07Z",
        expiresAt: "2026-08-01T12:22:00.000Z",
        candidateCount: 2,
        verificationHandle: null,
      },
    },
    {
      candidates: [
        {
          ...availableCandidate,
          state: "expired" as const,
          expiresAt: "2026-08-01T12:05:59.000Z",
        },
      ],
      expected: {
        provider: "gmail_api_v1",
        receivedTimeBucket: "2026-08-01T12:05Z",
        expiresAt: "2026-08-01T12:05:59.000Z",
        candidateCount: 1,
        verificationHandle: null,
      },
    },
    {
      candidates: [{ ...availableCandidate, state: "consumed" as const }],
      expected: {
        provider: "gmail_api_v1",
        receivedTimeBucket: "2026-08-01T12:05Z",
        expiresAt: "2026-08-01T12:20:00.000Z",
        candidateCount: 1,
        verificationHandle: null,
      },
    },
    {
      candidates: [availableCandidate],
      expected: {
        provider: "gmail_api_v1",
        receivedTimeBucket: "2026-08-01T12:05Z",
        expiresAt: "2026-08-01T12:20:00.000Z",
        candidateCount: 1,
        verificationHandle: handle,
      },
    },
  ] as const;

  for (const [index, current] of cases.entries()) {
    const policy = createBoundedMailboxPolicy({
      binding: {
        journeyId: primaryJourney,
        recipientBindingId: recipient,
        senderPolicyId: senderPolicy,
        target,
        notBefore,
        notAfter,
      },
      clock: () => now,
      timeoutMs: 100,
      candidateSource: {
        async query() {
          return { ok: true, value: current.candidates };
        },
      },
    });
    const result = await policy.mailboxProvider.poll(
      { ...request, queryId: opaque<"mailbox_query">(`mailbox_query_case_${index}`) },
      new AbortController().signal,
    );
    assert.deepEqual(result, { ok: true, value: current.expected });
  }
});

test("rejects every request binding mismatch before querying the source", async () => {
  let sourceCalls = 0;
  const policy = createBoundedMailboxPolicy({
    binding: {
      journeyId: primaryJourney,
      recipientBindingId: recipient,
      senderPolicyId: senderPolicy,
      target,
      notBefore,
      notAfter,
    },
    clock: () => now,
    timeoutMs: 100,
    candidateSource: {
      async query() {
        sourceCalls += 1;
        return { ok: true, value: [availableCandidate] };
      },
    },
  });
  const other = (kind: string) => opaque<never>(`${kind}_2222222222222222`);
  const mismatches: readonly MailboxPollRequest[] = [
    { ...request, journeyId: journeyId("journey_2222222222222222") },
    {
      ...request,
      recipientBindingId: other("recipient") as RecipientBindingId,
    },
    {
      ...request,
      target: { ...target, hostId: other("host") as TargetHostId },
    },
    {
      ...request,
      target: { ...target, tenantId: other("tenant") as TargetTenantId },
    },
    {
      ...request,
      target: { ...target, postingId: other("posting") as TargetPostingId },
    },
    { ...request, notBefore: "2026-08-01T12:00:00.001Z" },
    { ...request, notAfter: "2026-08-01T12:14:59.999Z" },
  ];

  for (const mismatch of mismatches) {
    assert.deepEqual(
      await policy.mailboxProvider.poll(
        mismatch,
        new AbortController().signal,
      ),
      {
        ok: false,
        error: { code: "mailbox_query_invalid", retryable: false },
      },
    );
  }
  assert.equal(sourceCalls, 0);
});

test("rejects candidates outside journey, recipient, sender, target, or time bounds", async () => {
  const other = (kind: string) => opaque<never>(`${kind}_2222222222222222`);
  const invalidCandidates: readonly BoundedMailboxCandidate[] = [
    {
      ...availableCandidate,
      journeyId: journeyId("journey_2222222222222222"),
    },
    {
      ...availableCandidate,
      recipientBindingId: other("recipient") as RecipientBindingId,
    },
    {
      ...availableCandidate,
      senderPolicyId: other("sender_policy") as SenderPolicyId,
    },
    {
      ...availableCandidate,
      target: { ...target, hostId: other("host") as TargetHostId },
    },
    {
      ...availableCandidate,
      target: { ...target, tenantId: other("tenant") as TargetTenantId },
    },
    {
      ...availableCandidate,
      target: { ...target, postingId: other("posting") as TargetPostingId },
    },
    { ...availableCandidate, receivedAt: "2026-08-01T11:59:59.999Z" },
    { ...availableCandidate, receivedAt: "2026-08-01T12:15:00.001Z" },
    { ...availableCandidate, expiresAt: "2026-08-01T12:05:00.000Z" },
    { ...availableCandidate, state: "expired" },
  ];

  for (const [index, candidate] of invalidCandidates.entries()) {
    const policy = createBoundedMailboxPolicy({
      binding: {
        journeyId: primaryJourney,
        recipientBindingId: recipient,
        senderPolicyId: senderPolicy,
        target,
        notBefore,
        notAfter,
      },
      clock: () => now,
      timeoutMs: 100,
      candidateSource: {
        async query() {
          return { ok: true, value: [candidate] };
        },
      },
    });
    assert.deepEqual(
      await policy.mailboxProvider.poll(
        { ...request, queryId: opaque<"mailbox_query">(`mailbox_query_bad_${index}`) },
        new AbortController().signal,
      ),
      {
        ok: false,
        error: { code: "mailbox_query_invalid", retryable: false },
      },
    );
  }
});

test("replays the same query from one stable factual snapshot without re-querying", async () => {
  let sourceCalls = 0;
  const policy = createBoundedMailboxPolicy({
    binding: {
      journeyId: primaryJourney,
      recipientBindingId: recipient,
      senderPolicyId: senderPolicy,
      target,
      notBefore,
      notAfter,
    },
    clock: () => now,
    timeoutMs: 100,
    candidateSource: {
      async query() {
        sourceCalls += 1;
        return sourceCalls === 1
          ? { ok: true as const, value: [availableCandidate] }
          : { ok: true as const, value: [] };
      },
    },
  });

  const first = await policy.mailboxProvider.poll(
    request,
    new AbortController().signal,
  );
  const replay = await policy.mailboxProvider.poll(
    { ...request },
    new AbortController().signal,
  );

  assert.deepEqual(replay, first);
  assert.equal(sourceCalls, 1);
});

test("recognizes the same artifact metadata independent of target key order", async () => {
  let sourceCalls = 0;
  const reorderedTarget: TargetIdentityV1 = {
    postingId: target.postingId,
    tenantId: target.tenantId,
    hostId: target.hostId,
    atsFamily: "workday",
    schemaVersion: 1,
  };
  const policy = createBoundedMailboxPolicy({
    binding: {
      journeyId: primaryJourney,
      recipientBindingId: recipient,
      senderPolicyId: senderPolicy,
      target,
      notBefore,
      notAfter,
    },
    clock: () => now,
    timeoutMs: 100,
    candidateSource: {
      async query() {
        sourceCalls += 1;
        return {
          ok: true,
          value: [
            sourceCalls === 1
              ? availableCandidate
              : { ...availableCandidate, target: reorderedTarget },
          ],
        };
      },
    },
  });

  const first = await policy.mailboxProvider.poll(
    request,
    new AbortController().signal,
  );
  const second = await policy.mailboxProvider.poll(
    {
      ...request,
      queryId: opaque<"mailbox_query">("mailbox_query_2222222222222222"),
    },
    new AbortController().signal,
  );
  assert.deepEqual(second, first);
  assert.equal(sourceCalls, 2);
});

test("inspects and invalidates one journey-scoped artifact exactly once", async () => {
  const policy = createBoundedMailboxPolicy({
    binding: {
      journeyId: primaryJourney,
      recipientBindingId: recipient,
      senderPolicyId: senderPolicy,
      target,
      notBefore,
      notAfter,
    },
    clock: () => now,
    timeoutMs: 100,
    candidateSource: {
      async query() {
        return { ok: true, value: [availableCandidate] };
      },
    },
  });
  await policy.mailboxProvider.poll(request, new AbortController().signal);

  const inspectRequest = {
    schemaVersion: 1 as const,
    journeyId: primaryJourney,
    handleId: handle,
    expectedRecipientBindingId: recipient,
    expectedTarget: target,
  };
  assert.deepEqual(
    await policy.verificationArtifact.inspect(
      inspectRequest,
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        schemaVersion: 1,
        handleId: handle,
        journeyId: primaryJourney,
        provider: "gmail_api_v1",
        recipientBindingId: recipient,
        target,
        issuedAt: availableCandidate.receivedAt,
        expiresAt: availableCandidate.expiresAt,
        state: "available",
      },
    },
  );

  const invalidateRequest = {
    schemaVersion: 1 as const,
    journeyId: primaryJourney,
    operationId: generatedOperationId("operation_1111111111111111"),
    handleId: handle,
  };
  assert.deepEqual(
    await policy.verificationArtifact.invalidate(
      invalidateRequest,
      new AbortController().signal,
    ),
    { ok: true, value: undefined },
  );
  assert.deepEqual(
    await policy.verificationArtifact.inspect(
      inspectRequest,
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        schemaVersion: 1,
        handleId: handle,
        journeyId: primaryJourney,
        provider: "gmail_api_v1",
        recipientBindingId: recipient,
        target,
        issuedAt: availableCandidate.receivedAt,
        expiresAt: availableCandidate.expiresAt,
        state: "invalidated",
      },
    },
  );
  assert.deepEqual(
    await policy.verificationArtifact.invalidate(
      invalidateRequest,
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "verification_artifact_replayed", retryable: false },
    },
  );

  const replay = await policy.mailboxProvider.poll(
    request,
    new AbortController().signal,
  );
  assert.deepEqual(replay, {
    ok: true,
    value: {
      provider: "gmail_api_v1",
      receivedTimeBucket: "2026-08-01T12:05Z",
      expiresAt: "2026-08-01T12:20:00.000Z",
      candidateCount: 1,
      verificationHandle: null,
    },
  });
});

test("cancellation and timeout stop one source call without retrying", async () => {
  const pendingSource = () => {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      source: {
        async query(_request: unknown, signal: AbortSignal) {
          calls += 1;
          return await new Promise<never>((_resolve) => {
            signal.addEventListener("abort", () => undefined, { once: true });
          });
        },
      },
    };
  };
  const binding = {
    journeyId: primaryJourney,
    recipientBindingId: recipient,
    senderPolicyId: senderPolicy,
    target,
    notBefore,
    notAfter,
  };

  const neverStarted = pendingSource();
  const cancelledBeforeStart = createBoundedMailboxPolicy({
    binding,
    clock: () => now,
    timeoutMs: 100,
    candidateSource: neverStarted.source,
  });
  assert.deepEqual(
    await cancelledBeforeStart.mailboxProvider.poll(
      request,
      AbortSignal.abort(),
    ),
    {
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    },
  );
  assert.equal(neverStarted.calls, 0);

  const cancelledSource = pendingSource();
  const cancelledPolicy = createBoundedMailboxPolicy({
    binding,
    clock: () => now,
    timeoutMs: 1_000,
    candidateSource: cancelledSource.source,
  });
  const controller = new AbortController();
  const cancelledPoll = cancelledPolicy.mailboxProvider.poll(
    request,
    controller.signal,
  );
  controller.abort();
  assert.deepEqual(await cancelledPoll, {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
  assert.equal(cancelledSource.calls, 1);

  const timedOutSource = pendingSource();
  const timedOutPolicy = createBoundedMailboxPolicy({
    binding,
    clock: () => now,
    timeoutMs: 5,
    candidateSource: timedOutSource.source,
  });
  assert.deepEqual(
    await timedOutPolicy.mailboxProvider.poll(
      { ...request, queryId: opaque<"mailbox_query">("mailbox_query_timeout_1") },
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "mailbox_timeout", retryable: true },
    },
  );
  assert.equal(timedOutSource.calls, 1);
});

test("passes exact provider failures through once without scheduling a retry", async () => {
  let calls = 0;
  const policy = createBoundedMailboxPolicy({
    binding: {
      journeyId: primaryJourney,
      recipientBindingId: recipient,
      senderPolicyId: senderPolicy,
      target,
      notBefore,
      notAfter,
    },
    clock: () => now,
    timeoutMs: 100,
    candidateSource: {
      async query() {
        calls += 1;
        return {
          ok: false,
          error: { code: "gmail_rate_limited", retryable: true },
        } as const;
      },
    },
  });

  assert.deepEqual(
    await policy.mailboxProvider.poll(request, new AbortController().signal),
    {
      ok: false,
      error: { code: "gmail_rate_limited", retryable: true },
    },
  );
  assert.equal(calls, 1);
});

test("rejects invalid construction bounds and an invalid injected clock", async () => {
  const base = {
    binding: {
      journeyId: primaryJourney,
      recipientBindingId: recipient,
      senderPolicyId: senderPolicy,
      target,
      notBefore,
      notAfter,
    },
    clock: () => now,
    timeoutMs: 100,
    candidateSource: {
      async query() {
        return { ok: true as const, value: [availableCandidate] };
      },
    },
  };

  assert.throws(
    () => createBoundedMailboxPolicy({ ...base, timeoutMs: 0 }),
    /invalid mailbox policy configuration/u,
  );
  assert.throws(
    () => createBoundedMailboxPolicy({ ...base, timeoutMs: 60_001 }),
    /invalid mailbox policy configuration/u,
  );
  assert.throws(
    () => createBoundedMailboxPolicy({
      ...base,
      binding: {
        ...base.binding,
        senderPolicyId: "unreviewed" as SenderPolicyId,
      },
    }),
    /invalid mailbox policy configuration/u,
  );
  assert.throws(
    () => createBoundedMailboxPolicy({
      ...base,
      binding: { ...base.binding, notAfter: "not-an-instant" },
    }),
    /invalid mailbox policy configuration/u,
  );
  assert.throws(
    () => createBoundedMailboxPolicy({
      ...base,
      binding: {
        ...base.binding,
        notBefore: notAfter,
        notAfter: notBefore,
      },
    }),
    /invalid mailbox policy configuration/u,
  );

  const invalidClock = createBoundedMailboxPolicy({
    ...base,
    clock: () => "not-an-instant",
  });
  assert.deepEqual(
    await invalidClock.mailboxProvider.poll(
      request,
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "mailbox_query_invalid", retryable: false },
    },
  );

  const throwingClock = createBoundedMailboxPolicy({
    ...base,
    clock() {
      throw new Error("synthetic-clock-value.invalid");
    },
  });
  assert.deepEqual(
    await throwingClock.mailboxProvider.poll(
      request,
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "mailbox_query_invalid", retryable: false },
    },
  );
});

test("artifact access fails closed on every identity dimension and expiry", async () => {
  let currentTime = now;
  const policy = createBoundedMailboxPolicy({
    binding: {
      journeyId: primaryJourney,
      recipientBindingId: recipient,
      senderPolicyId: senderPolicy,
      target,
      notBefore,
      notAfter,
    },
    clock: () => currentTime,
    timeoutMs: 100,
    candidateSource: {
      async query() {
        return { ok: true, value: [availableCandidate] };
      },
    },
  });
  await policy.mailboxProvider.poll(request, new AbortController().signal);
  const baseInspect = {
    schemaVersion: 1 as const,
    journeyId: primaryJourney,
    handleId: handle,
    expectedRecipientBindingId: recipient,
    expectedTarget: target,
  };
  const other = (kind: string) => opaque<never>(`${kind}_3333333333333333`);
  const replayMismatches = [
    { ...baseInspect, journeyId: journeyId("journey_3333333333333333") },
    {
      ...baseInspect,
      handleId: other("verification_handle") as VerificationHandleId,
    },
    {
      ...baseInspect,
      expectedRecipientBindingId: other("recipient") as RecipientBindingId,
    },
  ] as const;
  for (const mismatch of replayMismatches) {
    assert.deepEqual(
      await policy.verificationArtifact.inspect(
        mismatch,
        new AbortController().signal,
      ),
      {
        ok: false,
        error: { code: "verification_artifact_replayed", retryable: false },
      },
    );
  }
  const targetMismatches = [
    { ...target, hostId: other("host") as TargetHostId },
    { ...target, tenantId: other("tenant") as TargetTenantId },
    { ...target, postingId: other("posting") as TargetPostingId },
  ] as const;
  for (const expectedTarget of targetMismatches) {
    assert.deepEqual(
      await policy.verificationArtifact.inspect(
        { ...baseInspect, expectedTarget },
        new AbortController().signal,
      ),
      {
        ok: false,
        error: { code: "mailbox_query_invalid", retryable: false },
      },
    );
  }

  assert.deepEqual(
    await policy.verificationArtifact.inspect(baseInspect, AbortSignal.abort()),
    {
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    },
  );
  currentTime = availableCandidate.expiresAt;
  const expired = await policy.verificationArtifact.inspect(
    baseInspect,
    new AbortController().signal,
  );
  assert.equal(expired.ok && expired.value.state, "expired");
  assert.deepEqual(
    await policy.verificationArtifact.invalidate(
      {
        schemaVersion: 1,
        journeyId: primaryJourney,
        operationId: generatedOperationId("operation_3333333333333333"),
        handleId: handle,
      },
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "verification_artifact_replayed", retryable: false },
    },
  );
});

test("reconstructs provider failures without retaining untrusted diagnostics", async () => {
  const policy = createBoundedMailboxPolicy({
    binding: {
      journeyId: primaryJourney,
      recipientBindingId: recipient,
      senderPolicyId: senderPolicy,
      target,
      notBefore,
      notAfter,
    },
    clock: () => now,
    timeoutMs: 100,
    candidateSource: {
      async query() {
        return {
          ok: false,
          error: {
            code: "gmail_rate_limited",
            retryable: true,
            diagnostic: "synthetic-provider-value.invalid",
          },
        } as never;
      },
    },
  });

  assert.deepEqual(
    await policy.mailboxProvider.poll(request, new AbortController().signal),
    {
      ok: false,
      error: { code: "gmail_rate_limited", retryable: true },
    },
  );
});
