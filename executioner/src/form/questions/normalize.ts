export interface ReviewedCatalogEntry<I extends string> {
  readonly id: I;
  readonly labels: readonly string[];
  readonly provenance: "reviewed_catalog";
}

export type CatalogResolution<I extends string> =
  | {
      readonly kind: "resolved";
      readonly id: I;
      readonly provenance: "reviewed_catalog";
    }
  | { readonly kind: "unknown" }
  | { readonly kind: "ambiguous"; readonly ids: readonly I[] };

export function normalizeCatalogText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s*\(required\)(?:\s*[\p{P}\p{S}])*\s*$/u, "")
    .replace(/(?<!\bnot)\s+required(?:\s*\*)?\s*$/u, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function resolveCatalogText<I extends string>(
  entries: readonly ReviewedCatalogEntry<I>[],
  text: string,
): CatalogResolution<I> {
  const normalized = normalizeCatalogText(text);
  const ids = Object.freeze([
    ...new Set(
      entries
        .filter(({ labels }) =>
          labels.some((label) => normalizeCatalogText(label) === normalized),
        )
        .map(({ id }) => id),
    ),
  ]);

  if (ids.length === 0) return Object.freeze({ kind: "unknown" });
  if (ids.length > 1) {
    return Object.freeze({ kind: "ambiguous", ids });
  }
  return Object.freeze({
    kind: "resolved",
    id: ids[0] as I,
    provenance: "reviewed_catalog",
  });
}

const questionBoilerplate = new Set([
  "a", "an", "and", "answer", "are", "choose", "did", "do", "does", "enter",
  "for", "from", "have", "has", "i", "in", "indicate", "is", "of", "on",
  "or", "please", "provide", "question", "s", "select", "tell", "the", "this",
  "to", "us", "what", "which", "will", "you", "your",
]);

export function normalizedQuestionKeywords(text: string): ReadonlySet<string> {
  return new Set(
    normalizeCatalogText(text).split(" ").filter((token) =>
      token.length > 0 && !questionBoilerplate.has(token)
    ),
  );
}

export function resolveCatalogKeywords<I extends string>(
  entries: readonly {
    readonly id: I;
    readonly keywordGroups: readonly (readonly string[])[];
  }[],
  text: string,
): CatalogResolution<I> {
  const keywords = normalizedQuestionKeywords(text);
  const ids = Object.freeze([
    ...new Set(entries.filter(({ keywordGroups }) =>
      keywordGroups.some((group) =>
        group.length > 0 && group.every((keyword) => keywords.has(keyword))
      )
    ).map(({ id }) => id)),
  ]);
  if (ids.length === 0) return Object.freeze({ kind: "unknown" });
  if (ids.length > 1) return Object.freeze({ kind: "ambiguous", ids });
  return Object.freeze({
    kind: "resolved",
    id: ids[0] as I,
    provenance: "reviewed_catalog",
  });
}

export function assertCatalogHasNoCollisions<I extends string>(
  entries: readonly ReviewedCatalogEntry<I>[],
): void {
  const owners = new Map<string, I>();
  for (const { id, labels } of entries) {
    for (const label of labels) {
      const normalized = normalizeCatalogText(label);
      const owner = owners.get(normalized);
      if (owner !== undefined && owner !== id) {
        throw new TypeError(
          `catalog alias collision for "${normalized}": ${owner}, ${id}`,
        );
      }
      owners.set(normalized, id);
    }
  }
}
