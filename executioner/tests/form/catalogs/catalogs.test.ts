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
  resolveQuestion,
} from "../../../src/form/questions/catalog.ts";
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

test("exact and reviewed keyword variants resolve deterministically", () => {
  assert.deepEqual(resolveQuestion("Given Name (Required) *"), {
    kind: "resolved",
    id: "s1-question-given-name",
    provenance: "reviewed_catalog",
  });
  assert.deepEqual(resolveQuestion("Family name"), {
    kind: "resolved",
    id: "s1-question-family-name",
    provenance: "reviewed_catalog",
  });
  const semanticCases = [
    ["Legal First Name", "s1-question-given-name"],
    ["Surname", "s1-question-family-name"],
    ["Mobile Phone", "s1-question-phone-number"],
    ["What's your gender?", "workday-question-gender-disclosure"],
    ["Select your gender", "workday-question-gender-disclosure"],
    ["Please agree to these terms", "workday-placeholder-terms-consent"],
  ] as const;
  for (const [label, id] of semanticCases) {
    assert.deepEqual(resolveQuestion(label), {
      kind: "resolved",
      id,
      provenance: "reviewed_catalog",
    });
  }
  for (const outOfScope of [
    "Email address",
    "State/Province",
    "ZIP/Postal Code",
    "Current Employer",
    "Current Job Title",
  ]) {
    assert.deepEqual(resolveQuestion(outOfScope), { kind: "unknown" });
  }
  assert.deepEqual(resolveQuestion("Select gender and race"), {
    kind: "ambiguous",
    ids: [
      "workday-question-gender-disclosure",
      "workday-question-ethnicity-disclosure",
    ],
  });
});

test("normalization removes accessible required suffixes without changing question text", () => {
  assert.equal(
    normalizeCatalogText("How Did You Hear About Us? Required"),
    "how did you hear about us",
  );
  assert.equal(
    normalizeCatalogText("Are you legally authorized to work in this country? Required *"),
    "are you legally authorized to work in this country",
  );
  assert.equal(
    normalizeCatalogText("Province or Territory Not Required"),
    "province or territory not required",
  );
  assert.equal(normalizeCatalogText("Is certification required?"), "is certification required");
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
      "Do you have any relatives currently employed by People Inc.?",
      "workday-placeholder-relative-employment",
    ],
    ["Gender", "workday-question-gender-disclosure"],
    ["Veteran Status", "workday-question-veteran-disclosure"],
    ["How Did You Hear About Us?", "workday-placeholder-application-source"],
    [
      "Yes, I have read and consent to the terms and conditions",
      "workday-placeholder-terms-consent",
    ],
  ] as const;

  for (const [label, id] of cases) {
    assert.deepEqual(resolveQuestion(label), {
      kind: "resolved",
      id,
      provenance: "reviewed_catalog",
    });
  }

  assert.deepEqual(resolveQuestion("How Did You Hear About Us? Required"), {
    kind: "resolved",
    id: "workday-placeholder-application-source",
    provenance: "reviewed_catalog",
  });
});

