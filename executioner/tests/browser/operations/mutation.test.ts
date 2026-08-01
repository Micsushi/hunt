import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { chromium } from "playwright";

import { browserTargetToken, captureResumeArtifact, upstreamResumeId } from "../../../src/contracts/index.ts";
import { PlaywrightBrowserSession } from "../../../src/browser/session.ts";
import { applyMutation, type ResolvedBrowserTarget } from "../../../src/browser/adapter.ts";
import { admittedMutation, dataPage, testIds, testJourneyId } from "../playwright-fixture.ts";

test("applies admitted desired-state mutations and independently reads them back", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("bbbbbbbbbbbbbbbb") });
  try {
    const started = await provider.start({ journeyId: testJourneyId, target: dataPage(`
      <label>Name <input data-hunt-target-token="target-name"></label><label>Bio <textarea data-hunt-target-token="target-bio"></textarea></label>
      <label>Date <input type="date" data-hunt-target-token="target-date"></label><label><input type="checkbox" data-hunt-target-token="target-authorized"> Authorized</label>
      <fieldset data-field-id="s1-field-work-authorization" data-hunt-target-token="target-s1-field-work-authorization" data-question-id="s1-question-work-authorization" data-question-label="Are you authorized to work in this location?">
        <legend>Are you authorized to work in this location?</legend>
        <label><input data-option-id="s1-option-work-authorization-yes" name="workAuthorization" required type="radio" value="yes">Yes</label>
        <label><input data-option-id="s1-option-work-authorization-no" name="workAuthorization" required type="radio" value="no">No</label>
      </fieldset>
      <label>Country <select data-hunt-target-token="target-country"><option>Canada</option><option>United States</option></select></label>
      <div role="listbox" aria-label="Department" data-hunt-target-token="target-department"><div role="option">Engineering</div><div role="option">Sales</div></div>
      <label>Resume <input type="file" data-hunt-target-token="target-resume"></label>
      <script>document.querySelectorAll('[role=option]').forEach(o => o.addEventListener('click', () => { document.querySelectorAll('[role=option]').forEach(x => x.setAttribute('aria-selected','false')); o.setAttribute('aria-selected','true'); }));</script>
    `) }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const first = await provider.observe(started.value, new AbortController().signal);
    if (!first.ok) throw new Error("observe failed");
    const token = (name: string) => {
      const found = first.value.targets.find((target) => target.name === name);
      if (found === undefined) throw new Error(`missing ${name}`);
      return found.token;
    };
    const mutations = [
      { mutation: { kind: "set_text", target: token("Name"), text: "Ada" } as const, seed: "1111111111111111" },
      { mutation: { kind: "set_text", target: token("Bio"), text: "Builder" } as const, seed: "2222222222222222" },
      { mutation: { kind: "set_date", target: token("Date"), isoDate: "2026-08-01" } as const, seed: "3333333333333333" },
      { mutation: { kind: "set_checked", target: token("Authorized"), checked: true } as const, seed: "4444444444444444" },
      { mutation: { kind: "select", target: token("Are you authorized to work in this location?"), option: "No" as never } as const, seed: "9999999999999999" },
      { mutation: { kind: "select", target: token("Country"), option: "United States" as never } as const, seed: "5555555555555555" },
      { mutation: { kind: "select", target: token("Department"), option: "Sales" as never } as const, seed: "6666666666666666" },
    ];
    for (const { mutation, seed } of mutations) {
      const result = await provider.mutate(admittedMutation(started.value.sessionId, started.value.pageId, mutation, seed), new AbortController().signal);
      assert.equal(result.ok, true);
    }

    const bytes = new TextEncoder().encode("resume-content");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const captured = captureResumeArtifact({ resumeId: upstreamResumeId("resume-1"), sha256: digest }, bytes);
    if (!captured.ok) throw new Error("capture failed");
    const upload = await provider.mutate(admittedMutation(started.value.sessionId, started.value.pageId, { kind: "upload", target: token("Resume"), artifact: captured.value }, "7777777777777777"), new AbortController().signal);
    assert.equal(upload.ok, true);

    const readback = await provider.observe(started.value, new AbortController().signal);
    if (!readback.ok) throw new Error("readback failed");
    const values = new Map<string, (typeof readback.value.targets)[number]["readback"]>(readback.value.targets.map((target) => [target.name, target.readback]));
    assert.deepEqual(values.get("Name"), { kind: "text", value: "Ada" });
    assert.deepEqual(values.get("Bio"), { kind: "text", value: "Builder" });
    assert.deepEqual(values.get("Date"), { kind: "text", value: "2026-08-01" });
    assert.deepEqual(values.get("Authorized"), { kind: "checked", checked: true });
    assert.deepEqual(values.get("Are you authorized to work in this location?"), { kind: "selected", option: "No" });
    assert.deepEqual(values.get("Country"), { kind: "selected", option: "United States" });
    assert.deepEqual(values.get("Department"), { kind: "selected", option: "Sales" });
    assert.deepEqual(values.get("Resume"), { kind: "upload", resumeId: "resume-1", sha256: digest });
  } finally {
    await context.close();
    await browser.close();
  }
});

test("fails stale, ambiguous, mismatched, and replayed operations closed", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("cccccccccccccccc") });
  try {
    const started = await provider.start({ journeyId: testJourneyId, target: dataPage(`<label>Same <input id="a" data-hunt-target-token="target-same"></label><label>Same <input id="b" data-hunt-target-token="target-same"></label><button>Submit</button>`) }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const observed = await provider.observe(started.value, new AbortController().signal);
    if (!observed.ok) throw new Error("observe failed");
    const same = observed.value.targets[0]?.token;
    assert.equal(observed.value.targets.some((target) => target.name === "Submit"), false);
    if (same === undefined) throw new Error("token missing");
    const ambiguous = await provider.mutate(admittedMutation(started.value.sessionId, started.value.pageId, { kind: "set_text", target: same, text: "x" }, "8888888888888888"), new AbortController().signal);
    assert.equal(ambiguous.ok ? "ok" : ambiguous.error.code, "browser_target_ambiguous");
  } finally {
    await context.close();
    await browser.close();
  }
});

test("passes upload bytes to Playwright through a zero-copy buffer view", async () => {
  const upload = Uint8Array.from([1, 2, 3, 4]);
  let captured: Buffer | undefined;
  const locator = {
    setInputFiles: async (file: { readonly buffer: Buffer }) => {
      captured = file.buffer;
    },
  };
  const page = {
    locator: () => ({ nth: () => locator }),
  };
  const target = {
    index: 0,
    declaredToken: "target-resume",
    name: "Resume",
    required: true,
    control: { kind: "file", element: "input" },
    state: { visibility: "visible", enabled: true, actionable: true },
    readback: { kind: "upload", resumeId: null, sha256: null },
    token: browserTargetToken("target-resume"),
  } as const satisfies ResolvedBrowserTarget;

  assert.equal(await applyMutation(page as never, target, { kind: "upload", target: target.token, artifact: {} as never }, upload, 50), "applied");
  assert.ok(captured !== undefined);
  assert.equal(captured.buffer, upload.buffer);
  upload.fill(0);
  assert.deepEqual([...captured], [0, 0, 0, 0]);
});
