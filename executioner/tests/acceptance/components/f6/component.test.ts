import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boundedText,
  browserTargetToken,
  fieldId,
  optionId,
  providerError,
  upstreamProfileId,
  upstreamResumeId,
  type FieldObservation,
  type ProfileAnswerResult,
  type ProfileFactId,
} from "../../../../src/contracts/index.ts";
import { createAnswerResolver } from "../../../../src/form/answers/resolver.ts";
import {
  questionCatalog,
  resolveQuestion,
} from "../../../../src/form/questions/catalog.ts";
import {
  assertProviderConformance,
  contractOperationCases,
  createProfileQueryFake,
  createResumeArtifactFixture,
} from "../../../../src/testing/contracts/index.ts";
import {
  dependencyViolations,
  sourceFiles,
} from "../../../architecture/dependency-rule.ts";
import { requiredFieldFlowCases } from "../../../../src/testing/contracts/field-flow-cases.ts";

function field(
  label: string,
  behavior: FieldObservation["behavior"] = "text",
  options: FieldObservation["options"] = [],
): FieldObservation {
  return Object.freeze({
    fieldId: fieldId("s1-field-given-name"),
    target: browserTargetToken("target-acceptance"),
    label: boundedText(label),
    required: true,
    behavior,
    options,
    state: "empty",
  });
}

function request(observed: FieldObservation) {
  return Object.freeze({
    mode: "live",

    field: observed,
    profileId: upstreamProfileId("profile-acceptance"),
    profileRevision: 7,
    resume: Object.freeze({
      resumeId: upstreamResumeId("resume-acceptance"),
      sha256: "6a5c5b7838b3f7a7bf24b7e9ca49141f10ee68b2e14c9ee43eba3fdecf7173cc",
    }),
    resumeArtifact: createResumeArtifactFixture(),
  });
}

function syntheticRequest(observed: FieldObservation) {
  return Object.freeze({
    ...request(observed),
    mode: "synthetic_test_non_submittable" as const,
  });
}

test("F6 conforms to the frozen AnswerResolver provider contract", async () => {
  const profile = createProfileQueryFake();
  await assertProviderConformance(
    "AnswerResolver",
    createAnswerResolver(profile.port, "One configured narrative."),
  );
});

test("F6 consumes the exact frozen ProfileQuery request and is deterministic", async () => {
  const profile = createProfileQueryFake();
  const resolver = createAnswerResolver(profile.port, "One configured narrative.");
  const operation = contractOperationCases.AnswerResolver.resolve;
  const signal = new AbortController().signal;

  const first = await resolver.resolve(operation.request, signal);
  const second = await resolver.resolve(operation.request, signal);

  assert.deepEqual(first, { ok: true, value: operation.expected });
  assert.deepEqual(second, first);
  assert.notEqual(second, first);
  assert.deepEqual(profile.calls, [
    {
      operation: "query",
      request: {
        profileId: operation.request.profileId,
        profileRevision: operation.request.profileRevision,
        factId: "given_name",
      },
    },
    {
      operation: "query",
      request: {
        profileId: operation.request.profileId,
        profileRevision: operation.request.profileRevision,
        factId: "given_name",
      },
    },
  ]);
});

test("the reviewed catalog is the exact frozen F5-to-F6 matrix", () => {
  assert.deepEqual(
    questionCatalog.map(({ id, labels, behavior }) => ({
      id,
      label: labels[0],
      behavior,
    })),
    requiredFieldFlowCases.map(({ questionId, fieldLabel, behavior }) => ({
      id: questionId,
      label: fieldLabel,
      behavior,
    })),
  );
  for (const { fieldLabel, questionId } of requiredFieldFlowCases) {
    assert.deepEqual(resolveQuestion(fieldLabel), {
      kind: "resolved",
      id: questionId,
      provenance: "reviewed_catalog",
    });
  }
});

