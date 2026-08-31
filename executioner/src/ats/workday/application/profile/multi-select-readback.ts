import type { Locator } from "playwright";

export async function committedMultiSelectReadback(
  locator: Locator,
): Promise<string | null> {
  const field = locator.locator(
    'xpath=ancestor::*[@data-automation-id="formField" or starts-with(@data-automation-id,"formField-")][1]',
  );
  if (await field.count() !== 1) return null;

  const observed = await field.evaluate((owner) => {
    const fieldSelector = '[data-automation-id="formField"], [data-automation-id^="formField-"]';
    const itemOwnerSelector = [
      '[data-uxi-widget-type="selectinputlistitem"]',
      '[data-uxi-multiselect-id]',
      '[data-uxi-selectinputlistitem-index]',
    ].join("");
    const normalize = (value: string | null | undefined) => (value ?? "")
      .normalize("NFC").replace(/\s+/gu, " ").trim();
    const readItem = (item: Element) => {
      const promptOptions = item.querySelectorAll('[data-automation-id="promptOption"]');
      if (promptOptions.length > 1) {
        throw new TypeError("Workday selected item has ambiguous semantic text");
      }
      const semantic = promptOptions[0] ?? item;
      const copy = semantic.cloneNode(true) as Element;
      copy.querySelectorAll('[data-automation-id="DELETE_charm"]')
        .forEach((affordance) => affordance.remove());
      return { canonical: promptOptions.length === 1, label: normalize(copy.textContent) };
    };
    const productionOwners = [...owner.querySelectorAll(itemOwnerSelector)]
      .filter((itemOwner) => itemOwner.closest(fieldSelector) === owner);
    const fieldSelectedItems = [...owner.querySelectorAll(
      '[data-automation-id="selectedItem"]',
    )].filter((item) => item.closest(fieldSelector) === owner);
    const ownerIds = new Set(productionOwners.map((itemOwner) =>
      itemOwner.getAttribute("data-uxi-multiselect-id")
    ));
    const ownerIndexes = productionOwners.map((itemOwner) =>
      itemOwner.getAttribute("data-uxi-selectinputlistitem-index")
    );
    if (productionOwners.length > 0 &&
        (ownerIds.size !== 1 || new Set(ownerIndexes).size !== ownerIndexes.length)) {
      throw new TypeError("Workday selected-item ownership is ambiguous");
    }
    const items = (productionOwners.length > 0
      ? productionOwners.map((itemOwner) => {
        const selectedItems = [...itemOwner.querySelectorAll(
          '[data-automation-id="selectedItem"]',
        )].filter((item) => item.closest(itemOwnerSelector) === itemOwner);
        if (selectedItems.length !== 1) {
          throw new TypeError("Workday selected-item owner is incomplete or ambiguous");
        }
        return readItem(selectedItems[0]!);
      })
      : fieldSelectedItems.map(readItem))
      .filter(({ label }) => label !== "");

    // Production Workday pills expose their semantic text as promptOption.
    // Collapsed and visible presentation mirrors can coexist as selectedItem
    // nodes without that child, so never mix their aggregate text into a
    // canonical prompt-backed selection set.
    const canonical = items.filter((item) => item.canonical);
    const labels = (canonical.length > 0 ? canonical : items).map(({ label }) => label);

    // Workday can remount one semantic selection into both a collapsed list
    // and a visible token. Multi-select options are set members, so retain one
    // exact structural label for each normalized option instead of counting UI
    // mirrors as duplicate selections.
    const unique = new Map<string, string>();
    for (const label of labels) {
      const key = label.toLocaleLowerCase("en-US");
      if (!unique.has(key)) unique.set(key, label);
    }
    const productionOwnerSet = new Set(productionOwners);
    const productionOwnedSelectedItemCount = fieldSelectedItems.filter((item) => {
      const itemOwner = item.closest(itemOwnerSelector);
      return itemOwner !== null && productionOwnerSet.has(itemOwner);
    }).length;
    return {
      labels: [...unique.values()],
      diagnostics: {
        selectedItemCount: fieldSelectedItems.length,
        productionOwnerCount: productionOwners.length,
        productionOwnedSelectedItemCount,
        unownedSelectedItemCount: fieldSelectedItems.length - productionOwnedSelectedItemCount,
        canonicalItemCount: items.filter((item) => item.canonical).length,
        fallbackItemCount: items.filter((item) => !item.canonical).length,
        chosenItemCount: labels.length,
        chosenUniqueCount: unique.size,
        usedProductionOwners: productionOwners.length > 0,
      },
    };
  });

  if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
    process.stderr.write(`${JSON.stringify({
      multiSelectReadbackOwnership: observed.diagnostics,
    })}\n`);
  }

  if (observed.labels.length === 0) return null;
  return observed.labels.length === 1 ? observed.labels[0]! : JSON.stringify(observed.labels);
}
