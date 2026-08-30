import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { boundedText } from "../../../../src/contracts/index.ts";
import { PlaywrightBrowserSession } from "../../../../src/browser/session.ts";
import { admittedMutation, dataPage, testIds, testJourneyId } from "../../../browser/playwright-fixture.ts";

test("cancellation after a custom-listbox effect starts is uncertain and invalidates the session", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("acacacacacacacac"), timeoutMs: 2_000 });
  const controller = new AbortController();
  try {
    await context.exposeFunction("huntAbortAfterEffectStarts", () => controller.abort());
    const started = await provider.start({ journeyId: testJourneyId, target: dataPage(`
      <div role="listbox" aria-label="Department" data-hunt-target-token="target-department"><div role="option">Engineering</div><div role="option" onclick="window.huntAbortAfterEffectStarts(); const start=performance.now(); while(performance.now()-start<500){}; this.setAttribute('aria-selected','true')">Sales</div></div>
    `) }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const observed = await provider.observe(started.value, new AbortController().signal);
    if (!observed.ok) throw new Error("observe failed");
    const target = observed.value.targets[0]?.token;
    if (target === undefined) throw new Error("target missing");
    const result = await provider.mutate(admittedMutation(started.value.sessionId, started.value.pageId, { kind: "select", target, option: boundedText("Sales") }), controller.signal);
    assert.deepEqual(result, { ok: false, error: { code: "browser_effect_uncertain", retryable: false } });
    const after = await provider.mutate(admittedMutation(started.value.sessionId, started.value.pageId, { kind: "select", target, option: boundedText("Engineering") }, "1212121212121212"), new AbortController().signal);
    assert.deepEqual(after, { ok: false, error: { code: "browser_session_invalidated", retryable: false } });
  } finally {
    await context.close();
    await browser.close();
  }
});

test("pre-effect cancellation stays cancellation and preserves foreign pages", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const foreign = await context.newPage();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("adadadadadadadad") });
  try {
    const started = await provider.start({ journeyId: testJourneyId, target: dataPage(`<label>Name <input data-hunt-target-token="target-name"></label>`) }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    assert.deepEqual(await provider.mutate({} as never, AbortSignal.abort()), { ok: false, error: { code: "operation_cancelled", retryable: false } });
    assert.equal(foreign.isClosed(), false);
    assert.equal((await provider.observe(started.value, new AbortController().signal)).ok, true);
  } finally {
    await context.close();
    await browser.close();
  }
});
