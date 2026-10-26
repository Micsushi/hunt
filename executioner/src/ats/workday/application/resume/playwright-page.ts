import type { Locator, Page } from "playwright";

import type {
  WorkdayResumeLocator,
  WorkdayResumePage,
} from "./types.ts";

export function createPlaywrightWorkdayResumePage(
  page: Page,
): WorkdayResumePage {
  return Object.freeze({
    locator(selector: string): WorkdayResumeLocator {
      if (selector === '[data-automation-id="confirmDeleteFile"]') {
        return resumeLocator(page.locator(selector));
      }
      // Standard upload IDs are also reused for certification attachments.
      // Prefer Workday's explicit resume field; preserve legacy uniqueness
      // checks when that ownership marker is absent.
      const owner = '[data-fkit-id="resumeAttachments--attachments"]';
      return resumeLocator(page.locator(selector).and(page.locator(
        `${owner} *, body:not(:has(${owner})) *`,
      )));
    },
  });
}

function resumeLocator(locator: Locator): WorkdayResumeLocator {
  return Object.freeze({
    count: () => locator.count(),
    isVisible: () => locator.isVisible(),
    click: (
      options?: Parameters<WorkdayResumeLocator["click"]>[0],
    ) => locator.click(options),
    setInputFiles: (
      file: Parameters<WorkdayResumeLocator["setInputFiles"]>[0],
      options?: Parameters<WorkdayResumeLocator["setInputFiles"]>[1],
    ) => locator.setInputFiles(file, options),
    evaluate<Result, Argument>(
      operation: (
        element: HTMLElement,
        argument: Argument,
      ) => Result | Promise<Result>,
      argument: Argument,
    ): Promise<Result> {
      return locator.evaluate(operation as never, argument as never) as Promise<Result>;
    },
  });
}
