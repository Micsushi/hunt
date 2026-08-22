import type { UiBehaviorId } from "../../contracts/index.ts";
import type {
  ApplicationProfileFactId,
  DiscoveredIntakeField,
} from "../answers/application-types.ts";
import {
  assertCatalogHasNoCollisions,
  resolveCatalogKeywords,
  resolveCatalogText,
  type ReviewedCatalogEntry,
} from "./normalize.ts";

type QuestionSource =
  | {
      readonly kind: "profile";
      readonly factId: ApplicationProfileFactId;
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
    [
      "Are you at least 18 years of age?",
      "Are you 18 years of age or older?",
      "Do you certify that you are 18 years of age or older?",
    ],
    ["checkbox", "radio", "select", "listbox"],
  ),
  aliasEntry(
    "s1-question-sponsorship-required",
    [
      "Will you now or in the future require sponsorship?",
      "Do you require employment sponsorship now or in the future?",
      "Do you now, or will you in the future, require sponsorship to work legally for Integer in the U.S.?",
    ],
    ["radio", "select", "listbox"],
  ),
  aliasEntry(
    "s1-question-earliest-start-date",
    ["Earliest Start Date", "Desired Start Date", "What is your availability/start date?", "When are you available to start?"],
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
    ["Desired Salary", "Salary Expectation", "Desired Compensation", "What are your salary expectations?", "Salary expectations"],
    ["text", "textarea", "select", "listbox"],
    { kind: "profile", factId: "salary_expectations", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-gender-disclosure",
    ["Gender", "Gender Identity", "Sex"],
    ["radio", "select", "listbox"],
    { kind: "profile", factId: "gender_disclosure", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-ethnicity-disclosure",
    [
      "Race/Ethnicity",
      "Race or Ethnicity",
      "Ethnicity",
      "Ethnicities",
      "Are you Hispanic or Latino?",
    ],
    ["radio", "select", "listbox"],
    { kind: "profile", factId: "ethnicity_disclosure", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-veteran-disclosure",
    ["Veteran Status", "Protected Veteran Status", "Were you ever in the military?"],
    ["radio", "select", "listbox"],
    { kind: "profile", factId: "veteran_disclosure", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-disability-disclosure",
    ["Disability Status", "Disability Self-Identification"],
    ["radio", "select", "listbox"],
    { kind: "profile", factId: "disability_disclosure", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-placeholder-terms-consent",
    [
      "Yes, I have read and consent to the terms and conditions",
      "I have read and agree to the terms and conditions",
      "I acknowledge and consent to the terms and conditions",
      "I Agree",
      "Accept Terms and Agreements",
    ],
    ["checkbox"],
    { kind: "profile", factId: "terms_consent", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-placeholder-prior-employment",
    [
      "Have you ever been employed by QTS Data Centers?",
      "Have you ever worked for Pyramid Global Hospitality?",
      "Have you previously worked for HRI Hospitality?",
      "Have you previously worked for HRI Hospitality? CURRENT ASSOCIATES: Please apply via your Workday account instead from Jobs Hub.",
      "Have you previously worked for our company (this does not apply to contingent/contract work)?",
    ],
    ["radio", "select", "listbox"],
    { kind: "profile", factId: "previously_worked_for_organization", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-placeholder-application-source",
    ["How Did You Hear About Us?"],
    ["select", "listbox"],
    {
      kind: "profile",
      factId: "application_source",
      ownerProvidedOnly: true,
      syntheticDefault: "LinkedIn",
    },
  ),
  aliasEntry(
    "workday-placeholder-relative-employment",
    [
      "Do you have any relatives currently employed by the company?",
      "Are any of your relatives employed by the company?",
      "Do you have any relatives employed by Integer?",
      "Do you have any relatives currently employed by Integer?",
    ],
    ["radio", "select", "listbox"],
    { kind: "profile", factId: "relatives_employed", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-placeholder-associate-referral",
    ["Have you been referred by an associate?", "Have you been referred by an Integer associate?"],
    ["radio", "select", "listbox"],
    { kind: "profile", factId: "associate_referral", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-current-associate",
    [
      "Are you a current Integer associate?",
      "Are you currently an Integer associate?",
      "Are you a current Integer associate (this does not apply to contingent/contract work)?",
    ],
    ["radio", "select", "listbox"],
    { kind: "profile", factId: "current_associate", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-previously-applied",
    [
      "Have you previously applied to Integer?",
      "Have you applied to Integer before?",
      "Have you previously applied for a position with our company?",
    ],
    ["radio", "select", "listbox"],
    { kind: "profile", factId: "previously_applied", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-essential-functions",
    [
      "Are you physically able to perform the essential functions of this position?",
      "Based on your understanding of this role, do you believe you are physically able to perform the essential functions of the job?",
    ],
    ["radio", "select", "listbox"],
    { kind: "profile", factId: "essential_functions_ability", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-employment-agreement",
    [
      "Are you subject to an NDA, non-compete, or company agreement that would prevent employment with Integer?",
      "Are you subject to any NDA, non-compete, or company agreement preventing employment?",
      "Are you currently subject to any company agreement (NDA, Non-compete, etc.) that would prevent you from working with INTEGER Holdings Corporation?",
    ],
    ["radio", "select", "listbox"],
    {
      kind: "profile",
      factId: "employment_agreement_prevents_employment",
      ownerProvidedOnly: true,
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
  { id: "workday-question-desired-salary", keywordGroups: [["desired", "salary"], ["salary", "expectation"], ["salary", "expectations"], ["salary", "requirements"], ["desired", "compensation"], ["compensation", "expectation"], ["compensation", "expectations"], ["compensation", "requirements"], ["expected", "compensation"]] },
  { id: "workday-question-gender-disclosure", keywordGroups: [["gender"], ["sex"]] },
  { id: "workday-question-ethnicity-disclosure", keywordGroups: [["ethnicity"], ["ethnicities"], ["race"], ["hispanic"], ["latino"]] },
  { id: "workday-question-veteran-disclosure", keywordGroups: [["veteran"], ["military"], ["armed", "forces"]] },
  { id: "workday-question-disability-disclosure", keywordGroups: [["disability"], ["disabled"]] },
  { id: "workday-placeholder-terms-consent", keywordGroups: [["consent", "terms"], ["agree", "terms"], ["acknowledge", "terms"]] },
  { id: "workday-placeholder-prior-employment", keywordGroups: [["previously", "worked"], ["ever", "employed"], ["prior", "employment"], ["previous", "employment"]] },
  { id: "workday-placeholder-application-source", keywordGroups: [["hear", "about"], ["application", "source"]] },
  { id: "workday-placeholder-relative-employment", keywordGroups: [["relative", "employed"], ["relatives", "employed"], ["family", "employed"]] },
  { id: "workday-placeholder-associate-referral", keywordGroups: [["referred", "associate"], ["referred", "employee"]] },
  { id: "workday-question-current-associate", keywordGroups: [["current", "integer", "associate"], ["currently", "integer", "associate"]] },
  { id: "workday-question-previously-applied", keywordGroups: [["previously", "applied"], ["applied", "before"]] },
  { id: "workday-question-essential-functions", keywordGroups: [["able", "perform", "essential", "functions"]] },
  { id: "workday-question-employment-agreement", keywordGroups: [["nda"], ["non", "compete"], ["company", "agreement", "prevent"]] },
] as const);

assertCatalogHasNoCollisions([...questionCatalog, ...questionAliasCatalog]);

export type CanonicalQuestionId =
  | (typeof questionCatalog)[number]["id"]
  | (typeof questionAliasCatalog)[number]["id"];

const generatedLearningDefaults = Object.freeze({
  "s1-question-given-name": "Test",
  "s1-question-family-name": "Candidate",
  "s1-question-phone-number": "403-555-0100",
  "s1-question-country": "Canada",
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
  "I do not want to answer",
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
  readonly initialState: "unset";
  readonly behaviors: readonly UiBehaviorId[];
  readonly answerTypes: readonly ("text" | "boolean" | "single_select" | "date" | "file")[];
  readonly allowedOptions: readonly string[];
  readonly allowsCustomValue: boolean;
  readonly defaultPolicy:
    | { readonly kind: "owner_required" }
    | { readonly kind: "resume_artifact" }
    | { readonly kind: "configured_template_or_generated_learning_default"; readonly value: string; readonly replaceWithOwnerAnswer: true }
    | { readonly kind: "privacy_choice_only"; readonly values: readonly string[] }
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
      kind: "privacy_choice_only",
      values: privacyDefaults,
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
    if (source.protected) return Object.freeze({ kind: "owner_required" });
    return Object.freeze({ kind: "visible_exact_match_only", value: source.value });
  }
  return Object.freeze({ kind: "owner_required" });
}

function createQuestionAnswerGuide(): readonly QuestionAnswerGuideEntry[] {
  const guide = new Map<string, QuestionAnswerGuideEntry>();
  const unobservedOptionCatalogs = new Set<CanonicalQuestionId>([
    "s1-question-age-requirement-met",
    "s1-question-sponsorship-required",
    "workday-placeholder-associate-referral",
    "workday-question-current-associate",
    "workday-question-previously-applied",
    "workday-placeholder-relative-employment",
    "workday-question-essential-functions",
    "workday-question-employment-agreement",
    "workday-question-veteran-disclosure",
  ]);
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
    const privacyQuestion = new Set<CanonicalQuestionId>([
      "workday-question-gender-disclosure",
      "workday-question-ethnicity-disclosure",
      "workday-question-veteran-disclosure",
      "workday-question-disability-disclosure",
    ]).has(row.id as CanonicalQuestionId);
    const booleanQuestion = row.source?.kind === "profile" &&
      new Set<ApplicationProfileFactId>([
        "work_authorization", "sponsorship_required", "age_requirement_met",
        "previously_worked_for_organization", "associate_referral",
        "current_associate", "previously_applied", "relatives_employed",
        "essential_functions_ability", "employment_agreement_prevents_employment",
        "terms_consent",
      ]).has(row.source.factId);
    const allowedOptions = unobservedOptionCatalogs.has(row.id as CanonicalQuestionId)
      ? Object.freeze([] as string[])
      : privacyQuestion
      ? privacyDefaults
      : booleanQuestion || row.behaviors.includes("checkbox")
      ? Object.freeze(["Yes", "No"])
      : Object.freeze([] as string[]);
    const answerTypes = Object.freeze([...new Set([
      ...(previous?.answerTypes ?? []),
      ...row.behaviors.map(answerTypeFor),
    ])]);
    guide.set(row.id, Object.freeze({
      id: row.id as CanonicalQuestionId,
      labels: Object.freeze([...new Set([...(previous?.labels ?? []), ...row.labels])]),
      initialState: "unset",
      behaviors: Object.freeze([...new Set([
        ...(previous?.behaviors ?? []),
        ...row.behaviors,
      ])]),
      answerTypes,
      allowedOptions,
      allowsCustomValue: answerTypes.some((type) => type === "text" || type === "date"),
      defaultPolicy: guidePolicy(row.id as CanonicalQuestionId, row.source),
    }));
  }
  return Object.freeze([...guide.values()]);
}

export const questionAnswerGuide = createQuestionAnswerGuide();

export interface RetainedIntakeControlGuideEntry {
  readonly page:
    | "profile" | "questionnaire" | "voluntary_disclosures"
    | "self_identify" | "resume";
  readonly identity: string | "unresolved";
  readonly sanitizedLabel: string | null;
  readonly normalizedQuestionType: DiscoveredIntakeField["normalizedQuestionType"];
  readonly behavior:
    | UiBehaviorId
    | "repeatable"
    | "search_select";
  readonly answerType:
    | "text"
    | "date"
    | "boolean"
    | "single_select"
    | "file"
    | "multi_select"
    | "repeatable";
  readonly required: boolean | null;
  readonly initialState: "unset";
  readonly uiVariant: string;
  readonly allowedOptions: readonly string[];
  readonly allowsCustomValue: boolean;
  readonly constraints: DiscoveredIntakeField["constraints"];
}

export const retainedIntakeControlGuide: readonly RetainedIntakeControlGuideEntry[] =
  Object.freeze([
    retained("profile", "identity.given_name", "First Name", "identity", "text", "text", true, "workday_text_v2"),
    retained("profile", "identity.middle_name", "Middle Name", "identity", "text", "text", false, "workday_text_v2"),
    retained("profile", "identity.family_name", "Last Name", "identity", "text", "text", true, "workday_text_v2"),
    retained("profile", "identity.preferred_name", "Preferred Name", "identity", "text", "text", false, "workday_text_v1"),
    retained("profile", "identity.has_preferred_name", "I have a preferred name", "identity", "checkbox", "boolean", false, "workday_checkbox_v2", ["Yes", "No"]),
    retained("profile", "address.line1", "Address Line 1", "address", "text", "text", false, "workday_text_v2"),
    retained("profile", "address.line2", "Address Line 2", "address", "text", "text", false, "workday_text_v2"),
    retained("profile", "address.city", "City", "address", "text", "text", false, "workday_text_v2"),
    retained("profile", "address.country", "Country", "address", "search_select", "single_select", true, "workday_search_select_v2"),
    retained("profile", "address.region", "Province or Territory", "address", "search_select", "single_select", false, "workday_search_select_v2"),
    retained("profile", "address.postal_code", "Postal Code", "address", "text", "text", false, "workday_text_v2"),
    retained("profile", "contact.email", "Email", "identity", "text", "text", true, "workday_text_v2"),
    retained("profile", "phone.device_type", "Phone Device Type", "phone", "search_select", "single_select", true, "workday_search_select_v2"),
    retained("profile", "phone.country_code", "Country Phone Code", "phone", "search_select", "single_select", true, "workday_search_select_v2"),
    retained("profile", "phone.number", "Phone Number", "phone", "text", "text", true, "workday_phone_v2"),
    retained("profile", "phone.extension", "Phone Extension", "phone", "text", "text", false, "workday_text_v2"),
    retained("profile", "source.how_did_you_hear", "How Did You Hear About Us?", "application_source", "search_select", "single_select", true, "workday_source_select_v1"),
    retained("profile", "employment.previously_worked_for_organization", "Have you previously worked for our company (this does not apply to contingent/contract work)?", "prior_employment", "radio", "single_select", true, "workday_previous_worker_radio_v1", ["Yes", "No"]),
    retained("profile", "skills.values", "Skills", "skill", "search_select", "multi_select", false, "workday_multi_select_v1"),
    retained("profile", "social.linkedin", "LinkedIn", "social_network", "text", "text", false, "workday_text_v2"),
    retained("profile", "social.github", "GitHub", "social_network", "text", "text", false, "workday_text_v2"),
    retained("profile", "website.portfolio", "Portfolio Website", "website", "text", "text", false, "workday_text_v2"),
    retained("questionnaire", "age_requirement_met", "Do you certify that you are 18 years of age or older?", "legal", "select", "single_select", null, "workday_select_v1"),
    retained("questionnaire", "associate_referral", "Have you been referred by an Integer associate?", "employment", "select", "single_select", null, "workday_select_v1"),
    retained("questionnaire", "current_associate", "Are you a current Integer associate (this does not apply to contingent/contract work)?", "employment", "select", "single_select", null, "workday_select_v1"),
    retained("questionnaire", "previously_applied", "Have you previously applied for a position with our company?", "employment", "select", "single_select", null, "workday_select_v1"),
    retained("questionnaire", "relatives_employed", "Do you have any relatives currently employed by Integer?", "employment", "select", "single_select", null, "workday_select_v1"),
    retained("questionnaire", "sponsorship_required", "Do you now, or will you in the future, require sponsorship to work legally for Integer in the U.S.?", "authorization", "select", "single_select", null, "workday_select_v1"),
    retained("questionnaire", "essential_functions_ability", "Based on your understanding of this role, do you believe you are physically able to perform the essential functions of the job?", "legal", "select", "single_select", null, "workday_select_v1"),
    retained("questionnaire", "employment_agreement_prevents_employment", "Are you currently subject to any company agreement (NDA, Non-compete, etc.) that would prevent you from working with INTEGER Holdings Corporation?", "legal", "select", "single_select", null, "workday_select_v1"),
    retained("questionnaire", "earliest_start_date", "When are you available to start?", "availability", "date", "date", null, "workday_date_v1", [], { displayFormat: "MM/DD/YYYY" }),
    retained("questionnaire", "salary_expectations", "Salary expectations", "compensation", "textarea", "text", null, "workday_textarea_v1"),
    retained("voluntary_disclosures", "veteran_disclosure", "Select Veteran Status", "demographic", "select", "single_select", true, "workday_select_v1"),
    retained("voluntary_disclosures", "terms_consent", "Yes, I have read and consent to the terms and conditions", "legal", "checkbox", "boolean", true, "workday_checkbox_v2", ["Yes", "No"]),
    retained("self_identify", "self_identification_language", "Language", "demographic", "select", "single_select", null, "workday_select_v1"),
    retained("self_identify", "self_identification_name", "Name", "identity", "text", "text", null, "workday_text_v1"),
    retained("self_identify", "unresolved", null, "unknown", "text", "text", null, "workday_text_v1"),
    retained("self_identify", "self_identification_date", "Date", "demographic", "date", "date", null, "workday_date_v1", [], { displayFormat: "MM/DD/YYYY" }),
    retained(
      "self_identify",
      "disability_disclosure",
      "Please check one of the boxes below",
      "demographic",
      "radio",
      "single_select",
      null,
      "workday_radio_v1",
      [
        "Yes, I have a disability, or have had one in the past",
        "No, I do not have a disability and have not had one in the past",
        "I do not want to answer",
      ],
    ),
    retained("resume", "experience", "Work Experience Add", "employment", "repeatable", "repeatable", false, "workday_repeatable_v1"),
    retained("resume", "education", "Education Add", "education", "repeatable", "repeatable", false, "workday_repeatable_v1"),
    retained("resume", "skills", "Type to Add Skills", "skill", "search_select", "multi_select", false, "workday_search_select_v1"),
    retained("resume", "resume", "Upload a file (5MB max)", "attachment", "file_upload", "file", false, "workday_resume_file_upload_v1", [], { maxBytes: 5 * 1024 * 1024 }),
    retained("resume", "websites", "Websites Add", "website", "repeatable", "repeatable", false, "workday_repeatable_v1"),
  ]);

export function retainedDiscoveredIntakeFields(): readonly DiscoveredIntakeField[] {
  return Object.freeze(retainedIntakeControlGuide.map((field, index) => Object.freeze({
    discoveredFieldId: `retained-${String(index + 1).padStart(2, "0")}`,
    page: field.page,
    identity: field.identity,
    sanitizedLabel: field.sanitizedLabel,
    normalizedQuestionType: field.normalizedQuestionType,
    behavior: field.behavior,
    answerType: field.answerType,
    uiVariant: field.uiVariant,
    required: field.required,
    allowedOptions: Object.freeze([...field.allowedOptions]),
    allowsCustomValue: field.allowsCustomValue,
    constraints: Object.freeze({ ...field.constraints }),
    answer: Object.freeze({ kind: "profile_answer_missing" as const }),
  })));
}

function retained(
  page: RetainedIntakeControlGuideEntry["page"],
  identity: string,
  sanitizedLabel: string | null,
  normalizedQuestionType: RetainedIntakeControlGuideEntry["normalizedQuestionType"],
  behavior: RetainedIntakeControlGuideEntry["behavior"],
  answerType: RetainedIntakeControlGuideEntry["answerType"],
  required: boolean | null,
  uiVariant: string,
  allowedOptions: readonly string[] = [],
  constraints: Partial<DiscoveredIntakeField["constraints"]> = {},
): RetainedIntakeControlGuideEntry {
  return Object.freeze({
    page,
    identity,
    sanitizedLabel,
    normalizedQuestionType,
    behavior,
    answerType,
    required,
    initialState: "unset",
    uiVariant,
    allowedOptions: Object.freeze([...allowedOptions]),
    allowsCustomValue: answerType === "text" || answerType === "date",
    constraints: Object.freeze({
      maxBytes: constraints.maxBytes ?? null,
      displayFormat: constraints.displayFormat ?? null,
    }),
  });
}
