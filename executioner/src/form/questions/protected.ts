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

// Recognize consent to evaluating this application, independently of the owner’s decision.
export function isAiEvaluationConsent(label: string): boolean {
  if (!/\b(?:ai|artificial intelligence|automated)\b/iu.test(label)) return false;
  const technology = '(?:ai|artificial intelligence(?: ai)?|automated)(?: (?:tools?|systems?|screening|evaluation))?';
  const material = '(?:(?:my|your|this|the) )?(?:application(?: materials)?|candidate (?:information|data)|resume|candidacy)';
  const purpose = new RegExp('^(?:(?:by selecting yes )?you consent to|do you (?:consent|agree) to|i (?:agree|consent) to|consent to) (?:the use of |using )?' +
    technology + ' (?:to |for )(?:evaluate|evaluating|assess|assessing|screen|screening|review|reviewing) ' + material + '$', 'u');
  const short = new RegExp('^(?:(?:i |do you )?(?:consent|agree) to )?' + technology +
    ' (?:evaluation|screening|assessment) (?:consent|of ' + material + ')$', 'u');
  const information = [
    /^to support an efficient recruitment process [\p{L}\d]+(?: [\p{L}\d]+){0,3} may use artificial intelligence ai tools to assess how your candidate information aligns with the role requirements$/u,
    /^these tools do not make decisions about a candidate s status every decision that leads [\p{L}\d]+(?: [\p{L}\d]+){0,3} to select a candidate for this role involves human review or intervention$/u,
    /^you have the right to choose whether your data is processed using ai tools$/u,
    /^by selecting no you decline consent$/u,
    /^your application will be manually reviewed by [\p{L}\d]+(?: [\p{L}\d]+){0,3} recruiters in accordance with [\p{L}\d]+(?: [\p{L}\d]+){0,3} policy$/u,
    /^for more information about how [\p{L}\d]+(?: [\p{L}\d]+){0,3} processes your personal data please review the candidate privacy notice$/u,
  ];
  const statements = label.split(/[.!?:;\n]+/u).map(normalizeCatalogText).filter(Boolean);
  let affirmative = false;
  for (const statement of statements) {
    if (purpose.test(statement) || short.test(statement)) affirmative = true;
    else if (!information.some(rule => rule.test(statement))) return false;
  }
  return affirmative;
}

export function isAiConsentControl(behavior: string, options: readonly string[]): boolean {
  if (behavior === 'checkbox') return options.every(option => /^(?:yes|(?:i )?(?:accept|agree))$/u.test(normalizeCatalogText(option)));
  return ['radio','select','listbox'].includes(behavior) && options.every(option =>
    /^(?:|please select|select(?: one)?|choose(?: one)?|yes|no|(?:i )?(?:agree|accept|decline|disagree))$/u.test(normalizeCatalogText(option)));
}

export const contractApprovedPrivacyChoices = Object.freeze([
  "Prefer not to answer",
  "Prefer not to say",
  "I prefer not to say",
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

/** A referral decision says nothing about who the applicant knows at the employer. */
export function isEmployeeRelationshipDetail(label: string): boolean {
  const text = normalizeCatalogText(label);
  const employee = /\b(?:employees?|associates?|staff|someone who works)\b/u.test(text);
  if (!employee) return false;
  return /\b(?:your|the) relationship (?:to|with)\b/u.test(text) ||
    /\b(?:name|email|contact details)\b/u.test(text) && /\b(?:referred|referrer|referral|recommended)\b/u.test(text);
}

export function protectedQuestionCategory(
  label: string,
  question: CanonicalQuestionId | undefined,
  options: readonly string[] = [],
): ProtectedQuestionCategory | null {
  const normalized = normalizeCatalogText(label);
  if (isAiEvaluationConsent(label) || /\b(?:application|applicant|recruitment|account) terms\b/u.test(normalized)) return "consent";
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
  const applicantMaterial = /\b(?:statements?|answers?|responses?|information|details)\b|\bapplication (?:is|was)\b|\b(?:is|was) (?:my|your|this|the) application\b/u;
  const suppliedByApplicant = /\b(?:my|your|this|the) application\b|\b(?:i|you) (?:have )?(?:provided|supplied|entered|given)\b|\b(?:provided|given|entered) (?:above|here|in this form)\b|\b(?:statements?|answers?|responses?|information|details) (?:given|provided|entered|supplied|above|herein)\b/u;
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
