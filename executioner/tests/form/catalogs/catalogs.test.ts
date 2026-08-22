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

test("application source is modeled as explicit owner input with synthetic fixture metadata", () => {
  const resolution = resolveQuestion("How Did You Hear About Us?");
  assert.equal(resolution.kind, "resolved");
  if (resolution.kind !== "resolved") return;
  const definition = questionFor(resolution.id);
  assert.deepEqual(definition?.source, {
    kind: "profile",
    factId: "application_source",
    ownerProvidedOnly: true,
    syntheticDefault: "LinkedIn",
  });
});

test("answer guide exposes types, options, and replacement-required learning defaults", () => {
  const byId = new Map(questionAnswerGuide.map((entry) => [entry.id, entry]));
  for (const id of [
    "s1-question-work-authorization",
    "workday-question-gender-disclosure",
    "workday-placeholder-relative-employment",
    "workday-placeholder-terms-consent",
  ]) {
    const entry = byId.get(id as never);
    assert.equal(entry?.initialState, "unset");
    assert.ok((entry?.behaviors.length ?? 0) > 0);
    assert.ok((entry?.answerTypes.length ?? 0) > 0);
    assert.equal(entry?.allowsCustomValue, false);
    assert.equal(entry?.defaultPolicy.kind, "owner_required");
  }
  assert.deepEqual(byId.get("s1-question-work-authorization")?.allowedOptions, ["Yes", "No"]);
  assert.ok(byId.get("workday-question-gender-disclosure")?.allowedOptions.includes(
    "I do not want to answer",
  ));
  for (const id of [
    "s1-question-age-requirement-met",
    "s1-question-sponsorship-required",
    "workday-placeholder-associate-referral",
    "workday-question-current-associate",
    "workday-question-previously-applied",
    "workday-placeholder-relative-employment",
    "workday-question-essential-functions",
    "workday-question-employment-agreement",
    "workday-question-veteran-disclosure",
  ]) assert.deepEqual(byId.get(id as never)?.allowedOptions, [], id);
});

test("retained Integer page shapes expose editable explicit-unset control metadata", () => {
  assert.equal(retainedIntakeControlGuide.length, 44);
  assert.equal(retainedIntakeControlGuide.every((entry) =>
    entry.initialState === "unset" && entry.uiVariant.length > 0 &&
    Array.isArray(entry.allowedOptions) && typeof entry.allowsCustomValue === "boolean" &&
    Object.hasOwn(entry.constraints, "maxBytes") &&
    Object.hasOwn(entry.constraints, "displayFormat")
  ), true);
  assert.equal(retainedIntakeControlGuide.find(({ identity }) => identity === "resume")
    ?.constraints.maxBytes, 5 * 1024 * 1024);
  assert.deepEqual(
    retainedIntakeControlGuide.find(({ identity }) => identity === "disability_disclosure")?.allowedOptions,
    [
      "Yes, I have a disability, or have had one in the past",
      "No, I do not have a disability and have not had one in the past",
      "I do not want to answer",
    ],
  );
  const shapeA = retainedIntakeControlGuide.filter(({ page }) => page === "questionnaire");
  assert.equal(shapeA.length, 10);
  assert.equal(shapeA.every(({ required, allowedOptions }) =>
    required === null && allowedOptions.length === 0
  ), true);
  const shapeC = retainedIntakeControlGuide.filter(({ page }) => page === "self_identify");
  assert.equal(shapeC.length, 5);
  assert.equal(shapeC.every(({ required }) => required === null), true);
  assert.equal(retainedIntakeControlGuide.filter(({ page }) =>
    page === "voluntary_disclosures"
  ).every(({ required }) => required === true), true);
  assert.equal(retainedIntakeControlGuide.filter(({ page }) =>
    page === "resume"
  ).every(({ required }) => required === false), true);
});

