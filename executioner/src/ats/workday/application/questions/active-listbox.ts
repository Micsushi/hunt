const opaqueIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface ActiveListboxEvidence {
  readonly control: {
    readonly controlId: string;
    readonly expanded: boolean;
    readonly relatedListboxIds: readonly string[];
  };
  readonly candidates: readonly {
    readonly listboxId: string;
    readonly visible: boolean;
    readonly active: boolean;
    readonly selectedItemList: boolean;
  }[];
}

export type ActiveListboxResolution =
  | { readonly kind: "resolved"; readonly listboxId: string }
  | { readonly kind: "unavailable" | "ambiguous" };

export function resolveActiveListbox(
  evidence: ActiveListboxEvidence,
): ActiveListboxResolution {
  if (
    !evidence.control.expanded ||
    !opaqueIdentifier.test(evidence.control.controlId) ||
    evidence.control.relatedListboxIds.length === 0 ||
    evidence.control.relatedListboxIds.length > 64 ||
    evidence.candidates.length > 64 ||
    evidence.control.relatedListboxIds.some((id) => !opaqueIdentifier.test(id)) ||
    evidence.candidates.some(({ listboxId }) => !opaqueIdentifier.test(listboxId))
  ) return Object.freeze({ kind: "unavailable" });

  const related = new Set(evidence.control.relatedListboxIds);
  const matches = evidence.candidates.filter((candidate) =>
    candidate.visible &&
    candidate.active &&
    !candidate.selectedItemList &&
    related.has(candidate.listboxId)
  );
  if (matches.length === 0) return Object.freeze({ kind: "unavailable" });
  if (matches.length > 1) return Object.freeze({ kind: "ambiguous" });
  return Object.freeze({
    kind: "resolved",
    listboxId: matches[0]!.listboxId,
  });
}