test("every resolved alias-only ID has one retrievable canonical definition", () => {
  const resolution = resolveQuestion("Highest Level of Education");
  assert.equal(resolution.kind, "resolved");
  if (resolution.kind !== "resolved") return;
  const definition = questionFor(resolution.id);
  assert.equal(definition?.id, resolution.id);
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

test("synthetic placeholders retain explicit source provenance", () => {
  const resolution = resolveQuestion("How Did You Hear About Us?");
  assert.equal(resolution.kind, "resolved");
  if (resolution.kind !== "resolved") return;
  const definition = questionFor(resolution.id);
  assert.equal(definition?.source?.kind, "synthetic_placeholder");
  if (definition?.source?.kind !== "synthetic_placeholder") return;
  assert.equal(definition.source.placeholderProvenance, "synthetic_ui_learning");
  assert.equal(definition.source.protected, false);
});

test("answer guide exposes types, options, and replacement-required learning defaults", () => {
  const byId = new Map(questionAnswerGuide.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get("s1-question-work-authorization"), {
    id: "s1-question-work-authorization",
    labels: [
      "Are you authorized to work in this location?",
      "Are you legally authorized to work in this country?",
    ],
    answerTypes: ["single_select"],
    possibleAnswers: [],
    defaultPolicy: {
      kind: "generated_learning_default",
      value: true,
      replaceWithOwnerAnswer: true,
    },
  });
  assert.deepEqual(byId.get("workday-question-gender-disclosure"), {
    id: "workday-question-gender-disclosure",
    labels: ["Gender", "Gender Identity", "Sex"],
    answerTypes: ["single_select"],
    possibleAnswers: [
      "Prefer not to answer",
      "Prefer not to say",
      "I do not wish to provide this information",
      "Decline to self-identify",
    ],
    defaultPolicy: {
      kind: "privacy_choice_or_first_visible_learning_option",
      values: [
        "Prefer not to answer",
        "Prefer not to say",
        "I do not wish to provide this information",
        "Decline to self-identify",
      ],
      replaceWithOwnerAnswer: true,
    },
  });
  assert.deepEqual(byId.get("workday-placeholder-relative-employment"), {
    id: "workday-placeholder-relative-employment",
    labels: [
      "Do you have any relatives currently employed by the company?",
      "Are any of your relatives employed by the company?",
    ],
    answerTypes: ["single_select"],
    possibleAnswers: ["Yes", "No"],
    defaultPolicy: { kind: "visible_exact_match_only", value: false },
  });
  assert.deepEqual(byId.get("workday-placeholder-terms-consent"), {
    id: "workday-placeholder-terms-consent",
    labels: [
      "Yes, I have read and consent to the terms and conditions",
      "I have read and agree to the terms and conditions",
      "I acknowledge and consent to the terms and conditions",
    ],
    answerTypes: ["boolean"],
    possibleAnswers: ["Yes", "No"],
    defaultPolicy: { kind: "visible_exact_match_only", value: true },
  });
});

test("question catalog is exactly the frozen ten-row S1 matrix", () => {
  assert.deepEqual(questionCatalog.map(({ id, labels, behavior, source }) => ({
    id,
    labels,
    behavior,
    source,
  })), [
    { id: "s1-question-given-name", labels: ["Given name"], behavior: "text", source: { kind: "profile", factId: "given_name" } },
    { id: "s1-question-family-name", labels: ["Family name"], behavior: "text", source: { kind: "profile", factId: "family_name" } },
    { id: "s1-question-phone-number", labels: ["Phone number"], behavior: "text", source: { kind: "profile", factId: "phone_number" } },
    { id: "s1-question-configured-narrative", labels: ["Brief interest statement"], behavior: "textarea", source: { kind: "narrative", factId: "configured_narrative", syntheticDefault: "I am interested in this role and available to discuss my qualifications." } },
    { id: "s1-question-work-authorization", labels: ["Are you authorized to work in this location?"], behavior: "radio", source: { kind: "profile", factId: "work_authorization", ownerProvidedOnly: true } },
    { id: "s1-question-age-requirement-met", labels: ["I am at least 18 years of age."], behavior: "checkbox", source: { kind: "profile", factId: "age_requirement_met", ownerProvidedOnly: true } },
    { id: "s1-question-sponsorship-required", labels: ["Will you require sponsorship?"], behavior: "select", source: { kind: "profile", factId: "sponsorship_required", ownerProvidedOnly: true } },
    { id: "s1-question-country", labels: ["Country"], behavior: "listbox", source: { kind: "profile", factId: "country" } },
    { id: "s1-question-earliest-start-date", labels: ["Available start date"], behavior: "date", source: { kind: "profile", factId: "earliest_start_date", ownerProvidedOnly: true } },
    { id: "s1-question-resume", labels: ["Resume"], behavior: "file_upload", source: { kind: "resume" } },
  ]);
});

test("option aliases resolve to canonical option IDs", () => {
  assert.deepEqual(resolveOption(" YES. * "), {
    kind: "resolved",
    id: "yes",
    provenance: "reviewed_catalog",
  });
  assert.deepEqual(resolveOption("False"), {
    kind: "resolved",
    id: "no",
    provenance: "reviewed_catalog",
  });
  assert.deepEqual(resolveOption("Maybe"), { kind: "unknown" });
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

test("reviewed catalogs and their entries are immutable", () => {
  for (const catalog of [questionCatalog, optionCatalog]) {
    assert.equal(Object.isFrozen(catalog), true);
    for (const entry of catalog) {
      assert.equal(Object.isFrozen(entry), true);
      assert.equal(Object.isFrozen(entry.labels), true);
      assert.equal(entry.provenance, "reviewed_catalog");
    }
  }
});
