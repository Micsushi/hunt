import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";
import { createHash } from "node:crypto";

import { captureResumeArtifact, upstreamResumeId } from "../../../src/contracts/index.ts";
import {
  PlaywrightBrowserSession,
  reconcileCommittedMutation,
} from "../../../src/browser/session.ts";
import { admittedMutation, dataPage, testIds, testJourneyId } from "../playwright-fixture.ts";

test("owns exactly one page and leaves foreign pages alone", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const foreign = await context.newPage();
  const provider = new PlaywrightBrowserSession({
    context,
    ids: testIds("aaaaaaaaaaaaaaaa"),
  });

  try {
    const started = await provider.start(
      { journeyId: testJourneyId, target: dataPage("<p>owned</p>", "page-owned") },
      new AbortController().signal,
    );
    assert.deepEqual(started, {
      ok: true,
      value: {
        sessionId: "browser_session_aaaaaaaaaaaaaaaa",
        pageId: "page-owned",
      },
    });
    assert.equal(context.pages().length, 2);

    const duplicate = await provider.start(
      { journeyId: testJourneyId, target: dataPage("duplicate") },
      new AbortController().signal,
    );
    assert.deepEqual(duplicate, {
      ok: false,
      error: { code: "browser_page_owned", retryable: false },
    });

    if (!started.ok) throw new Error("setup failed");
    assert.deepEqual(
      await provider.close({ sessionId: started.value.sessionId }, new AbortController().signal),
      { ok: true, value: undefined },
    );
    assert.equal(context.pages().length, 1);
    assert.equal(foreign.isClosed(), false);
    assert.deepEqual(
      await provider.close({ sessionId: started.value.sessionId }, new AbortController().signal),
      { ok: true, value: undefined },
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("attached semantic session observes an already-owned page without closing it", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(dataPage(
    '<label>Name <input required data-hunt-target-token="target-name"></label>',
    "page-attached",
  ));
  const provider = new PlaywrightBrowserSession({
    attached: {
      page,
      sessionId: "browser_session_attached00000001" as never,
      pageId: "page-attached" as never,
    },
    ids: testIds("unused00000000000"),
  });
  try {
    const observed = await provider.observe({
      sessionId: "browser_session_attached00000001" as never,
      pageId: "page-attached" as never,
    }, new AbortController().signal);
    assert.equal(observed.ok, true);
    assert.equal(observed.ok && observed.value.targets.length, 1);
    assert.deepEqual(await provider.close({
      sessionId: "browser_session_attached00000001" as never,
    }, new AbortController().signal), { ok: true, value: undefined });
    assert.equal(page.isClosed(), false);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("pre-cancelled start is bounded and acquires no page", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({
    context,
    ids: testIds("bbbbbbbbbbbbbbbb"),
  });
  try {
    assert.deepEqual(
      await provider.start(
        { journeyId: testJourneyId, target: dataPage("cancelled") },
        AbortSignal.abort(),
      ),
      { ok: false, error: { code: "operation_cancelled", retryable: false } },
    );
    assert.equal(context.pages().length, 0);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("concurrent starts reserve ownership before the first await", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({
    context,
    ids: testIds("cccccccccccccccc"),
  });
  try {
    const [first, second] = await Promise.all([
      provider.start(
        { journeyId: testJourneyId, target: dataPage("first", "page-first") },
        new AbortController().signal,
      ),
      provider.start(
        { journeyId: testJourneyId, target: dataPage("second", "page-second") },
        new AbortController().signal,
      ),
    ]);
    assert.equal(first.ok, true);
    assert.deepEqual(second, {
      ok: false,
      error: { code: "browser_page_owned", retryable: false },
    });
    if (first.ok) {
      await provider.close({ sessionId: first.value.sessionId }, new AbortController().signal);
    }
  } finally {
    await context.close();
    await browser.close();
  }
});

test("start requires a valid declared page coordinate instead of deriving one from the URL", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("fafafafafafafafa") });
  try {
    const target = `data:text/html,${encodeURIComponent("<html><body>undeclared</body></html>")}`;
    assert.deepEqual(await provider.start({ journeyId: testJourneyId, target }, new AbortController().signal), {
      ok: false,
      error: { code: "browser_target_invalid", retryable: false },
    });
    assert.equal(context.pages().length, 0);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("close clears upload, seen-target, and operation metadata before restart", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({
    context,
    ids: testIds("dddddddddddddddd", "eeeeeeeeeeeeeeee"),
  });
  try {
    const first = await provider.start({ journeyId: testJourneyId, target: dataPage(`<label>Resume <input type="file" data-hunt-target-token="target-resume"></label><label>Ephemeral <input data-hunt-target-token="target-ephemeral"></label>`, "page-first") }, new AbortController().signal);
    if (!first.ok) throw new Error("first start failed");
    const firstObservation = await provider.observe(first.value, new AbortController().signal);
    if (!firstObservation.ok) throw new Error("first observe failed");
    const resume = firstObservation.value.targets.find((target) => target.name === "Resume")?.token;
    const ephemeral = firstObservation.value.targets.find((target) => target.name === "Ephemeral")?.token;
    if (resume === undefined || ephemeral === undefined) throw new Error("first tokens missing");
    const bytes = new TextEncoder().encode("resume-cleanup");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const artifact = captureResumeArtifact({ resumeId: upstreamResumeId("resume-cleanup"), sha256: digest }, bytes);
    if (!artifact.ok) throw new Error("artifact capture failed");
    const seed = "2424242424242424";
    assert.equal((await provider.mutate(admittedMutation(first.value.sessionId, first.value.pageId, { kind: "upload", target: resume, artifact: artifact.value }, seed), new AbortController().signal)).ok, true);
    assert.equal((await provider.close({ sessionId: first.value.sessionId }, new AbortController().signal)).ok, true);

    const second = await provider.start({ journeyId: testJourneyId, target: dataPage(`<label>Resume <input type="file" data-hunt-target-token="target-resume"></label><label>Name <input data-hunt-target-token="target-name"></label>`, "page-second") }, new AbortController().signal);
    if (!second.ok) throw new Error("second start failed");
    const secondObservation = await provider.observe(second.value, new AbortController().signal);
    if (!secondObservation.ok) throw new Error("second observe failed");
    const secondResume = secondObservation.value.targets.find((target) => target.name === "Resume");
    const name = secondObservation.value.targets.find((target) => target.name === "Name")?.token;
    if (name === undefined) throw new Error("second token missing");
    assert.deepEqual(secondResume?.readback, { kind: "upload", resumeId: null, sha256: null });
    assert.equal((await provider.mutate(admittedMutation(second.value.sessionId, second.value.pageId, { kind: "set_text", target: name, text: "Ada" }, seed), new AbortController().signal)).ok, true);
    const absent = await provider.mutate(admittedMutation(second.value.sessionId, second.value.pageId, { kind: "set_text", target: ephemeral, text: "x" }, "2525252525252525"), new AbortController().signal);
    assert.equal(absent.ok ? "ok" : absent.error.code, "browser_target_invalid");
  } finally {
    await context.close();
    await browser.close();
  }
});

test("post-effect reconciliation accepts exact committed state across sibling remounted controls", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const sessionId = "browser_session_reconcile_siblings" as never;
  const pageId = "page-reconcile-siblings" as never;
  try {
    await page.route("https://fixture.test/reconcile", (route) => route.fulfill({
      contentType: "text/html",
      body: `<html data-hunt-page-id="page-reconcile-siblings"><body>
      <label>Text <input data-hunt-target-token="target-text" value="Ada"></label>
      <label>Narrative <textarea data-hunt-target-token="target-area">Hello</textarea></label>
      <div contenteditable="true" aria-label="Editable" data-hunt-target-token="target-edit">World</div>
      <label>Date <input type="date" data-hunt-target-token="target-date" value="2026-08-28"></label>
      <label>Choice <select data-hunt-target-token="target-select"><option>Red</option><option selected>Blue</option></select></label>
      <label>Ack <input type="checkbox" data-hunt-target-token="target-check" checked></label>
      <label>Many <select multiple data-hunt-target-token="target-many"><option selected>One</option><option>Two</option></select></label>
      <label>File <input type="file" data-hunt-target-token="target-file"></label>
    </body></html>`,
    }));
    await page.goto("https://fixture.test/reconcile");
    await page.locator("[data-hunt-target-token]").evaluateAll((controls) => {
      for (const control of controls) control.replaceWith(control.cloneNode(true));
    });
    const committed = async (mutation: Parameters<typeof reconcileCommittedMutation>[3]) =>
      reconcileCommittedMutation(page, sessionId, pageId, mutation, new Map());
    assert.equal(await committed({ kind: "set_text", target: "target-text" as never, text: "Ada" }), "committed");
    assert.equal(await committed({ kind: "set_text", target: "target-area" as never, text: "Hello" }), "committed");
    assert.equal(await committed({ kind: "set_text", target: "target-edit" as never, text: "World" }), "committed");
    assert.equal(await committed({ kind: "set_date", target: "target-date" as never, isoDate: "2026-08-28" }), "committed");
    assert.equal(await committed({ kind: "select", target: "target-select" as never, option: "Blue" as never }), "committed");
    assert.equal(await committed({ kind: "set_checked", target: "target-check" as never, checked: true }), "committed");
    assert.equal(await committed({ kind: "select", target: "target-many" as never, option: "One" as never }), "committed");

    const bytes = new TextEncoder().encode("test upload");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifact = captureResumeArtifact({ resumeId: upstreamResumeId("resume-reconcile"), sha256 }, bytes);
    if (!artifact.ok) throw new Error("artifact capture failed");
    await page.locator('[data-hunt-target-token="target-file"]').setInputFiles({
      name: "resume.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    });
    assert.equal(await committed({
      kind: "upload",
      target: "target-file" as never,
      artifact: artifact.value,
    }), "committed");
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
});
