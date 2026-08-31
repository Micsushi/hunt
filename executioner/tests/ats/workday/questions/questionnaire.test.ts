import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  boundedText,
  browserPageId,
  browserTargetToken,
  fieldId,
  guardRevision,
  journeyId,
  optionId,
  upstreamProfileId,
  upstreamResumeId,
  type BrowserSessionId,
  type FieldDriver,
  type FieldObservation,
  type FieldVerifier,
  type OperationId,
  type ProfileQuery,
} from "../../../../src/contracts/index.ts";
import type { ApplicationAnswerResolver } from
  "../../../../src/form/answers/application-types.ts";
import type {
  ClassificationLayer,
  SanitizedStructuralObservationV1,
  UnknownCandidateId,
} from "../../../../src/contracts/live/index.ts";
import {
  createConfiguredNarrativeProvider,
  createQuestionnairePageHandler,
  resolveActiveListbox,
  type ActiveListboxEvidence,
  type ConfiguredNarrativeProvider,
  type QuestionnairePageHandlerDependencies,
} from "../../../../src/ats/workday/application/questions/index.ts";
import { createResumeArtifactFixture } from "../../../../src/testing/contracts/index.ts";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/questionnaire-v1.json", import.meta.url),
  "utf8",
)) as {
  readonly activeListbox: ActiveListboxEvidence;
  readonly unknownQuestionObservation: SanitizedStructuralObservationV1;
  readonly ambiguousOptionObservation: SanitizedStructuralObservationV1;
};

function field(
  id: string,
  label: string,
  behavior: FieldObservation["behavior"],
  options: FieldObservation["options"] = [],
): FieldObservation {
  return Object.freeze({
    fieldId: fieldId(id),
    target: browserTargetToken(`target-${id}`),
    label: boundedText(label),
    required: true,
    behavior,
    options,
    state: "empty",
  });
}

const narrativeField = field(
  "s2-field-interest",
  "Brief interest statement",
  "textarea",
);
const authorizationField = field(
  "s2-field-work-authorization",
  "Are you authorized to work in this location?",
  "radio",
  [
    { id: optionId("s2-option-auth-yes"), label: boundedText("Yes") },
    { id: optionId("s2-option-auth-no"), label: boundedText("No") },
  ],
);
const countryField = field(
  "s2-field-country",
  "Country",
  "listbox",
  [
    { id: optionId("s2-option-country-ca"), label: boundedText("Canada") },
    { id: optionId("s2-option-country-us"), label: boundedText("United States") },
  ],
);

function request(fields: readonly FieldObservation[]) {
  return {
    mode: "live" as const,
    answerFallbackPolicy: "owner_facts_only" as const,
    journeyId: journeyId("journey_questionnaire_fixture_1"),
    sessionId: "browser_session_questionnaire_fixture_1" as BrowserSessionId,
    pageId: browserPageId("page-questionnaire"),
    guardRevision: guardRevision("guard-questionnaire-v1"),
    profileId: upstreamProfileId("profile-questionnaire-fixture"),
    profileRevision: 7,
    resume: {
      resumeId: upstreamResumeId("resume-questionnaire-fixture"),
      sha256: "6a5c5b7838b3f7a7bf24b7e9ca49141f10ee68b2e14c9ee43eba3fdecf7173cc",
    },
    resumeArtifact: createResumeArtifactFixture(),
    page: {
      pageIdentity: { kind: "workday", page: "questionnaire" } as const,
      fields,
    },
    activeListboxes: {
      [countryField.fieldId]: fixture.activeListbox,
    },
  };
}

