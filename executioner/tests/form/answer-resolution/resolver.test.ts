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
  type ProfileQueryError,
} from "../../../src/contracts/index.ts";
import type {
  ApplicationProfileAnswerResult,
  ApplicationProfileQuery,
} from "../../../src/profile/application-profile.ts";
import { createApplicationAnswerResolver as createAnswerResolver } from
  "../../../src/form/answers/resolver.ts";
import { mapVisibleOption } from "../../../src/form/options/mapper.ts";
import {
  createProfileQueryFake,
  createResumeArtifactFixture,
} from "../../../src/testing/contracts/index.ts";

function field(
  label: string,
  behavior: FieldObservation["behavior"] = "text",
  options: FieldObservation["options"] = [],
  state: FieldObservation["state"] = "empty",
): FieldObservation {
  return Object.freeze({
    fieldId: fieldId("s1-field-given-name"),
    target: browserTargetToken("target-1"),
    label: boundedText(label),
    required: true,
    behavior,
    options,
    state,
  });
}

function request(observed: FieldObservation) {
  const resume = Object.freeze({
    resumeId: upstreamResumeId("resume-1"),
    sha256: "6a5c5b7838b3f7a7bf24b7e9ca49141f10ee68b2e14c9ee43eba3fdecf7173cc",
  });
  const resumeArtifact = createResumeArtifactFixture();
  return Object.freeze({
    mode: "live",

    field: observed,
    profileId: upstreamProfileId("profile-1"),
    profileRevision: 3,
    resume,
    resumeArtifact,
  });
}

function syntheticRequest(observed: FieldObservation) {
  return Object.freeze({
    ...request(observed),
    mode: "synthetic_test_non_submittable" as const,
  });
}

function resolverWith(answer: ApplicationProfileAnswerResult) {
  const profile = createProfileQueryFake({
    query: { ok: true, value: answer } as never,
  });
  return {
    resolver: createAnswerResolver(
      profile.port as unknown as ApplicationProfileQuery,
      "I am interested in this role.",
    ),
    profile,
  };
}

test("profile answers produce exact immutable intents with provenance", async () => {
  const cases = [
    ["Given name", "text", "Ada", "text", { value: "Ada" }],
    ["Family name", "text", "Lovelace", "text", { value: "Lovelace" }],
    ["Phone number", "text", "555-0100", "text", { value: "555-0100" }],
    ["Available start date", "date", "2026-09-01", "date", { isoDate: "2026-09-01" }],
    ["I am at least 18 years of age.", "checkbox", true, "toggle", { checked: true }],
  ] as const;

  for (const [label, behavior, value, kind, payload] of cases) {
    const { resolver } = resolverWith({
      kind: "answered",
      value,
      provenance: "owner_provided",
      lane: "live_owner_fact",
    });
    const result = await resolver.resolve(
      request(field(label, behavior)),
      new AbortController().signal,
    );

    assert.equal(result.ok, true);
    if (!result.ok || result.value.kind !== "resolved") continue;
    assert.deepEqual(result.value.intent, {
      kind,
      behavior,
      fieldId: fieldId("s1-field-given-name"),
      target: browserTargetToken("target-1"),
      ...payload,
      provenance: "owner_provided",
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.value), true);
    assert.equal(Object.isFrozen(result.value.intent), true);
  }
});

test("choice mapping uses each frozen row's exact behavior and visible option", async () => {
  const cases = [
    ["Are you authorized to work in this location? Required", "radio", true, "s1-option-work-authorization-no", "No", "s1-option-work-authorization-yes", "Yes"],
    ["Will you require sponsorship?", "select", true, "s1-option-sponsorship-no", "No", "s1-option-sponsorship-yes", "Yes"],
    ["Country", "listbox", "United States", "s1-option-country-ca", "Canada", "s1-option-country-us", "United States"],
  ] as const;

  for (const [label, behavior, value, otherOptionId, otherOptionLabel, expectedOptionId, expectedOptionLabel] of cases) {
    const options = Object.freeze([
      Object.freeze({ id: optionId(otherOptionId), label: boundedText(otherOptionLabel) }),
      Object.freeze({ id: optionId(expectedOptionId), label: boundedText(expectedOptionLabel) }),
    ]);
    const { resolver } = resolverWith({
      kind: "answered",
      value,
      provenance: "owner_provided",
      lane: "live_owner_fact",
    });
    const result = await resolver.resolve(
      request(field(label, behavior, options)),
      new AbortController().signal,
    );
    assert.deepEqual(result, {
      ok: true,
      value: {
        kind: "resolved",

        lane: "live_owner_fact",
        intent: {
          kind: "choice",
          behavior,
          fieldId: fieldId("s1-field-given-name"),
          target: browserTargetToken("target-1"),
          optionId: optionId(expectedOptionId),
          expectedOption: boundedText(expectedOptionLabel),
          provenance: "owner_provided",
        },
      },
    });
  }
});

