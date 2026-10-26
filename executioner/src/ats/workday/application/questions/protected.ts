import type { BoundedText } from "../../../../contracts/index.ts";
import {
  type CanonicalQuestionId,
} from "../../../../form/questions/catalog.ts";
import { normalizeCatalogText } from "../../../../form/questions/normalize.ts";

export type ProtectedQuestionCategory = "authorization" | "legal" | "consent";

export const contractApprovedPrivacyChoices = Object.freeze([
  "Prefer not to answer",
  "Prefer not to say",
  "I do not wish to provide this information",
  "I do not want to answer",
  "Decline to self-identify",
] as const);

export function protectedAnswerProvenanceAllowed(
  provenance: string,
  _contractApprovedTruth = false,
): boolean {
  return provenance === "owner_provided";
}

export function isContractApprovedPrivacyChoice(value: string): boolean {
  const normalized = normalizeCatalogText(value);
  return contractApprovedPrivacyChoices.some((candidate) =>
    normalizeCatalogText(candidate) === normalized
  );
}

const authorizationQuestionIds = new Set<CanonicalQuestionId>([
  "s1-question-work-authorization",
  "s1-question-sponsorship-required",
]);

const legalQuestionIds = new Set<CanonicalQuestionId>([
  "s1-question-age-requirement-met",
  "s1-question-earliest-start-date",
  "workday-question-highest-education",
  "workday-question-years-experience",
  "workday-question-desired-salary",
  "workday-question-gender-disclosure",
  "workday-question-ethnicity-disclosure",
  "workday-question-veteran-disclosure",
  "workday-question-disability-disclosure",
  "workday-placeholder-prior-employment",
  "workday-placeholder-relative-employment",
  "workday-placeholder-associate-referral",
  "workday-question-current-associate",
  "workday-question-previously-applied",
  "workday-question-essential-functions",
  "workday-question-employment-agreement",
]);

export function protectedQuestionCategory(
  label: BoundedText,
  question: CanonicalQuestionId | undefined,
): ProtectedQuestionCategory | null {
  if (question !== undefined && authorizationQuestionIds.has(question)) {
    return "authorization";
  }
  if (question !== undefined && legalQuestionIds.has(question)) return "legal";
  const normalized = normalizeCatalogText(label);
  if (/\b(?:consent|agree|acknowledge|terms|signature)\b/u.test(normalized)) {
    return "consent";
  }
  if (/\b(?:authori[sz](?:e|ed|ation)?|sponsor|visa|work permit)\b/u.test(normalized)) {
    return "authorization";
  }
  if (
    /\b(?:legal|criminal|background check|disclosure|salary|compensation|availability|start date|earliest start|at least 18|18 years of age|18 years old|18 or older|gender|sex|race|ethnicity|veteran|disability|previously worked|ever worked|ever been employed|prior employment|previous employment)\b/u.test(normalized) ||
    /\b(?:referred|referral)\b.*\b(?:associate|employee)\b/u.test(normalized) ||
    /\bcurrent(?:ly)?\b.*\b(?:associate|employee)\b/u.test(normalized) ||
    /\b(?:relative|relatives|family member|family members)\b.*\b(?:employ|employed|works|working)\b/u.test(normalized) ||
    /\b(?:physically able|physical ability|able to perform)\b.*\bessential functions?\b/u.test(normalized) ||
    /\b(?:nda|non compete|noncompete|non competition|confidentiality|company agreement)\b/u.test(normalized)
  ) {
    return "legal";
  }
  return null;
}
