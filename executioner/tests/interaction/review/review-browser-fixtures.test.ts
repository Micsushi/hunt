import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { chromium } from "playwright";

import {
  inspectWorkdayReview,
  type ReviewReadOnlyPage,
} from "../../../src/interaction/review/index.ts";

test("headless Playwright confirms the real Workday Review signatures", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(await fixture("workday-review.html"));

    assert.deepEqual(
      await inspectWorkdayReview(page as ReviewReadOnlyPage),
      {
        schemaVersion: 1,
        reviewRoot: { count: 1, visible: true },
        activeStep: { count: 1, visible: true },
        validationErrorCount: 0,
        finalSubmit: { count: 1, visible: true, enabled: true },
      },
    );
  } finally {
    await browser.close();
  }
});

test("headless Playwright denies a Review-and-Submit text lookalike structurally", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(await fixture("review-lookalike.html"));
    const observed = await inspectWorkdayReview(page as ReviewReadOnlyPage);

    assert.deepEqual(observed.reviewRoot, { count: 0, visible: false });
    assert.deepEqual(observed.activeStep, { count: 0, visible: false });
    assert.deepEqual(observed.finalSubmit, {
      count: 0,
      visible: false,
      enabled: false,
    });
  } finally {
    await browser.close();
  }
});

function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}
