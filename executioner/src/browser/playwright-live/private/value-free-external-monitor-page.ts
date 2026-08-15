import type { Page } from "playwright";

import type { ExternalMonitorPage } from "./external-monitor-port.ts";
import type { PersistentPage } from "./types.ts";

const valueBearingSelectors = [
  "input:visible",
  "textarea:visible",
  "select:visible",
  '[role="combobox"]:visible',
  '[role="listbox"]:visible',
  '[role="radio"][aria-checked="true"]:visible',
  '[role="checkbox"][aria-checked="true"]:visible',
  'button[aria-haspopup="listbox"]:visible',
  '[data-automation-id*="multiSelect" i]:visible',
  '[data-automation-id*="fileUpload" i]:visible',
  '[data-automation-id*="attachment" i]:visible',
  '[data-hunt-review-field-id]:visible',
  '[data-automation-id="applyFlowReviewPage"] [data-automation-id^="formField-"]:visible',
] as const;

/** Keeps monitor structure visible while excluding entered/selected owner values. */
export function valueFreeExternalMonitorPage(
  page: PersistentPage,
  title?: () => Promise<string>,
): ExternalMonitorPage {
  const owned = page as unknown as Page;
  return Object.freeze({
    screenshot: (options?: { readonly type?: "png"; readonly fullPage?: boolean }) =>
      owned.screenshot({
        ...options,
        animations: "disabled",
        caret: "hide",
        mask: valueBearingSelectors.map((selector) => owned.locator(selector)),
        maskColor: "#6B7280",
      }),
    title: title ?? (() => owned.title()),
    url: () => owned.url(),
  });
}

export const valueFreeMonitorMaskSelectors = valueBearingSelectors;
