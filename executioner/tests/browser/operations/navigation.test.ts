import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { PlaywrightBrowserSession } from "../../../src/browser/session.ts";
import { admittedNavigation, dataPage, testIds, testJourneyId } from "../playwright-fixture.ts";

test("navigates only through one exact next control and rotates page coordinates", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("dddddddddddddddd") });
  try {
    const started = await provider.start({ journeyId: testJourneyId, target: dataPage(`<button onclick="document.documentElement.dataset.huntPageId='page-questionnaire'">Continue</button><button>Submit</button>`, "page-profile") }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const request = admittedNavigation(started.value.sessionId, started.value.pageId);
    const result = await provider.navigate(request, new AbortController().signal);
    assert.deepEqual(result, { ok: true, value: { operationId: request.snapshot.effect.operationId, fromPageId: "page-profile", pageId: "page-questionnaire" } });
    assert.deepEqual(await provider.observe(started.value, new AbortController().signal), { ok: false, error: { code: "browser_session_missing", retryable: false } });
    const replay = await provider.navigate(request, new AbortController().signal);
    assert.equal(replay.ok ? "ok" : replay.error.code, "admission_consumed");
  } finally {
    await context.close();
    await browser.close();
  }
});

test("rejects duplicate next controls as ambiguous", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("eeeeeeeeeeeeeeee") });
  try {
    const started = await provider.start({ journeyId: testJourneyId, target: dataPage(`<button>Next</button><button>Continue</button>`) }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const result = await provider.navigate(admittedNavigation(started.value.sessionId, started.value.pageId), new AbortController().signal);
    assert.equal(result.ok ? "ok" : result.error.code, "browser_target_ambiguous");
  } finally {
    await context.close();
    await browser.close();
  }
});

test("waits for a delayed post-click destination before rotating page coordinates", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.route("https://fixture.invalid/**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      contentType: "text/html",
      body: url.pathname === "/profile"
        ? `<html data-hunt-page-id="page-profile"><body><button onclick="setTimeout(()=>location.href='/questionnaire',75)">Next</button></body></html>`
        : `<html data-hunt-page-id="page-questionnaire"><body><h1>Questions</h1></body></html>`,
    });
  });
  const provider = new PlaywrightBrowserSession({
    context,
    ids: testIds("edededededededed"),
    timeoutMs: 2_000,
  });
  try {
    const started = await provider.start({
      journeyId: testJourneyId,
      target: "https://fixture.invalid/profile",
    }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const request = admittedNavigation(started.value.sessionId, started.value.pageId);
    assert.deepEqual(await provider.navigate(request, new AbortController().signal), {
      ok: true,
      value: {
        operationId: request.snapshot.effect.operationId,
        fromPageId: "page-profile",
        pageId: "page-questionnaire",
      },
    });
  } finally {
    await context.close();
    await browser.close();
  }
});

test("closes and invalidates when navigation lands on a malformed page coordinate", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const foreign = await context.newPage();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("fefefefefefefefe") });
  try {
    const started = await provider.start({ journeyId: testJourneyId, target: dataPage(`<button onclick="document.documentElement.dataset.huntPageId='contains space'">Next</button>`, "page-profile") }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const owned = context.pages().find((page) => page !== foreign);
    if (owned === undefined) throw new Error("owned page missing");
    const request = admittedNavigation(started.value.sessionId, started.value.pageId, "2323232323232323");
    const result = await provider.navigate(request, new AbortController().signal);
    assert.deepEqual(result, { ok: false, error: { code: "browser_effect_uncertain", retryable: false } });
    assert.equal(owned.isClosed(), true);
    assert.equal(foreign.isClosed(), false);
    assert.deepEqual(await provider.observe(started.value, new AbortController().signal), { ok: false, error: { code: "browser_session_invalidated", retryable: false } });
  } finally {
    await context.close();
    await browser.close();
  }
});
