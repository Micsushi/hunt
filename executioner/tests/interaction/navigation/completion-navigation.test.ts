import assert from "node:assert/strict";
import { test } from "node:test";

import {
  browserPageId,
  browserTargetToken,
  boundedText,
  fieldId,
  generatedOperationId,
  type PageIdentity,
  type SemanticPageSnapshot,
  type VerificationResult,
} from "../../../src/contracts/index.ts";
import { contractFixtures } from "../../../src/testing/contracts/index.ts";
import { createCompletionNavigation } from "../../../src/interaction/navigation/completion-navigation.ts";

const requiredPage = {
  pageIdentity: { kind: "workday", page: "profile" },
  fields: [
    {
      fieldId: fieldId("required"),
      target: browserTargetToken("target-required"),
      label: boundedText("Required"),
      required: true,
      behavior: "text",
      options: [],
      state: "populated",
    },
    {
      fieldId: fieldId("optional"),
      target: browserTargetToken("target-optional"),
      label: boundedText("Optional"),
      required: false,
      behavior: "text",
      options: [],
      state: "empty",
    },
  ],
} as const satisfies SemanticPageSnapshot;

const requiredFieldId = fieldId("required");

test("approves exactly one legal next step after every required field is verified", async () => {
  const provider = createCompletionNavigation();

  assert.deepEqual(
    await provider.complete(
      {
        page: requiredPage,
        verification: [{ kind: "verified", fieldId: requiredFieldId }],
      },
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        kind: "complete",
        decision: {
          kind: "next",
          expectedPage: "questionnaire",
        },
      },
    },
  );
});

const blockingResults: readonly {
  name: string;
  verification: readonly VerificationResult[];
}[] = [
  { name: "missing", verification: [] },
  {
    name: "rejected",
    verification: [
      { kind: "rejected", fieldId: requiredFieldId, reason: "mismatch" },
    ],
  },
  {
    name: "ambiguous",
    verification: [{ kind: "ambiguous", fieldId: requiredFieldId }],
  },
  {
    name: "unavailable",
    verification: [{ kind: "unavailable", fieldId: requiredFieldId }],
  },
  {
    name: "conflicting",
    verification: [
      { kind: "verified", fieldId: requiredFieldId },
      { kind: "rejected", fieldId: requiredFieldId, reason: "stale" },
    ],
  },
];

for (const scenario of blockingResults) {
  test(`blocks navigation for ${scenario.name} required-field verification`, async () => {
    const provider = createCompletionNavigation();

    assert.deepEqual(
      await provider.complete(
        {
          page: requiredPage,
          verification: scenario.verification,
        },
        new AbortController().signal,
      ),
      {
        ok: true,
        value: {
          kind: "blocked",
          fieldIds: [requiredFieldId],
          decision: { kind: "blocked" },
        },
      },
    );
  });
}

test("uses the explicit Workday transition map", async () => {
  const provider = createCompletionNavigation();
  const cases = [
    ["account", { kind: "next", expectedPage: "profile" }],
    ["profile", { kind: "next", expectedPage: "questionnaire" }],
    ["questionnaire", { kind: "next", expectedPage: "review" }],
    ["review", { kind: "stop_review" }],
  ] as const;

  for (const [page, decision] of cases) {
    assert.deepEqual(
      await provider.complete(
        {
          page: {
            pageIdentity: { kind: "workday", page },
            fields: [],
          },
          verification: [],
        },
        new AbortController().signal,
      ),
      {
        ok: true,
        value: {
          kind: "complete",
          decision,
        },
      },
    );
  }
});

test("Review is terminal even when its summary contains required fields", async () => {
  const provider = createCompletionNavigation();

  assert.deepEqual(
    await provider.complete(
      {
        page: {
          ...requiredPage,
          pageIdentity: { kind: "workday", page: "review" },
        },
        verification: [],
      },
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        kind: "complete",
        decision: { kind: "stop_review" },
      },
    },
  );
});

test("blocks unknown and ambiguous pages without navigation approval", async () => {
  const provider = createCompletionNavigation();

  for (const pageIdentity of [
    { kind: "unknown" },
    { kind: "ambiguous" },
  ] as const) {
    assert.deepEqual(
      await provider.complete(
        {
          page: { pageIdentity, fields: [] },
          verification: [],
        },
        new AbortController().signal,
      ),
      {
        ok: true,
        value: {
          kind: "blocked",
          fieldIds: [],
          decision: { kind: "blocked" },
        },
      },
    );
  }
});

function reconciliation(
  expected: PageIdentity,
  observed: PageIdentity = expected,
) {
  const sourcePage = expected.kind === "workday"
    ? expected.page === "questionnaire"
      ? { kind: "workday", page: "profile" } as const
      : expected.page === "review"
        ? { kind: "workday", page: "questionnaire" } as const
        : { kind: "workday", page: "account" } as const
    : { kind: "unknown" } as const;
  return {
    operationId: contractFixtures.mutationReceipt.operationId,
    decision: {
      kind: "next",
      expectedPage:
        expected.kind === "workday" && expected.page !== "account"
          ? expected.page
          : "profile",
    },
    observation: {
      operationId: contractFixtures.mutationReceipt.operationId,
      fromPageId: browserPageId("page-before"),
      pageId: browserPageId("page-after"),
    },
    sourcePage,
    expected,
    observed,
  } as const;
}

