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

test("unknown choices randomly select a visible non-placeholder option only in synthetic mode", async () => {
  const profile = createProfileQueryFake({
    query: { ok: true, value: { kind: "profile_answer_missing" } },
  });
  const resolver = createAnswerResolver(
    profile.port,
    "I am interested in this role.",
    "2026-08-20",
    (length) => length - 1,
  );
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
        optionId: "option-second",
        expectedOption: "Second available",
        provenance: "visible_option",
      },
    },
  });
});

test("synthetic mode traverses protected catalogs without an owner answer", async () => {
  const demographic = resolverWith({ kind: "profile_answer_missing" });
  const demographicResult = await demographic.resolver.resolve(syntheticRequest(field(
    "Gender",
    "listbox",
    [
      { id: optionId("gender-alpha"), label: boundedText("Female") },
      { id: optionId("gender-beta"), label: boundedText("Male") },
    ],
  )), new AbortController().signal);
  assert.equal(demographicResult.ok && demographicResult.value.kind, "resolved");
  if (demographicResult.ok && demographicResult.value.kind === "resolved") {
    assert.equal(demographicResult.value.lane, "synthetic_test_default");
    assert.equal(demographicResult.value.intent.provenance, "visible_option");
  }

  const nonOwner = resolverWith({
    kind: "answered",
    value: true,
    provenance: "resume_verified",
    lane: "live_owner_fact",
  });
  const ownerOnlyResult = await nonOwner.resolver.resolve(syntheticRequest(field(
    "Are you authorized to work in this location?",
    "radio",
    [
      { id: optionId("authorization-yes"), label: boundedText("Yes") },
      { id: optionId("authorization-no"), label: boundedText("No") },
    ],
  )), new AbortController().signal);
  assert.equal(ownerOnlyResult.ok && ownerOnlyResult.value.kind, "resolved");
  if (ownerOnlyResult.ok && ownerOnlyResult.value.kind === "resolved") {
    assert.equal(ownerOnlyResult.value.lane, "synthetic_test_default");
    assert.equal(ownerOnlyResult.value.intent.provenance, "visible_option");
  }
});

test("one resolver keeps a random synthetic choice stable across conditional rescans", async () => {
  const profile = createProfileQueryFake({
    query: { ok: true, value: { kind: "profile_answer_missing" } },
  });
  let selection = 0;
  const resolver = createAnswerResolver(
    profile.port,
    "I am interested in this role.",
    "2026-08-20",
    () => selection++,
  );
  const observed = field("Unreviewed conditional choice", "select", [
    { id: optionId("option-yes"), label: boundedText("Yes") },
    { id: optionId("option-no"), label: boundedText("No") },
  ]);

  const first = await resolver.resolve(syntheticRequest(observed), new AbortController().signal);
  const rescanned = await resolver.resolve(
    syntheticRequest(observed),
    new AbortController().signal,
  );

  assert.deepEqual(rescanned, first);
  assert.equal(selection, 1);
});

test("one resolver keeps a random synthetic choice stable across remounted option identities", async () => {
  const profile = createProfileQueryFake({
    query: { ok: true, value: { kind: "profile_answer_missing" } },
  });
  let selection = 0;
  const resolver = createAnswerResolver(
    profile.port,
    "I am interested in this role.",
    "2026-08-20",
    () => selection++,
  );
  const first = field("Unreviewed conditional choice", "listbox", [
    { id: optionId("first-remount-yes"), label: boundedText("Yes") },
    { id: optionId("first-remount-no"), label: boundedText("No") },
  ]);
  const remounted = {
    ...first,
    target: browserTargetToken("target-remounted-choice"),
    options: Object.freeze([
      { id: optionId("second-remount-no"), label: boundedText("No") },
      { id: optionId("second-remount-yes"), label: boundedText("Yes") },
    ]),
  };

  const initial = await resolver.resolve(syntheticRequest(first), new AbortController().signal);
  const rescanned = await resolver.resolve(
    syntheticRequest(remounted),
    new AbortController().signal,
  );

  assert.equal(initial.ok && initial.value.kind, "resolved");
  assert.equal(rescanned.ok && rescanned.value.kind, "resolved");
  if (initial.ok && initial.value.kind === "resolved" && initial.value.intent.kind === "choice" &&
      rescanned.ok && rescanned.value.kind === "resolved" && rescanned.value.intent.kind === "choice") {
    assert.equal(rescanned.value.intent.expectedOption, initial.value.intent.expectedOption);
    assert.equal(rescanned.value.intent.target, remounted.target);
  }
  assert.equal(selection, 1);
});

