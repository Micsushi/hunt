import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertCatalogHasNoCollisions,
  normalizeCatalogText,
  resolveCatalogText,
} from "../../../src/form/questions/normalize.ts";
import {
  questionCatalog,
  questionAnswerGuide,
  questionFor,
  questionForField,
  retainedIntakeControlGuide,
  retainedIntakeTextSha256,
  resolveQuestion,
} from "../../../src/form/questions/catalog.ts";
import {
  retainedProfileControlGuide,
  retainedProfileLabelSha256Matches,
  retainedProfileTextSha256,
} from "../../../src/ats/workday/application/profile/catalog.ts";
import {
  optionCatalog,
  resolveOption,
} from "../../../src/form/options/catalog.ts";

test("normalization removes only Workday presentation noise", () => {
  for (const text of [
    " Given-Name: * ",
    "GIVEN NAME (Required)",
    "Given Name (Required) *",
    "given   name",
  ]) {
    assert.equal(normalizeCatalogText(text), "given name");
  }
});

test("weekly hours use one reusable numeric profile fact without matching unrelated hours", () => {
  const definition = questionForField("How many hours per week are you available to work?", "text");
  assert.equal(definition?.id, "workday-question-weekly-hours");
  assert.deepEqual(definition?.source, {
    kind: "profile", factId: "weekly_hours", ownerProvidedOnly: true,
  });
  assert.deepEqual(questionAnswerGuide.find(({ id }) => id === "workday-question-weekly-hours")?.defaultPolicy, {
    kind: "generated_learning_default", value: 40, replaceWithOwnerAnswer: true,
  });
  assert.deepEqual(resolveQuestion("Describe your preferred working hours"), { kind: "unknown" });
  assert.deepEqual(resolveQuestion("Have you worked night hours before?"), { kind: "unknown" });
});

test("reviewed questionnaire aliases resolve without admitting profile-page labels", () => {
  const cases = [
    ["Are you legally authorized to work in this country?", "s1-question-work-authorization"],
    ["Are you 18 years of age or older?", "s1-question-age-requirement-met"],
    ["Will you now or in the future require sponsorship?", "s1-question-sponsorship-required"],
    ["Highest Level of Education", "workday-question-highest-education"],
    ["Years of Relevant Experience", "workday-question-years-experience"],
    ["Desired Salary", "workday-question-desired-salary"],
    [
      "Expectations on Compensation - Please state your expectations of total compensation for this position. (Please list a value and/or range)",
      "workday-question-desired-salary",
    ],
    [
      "Please indicate your annual salary and/or total compensation requirements",
      "workday-question-desired-salary",
    ],
    [
      "Do you have any relatives currently employed by People Inc.?",
      "workday-placeholder-relative-employment",
    ],
    [
      "Have you been referred by an Integer associate?",
      "workday-placeholder-associate-referral",
    ],
    ["Gender", "workday-question-gender-disclosure"],
    ["Are you Hispanic or Latino?", "workday-question-ethnicity-disclosure"],
    ["Veteran Status", "workday-question-veteran-disclosure"],
    ["Were you ever in the military?", "workday-question-veteran-disclosure"],
    ["How Did You Hear About Us?", "workday-placeholder-application-source"],
    [
      "Yes, I have read and consent to the terms and conditions",
      "workday-placeholder-terms-consent",
    ],
    ["How Did You Hear About Us? Required", "workday-placeholder-application-source"],
    ["How did you hear about us? Employee Referral", "workday-placeholder-application-source"],
    ["Have you previously worked for this organization?", "workday-placeholder-prior-employment"],
    ["Have you ever been employed by our company or an affiliate?", "workday-placeholder-prior-employment"],
    ["Have you ever been employed by Adient?", "workday-placeholder-prior-employment"],
    ["Were you referred by an employee of Acme?", "workday-placeholder-associate-referral"],
    ["Have you served in the military?", "workday-question-veteran-disclosure"],
    ["Please specify your military service status", "workday-question-veteran-disclosure"],
    ["Are you a member of the armed forces?", "workday-question-veteran-disclosure"],
  ] as const;

  for (const [label, id] of cases) {
    assert.deepEqual(resolveQuestion(label), {
      kind: "resolved",
      id,
      provenance: "reviewed_catalog",
    });
    if (id === "workday-question-veteran-disclosure") assert.equal(questionForField(label, "listbox")?.id, id);
  }

  for (const label of [
    "Do you or a close associate meet this definition? A politically exposed person is a senior official in the executive, legislative, administrative, military or judicial branches of government.",
    "Do you have experience supplying equipment to the military?",
    "Have you worked with armed forces customers?",
    "Please provide your previous employment history",
    "Have you previously worked for a staffing agency?",
  ]) assert.deepEqual(resolveQuestion(label), { kind: "unknown" }, label);

  assert.equal(questionFor("workday-question-highest-education")?.id, "workday-question-highest-education");
  assert.deepEqual(questionForField("Highest Level of Education", "select"), {
    id: "workday-question-highest-education",
    labels: ["Highest Level of Education", "Highest Education", "Degree Level"],
    behavior: "select",
    provenance: "reviewed_catalog",
    source: {
      kind: "profile",
      factId: "highest_education",
      ownerProvidedOnly: true,
    },
  });
});