test("all ten exact F5 observations resolve through F6 without an unknown row", async () => {
  const values: Readonly<Partial<Record<ProfileFactId, string | boolean>>> = {
    given_name: "Ada",
    family_name: "Lovelace",
    phone_number: "555-0100",
    country: "United States",
    earliest_start_date: "2026-09-01",
    work_authorization: true,
    sponsorship_required: true,
    age_requirement_met: true,
    configured_narrative: "Narrative.",
  };
  const profile = createProfileQueryFake({
    query: (call) => {
      const factId = (call as { factId: ProfileFactId }).factId;
      const value = values[factId];
      if (value === undefined) throw new TypeError(`${factId} is not an S1 fact`);
      return {
        ok: true,
        value: {
          kind: "answered",
          value,
          provenance: factId === "configured_narrative"
            ? "configured_template"
            : "owner_provided",
        },
      } as const;
    },
  });
  const resolver = createAnswerResolver(profile.port, "Narrative.");

  for (const row of requiredFieldFlowCases) {
    assert.deepEqual(resolveQuestion(row.fieldLabel), {
      kind: "resolved",
      id: row.questionId,
      provenance: "reviewed_catalog",
    });
    const observed = Object.freeze({
      fieldId: fieldId(row.fieldId),
      target: browserTargetToken(`target-${row.fieldId}`),
      label: boundedText(row.fieldLabel),
      required: true,
      behavior: row.behavior,
      options: Object.freeze(row.options.map(({ id, label }) => Object.freeze({
        id: optionId(id),
        label: boundedText(label),
      }))),
      state: "empty" as const,
    }) satisfies FieldObservation;
    const result = await resolver.resolve(
      request(observed),
      new AbortController().signal,
    );
    assert.equal(result.ok, true, `${row.fieldId} did not resolve`);
    if (!result.ok || result.value.kind !== "resolved") {
      assert.fail(`${row.fieldId} did not produce an intent`);
    }
    assert.equal(result.value.intent.fieldId, row.fieldId);
    assert.equal(result.value.intent.behavior, row.behavior);
  }

  assert.deepEqual(
    profile.calls.map(({ request: call }) => (call as { factId: ProfileFactId }).factId),
    questionCatalog.flatMap((entry) => entry.source.kind === "profile"
      ? [entry.source.factId]
      : entry.source.kind === "narrative" ? ["configured_narrative"] : []),
  );
});

test("resolver preserves all F4 errors byte-for-byte without throwing", async () => {
  for (const code of [
    "profile_query_invalid",
    "profile_missing",
    "profile_revision_mismatch",
    "operation_cancelled",
  ] as const) {
    const dependencyResult = { ok: false as const, error: providerError(code) };
    const profile = createProfileQueryFake({ query: dependencyResult });
    const result = await createAnswerResolver(profile.port, "Narrative.").resolve(
      request(field("Given name")),
      new AbortController().signal,
    );
    assert.equal(result, dependencyResult);
  }
});

test("the synthetic compatibility resolver replaces non-owner protected facts", async () => {
  const cases = [
    ["Available start date", "date", "2026-09-01"],
    ["Are you authorized to work in this location?", "radio", true],
    ["Will you require sponsorship?", "select", false],
    ["I am at least 18 years of age.", "checkbox", true],
  ] as const;

  for (const [label, behavior, value] of cases) {
    for (const provenance of ["resume_verified", "configured_template"] as const) {
      const answer: ProfileAnswerResult = {
        kind: "answered",
        value,
        provenance,
      };
      const profile = createProfileQueryFake({ query: { ok: true, value: answer } });
      const options = behavior === "radio" || behavior === "select"
        ? [
            { id: optionId("yes"), label: boundedText("Yes") },
            { id: optionId("no"), label: boundedText("No") },
          ]
        : [];
      const result = await createAnswerResolver(profile.port, "Narrative.").resolve(
        request(field(label, behavior, options)),
        new AbortController().signal,
      );
      assert.equal(result.ok && result.value.kind, "resolved");
      if (result.ok && result.value.kind === "resolved") {
        assert.ok(["reviewed_catalog", "visible_option"].includes(result.value.intent.provenance));
      }
    }
  }
});