test("age aliases reject non-owner answers", async () => {
  const { resolver } = resolverWith({
    kind: "answered",
    value: true,
    provenance: "resume_verified",
    lane: "live_owner_fact",
  });
  const options = Object.freeze([
    Object.freeze({ id: optionId("age-yes"), label: boundedText("Yes") }),
    Object.freeze({ id: optionId("age-no"), label: boundedText("No") }),
  ]);

  assert.deepEqual(await resolver.resolve(
    request(field("Are you 18 years of age or older?", "radio", options)),
    new AbortController().signal,
  ), {
    ok: false,
    error: { code: "protected_answer_denied", retryable: false },
  });
});

test("semantic demographic privacy choices still require an owner fact", async () => {
  const profile = createProfileQueryFake();
  const resolver = createAnswerResolver(profile.port, "Narrative.");
  const options = Object.freeze([
    Object.freeze({ id: optionId("gender-neutral"), label: boundedText("Prefer not to answer") }),
  ]);

  assert.deepEqual(await resolver.resolve(
    request(field("Select your gender", "listbox", options)),
    new AbortController().signal,
  ), { ok: false, error: { code: "protected_answer_denied", retryable: false } });
  assert.equal(profile.calls.length, 1);
});

test("demographic declarations never fall back to the first visible option", async () => {
  const profile = createProfileQueryFake();
  const resolver = createAnswerResolver(profile.port, "Narrative.");
  for (const [label, visible] of [
    ["Gender", "Female"],
    ["Veteran Status", "Protected veteran"],
    ["Disability Status", "No"],
  ] as const) {
    assert.deepEqual(await resolver.resolve(request(field(label, "listbox", [{
      id: optionId("first-visible"),
      label: boundedText(visible),
    }])), new AbortController().signal), {
      ok: false,
      error: { code: "protected_answer_denied", retryable: false },
    });
  }
  assert.deepEqual(profile.calls.map(({ request: input }) =>
    (input as { readonly factId: string }).factId
  ), [
    "gender_disclosure", "veteran_disclosure", "disability_disclosure",
  ]);
});

test("protected placeholders fail closed while low-risk placeholders remain available", async () => {
  const profile = createProfileQueryFake({
    query: { ok: true, value: { kind: "profile_answer_missing" } },
  });
  const resolver = createAnswerResolver(profile.port, "Narrative.");
  const yesNo = Object.freeze([
    Object.freeze({ id: optionId("prior-yes"), label: boundedText("Yes") }),
    Object.freeze({ id: optionId("prior-no"), label: boundedText("No") }),
  ]);
  for (const protectedField of [
    field("Have you ever been employed by QTS Data Centers?", "radio", yesNo),
    field("Yes, I have read and consent to the terms and conditions", "checkbox"),
    field("I Agree", "checkbox"),
  ]) {
    assert.deepEqual(await resolver.resolve(
      request(protectedField),
      new AbortController().signal,
    ), {
      ok: true,
      value: {
        kind: "profile_answer_missing",
        questionId: protectedField.label.includes("employed")
          ? "workday-placeholder-prior-employment"
          : "workday-placeholder-terms-consent",
      },
    });
  }

  const sources = Object.freeze([
    Object.freeze({ id: optionId("source-linkedin"), label: boundedText("LinkedIn") }),
  ]);
  assert.deepEqual(await resolver.resolve(
    syntheticRequest(field("How Did You Hear About Us?", "select", sources)),
    new AbortController().signal,
  ), {
    ok: true,
    value: {
      kind: "resolved",

      lane: "synthetic_test_default",
      intent: {
        kind: "choice",
        behavior: "select",
        fieldId: "s1-field-given-name",
        target: "target-1",
        optionId: "source-linkedin",
        expectedOption: "LinkedIn",
        provenance: "reviewed_catalog",
      },
    },
  });
  assert.ok(profile.calls.length >= 1);
});

