import {
  assertCatalogHasNoCollisions,
  resolveCatalogText,
  type ReviewedCatalogEntry,
} from "../questions/normalize.ts";

function entry<I extends string>(id: I, labels: readonly string[]) {
  return Object.freeze({
    id,
    labels: Object.freeze([...labels]),
    provenance: "reviewed_catalog" as const,
  });
}

export const optionCatalog = Object.freeze([
  entry("yes", ["Yes", "Y", "True"]),
  entry("no", ["No", "N", "False"]),
] as const satisfies readonly ReviewedCatalogEntry<string>[]);

assertCatalogHasNoCollisions(optionCatalog);

export function resolveOption(text: string) {
  return resolveCatalogText(optionCatalog, text);
}