test("exact retained Integer labels resolve or remain deliberately unidentified", () => {
  const questionnaire = [
    ["Do you certify that you are 18 years of age or older?", "s1-question-age-requirement-met"],
    ["Have you been referred by an Integer associate?", "workday-placeholder-associate-referral"],
    ["Are you a current Integer associate (this does not apply to contingent/contract work)?", "workday-question-current-associate"],
    ["Have you previously applied for a position with our company?", "workday-question-previously-applied"],
    ["Do you have any relatives currently employed by Integer?", "workday-placeholder-relative-employment"],
    ["Do you now, or will you in the future, require sponsorship to work legally for Integer in the U.S.?", "s1-question-sponsorship-required"],
    ["Based on your understanding of this role, do you believe you are physically able to perform the essential functions of the job?", "workday-question-essential-functions"],
    ["Are you currently subject to any company agreement (NDA, Non-compete, etc.) that would prevent you from working with INTEGER Holdings Corporation?", "workday-question-employment-agreement"],
    ["When are you available to start?", "s1-question-earliest-start-date"],
    ["Salary expectations", "workday-question-desired-salary"],
  ] as const;
  for (const [label, id] of questionnaire) {
    assert.deepEqual(resolveQuestion(label), { kind: "resolved", id, provenance: "reviewed_catalog" });
  }
  const labels = new Set(retainedIntakeControlGuide.map(({ sanitizedLabel }) => sanitizedLabel));
  for (const label of [
    "Select Veteran Status",
    "Yes, I have read and consent to the terms and conditions",
    "Language", "Name", "Date", "Please check one of the boxes below",
    "Work Experience Add", "Education Add", "Type to Add Skills",
    "Upload a file (5MB max)", "Websites Add",
  ]) assert.equal(labels.has(label), true, label);
  const unresolved = retainedIntakeControlGuide.find(({ identity }) => identity === "unresolved");
  assert.equal(unresolved?.sanitizedLabel, null);
  assert.equal(unresolved?.normalizedQuestionType, "unknown");
  assert.equal(unresolved?.required, null);
});

test("retained run-99 Profile labels and requiredness stay evidence-bound", () => {
  const profile = retainedIntakeControlGuide.filter(({ page }) => page === "profile");
  const retained = new Map(profile.map(({ sanitizedLabel, required, allowedOptions }) => [
    sanitizedLabel,
    { required, allowedOptions },
  ]));
  assert.deepEqual([...retained.entries()].filter(([label]) => new Set([
    "How Did You Hear About Us?",
    "Have you previously worked for our company (this does not apply to contingent/contract work)?",
    "Country", "First Name", "Last Name", "Address Line 1", "City",
    "Province or Territory", "Postal Code", "Email", "Phone Device Type",
    "Country Phone Code", "Phone Number", "Phone Extension",
  ]).has(label ?? "")), [
    ["First Name", { required: true, allowedOptions: [] }],
    ["Last Name", { required: true, allowedOptions: [] }],
    ["Address Line 1", { required: false, allowedOptions: [] }],
    ["City", { required: false, allowedOptions: [] }],
    ["Country", { required: true, allowedOptions: [] }],
    ["Province or Territory", { required: false, allowedOptions: [] }],
    ["Postal Code", { required: false, allowedOptions: [] }],
    ["Email", { required: true, allowedOptions: [] }],
    ["Phone Device Type", { required: true, allowedOptions: [] }],
    ["Country Phone Code", { required: true, allowedOptions: [] }],
    ["Phone Number", { required: true, allowedOptions: [] }],
    ["Phone Extension", { required: false, allowedOptions: [] }],
    ["How Did You Hear About Us?", { required: true, allowedOptions: [] }],
    [
      "Have you previously worked for our company (this does not apply to contingent/contract work)?",
      { required: true, allowedOptions: ["Yes", "No"] },
    ],
  ]);
});

test("the runtime Profile guide exactly mirrors the retained intake guide", () => {
  const retainedProfile = retainedIntakeControlGuide
    .filter(({ page }) => page === "profile")
    .map(({ identity, sanitizedLabel, normalizedQuestionType, behavior, answerType,
      required, uiVariant, allowedOptions }) => ({
      identity,
      sanitizedLabel,
      normalizedQuestionType,
      behavior,
      answerType,
      required,
      uiVariant,
      allowedOptions,
    }));
  assert.deepEqual(retainedProfileControlGuide, retainedProfile);
  assert.equal(
    retainedProfileTextSha256("  Have You\u2019re Applied  "),
    retainedIntakeTextSha256("  Have You\u2019re Applied  "),
  );
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
