const normalized = (value: string): string => value.normalize("NFKC")
  .toLocaleLowerCase("en-US")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim();

export type TestingQuestionSemanticType =
  | "qualification_requirement"
  | "employee_referral"
  | "prior_employment"
  | "sponsorship_requirement"
  | "demographic"
  | "compensation"
  | "authorization"
  | "consent"
  | "availability"
  | "identity"
  | "employment"
  | "unknown";

export function testingQuestionSemanticType(label: string): TestingQuestionSemanticType {
  const value = normalized(label);
  if (/\b(?:referred|referral)\b.*\b(?:associate|employee)\b/u.test(value)) {
    return "employee_referral";
  }
  if (
    /\b(?:previously|ever|prior|formerly)\b.*\b(?:worked|employed|employment)\b/u.test(value) ||
    /\bprevious employment\b/u.test(value)
  ) return "prior_employment";
  if (/\b(?:sponsor|sponsorship|visa)\b/u.test(value)) return "sponsorship_requirement";
  if (
    /\b(?:meet|satisfy)\b.*\b(?:qualification|qualifications|requirement|requirements)\b/u.test(value) ||
    /\b(?:can|able|ability|physically)\b.*\bperform\b.*\bessential functions?\b/u.test(value) ||
    /\bat least 18 years?\b/u.test(value) ||
    /\b18 years? of age\b.*\b(?:older|minimum|requirement)\b/u.test(value) ||
    /\b(?:have|possess)\b.*\b(?:required|minimum)\b.*\b(?:experience|education|license|licenses|certification|certifications|skill|skills)\b/u.test(value)
  ) return "qualification_requirement";
  if (/\b(?:gender|sex|race|ethnicity|hispanic|latino|veteran|military|disability|disabled)\b/u.test(value)) {
    return "demographic";
  }
  if (/\b(?:salary|compensation|pay)\b/u.test(value)) return "compensation";
  if (/\b(?:authorized|authorised)\b.*\bwork\b/u.test(value)) return "authorization";
  if (/\b(?:consent|agree|acknowledge)\b/u.test(value)) return "consent";
  if (/\b(?:start date|available to start|availability)\b/u.test(value)) return "availability";
  if (/\b(?:name|language)\b/u.test(value)) return "identity";
  if (/\b(?:employed|employment|associate|relative|relatives)\b/u.test(value)) return "employment";
  return "unknown";
}

export function semanticSyntheticTestDefault(label: string): boolean | undefined {
  const type = testingQuestionSemanticType(label);
  if (type === "qualification_requirement") return true;
  if (type === "employee_referral" || type === "prior_employment") return false;
  return undefined;
}
