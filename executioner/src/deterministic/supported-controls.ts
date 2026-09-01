import { uiBehaviorIds, type UiBehaviorId } from "../contracts/types.ts";
import { isSharedProfileUiType } from "./ui-state-model.ts";

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
  return isSharedProfileUiType(value);
}

export const checkboxGroupKindAttribute = "data-hunt-checkbox-group-kind";
export const checkboxGroupOptionsAttribute = "data-hunt-checkbox-options";
export const checkboxGroupSelectedOptionAttribute = "data-hunt-checkbox-selected-option";
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
    const optionsAttribute = "data-hunt-checkbox-options";
    const selectedOptionAttribute = "data-hunt-checkbox-selected-option";
    const normalize = (value: string | null | undefined) =>
      (value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement) || element.hidden ||
          element.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" &&
        style.visibility !== "collapse" && element.getClientRects().length > 0;
    };
    document.querySelectorAll(`[${attribute}], [${selectedOptionAttribute}]`)
      .forEach((element) => {
        element.removeAttribute(attribute);
        element.removeAttribute(selectedOptionAttribute);
      });
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
    const owners = [...new Set([...native, ...generic])];
    document.querySelectorAll(`[${optionsAttribute}]`).forEach((element) => {
      if (!owners.includes(element as HTMLElement)) element.removeAttribute(optionsAttribute);
    });
    return owners.map((owner, index) => {
      owner.setAttribute("data-hunt-checkbox-group-candidate", String(index));
      const checkboxes = [...owner.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
        .filter(visible);
      const priorOptions = (() => {
        const encoded = owner.getAttribute(optionsAttribute);
        if (encoded === null) return [];
        try {
          const parsed: unknown = JSON.parse(encoded);
          return Array.isArray(parsed) && parsed.length >= 2 && parsed.every((option) =>
              typeof option === "string" && normalize(option) !== ""
            ) && new Set(parsed.map((option) => normalize(String(option)))).size === parsed.length
            ? parsed.map((option) => normalize(String(option)))
            : [];
        } catch {
          return [];
        }
      })();
      const records: Record<string, unknown>[] = [];
      const seen = new Set<unknown>();
      const inspect = (value: unknown): void => {
        if (typeof value !== "object" || value === null || seen.has(value)) return;
        seen.add(value);
        records.push(value as Record<string, unknown>);
      };
      const host = owner as unknown as Record<string, unknown>;
      Object.keys(owner).filter((key) => key.startsWith("__reactProps$"))
        .forEach((key) => inspect(host[key]));
      const fiberKey = Object.keys(owner).find((key) =>
        key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
      );
      let fiber = fiberKey === undefined ? undefined : host[fiberKey] as {
        memoizedProps?: unknown;
        pendingProps?: unknown;
        return?: unknown;
      } | undefined;
      for (let depth = 0; fiber !== undefined && fiber !== null && depth < 20; depth += 1) {
        inspect(fiber.memoizedProps ?? fiber.pendingProps);
        fiber = fiber.return as typeof fiber;
      }
      const backing = records.flatMap((record) => {
        if (!Array.isArray(record.options) || record.options.length < 1) return [];
        const options = record.options.map((option) => {
          if (typeof option !== "object" || option === null) return undefined;
          const item = option as Record<string, unknown>;
          const label = typeof item.label === "string"
            ? item.label.normalize("NFC").replace(/\s+/gu, " ").trim()
            : "";
          if (label === "") return undefined;
          return { label, id: typeof item.id === "string" ? item.id : undefined };
        });
        if (options.some((option) => option === undefined)) return [];
        const exactOptions = options as { readonly label: string; readonly id?: string }[];
        const selected = (() => {
          const value = Array.isArray(record.value) ? record.value[0] : record.value;
          if (typeof value === "string") {
            return exactOptions.find((option) => option.id === value || option.label === value)?.label;
          }
          if (typeof value === "object" && value !== null) {
            const selectedRecord = value as Record<string, unknown>;
            return exactOptions.find((option) =>
              typeof selectedRecord.id === "string" && option.id === selectedRecord.id ||
              typeof selectedRecord.label === "string" && option.label === selectedRecord.label
            )?.label;
          }
          return undefined;
        })();
        return [{ options: exactOptions.map(({ label }) => label), selected }];
      });
      const optionSets = new Map(backing.filter(({ options }) => options.length >= 2)
        .map(({ options }) => [JSON.stringify(options), options]));
      const currentOptions = optionSets.size === 1 ? [...optionSets.values()][0]! : [];
      const checkboxLabels = checkboxes.map((checkbox) => {
        const aria = normalize(checkbox.getAttribute("aria-label"));
        if (aria !== "") return aria;
        const label = checkbox.labels?.[0]?.cloneNode(true) as HTMLElement | undefined;
        label?.querySelectorAll("input,textarea,select,button").forEach((control) => control.remove());
        return normalize(label?.textContent) || normalize(checkbox.value);
      }).filter(Boolean);
      const observedSubsetsPrior = priorOptions.length >= 2 &&
        [...backing.flatMap(({ options }) => options), ...checkboxLabels].length > 0 &&
        [...backing.flatMap(({ options }) => options), ...checkboxLabels]
          .every((option) => priorOptions.includes(option));
      const backingOptions = currentOptions.length >= 2
        ? currentOptions
        : observedSubsetsPrior ? priorOptions : [];
      const selectedOptions = new Set(backing.map(({ selected }) => selected).filter(
        (selected): selected is string => selected !== undefined,
      ));
      if (backingOptions.length >= 2) {
        owner.setAttribute(optionsAttribute, JSON.stringify(backingOptions));
      } else {
        owner.removeAttribute(optionsAttribute);
      }
      if (selectedOptions.size === 1) {
        owner.setAttribute(selectedOptionAttribute, [...selectedOptions][0]!);
      }
      const names = new Set(checkboxes.map((checkbox) =>
        (checkbox.name ?? "").normalize("NFC").replace(/\s+/gu, " ").trim()
      ).filter(Boolean));
      const explicit = owner.getAttribute("data-hunt-checkbox-selection-mode");
      return {
        checkboxCount: Math.max(checkboxes.length, backingOptions.length),
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
