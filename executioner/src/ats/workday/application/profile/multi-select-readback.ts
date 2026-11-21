import { inspectChoiceWidget, type ChoiceReadback } from "../../../../../extension/shared-choice-widget.js";
import type { Locator } from "playwright";

export interface MultiSelectReadbackOwnershipDiagnostics {
  readonly selectedItemCount: number;
  readonly productionOwnerCount: number;
  readonly productionOwnedSelectedItemCount: number;
  readonly unownedSelectedItemCount: number;
  readonly canonicalItemCount: number;
  readonly fallbackItemCount: number;
  readonly chosenItemCount: number;
  readonly chosenUniqueCount: number;
  readonly usedProductionOwners: boolean;
}

export async function committedMultiSelectReadback(
  locator: Locator,
  trace?: (event: string, details?: object) => void,
): Promise<string | null> {
  const field = locator.locator(
    'xpath=ancestor::*[@data-automation-id="formField" or starts-with(@data-automation-id,"formField-")][1]',
  );
  if (await field.count() !== 1) return null;

  const observed = await field.evaluate<ChoiceReadback, "readback">(inspectChoiceWidget, "readback");

  try {
    trace?.("profile_multi_select_readback_ownership", observed.diagnostics);
  } catch {
    // Diagnostics never alter committed readback behavior.
  }

  if (observed.labels.length === 0) return null;
  return observed.labels.length === 1 ? observed.labels[0]! : JSON.stringify(observed.labels);
}
