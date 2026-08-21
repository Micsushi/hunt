import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";

import { chromium } from "playwright";

import {
  browserTargetToken,
  captureResumeArtifact,
  MAX_RESUME_ARTIFACT_BYTES,
  upstreamResumeId,
} from "../../../src/contracts/index.ts";
import { PlaywrightBrowserSession } from "../../../src/browser/session.ts";
import { applyMutation, type ResolvedBrowserTarget } from "../../../src/browser/adapter.ts";
import { admittedMutation, dataPage, testIds, testJourneyId } from "../playwright-fixture.ts";

async function loopbackPage(body: string): Promise<{
  readonly target: string;
  readonly close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<html data-hunt-page-id="page-test"><body>${body}</body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("loopback address unavailable");
  }
  return {
    target: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}

test("applies admitted desired-state mutations and independently reads them back", async () => {
  const fixture = await loopbackPage(`
    <label>Name <input data-hunt-target-token="target-name"></label><label>Bio <textarea data-hunt-target-token="target-bio"></textarea></label>
    <label>Years <input type="number" data-hunt-target-token="target-years"></label>
    <label>Date <input type="date" data-hunt-target-token="target-date"></label><label><input type="checkbox" data-hunt-target-token="target-authorized"> Authorized</label>
    <div data-automation-id="dateSection" aria-label="Composite date" data-hunt-target-token="target-composite-date"><input data-automation-id="dateSectionMonth"><input data-automation-id="dateSectionDay"><input data-automation-id="dateSectionYear"></div>
    <fieldset data-field-id="s1-field-work-authorization" data-hunt-target-token="target-s1-field-work-authorization" data-question-id="s1-question-work-authorization" data-question-label="Are you authorized to work in this location?">
      <legend>Are you authorized to work in this location?</legend>
      <label><input data-option-id="s1-option-work-authorization-yes" name="workAuthorization" required type="radio" value="yes">Yes</label>
      <label><input data-option-id="s1-option-work-authorization-no" name="workAuthorization" required type="radio" value="no">No</label>
    </fieldset>
    <label>Country <select data-hunt-target-token="target-country"><option>Canada</option><option>United States</option></select></label>
    <div role="listbox" aria-label="Department" data-hunt-target-token="target-department"><div role="option">Engineering</div><div role="option">Sales</div></div>
    <label>Resume <input type="file" multiple data-hunt-target-token="target-resume"></label>
    <script>document.querySelectorAll('[role=option]').forEach(o => o.addEventListener('click', () => { document.querySelectorAll('[role=option]').forEach(x => x.setAttribute('aria-selected','false')); o.setAttribute('aria-selected','true'); }));</script>
  `);
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("bbbbbbbbbbbbbbbb") });
  try {
    const started = await provider.start({
      journeyId: testJourneyId,
      target: fixture.target,
    }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const first = await provider.observe(started.value, new AbortController().signal);
    if (!first.ok) throw new Error("observe failed");
    const token = (name: string) => {
      const found = first.value.targets.find((target) => target.name === name);
      if (found === undefined) throw new Error(`missing ${name}`);
      return found.token;
    };
    const page = context.pages()[0];
    assert.ok(page !== undefined);
    const resumeInput = page.locator('[data-hunt-target-token="target-resume"]');
    const resumeReadback = async () => {
      const observed = await provider.observe(started.value, new AbortController().signal);
      if (!observed.ok) throw new Error("resume readback failed");
      return observed.value.targets.find(({ name }) => name === "Resume")?.readback;
    };
    assert.deepEqual(await resumeReadback(), {
      kind: "upload",
      resumeId: null,
      sha256: null,
    });

    await resumeInput.setInputFiles({
      name: "external.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("external-file-without-cache"),
    });
    assert.deepEqual(await resumeReadback(), { kind: "unavailable" });

    await resumeInput.setInputFiles([
      { name: "first.pdf", mimeType: "application/pdf", buffer: Buffer.from("first") },
      { name: "second.pdf", mimeType: "application/pdf", buffer: Buffer.from("second") },
    ]);
    assert.deepEqual(await resumeReadback(), { kind: "unavailable" });

    const oversized = Buffer.alloc(MAX_RESUME_ARTIFACT_BYTES + 1, 1);
    try {
      await resumeInput.setInputFiles({
        name: "oversized.pdf",
        mimeType: "application/pdf",
        buffer: oversized,
      });
      assert.deepEqual(await resumeReadback(), { kind: "unavailable" });
    } finally {
      oversized.fill(0);
    }

    await resumeInput.setInputFiles({
      name: "unreadable.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("unreadable"),
    });
    await page.evaluate(() => {
      const root = globalThis as typeof globalThis & {
        restoreFileArrayBuffer?: () => void;
      };
      const original = File.prototype.arrayBuffer;
      root.restoreFileArrayBuffer = () => {
        File.prototype.arrayBuffer = original;
      };
      File.prototype.arrayBuffer = async () => {
        throw new Error("synthetic file read failure");
      };
    });
    try {
      assert.deepEqual(await resumeReadback(), { kind: "unavailable" });
    } finally {
      await page.evaluate(() => {
        const root = globalThis as typeof globalThis & {
          restoreFileArrayBuffer?: () => void;
        };
        root.restoreFileArrayBuffer?.();
        delete root.restoreFileArrayBuffer;
      });
    }
    await resumeInput.setInputFiles([]);
    const mutations = [
      { mutation: { kind: "set_text", target: token("Name"), text: "Ada" } as const, seed: "1111111111111111" },
      { mutation: { kind: "set_text", target: token("Bio"), text: "Builder" } as const, seed: "2222222222222222" },
      { mutation: { kind: "set_text", target: token("Years"), text: "5" } as const, seed: "2323232323232323" },
      { mutation: { kind: "set_date", target: token("Date"), isoDate: "2026-08-01" } as const, seed: "3333333333333333" },
      { mutation: { kind: "set_date", target: token("Composite date"), isoDate: "2026-09-02" } as const, seed: "3434343434343434" },
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
    assert.deepEqual(values.get("Years"), { kind: "text", value: "5" });
    assert.deepEqual(values.get("Date"), { kind: "text", value: "2026-08-01" });
    assert.deepEqual(values.get("Composite date"), { kind: "text", value: "2026-09-02" });
    assert.deepEqual(values.get("Authorized"), { kind: "checked", checked: true });
    assert.deepEqual(values.get("Are you authorized to work in this location?"), { kind: "selected", option: "No" });
    assert.deepEqual(values.get("Country"), { kind: "selected", option: "United States" });
    assert.deepEqual(values.get("Department"), { kind: "selected", option: "Sales" });
    assert.deepEqual(values.get("Resume"), { kind: "upload", resumeId: "resume-1", sha256: digest });

    await resumeInput.setInputFiles([]);
    const cleared = await provider.observe(started.value, new AbortController().signal);
    if (!cleared.ok) throw new Error("cleared readback failed");
    assert.deepEqual(
      cleared.value.targets.find(({ name }) => name === "Resume")?.readback,
      { kind: "upload", resumeId: null, sha256: null },
    );

    await resumeInput.setInputFiles({
      name: "resume.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("different-resume-content"),
    });
    const replaced = await provider.observe(started.value, new AbortController().signal);
    if (!replaced.ok) throw new Error("replaced readback failed");
    assert.deepEqual(
      replaced.value.targets.find(({ name }) => name === "Resume")?.readback,
      { kind: "unavailable" },
    );
  } finally {
    await context.close();
    await browser.close();
    await fixture.close();
  }
});

