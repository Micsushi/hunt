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
import type { ApplicationAnswerResolver, ApplicationProfileQuery } from
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
  readonly profile?: QuestionnairePageHandlerDependencies["profileQuery"];
  readonly readSalaryText?: QuestionnairePageHandlerDependencies["readSalaryText"];
  readonly recordSalaryAmount?: QuestionnairePageHandlerDependencies["recordSalaryAmount"];
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
  const defaultProfile: ProfileQuery = {
    async query(input: Parameters<ProfileQuery["query"]>[0]) {
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
      profileQuery: options.profile ?? defaultProfile,
      readSalaryText: options.readSalaryText,
      recordSalaryAmount: options.recordSalaryAmount,
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
  for (const [state, current, formatted, numeric, prompt, expected] of [
    ["empty", "65000", "CAD $65,000 per year", 65000, "What are your salary expectations ?*", "amount"],
    ["populated", "65000", "CAD $65,000 per year", 65000, "What are your salary expectations ?*", "amount"],
    ["empty", "65001", "CAD $65,000 per year", 65000, "Salary expectations", "blocked"],
    ["populated", "65000", "CAD $65,000 per year", 70000, "Salary expectations", "blocked"],
    ["populated", "65000", "CAD $60,000 to $65,000 per year", 65000, "Salary expectations", "blocked"],
    ["populated", "65000", "CAD $65,000 per year", 65000, "What salary range are you targeting?", "blocked"],
    ["populated", "65000", "CAD $65,000 per year", 65000, "Desired salary in USD per hour", "blocked"],
  ] as const) {
    const amounts: string[] = [];
    const savedProfile: ApplicationProfileQuery = {
      async query({factId}) {return {ok:true,value:{kind:"answered",provenance:"owner_provided",
        lane:"live_owner_fact",value:factId === "desired_salary" ? numeric : formatted}};},
    };
    const {handler, calls} = dependencies({profile: savedProfile,
      readSalaryText:async () => current,recordSalaryAmount:({amount}) => amounts.push(amount),
      verifier:{async verify({intent}) { return {ok:true,value:{kind:"rejected",fieldId:intent.fieldId,reason:"mismatch"}}; }},
    });
    const result = await handler.complete(request([{...field("salary",prompt,"text"),state}]),new AbortController().signal);
    assert.equal(result.ok && result.value.kind, expected === "amount" ? "verified" : "blocked", prompt);
    assert.equal(calls.driven,state === "empty" ? 1 : 0);
    assert.deepEqual(amounts,expected === "amount" ? ["65000"] : []);
    if (result.ok && result.value.kind === "blocked") assert.equal(result.value.code, "salary_readback_needs_review");
    if (result.ok && result.value.kind === "verified") assert.equal(result.value.answers.length,1);
  }
  const relationship = field("employee-relationship",
    "If you were not referred by an employee, but know someone who works here, please specify your relationship to that employee. If you do not know anyone here, please input Not Applicable.", "textarea");
  for (const answerFallbackPolicy of ["owner_facts_only","deterministic_site_valid_editable"] as const) {
    const {handler,calls} = dependencies();
    const stop = await handler.complete({...request([relationship]),answerFallbackPolicy},new AbortController().signal);
    assert.equal(stop.ok && stop.value.kind === "blocked" && stop.value.code, "employee_relationship_needs_review");
    assert.equal(calls.driven,0);
  }
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
  const queried: string[] = [];
  const approved = dependencies({profile:{async query(input) {
    queried.push(input.factId);
    return {ok:true,value:{kind:"answered",value:true,provenance:"owner_provided",lane:"live_owner_fact"}};
  }} satisfies ApplicationProfileQuery});
  const aiConsent = field("ai-screening","I consent to automated screening of my application.","checkbox");
  const optional = {...aiConsent,required:false};
  const priorDecision = {...aiConsent,state:"populated" as const};
  await approved.handler.complete(request([optional,priorDecision]),new AbortController().signal);
  assert.deepEqual(queried,[]);
  assert.equal(approved.calls.driven,0);
  const granted = await approved.handler.complete(request([aiConsent]),new AbortController().signal);
  assert.equal(granted.ok && granted.value.kind,"verified");
  assert.deepEqual(new Set(queried),new Set(["ai_evaluation_consent"]));
  assert.equal(approved.calls.driven,1);
  assert.equal(approved.calls.verified,1);
  const terms = field("terms","Applicant Privacy Notice","checkbox");
  const denied = dependencies({
    profile:{async query(){assert.fail("An unsupported consent shape must not query any saved decision");}},
    resolver:{async resolve(){assert.fail("An injected resolver must not see an unsupported consent shape");}},
  });
  for (const observed of [
    {...terms,rawQuestion:aiConsent.label,rawOptions:["I decline"]},
    field("mixed","I agree to the recruitment privacy notice and AI screening of my application.","checkbox"),
  ]) {
    const result = await denied.handler.complete(request([observed]),new AbortController().signal);
    assert.ok(result.ok && result.value.kind === "blocked" && result.value.code === "protected_answer_denied");
    assert.equal(denied.calls.driven,0);
  }
  queried.length = 0;
  const acceptedTerms = await approved.handler.complete(request([terms]),new AbortController().signal);
  assert.ok(acceptedTerms.ok && acceptedTerms.value.kind === "verified");
  assert.deepEqual(new Set(queried),new Set(["terms_consent"]));
  assert.equal(approved.calls.driven,2);

  for (const choice of [undefined, false] as const) {
    const withheld = dependencies({profile:{async query() {
      return choice === undefined ? {ok:true,value:{kind:"profile_answer_missing"}} :
        {ok:true,value:{kind:"answered",value:choice,provenance:"owner_provided",lane:"live_owner_fact"}};
    }} satisfies ApplicationProfileQuery});
    const result = await withheld.handler.complete(request([aiConsent]),new AbortController().signal);
    assert.ok(result.ok && result.value.kind === "blocked" && result.value.code === "protected_answer_denied");
    assert.equal(withheld.calls.driven,0);
  }

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