test("synthetic choices are isolated by stable field slot for same-canonical disjoint catalogs", async () => {
  const profile = createProfileQueryFake({
    query: { ok: true, value: { kind: "profile_answer_missing" } },
  });
  const picks = [0, 1];
  const resolver = createAnswerResolver(
    profile.port,
    "I am interested in this role.",
    "2026-08-20",
    () => picks.shift() ?? 0,
  );
  const sponsorship = field("Will you require sponsorship?", "listbox", [
    { id: optionId("sponsorship-yes"), label: boundedText("Yes") },
    { id: optionId("sponsorship-no"), label: boundedText("No") },
  ]);
  const status = Object.freeze({
    ...field("If you require sponsorship, what is your current status?", "listbox", [
      { id: optionId("status-f1"), label: boundedText("F-1") },
      { id: optionId("status-h1b"), label: boundedText("H-1B") },
      { id: optionId("status-other"), label: boundedText("Other") },
      { id: optionId("status-none"), label: boundedText("None of these") },
    ]),
    fieldId: fieldId("field-sponsorship-status"),
    target: browserTargetToken("target-sponsorship-status"),
  });

  const first = await resolver.resolve(syntheticRequest(sponsorship), new AbortController().signal);
  const second = await resolver.resolve(syntheticRequest(status), new AbortController().signal);

  assert.equal(first.ok && first.value.kind, "resolved");
  assert.equal(second.ok && second.value.kind, "resolved");
  if (second.ok && second.value.kind === "resolved" && second.value.intent.kind === "choice") {
    assert.equal(second.value.intent.expectedOption, "H-1B");
  }
});

test("synthetic choices are isolated by stable field slot for equal normalized labels", async () => {
  const profile = createProfileQueryFake({
    query: { ok: true, value: { kind: "profile_answer_missing" } },
  });
  const resolver = createAnswerResolver(
    profile.port,
    "I am interested in this role.",
    "2026-08-20",
    () => 0,
  );
  const first = field("Other", "select", [
    { id: optionId("first-alpha"), label: boundedText("Alpha") },
    { id: optionId("first-beta"), label: boundedText("Beta") },
  ]);
  const second = Object.freeze({
    ...field("  OTHER  ", "select", [
      { id: optionId("second-gamma"), label: boundedText("Gamma") },
      { id: optionId("second-delta"), label: boundedText("Delta") },
    ]),
    fieldId: fieldId("field-other-second"),
    target: browserTargetToken("target-other-second"),
  });

  const initial = await resolver.resolve(syntheticRequest(first), new AbortController().signal);
  const distinct = await resolver.resolve(syntheticRequest(second), new AbortController().signal);

  assert.equal(initial.ok && initial.value.kind, "resolved");
  assert.equal(distinct.ok && distinct.value.kind, "resolved");
});

test("same-field option disappearance adopts a current committed site-valid selection", async () => {
  const profile = createProfileQueryFake({
    query: { ok: true, value: { kind: "profile_answer_missing" } },
  });
  let selections = 0;
  const resolver = createAnswerResolver(
    profile.port,
    "I am interested in this role.",
    "2026-08-20",
    () => selections++,
  );
  const initialField = field("Unreviewed choice", "listbox", [
    { id: optionId("initial-alpha"), label: boundedText("Alpha") },
    { id: optionId("initial-beta"), label: boundedText("Beta") },
  ]);
  const changedField = Object.freeze({
    ...initialField,
    target: browserTargetToken("target-remounted-current-choice"),
    options: Object.freeze([
      { id: optionId("changed-gamma"), label: boundedText("Gamma") },
      { id: optionId("changed-delta"), label: boundedText("Delta") },
    ]),
  });

  await resolver.resolve(syntheticRequest(initialField), new AbortController().signal);
  const adopted = await resolver.resolve(Object.freeze({
    ...syntheticRequest(changedField),
    committedReadback: { kind: "selected" as const, option: boundedText("Delta") },
  }), new AbortController().signal);

  assert.equal(adopted.ok && adopted.value.kind, "resolved");
  if (adopted.ok && adopted.value.kind === "resolved" && adopted.value.intent.kind === "choice") {
    assert.equal(adopted.value.intent.expectedOption, "Delta");
    assert.equal(adopted.value.syntheticReplacementReason, "committed_value_adopted");
  }
  assert.equal(selections, 1);
});