test("unresolved and unmatched synthetic facts learn supported mechanics", async () => {
  const missing = createAnswerResolver(createProfileQueryFake({
    query: { ok: true, value: { kind: "profile_answer_missing" } },
  }).port, "Narrative.");
  assert.deepEqual(
    await missing.resolve(syntheticRequest(field("Given name")), new AbortController().signal),
    {
      ok: true,
      value: {
        kind: "resolved",
        intent: {
          kind: "text",
          behavior: "text",
          fieldId: "s1-field-given-name",
          target: "target-acceptance",
          value: "Test",
          provenance: "reviewed_catalog",
        },
      },
    },
  );

  const answered = createProfileQueryFake({
    query: {
      ok: true,
      value: {
        kind: "answered",
        value: true,
        provenance: "owner_provided",
      },
    },
  });
  const resolver = createAnswerResolver(answered.port, "Exact narrative.");

  assert.deepEqual(
    await resolver.resolve(
      request(field("Are you authorized to work in this location?", "radio", [
        { id: optionId("no"), label: boundedText("No") },
      ])),
      new AbortController().signal,
    ),
    {
      ok: true,
      value: {
        kind: "resolved",
        intent: {
          kind: "choice",
          behavior: "radio",
          fieldId: "s1-field-given-name",
          target: "target-acceptance",
          optionId: "no",
          expectedOption: "No",
          provenance: "visible_option",
        },
      },
    },
  );
  const ambiguousOwner = await resolver.resolve(
    request(field("Are you authorized to work in this location?", "radio", [
      { id: optionId("yes"), label: boundedText("Yes") },
      { id: optionId("y"), label: boundedText("Y") },
    ])),
    new AbortController().signal,
  );
  assert.equal(ambiguousOwner.ok && ambiguousOwner.value.kind, "resolved");
  if (ambiguousOwner.ok && ambiguousOwner.value.kind === "resolved") {
    assert.equal(ambiguousOwner.value.intent.kind, "choice");
    assert.equal(ambiguousOwner.value.intent.provenance, "visible_option");
    if (ambiguousOwner.value.intent.kind === "choice") {
      assert.ok(["Yes", "Y"].includes(String(ambiguousOwner.value.intent.expectedOption)));
    }
  }
  assert.deepEqual(
    await resolver.resolve(
      request(field("Given name", "unsupported")),
      new AbortController().signal,
    ),
    { ok: true, value: { kind: "unsupported", fieldId: "s1-field-given-name" } },
  );
  assert.deepEqual(
  await resolver.resolve(syntheticRequest(field("Unreviewed")), new AbortController().signal),
    {
      ok: true,
      value: {
        kind: "resolved",
        intent: {
          kind: "text",
          behavior: "text",
          fieldId: "s1-field-given-name",
          target: "target-acceptance",
          value: "Test response pending owner review.",
          provenance: "reviewed_catalog",
        },
      },
    },
  );
});

test("configured narrative and artifact upload are exact", async () => {
  const resolver = createAnswerResolver(createProfileQueryFake({
    query: { ok: true, value: {
      kind: "answered",
      value: "Exact narrative.",
      provenance: "configured_template",
    } },
  }).port, "Exact narrative.");

  const narrative = await resolver.resolve(
    request(field("Brief interest statement", "textarea")),
    new AbortController().signal,
  );
  assert.equal(narrative.ok && narrative.value.kind === "resolved" && narrative.value.intent.kind === "text" && narrative.value.intent.value, "Exact narrative.");

  const resumeRequest = request(field("Resume", "file_upload"));
  const resume = await resolver.resolve(resumeRequest, new AbortController().signal);
  assert.equal(resume.ok, true);
  if (resume.ok && resume.value.kind === "resolved" && resume.value.intent.kind === "resume_upload") {
    assert.equal(resume.value.intent.artifact, resumeRequest.resumeArtifact);
    assert.equal(resume.value.intent.provenance, "resume_verified");
  } else {
    assert.fail("resume control must resolve to the selected artifact handle");
  }
});

test("F6 source stays inside its component import boundary", () => {
  const files = [
    ...sourceFiles("src/form/questions"),
    ...sourceFiles("src/form/answers"),
    ...sourceFiles("src/form/options"),
  ];
  assert.deepEqual(dependencyViolations(files), []);
});

test("F6 rejects an empty configured narrative at composition time", () => {
  assert.throws(
    () => createAnswerResolver(createProfileQueryFake().port, "   "),
    /narrative template must not be empty/u,
  );
});
