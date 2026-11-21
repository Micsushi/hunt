import {
  type CanonicalQuestionId,
} from "./catalog.ts";
import { normalizeCatalogText } from "./normalize.ts";

export type ProtectedQuestionCategory = "authorization" | "legal" | "consent";

export function isRecruitmentTermsConsent(label: string): boolean {
  const text = normalizeCatalogText(label);
  // The owner's recruitment/privacy decision does not cover the opposite statement
  // or another declaration bundled beside a privacy notice. Conditional notice text
  // ("If you do not consent...") is not itself a negated applicant declaration.
  if (/\b(?:certify|certification|accurate|accuracy|truthful|signature|sign here|background check|marketing|promotional|advertising|newsletter)\b/u.test(text) ||
      /\b(?:i|we) (?:(?:do not|don t|will not|won t|cannot|can t|never) (?:agree|accept|consent|acknowledge)|decline|refuse|reject|disagree)\b/u.test(text) ||
      /^(?:(?:do not|don t|not) (?:agree|accept|consent|acknowledge)|decline|refuse|reject|disagree)\b/u.test(text) ||
      /\bdo you not (?:agree|accept|consent|acknowledge)\b/u.test(text)) return false;
  // Reject an additional requested action, not ordinary processing/retention
  // described by a recruitment notice (including use of service providers).
  if (/\b(?:i|we) (?:am|are|have|meet|can)\b.{0,100}\b(?:authori[sz]ed|eligible|qualifications|years of age|criminal|employed|worked)\b/u.test(text) ||
      /\b(?:arbitration|class action waiver|waiv(?:e|ing) (?:my |your |our )?(?:legal )?rights)\b/u.test(text) ||
      /\b(?:agree|consent|authori[sz]e|request|opt in|subscribe|sign up|join)\b.{0,180}\b(?:sms|texts|texting|text messages?|(?:by|via) text|talent (?:community|pool|network)|future (?:job |career )?(?:roles|opportunities|openings|positions))\b/u.test(text) ||
      /\b(?:agree|consent|authori[sz]e)\b.{0,100}\b(?:sell|sale|commercial sharing)\b.{0,100}\b(?:information|data|third parties|partners)\b/u.test(text) ||
      /\b(?:agree|consent|authori[sz]e)\b.{0,80}\b(?:share|sharing|disclose|disclosure|transfer)\b.{0,100}\bthird parties\b.{0,80}\b(?:own|independent|unrelated|commercial)\b/u.test(text) ||
      /\b(?:agree|consent|authori[sz]e)\b.{0,80}\b(?:retain|store|keep)\b.{0,80}\bindefinitely\b/u.test(text)) return false;
  return /\b(?:privacy|terms (?:and conditions|conditions|of use|of service)|consent to (?:the )?(?:use|processing|collection) of (?:my |your )?personal data)\b/u.test(text) ||
    /^(?:(?:i |yes i )?(?:have )?(?:read|accept|agree to|consent to)(?: and consent to)? (?:the )?)?terms$/u.test(text);
}

export const contractApprovedPrivacyChoices = Object.freeze([
  "Prefer not to answer",
  "Prefer not to say",
  "I do not wish to provide this information",
  "I do not want to answer",
  "Decline to self-identify",
] as const);

export function protectedAnswerProvenanceAllowed(provenance: string): boolean {
  return provenance === "owner_provided";
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
  label: string,
  question: CanonicalQuestionId | undefined,
): ProtectedQuestionCategory | null {
  const normalized = normalizeCatalogText(label);
  if (/\b(?:consent|acknowledge|signature|privacy (?:notice|policy)|terms (?:(?:and )?conditions|of (?:use|service)))\b|\b(?:(?:i|we) (?:hereby )?agree|agree to)\b|^agree$|^terms$|\b(?:accept|read) (?:the )?terms\b|\bi have (?:received )?read and (?:understood|understand)\b/u.test(normalized)) {
    return "consent";
  }
  if (question !== undefined && authorizationQuestionIds.has(question)) {
    return "authorization";
  }
  if (question !== undefined && legalQuestionIds.has(question)) return "legal";
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
