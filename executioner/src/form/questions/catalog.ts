import { createHash } from "node:crypto";

import type { UiBehaviorId } from "../../contracts/index.ts";
import { applicantRefersSomeone, employmentQuestion, referralQuestion, rankQuestionCandidates, sameEmployer } from './matching.ts';
import type {
  ApplicationProfileFactId,
  DiscoveredIntakeField,
} from "../answers/application-types.ts";
import {
  assertCatalogHasNoCollisions,
  normalizeCatalogText,
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

export const canadianWorkEligibilityLabels = [
  "Are you currently eligible to work in Canada?",
  "Êtes vous présentement admissible à travailler au Canada? | Are you currently eligible to work in Canada?",
] as const;

const questionAliasCatalog = Object.freeze([
  // Existing current-page wording shares the same stable facts in both workflows.
  aliasEntry("s1-question-given-name", ["first name","legal first name","prénom"], ["text", "textarea"], {"kind":"profile","factId":"given_name"}),
  aliasEntry("s1-question-family-name", ["last name","legal last name","nom de famille"], ["text", "textarea"], {"kind":"profile","factId":"family_name"}),
  aliasEntry("owner-question-preferred-name", ["preferred name","preferred first name"], ["text", "textarea"], { kind: "profile", factId: "preferred_name" }),
  aliasEntry("owner-question-email-address", ["email","email address","e-mail","adresse e-mail","adresse courriel / email","confirm your email"], ["text", "textarea"], { kind: "profile", factId: "email_address" }),
  aliasEntry("s1-question-phone-number", ["phone","mobile phone","téléphone","numéro de téléphone / phone number"], ["text", "textarea"], {"kind":"profile","factId":"phone_number"}),
  aliasEntry("owner-question-phone-country-code", ["Phone country code", "Country phone code", "Phone country"], ["select", "listbox", "text"], { kind: "profile", factId: "phone_country_code" }),
  aliasEntry("owner-question-current-location", ["Location", "Current location"], ["text", "textarea"], { kind: "profile", factId: "current_location" }),
  aliasEntry("owner-question-city", ["city","ville"], ["text", "textarea"], { kind: "profile", factId: "city" }),
  aliasEntry("owner-question-postal-code", ["postal code","zip code","postal code / zip code","zip","code postal"], ["text", "textarea", "listbox"], { kind: "profile", factId: "postal_code" }),
  aliasEntry("owner-question-current-company", ["current company"], ["text", "textarea"], { kind: "profile", factId: "current_company" }),
  aliasEntry("owner-question-current-title", ["current title"], ["text", "textarea"], { kind: "profile", factId: "current_title" }),
  aliasEntry("owner-question-linkedin-url", ["linkedin link","linkedin","linkedin profile","linkedin profile url","linkedin url"], ["text", "textarea"], { kind: "profile", factId: "linkedin_url" }),
  aliasEntry("owner-question-github-url", ["github","github profile","github url","github profile url"], ["text", "textarea"], { kind: "profile", factId: "github_url" }),
  aliasEntry("owner-question-portfolio-url", ["portfolio","portfolio url","portfolio website","website, blog or portfolio","website"], ["text", "textarea"], { kind: "profile", factId: "portfolio_url" }),
  aliasEntry("owner-question-address-line1", ["address"], ["text", "textarea"], {"kind":"profile","factId":"address_line1","ownerProvidedOnly":true}),
  aliasEntry("workday-question-desired-salary", ["what would be your salary expectations for the position?"], ["text", "textarea"], {"kind":"profile","factId":"salary_expectations","ownerProvidedOnly":true}),
  aliasEntry("owner-question-address-line1", ["Street address", "Address Line 1"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "address_line1", ownerProvidedOnly: true }),
  aliasEntry("owner-question-address-line2", ["Address Line 2", "Apartment or unit"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "address_line2", ownerProvidedOnly: true }),
  aliasEntry("owner-question-education-institution", ["University", "School name", "School or University", "School/University"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "education_institution", ownerProvidedOnly: true }),
  aliasEntry("owner-question-education-degree", ["Degree"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "education_degree", ownerProvidedOnly: true }),
  aliasEntry("owner-question-education-field-of-study", ["Field of study", "Major"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "education_field_of_study", ownerProvidedOnly: true }),
  aliasEntry("owner-question-education-start-year", ["First year attended"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "education_start_year", ownerProvidedOnly: true }),
  aliasEntry("owner-question-education-end-year", ["Graduation year", "Last year attended"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "education_end_year", ownerProvidedOnly: true }),
  aliasEntry("owner-question-education-gpa", ["GPA", "Grade point average", "What is your average GPA?"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "education_gpa", ownerProvidedOnly: true }),
  aliasEntry("owner-question-education-gpa-scale", ["GPA scale"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "education_gpa_scale", ownerProvidedOnly: true }),
  aliasEntry("owner-question-languages", ["Languages spoken"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "languages", ownerProvidedOnly: true }),
  aliasEntry("owner-question-driver-license", ["Driver licence class"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "driver_license", ownerProvidedOnly: true }),
  aliasEntry("owner-question-reason-for-leaving", ["Reason for leaving"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "reason_for_leaving", ownerProvidedOnly: true }),
  aliasEntry("owner-question-relocation-preference", ["Preferred relocation location"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "relocation_preference", ownerProvidedOnly: true }),
  aliasEntry("owner-question-work-arrangements", ["Preferred work arrangement"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "work_arrangements", ownerProvidedOnly: true }),
  aliasEntry("owner-question-employment-types", ["Preferred employment types"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "employment_types", ownerProvidedOnly: true }),
  aliasEntry("owner-question-acceptable-work-terms", ["Acceptable work term lengths"], ["text", "textarea", "select", "listbox"], { kind: "profile", factId: "acceptable_work_terms", ownerProvidedOnly: true }),
  aliasEntry("owner-question-official-coop-program", ["Are you enrolled in an official co-op program?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "official_coop_program", ownerProvidedOnly: true }),
  aliasEntry("owner-question-current-coop-wil", ["Are you currently enrolled in a Co-op or Work-Integrated Learning (WIL) program through your school?"], ["text", "textarea", "radio", "select", "listbox"], { kind: "profile", factId: "official_coop_program", ownerProvidedOnly: true }),
  aliasEntry("owner-question-returning-to-studies", ["Will you return to university after your work term?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "returning_to_studies", ownerProvidedOnly: true }),
  aliasEntry("owner-question-university-coop-approval", ["Can your university approve a co-op placement?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "university_coop_approval", ownerProvidedOnly: true }),
  aliasEntry("owner-question-relocation-assistance-required", ["Do you require relocation assistance?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "relocation_assistance_required", ownerProvidedOnly: true }),
  aliasEntry("owner-question-overtime-available", ["Are you willing to work overtime?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "overtime_available", ownerProvidedOnly: true }),
  aliasEntry("owner-question-evenings-available", ["Are you available to work evenings?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "evenings_available", ownerProvidedOnly: true }),
  aliasEntry("owner-question-weekends-available", ["Are you available to work weekends?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "weekends_available", ownerProvidedOnly: true }),
  aliasEntry("owner-question-overnights-available", ["Are you available to work overnight shifts?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "overnights_available", ownerProvidedOnly: true }),
  aliasEntry("owner-question-vehicle-access", ["Do you have access to a vehicle?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "vehicle_access", ownerProvidedOnly: true }),
  aliasEntry("owner-question-valid-drivers-licence", ["Do you have a valid driver's licence?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "valid_drivers_licence", ownerProvidedOnly: true }),
  aliasEntry("owner-question-background-check-willing", ["Are you willing to undergo a background check?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "background_check_willing", ownerProvidedOnly: true }),
  aliasEntry("owner-question-references-available", ["Are references available upon request?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "references_available", ownerProvidedOnly: true }),
  aliasEntry("owner-question-may-contact-employer", ["May we contact this employer?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "may_contact_employer", ownerProvidedOnly: true }),
  aliasEntry("owner-question-recruiting-texts", ["Would you like to receive recruiting text messages?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "recruiting_texts", ownerProvidedOnly: true }),
  aliasEntry("owner-question-marketing-messages", ["Would you like to receive marketing messages?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "marketing_messages", ownerProvidedOnly: true }),
  aliasEntry("owner-question-talent-community", ["Would you like to join our talent community?"], ["radio", "select", "listbox", "checkbox"], { kind: "profile", factId: "talent_community", ownerProvidedOnly: true }),

  aliasEntry("s1-question-country", ["Country", "Pays"], ["select", "listbox", "text"]),
  aliasEntry("owner-question-residence-region", ["Which U.S. State or Canadian Province do you reside in?", "State", "Province", "State/Province"], ["select", "listbox", "text"],
    { kind: "profile", factId: "region", ownerProvidedOnly: true }),
  aliasEntry(
    "s1-question-work-authorization",
    ["Are you legally authorized to work in this country?", "Are you legally entitled to work in Canada?",
      "Are you authorized to work lawfully in the Canada?", ...canadianWorkEligibilityLabels],
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
    ["Earliest Start Date", "Desired Start Date", "Date available", "What is your availability/start date?", "When are you available to start?", "When are you looking to start?"],
    ["date", "text", "textarea"],
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
    ["text", "textarea", "select", "listbox"],
    { kind: "profile", factId: "years_experience", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-desired-salary",
    ["Desired Salary", "Desired pay", "Salary Expectation", "Desired Compensation", "What are your salary expectations?", "Salary expectations", "What salary range are you targeting?", "What is your target compensation range?"],
    ["text", "textarea", "select", "listbox"],
    { kind: "profile", factId: "salary_expectations", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-weekly-hours",
    ["Desired weekly hours", "Expected weekly hours"],
    ["text", "textarea", "select", "listbox"],
    { kind: "profile", factId: "weekly_hours", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-travel-percentage",
    ["Travel percentage"],
    ["text"],
    { kind: "profile", factId: "travel_percentage", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-question-notice-period-days",
    ["Notice period in days"],
    ["text", "textarea", "select", "listbox"],
    { kind: "profile", factId: "notice_period_days", ownerProvidedOnly: true },
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
      "Have you ever been employed by Adient?",
      "Have you ever been employed by QTS Data Centers?",
      "Have you ever worked for Pyramid Global Hospitality?",
      "Have you previously worked for HRI Hospitality?",
      "Have you previously worked for HRI Hospitality? CURRENT ASSOCIATES: Please apply via your Workday account instead from Jobs Hub.",
      "Have you previously worked for our company (this does not apply to contingent/contract work)?",
      "Have you previously worked for this organization? If Yes, please answer the questions below. If No, please continue to the next page.",
    ],
    ["radio", "select", "listbox"],
    { kind: "profile", factId: "previously_worked_for_organization", ownerProvidedOnly: true },
  ),
  aliasEntry(
    "workday-placeholder-application-source",
    ["How Did You Hear About Us?"],
    ["radio", "select", "listbox"],
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
  { id: "workday-question-desired-salary", keywordGroups: [["desired", "salary"], ["expected", "salary"], ["salary", "expectation"], ["salary", "expectations"], ["salary", "requirements"], ["desired", "compensation"], ["compensation", "expectation"], ["compensation", "expectations"], ["compensation", "requirements"], ["expected", "compensation"]] },
  { id: "workday-question-weekly-hours", keywordGroups: [
    ["expected", "weekly", "hours"], ["desired", "weekly", "hours"],
    ["many", "hours", "week"], ["available", "hours", "week"],
  ] },
  { id: "workday-question-notice-period-days", keywordGroups: [["notice", "period", "days"], ["notice", "period", "day"]] },
  { id: "workday-question-gender-disclosure", keywordGroups: [["gender"], ["sex"]] },
  { id: "workday-question-ethnicity-disclosure", keywordGroups: [["ethnicity"], ["ethnicities"], ["race"], ["hispanic"], ["latino"]] },
  { id: "workday-question-veteran-disclosure", keywordGroups: [
    ["veteran"], ["military", "served"], ["military", "service"], ["military", "status"],
    ["armed", "forces", "served"], ["armed", "forces", "member"],
  ] },
  { id: "workday-question-disability-disclosure", keywordGroups: [["disability"], ["disabled"]] },
  { id: "workday-placeholder-terms-consent", keywordGroups: [["consent", "terms"], ["agree", "terms"], ["acknowledge", "terms"]] },
  { id: "workday-placeholder-prior-employment", keywordGroups: [
    ["previously", "worked", "organization"],
    ["previously", "worked", "company"],
    ["previously", "worked", "affiliate"],
    ["ever", "employed", "organization"],
    ["ever", "employed", "company"],
    ["ever", "employed", "affiliate"],
    ["prior", "employment", "organization"],
    ["prior", "employment", "company"],
    ["prior", "employment", "affiliate"],
    ["previous", "employment", "organization"],
    ["previous", "employment", "company"],
    ["previous", "employment", "affiliate"],
  ] },
  { id: "workday-placeholder-application-source", keywordGroups: [["hear", "about"], ["application", "source"], ["how", "learn", "about", "employer"]] },
  { id: "workday-placeholder-relative-employment", keywordGroups: [["relative", "employed"], ["relatives", "employed"], ["family", "employed"]] },
  { id: "workday-placeholder-associate-referral", keywordGroups: [["referred", "associate"], ["referred", "employee"]] },
  { id: "workday-question-current-associate", keywordGroups: [["current", "integer", "associate"], ["currently", "integer", "associate"], ["currently", "work", "at"], ["currently", "employed", "by"], ["currently", "employed", "with"]] },
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
  "workday-question-desired-salary": 1,
  "workday-question-weekly-hours": 40,
  "workday-question-travel-percentage": 1,
  "workday-question-notice-period-days": 0,
  "workday-question-years-experience": 0,
} as const satisfies Partial<Record<CanonicalQuestionId, string | number | boolean>>);

export function generatedLearningDefaultFor(
  id: CanonicalQuestionId,
): string | number | boolean | undefined {
  return generatedLearningDefaults[id as keyof typeof generatedLearningDefaults];
}

function isOfferStageBackgroundCheck(text: string, employerNames?: readonly string[]): boolean {
  const parts = text.split('|');
  if (parts.length > 2) return false;
  const english = parts[parts.length - 1]!.trim();
  const employer = /^if advanced to an offer of employment with ([^,|\n]{1,80}),/iu.exec(english)?.[1]?.trim();
  if (!employer || !(/^[\p{Lu}\d]{2,10}$/u.test(employer) || employerNames?.some(name => sameEmployer(name, employer)))) return false;
  const name = normalizeCatalogText(employer);
  if (normalizeCatalogText(english) !== `if advanced to an offer of employment with ${name} you consent to respecting the employment verification and background check process`) return false;
  return parts.length === 1 || normalizeCatalogText(parts[0]!) ===
    `si vous recevez une offre d emploi de ${name} vous consentez à respecter le processus de vérification d emploi et de références`;
}

export function resolveQuestion(text: string, employerNames?: readonly string[]) {
  const exact=resolveCatalogText([...questionCatalog,...questionAliasCatalog],text);
  if(exact.kind!=='unknown') return exact;
  if (isOfferStageBackgroundCheck(text, employerNames)) return {kind:'resolved' as const, id:'owner-question-background-check-willing' as const, provenance:'reviewed_catalog' as const};
  const sourceEmployer = /^how did you hear about (.+)$/u.exec(normalizeCatalogText(text))?.[1];
  if (sourceEmployer && employerNames !== undefined &&
      !/^(?:(?:the|this|our) (?:company|organization|job|position|opening|opportunity|role|job posting|job opening)|us)$/u.test(sourceEmployer) &&
      !employerNames.some(name=>sameEmployer(name,sourceEmployer))) {
    return {kind:'unknown' as const};
  }
  if (applicantRefersSomeone(text)) return {kind:'unknown' as const};
  const referral=referralQuestion(text);
  if(referral) return referral.negated?{kind:'unknown' as const}:{kind:'resolved' as const,id:'workday-placeholder-associate-referral' as const,provenance:'reviewed_catalog' as const};
  const employment = employmentQuestion(text);
  if(employment?.negated) return {kind:'unknown' as const};
  if(employment?.qualified) return resolveCatalogKeywords(questionSemanticCatalog,text);
  if (employment) {
    return {kind:'resolved' as const, id:employment.period === 'current'
      ? 'workday-question-current-associate' as const : 'workday-placeholder-prior-employment' as const,
      provenance:'reviewed_catalog' as const};
  }
  if (/\b(?:sex assigned at birth|biological sex|legal sex)\b/iu.test(text)) return {kind:'unknown' as const};
  // A numeric amount, not a yes/no willingness or a travel narrative.
  const value = text.normalize("NFKC").toLowerCase();
  if (/\btravel\b/u.test(value) &&
      /(?:\b(?:what|which)\s+(?:percentage|percent)\b|\bhow much\s*%|\b(?:enter|specify|provide|indicate|mention)\b[^?!.]*\bpercentage\b)/u.test(value) &&
      !/\b(?:describe|explain|why)\b/u.test(value)) {
    return resolveCatalogText(questionAliasCatalog, "Travel percentage");
  }
  const canonical = resolveCatalogText(questionCatalog, text);
  if (canonical.kind !== "unknown") return canonical;
  const alias = resolveCatalogText(questionAliasCatalog, text);
  return alias.kind === "unknown"
    ? resolveCatalogKeywords(
      /\b(?:relative|relatives|family)\b/u.test(value)
        ? questionSemanticCatalog.filter(entry => entry.id !== "workday-question-current-associate")
        : questionSemanticCatalog, text)
    : alias;
}

/** Stable IDs bind wording to profile facts; uncertain suggestions never edit the catalog. */
export function inspectQuestionMatch(text: string, employerNames?: readonly string[]) {
  const resolution = resolveQuestion(text, employerNames);
  const employment = employmentQuestion(text) ?? referralQuestion(text);
  const entries = [...questionCatalog,...questionAliasCatalog];
  const exact = resolveCatalogText(entries,text);
  const question = resolution.kind === 'resolved' ? questionFor(resolution.id) : undefined;
  return {resolution, family:employment?.family ?? (resolution.kind==='resolved'?resolution.id:null),
    context:employment ?? null,
    factId:question?.source?.kind==='profile'?question.source.factId:null,
    factIds:employment?.period==='ever' ? ['current_associate','previously_worked_for_organization'] :
      question?.source?.kind==='profile' ? [question.source.factId] : [],
    method:resolution.kind==='resolved' ? exact.kind==='resolved'?'exact':employment?'pattern':'keywords' : 'unmatched',
    candidates:resolution.kind==='resolved'?[]:rankQuestionCandidates(entries,text),
    provisional:resolution.kind!=='resolved' || employment?.qualified===true && exact.kind!=='resolved'};
}

export function matchingDictionary() {
  return [...questionCatalog,...questionAliasCatalog].map(entry=>({id:entry.id,labels:entry.labels,
    factId:entry.source?.kind==='profile'?entry.source.factId:null,
    controls:'behaviors' in entry?entry.behaviors:[entry.behavior]}));
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
    retained("profile", "employment.previously_worked_for_organization", "Have you previously worked for this organization? If Yes, please answer the questions below. If No, please continue to the next page.", "prior_employment", "radio", "single_select", true, "workday_previous_worker_radio_v1", ["Yes", "No"]),
    retained("profile", "skills.values", "Type to Add Skills", "skill", "search_select", "multi_select", false, "workday_multi_select_v1"),
    retained("profile", "social.linkedin", "LinkedIn", "social_network", "text", "text", false, "workday_text_v2"),
    retained("profile", "social.facebook", "Facebook", "social_network", "text", "text", false, "workday_text_v2"),
    retained("profile", "social.twitter", "Twitter", "social_network", "text", "text", false, "workday_text_v2"),
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

export function retainedIntakeTextSha256(value: string): string {
  return createHash("sha256").update(
    value.normalize("NFC").replace(/[\u2018\u2019\u02bc]/gu, "'")
      .replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US"),
    "utf8",
  ).digest("hex");
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
