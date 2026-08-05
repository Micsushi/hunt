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
  type AnswerResolver,
  type BrowserSessionId,
  type FieldDriver,
  type FieldObservation,
  type FieldVerifier,
  type OperationId,
  type ProfileQuery,
} from "../../../../src/contracts/index.ts";
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
  readonly resolver?: AnswerResolver;
  readonly driver?: FieldDriver;
  readonly verifier?: FieldVerifier;
  readonly observation?: SanitizedStructuralObservationV1;
} = {}) {
  const calls = { resolved: 0, driven: 0, verified: 0 };
  let operation = 0;
  const profile: ProfileQuery = options.profile ?? {
    async query(input) {
      const values = {
        work_authorization: false,
        country: "United States",
      } as const;
      const value = values[input.factId as keyof typeof values];
      return value === undefined
        ? { ok: true, value: { kind: "profile_answer_missing" } }
        : { ok: true, value: { kind: "answered", value, provenance: "owner_provided" } };
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
      narrative: createConfiguredNarrativeProvider({
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
          fieldId: narrativeField.fieldId,
          questionId: "s1-question-configured-narrative",
          provenance: "configured_template",
          protectedCategory: null,
          templateRevision: "narrative-questionnaire-v1",
          verification: "independent",
        },
        {
          fieldId: authorizationField.fieldId,
          questionId: "s1-question-work-authorization",
          provenance: "owner_provided",
          protectedCategory: "authorization",
          templateRevision: null,
          verification: "independent",
        },
        {
          fieldId: countryField.fieldId,
          questionId: "s1-question-country",
          provenance: "owner_provided",
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

test("protected answers require explicit owner provenance and never mutate on denial", async () => {
  const profile: ProfileQuery = {
    async query() {
      return {
        ok: true,
        value: { kind: "answered", value: true, provenance: "resume_verified" },
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

test("missing protected facts retain their stable missing code and never mutate", async () => {
  const profile: ProfileQuery = {
    async query() {
      return { ok: true, value: { kind: "profile_answer_missing" } };
    },
  };
  const { handler, calls } = dependencies({ profile });

  assert.deepEqual(await handler.complete(
    request([authorizationField]),
    new AbortController().signal,
  ), {
    ok: true,
    value: {
      kind: "blocked",
      code: "profile_answer_missing",
      fieldId: authorizationField.fieldId,
      protectedCategory: "authorization",
    },
  });
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("unknown consent prompts stop with sanitized candidate evidence", async () => {
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

  assert.equal(result.ok, true);
  if (!result.ok || result.value.kind !== "blocked") return;
  assert.equal(result.value.code, "question_unknown");
  assert.equal(result.value.protectedCategory, "consent");
  assert.deepEqual(result.value.candidate, {
    schemaVersion: 1,
    candidateId: "unknown_candidate_questionnaire_01",
    observationId: fixture.unknownQuestionObservation.observationId,
    layer: "question",
    outcome: "question_unknown",
    sourceRevisionId: fixture.unknownQuestionObservation.sourceRevisionId,
    parentLineage: fixture.unknownQuestionObservation.parentLineage,
    traitIds: fixture.unknownQuestionObservation.traitIds,
    observedVariantId: null,
    controlCount: 1,
    requiredControlCount: 1,
    optionCount: 2,
  });
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
  assert.doesNotMatch(JSON.stringify(result), /I consent|disclosure|Yes|No/u);
});

test("unknown behavior cannot stop without valid sanitized candidate evidence", async () => {
  const consent = field("s2-field-consent", "I consent to this disclosure", "select");
  const { handler, calls } = dependencies();

  assert.deepEqual(await handler.complete(
    request([consent]),
    new AbortController().signal,
  ), {
    ok: false,
    error: { code: "questionnaire_candidate_invalid", retryable: false },
  });
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("fixed-choice ambiguity emits sanitized option candidate and never clicks", async () => {
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
        value: { kind: "answered", value: true, provenance: "owner_provided" },
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

  assert.equal(result.ok, true);
  if (!result.ok || result.value.kind !== "blocked") return;
  assert.equal(result.value.code, "option_ambiguous");
  assert.equal(result.value.candidate?.layer, "visible_option");
  assert.equal(result.value.candidate?.outcome, "option_ambiguous");
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("configured provenance cannot smuggle a different narrative", async () => {
  const resolver: AnswerResolver = {
    async resolve(input) {
      return {
        ok: true,
        value: {
          kind: "resolved",
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

test("resolved intents remain bound to the observed field and target", async () => {
  const resolver: AnswerResolver = {
    async resolve(input) {
      return {
        ok: true,
        value: {
          kind: "resolved",
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

test("an injected resolver cannot bypass unknown-question candidate admission", async () => {
  const consent = field("s2-field-consent", "I consent to this disclosure", "text");
  const resolver: AnswerResolver = {
    async resolve(input) {
      return {
        ok: true,
        value: {
          kind: "resolved",
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

  assert.equal(result.ok, true);
  if (!result.ok || result.value.kind !== "blocked") return;
  assert.equal(result.value.code, "question_unknown");
  assert.equal(result.value.protectedCategory, "consent");
  assert.equal(result.value.candidate?.outcome, "question_unknown");
  assert.equal(calls.driven, 0);
  assert.equal(calls.verified, 0);
});

test("protected text placeholders are denied even with owner provenance", async () => {
  const resolver: AnswerResolver = {
    async resolve(input) {
      return {
        ok: true,
        value: {
          kind: "resolved",
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
      profileQuery: { async query() { return { ok: true, value: { kind: "profile_answer_missing" } }; } },
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
