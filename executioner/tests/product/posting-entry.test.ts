import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { PlaywrightPostingNavigationAdapter } from "../../src/browser/playwright-live/private/playwright-posting-navigation.ts";

test("saved application entry admits only structural Continue for the exact posting", { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 778, height: 446 } });
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
    await page.goto("https://fixture.wd3.myworkdayjobs.com/External/job/Plymouth-MI/Buyer_R1");
    const adapter = new PlaywrightPostingNavigationAdapter();
    for (const [href, automation, expected] of [
      ["/en-US/External/job/Plymouth%2CMI/Buyer_R1/apply", "continueButton", true],
      ["/en-US/External/job/Plymouth%2CMI/Buyer_R2/apply", "continueButton", false],
      ["https://other.wd3.myworkdayjobs.com/en-US/External/job/Plymouth%2CMI/Buyer_R1/apply", "continueButton", false],
      ["/en-US/External/job/Plymouth%2CMI/Buyer_R1/apply", "unrelated", false],
      ["/en-US/Internal/job/Plymouth%2CMI/Buyer_R1/apply", "continueButton", false],
    ] as const) {
      await page.setContent(`<a href="${href}" role="button" data-automation-id="${automation}">Continue Application</a><script>window.clicked=false;document.querySelector('a').onclick=e=>{e.preventDefault();window.clicked=true;};</script>`);
      assert.equal((await adapter.inspect(page, "start_application", { waitForCandidate: false })).actionable, expected);
      if (expected) await adapter.activate(page, "start_application");
      else await assert.rejects(() => adapter.activate(page, "start_application"));
      assert.equal(await page.evaluate("window.clicked"), expected);
    }
  } finally { await browser.close(); }
});


test("Apply Manually recognizes a sibling email-provider choice without requiring its container", { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent(`<main data-automation-id="applyFlowPage"><button>Apply Manually</button></main>
      <script>document.querySelector('button').onclick=()=>{document.querySelector('main').innerHTML=
      '<section data-automation-id="signInContent">Choose a provider</section><button data-automation-id="SignInWithEmailButton">Sign in with email</button>'};</script>`);
    const adapter = new PlaywrightPostingNavigationAdapter();
    await adapter.activate(page, "apply_manually");
    assert.equal(await page.locator('[data-automation-id="signInContent"] [data-automation-id="SignInWithEmailButton"]').count(), 0);
    const { inspectWorkdayStructure } = await import("../../src/browser/playwright-live/private/workday-structural-catalog.ts");
    const result = await inspectWorkdayStructure(page, false, { inspect: async () => ({ cardinality: 0, actionable: false }) });
    assert.ok(result.kind === "snapshot" && result.snapshot.traitIds.includes("structural_trait_navigation_email_sign_in_choice_v1"));
    assert.deepEqual(await adapter.inspect(page, "sign_in_with_email", { waitForCandidate: false }), { cardinality: 1, actionable: true });
    await page.locator('[data-automation-id="SignInWithEmailButton"]').evaluate(element => element.after(element.cloneNode(true)));
    assert.equal((await adapter.inspect(page, "sign_in_with_email", { waitForCandidate: false })).actionable, false);
  } finally { await browser.close(); }
});