function dependencies(options: {
  readonly profile?: ProfileQuery;
    readonly resolver?: ApplicationAnswerResolver;
  readonly driver?: FieldDriver;
  readonly verifier?: FieldVerifier;
  readonly observation?: SanitizedStructuralObservationV1;
  readonly narrative?: ConfiguredNarrativeProvider;
  readonly previouslyVerified?: QuestionnairePageHandlerDependencies["previouslyVerified"];
  readonly recordVerified?: QuestionnairePageHandlerDependencies["recordVerified"];
  readonly recordAttempt?: QuestionnairePageHandlerDependencies["recordAttempt"];
} = {}) {
  const calls = { resolved: 0, driven: 0, verified: 0 };
  let operation = 0;
  const profile: ProfileQuery = options.profile ?? {
    async query(input) {
      const values = {
        work_authorization: false,
        country: "United States",
        configured_narrative: "Exact configured interest statement.",
      } as const;
      const value = values[input.factId as keyof typeof values];
      return value === undefined
        ? { ok: true, value: { kind: "profile_answer_missing" } }
        : {
            ok: true,
            value: {
              kind: "answered",
              value,
              provenance: input.factId === "configured_narrative"
                ? "configured_template"
                : "owner_provided",
              lane: "live_owner_fact",
            },
          };
    },
  };
  const driver: FieldDriver = options.driver ?? {
    async drive(input) {
      calls.driven += 1;
      return {
        ok: true,
        value: {
          operationId: input.operationId,
          fieldId: input.intent.fieldId,
          behavior: input.intent.behavior,
          attempted: true,
        },
      };
    },
  };
  const verifier: FieldVerifier = options.verifier ?? {
    async verify(input) {
      calls.verified += 1;
      return {
        ok: true,
        value: { kind: "verified", fieldId: input.intent.fieldId },
      };
    },
  };
  return {
    calls,
    handler: createQuestionnairePageHandler({
      profileQuery: profile,
      answerResolver: options.resolver,
      driver,
      verifier,
      narrative: options.narrative ?? createConfiguredNarrativeProvider({
        revision: "narrative-questionnaire-v1",
        template: "Exact configured interest statement.",
      }),
      nextOperationId() {
        operation += 1;
        return `operation_questionnaire_${operation.toString().padStart(16, "0")}` as OperationId;
      },
      allocateCandidateId() {
        return "unknown_candidate_questionnaire_01" as UnknownCandidateId;
      },
      observationFor(_fieldId, layer: ClassificationLayer) {
        return options.observation?.layer === layer ? options.observation : undefined;
      },
      previouslyVerified: options.previouslyVerified,
      recordVerified: options.recordVerified,
      recordAttempt: options.recordAttempt,
    }),
  };
}

test("required narrative and fixed choices resolve canonically and independently verify", async () => {
  const { handler, calls } = dependencies();
  const result = await handler.complete(
    request([narrativeField, authorizationField, countryField]),
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "verified",
      answers: [
        {
          pageId: "page-questionnaire",
          fieldId: narrativeField.fieldId,
          questionId: "s1-question-configured-narrative",
          provenance: "configured_template",
          lane: "live_owner_fact",
          protectedCategory: null,
          templateRevision: "narrative-questionnaire-v1",
          verification: "independent",
        },
        {
          pageId: "page-questionnaire",
          fieldId: authorizationField.fieldId,
          questionId: "s1-question-work-authorization",
          provenance: "owner_provided",
          lane: "live_owner_fact",
          protectedCategory: "authorization",
          templateRevision: null,
          verification: "independent",
        },
        {
          pageId: "page-questionnaire",
          fieldId: countryField.fieldId,
          questionId: "s1-question-country",
          provenance: "owner_provided",
          lane: "live_owner_fact",
          protectedCategory: null,
          templateRevision: null,
          verification: "independent",
        },
      ],
      protectedPlaceholderCount: 0,
    },
  });
  assert.deepEqual(calls, { resolved: 0, driven: 3, verified: 3 });
});

