import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boundedText,
  type AnswerResolutionRequest,
  browserReadbackText,
  browserOperationCoordinateKeys,
  type BrowserMutationRequest,
  type BrowserReadback,
  MAX_BROWSER_READBACK_CODE_POINTS,
  type BrowserObservation,
  type DriverRequest,
  type FieldIntent,
  type JourneyBootstrapRequest,
  journeyBootstrapReferenceKeys,
  parseMcpRequest,
  type NavigationReconciliationRequest,
  type NavigationResult,
  type PageCompletionResult,
  serializedSchemas,
  type StartJourneyCommand,
  uiBehaviorIds,
  type VerificationRequest,
} from "../../src/contracts/index.ts";

test("browser observations carry bounded verifier readback", () => {
  const observation = {
    sessionId: "session-1",
    pageId: "page-1",
    origin: "http://fixture.invalid",
    path: "/profile",
    targets: [
      {
        token: "target-text",
        role: "textbox",
        name: browserReadbackText("First name"),
        required: true,
        options: [],
        state: { visibility: "visible", enabled: true, actionable: true },
        readback: { kind: "text", value: browserReadbackText("Ada") },
      },
      {
        token: "target-check",
        role: "checkbox",
        name: browserReadbackText("Authorized"),
        required: true,
        options: [],
        state: { visibility: "visible", enabled: true, actionable: true },
        readback: { kind: "checked", checked: true },
      },
      {
        token: "target-select",
        role: "combobox",
        name: browserReadbackText("Country"),
        required: true,
        options: [browserReadbackText("Synthetic option")],
        state: { visibility: "visible", enabled: true, actionable: true },
        readback: {
          kind: "selected",
          option: browserReadbackText("Synthetic option"),
        },
      },
      {
        token: "target-upload",
        role: "file",
        name: browserReadbackText("Resume"),
        required: true,
        options: [],
        state: { visibility: "hidden", enabled: true, actionable: false },
        readback: { kind: "upload", resumeId: "resume-1" },
      },
    ],
  } as const satisfies BrowserObservation;

  assert.equal(MAX_BROWSER_READBACK_CODE_POINTS, 512);
  assert.deepEqual(
    observation.targets.map(({ readback }) => readback.kind),
    ["text", "checked", "selected", "upload"],
  );
  assert.ok(
    observation.targets[0].readback.value.length <=
      MAX_BROWSER_READBACK_CODE_POINTS,
  );
  assert.throws(
    () =>
      browserReadbackText(
        "x".repeat(MAX_BROWSER_READBACK_CODE_POINTS + 1),
      ),
    RangeError,
  );
});

test("answer resolution carries the selected resume input", () => {
  const request = {
    field: {
      fieldId: "resume",
      target: "target-upload",
      label: boundedText("Resume"),
      required: true,
      behavior: "file_upload",
      options: [],
      state: "empty",
    },
    profileId: "profile-1",
    profileRevision: 1,
    resume: {
      resumeId: "resume-1",
      sha256: "sha256:resume",
    },
  } as const satisfies AnswerResolutionRequest;

  assert.equal(request.resume.resumeId, "resume-1");
});

test("navigation reconciliation compares semantic page identity", () => {
  const expected = {
    kind: "workday",
    page: "questionnaire",
  } as const;
  const observed = {
    kind: "workday",
    page: "questionnaire",
  } as const;
  const request = {
    operationId: "operation-1",
    decision: { kind: "next", expectedPage: "questionnaire" },
    observation: {
      operationId: "operation-1",
      fromPageId: "browser-page-1",
      pageId: "browser-page-2",
    },
    expected,
    observed,
  } as const satisfies NavigationReconciliationRequest;
  const result = {
    kind: "advanced",
    expected,
    observed,
  } as const satisfies NavigationResult;

  assert.deepEqual(result.expected, request.expected);
  assert.deepEqual(result.observed, request.observed);
});

test("complete pages cannot carry a blocked navigation decision", () => {
  // @ts-expect-error complete results require an approved next/review decision
  const invalid: PageCompletionResult = {
    kind: "complete",
    decision: { kind: "blocked" },
  };
  assert.equal(invalid.decision.kind, "blocked");
});

