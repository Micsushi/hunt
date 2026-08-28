import { uiBehaviorIds, type UiBehaviorId } from "../contracts/types.ts";

export const supportedControlSelector = [
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[role="combobox"]',
  '[role="radiogroup"]',
  '[role="checkbox"]',
  '[role="listbox"][aria-multiselectable="true"]',
  'button[aria-haspopup="listbox"]',
].join(", ");

export function isSupportedUiBehavior(value: unknown): value is UiBehaviorId {
  return typeof value === "string" && (uiBehaviorIds as readonly string[]).includes(value);
}

export function isSupportedProfileUiBehavior(value: unknown): boolean {
  return isSupportedUiBehavior(value) || [
    "file", "phone", "month", "year", "number", "url", "multi_select",
    "search_select", "radio_group",
  ].includes(String(value));
}

export const checkboxGroupKindAttribute = "data-hunt-checkbox-group-kind";
export type CheckboxGroupKind = "independent" | "exclusive" | "multiple";

export interface CheckboxGroupEvidence {
  readonly checkboxCount: number;
  readonly nativeGroup: boolean;
  readonly role: string;
  readonly ariaMultiselectable: boolean;
  readonly explicitMode: "exclusive" | "multiple" | null;
  readonly distinctNames: number;
  readonly normalizedText: string;
}

export function classifyCheckboxGroup(evidence: CheckboxGroupEvidence): CheckboxGroupKind {
  if (!Number.isSafeInteger(evidence.checkboxCount) || evidence.checkboxCount < 2) {
    return "independent";
  }
  if (evidence.explicitMode !== null) return evidence.explicitMode;
  if (evidence.ariaMultiselectable ||
      /select (?:all|any)|all that apply|choose (?:all|any)|multiple selections?/iu.test(
        evidence.normalizedText,
      )) return "multiple";
  if (evidence.role === "radiogroup" ||
      /select one|choose one|check one|one of (?:the )?(?:boxes|options)/iu.test(
        evidence.normalizedText,
      )) return "exclusive";
  if (evidence.nativeGroup) return "exclusive";
  return "independent";
}

export interface CheckboxGroupingPage {
  evaluate<Result, Argument>(
    operation: (argument: Argument) => Result | Promise<Result>,
    argument: Argument,
  ): Promise<Result>;
}

export async function annotateCheckboxGroups(page: CheckboxGroupingPage): Promise<void> {
  const evidence = await page.evaluate((attribute) => {
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement) || element.hidden ||
          element.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" &&
        style.visibility !== "collapse" && element.getClientRects().length > 0;
    };
    document.querySelectorAll(`[${attribute}]`).forEach((element) =>
      element.removeAttribute(attribute)
    );
    const native = [...document.querySelectorAll<HTMLElement>(
      '[data-automation-id$="-CheckboxGroup"]',
    )].filter(visible);
    const generic = [...document.querySelectorAll<HTMLElement>(
      '[data-automation-id="formField"], [data-automation-id^="formField-"]',
    )].filter(visible).filter((owner) =>
      owner.querySelector('[data-automation-id$="-CheckboxGroup"]') === null &&
      [...owner.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter(visible)
        .length >= 2
    );
    return [...new Set([...native, ...generic])].map((owner, index) => {
      owner.setAttribute("data-hunt-checkbox-group-candidate", String(index));
      const checkboxes = [...owner.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
        .filter(visible);
      const names = new Set(checkboxes.map((checkbox) =>
        (checkbox.name ?? "").normalize("NFC").replace(/\s+/gu, " ").trim()
      ).filter(Boolean));
      const explicit = owner.getAttribute("data-hunt-checkbox-selection-mode");
      return {
        checkboxCount: checkboxes.length,
        nativeGroup: owner.matches('[data-automation-id$="-CheckboxGroup"]'),
        role: owner.getAttribute("role") ?? "",
        ariaMultiselectable: owner.getAttribute("aria-multiselectable") === "true",
        explicitMode: explicit === "exclusive" || explicit === "multiple" ? explicit : null,
        distinctNames: names.size,
        normalizedText: `${owner.getAttribute("aria-label") ?? ""} ${owner.textContent ?? ""}`
          .normalize("NFC").replace(/\s+/gu, " ").trim(),
      };
    });
  }, checkboxGroupKindAttribute);
  const decisions = evidence.map((item) => classifyCheckboxGroup({
    ...item,
    explicitMode: item.explicitMode === "exclusive" || item.explicitMode === "multiple"
      ? item.explicitMode
      : null,
  }));
  await page.evaluate(({ attribute, decisions }) => {
    for (const owner of document.querySelectorAll<HTMLElement>(
      '[data-hunt-checkbox-group-candidate]',
    )) {
      const ordinal = Number(owner.getAttribute("data-hunt-checkbox-group-candidate"));
      owner.removeAttribute("data-hunt-checkbox-group-candidate");
      const decision = decisions[ordinal];
      if (decision !== undefined) owner.setAttribute(attribute, decision);
    }
  }, { attribute: checkboxGroupKindAttribute, decisions });
}
