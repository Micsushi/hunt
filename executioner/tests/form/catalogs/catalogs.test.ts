import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertCatalogHasNoCollisions,
  normalizeCatalogText,
  resolveCatalogText,
} from "../../../src/form/questions/normalize.ts";
import {
  questionCatalog,
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

test("only frozen Workday labels resolve deterministically", () => {
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
  for (const outOfScope of [
    "Legal First Name",
    "Surname",
    "Email address",
    "Mobile Phone",
    "State/Province",
    "ZIP/Postal Code",
    "Current Employer",
    "Current Job Title",
  ]) {
    assert.deepEqual(resolveQuestion(outOfScope), { kind: "unknown" });
  }
});

test("reviewed questionnaire aliases resolve without admitting profile-page labels", () => {
  const cases = [
    ["Are you legally authorized to work in this country?", "s1-question-work-authorization"],
    ["Are you 18 years of age or older?", "s1-question-age-requirement-met"],
    ["Will you now or in the future require sponsorship?", "s1-question-sponsorship-required"],
    ["Highest Level of Education", "workday-question-highest-education"],
    ["Years of Relevant Experience", "workday-question-years-experience"],
    ["Desired Salary", "workday-question-desired-salary"],
    ["Gender", "workday-question-gender-disclosure"],
    ["Veteran Status", "workday-question-veteran-disclosure"],
    ["How Did You Hear About Us?", "workday-placeholder-application-source"],
  ] as const;

  for (const [label, id] of cases) {
    assert.deepEqual(resolveQuestion(label), {
      kind: "resolved",
      id,
      provenance: "reviewed_catalog",
    });
  }
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
    { id: "s1-question-configured-narrative", labels: ["Brief interest statement"], behavior: "textarea", source: { kind: "narrative", factId: "configured_narrative" } },
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
