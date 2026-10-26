import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  boundedText,
  type BrowserObservation,
  type CompletionNavigation,
  type FieldVerifier,
} from "../../../../src/contracts/index.ts";
import {
  assertProviderConformance,
  contractFixtures,
  contractOperationCases,
  createBrowserSessionFake,
  createCompletionNavigationFake,
  createFieldVerifierFake,
} from "../../../../src/testing/contracts/index.ts";
import { createFieldVerifier } from "../../../../src/interaction/verification/field-verifier.ts";
import { createCompletionNavigation } from "../../../../src/interaction/navigation/completion-navigation.ts";

const verifiedObservation = {
  ...contractFixtures.browserObservation,
  targets: [
    {
      ...contractFixtures.browserObservation.targets[0],
      readback: {
        kind: "text",
        value: boundedText(contractFixtures.intent.value),
      },
    },
  ],
} as BrowserObservation;

test("FieldVerifier conforms to the frozen provider contract", async () => {
  const browser = createBrowserSessionFake({
    observe: { ok: true, value: verifiedObservation },
  });

  await assertProviderConformance(
    "FieldVerifier",
    createFieldVerifier(browser.port),
  );
});

test("CompletionNavigation conforms to the frozen provider contract", async () => {
  await assertProviderConformance(
    "CompletionNavigation",
    createCompletionNavigation(),
  );
});

async function consumeVerifier(port: FieldVerifier) {
  return port.verify(
    contractOperationCases.FieldVerifier.verify.request,
    new AbortController().signal,
  );
}

async function consumeNavigation(port: CompletionNavigation) {
  return port.complete(
    contractOperationCases.CompletionNavigation.complete.request,
    new AbortController().signal,
  );
}

test("F8 consumers can use the shared contract fakes", async () => {
  assert.deepEqual(
    await consumeVerifier(createFieldVerifierFake().port),
    {
      ok: true,
      value: contractOperationCases.FieldVerifier.verify.expected,
    },
  );
  assert.deepEqual(
    await consumeNavigation(createCompletionNavigationFake().port),
    {
      ok: true,
      value: contractOperationCases.CompletionNavigation.complete.expected,
    },
  );
});

test("false-success and hidden readback cannot pass independent verification", async () => {
  const observations: readonly BrowserObservation[] = [
    {
      ...verifiedObservation,
      targets: verifiedObservation.targets.map((target) => ({
        ...target,
        readback: {
          kind: "text" as const,
          value: boundedText("stale value"),
        },
      })),
    },
    {
      ...verifiedObservation,
      targets: verifiedObservation.targets.map((target) => ({
        ...target,
        state: {
          visibility: "hidden",
          enabled: true,
          actionable: false,
        },
      })),
    },
  ];

  for (const observation of observations) {
    const browser = createBrowserSessionFake({
      observe: { ok: true, value: observation },
    });
    const result = await consumeVerifier(
      createFieldVerifier(browser.port, { maxAttempts: 1 }),
    );

    assert.equal(result.ok, true);
    assert.notEqual(
      result.ok ? result.value.kind : undefined,
      "verified",
    );
  }
});

test("any incomplete required field blocks navigation", async () => {
  const provider = createCompletionNavigation();
  const result = await provider.complete(
    {
      page: contractFixtures.pageSnapshot,
      verification: [
        {
          kind: "rejected",
          fieldId: contractFixtures.field.fieldId,
          reason: "mismatch",
        },
      ],
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "blocked",
      fieldIds: [contractFixtures.field.fieldId],
      decision: { kind: "blocked" },
    },
  });
});

test("illegal transition is reported and Review is terminal", async () => {
  const provider = createCompletionNavigation();
  const signal = new AbortController().signal;

  assert.deepEqual(
    await provider.reconcile(
      {
        ...contractOperationCases.CompletionNavigation.reconcile.request,
        observed: { kind: "workday", page: "account" },
      },
      signal,
    ),
    {
      ok: true,
      value: {
        kind: "illegal_transition",
        expected: { kind: "workday", page: "questionnaire" },
        observed: { kind: "workday", page: "account" },
      },
    },
  );
  assert.deepEqual(
    await provider.complete(
      {
        page: {
          pageIdentity: { kind: "workday", page: "review" },
          fields: [],
        },
        verification: [],
      },
      signal,
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

test("F8 source has no driver dependency or final-action capability", () => {
  const sources = [
    "src/interaction/verification/field-verifier.ts",
    "src/interaction/completion/page-completion.ts",
    "src/interaction/navigation/completion-navigation.ts",
  ].map((path) => readFileSync(path, "utf8"));
  const source = sources.join("\n");

  assert.doesNotMatch(source, /interaction\/drivers|FieldDriver/u);
  assert.doesNotMatch(source, /FactualTerminalOutcome|TerminalResult|JourneyControl/u);
  assert.doesNotMatch(source, /\bsubmit\b/iu);
});
