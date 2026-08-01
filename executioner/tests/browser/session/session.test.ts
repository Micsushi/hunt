import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";
import { createHash } from "node:crypto";

import { captureResumeArtifact, upstreamResumeId } from "../../../src/contracts/index.ts";
import { PlaywrightBrowserSession } from "../../../src/browser/session.ts";
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