test("same-field option disappearance reselects once when no valid value is committed", async () => {
  const profile = createProfileQueryFake({
    query: { ok: true, value: { kind: "profile_answer_missing" } },
  });
  const picks = [1, 0];
  const resolver = createAnswerResolver(
    profile.port,
    "I am interested in this role.",
    "2026-08-20",
    () => picks.shift() ?? 0,
  );
  const initialField = field("Unreviewed choice", "radio", [
    { id: optionId("initial-alpha"), label: boundedText("Alpha") },
    { id: optionId("initial-beta"), label: boundedText("Beta") },
  ]);
  const changedField = Object.freeze({
    ...initialField,
    options: Object.freeze([
      { id: optionId("changed-gamma"), label: boundedText("Gamma") },
      { id: optionId("changed-delta"), label: boundedText("Delta") },
    ]),
  });

  await resolver.resolve(syntheticRequest(initialField), new AbortController().signal);
  const replaced = await resolver.resolve(syntheticRequest(changedField), new AbortController().signal);

  assert.equal(replaced.ok && replaced.value.kind, "resolved");
  if (replaced.ok && replaced.value.kind === "resolved" && replaced.value.intent.kind === "choice") {
    assert.equal(replaced.value.intent.expectedOption, "Gamma");
    assert.equal(replaced.value.syntheticReplacementReason, "cached_option_unavailable");
  }
});

test("unknown synthetic text honors bounded native types, quantified patterns, lengths, ranges, and steps", async () => {
  const { resolver } = resolverWith({ kind: "profile_answer_missing" });
  const cases = [
    [{ inputType: "email", min: null, max: null, step: null, minLength: null, maxLength: 64, pattern: null, readOnly: false }, "test@example.invalid"],
    [{ inputType: "url", min: null, max: null, step: null, minLength: null, maxLength: 64, pattern: null, readOnly: false }, "https://example.invalid/test"],
    [{ inputType: "number", min: 5, max: 11, step: 3, minLength: null, maxLength: null, pattern: null, readOnly: false }, "5"],
    [{ inputType: "text", min: null, max: null, step: null, minLength: null, maxLength: 6, pattern: "\\d{6}", readOnly: false }, /^\d{6}$/u],
    [{ inputType: "text", min: null, max: null, step: null, minLength: null, maxLength: 8, pattern: "EMP-\\d{4}", readOnly: false }, /^EMP-\d{4}$/u],
    [{ inputType: "text", min: null, max: null, step: null, minLength: 8, maxLength: 8, pattern: null, readOnly: false }, /^.{8}$/u],
    [{ inputType: "text", min: null, max: null, step: null, minLength: 3, maxLength: 5, pattern: "[A-Za-z0-9]+", readOnly: false }, /^[A-Za-z0-9]{3,5}$/u],
  ] as const;
  for (const [constraints, expected] of cases) {
    const observed = Object.freeze({
      ...field("Unreviewed constrained value", "text"),
      constraints,
    });
    const result = await resolver.resolve(syntheticRequest(observed), new AbortController().signal);
    assert.equal(result.ok && result.value.kind, "resolved");
    if (result.ok && result.value.kind === "resolved" && result.value.intent.kind === "text") {
      if (expected instanceof RegExp) assert.match(result.value.intent.value, expected);
      else assert.equal(result.value.intent.value, expected);
    }
  }

  const unsupported = await resolver.resolve(syntheticRequest(Object.freeze({
    ...field("Unreviewed constrained value", "text"),
    constraints: {
      inputType: "text" as const,
      min: null,
      max: null,
      step: null,
      minLength: null,
      maxLength: 8,
      pattern: "(A|B)",
      readOnly: false,
    },
  })), new AbortController().signal);
  assert.equal(unsupported.ok && unsupported.value.kind, "unsupported_constraint");
});

test("nonempty readonly fields are readback-only and empty required readonly fields diagnose UI support", async () => {
  const { resolver } = resolverWith({ kind: "profile_answer_missing" });
  const readonly = {
    inputType: "text" as const,
    min: null,
    max: null,
    maxLength: null,
    pattern: null,
    readOnly: true,
  };
  const populated = await resolver.resolve(syntheticRequest(Object.freeze({
    ...field("Derived identifier", "text", [], "populated"),
    constraints: readonly,
    readOnly: true,
  })), new AbortController().signal);
  const empty = await resolver.resolve(syntheticRequest(Object.freeze({
    ...field("Derived identifier", "text"),
    constraints: readonly,
    readOnly: true,
  })), new AbortController().signal);
  assert.deepEqual(populated, {
    ok: true,
    value: { kind: "readback_only", fieldId: fieldId("s1-field-given-name") },
  });
  assert.deepEqual(empty, {
    ok: true,
    value: { kind: "unsupported", fieldId: fieldId("s1-field-given-name") },
  });
});

