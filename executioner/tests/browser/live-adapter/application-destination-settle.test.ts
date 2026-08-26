import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { waitThroughApplicationDestinationSettle } from
  "../../../src/browser/playwright-live/private/workday-application-runtime.ts";

test("a stable empty Workday destination settles without consuming the 60-second recovery budget", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <html data-hunt-page-id="page-resume">
        <body data-hunt-application-page="resume">
          <main data-automation-id="applyFlowMyExpPage">
            <button type="button">Next</button>
          </main>
        </body>
      </html>
    `);
    const startedAt = Date.now();
    const observed = await waitThroughApplicationDestinationSettle(
      page,
      60_000,
      new AbortController().signal,
    );
    assert.equal(observed.ok, true, JSON.stringify(observed));
    assert.ok(Date.now() - startedAt < 2_000);
    assert.equal(observed.ok ? observed.value.page : undefined, "resume");
    assert.deepEqual(observed.ok ? observed.value.requiredFields : undefined, []);
  } finally {
    await browser.close();
  }
});

test("an empty Workday destination still yields a delayed nonempty remount", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <html data-hunt-page-id="page-resume">
        <body data-hunt-application-page="resume">
          <main data-automation-id="applyFlowMyExpPage"></main>
          <script>
            setTimeout(() => {
              document.querySelector('main').innerHTML =
                '<label>Resume<input required type="file" data-automation-id="file-upload-input-ref"></label>';
            }, 400);
          </script>
        </body>
      </html>
    `);
    const observed = await waitThroughApplicationDestinationSettle(
      page,
      60_000,
      new AbortController().signal,
    );
    assert.equal(observed.ok, true, JSON.stringify(observed));
    assert.equal(observed.ok ? observed.value.requiredFields.length : 0, 1);
  } finally {
    await browser.close();
  }
});
