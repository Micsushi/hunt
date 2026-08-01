import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { PlaywrightBrowserSession } from "../../../../src/browser/session.ts";
import { admittedMutation, dataPage, testIds, testJourneyId } from "../../../browser/playwright-fixture.ts";

test("stale targets and repeated operation identities fail closed", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("aeaeaeaeaeaeaeae") });
  try {
    const started = await provider.start({ journeyId: testJourneyId, target: dataPage(`<label>Name <input data-hunt-target-token="target-name"></label>`) }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const observed = await provider.observe(started.value, new AbortController().signal);
    if (!observed.ok) throw new Error("observe failed");
    const target = observed.value.targets[0]?.token;
    if (target === undefined) throw new Error("target missing");
    const page = context.pages().find((candidate) => candidate.url().startsWith("data:"));
    if (page === undefined) throw new Error("owned page missing");
    await page.locator("input").evaluate((element) => element.remove());
    const stale = await provider.mutate(admittedMutation(started.value.sessionId, started.value.pageId, { kind: "set_text", target, text: "Ada" }), new AbortController().signal);
    assert.equal(stale.ok ? "ok" : stale.error.code, "browser_target_stale");

    await page.setContent(`<label>Name <input data-hunt-target-token="target-name"></label>`);
    const refreshed = await provider.observe(started.value, new AbortController().signal);
    if (!refreshed.ok) throw new Error("refresh failed");
    const restored = refreshed.value.targets[0]?.token;
    if (restored === undefined) throw new Error("restored target missing");
    const first = admittedMutation(started.value.sessionId, started.value.pageId, { kind: "set_text", target: restored, text: "Ada" }, "1313131313131313");
    assert.equal((await provider.mutate(first, new AbortController().signal)).ok, true);
    const replay = admittedMutation(started.value.sessionId, started.value.pageId, { kind: "set_text", target: restored, text: "Grace" }, "1313131313131313");
    const repeated = await provider.mutate(replay, new AbortController().signal);
    assert.equal(repeated.ok ? "ok" : repeated.error.code, "browser_operation_replayed");
  } finally {
    await context.close();
    await browser.close();
  }
});
