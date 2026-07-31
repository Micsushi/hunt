import assert from "node:assert/strict";
import { test } from "node:test";

import {
  browserPageId,
  admitContractSnapshot,
  bindAdmissionRequest,
  boundedText,
  browserTargetToken,
  type AnswerResolutionRequest,
  browserReadbackText,
  browserOperationCoordinateKeys,
  createGeneratedIdAllocator,
  generatedSessionId,
  fieldId,
  type BrowserMutationRequest,
  type BrowserMutation,
  type BrowserReadback,
  sha256Digest,
  MAX_BROWSER_READBACK_CODE_POINTS,
  type BrowserObservation,
  type DriverRequest,
  type FieldIntent,
  type JourneyBootstrapRequest,
  journeyBootstrapReferenceKeys,
  mcpRequestId,
  generatedOperationId,
  guardRevision,
  optionId,
  parseMcpRequest,
  type NavigationReconciliationRequest,
  type NavigationResult,
  type PageCompletionResult,
  serializedSchemas,
  upstreamJobId,
  upstreamProfileId,
  upstreamResumeId,
  uiBehaviorIds,
  type VerificationRequest,
} from "../../src/contracts/index.ts";
import {
  contractFixtures,
  contractOperationCases,
} from "../../src/testing/contracts/index.ts";

const generatedIds = createGeneratedIdAllocator({
  next: () => "0123456789abcdef",
});
const generatedSession = generatedSessionId(generatedIds);
if (!generatedSession.ok) throw new Error("test id allocation failed");
const testSessionId = generatedSession.value;

