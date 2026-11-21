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
import { protectedQuestionCategory } from "../../../src/ats/workday/application/questions/protected.ts";
import { resolveQuestion } from "../../../src/form/questions/catalog.ts";
import { sharedUiReadbackState } from "../../../src/deterministic/ui-state-model.ts";
import { testingQuestionSemanticType } from "../../../src/form/answers/testing-policy.ts";
import type { ApplicationFieldObservation } from "../../../src/form/answers/application-types.ts";
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

function request(observed: ApplicationFieldObservation) {
  const resume = Object.freeze({
    resumeId: upstreamResumeId("resume-1"),
    sha256: "6a5c5b7838b3f7a7bf24b7e9ca49141f10ee68b2e14c9ee43eba3fdecf7173cc",
  });
  const resumeArtifact = createResumeArtifactFixture();
  return Object.freeze({
    mode: "live",
    answerFallbackPolicy: "owner_facts_only" as const,
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

test("political exposure uses its visible options without consulting veteran facts", async () => {
  const { resolver, profile } = resolverWith({ kind: "answered", value: "Protected veteran", provenance: "owner_provided", lane: "live_owner_fact" });
  const observed = field(
    "Do you or a close associate meet this definition? A politically exposed person is a senior official in the executive, legislative, administrative, military or judicial branches of government.",
    "listbox",
    ["Yes, politically exposed", "No, not politically exposed"].map((label, index) => ({
      id: optionId(`political-option-${index}`), label: boundedText(label),
    })),
  );
  const result = await resolver.resolve(syntheticRequest(observed), new AbortController().signal);
  assert.equal(profile.calls.length, 0);
  assert.ok(result.ok && result.value.kind === "resolved" && result.value.intent.kind === "choice");
  if (result.ok && result.value.kind === "resolved" && result.value.intent.kind === "choice") {
    assert.equal(result.value.lane, "synthetic_test_default");
    const expectedOption = result.value.intent.expectedOption;
    assert.ok(observed.options.some(({ label }) => label === expectedOption));
  }
});

test("numeric questions share defaults and preserve an owner answer across labels", async () => {
  const signal = new AbortController().signal;
  for (const [label, expected, behavior = "text"] of [
    ["Please indicate your expected number of weekly hours:", "40"],
    ["How many hours per week are you available to work?", "40"],
    ["Desired weekly hours", "40"],
    ["5. How many years of related work experience have you obtained?", "0"],
    ["What is your notice period? Please answer in the amount of days.", "0"],
    ["Years of Relevant Experience", "0"],
    ["How many years of work experience do you have?", "0", "textarea"],
  ] as const) {
    const observed = field(label, behavior);
    if (expected === "40") assert.equal(testingQuestionSemanticType(label), "availability");
    const missing = resolverWith({ kind: "profile_answer_missing" }).resolver;
    const generated = await missing.resolve(syntheticRequest(observed), signal);
    assert.equal(generated.ok && generated.value.kind === "resolved" &&
      generated.value.intent.kind === "text" && generated.value.intent.value, expected);
    assert.equal(generated.ok && generated.value.kind === "resolved" &&
      generated.value.lane, "synthetic_test_default");
    const live = await missing.resolve(request(observed), signal);
    assert.equal(live.ok && live.value.kind, "profile_answer_missing");
    const owner = resolverWith({ kind: "answered", value: 24,
      provenance: "owner_provided", lane: "live_owner_fact" }).resolver;
    const preserved = await owner.resolve(syntheticRequest(observed), signal);
    assert.equal(preserved.ok && preserved.value.kind === "resolved" &&
      preserved.value.intent.kind === "text" && preserved.value.intent.value, "24");
  }
});

test("valid committed values are preserved instead of overwritten", async () => {
  const { resolver, profile } = resolverWith({
    kind: "answered",
    value: "Replacement",
    provenance: "owner_provided",
    lane: "live_owner_fact",
  });
  const result = await resolver.resolve(Object.freeze({
    ...request({ ...field("Given name", "text", [], "populated"), populatedValueValid: true }),
    committedReadback: { kind: "text" as const, value: boundedText("Manual value") },
  }), new AbortController().signal);

  assert.deepEqual(result, {
    ok: true,
    value: { kind: "readback_only", fieldId: fieldId("s1-field-given-name") },
  });
  assert.equal(profile.calls.length, 0);
});

test("unknown choices use the supplied selection strategy on visible non-placeholder options", async () => {
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
    "current_associate",
    "associate_referral",
  ]);
});

test("Canadian authorization and sponsorship use only their scoped saved answers", async () => {
  const options = ["Yes", "No"].map(label => ({id:optionId(label.toLowerCase()),label:boundedText(label)}));
  const signal = new AbortController().signal;
  for (const [label, factId, value] of [
    ["Are you legally entitled to work in Canada?", "work_authorization_canada", true],
    ["Are you authorized to work lawfully in the Canada?", "work_authorization_canada", true],
    ["Will you require sponsorship to work in Canada?", "sponsorship_required_canada", false],
    ["Will you now or in the future require sponsorship from Novara to work in Canada?", "sponsorship_required_canada", false],
    ["Will you require sponsorship?", "sponsorship_required", false],
  ] as const) {
    const {resolver,profile} = resolverWith({kind:"answered",value,provenance:"owner_provided",lane:"live_owner_fact"});
    const result = await resolver.resolve({...request(field(label,"select",options)),employerNames:["Novara"]},signal);
    assert.equal(result.ok && result.value.kind,"resolved",label);
    assert.deepEqual(profile.calls.map(({request: input}) => (input as {factId:string}).factId),[factId]);
  }
  const {resolver,profile} = resolverWith({kind:"answered",value:true,provenance:"owner_provided",lane:"live_owner_fact"});
  for (const label of ["Are you authorized to work in the United States?",
    "Will you require sponsorship to work in the U.S.?", "Are you authorized to work in Mexico?",
    "Are you authorized to work in Canada as a Canadian citizen or permanent resident?",
    "Are you authorized to work in Canada without visa sponsorship?",
    "Are you legally authorized to work for any employer in Canada and able to provide proof of such?"]) {
    const result = await resolver.resolve(request(field(label,"select",options)),signal);
    assert.deepEqual(result,{ok:false,error:{code:"protected_answer_denied",retryable:false}},label);
  }
  assert.equal(profile.calls.length,0);
});


test("only approved recruitment terms use saved consent; required unknown declarations use authorized provisional fallback", async () => {
  const approvedLabels = new Set(['Yes, I have read and consent to the terms and conditions*','Applicant Privacy Notice','Privacy Policy','Terms','Terms & Conditions','Accept terms','I have read the terms']);
  for (const label of ["Yes, I have read and consent to the terms and conditions*", "I Agree",
    "Applicant Privacy Notice", "Privacy Policy", "Terms", "Terms & Conditions", "Accept terms", "I have read the terms", "I have read and understood",
    "I agree to disclose my gender", "I consent to disclose my veteran status", "I agree that I am authorized to work in Canada"]) {
    for (const stored of [{ kind: "profile_answer_missing" } as const,
      { kind: "answered", value: true, provenance: "owner_provided", lane: "live_owner_fact" } as const]) {
      const { resolver, profile } = resolverWith(stored);
      for (const mode of ["live", "synthetic_test_non_submittable"] as const) {
        for (const answerFallbackPolicy of ["owner_facts_only", "deterministic_site_valid_editable"] as const) {
          const observed = field(label, "checkbox");
          const input = { ...request(observed), mode, answerFallbackPolicy };
          const approved = approvedLabels.has(label) && stored.kind==='answered';
          const answer = await resolver.resolve(input, new AbortController().signal);
          if (approved) {
            assert.ok(answer.ok && answer.value.kind==='resolved');
            if(answer.ok && answer.value.kind==='resolved') {
              assert.equal(answer.value.lane,'live_owner_fact');
              assert.equal(answer.value.intent.kind,'toggle');
              if(answer.value.intent.kind==='toggle') assert.equal(answer.value.intent.checked,true);
            }
          } else if (mode === "synthetic_test_non_submittable" || answerFallbackPolicy === "deterministic_site_valid_editable") {
            assert.ok(answer.ok && answer.value.kind === "resolved");
            if (answer.ok && answer.value.kind === "resolved") assert.equal(answer.value.lane, "synthetic_test_default");
          } else assert.deepEqual(answer, {
            ok: false, error: { code: "protected_answer_denied", retryable: false },
          });
          for (const preserved of [{ ...observed, state: "populated" as const },
            { ...observed, required: false }]) {
            assert.deepEqual(await resolver.resolve({ ...input, field: preserved }, new AbortController().signal), {
              ok: true, value: { kind: "readback_only", fieldId: observed.fieldId },
            });
          }
        }
      }
      if (!approvedLabels.has(label)) assert.equal(profile.calls.length, 0);
    }
  }
});


test("consent preservation uses checked backing state and excludes employment questions", async () => {
  assert.equal(sharedUiReadbackState("checkbox", "visible", { kind: "checked", checked: true }), "populated");
  assert.equal(sharedUiReadbackState("checkbox", "visible", { kind: "checked", checked: false }), "empty");
  for (const text of ["What are your salary expectations?", "How many co-op terms have you previously had?",
    "Now that CI catches regressions automatically, manual exploratory testing is mostly obsolete. Agree or disagree? Why?",
    "Are you currently subject to any company agreement (NDA, Non-compete, etc.) that would prevent you from working with INTEGER Holdings Corporation?"]) {
    const label = boundedText(text), question = resolveQuestion(label);
    assert.notEqual(protectedQuestionCategory(label, question.kind === "resolved" ? question.id : undefined), "consent");
  }
  const options=["This will be my first co-op term","1","2","3","4"].map((label,i)=>({id:optionId(`coop-${i}`),label:boundedText(label)}));
  const answer=await resolverWith({kind:"profile_answer_missing"}).resolver.resolve(syntheticRequest(field("How many co-op terms have you previously had?","select",options)),new AbortController().signal);
  assert.equal(answer.ok&&answer.value.kind==="resolved"&&answer.value.intent.kind==="choice",true);
  const opinion=await resolverWith({kind:"profile_answer_missing"}).resolver.resolve(syntheticRequest(field("Now that CI catches regressions automatically, manual exploratory testing is mostly obsolete. Agree or disagree? Why?","textarea")),new AbortController().signal);
  assert.equal(opinion.ok&&opinion.value.kind==="resolved"&&opinion.value.intent.kind==="text",true);
});
