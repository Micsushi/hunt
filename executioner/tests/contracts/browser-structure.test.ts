import assert from "node:assert/strict";
import test from "node:test";

import {
  browserControlKinds,
  admitContractSnapshot,
  bindAdmissionRequest,
  browserPageId,
  browserTargetToken,
  boundedText,
  generatedOperationId,
  guardRevision,
  providerError,
  stableErrorPolicy,
  type BrowserEffectError,
  type BrowserMutation,
  type BrowserMutationRequest,
  type BrowserSession,
  type BrowserTargetObservation,
} from "../../src/contracts/index.ts";
import { contractFixtures } from "../../src/testing/contracts/fixtures.ts";

type MutationFailure = Extract<
  Awaited<ReturnType<BrowserSession["mutate"]>>,
  { readonly ok: false }
>["error"];

if (false) {
  const preEffectTimeout: MutationFailure = {
    code: "browser_timeout",
    retryable: true,
  };
  const uncertainEffect: MutationFailure = {
    code: "browser_effect_uncertain",
    retryable: false,
  };
  void preEffectTimeout;
  void uncertainEffect;
}

test("browser effect timeout is distinct from uncertain effect invalidation", () => {
  const preEffect: BrowserEffectError = providerError("browser_timeout");
  const mayHaveStarted: BrowserEffectError = providerError(
    "browser_effect_uncertain",
  );

  assert.deepEqual(preEffect, {
    code: "browser_timeout",
    retryable: true,
  });
  assert.deepEqual(mayHaveStarted, {
    code: "browser_effect_uncertain",
    retryable: false,
  });
  assert.equal(stableErrorPolicy[preEffect.code].owner, "F3");
  assert.equal(stableErrorPolicy[mayHaveStarted.code].owner, "F3");
});

test("browser observations preserve structural control semantics", () => {
  const shared = {
    token: browserTargetToken("target-1"),
    name: boundedText("Question"),
    required: true,
    state: {
      visibility: "visible",
      enabled: true,
      actionable: true,
    } as const,
    readback: { kind: "empty" } as const,
  };
  const targets = [
    { ...shared, control: { kind: "text", element: "textarea" } },
    { ...shared, control: { kind: "date", element: "input" } },
    {
      ...shared,
      control: {
        kind: "choice",
        element: "input",
        choice: "radio",
        group: boundedText("work-authorization"),
        checked: false,
      },
    },
  ] satisfies readonly BrowserTargetObservation[];

  assert.deepEqual(browserControlKinds, [
    "text",
    "date",
    "choice",
    "select",
    "button",
    "file",
  ]);
  assert.equal(targets[0]?.control.element, "textarea");
  assert.equal(targets[2]?.control.kind, "choice");
  assert.equal(targets[2]?.control.checked, false);
});

test("browser mutations state the desired value instead of an ambiguous click", () => {
  const revision = guardRevision("guard-browser-structure");
  const createRequest = (mutation: BrowserMutation, token: string): BrowserMutationRequest => {
    const operation = generatedOperationId(token);
    const admitted = admitContractSnapshot(
      {
        policyRevision: revision,
        capability: "field_mutation",
        effect: {
          kind: "browser_mutation",
          sessionId: contractFixtures.browserObservation.sessionId,
          pageId: browserPageId("page-1"),
          operationId: operation,
          mutation,
        },
      },
      "safety",
      {
        journeyId: contractFixtures.journeyState.journeyId,
        attemptId: operation,
        guardRevision: revision,
      },
    );
    if (!admitted.ok) throw new Error("test admission failed");
    return bindAdmissionRequest(admitted.value);
  };
  const mutations = [
    createRequest(
      {
        kind: "set_text",
        target: browserTargetToken("target-text"),
        text: "value",
      },
      "operation_1111111111111111",
    ),
    createRequest(
      {
        kind: "set_date",
        target: browserTargetToken("target-date"),
        isoDate: "2026-07-31",
      },
      "operation_2222222222222222",
    ),
    createRequest(
      {
        kind: "set_checked",
        target: browserTargetToken("target-choice"),
        checked: true,
      },
      "operation_3333333333333333",
    ),
  ] satisfies readonly BrowserMutationRequest[];

  assert.deepEqual(
    mutations.map(({ snapshot }) => snapshot.effect.mutation.kind),
    ["set_text", "set_date", "set_checked"],
  );
});