test("semantic testing defaults distinguish qualifications from sponsorship", async () => {
  const profile = createProfileQueryFake({
    query: { ok: true, value: { kind: "profile_answer_missing" } },
  });
  const resolver = createAnswerResolver(
    profile.port,
    "I am interested in this role.",
    "2026-08-20",
    () => 0,
  );
  const yesNo = Object.freeze([
    { id: optionId("answer-no"), label: boundedText("No") },
    { id: optionId("answer-yes"), label: boundedText("Yes") },
  ]);
  for (const label of [
    "Do you meet all minimum qualifications listed in this job posting?",
    "Can you perform the essential functions of this job with or without accommodation?",
    "Do you certify that you are 18 years of age or older?",
  ]) {
    const result = await resolver.resolve(
      syntheticRequest(field(label, "listbox", yesNo)),
      new AbortController().signal,
    );
    assert.equal(result.ok && result.value.kind, "resolved");
    if (result.ok && result.value.kind === "resolved" && result.value.intent.kind === "choice") {
      assert.equal(result.value.intent.expectedOption, "Yes");
    }
  }

  const sponsorship = await resolver.resolve(syntheticRequest(field(
    "Will you now or in the future require visa sponsorship for employment?",
    "listbox",
    yesNo,
  )), new AbortController().signal);
  assert.equal(sponsorship.ok && sponsorship.value.kind, "resolved");
  if (sponsorship.ok && sponsorship.value.kind === "resolved" &&
      sponsorship.value.intent.kind === "choice") {
    assert.equal(sponsorship.value.intent.expectedOption, "No");
  }
});

test("missing prior-employment and employee-referral facts use semantic No defaults", async () => {
  const profile = createProfileQueryFake({
    query: { ok: true, value: { kind: "profile_answer_missing" } },
  });
  const resolver = createAnswerResolver(
    profile.port,
    "I am interested in this role.",
    "2026-08-20",
    () => 0,
  );
  const yesNo = Object.freeze([
    { id: optionId("answer-yes"), label: boundedText("Yes") },
    { id: optionId("answer-no"), label: boundedText("No") },
  ]);
  for (const label of [
    "Have you previously worked for this organization?",
    "Have you been referred by an employee of Integer?",
  ]) {
    const result = await resolver.resolve(
      syntheticRequest(field(label, "listbox", yesNo)),
      new AbortController().signal,
    );
    assert.equal(result.ok && result.value.kind, "resolved");
    if (result.ok && result.value.kind === "resolved" && result.value.intent.kind === "choice") {
      assert.equal(result.value.intent.expectedOption, "No");
    }
  }
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

test("durable prior-employment and employee-referral facts resolve to No", async () => {
  const queried: string[] = [];
  const profile: ApplicationProfileQuery = Object.freeze({
    async query(input: Parameters<ApplicationProfileQuery["query"]>[0]) {
      queried.push(input.factId);
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          kind: "answered" as const,
          value: false,
          provenance: "owner_provided" as const,
          lane: "live_owner_fact" as const,
        }),
      });
    },
  });
  const resolver = createAnswerResolver(profile, "I am interested in this role.");
  const options = Object.freeze([
    { id: optionId("answer-yes"), label: boundedText("Yes") },
    { id: optionId("answer-no"), label: boundedText("No") },
  ]);
  for (const label of [
    "Have you previously worked for this organization? If Yes, please answer the questions below. If No, please continue to the next page.",
    "Have you ever been employed by Adient?",
    "Have you been referred by an associate?",
  ]) {
    const result = await resolver.resolve(
      request(field(label, "radio", options)),
      new AbortController().signal,
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.kind, "resolved");
    if (!result.ok || result.value.kind !== "resolved" || result.value.intent.kind !== "choice") {
      continue;
    }
    assert.equal(result.value.intent.expectedOption, "No");
    assert.equal(result.value.intent.provenance, "owner_provided");
    assert.equal(result.value.lane, "live_owner_fact");
  }
  assert.deepEqual(queried, [
    "previously_worked_for_organization",
    "previously_worked_for_organization",
    "associate_referral",
  ]);
});

test("missing known facts use editable defaults only in non-submittable learning mode", async () => {
  const { resolver } = resolverWith({ kind: "profile_answer_missing" });
  const options = Object.freeze([
    { id: optionId("experience-placeholder"), label: boundedText("Select One") },
    { id: optionId("experience-first"), label: boundedText("Less than one year") },
  ]);
  assert.deepEqual(await resolver.resolve(syntheticRequest(field(
    "Years of Experience",
    "select",
    options,
  )), new AbortController().signal), {
    ok: true,
    value: {
      kind: "resolved",
      lane: "synthetic_test_default",
      intent: {
        kind: "choice",
        behavior: "select",
        fieldId: "s1-field-given-name",
        target: "target-1",
        optionId: "experience-first",
        expectedOption: "Less than one year",
        provenance: "visible_option",
      },
    },
  });
});