test("driver and verifier requests carry explicit browser coordinates", () => {
  const intent = {
    kind: "text",
    behavior: "text",
    fieldId: "field-1",
    target: "target-1",
    value: "Synthetic",
    provenance: "owner_provided",
  } as const satisfies FieldIntent;
  const coordinates = {
    sessionId: "session-1",
    pageId: "page-1",
  };
  const driver = {
    ...coordinates,
    operationId: "operation-1",
    intent,
  } satisfies DriverRequest;
  const verification = {
    ...coordinates,
    intent,
    receipt: {
      operationId: "operation-1",
      fieldId: "field-1",
      behavior: "text",
      attempted: true,
    },
  } satisfies VerificationRequest;
  const mutation = {
    ...coordinates,
    operationId: driver.operationId,
    mutation: {
      kind: "type",
      target: intent.target,
      text: intent.value,
    },
  } satisfies BrowserMutationRequest;

  assert.deepEqual(
    browserOperationCoordinateKeys.map((key) => driver[key]),
    ["session-1", "page-1"],
  );
  assert.equal(verification.pageId, mutation.pageId);
});

test("MCP start, orchestration, and F4 bootstrap share one ID request", () => {
  const request = parseMcpRequest({
    schemaVersion: 1,
    requestId: "request-1",
    method: "start_journey",
    params: {
      operationId: "operation-1",
      jobId: "job-1",
      resumeId: "resume-1",
      profileId: "profile-1",
    },
  });
  assert.equal(request.method, "start_journey");
  const bootstrap =
    request.params satisfies JourneyBootstrapRequest & StartJourneyCommand;

  assert.deepEqual(Object.keys(bootstrap), journeyBootstrapReferenceKeys);
  assert.deepEqual(
    serializedSchemas.mcpRequest.oneOf[0].properties.params.required,
    journeyBootstrapReferenceKeys,
  );
});

test("field intents retain the exact UI behavior for driver dispatch", () => {
  const intents = [
    {
      kind: "text",
      behavior: "textarea",
      fieldId: "field-text",
      target: "target-text",
      value: "Synthetic narrative",
      provenance: "configured_template",
    },
    {
      kind: "choice",
      behavior: "listbox",
      fieldId: "field-choice",
      target: "target-choice",
      optionId: "option-1",
      expectedOption: boundedText("Synthetic option"),
      provenance: "visible_option",
    },
    {
      kind: "toggle",
      behavior: "checkbox",
      fieldId: "field-check",
      target: "target-check",
      checked: true,
      provenance: "owner_provided",
    },
    {
      kind: "date",
      behavior: "date",
      fieldId: "field-date",
      target: "target-date",
      isoDate: "2026-08-01",
      provenance: "owner_provided",
    },
    {
      kind: "resume_upload",
      behavior: "file_upload",
      fieldId: "field-upload",
      target: "target-upload",
      resumeId: "resume-1",
      provenance: "resume_verified",
    },
  ] as const satisfies readonly FieldIntent[];

  assert.deepEqual(uiBehaviorIds, [
    "text",
    "textarea",
    "radio",
    "checkbox",
    "select",
    "listbox",
    "date",
    "file_upload",
  ]);
  assert.deepEqual(
    intents.map(({ behavior }) => behavior),
    ["textarea", "listbox", "checkbox", "date", "file_upload"],
  );
});

test("choice intent carries one bounded browser-usable expected option", () => {
  const choice = {
    kind: "choice",
    behavior: "select",
    fieldId: "field-choice",
    target: "target-choice",
    optionId: "option-1",
    expectedOption: boundedText("Synthetic option"),
    provenance: "visible_option",
  } as const satisfies FieldIntent;
  const mutation = {
    sessionId: "session-1",
    pageId: "page-1",
    operationId: "operation-1",
    mutation: {
      kind: "select",
      target: choice.target,
      option: choice.expectedOption,
    },
  } satisfies BrowserMutationRequest;
  const readback = {
    kind: "selected",
    option: choice.expectedOption,
  } satisfies BrowserReadback;

  assert.equal(mutation.mutation.option, readback.option);
  assert.throws(
    () => boundedText("x".repeat(MAX_BROWSER_READBACK_CODE_POINTS + 1)),
    RangeError,
  );
});
