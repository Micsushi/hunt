import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { PlaywrightBrowserSession } from "../../../../src/browser/session.ts";
import { assertProviderConformance } from "../../../../src/testing/contracts/conformance.ts";
import { testIds } from "../../../browser/playwright-fixture.ts";

test("real Playwright provider conforms to the exact BrowserSession port", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.route("https://fixture.invalid/**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      contentType: "text/html",
      body: url.pathname === "/profile"
        ? `<html data-hunt-page-id="page-profile"><body><label>Given name <input required data-hunt-target-token="target-given-name"></label><script>document.querySelector('input').addEventListener('input',()=>{if(document.querySelector('button'))return;const button=document.createElement('button');button.textContent='Next';button.addEventListener('click',()=>location.href='/questionnaire');document.body.append(button)});</script></body></html>`
        : `<html data-hunt-page-id="page-questionnaire"><body><h1>Questions</h1></body></html>`,
    });
  });
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("abababababababab") });
  try {
    await assertProviderConformance("BrowserSession", provider);
    assert.equal(context.pages().length, 0);
  } finally {
    await context.close();
    await browser.close();
  }
});