test("visible option no-match and ambiguity remain distinct and immutable", () => {
  const noMatch = mapVisibleOption(true, [
    { id: optionId("option-no"), label: boundedText("No") },
  ]);
  const ambiguous = mapVisibleOption(true, [
    { id: optionId("option-yes"), label: boundedText("Yes") },
    { id: optionId("option-y"), label: boundedText("Y") },
  ]);

  assert.deepEqual(noMatch, { kind: "option_no_match" });
  assert.deepEqual(ambiguous, { kind: "option_ambiguous" });
  assert.equal(Object.isFrozen(noMatch), true);
  assert.equal(Object.isFrozen(ambiguous), true);
});

test("missing and non-owner protected facts fail closed", async () => {
  const cases = [
    ["Available start date", "date", "s1-question-earliest-start-date", "2026-09-01"],
    ["Are you authorized to work in this location?", "radio", "s1-question-work-authorization", true],
    ["Will you require sponsorship?", "select", "s1-question-sponsorship-required", false],
    ["I am at least 18 years of age.", "checkbox", "s1-question-age-requirement-met", true],
  ] as const;

  for (const [label, behavior, expectedQuestionId, value] of cases) {
    const options = behavior === "radio" || behavior === "select"
      ? Object.freeze([
          { id: optionId(`${expectedQuestionId}-yes`), label: boundedText("Yes") },
          { id: optionId(`${expectedQuestionId}-no`), label: boundedText("No") },
        ])
      : undefined;
    const missing = resolverWith({ kind: "profile_answer_missing" });
    const generated = await missing.resolver.resolve(
      request(field(label, behavior, options)),
      new AbortController().signal,
    );
    assert.deepEqual(generated, {
      ok: true,
      value: { kind: "profile_answer_missing", questionId: expectedQuestionId },
    });

    const unowned = resolverWith({
      kind: "answered",
      value,
      provenance: "resume_verified",
      lane: "live_owner_fact",
    });
    const fallback = await unowned.resolver.resolve(
      request(field(label, behavior, options)),
      new AbortController().signal,
    );
    assert.deepEqual(fallback, {
      ok: false,
      error: { code: "protected_answer_denied", retryable: false },
    });
  }
});

test("owner-provided protected choices defer exact matching when Workday mounts options on open", async () => {
  for (const [label, value, expectedOption, expectedId] of [
    ["Are you authorized to work in this location?", true, "Yes", "deferred-yes"],
    ["Will you require sponsorship?", false, "No", "deferred-no"],
  ] as const) {
    const { resolver } = resolverWith({
      kind: "answered",
      value,
      provenance: "owner_provided",
      lane: "live_owner_fact",
    });
    const result = await resolver.resolve(
      request(field(label, "select", [
        { id: optionId("placeholder-only"), label: boundedText("Select One") },
      ])),
      new AbortController().signal,
    );
    assert.equal(result.ok && result.value.kind, "resolved");
    if (!result.ok || result.value.kind !== "resolved" || result.value.intent.kind !== "choice") {
      continue;
    }
    assert.equal(result.value.intent.optionId, expectedId);
    assert.equal(result.value.intent.expectedOption, expectedOption);
    assert.equal(result.value.intent.provenance, "owner_provided");
  }
});

