import type {
  ProfileFactId,
  UiBehaviorId,
} from "../../contracts/index.ts";
import {
  assertCatalogHasNoCollisions,
  normalizeCatalogText,
  resolveCatalogText,
  type ReviewedCatalogEntry,
} from "./normalize.ts";

type QuestionSource =
  | {
      readonly kind: "profile";
      readonly factId: ProfileFactId;
      readonly ownerProvidedOnly?: true;
    }
  | { readonly kind: "narrative"; readonly factId: "configured_narrative" }
  | { readonly kind: "resume" }
  | { readonly kind: "neutral_disclosure" }
  | {
      readonly kind: "synthetic_placeholder";
      readonly value: string | number | boolean;
      readonly placeholderProvenance: "synthetic_ui_learning";
      readonly protected: boolean;
    };

interface QuestionCatalogEntry extends ReviewedCatalogEntry<string> {
  readonly behavior: UiBehaviorId;
  readonly source: QuestionSource;
}

interface QuestionAliasCatalogEntry extends ReviewedCatalogEntry<string> {
  readonly behaviors: readonly UiBehaviorId[];
  readonly source?: QuestionSource;
}

function entry<I extends string>(
  id: I,
  label: string,
  behavior: UiBehaviorId,
  source: QuestionSource,
) {
  return Object.freeze({
    id,
    labels: Object.freeze([label]),
    behavior,
    provenance: "reviewed_catalog" as const,
    source: Object.freeze(source),
  });
}

function aliasEntry<I extends string>(
  id: I,
  labels: readonly string[],
  behaviors: readonly UiBehaviorId[],
  source?: QuestionSource,
) {
  return Object.freeze({
    id,
    labels: Object.freeze([...labels]),
    behaviors: Object.freeze([...behaviors]),
    provenance: "reviewed_catalog" as const,
    source: source === undefined ? undefined : Object.freeze(source),
  });
}

export const questionCatalog = Object.freeze([
  entry("s1-question-given-name", "Given name", "text", { kind: "profile", factId: "given_name" }),
  entry("s1-question-family-name", "Family name", "text", { kind: "profile", factId: "family_name" }),
  entry("s1-question-phone-number", "Phone number", "text", { kind: "profile", factId: "phone_number" }),
  entry("s1-question-configured-narrative", "Brief interest statement", "textarea", { kind: "narrative", factId: "configured_narrative" }),
  entry("s1-question-work-authorization", "Are you authorized to work in this location?", "radio", { kind: "profile", factId: "work_authorization", ownerProvidedOnly: true }),
  entry("s1-question-age-requirement-met", "I am at least 18 years of age.", "checkbox", { kind: "profile", factId: "age_requirement_met", ownerProvidedOnly: true }),
  entry("s1-question-sponsorship-required", "Will you require sponsorship?", "select", { kind: "profile", factId: "sponsorship_required", ownerProvidedOnly: true }),
  entry("s1-question-country", "Country", "listbox", { kind: "profile", factId: "country" }),
  entry("s1-question-earliest-start-date", "Available start date", "date", { kind: "profile", factId: "earliest_start_date", ownerProvidedOnly: true }),
  entry("s1-question-resume", "Resume", "file_upload", { kind: "resume" }),
] as const satisfies readonly QuestionCatalogEntry[]);

