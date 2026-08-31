import type { Locator } from "playwright";

export async function committedMultiSelectReadback(
  locator: Locator,
): Promise<string | null> {
  const field = locator.locator(
    'xpath=ancestor::*[@data-automation-id="formField" or starts-with(@data-automation-id,"formField-")][1]',
  );
  if (await field.count() !== 1) return null;

  const committed = await field.evaluate((owner) => {
    const fieldSelector = '[data-automation-id="formField"], [data-automation-id^="formField-"]';
    const normalize = (value: string | null | undefined) => (value ?? "")
      .normalize("NFC").replace(/\s+/gu, " ").trim();
    const labels = [...owner.querySelectorAll('[data-automation-id="selectedItem"]')]
      .filter((item) => item.closest(fieldSelector) === owner)
      .map((item) => normalize(
        item.querySelector('[data-automation-id="promptOption"]')?.textContent ??
          item.textContent,
      ))
      .filter(Boolean);

    // Workday can remount one semantic selection into both a collapsed list
    // and a visible token. Multi-select options are set members, so retain one
    // exact structural label for each normalized option instead of counting UI
    // mirrors as duplicate selections.
    const unique = new Map<string, string>();
    for (const label of labels) {
      const key = label.toLocaleLowerCase("en-US");
      if (!unique.has(key)) unique.set(key, label);
    }
    return [...unique.values()];
  });

  if (committed.length === 0) return null;
  return committed.length === 1 ? committed[0]! : JSON.stringify(committed);
}
