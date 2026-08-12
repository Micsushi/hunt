import type { BoundedText } from "../../../../contracts/index.ts";
import {
  type CanonicalQuestionId,
} from "../../../../form/questions/catalog.ts";
import { normalizeCatalogText } from "../../../../form/questions/normalize.ts";

export type ProtectedQuestionCategory = "authorization" | "legal" | "consent";

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
    /\b(?:legal|criminal|background check|disclosure|salary|compensation|at least 18|18 years of age|18 years old|18 or older|gender|sex|race|ethnicity|veteran|disability|previously worked|ever worked|ever been employed|prior employment|previous employment)\b/u.test(normalized)
  ) {
    return "legal";
  }
  return null;
}
