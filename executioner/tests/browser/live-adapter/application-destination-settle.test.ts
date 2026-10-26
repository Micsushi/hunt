import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { applicationReadyMonitorTaxonomy, waitThroughApplicationDestinationSettle } from
  "../../../src/browser/playwright-live/private/workday-application-runtime.ts";

test("application-ready inspection recovers an owned runtime error before accepting a stable form", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let loads = 0;
  try {
    const form = `<main data-automation-id="applyFlowPage"><section data-automation-id="applyFlowMyInfoPage">
      <h2>My Information</h2><label>First Name<input id="name--legalName--firstName" required></label>
      <button>Save and Continue</button></section></main>`;
    await page.route("https://example.test/application", route => route.fulfill({
      contentType: "text/html",
      body: ++loads === 1
        ? form + `<script>setTimeout(() => document.querySelector('main').innerHTML =
          '<h2>Something went wrong</h2><p>Please refresh the page and then try again.</p>', 200);</script>`
        : form,
    }));
    await page.goto("https://example.test/application");
    const taxonomy = await applicationReadyMonitorTaxonomy(page as never);
    assert.equal(loads, 2);
    assert.equal(taxonomy.fieldCount, 1);
    assert.equal(taxonomy.requiredFieldCount, 1);
    assert.equal(taxonomy.submitActivated, false);
    await applicationReadyMonitorTaxonomy(page as never);
    assert.equal(loads, 2, "stable forms are not reloaded");
  } finally {
    await browser.close();
  }
});

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
