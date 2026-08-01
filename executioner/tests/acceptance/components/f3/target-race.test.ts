import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { chromium } from "playwright";

import { captureResumeArtifact, upstreamResumeId } from "../../../../src/contracts/index.ts";
import { PlaywrightBrowserSession } from "../../../../src/browser/session.ts";
import { admittedMutation, dataPage, testIds, testJourneyId } from "../../../browser/playwright-fixture.ts";

test("re-resolves target uniqueness immediately before side effects", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("afafafafafafafaf") });
  try {
    const started = await provider.start({ journeyId: testJourneyId, target: dataPage(`<label>Name <input data-hunt-target-token="target-name"></label>`) }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const observed = await provider.observe(started.value, new AbortController().signal);
    if (!observed.ok) throw new Error("observe failed");
    const target = observed.value.targets[0]?.token;
    if (target === undefined) throw new Error("target missing");
    const page = context.pages()[0];
    if (page === undefined) throw new Error("page missing");
    await page.locator("body").evaluate((body) => body.insertAdjacentHTML("beforeend", `<label>Name <input data-hunt-target-token="target-name"></label>`));
    const raced = await provider.mutate(admittedMutation(started.value.sessionId, started.value.pageId, { kind: "set_text", target, text: "Ada" }), new AbortController().signal);
    assert.equal(raced.ok ? "ok" : raced.error.code, "browser_target_ambiguous");
    assert.deepEqual(await page.locator("input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)), ["", ""]);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("does not consume an upload artifact until its target is uniquely re-resolved", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("babababababababa") });
  try {
    const started = await provider.start({ journeyId: testJourneyId, target: dataPage(`<label>Resume <input type="file" data-hunt-target-token="target-resume"></label>`) }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const observed = await provider.observe(started.value, new AbortController().signal);
    if (!observed.ok) throw new Error("observe failed");
    const target = observed.value.targets[0]?.token;
    if (target === undefined) throw new Error("target missing");
    const bytes = new TextEncoder().encode("resume");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const captured = captureResumeArtifact({ resumeId: upstreamResumeId("resume-race"), sha256: digest }, bytes);
    if (!captured.ok) throw new Error("capture failed");
    const page = context.pages()[0];
    if (page === undefined) throw new Error("page missing");
    await page.locator("input").evaluate((element) => element.remove());
    const stale = await provider.mutate(admittedMutation(started.value.sessionId, started.value.pageId, { kind: "upload", target, artifact: captured.value }), new AbortController().signal);
    assert.equal(stale.ok ? "ok" : stale.error.code, "browser_target_stale");
    await page.setContent(`<label>Resume <input type="file" data-hunt-target-token="target-resume"></label>`);
    const refreshed = await provider.observe(started.value, new AbortController().signal);
    if (!refreshed.ok) throw new Error("refresh failed");
    const freshTarget = refreshed.value.targets[0]?.token;
    if (freshTarget === undefined) throw new Error("fresh target missing");
    const retried = await provider.mutate(admittedMutation(started.value.sessionId, started.value.pageId, { kind: "upload", target: freshTarget, artifact: captured.value }, "1414141414141414"), new AbortController().signal);
    assert.equal(retried.ok, true);
  } finally {
    await context.close();
    await browser.close();
  }
});