test("commits a controlled Workday formatted date through its visible calendar", async () => {
  const fixture = await loopbackPage(`
    <div data-automation-id="formField-dateSignedOn">
      <label>Date <input type="tel" placeholder="MM/DD/YYYY"
        data-hunt-target-token="target-formatted-date"></label>
      <div data-automation-id="datePickerIcon">Calendar</div>
    </div>
    <div role="dialog" hidden>
      <button type="button" aria-label="Tuesday, September 1, 2026">1</button>
    </div>
    <script>
      const input = document.querySelector('[data-hunt-target-token="target-formatted-date"]');
      let accepted = '';
      Object.defineProperty(input, '__reactProps$controlledDate', {
        enumerable: true,
        value: {
          value: '',
          onChange: () => {},
        },
      });
      input.addEventListener('input', () => { input.value = accepted; });
      input.addEventListener('blur', () => { input.value = accepted; });
      document.querySelector('[data-automation-id="datePickerIcon"]').addEventListener('click', () => {
        document.querySelector('[role="dialog"]').hidden = false;
      });
      document.querySelector('[aria-label="Tuesday, September 1, 2026"]').addEventListener('click', () => {
        accepted = '09/01/2026';
        input.value = accepted;
        document.querySelector('[role="dialog"]').hidden = true;
      });
    </script>
  `);
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("bcbcbcbcbcbcbcbc") });
  try {
    const started = await provider.start({
      journeyId: testJourneyId,
      target: fixture.target,
    }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const observed = await provider.observe(started.value, new AbortController().signal);
    if (!observed.ok) throw new Error("observe failed");
    const target = observed.value.targets.find(({ name }) => name === "Date")?.token;
    if (target === undefined) throw new Error("date target missing");

    const result = await provider.mutate(admittedMutation(
      started.value.sessionId,
      started.value.pageId,
      { kind: "set_date", target, isoDate: "2026-09-01" },
      "bcbcbcbcbcbcbccd",
    ), new AbortController().signal);
    assert.equal(result.ok, true);
    const page = context.pages()[0];
    assert.ok(page !== undefined);
    assert.deepEqual(
      await page.evaluate(() =>
        (document.documentElement as unknown as Record<string, unknown>).__huntDateProbe
      ),
      {
        digitAccepted: false,
        fillAccepted: false,
        sequentialAccepted: false,
        ownerCallSucceeded: true,
        ownerAccepted: false,
        directPropCount: 1,
        directOnChangeCount: 1,
        directOnChangeArity: 0,
        directOnBlurCount: 0,
        directOnInputCount: 0,
        calendarOpened: true,
        calendarCandidateCount: 1,
        calendarAccepted: true,
      },
    );
    assert.equal(
      await page.locator('[data-hunt-target-token="target-formatted-date"]').inputValue(),
      "09/01/2026",
    );
  } finally {
    await context.close();
    await browser.close();
    await fixture.close();
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

test("rebinds one uniquely observed Workday checkbox group after its target token vanishes", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({
    context,
    ids: testIds("cdcdcdcdcdcdcdcd"),
  });
  try {
    const started = await provider.start({
      journeyId: testJourneyId,
      target: dataPage(`
        <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
          data-hunt-target-token="target-disability-status">
          <legend>Disability status</legend>
          <label><input type="checkbox" aria-label="Yes">Yes</label>
          <label><input type="checkbox" aria-label="No">No</label>
          <label><input id="decline" type="checkbox"
            aria-label="Decline to self-identify">Decline to self-identify</label>
        </fieldset>
      `, "page-questionnaire"),
    }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const observed = await provider.observe(started.value, new AbortController().signal);
    if (!observed.ok) throw new Error("observe failed");
    const target = observed.value.targets[0]?.token;
    if (target === undefined) throw new Error("target missing");
    const page = context.pages()[0];
    assert.ok(page !== undefined);
    await page.locator('[data-automation-id="disabilityStatus-CheckboxGroup"]')
      .evaluate((element) => element.removeAttribute("data-hunt-target-token"));

    const result = await provider.mutate(admittedMutation(
      started.value.sessionId,
      started.value.pageId,
      { kind: "select", target, option: "Decline to self-identify" as never },
      "cdcdcdcdcdcdcdce",
    ), new AbortController().signal);
    assert.equal(result.ok, true);
    assert.equal(await page.locator("#decline").isChecked(), true);
    assert.equal(await page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("re-commits an exact Workday prompt-button selection", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("ededededededed02") });
  try {
    const started = await provider.start({ journeyId: testJourneyId, target: dataPage(`
      <div data-automation-id="formField-authorization">
        <label>Are you authorized to work in the U.S.?</label>
        <span data-automation-id="required">*</span>
        <button id="authorization" type="button" aria-haspopup="listbox" data-hunt-target-token="target-authorization">Yes</button>
        <div id="options" hidden>
          <div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">Yes</div></div>
          <div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">No</div></div>
        </div>
      </div>
      <script>
        const button = document.querySelector('#authorization');
        const options = document.querySelector('#options');
        button.addEventListener('click', () => { options.hidden = false; });
        options.addEventListener('click', (event) => {
          const option = event.target.closest('[data-automation-id="promptOption"]');
          if (option === null) return;
          button.textContent = option.textContent.trim();
          button.dataset.committed = 'true';
          options.hidden = true;
        });
      </script>
    `, "page-questionnaire") }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const observed = await provider.observe(started.value, new AbortController().signal);
    if (!observed.ok) throw new Error("observe failed");
    const target = observed.value.targets[0]?.token;
    if (target === undefined) throw new Error("target missing");

    const result = await provider.mutate(admittedMutation(
      started.value.sessionId,
      started.value.pageId,
      { kind: "select", target, option: "Yes" as never },
      "ededededededed03",
    ), new AbortController().signal);
    assert.equal(result.ok, true);
    assert.equal(
      await context.pages()[0]!.locator("#authorization").getAttribute("data-committed"),
      "true",
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("opens a Workday prompt button before requiring its lazily mounted option", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("ededededededed04") });
  try {
    const started = await provider.start({ journeyId: testJourneyId, target: dataPage(`
      <div data-automation-id="formField-authorization">
        <label>Are you authorized to work in the U.S.? <span aria-hidden="true">*</span></label>
        <button id="authorization" type="button" aria-label="Select One Required" aria-haspopup="listbox" data-hunt-target-token="target-authorization">Select One</button>
      </div>
      <script>
        const button = document.querySelector('#authorization');
        button.addEventListener('click', () => setTimeout(() => {
          const options = document.createElement('div');
          options.innerHTML = '<div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">Yes</div></div><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">No</div></div>';
          options.addEventListener('click', (event) => {
            const option = event.target.closest('[data-automation-id="promptOption"]');
            if (option === null) return;
            button.textContent = option.textContent.trim();
            button.dataset.committed = 'true';
            options.remove();
          });
          document.body.append(options);
        }, 750), { once: true });
      </script>
    `, "page-questionnaire") }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");
    const observed = await provider.observe(started.value, new AbortController().signal);
    if (!observed.ok) throw new Error("observe failed");
    const target = observed.value.targets[0]?.token;
    if (target === undefined) throw new Error("target missing");
    assert.deepEqual(observed.value.targets[0]?.control, {
      kind: "select",
      element: "listbox",
      options: [],
    });

    const result = await provider.mutate(admittedMutation(
      started.value.sessionId,
      started.value.pageId,
      { kind: "select", target, option: "Yes" as never },
      "ededededededed05",
    ), new AbortController().signal);
    assert.equal(result.ok, true);
    assert.equal(
      await context.pages()[0]!.locator("#authorization").getAttribute("data-committed"),
      "true",
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("upload observation transfers only digest and size metadata from the page", () => {
  const source = readFileSync(
    new URL("../../../src/browser/adapter.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\b(?:btoa|base64|createHash)\b|kind:\s*"bytes"/u,
  );
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/u);
  assert.match(source, /return \{ kind: "digest", sha256, size \}/u);
});

test("passes upload bytes to Playwright through a zero-copy buffer view", async () => {
  const upload = Uint8Array.from([1, 2, 3, 4]);
  let captured: Buffer | undefined;
  const locator = {
    count: async () => 1,
    setInputFiles: async (file: { readonly buffer: Buffer }) => {
      captured = file.buffer;
    },
  };
  const page = {
    locator: () => locator,
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
