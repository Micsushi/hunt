import type {
  ProfileFactId,
  UiBehaviorId,
} from "../../contracts/index.ts";
import {
  assertCatalogHasNoCollisions,
  resolveCatalogKeywords,
  resolveCatalogText,
  type ReviewedCatalogEntry,
} from "./normalize.ts";

type QuestionSource =
  | {
      readonly kind: "profile";
      readonly factId: ProfileFactId;
      readonly ownerProvidedOnly?: true;
      readonly syntheticDefault?: string | number | boolean;
    }
  | {
      readonly kind: "narrative";
      readonly factId: "configured_narrative";
      readonly syntheticDefault: string;
    }
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
  entry("s1-question-configured-narrative", "Brief interest statement", "textarea", {
    kind: "narrative",
    factId: "configured_narrative",
    syntheticDefault: "I am interested in this role and available to discuss my qualifications.",
  }),
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
    "workday-placeholder-terms-consent",
    [
      "Yes, I have read and consent to the terms and conditions",
      "I have read and agree to the terms and conditions",
      "I acknowledge and consent to the terms and conditions",
    ],
    ["checkbox"],
    {
      kind: "synthetic_placeholder",
      value: true,
      placeholderProvenance: "synthetic_ui_learning",
      protected: true,
    },
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
  aliasEntry(
    "workday-placeholder-relative-employment",
    [
      "Do you have any relatives currently employed by the company?",
      "Are any of your relatives employed by the company?",
    ],
    ["radio", "select", "listbox"],
    {
      kind: "synthetic_placeholder",
      value: false,
      placeholderProvenance: "synthetic_ui_learning",
      protected: false,
    },
  ),
] as const satisfies readonly QuestionAliasCatalogEntry[]);

const questionSemanticCatalog = Object.freeze([
  { id: "s1-question-given-name", keywordGroups: [["given", "name"], ["first", "name"]] },
  { id: "s1-question-family-name", keywordGroups: [["family", "name"], ["last", "name"], ["surname"]] },
  { id: "s1-question-phone-number", keywordGroups: [["phone", "number"], ["mobile", "phone"]] },
  { id: "s1-question-configured-narrative", keywordGroups: [["interest", "statement"]] },
  { id: "s1-question-work-authorization", keywordGroups: [["authorized", "work"], ["authorised", "work"]] },
  { id: "s1-question-age-requirement-met", keywordGroups: [["18", "age"], ["18", "older"]] },
  { id: "s1-question-sponsorship-required", keywordGroups: [["require", "sponsorship"], ["need", "sponsorship"]] },
  { id: "s1-question-earliest-start-date", keywordGroups: [["start", "date"]] },
  { id: "s1-question-resume", keywordGroups: [["resume"], ["cv"]] },
  { id: "workday-question-highest-education", keywordGroups: [["highest", "education"], ["degree", "level"]] },
  { id: "workday-question-years-experience", keywordGroups: [["years", "experience"], ["year", "experience"]] },
  { id: "workday-question-desired-salary", keywordGroups: [["desired", "salary"], ["salary", "expectation"], ["salary", "expectations"], ["desired", "compensation"], ["compensation", "expectation"], ["compensation", "expectations"], ["expected", "compensation"]] },
  { id: "workday-question-gender-disclosure", keywordGroups: [["gender"], ["sex"]] },
  { id: "workday-question-ethnicity-disclosure", keywordGroups: [["ethnicity"], ["ethnicities"], ["race"]] },
  { id: "workday-question-veteran-disclosure", keywordGroups: [["veteran"]] },
  { id: "workday-question-disability-disclosure", keywordGroups: [["disability"], ["disabled"]] },
  { id: "workday-placeholder-terms-consent", keywordGroups: [["consent", "terms"], ["agree", "terms"], ["acknowledge", "terms"]] },
  { id: "workday-placeholder-prior-employment", keywordGroups: [["previously", "worked"], ["ever", "employed"], ["prior", "employment"], ["previous", "employment"]] },
  { id: "workday-placeholder-application-source", keywordGroups: [["hear", "about"], ["application", "source"]] },
  { id: "workday-placeholder-relative-employment", keywordGroups: [["relative", "employed"], ["relatives", "employed"], ["family", "employed"]] },
] as const);

assertCatalogHasNoCollisions([...questionCatalog, ...questionAliasCatalog]);

export type CanonicalQuestionId =
  | (typeof questionCatalog)[number]["id"]
  | (typeof questionAliasCatalog)[number]["id"];

const generatedLearningDefaults = Object.freeze({
  "s1-question-given-name": "Test",
  "s1-question-family-name": "Candidate",
  "s1-question-phone-number": "403-555-0100",
  "s1-question-work-authorization": true,
  "s1-question-age-requirement-met": true,
  "s1-question-sponsorship-required": false,
  "s1-question-country": "Canada",
  "s1-question-earliest-start-date": "2026-09-01",
  "workday-question-highest-education": "Bachelor's degree",
  "workday-question-years-experience": 5,
  "workday-question-desired-salary": 100000,
} as const satisfies Partial<Record<CanonicalQuestionId, string | number | boolean>>);