test("a conditional rescan reuses only an exact previously verified field", async () => {
  const verified = new Set<string>();
  const conditionalReveals: boolean[] = [];
  const { handler, calls } = dependencies({
    previouslyVerified: ({ pageId, field, intent }) => verified.has(
      `${pageId}:${field.fieldId}:${intent.kind}:${intent.behavior}`,
    ),
    recordVerified: ({ pageId, field, intent }) => {
      verified.add(`${pageId}:${field.fieldId}:${intent.kind}:${intent.behavior}`);
    },
    recordAttempt: ({ conditionalReveal }) => {
      conditionalReveals.push(conditionalReveal ?? false);
    },
  });

  const first = await handler.complete(
    request([narrativeField]),
    new AbortController().signal,
  );
  const rescanned = await handler.complete(
    { ...request([narrativeField, authorizationField]), conditionalReveal: true },
    new AbortController().signal,
  );

  assert.equal(first.ok && first.value.kind, "verified");
  assert.equal(rescanned.ok && rescanned.value.kind, "verified");
  assert.deepEqual(calls, { resolved: 0, driven: 2, verified: 2 });
  assert.equal(verified.size, 2);
  assert.deepEqual(conditionalReveals, [false, true]);
});

test("protected non-owner answers fail closed before mutation", async () => {
  const profile: ProfileQuery = {
    async query() {
      return {
        ok: true,
        value: { kind: "answered", value: true, provenance: "resume_verified", lane: "live_owner_fact" },
      };
    },
  };
  const { handler, calls } = dependencies({ profile });
  const result = await handler.complete(
    request([authorizationField]),
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "blocked",
      code: "protected_answer_denied",
      fieldId: authorizationField.fieldId,
      protectedCategory: "authorization",
    },
  });
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("listbox mutations rely on the driver's exact owned-popup binding", async () => {
  const { handler, calls } = dependencies();
  const { activeListboxes: _legacyEvidence, ...withoutStaticPopup } = request([countryField]);
  const result = await handler.complete(
    withoutStaticPopup,
    new AbortController().signal,
  );

  assert.equal(result.ok && result.value.kind, "verified");
  assert.deepEqual(calls, { resolved: 0, driven: 1, verified: 1 });
});

test("unknown supported questions use deterministic editable fallback in live transport", async () => {
  const unknown = field("s2-field-unknown", "Describe your interest in this role", "textarea");
  const profile: ProfileQuery = {
    async query() {
      return { ok: true, value: { kind: "profile_answer_missing" } };
    },
  };
  const { handler, calls } = dependencies({
    profile,
    observation: fixture.unknownQuestionObservation,
  });

  const result = await handler.complete(
    {
      ...request([unknown]),
      answerFallbackPolicy: "deterministic_site_valid_editable",
    },
    new AbortController().signal,
  );

  assert.equal(result.ok && result.value.kind, "verified");
  if (result.ok && result.value.kind === "verified") {
    assert.equal(result.value.answers.length, 1);
    assert.equal(result.value.answers[0]?.lane, "synthetic_test_default");
    assert.equal(result.value.answers[0]?.provenance, "reviewed_catalog");
  }
  assert.deepEqual(calls, { resolved: 0, driven: 1, verified: 1 });
});