test("configured narrative fallback is available only in synthetic mode", async () => {
  const profile = createProfileQueryFake({
    query: { ok: true, value: { kind: "profile_answer_missing" } },
  });
  const resolver = createAnswerResolver(profile.port, undefined);
  const answer = await resolver.resolve(
    syntheticRequest(field("Brief interest statement", "textarea")),
    new AbortController().signal,
  );

  assert.equal(answer.ok, true);
  assert.equal(answer.ok && answer.value.kind, "resolved");
  if (answer.ok && answer.value.kind === "resolved") {
    assert.equal(answer.value.intent.provenance, "reviewed_catalog");
  }
  assert.equal(profile.calls.length, 1);
});

test("unknown dates use the injected local calendar date only in synthetic mode", async () => {
  const profile = createProfileQueryFake();
  const resolver = createAnswerResolver(profile.port, undefined, "2026-08-20");
  const answer = await resolver.resolve(
    syntheticRequest(field("Date signed", "date")),
    new AbortController().signal,
  );

  assert.equal(answer.ok, true);
  if (answer.ok && answer.value.kind === "resolved") {
    assert.equal(answer.value.intent.kind, "date");
    if (answer.value.intent.kind === "date") {
      assert.equal(answer.value.intent.isoDate, "2026-08-20");
      assert.equal(answer.value.intent.provenance, "reviewed_catalog");
    }
  }
});

test("configured narrative is owner-bound while the selected resume artifact bypasses ProfileQuery", async () => {
  const profile = createProfileQueryFake({ query: { ok: true, value: {
    kind: "answered",
    value: "One configured narrative.",
    provenance: "configured_template",
    lane: "live_owner_fact",
  } } as never });
  const resolver = createAnswerResolver(profile.port, "One configured narrative.");

  const narrative = await resolver.resolve(
    request(field("Brief interest statement", "textarea")),
    new AbortController().signal,
  );
  assert.equal(narrative.ok, true);
  if (narrative.ok && narrative.value.kind === "resolved") {
    assert.equal(narrative.value.intent.kind, "text");
    if (narrative.value.intent.kind === "text") {
      assert.equal(narrative.value.intent.value, "One configured narrative.");
      assert.equal(narrative.value.intent.provenance, "configured_template");
    }
  }

  const resumeRequest = request(field("Resume", "file_upload"));
  const resume = await resolver.resolve(resumeRequest, new AbortController().signal);
  assert.equal(resume.ok, true);
  if (resume.ok && resume.value.kind === "resolved") {
    assert.equal(resume.value.lane, "live_owner_fact");
    assert.equal(resume.value.intent.kind, "resume_upload");
    if (resume.value.intent.kind === "resume_upload") {
      assert.equal(resume.value.intent.artifact, resumeRequest.resumeArtifact);
      assert.equal(resume.value.intent.provenance, "resume_verified");
    }
  }
  const syntheticResume = await resolver.resolve(
    syntheticRequest(field("Resume", "file_upload")),
    new AbortController().signal,
  );
  assert.equal(syntheticResume.ok && syntheticResume.value.kind === "resolved" &&
    syntheticResume.value.lane, "synthetic_test_default");
  assert.equal(profile.calls.length, 1);
});

test("an unresolved narrative uses its deterministic fallback only in synthetic mode", async () => {
  const profile = createProfileQueryFake({
    query: {
      ok: true,
      value: { kind: "profile_answer_missing" },
    },
  });
  const resolver = createAnswerResolver(profile.port, undefined);

  assert.deepEqual(await resolver.resolve(
    syntheticRequest(field("Brief interest statement", "textarea")),
    new AbortController().signal,
  ), {
    ok: true,
    value: {
      kind: "resolved",

      lane: "synthetic_test_default",
      intent: {
        kind: "text",
        behavior: "textarea",
        fieldId: "s1-field-given-name",
        target: "target-1",
        value: "I am interested in this role and available to discuss my qualifications.",
        provenance: "reviewed_catalog",
      },
    },
  });
  const name = await resolver.resolve(
    request(field("Given name")),
    new AbortController().signal,
  );
  assert.equal(name.ok && name.value.kind, "profile_answer_missing");
  assert.equal(profile.calls.length, 2);
});

