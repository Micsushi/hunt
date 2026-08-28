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
