import assert from "node:assert/strict";
import { test } from "node:test";

import {
  admitContractSnapshot,
  boundedText,
  browserTargetToken,
  fieldId,
  generatedOperationId,
  guardRevision,
  journeyId,
  optionId,
  type BrowserMutation,
  type FieldIntent,
} from "../../../../src/contracts/index.ts";
import { createFieldDriver } from "../../../../src/interaction/drivers/registry.ts";
import {
  contractFixtures,
  createBrowserSessionFake,
  createResumeArtifactFixture,
  createSafetyGuardFake,
} from "../../../../src/testing/contracts/index.ts";
import { requiredFieldFlowCases } from "../../../../src/testing/contracts/field-flow-cases.ts";

function admittingSafety() {
  return createSafetyGuardFake({
    admit: (request) =>
      admitContractSnapshot(
        request.input,
        "safety",
        request.binding,
      ) as never,
  });
}

function intentFor(
  flow: (typeof requiredFieldFlowCases)[number],
): FieldIntent {
  const target = browserTargetToken(`target-${flow.fieldId}`);
  const common = {
    fieldId: fieldId(flow.fieldId),
    target,
    provenance: flow.behavior === "file_upload"
      ? "resume_verified" as const
      : "owner_provided" as const,
  };
  switch (flow.behavior) {
    case "text":
    case "textarea":
      return {
        ...common,
        kind: "text",
        behavior: flow.behavior,
        value: `Synthetic ${flow.fieldLabel}`,
      };
    case "radio":
    case "select":
    case "listbox":
      return {
        ...common,
        kind: "choice",
        behavior: flow.behavior,
        optionId: optionId(flow.options[0]!.id),
        expectedOption: boundedText(flow.options[0]!.label),
      };
    case "checkbox":
      return {
        ...common,
        kind: "toggle",
        behavior: "checkbox",
        checked: true,
      };
    case "date":
      return {
        ...common,
        kind: "date",
        behavior: "date",
        isoDate: "2026-08-01",
      };
    case "file_upload":
      return {
        ...common,
        kind: "resume_upload",
        behavior: "file_upload",
        artifact: createResumeArtifactFixture(),
      };
  }
}

function mutationFor(intent: FieldIntent): BrowserMutation {
  switch (intent.kind) {
    case "text":
      return {
        kind: "set_text",
        target: intent.target,
        text: intent.value,
      };
    case "choice":
      return {
        kind: "select",
        target: intent.target,
        option: intent.expectedOption,
      };
    case "toggle":
      return {
        kind: "set_checked",
        target: intent.target,
        checked: intent.checked,
      };
    case "date":
      return {
        kind: "set_date",
        target: intent.target,
        isoDate: intent.isoDate,
      };
    case "resume_upload":
      return {
        kind: "upload",
        target: intent.target,
        artifact: intent.artifact,
      };
  }
}

test("the ten-control matrix issues one exact desired-state mutation per field", async () => {
  assert.equal(requiredFieldFlowCases.length, 10);

  for (const [index, flow] of requiredFieldFlowCases.entries()) {
    const intent = intentFor(flow);
    const expectedMutation = mutationFor(intent);
    const safety = admittingSafety();
    const browser = createBrowserSessionFake();
    const operationId = generatedOperationId(
      `operation_${String(index).padStart(16, "0")}`,
    );

    const result = await createFieldDriver(browser.port, safety.port).drive(
      {
        journeyId: journeyId("journey_0123456789abcdef"),
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        guardRevision: guardRevision("policy-s1"),
        operationId,
        intent,
      },
      new AbortController().signal,
    );

    assert.deepEqual(result, {
      ok: true,
      value: {
        operationId,
        fieldId: intent.fieldId,
        behavior: intent.behavior,
        attempted: true,
      },
    });
    assert.equal(safety.calls.length, 1);
    assert.equal(browser.calls.length, 1);
    const browserRequest = browser.calls[0]!.request as {
      readonly snapshot: {
        readonly effect: { readonly mutation: BrowserMutation };
      };
    };
    assert.deepEqual(browserRequest.snapshot.effect.mutation, expectedMutation);
    assert.equal(
      Object.hasOwn(browserRequest.snapshot.effect.mutation, "resumeId"),
      false,
    );
    if (intent.kind === "resume_upload") {
      assert.strictEqual(
        browserRequest.snapshot.effect.mutation.kind === "upload"
          ? browserRequest.snapshot.effect.mutation.artifact
          : undefined,
        intent.artifact,
      );
      assert.equal(intent.artifact.sha256, contractFixtures.resume.sha256);
    }
  }
});