test("reviewed age aliases reject injected learning defaults", async () => {
  const age = field(
    "s2-field-age-requirement",
    "Are you 18 years of age or older?",
    "radio",
    [
      { id: optionId("s2-option-age-yes"), label: boundedText("Yes") },
      { id: optionId("s2-option-age-no"), label: boundedText("No") },
    ],
  );
  const resolver: ApplicationAnswerResolver = {
    async resolve(input) {
      return {
        ok: true,
        value: {
          kind: "resolved",

          lane: "synthetic_test_default",
          intent: {
            kind: "choice",
            behavior: "radio",
            fieldId: input.field.fieldId,
            target: input.field.target,
            optionId: optionId("s2-option-age-yes"),
            expectedOption: boundedText("Yes"),
            provenance: "reviewed_catalog",
          },
        },
      };
    },
  };
  const { handler, calls } = dependencies({ resolver });

  const result = await handler.complete(
    request([age]),
    new AbortController().signal,
  );
  assert.equal(result.ok && result.value.kind, "blocked");
  if (result.ok && result.value.kind === "blocked") {
    assert.equal(result.value.code, "profile_answer_missing");
    assert.equal(result.value.protectedCategory, "legal");
  }
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("protected synthetic employment facts fail closed", async () => {
  const priorEmployment = field(
    "s2-field-prior-employment",
    "Have you ever been employed by QTS Data Centers?",
    "radio",
    [
      { id: optionId("s2-option-prior-yes"), label: boundedText("Yes") },
      { id: optionId("s2-option-prior-no"), label: boundedText("No") },
    ],
  );
  const { handler, calls } = dependencies();

  const result = await handler.complete(
    request([priorEmployment]),
    new AbortController().signal,
  );
  assert.equal(result.ok && result.value.kind, "blocked");
  if (result.ok && result.value.kind === "blocked") {
    assert.equal(result.value.code, "profile_answer_missing");
    assert.equal(result.value.protectedCategory, "legal");
  }
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("compensation fails closed without owner provenance", async () => {
  const compensation = field(
    "s2-field-compensation",
    "Expectations on Compensation - Please state your expectations of total compensation for this position. (Please list a value and/or range)",
    "textarea",
  );
  const compensationRequirements = field(
    "s2-field-compensation-requirements",
    "Please indicate your annual salary and/or total compensation requirements",
    "textarea",
  );
  const { handler, calls } = dependencies();

  const result = await handler.complete(
    request([compensation, compensationRequirements]),
    new AbortController().signal,
  );

  assert.equal(result.ok && result.value.kind, "blocked");
  if (result.ok && result.value.kind === "blocked") {
    assert.equal(result.value.code, "profile_answer_missing");
    assert.equal(result.value.protectedCategory, "legal");
  }
  assert.deepEqual(calls, { resolved: 0, driven: 0, verified: 0 });

});

test("Integer truth-dependent wording families fail closed before mutation", async () => {
  const yesNo = [
    { id: optionId("s2-option-truth-yes"), label: boundedText("Yes") },
    { id: optionId("s2-option-truth-no"), label: boundedText("No") },
  ] as const;
  const cases = [
    field("s2-field-age", "Do you certify that you are 18 years of age or older?", "listbox", yesNo),
    field("s2-field-referral", "Have you been referred by an Integer associate?", "listbox", yesNo),
    field("s2-field-current-associate", "Are you a current Integer associate (this does not apply to contingent/contract work)?", "radio", yesNo),
    field("s2-field-previously-applied", "Have you previously applied for a position with our company?", "listbox", yesNo),
    field("s2-field-relatives", "Do you have any relatives currently employed by Integer?", "radio", yesNo),
    field("s2-field-sponsorship", "Do you now, or will you in the future, require sponsorship to work legally for Integer in the U.S.?", "listbox", yesNo),
    field("s2-field-essential-functions", "Based on your understanding of this role, do you believe you are physically able to perform the essential functions of the job?", "radio", yesNo),
    field("s2-field-agreement", "Are you currently subject to any company agreement (NDA, Non-compete, etc.) that would prevent you from working with INTEGER Holdings Corporation?", "radio", yesNo),
    field("s2-field-start-date", "When are you available to start?", "text"),
    field("s2-field-salary", "Salary expectations", "text"),
  ] as const;

  for (const candidate of cases) {
    const { handler, calls } = dependencies();
    const result = await handler.complete(request([candidate]), new AbortController().signal);
    assert.equal(result.ok && result.value.kind, "blocked", candidate.label);
    if (result.ok && result.value.kind === "blocked") {
      assert.equal(
        result.value.code === "protected_answer_denied" || result.value.code === "profile_answer_missing",
        true,
        candidate.label,
      );
      assert.equal(
        result.value.protectedCategory === "legal" ||
          result.value.protectedCategory === "authorization",
        true,
        candidate.label,
      );
    }
    assert.equal(calls.driven, 0, candidate.label);
    assert.equal(calls.verified, 0, candidate.label);
  }
});

test("non-protected synthetic mechanics stay non-submittable while verifying UI mechanics", async () => {
  const source = field(
    "s2-field-application-source",
    "How Did You Hear About Us?",
    "select",
    [{ id: optionId("s2-option-source-linkedin"), label: boundedText("LinkedIn") }],
  );
  const { handler, calls } = dependencies();

  assert.deepEqual(await handler.complete(
    { ...request([source]), mode: "synthetic_test_non_submittable" },
    new AbortController().signal,
  ), {
    ok: true,
    value: {
      kind: "verified",
      answers: [],
      protectedPlaceholderCount: 0,
    },
  });
  assert.equal(calls.driven, 1);
  assert.equal(calls.verified, 1);
});

test("missing protected facts require owner input", async () => {
  const profile: ProfileQuery = {
    async query() {
      return { ok: true, value: { kind: "profile_answer_missing" } };
    },
  };
  const { handler, calls } = dependencies({ profile });

  const result = await handler.complete(
    request([authorizationField]),
    new AbortController().signal,
  );
  assert.equal(result.ok && result.value.kind, "blocked");
  if (result.ok && result.value.kind === "blocked") {
    assert.equal(result.value.code, "profile_answer_missing");
    assert.equal(result.value.protectedCategory, "authorization");
  }
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("protected choice defaults remain synthetic and non-submittable while learning UI", async () => {
  const sponsorship = field(
    "s2-field-sponsorship",
    "Do you require a work permit or VISA sponsorship?",
    "listbox",
    [
      { id: optionId("s2-option-sponsorship-select"), label: boundedText("Select One") },
      { id: optionId("s2-option-sponsorship-yes"), label: boundedText("Yes") },
      { id: optionId("s2-option-sponsorship-no"), label: boundedText("No") },
    ],
  );
  const profile: ProfileQuery = {
    async query() {
      return { ok: true, value: { kind: "profile_answer_missing" } };
    },
  };
  const { handler, calls } = dependencies({ profile });

  assert.deepEqual(await handler.complete(
    { ...request([sponsorship]), mode: "synthetic_test_non_submittable" },
    new AbortController().signal,
  ), {
    ok: true,
    value: {
      kind: "verified",
      answers: [],
      protectedPlaceholderCount: 0,
    },
  });
  assert.equal(calls.driven, 1);
  assert.equal(calls.verified, 1);
});

test("protected text defaults remain synthetic and non-submittable while learning UI", async () => {
  const compensation = field(
    "s2-field-compensation-learning",
    "Please indicate your annual salary and/or total compensation requirements",
    "textarea",
  );
  const profile: ProfileQuery = {
    async query() {
      return { ok: true, value: { kind: "profile_answer_missing" } };
    },
  };
  const { handler, calls } = dependencies({ profile });

  assert.deepEqual(await handler.complete(
    { ...request([compensation]), mode: "synthetic_test_non_submittable" },
    new AbortController().signal,
  ), {
    ok: true,
    value: {
      kind: "verified",
      answers: [],
      protectedPlaceholderCount: 0,
    },
  });
  assert.equal(calls.driven, 1);
  assert.equal(calls.verified, 1);
});

test("an unresolved narrative requires owner input while other owner facts remain usable", async () => {
  const unresolved = createConfiguredNarrativeProvider({
    revision: "narrative-questionnaire-v1",
    template: undefined,
  });
  const profile: ProfileQuery = {
    async query(input) {
      return input.factId === "country"
        ? { ok: true, value: {
            kind: "answered",
            value: "United States",
            provenance: "owner_provided",
            lane: "live_owner_fact",
          } as const }
        : { ok: true, value: { kind: "profile_answer_missing" } as const };
    },
  };
  const { handler, calls } = dependencies({ narrative: unresolved, profile });

  assert.deepEqual(await handler.complete(
    request([countryField]),
    new AbortController().signal,
  ), {
    ok: true,
    value: {
      kind: "verified",
      answers: [{
        pageId: "page-questionnaire",
        fieldId: countryField.fieldId,
        questionId: "s1-question-country",
        provenance: "owner_provided",
        lane: "live_owner_fact",
        protectedCategory: null,
        templateRevision: null,
        verification: "independent",
      }],
      protectedPlaceholderCount: 0,
    },
  });
  assert.deepEqual(await handler.complete(
    request([narrativeField]),
    new AbortController().signal,
  ), {
    ok: true,
    value: {
      kind: "blocked",
      code: "profile_answer_missing",
      fieldId: narrativeField.fieldId,
      protectedCategory: null,
    },
  });
  assert.equal(calls.driven, 1);
  assert.equal(calls.verified, 1);
});

test("unknown consent prompts reject visible learning options", async () => {
  const consent = field(
    "s2-field-consent",
    "I consent to this disclosure",
    "select",
    [
      { id: optionId("s2-option-consent-yes"), label: boundedText("Yes") },
      { id: optionId("s2-option-consent-no"), label: boundedText("No") },
    ],
  );
  const { handler, calls } = dependencies({
    observation: fixture.unknownQuestionObservation,
  });
  const result = await handler.complete(
    request([consent]),
    new AbortController().signal,
  );

  assert.equal(result.ok && result.value.kind, "blocked");
  if (result.ok && result.value.kind === "blocked") {
    assert.equal(result.value.code, "protected_answer_denied");
    assert.equal(result.value.protectedCategory, "consent");
  }
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("unknown protected choice without options fails closed", async () => {
  const consent = field("s2-field-consent", "I consent to this disclosure", "select");
  const { handler, calls } = dependencies({ observation: fixture.unknownQuestionObservation });

  const result = await handler.complete(
    request([consent]),
    new AbortController().signal,
  );
  assert.equal(result.ok && result.value.kind, "blocked");
  if (result.ok && result.value.kind === "blocked") {
    assert.equal(result.value.code, "protected_answer_denied");
    assert.equal(result.value.protectedCategory, "consent");
  }
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("protected fixed-choice ambiguity cannot choose a visible learning fallback", async () => {
  const ambiguous = field(
    "s2-field-work-authorization",
    "Are you authorized to work in this location?",
    "radio",
    [
      { id: optionId("s2-option-auth-yes"), label: boundedText("Yes") },
      { id: optionId("s2-option-auth-y"), label: boundedText("Y") },
    ],
  );
  const profile: ProfileQuery = {
    async query() {
      return {
        ok: true,
        value: { kind: "answered", value: true, provenance: "owner_provided", lane: "live_owner_fact" },
      };
    },
  };
  const { handler, calls } = dependencies({
    profile,
    observation: fixture.ambiguousOptionObservation,
  });
  const result = await handler.complete(
    request([ambiguous]),
    new AbortController().signal,
  );

  assert.equal(result.ok && result.value.kind, "blocked");
  if (result.ok && result.value.kind === "blocked") {
    assert.equal(result.value.code, "protected_answer_denied");
    assert.equal(result.value.protectedCategory, "authorization");
  }
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("configured provenance cannot smuggle a different narrative", async () => {
  const resolver: ApplicationAnswerResolver = {
    async resolve(input) {
      return {
        ok: true,
        value: {
          kind: "resolved",

          lane: "live_owner_fact",
          intent: {
            kind: "text",
            behavior: "textarea",
            fieldId: input.field.fieldId,
            target: input.field.target,
            value: "Invented personal claim.",
            provenance: "configured_template",
          },
        },
      };
    },
  };
  const { handler, calls } = dependencies({ resolver });

  assert.deepEqual(await handler.complete(
    request([narrativeField]),
    new AbortController().signal,
  ), {
    ok: true,
    value: {
      kind: "blocked",
      code: "narrative_template_mismatch",
      fieldId: narrativeField.fieldId,
      protectedCategory: null,
    },
  });
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("an injected resolver cannot replace the reviewed narrative default", async () => {
  let resolved = 0;
  const resolver: ApplicationAnswerResolver = {
    async resolve(input) {
      resolved += 1;
      return {
        ok: true,
        value: {
          kind: "resolved",

          lane: "live_owner_fact",
          intent: {
            kind: "text",
            behavior: "textarea",
            fieldId: input.field.fieldId,
            target: input.field.target,
            value: "Invented personal claim.",
            provenance: "owner_provided",
          },
        },
      };
    },
  };
  const { handler, calls } = dependencies({
    resolver,
    narrative: createConfiguredNarrativeProvider({
      revision: "narrative-questionnaire-v1",
      template: undefined,
    }),
  });

  assert.deepEqual(await handler.complete(
    request([narrativeField]),
    new AbortController().signal,
  ), {
    ok: true,
    value: {
      kind: "blocked",
      code: "narrative_template_mismatch",
      fieldId: narrativeField.fieldId,
      protectedCategory: null,
    },
  });
  assert.equal(resolved, 1);
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("resolved intents remain bound to the observed field and target", async () => {
  const resolver: ApplicationAnswerResolver = {
    async resolve(input) {
      return {
        ok: true,
        value: {
          kind: "resolved",

          lane: "live_owner_fact",
          intent: {
            kind: "text",
            behavior: "textarea",
            fieldId: input.field.fieldId,
            target: browserTargetToken("target-different-field"),
            value: "Exact configured interest statement.",
            provenance: "configured_template",
          },
        },
      };
    },
  };
  const { handler, calls } = dependencies({ resolver });

  assert.deepEqual(await handler.complete(
    request([narrativeField]),
    new AbortController().signal,
  ), {
    ok: true,
    value: {
      kind: "blocked",
      code: "answer_intent_mismatch",
      fieldId: narrativeField.fieldId,
      protectedCategory: null,
    },
  });
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("an injected owner answer can resolve an observed unknown question", async () => {
  const consent = field("s2-field-consent", "I consent to this disclosure", "text");
  const resolver: ApplicationAnswerResolver = {
    async resolve(input) {
      return {
        ok: true,
        value: {
          kind: "resolved",

          lane: "live_owner_fact",
          intent: {
            kind: "text",
            behavior: "text",
            fieldId: input.field.fieldId,
            target: input.field.target,
            value: "Yes",
            provenance: "owner_provided",
          },
        },
      };
    },
  };
  const { handler, calls } = dependencies({
    resolver,
    observation: fixture.unknownQuestionObservation,
  });
  const result = await handler.complete(
    request([consent]),
    new AbortController().signal,
  );

  assert.equal(result.ok && result.value.kind, "verified");
  if (!result.ok || result.value.kind !== "verified") return;
  assert.equal(result.value.answers[0]?.provenance, "owner_provided");
  assert.equal(result.value.answers[0]?.protectedCategory, "consent");
  assert.match(result.value.answers[0]?.questionId ?? "", /^observed-question-[0-9a-f]{24}$/u);
  assert.equal(calls.driven, 1);
  assert.equal(calls.verified, 1);
});

test("protected text placeholders are denied even with owner provenance", async () => {
  const resolver: ApplicationAnswerResolver = {
    async resolve(input) {
      return {
        ok: true,
        value: {
          kind: "resolved",

          lane: "live_owner_fact",
          intent: {
            kind: "text",
            behavior: "text",
            fieldId: input.field.fieldId,
            target: input.field.target,
            value: "N/A",
            provenance: "owner_provided",
          },
        },
      };
    },
  };
  const { handler, calls } = dependencies({ resolver });

  assert.deepEqual(await handler.complete(
    request([authorizationField]),
    new AbortController().signal,
  ), {
    ok: true,
    value: {
      kind: "blocked",
      code: "protected_answer_denied",
      fieldId: authorizationField.fieldId,
      protectedCategory: "authorization",
    },
  });
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("driver and verifier must be independently owned ports", () => {
  const coupled = {
    async drive(input: Parameters<FieldDriver["drive"]>[0]) {
      return {
        ok: true as const,
        value: {
          operationId: "operation_questionnaire_0000000000000001" as OperationId,
          fieldId: input.intent.fieldId,
          behavior: input.intent.behavior,
          attempted: true as const,
        },
      };
    },
    async verify(input: Parameters<FieldVerifier["verify"]>[0]) {
      return {
        ok: true as const,
        value: { kind: "verified" as const, fieldId: input.intent.fieldId },
      };
    },
  } satisfies FieldDriver & FieldVerifier;

  assert.throws(
    () => createQuestionnairePageHandler({
      profileQuery: {
        async query() {
          return { ok: true, value: { kind: "profile_answer_missing" } };
        },
      } as ProfileQuery,
      driver: coupled,
      verifier: coupled,
      narrative: createConfiguredNarrativeProvider({
        revision: "narrative-questionnaire-v1",
        template: "Exact configured interest statement.",
      }),
      nextOperationId: () => "operation_questionnaire_0000000000000001" as OperationId,
      allocateCandidateId: () => "unknown_candidate_questionnaire_01" as UnknownCandidateId,
      observationFor: () => undefined,
    }),
    /independent/u,
  );
});

test("a verifier rejection blocks completion and the handler never self-verifies", async () => {
  const verifier: FieldVerifier = {
    async verify(input) {
      return {
        ok: true,
        value: {
          kind: "rejected",
          fieldId: input.intent.fieldId,
          reason: "mismatch",
        },
      };
    },
  };
  const { handler, calls } = dependencies({ verifier });
  const result = await handler.complete(
    request([narrativeField]),
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "blocked",
      code: "verification_rejected",
      fieldId: narrativeField.fieldId,
      protectedCategory: null,
    },
  });
  assert.equal(calls.driven, 1);
});

test("active listbox resolution follows the expanded control relation only", () => {
  assert.deepEqual(resolveActiveListbox(fixture.activeListbox), {
    kind: "resolved",
    listboxId: "country-options",
  });
  assert.deepEqual(resolveActiveListbox({
    ...fixture.activeListbox,
    control: { ...fixture.activeListbox.control, expanded: false },
  }), { kind: "unavailable" });
  assert.deepEqual(resolveActiveListbox({
    ...fixture.activeListbox,
    candidates: [
      ...fixture.activeListbox.candidates,
      {
        listboxId: "country-options",
        visible: true,
        active: true,
        selectedItemList: false,
      },
    ],
  }), { kind: "ambiguous" });
});

test("configured narrative provider is versioned and only serves eligible prompts", () => {
  const provider = createConfiguredNarrativeProvider({
    revision: "narrative-questionnaire-v1",
    template: "Exact configured interest statement.",
  });

  assert.deepEqual(provider.resolve("s1-question-configured-narrative"), {
    text: "Exact configured interest statement.",
    revision: "narrative-questionnaire-v1",
    provenance: "configured_template",
    lane: "live_owner_fact",
  });
  assert.equal(provider.resolve("s1-question-work-authorization"), undefined);
  assert.throws(
    () => createConfiguredNarrativeProvider({ revision: "narrative-v1", template: "TODO" }),
    /placeholder/u,
  );
  assert.throws(
    () => createConfiguredNarrativeProvider({ revision: "narrative-v1", template: "  " }),
    /empty/u,
  );
});