test("the runtime Profile guide adapts retained intake metadata to driver semantics", () => {
  const retainedProfile = retainedIntakeControlGuide
    .filter(({ page }) => page === "profile")
    .map(({ identity, sanitizedLabel, normalizedQuestionType, behavior, answerType,
      required, uiVariant, allowedOptions }) => ({
      identity,
      sanitizedLabel,
      normalizedQuestionType,
      behavior: identity === "skills.values" ? "multi_select" : behavior,
      answerType: identity === "social.linkedin" ? "url" : answerType,
      required,
      uiVariant,
      allowedOptions,
    }));
  assert.deepEqual(retainedProfileControlGuide.filter(({ identity }) =>
    identity !== "identity.prefix" && identity !== "identity.suffix"), retainedProfile);
  assert.deepEqual(retainedProfileControlGuide.find(({ identity }) => identity === "identity.prefix"), {
    identity: "identity.prefix", sanitizedLabel: "Prefix", normalizedQuestionType: "identity",
    behavior: "search_select", answerType: "single_select", required: false,
    uiVariant: "workday_search_select_v2", allowedOptions: [],
  });
  assert.deepEqual(retainedProfileControlGuide.find(({ identity }) => identity === "identity.suffix"), {
    identity: "identity.suffix", sanitizedLabel: "Suffix", normalizedQuestionType: "identity",
    behavior: "search_select", answerType: "single_select", required: false,
    uiVariant: "workday_search_select_v2", allowedOptions: [],
  });
  assert.equal(
    retainedProfileTextSha256("  Have You\u2019re Applied  "),
    retainedIntakeTextSha256("  Have You\u2019re Applied  "),
  );
  assert.equal(retainedProfileLabelSha256Matches(
    "employment.previously_worked_for_organization",
    retainedProfileTextSha256(
      "Have you previously worked for this organization? If Yes, please answer the questions below. If No, please continue to the next page.",
    ),
  ), true);
  assert.equal(retainedProfileLabelSha256Matches(
    "employment.previously_worked_for_organization",
    retainedProfileTextSha256(
      "Have you previously worked for our company (this does not apply to contingent/contract work)?",
    ),
  ), true);
  assert.equal(retainedProfileLabelSha256Matches(
    "employment.previously_worked_for_organization",
    "8be0c7b5805ae75479f25c31de6212db43568e1f78924c0908a14d87a3d7936a",
  ), true);
  assert.equal(retainedProfileLabelSha256Matches(
    "employment.previously_worked_for_organization",
    "84bd55d4d4826434cbf9940bb1da457eba54b7fb8d14971d33b3479f4303689b",
  ), true);
  assert.equal(retainedProfileLabelSha256Matches(
    "employment.previously_worked_for_organization",
    "02bb36a74d0f3cc0968cbf6e158bb2f84011460f197371539ac138259cc11e15",
  ), true);
  assert.equal(retainedProfileLabelSha256Matches(
    "employment.previously_worked_for_organization",
    "71a67a443e1256061f585fff53d60f41e192b4d578d31588ae75166ad526488a",
  ), true);
  assert.equal(retainedProfileLabelSha256Matches(
    "employment.previously_worked_for_organization",
    "a1b0f894080a0d563c6d93c2cf51607c2e7ac176ad2471d025a39bd1a6262c38",
  ), true);
  assert.equal(retainedProfileLabelSha256Matches(
    "employment.previously_worked_for_organization",
    "b244d36babd8b6f140d6df0e12d9604d73e95adac122b8620b788b5ba16e150e",
  ), true);
  assert.equal(retainedProfileLabelSha256Matches(
    "employment.previously_worked_for_organization",
    "a103b2bc246b315094938c4474b6b971366e01eb9bfa8741d068a6cdf2d3b13f",
  ), true);
  assert.equal(retainedProfileLabelSha256Matches(
    "address.region",
    "c697d2981bf416569a16cfbcdec1542b5398f3cc77d2b905819aa99c46ecf6f6",
  ), true);
  assert.equal(retainedProfileLabelSha256Matches(
    "address.country", retainedProfileTextSha256("Country / Territory"),
  ), true);
  assert.equal(retainedProfileLabelSha256Matches(
    "identity.prefix", retainedProfileTextSha256("Prefix"),
  ), true);
  assert.equal(retainedProfileLabelSha256Matches(
    "phone.country_code", "9f7f25cdd3fad1c99f6f2f528e7e1948076516e88fc00dfd3b44ad97fb82f1ad",
  ), true);
  assert.equal(retainedProfileLabelSha256Matches(
    "employment.previously_worked_for_organization",
    retainedProfileTextSha256("Have you previously worked for an unrelated company?"),
  ), false);
});

test("unknown and ambiguous catalog results remain distinct", () => {
  const colliding = [
    { id: "first", labels: ["Same label"], provenance: "reviewed_catalog" },
    { id: "second", labels: ["same-label"], provenance: "reviewed_catalog" },
  ] as const;

  assert.deepEqual(resolveCatalogText(colliding, "something else"), {
    kind: "unknown",
  });
  assert.deepEqual(resolveCatalogText(colliding, "same label"), {
    kind: "ambiguous",
    ids: ["first", "second"],
  });
  assert.throws(
    () => assertCatalogHasNoCollisions(colliding),
    /catalog alias collision.*same label.*first.*second/u,
  );
});