export function generatedLearningDefaultFor(
  id: CanonicalQuestionId,
): string | number | boolean | undefined {
  return generatedLearningDefaults[id as keyof typeof generatedLearningDefaults];
}

export function resolveQuestion(text: string) {
  const canonical = resolveCatalogText(questionCatalog, text);
  if (canonical.kind !== "unknown") return canonical;
  const alias = resolveCatalogText(questionAliasCatalog, text);
  return alias.kind === "unknown"
    ? resolveCatalogKeywords(questionSemanticCatalog, text)
    : alias;
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
  const canonical = questionCatalog.find((question) =>
    question.id === resolution.id &&
    question.behavior === behavior
  );
  if (canonical !== undefined) return canonical;
  const alias = questionAliasCatalog.find((question) =>
    question.id === resolution.id &&
    question.behaviors.includes(behavior)
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

const privacyDefaults = Object.freeze([
  "Prefer not to answer",
  "Prefer not to say",
  "I do not wish to provide this information",
  "Decline to self-identify",
]);

function answerTypeFor(behavior: UiBehaviorId) {
  if (behavior === "radio" || behavior === "select" || behavior === "listbox") {
    return "single_select" as const;
  }
  if (behavior === "checkbox") return "boolean" as const;
  if (behavior === "date") return "date" as const;
  if (behavior === "file_upload") return "file" as const;
  return "text" as const;
}

export interface QuestionAnswerGuideEntry {
  readonly id: CanonicalQuestionId;
  readonly labels: readonly string[];
  readonly answerTypes: readonly ("text" | "boolean" | "single_select" | "date" | "file")[];
  readonly possibleAnswers: readonly string[];
  readonly defaultPolicy:
    | { readonly kind: "owner_required" }
    | { readonly kind: "resume_artifact" }
    | { readonly kind: "configured_template_or_generated_learning_default"; readonly value: string; readonly replaceWithOwnerAnswer: true }
    | { readonly kind: "privacy_choice_or_first_visible_learning_option"; readonly values: readonly string[]; readonly replaceWithOwnerAnswer: true }
    | { readonly kind: "generated_learning_default"; readonly value: string | number | boolean; readonly replaceWithOwnerAnswer: true }
    | { readonly kind: "visible_exact_match_only"; readonly value: string | number | boolean };
}

function guidePolicy(
  id: CanonicalQuestionId,
  source: QuestionSource | undefined,
): QuestionAnswerGuideEntry["defaultPolicy"] {
  if (source?.kind === "narrative") {
    return Object.freeze({
      kind: "configured_template_or_generated_learning_default",
      value: source.syntheticDefault,
      replaceWithOwnerAnswer: true,
    });
  }
  if (source?.kind === "resume") return Object.freeze({ kind: "resume_artifact" });
  if (source?.kind === "neutral_disclosure") {
    return Object.freeze({
      kind: "privacy_choice_or_first_visible_learning_option",
      values: privacyDefaults,
      replaceWithOwnerAnswer: true,
    });
  }
  const generatedDefault = generatedLearningDefaultFor(id);
  if (generatedDefault !== undefined) {
    return Object.freeze({
      kind: "generated_learning_default",
      value: generatedDefault,
      replaceWithOwnerAnswer: true,
    });
  }
  if (source?.kind === "synthetic_placeholder") {
    return Object.freeze({ kind: "visible_exact_match_only", value: source.value });
  }
  return Object.freeze({ kind: "owner_required" });
}

function createQuestionAnswerGuide(): readonly QuestionAnswerGuideEntry[] {
  const guide = new Map<string, QuestionAnswerGuideEntry>();
  const rows = [
    ...questionCatalog.map((question) => ({
      id: question.id,
      labels: question.labels,
      behaviors: [question.behavior] as readonly UiBehaviorId[],
      source: question.source as QuestionSource,
    })),
    ...questionAliasCatalog.map((question) => ({
      id: question.id,
      labels: question.labels,
      behaviors: question.behaviors,
      source: question.source ?? questionCatalog.find(({ id }) => id === question.id)?.source,
    })),
  ];
  for (const row of rows) {
    const previous = guide.get(row.id);
    const possibleAnswers = row.source?.kind === "neutral_disclosure"
      ? privacyDefaults
      : row.id === "workday-placeholder-prior-employment" ||
          row.id === "workday-placeholder-relative-employment" ||
          row.behaviors.includes("checkbox")
      ? Object.freeze(["Yes", "No"])
      : Object.freeze([] as string[]);
    guide.set(row.id, Object.freeze({
      id: row.id as CanonicalQuestionId,
      labels: Object.freeze([...new Set([...(previous?.labels ?? []), ...row.labels])]),
      answerTypes: Object.freeze([...new Set([
        ...(previous?.answerTypes ?? []),
        ...row.behaviors.map(answerTypeFor),
      ])]),
      possibleAnswers,
      defaultPolicy: guidePolicy(row.id as CanonicalQuestionId, row.source),
    }));
  }
  return Object.freeze([...guide.values()]);
}

export const questionAnswerGuide = createQuestionAnswerGuide();