test("grouped radio selection uses the group target and exact option", async () => {
  const flow = requiredFieldFlowCases.find(({ behavior }) => behavior === "radio")!;
  const intent = intentFor(flow);
  assert.equal(intent.kind, "choice");
  const safety = admittingSafety();
  const browser = createBrowserSessionFake();

  await createFieldDriver(browser.port, safety.port).drive(
    {
      journeyId: journeyId("journey_0123456789abcdef"),
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: contractFixtures.browserObservation.pageId,
      guardRevision: guardRevision("policy-s1"),
      operationId: generatedOperationId("operation_2222222222222222"),
      intent,
    },
    new AbortController().signal,
  );

  const request = browser.calls[0]!.request as {
    readonly snapshot: {
      readonly effect: { readonly mutation: BrowserMutation };
    };
  };
  assert.deepEqual(request.snapshot.effect.mutation, {
    kind: "select",
    target: intent.target,
    option: intent.expectedOption,
  });
});

test("checkbox true and false are idempotent desired states", async () => {
  for (const [index, checked] of [true, false].entries()) {
    const intent = {
      kind: "toggle",
      behavior: "checkbox",
      fieldId: fieldId("s1-field-age-requirement"),
      target: browserTargetToken("target-age-requirement"),
      checked,
      provenance: "owner_provided",
    } as const satisfies FieldIntent;
    const safety = admittingSafety();
    const browser = createBrowserSessionFake();

    await createFieldDriver(browser.port, safety.port).drive(
      {
        journeyId: journeyId("journey_0123456789abcdef"),
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        guardRevision: guardRevision("policy-s1"),
        operationId: generatedOperationId(
          `operation_${String(index + 30).padStart(16, "0")}`,
        ),
        intent,
      },
      new AbortController().signal,
    );

    const request = browser.calls[0]!.request as {
      readonly snapshot: {
        readonly effect: { readonly mutation: BrowserMutation };
      };
    };
    assert.deepEqual(request.snapshot.effect.mutation, {
      kind: "set_checked",
      target: intent.target,
      checked,
    });
  }
});

test("invalid dates and intent values fail before admission", async () => {
  const valid = intentFor(
    requiredFieldFlowCases.find(({ behavior }) => behavior === "date")!,
  );
  assert.equal(valid.kind, "date");
  const invalid = [
    { ...contractFixtures.intent, value: 1 },
    { ...valid, isoDate: "2026-02-30" },
    { ...valid, isoDate: "08/01/2026" },
    {
      kind: "toggle",
      behavior: "checkbox",
      fieldId: fieldId("s1-field-age-requirement"),
      target: browserTargetToken("target-age-requirement"),
      checked: "yes",
      provenance: "owner_provided",
    },
    { ...contractFixtures.intent, provenance: "invented" },
  ] as unknown as FieldIntent[];

  for (const [index, intent] of invalid.entries()) {
    const safety = admittingSafety();
    const browser = createBrowserSessionFake();
    const result = await createFieldDriver(browser.port, safety.port).drive(
      {
        journeyId: journeyId("journey_0123456789abcdef"),
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        guardRevision: guardRevision("policy-s1"),
        operationId: generatedOperationId(
          `operation_${String(index + 50).padStart(16, "0")}`,
        ),
        intent,
      },
      new AbortController().signal,
    );

    assert.deepEqual(result, {
      ok: false,
      error: { code: "driver_intent_invalid", retryable: false },
    });
    assert.deepEqual(safety.calls, []);
    assert.deepEqual(browser.calls, []);
  }
});

test("a mutation receipt contains no applicant value and claims no verification", async () => {
  const safety = admittingSafety();
  const browser = createBrowserSessionFake();
  const applicantText = ["applicant", "example.invalid"].join("@");
  const result = await createFieldDriver(browser.port, safety.port).drive(
    {
      journeyId: journeyId("journey_0123456789abcdef"),
      sessionId: contractFixtures.browserObservation.sessionId,
      pageId: contractFixtures.browserObservation.pageId,
      guardRevision: guardRevision("policy-s1"),
      operationId: generatedOperationId("operation_7777777777777777"),
      intent: {
        ...contractFixtures.intent,
        value: applicantText,
      },
    },
    new AbortController().signal,
  );

  assert.equal(result.ok, true);
  const receipt = result.ok ? result.value : {};
  for (const forbidden of ["value", "text", "target", "artifact", "verified"]) {
    assert.equal(Object.hasOwn(receipt, forbidden), false);
  }
  assert.equal(JSON.stringify(receipt).includes(applicantText), false);
});
