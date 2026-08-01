import type {
  FieldObservation,
  OptionId,
  ProfileAnswerResult,
} from "../../contracts/index.ts";
import { normalizeCatalogText } from "../questions/normalize.ts";
import { resolveOption } from "./catalog.ts";

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

function optionKey(value: string): string {
  const resolved = resolveOption(value);
  return resolved.kind === "resolved"
    ? resolved.id
    : normalizeCatalogText(value);
}

export function mapVisibleOption(
  value: AnswerValue,
  options: FieldObservation["options"],
): OptionMappingResult {
  const wanted = optionKey(
    typeof value === "boolean" ? (value ? "yes" : "no") : String(value),
  );
  const matches = options.filter(({ label }) => optionKey(label) === wanted);

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
