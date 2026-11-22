import {
  type CanonicalQuestionId,
} from "./catalog.ts";
import { normalizeCatalogText } from "./normalize.ts";

export type ProtectedQuestionCategory = "authorization" | "legal" | "consent";

// Parse the whole declaration. A privacy keyword inside a second, unrelated
// attestation cannot authorize that attestation.
export function isRecruitmentTermsConsent(label: string, requiredEmployerNames: readonly string[] = []): boolean {
  // A named privacy notice applies only to the employer on the required field.
  const named = /^you declare that you have read and (?:agree to|understand) the privacy notice of (.+)$/u.exec(normalizeCatalogText(label));
  if (named) {
    const companyKey = (name: string) => normalizeCatalogText(name).replace(/\bltée\b/gu, 'lte').replace(/\s+/gu, '');
    return requiredEmployerNames.some(name => companyKey(name) === companyKey(named[1]!));
  }
  const notices = label.split(/[.!?;\n]+/u).map(normalizeCatalogText).filter(Boolean);
  let requestsConsent = false;
  for (const notice of notices) {
    // Some employers explain that declining prevents the application proceeding.
    // Accept only that consequence, never an arbitrary trailing declaration.
    if (/^if you do not (?:agree|consent)(?: to (?:the |this |our )?(?:privacy (?:notice|policy)|terms(?: and conditions)?))? (?:please do not (?:apply|proceed|continue|submit (?:your|this) application)|(?:we (?:cannot|will not)|we (?:won t|can t)|we (?:will )?not be able to) (?:consider|process|accept) your application|you (?:cannot|will not be able to) (?:apply|continue|proceed)|your application (?:cannot|will not) (?:proceed|be (?:considered|processed|accepted)))$/u.test(notice)) continue;
    // A notice may describe the employer's own limited use of applicant data.
    if (/^(?:(?:we|our service providers|we and our service providers) (?:may |will )?(?:process|use|collect|retain|store) your (?:application|personal) (?:data|information)|your (?:application|personal) (?:data|information) (?:may|will) be (?:processed|used|collected|retained|stored)) (?:for recruitment purposes|to (?:assess|review|process) your application|for (?:up to )?(?:one|two|[1-9][0-9]?) (?:months?|years?)(?: for recruitment purposes)?)$/u.test(notice)) continue;
    const objects = notice
      .replace(/^(?:please )?(?:confirm|acknowledge) (?:that )?/u, "")
      .replace(/^(?:(?:yes )?(?:you|i|we) )?(?:have )?(?:read (?:and understood )?and )?(?:accept|agree to|consent to|acknowledge|read(?: and understood)?) /u, "")
      .replace(/\bterms and conditions\b/gu, "terms conditions");
    if (!objects.split(" and ").every(object =>
      /^(?:(?:the|our|your|this) )?(?:[\p{L}\p{N}]+ (?:s |(?:corp|inc|llc|ltd|corporation|limited)(?: s)? ))?(?:(?:recruitment|applicant|candidate|application|account|data) )?(?:privacy (?:notice|policy|statement)|terms(?: conditions| of (?:use|service))?|(?:processing|collection|use) of (?:my |your )?personal data(?: for recruitment purposes)?)$/u.test(object))) return false;
    requestsConsent = true;
  }
  return requestsConsent;
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
  options: readonly string[] = [],
): ProtectedQuestionCategory | null {
  const normalized = normalizeCatalogText(label);
  if (options.some(option => /\b(?:i (?:hereby )?(?:agree|consent|acknowledge|confirm|attest|certify)|acknowledge confirm)\b/u.test(normalizeCatalogText(option)))) return "consent";
  if (/\b(?:i|we) (?:hereby )?(?:confirm|certify|declare|attest|pledge)\b|\b(?:please )?(?:confirm|certify|attest) that\b|\b(?:consent|acknowledge|signature|privacy (?:notice|policy|statement)|terms (?:(?:and )?conditions|of (?:use|service)))\b|\b(?:(?:i|we) (?:hereby )?agree|agree to)\b|^agree$|^terms$|\b(?:accept|read) (?:the )?terms\b|\bi have (?:received )?read and (?:understood|understand)\b/u.test(normalized)) {
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

/** Includes declarations phrased as statements, without an explicit "I certify". */
export function isApplicationAccuracyDeclaration(label: string): boolean {
  const text = normalizeCatalogText(label);
  const applicantMaterial = /\b(?:statements?|answers?|information|details)\b|\bapplication (?:is|was)\b|\b(?:is|was) (?:my|your|this|the) application\b/u;
  const suppliedByApplicant = /\b(?:my|your|this|the) application\b|\b(?:i|you) (?:have )?(?:provided|supplied|entered|given)\b|\b(?:provided|given|entered) (?:above|here|in this form)\b/u;
  // Questions and declarations can put the verb on either side of the subject.
  return applicantMaterial.test(text) && suppliedByApplicant.test(text) &&
    /\b(?:true|accurate|correct|complete|truthful)\b/u.test(text) &&
    /\b(?:is|are|was|were|be|confirm|certify|attest|declare|affirm)\b/u.test(text);
}

/** Whether the employer is asking for the applicant's actual conviction or pardon history. */
export function isCriminalConvictionDisclosure(label: string): boolean {
  const question = normalizeCatalogText(label).normalize('NFD').replace(/\p{M}/gu, '');
  // Omit the subject of a screening check, keeping any separate disclosure in the question.
  const disclosure = question
    .replace(/\bcriminal (?:record|history|background|conviction) (?:background )?(?:checks?|screenings?|search(?:es)?)\b/gu, '')
    .replace(/\b(?:check|review|verification|search) (?:of |de |du |des )?(?:your |votre |vos )?(?:criminal (?:record|history)|casier judiciaire|antecedents judiciaires)\b/gu, '');
  const outcome = /\b(?:convicted|found guilty|ple(?:d|ad(?:ed)?) (?:guilty|no contest|nolo contendere)|guilty plea|pardoned|record suspension)\b/u;
  const history = /\b(?:criminal (?:record|history|convictions?)|(?:any|prior|past|previous|unpardoned|felony|misdemeanou?r) convictions?|felon(?:y|ies)|misdemeanou?rs?|pardons?)\b/u;
  const french = /\b(?:casier judiciaire|antecedents judiciaires|condamnations? (?:criminelles?|penales?)|condamnee?|reconnue? coupable|plaidee? (?:non )?coupable|suspension du casier)\b/u;
  return outcome.test(disclosure) || history.test(disclosure) || french.test(disclosure);
}