test("every ProfileQuery failure is returned unchanged and never thrown", async () => {
  for (const code of [
    "profile_query_invalid",
    "profile_missing",
    "profile_revision_mismatch",
    "operation_cancelled",
  ] as const) {
    const error = providerError(code) as ProfileQueryError | ReturnType<typeof providerError<"operation_cancelled">>;
    const dependencyResult = { ok: false as const, error };
    const profile = createProfileQueryFake({ query: dependencyResult });
    const resolver = createAnswerResolver(profile.port, "Configured narrative.");

    const result = await resolver.resolve(
      request(field("Given name")),
      new AbortController().signal,
    );
    assert.deepEqual(result, { ok: false, error });
    assert.equal(result, dependencyResult);
    if (!result.ok) assert.equal(result.error, error);
  }
});

test("unknown and invalid fields generate only in synthetic mode while other states remain explicit", async () => {
  const { resolver, profile } = resolverWith({
    kind: "answered",
    value: "2026-13-01",
    provenance: "owner_provided",
    lane: "live_owner_fact",
  });
  const signal = new AbortController().signal;

  const unknown = await resolver.resolve(syntheticRequest(field("Unreviewed")), signal);
  assert.equal(unknown.ok && unknown.value.kind, "resolved");
  if (unknown.ok && unknown.value.kind === "resolved") {
    assert.equal(unknown.value.intent.provenance, "reviewed_catalog");
  }
  for (const observed of [
    field("Given name", "unsupported"),
    field("Given name", "text", [], "hidden"),
    field("Given name", "text", [], "ambiguous"),
  ]) {
    assert.deepEqual(await resolver.resolve(request(observed), signal), {
      ok: true,
      value: { kind: "unsupported", fieldId: fieldId("s1-field-given-name") },
    });
  }
  const generated = await resolver.resolve(syntheticRequest(field("Given name", "textarea")), signal);
  assert.equal(generated.ok && generated.value.kind, "resolved");
  assert.deepEqual(await resolver.resolve(
    request(field("Are you at least 18 years of age?", "textarea")),
    signal,
  ), { ok: false, error: { code: "protected_answer_denied", retryable: false } });
  assert.deepEqual(await resolver.resolve(request(field("Available start date", "date")), signal), {
    ok: false,
    error: { code: "protected_answer_denied", retryable: false },
  });
  const callsBeforeAbort = profile.calls.length;
  assert.deepEqual(await resolver.resolve(request(field("Given name")), AbortSignal.abort()), {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
  assert.equal(profile.calls.length, callsBeforeAbort);
});

test("unknown choices select the first visible non-placeholder option only in synthetic mode", async () => {
  const { resolver } = resolverWith({ kind: "profile_answer_missing" });
  const result = await resolver.resolve(syntheticRequest(field(
    "Unreviewed choice",
    "select",
    [
      { id: optionId("option-placeholder"), label: boundedText("Select One") },
      { id: optionId("option-first"), label: boundedText("First available") },
      { id: optionId("option-second"), label: boundedText("Second available") },
    ],
  )), new AbortController().signal);
  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "resolved",

      lane: "synthetic_test_default",
      intent: {
        kind: "choice",
        behavior: "select",
        fieldId: "s1-field-given-name",
        target: "target-1",
        optionId: "option-first",
        expectedOption: "First available",
        provenance: "visible_option",
      },
    },
  });
});

test("protected choices never fall back to a visible learning option", async () => {
  const { resolver } = resolverWith({
    kind: "answered",
    value: "Not visible",
    provenance: "owner_provided",
    lane: "live_owner_fact",
  });
  const result = await resolver.resolve(request(field(
    "Will you require sponsorship?",
    "select",
    [{ id: optionId("sponsor-no"), label: boundedText("No") }],
  )), new AbortController().signal);
  assert.deepEqual(result, {
    ok: false,
    error: { code: "protected_answer_denied", retryable: false },
  });
});

test("missing protected profile facts never fall back to a visible learning option", async () => {
  const { resolver } = resolverWith({ kind: "profile_answer_missing" });
  const result = await resolver.resolve(request(field(
    "Years of Experience",
    "select",
    [{ id: optionId("experience-visible"), label: boundedText("Less than one year") }],
  )), new AbortController().signal);
  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "profile_answer_missing",
      questionId: "workday-question-years-experience",
    },
  });
});
