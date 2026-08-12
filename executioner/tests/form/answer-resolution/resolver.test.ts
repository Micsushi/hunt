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
  type ProfileQueryError,
} from "../../../src/contracts/index.ts";
import { createAnswerResolver } from "../../../src/form/answers/resolver.ts";
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
    field: observed,
    profileId: upstreamProfileId("profile-1"),
    profileRevision: 3,
    resume,
    resumeArtifact,
  });
}

function resolverWith(answer: ProfileAnswerResult) {
  const profile = createProfileQueryFake({ query: { ok: true, value: answer } });
  return {
    resolver: createAnswerResolver(profile.port, "I am interested in this role."),
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
    ["Are you authorized to work in this location?", "radio", true, "s1-option-work-authorization-no", "No", "s1-option-work-authorization-yes", "Yes"],
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
    });
    const result = await resolver.resolve(
      request(field(label, behavior, options)),
      new AbortController().signal,
    );
    assert.deepEqual(result, {
      ok: true,
      value: {
        kind: "resolved",
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

test("age aliases reject non-owner answers before producing an intent", async () => {
  const { resolver } = resolverWith({
    kind: "answered",
    value: true,
    provenance: "resume_verified",
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

test("reviewed demographic defaults are denied without querying profile facts", async () => {
  const profile = createProfileQueryFake();
  const resolver = createAnswerResolver(profile.port, "Narrative.");
  const options = Object.freeze([
    Object.freeze({ id: optionId("gender-neutral"), label: boundedText("Prefer not to answer") }),
  ]);

  assert.deepEqual(await resolver.resolve(
    request(field("Gender", "listbox", options)),
    new AbortController().signal,
  ), {
    ok: false,
    error: { code: "protected_answer_denied", retryable: false },
  });
  assert.deepEqual(profile.calls, []);
});

test("synthetic facts never become owner facts or mutation intents", async () => {
  const profile = createProfileQueryFake();
  const resolver = createAnswerResolver(profile.port, "Narrative.");
  const yesNo = Object.freeze([
    Object.freeze({ id: optionId("prior-yes"), label: boundedText("Yes") }),
    Object.freeze({ id: optionId("prior-no"), label: boundedText("No") }),
  ]);
  assert.deepEqual(await resolver.resolve(
    request(field("Have you ever been employed by QTS Data Centers?", "radio", yesNo)),
    new AbortController().signal,
  ), {
    ok: false,
    error: { code: "protected_answer_denied", retryable: false },
  });

  const sources = Object.freeze([
    Object.freeze({ id: optionId("source-linkedin"), label: boundedText("LinkedIn") }),
  ]);
  assert.deepEqual(await resolver.resolve(
    request(field("How Did You Hear About Us?", "select", sources)),
    new AbortController().signal,
  ), {
    ok: true,
    value: {
      kind: "profile_answer_missing",
      questionId: "workday-placeholder-application-source",
    },
  });
  assert.deepEqual(profile.calls, []);
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

test("missing and protected facts never become holding values", async () => {
  const cases = [
    ["Available start date", "date", "s1-question-earliest-start-date", "2026-09-01"],
    ["Are you authorized to work in this location?", "radio", "s1-question-work-authorization", true],
    ["Will you require sponsorship?", "select", "s1-question-sponsorship-required", false],
    ["I am at least 18 years of age.", "checkbox", "s1-question-age-requirement-met", true],
  ] as const;

  for (const [label, behavior, expectedQuestionId, value] of cases) {
    const missing = resolverWith({ kind: "profile_answer_missing" });
    assert.deepEqual(
      await missing.resolver.resolve(
        request(field(label, behavior)),
        new AbortController().signal,
      ),
      {
        ok: true,
        value: {
          kind: "profile_answer_missing",
          questionId: expectedQuestionId,
        },
      },
    );

    const unowned = resolverWith({
      kind: "answered",
      value,
      provenance: "resume_verified",
    });
    assert.deepEqual(
      await unowned.resolver.resolve(
        request(field(label, behavior)),
        new AbortController().signal,
      ),
      { ok: false, error: { code: "protected_answer_denied", retryable: false } },
    );
  }
});

test("configured narrative and selected resume artifact bypass ProfileQuery", async () => {
  const profile = createProfileQueryFake();
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
    assert.equal(resume.value.intent.kind, "resume_upload");
    if (resume.value.intent.kind === "resume_upload") {
      assert.equal(resume.value.intent.artifact, resumeRequest.resumeArtifact);
      assert.equal(resume.value.intent.provenance, "resume_verified");
    }
  }
  assert.deepEqual(profile.calls, []);
});

test("an unresolved narrative blocks only its exact question", async () => {
  const profile = createProfileQueryFake({
    query: {
      ok: true,
      value: { kind: "answered", value: "Ada", provenance: "owner_provided" },
    },
  });
  const resolver = createAnswerResolver(profile.port, undefined);

  assert.deepEqual(await resolver.resolve(
    request(field("Brief interest statement", "textarea")),
    new AbortController().signal,
  ), {
    ok: true,
    value: {
      kind: "profile_answer_missing",
      questionId: "s1-question-configured-narrative",
    },
  });
  const name = await resolver.resolve(
    request(field("Given name")),
    new AbortController().signal,
  );
  assert.equal(name.ok && name.value.kind, "resolved");
  assert.equal(profile.calls.length, 1);
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

test("unknown, hidden, ambiguous, unsupported, invalid date, and abort are explicit", async () => {
  const { resolver, profile } = resolverWith({
    kind: "answered",
    value: "2026-13-01",
    provenance: "owner_provided",
  });
  const signal = new AbortController().signal;

  assert.deepEqual(await resolver.resolve(request(field("Unreviewed")), signal), {
    ok: false,
    error: { code: "question_unknown", retryable: false },
  });
  for (const observed of [
    field("Given name", "unsupported"),
    field("Given name", "text", [], "hidden"),
    field("Given name", "text", [], "ambiguous"),
    field("Given name", "textarea"),
    field("Are you at least 18 years of age?", "textarea"),
  ]) {
    assert.deepEqual(await resolver.resolve(request(observed), signal), {
      ok: true,
      value: { kind: "unsupported", fieldId: fieldId("s1-field-given-name") },
    });
  }
  assert.deepEqual(await resolver.resolve(request(field("Available start date", "date")), signal), {
    ok: true,
    value: { kind: "unsupported", fieldId: fieldId("s1-field-given-name") },
  });
  const callsBeforeAbort = profile.calls.length;
  assert.deepEqual(await resolver.resolve(request(field("Given name")), AbortSignal.abort()), {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
  assert.equal(profile.calls.length, callsBeforeAbort);
});
