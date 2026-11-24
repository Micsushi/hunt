import type {
  FieldObservation,
  OptionId,
  ProfileAnswerResult,
} from "../../contracts/index.ts";
import { normalizeCatalogText } from "../questions/normalize.ts";
import { isRecruitmentTermsConsent } from "../questions/protected.ts";
import { resolveOption } from "./catalog.ts";
import { equivalentAnswer, matchesDegreeLevel } from '../../deterministic/answer-equivalence.ts';

type AnswerValue = Extract<
  ProfileAnswerResult,
  { readonly kind: "answered" }
>["value"];

export type OptionMappingResult =
  | {
      readonly kind: "matched";
      readonly optionId: OptionId;
      readonly expectedOption: FieldObservation["options"][number]["label"];
    }
  | { readonly kind: "option_no_match" }
  | { readonly kind: "option_ambiguous" };

export function consentOption(value: boolean, options: FieldObservation["options"], rawOptions?: readonly string[]) {
  if (rawOptions && rawOptions.length !== options.length) return undefined;
  const choices = options.map((option, index) => ({option, label:rawOptions?.[index] ?? option.label})).filter(({label}) => {
    const text = normalizeCatalogText(label);
    return text && !/^(?:select|choose|please select|select one|choose one|none selected|no (?:items|matches|results)(?: found)?)$/u.test(text);
  });
  const matches = choices.filter(({label}) => {
    const text = normalizeCatalogText(label);
    if (!value) return /^(?:no|n|false|decline|i (?:decline|do not agree))$/u.test(text);
    if (text === "acknowledge confirm") return choices.length === 1;
    return /^(?:yes|y|true|(?:i )?(?:agree|accept|acknowledge))$/u.test(text) ||
      isRecruitmentTermsConsent(label);
  });
  const choice = matches.length === 1 ? matches[0] : undefined;
  return choice && choice.label === choice.option.label ? choice.option : undefined;
}

function optionKey(value: string): string {
  const resolved = resolveOption(value);
  return resolved.kind === "resolved"
    ? resolved.id
    : normalizeCatalogText(value);
}

export function mapVisibleOption(
  value: AnswerValue,
  options: FieldObservation["options"],
  context = '',
): OptionMappingResult {
  const wanted = optionKey(
    typeof value === "boolean" ? (value ? "yes" : "no") : String(value),
  );
  let matches = options.filter(({ label }) => optionKey(label) === wanted);
  if (matches.length === 0 && context && typeof value === 'string') {
    matches = options.filter(({label})=>equivalentAnswer(label,value,context));
    if (!matches.length && context === 'owner-question-education-degree') {
      matches = options.filter(({label}) => matchesDegreeLevel(label.trim().toLowerCase(), value.trim().toLowerCase()));
    }
  }
  // Employers often qualify a binary answer ("Yes, I am over 18").
  // Only accept one matching polarity; multiple qualified answers need more context.
  if (matches.length === 0 && typeof value === "boolean") {
    const polarity = value ? /^yes\s*[,:–-]/iu : /^no\s*[,:–-]/iu;
    matches = options.filter(({ label }) => polarity.test(String(label).trim()));
  }

  if (matches.length === 0) {
    return Object.freeze({ kind: "option_no_match" });
  }
  if (matches.length > 1) {
    return Object.freeze({ kind: "option_ambiguous" });
  }
  const match = matches[0];
  if (match === undefined) {
    return Object.freeze({ kind: "option_no_match" });
  }
  return Object.freeze({
    kind: "matched",
    optionId: match.id,
    expectedOption: match.label,
  });
}
