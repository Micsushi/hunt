export interface ChoiceReadback {
  labels: string[];
  diagnostics: {
    selectedItemCount: number;
    productionOwnerCount: number;
    productionOwnedSelectedItemCount: number;
    unownedSelectedItemCount: number;
    canonicalItemCount: number;
    fallbackItemCount: number;
    chosenItemCount: number;
    chosenUniqueCount: number;
    usedProductionOwners: boolean;
  };
}
export interface ChoiceWidget {
  kind: "owned_search_choice";
  valid: boolean;
  reason: string | null;
  input: HTMLInputElement;
  owner: Element | null;
  widget: Element | null;
  widgetId: string;
  root: Node;
  region: Node;
  query: string;
  labels: string[];
  pills: {node: Element; label: string; remove: Element | null}[];
  popup: Element | null;
  popupStatus: "closed" | "ready" | "busy";
  options: {node: Element; label: string; disabled: boolean}[];
  empty: boolean;
  multiple: boolean | null;
  diagnostics: ChoiceReadback["diagnostics"] | null;
}
export function inspectChoiceWidget(element: Element): ChoiceWidget | null;
export function inspectChoiceWidget(element: Element, mode: "readback"): ChoiceReadback;