test("reconciles the approved expected transition against independent observed state", async () => {
  const provider = createCompletionNavigation();

  assert.deepEqual(
    await provider.reconcile(
      reconciliation(
        { kind: "workday", page: "questionnaire" },
        { kind: "workday", page: "questionnaire" },
      ),
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        kind: "advanced",
        expected: { kind: "workday", page: "questionnaire" },
        observed: { kind: "workday", page: "questionnaire" },
      },
    },
  );
});

test("returns illegal_transition when navigation reaches another known page", async () => {
  const provider = createCompletionNavigation();

  assert.deepEqual(
    await provider.reconcile(
      reconciliation(
        { kind: "workday", page: "questionnaire" },
        { kind: "workday", page: "review" },
      ),
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        kind: "illegal_transition",
        expected: { kind: "workday", page: "questionnaire" },
        observed: { kind: "workday", page: "review" },
      },
    },
  );
});

test("returns uncertain when observed state is not independently classified", async () => {
  const provider = createCompletionNavigation();

  assert.deepEqual(
    await provider.reconcile(
      reconciliation(
        { kind: "workday", page: "questionnaire" },
        { kind: "ambiguous" },
      ),
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        kind: "uncertain",
        expected: { kind: "workday", page: "questionnaire" },
        observed: { kind: "ambiguous" },
      },
    },
  );
});

test("returns uncertain when the browser page identity did not change", async () => {
  const provider = createCompletionNavigation();
  const request = reconciliation({
    kind: "workday",
    page: "questionnaire",
  });

  assert.deepEqual(
    await provider.reconcile(
      {
        ...request,
        observation: {
          ...request.observation,
          pageId: request.observation.fromPageId,
        },
      },
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        kind: "uncertain",
        expected: { kind: "workday", page: "questionnaire" },
        observed: { kind: "workday", page: "questionnaire" },
      },
    },
  );
});

test("rejects reconciliation that does not match the approved target", async () => {
  const provider = createCompletionNavigation();
  const request = reconciliation({ kind: "workday", page: "questionnaire" });

  assert.deepEqual(
    await provider.reconcile(
      {
        ...request,
        decision: {
          kind: "next",
          expectedPage: "profile",
        },
      },
      new AbortController().signal,
    ),
    {
      ok: false,
      error: {
        code: "navigation_illegal",
        retryable: false,
      },
    },
  );
});

test("requires one verification for one semantic field even if it is observed twice", async () => {
  const provider = createCompletionNavigation();

  const result = await provider.complete(
    {
      page: { ...requiredPage, fields: [requiredPage.fields[0], requiredPage.fields[0]] },
      verification: [{ kind: "verified", fieldId: requiredFieldId }],
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "complete",
      decision: { kind: "next", expectedPage: "questionnaire" },
    },
  });
});

test("rejects reconciliation whose semantic source page contradicts the approved transition", async () => {
  const provider = createCompletionNavigation();
  const request = reconciliation({ kind: "workday", page: "questionnaire" });

  assert.deepEqual(
    await provider.reconcile(
      {
        ...request,
        sourcePage: { kind: "workday", page: "account" },
      },
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "navigation_illegal", retryable: false },
    },
  );
});

test("rejects reconciliation whose browser operation does not match", async () => {
  const provider = createCompletionNavigation();
  const request = reconciliation({ kind: "workday", page: "questionnaire" });

  assert.deepEqual(
    await provider.reconcile(
      {
        ...request,
        observation: {
          ...request.observation,
          operationId: generatedOperationId("operation_ffffffffffffffff"),
        },
      },
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "navigation_illegal", retryable: false },
    },
  );
});

test("stops at Review without a navigation action", async () => {
  const provider = createCompletionNavigation();

  assert.deepEqual(
    await provider.reconcile(
      {
        operationId: contractFixtures.mutationReceipt.operationId,
        decision: { kind: "stop_review" },
        observation: {
          operationId: contractFixtures.mutationReceipt.operationId,
          fromPageId: contractFixtures.browserObservation.pageId,
          pageId: contractFixtures.browserObservation.pageId,
        },
        sourcePage: { kind: "workday", page: "review" },
        expected: { kind: "workday", page: "review" },
        observed: { kind: "workday", page: "review" },
      },
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        kind: "review_reached",
        expected: { kind: "workday", page: "review" },
        observed: { kind: "workday", page: "review" },
      },
    },
  );
});

test("rejects a Review stop that reports browser movement", async () => {
  const provider = createCompletionNavigation();
  const pageId = contractFixtures.browserObservation.pageId;

  assert.deepEqual(
    await provider.reconcile(
      {
        operationId: contractFixtures.mutationReceipt.operationId,
        decision: { kind: "stop_review" },
        observation: {
          operationId: contractFixtures.mutationReceipt.operationId,
          fromPageId: pageId,
          pageId: browserPageId("page-after-review"),
        },
        sourcePage: { kind: "workday", page: "review" },
        expected: { kind: "workday", page: "review" },
        observed: { kind: "workday", page: "review" },
      },
      new AbortController().signal,
    ),
    {
      ok: false,
      error: { code: "navigation_illegal", retryable: false },
    },
  );
});

test("cancellation never approves completion or reconciliation", async () => {
  const provider = createCompletionNavigation();
  const signal = AbortSignal.abort();
  const error = {
    ok: false,
    error: {
      code: "operation_cancelled",
      retryable: false,
    },
  };

  assert.deepEqual(
    await provider.complete(
      {
        page: requiredPage,
        verification: [{ kind: "verified", fieldId: requiredFieldId }],
      },
      signal,
    ),
    error,
  );
  assert.deepEqual(
    await provider.reconcile(
      reconciliation({ kind: "workday", page: "questionnaire" }),
      signal,
    ),
    error,
  );
});
