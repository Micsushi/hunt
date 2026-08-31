import type { ProfileFieldPlan, ProfilePageSnapshot } from "./types.ts";

const MAX_EXACT_SKILL_SELECTIONS = 8;

export function boundedOptionalSkillFacts(
  field: ProfileFieldPlan,
  snapshot: ProfilePageSnapshot,
): ProfileFieldPlan {
  if (
    field.fieldId !== "skills.values" ||
    field.answerType !== "multi_select" ||
    field.answer.kind !== "answered" ||
    snapshot.controls.find(({ fieldId }) => fieldId === field.fieldId)?.required !== false
  ) return field;
  const values = exactStringList(field.answer.value);
  if (values === undefined || values.length <= MAX_EXACT_SKILL_SELECTIONS) return field;
  const value = JSON.stringify([values[0]!]);
  return Object.freeze({
    ...field,
    allowedOptions: Object.freeze([value]),
    answer: Object.freeze({
      ...field.answer,
      value,
      provenance: "journey_derived" as const,
    }),
    optionMapping: Object.freeze({
      canonicalValue: value,
      visibleOption: value,
      provenance: "visible_option" as const,
    }),
  });
}

function exactStringList(value: string): readonly string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 &&
        parsed.every((item) => typeof item === "string" && item.trim() !== "") &&
        new Set(parsed.map((item) => item.normalize("NFKC").trim().toLocaleLowerCase("en-US"))).size ===
          parsed.length
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
