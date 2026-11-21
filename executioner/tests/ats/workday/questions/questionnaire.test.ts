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
  readonly fieldPresent?: QuestionnairePageHandlerDependencies["fieldPresent"];
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
      fieldPresent: options.fieldPresent,
      previouslyVerified: options.previouslyVerified,
      recordVerified: options.recordVerified,
      recordAttempt: options.recordAttempt,
    }),
  };
}

test("an injected owner answer can resolve an observed unknown question", async () => {
  const consent = field("s2-field-custom", "Custom recruiter question", "text");
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
  assert.equal(result.value.answers[0]?.protectedCategory, null);
  assert.match(result.value.answers[0]?.questionId ?? "", /^observed-question-[0-9a-f]{24}$/u);
  assert.equal(calls.driven, 1);
  assert.equal(calls.verified, 1);
});


test("preserved consent skips mutations and unknown consent cannot become an injected owner fact", async () => {
  for (const label of ["Yes, I have read and consent to the terms and conditions*",
    "Applicant Privacy Notice", "Privacy Policy", "I have read and understood",
    "I agree to the Recruitment Privacy Notice and confirm that no AI tools were used."]) {
    for (const mode of ["live", "synthetic_test_non_submittable"] as const) {
      for (const answerFallbackPolicy of ["owner_facts_only", "deterministic_site_valid_editable"] as const) {
        for (const [state, required, expected] of [
          ["empty", true, "blocked"], ["populated", true, "verified"],
          ["empty", false, "verified"], ["ambiguous", false, "verified"],
        ] as const) {
          const { handler, calls } = dependencies({ resolver: {
            async resolve({field}) { return {ok: true, value: {kind: 'resolved', lane: 'live_owner_fact',
              intent: {kind: 'toggle', behavior: 'checkbox', fieldId: field.fieldId, target: field.target, checked: true, provenance: 'owner_provided'}}}; },
          } });
          const observed = { ...field("consent", label, "checkbox"), state, required };
          const result = await handler.complete({ ...request([observed]), mode, answerFallbackPolicy },
            new AbortController().signal);
          assert.equal(result.ok && result.value.kind, expected);
          if (result.ok && result.value.kind === "blocked") assert.equal(result.value.code, "protected_answer_denied");
          assert.equal(calls.driven, 0);
          assert.equal(calls.verified, 0);
        }
      }
    }
  }
});