function protectedMutation(mutation: BrowserMutation, token: string): BrowserMutationRequest {
  const operation = generatedOperationId(token);
  const revision = guardRevision("guard-data-flow");
  const admitted = admitContractSnapshot(
    {
      policyRevision: revision,
      capability: "field_mutation",
      effect: {
        kind: "browser_mutation",
        sessionId: testSessionId,
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
}

test("browser observations carry bounded verifier readback", () => {
  const observation = {
    sessionId: testSessionId,
    pageId: browserPageId("page-1"),
    origin: "http://fixture.invalid",
    path: "/profile",
    targets: [
      {
        token: browserTargetToken("target-text"),
        name: browserReadbackText("First name"),
        required: true,
        control: { kind: "text", element: "input" },
        state: { visibility: "visible", enabled: true, actionable: true },
        readback: { kind: "text", value: browserReadbackText("Ada") },
      },
      {
        token: browserTargetToken("target-check"),
        name: browserReadbackText("Authorized"),
        required: true,
        control: {
          kind: "choice",
          element: "input",
          choice: "checkbox",
          group: boundedText("authorization"),
          checked: true,
        },
        state: { visibility: "visible", enabled: true, actionable: true },
        readback: { kind: "checked", checked: true },
      },
      {
        token: browserTargetToken("target-select"),
        name: browserReadbackText("Country"),
        required: true,
        control: {
          kind: "select",
          element: "select",
          options: [browserReadbackText("Synthetic option")],
        },
        state: { visibility: "visible", enabled: true, actionable: true },
        readback: {
          kind: "selected",
          option: browserReadbackText("Synthetic option"),
        },
      },
      {
        token: browserTargetToken("target-upload"),
        name: browserReadbackText("Resume"),
        required: true,
        control: { kind: "file", element: "input" },
        state: { visibility: "hidden", enabled: true, actionable: false },
        readback: {
          kind: "upload",
          resumeId: upstreamResumeId("resume-1"),
          sha256: sha256Digest(
            "6a5c5b7838b3f7a7bf24b7e9ca49141f10ee68b2e14c9ee43eba3fdecf7173cc",
          ),
        },
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

if (false) {
  const upload: Extract<BrowserReadback, { readonly kind: "upload" }> = {
    kind: "upload",
    // @ts-expect-error upload readback retains a branded upstream resume ID
    resumeId: "resume-raw",
    sha256: sha256Digest(
      "6a5c5b7838b3f7a7bf24b7e9ca49141f10ee68b2e14c9ee43eba3fdecf7173cc",
    ),
  };
  // @ts-expect-error a present upload must carry its verified digest
  const missingDigest: BrowserReadback = {
    kind: "upload",
    resumeId: upstreamResumeId("resume-1"),
  };
  const incompleteAbsent: BrowserReadback = {
    kind: "upload",
    resumeId: null,
    // @ts-expect-error an absent upload cannot retain a digest
    sha256: sha256Digest(
      "6a5c5b7838b3f7a7bf24b7e9ca49141f10ee68b2e14c9ee43eba3fdecf7173cc",
    ),
  };
  void upload;
  void missingDigest;
  void incompleteAbsent;
}

test("upload readback is absent or carries one verified lowercase SHA-256 digest", () => {
  const absent = {
    kind: "upload",
    resumeId: null,
    sha256: null,
  } as const satisfies BrowserReadback;
  const present = {
    kind: "upload",
    resumeId: upstreamResumeId("resume-1"),
    sha256: sha256Digest(
      "6a5c5b7838b3f7a7bf24b7e9ca49141f10ee68b2e14c9ee43eba3fdecf7173cc",
    ),
  } as const satisfies BrowserReadback;

  assert.deepEqual(absent, { kind: "upload", resumeId: null, sha256: null });
  assert.equal(present.sha256.length, 64);
  assert.throws(() => sha256Digest("0".repeat(63)), RangeError);
  assert.throws(() => sha256Digest("A".repeat(64)), RangeError);
  assert.throws(() => sha256Digest(`sha256:${"0".repeat(64)}`), RangeError);
});

test("answer resolution carries the selected resume input", () => {
  const request = {
    field: {
      fieldId: fieldId("resume"),
      target: browserTargetToken("target-upload"),
      label: boundedText("Resume"),
      required: true,
      behavior: "file_upload",
      options: [],
      state: "empty",
    },
    profileId: upstreamProfileId("profile-1"),
    profileRevision: 1,
    resume: {
      resumeId: upstreamResumeId("resume-1"),
      sha256: "sha256:resume",
    },
    resumeArtifact: contractFixtures.resumeArtifact,
  } as const satisfies AnswerResolutionRequest;

  assert.equal(request.resume.resumeId, "resume-1");
});

test("navigation reconciliation compares semantic page identity", () => {
  const sourcePage = {
    kind: "workday",
    page: "profile",
  } as const;
  const expected = {
    kind: "workday",
    page: "questionnaire",
  } as const;
  const observed = {
    kind: "workday",
    page: "questionnaire",
  } as const;
  const request = {
    operationId: generatedOperationId("operation_0123456789abcdef"),
    decision: { kind: "next", expectedPage: "questionnaire" },
    observation: {
      operationId: generatedOperationId("operation_0123456789abcdef"),
      fromPageId: browserPageId("browser-page-1"),
      pageId: browserPageId("browser-page-2"),
    },
    sourcePage,
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
  assert.deepEqual(request.sourcePage, {
    kind: "workday",
    page: "profile",
  });
  if (false) {
    const { sourcePage: _sourcePage, ...missingSourcePage } = request;
    // @ts-expect-error reconciliation requires the semantic source page
    const invalid: NavigationReconciliationRequest = missingSourcePage;
    void invalid;
  }
});

test("complete pages cannot carry a blocked navigation decision", () => {
  // @ts-expect-error complete results require an approved next/review decision
  const invalid: PageCompletionResult = {
    kind: "complete",
    decision: { kind: "blocked" },
  };
  assert.equal(invalid.decision.kind, "blocked");
});

test("driver carries exact safety binding context and verifier carries browser coordinates", () => {
  const intent = {
    kind: "text",
    behavior: "text",
    fieldId: fieldId("field-1"),
    target: browserTargetToken("target-1"),
    value: "Synthetic",
    provenance: "owner_provided",
  } as const satisfies FieldIntent;
  const coordinates = {
    sessionId: testSessionId,
    pageId: browserPageId("page-1"),
  };
  const driver = {
    ...coordinates,
    journeyId: contractFixtures.journeyState.journeyId,
    guardRevision: guardRevision("guard-data-flow"),
    operationId: generatedOperationId("operation_0123456789abcdef"),
    intent,
  } satisfies DriverRequest;
  const verification = {
    ...coordinates,
    intent,
    receipt: {
      operationId: generatedOperationId("operation_0123456789abcdef"),
      fieldId: fieldId("field-1"),
      behavior: "text",
      attempted: true,
    },
  } satisfies VerificationRequest;
  const mutation = protectedMutation(
    {
      kind: "set_text",
      target: intent.target,
      text: intent.value,
    },
    "operation_0123456789abcdef",
  );

  assert.deepEqual(
    browserOperationCoordinateKeys.map((key) => driver[key]),
    [testSessionId, "page-1"],
  );
  assert.equal(driver.journeyId, contractFixtures.journeyState.journeyId);
  assert.equal(driver.guardRevision, "guard-data-flow");
  assert.equal(driver.operationId, "operation_0123456789abcdef");
  assert.equal(verification.pageId, mutation.snapshot.effect.pageId);
  if (false) {
    const {
      journeyId: _journeyId,
      guardRevision: _guardRevision,
      ...missingBinding
    } = driver;
    // @ts-expect-error driver requests require journey and guard binding
    const invalid: DriverRequest = missingBinding;
    void invalid;
  }
});

test("canonical F7 and F8 cases retain safety binding and semantic source proof", () => {
  const driver = contractOperationCases.FieldDriver.drive.request;
  assert.deepEqual(Object.keys(driver).sort(), [
    "guardRevision",
    "intent",
    "journeyId",
    "operationId",
    "pageId",
    "sessionId",
  ]);
  assert.equal(driver.journeyId, contractFixtures.journeyState.journeyId);
  assert.equal(driver.guardRevision, contractFixtures.safetyAdmission.guardRevision);
  assert.equal(driver.operationId, contractFixtures.safetyAdmission.attemptId);
  assert.deepEqual(
    contractOperationCases.CompletionNavigation.reconcile.request.sourcePage,
    { kind: "workday", page: "profile" },
  );
});

test("MCP start, orchestration, and F4 bootstrap share one ID request", () => {
  const request = parseMcpRequest({
    schemaVersion: 2,
    requestId: mcpRequestId("request-1"),
    method: "start_journey",
    params: {
      jobId: upstreamJobId("job-1"),
      resumeId: upstreamResumeId("resume-1"),
      profileId: upstreamProfileId("profile-1"),
    },
  });
  assert.equal(request.method, "start_journey");
  const bootstrap = request.params satisfies JourneyBootstrapRequest;

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
      fieldId: fieldId("field-text"),
      target: browserTargetToken("target-text"),
      value: "Synthetic narrative",
      provenance: "configured_template",
    },
    {
      kind: "choice",
      behavior: "listbox",
      fieldId: fieldId("field-choice"),
      target: browserTargetToken("target-choice"),
      optionId: optionId("option-1"),
      expectedOption: boundedText("Synthetic option"),
      provenance: "visible_option",
    },
    {
      kind: "toggle",
      behavior: "checkbox",
      fieldId: fieldId("field-check"),
      target: browserTargetToken("target-check"),
      checked: true,
      provenance: "owner_provided",
    },
    {
      kind: "date",
      behavior: "date",
      fieldId: fieldId("field-date"),
      target: browserTargetToken("target-date"),
      isoDate: "2026-08-01",
      provenance: "owner_provided",
    },
    {
      kind: "resume_upload",
      behavior: "file_upload",
      fieldId: fieldId("field-upload"),
      target: browserTargetToken("target-upload"),
      artifact: contractFixtures.resumeArtifact,
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
    fieldId: fieldId("field-choice"),
    target: browserTargetToken("target-choice"),
    optionId: optionId("option-1"),
    expectedOption: boundedText("Synthetic option"),
    provenance: "visible_option",
  } as const satisfies FieldIntent;
  const mutation = protectedMutation(
    {
      kind: "select",
      target: choice.target,
      option: choice.expectedOption,
    },
    "operation_fedcba9876543210",
  );
  const readback = {
    kind: "selected",
    option: choice.expectedOption,
  } satisfies BrowserReadback;

  assert.equal(mutation.snapshot.effect.mutation.kind, "select");
  if (mutation.snapshot.effect.mutation.kind !== "select") return;
  assert.equal(mutation.snapshot.effect.mutation.option, readback.option);
  assert.throws(
    () => boundedText("x".repeat(MAX_BROWSER_READBACK_CODE_POINTS + 1)),
    RangeError,
  );
});
