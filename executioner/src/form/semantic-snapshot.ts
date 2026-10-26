import type {
  FieldObservation,
  PageIdentity,
  SemanticPageSnapshot,
} from "../contracts/index.ts";

export function createSemanticSnapshot(
  pageIdentity: PageIdentity,
  fields: readonly FieldObservation[],
): SemanticPageSnapshot {
  const immutableFields = fields.map((field) => Object.freeze({
    ...field,
    options: Object.freeze(field.options.map((option) => Object.freeze({ ...option }))),
  })).sort((left, right) =>
    left.fieldId < right.fieldId ? -1 : left.fieldId > right.fieldId ? 1 : 0
  );
  return Object.freeze({
    pageIdentity: Object.freeze({ ...pageIdentity }),
    fields: Object.freeze(immutableFields),
  });
}