const questionAliasCatalog = Object.freeze([
  aliasEntry(
    "s1-question-work-authorization",
    ["Are you legally authorized to work in this country?"],
    ["radio", "select", "listbox"],
  ),
  aliasEntry(
    "s1-question-age-requirement-met",
    ["Are you at least 18 years of age?", "Are you 18 years of age or older?"],
    ["checkbox", "radio", "select", "listbox"],
  ),
  aliasEntry(
    "s1-question-sponsorship-required",
    [
      "Will you now or in the future require sponsorship?",
      "Do you require employment sponsorship now or in the future?",
    ],
    ["radio", "select", "listbox"],
  ),
  aliasEntry(
    "s1-question-earliest-start-date",
    ["Earliest Start Date", "Desired Start Date"],
    ["date", "text"],
  ),
  aliasEntry(
    "workday-question-highest-education",
    ["Highest Level of Education", "Highest Education", "Degree Level"],
    ["text", "select", "listbox"],
    { kind: "profile", factId: "highest_education", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-years-experience",
    [
      "How many years of relevant experience do you have?",
      "Years of Relevant Experience",
      "Years of Experience",
    ],
    ["text", "select", "listbox"],
    { kind: "profile", factId: "years_experience", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-desired-salary",
    ["Desired Salary", "Salary Expectation", "Desired Compensation"],
    ["text", "textarea", "select", "listbox"],
    { kind: "profile", factId: "desired_salary", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-gender-disclosure",
    ["Gender", "Gender Identity", "Sex"],
    ["radio", "select", "listbox"],
    { kind: "neutral_disclosure" },
  ),
  aliasEntry(
    "workday-question-ethnicity-disclosure",
    ["Race/Ethnicity", "Race or Ethnicity", "Ethnicity", "Ethnicities"],
    ["radio", "select", "listbox"],
    { kind: "neutral_disclosure" },
  ),
  aliasEntry(
    "workday-question-veteran-disclosure",
    ["Veteran Status", "Protected Veteran Status"],
    ["radio", "select", "listbox"],
    { kind: "neutral_disclosure" },
  ),
  aliasEntry(
    "workday-question-disability-disclosure",
    ["Disability Status", "Disability Self-Identification"],
    ["radio", "select", "listbox"],
    { kind: "neutral_disclosure" },
  ),
  aliasEntry(
    "workday-placeholder-prior-employment",
    [
      "Have you ever been employed by QTS Data Centers?",
      "Have you ever worked for Pyramid Global Hospitality?",
      "Have you previously worked for HRI Hospitality?",
      "Have you previously worked for HRI Hospitality? CURRENT ASSOCIATES: Please apply via your Workday account instead from Jobs Hub.",
    ],
    ["radio", "select", "listbox"],
    {
      kind: "synthetic_placeholder",
      value: false,
      placeholderProvenance: "synthetic_ui_learning",
      protected: true,
    },
  ),
  aliasEntry(
    "workday-placeholder-application-source",
    ["How Did You Hear About Us?"],
    ["select", "listbox"],
    {
      kind: "synthetic_placeholder",
      value: "LinkedIn",
      placeholderProvenance: "synthetic_ui_learning",
      protected: false,
    },
  ),
] as const satisfies readonly QuestionAliasCatalogEntry[]);

assertCatalogHasNoCollisions([...questionCatalog, ...questionAliasCatalog]);

export type CanonicalQuestionId =
  | (typeof questionCatalog)[number]["id"]
  | (typeof questionAliasCatalog)[number]["id"];

export function resolveQuestion(text: string) {
  const canonical = resolveCatalogText(questionCatalog, text);
  return canonical.kind === "unknown"
    ? resolveCatalogText(questionAliasCatalog, text)
    : canonical;
}

export function questionFor(id: CanonicalQuestionId) {
  return questionCatalog.find((question) => question.id === id) ??
    questionAliasCatalog.find((question) => question.id === id);
}

export function questionForField(
  text: string,
  behavior: UiBehaviorId,
): QuestionCatalogEntry | undefined {
  const resolution = resolveQuestion(text);
  if (resolution.kind !== "resolved") return undefined;
  const normalized = normalizeCatalogText(text);
  const canonical = questionCatalog.find((question) =>
    question.id === resolution.id &&
    question.behavior === behavior &&
    question.labels.some((label) => normalizeCatalogText(label) === normalized)
  );
  if (canonical !== undefined) return canonical;
  const alias = questionAliasCatalog.find((question) =>
    question.id === resolution.id &&
    question.behaviors.includes(behavior) &&
    question.labels.some((label) => normalizeCatalogText(label) === normalized)
  );
  const source = alias?.source ??
    questionCatalog.find(({ id }) => id === resolution.id)?.source;
  return alias === undefined || source === undefined
    ? undefined
    : Object.freeze({
        id: alias.id,
        labels: alias.labels,
        behavior,
        provenance: alias.provenance,
        source,
      });
}
