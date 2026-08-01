import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { chromium, type BrowserContext } from "playwright";

import { createWorkdayPageUnderstanding } from "../../../src/ats/workday/page-understanding.ts";
import { PlaywrightBrowserSession } from "../../../src/browser/session.ts";
import {
  createGeneratedIdAllocator,
  fixtureRunId,
  journeyId,
  providerError,
  type BrowserObservation,
  type BrowserSession,
  type PageUnderstanding,
  type PageUnderstandingResult,
  type PortResult,
} from "../../../src/contracts/index.ts";
import { FixtureServer } from "../../../src/testing/fixture-server.ts";

const fixtureRoot = resolve("fixtures/workday/s1");
const signal = new AbortController().signal;
const surfaceJourneyId = journeyId("journey_1111111111111111");

function requireValue<T>(result: PortResult<T, unknown>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("expected provider success");
  return result.value;
}

function createIds() {
  let next = 0;
  return createGeneratedIdAllocator({
    next: () => String(next += 1).padStart(16, "0"),
  });
}

async function observeAndUnderstand(
  browser: BrowserSession,
  understanding: PageUnderstanding,
  target: string,
): Promise<{
  readonly observation: BrowserObservation;
  readonly understanding: PageUnderstandingResult;
}> {
  const opened = requireValue(await browser.start(
    { journeyId: surfaceJourneyId, target },
    signal,
  ));
  try {
    const observation = requireValue(await browser.observe(opened, signal));
    return {
      observation,
      understanding: requireValue(await understanding.understand({ observation }, signal)),
    };
  } finally {
    requireValue(await browser.close({ sessionId: opened.sessionId }, signal));
  }
}

function fieldShape(result: PageUnderstandingResult) {
  assert.equal(result.kind, "understood");
  if (result.kind !== "understood") return [];
  return result.snapshot.fields.map((field) => [
    field.fieldId,
    field.target,
    field.behavior,
    field.options.map(({ id }) => id),
  ]);
}

test("three real resets produce identical browser-visible F5 semantics", async () => {
  const fixture = new FixtureServer(fixtureRoot);
  const engine = await chromium.launch();
  const context = await engine.newContext();
  const browser = new PlaywrightBrowserSession({ context, ids: createIds() });
  const understanding = createWorkdayPageUnderstanding();
  const fixtureRun = fixtureRunId("surface-semantic-run");
  const started = requireValue(await fixture.start({ fixtureRunId: fixtureRun }, signal));

  try {
    const resetHashes: string[] = [];
    const surfaceHashes: string[] = [];
    let firstProfile: PageUnderstandingResult | undefined;
    let firstQuestionnaire: PageUnderstandingResult | undefined;
    let firstAgeTarget: BrowserObservation["targets"][number] | undefined;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const reset = requireValue(await fixture.reset({ fixtureRunId: fixtureRun }, signal));
      resetHashes.push(reset.semanticHash);
      const profile = await observeAndUnderstand(
        browser,
        understanding,
        `${started.origin}/profile`,
      );
      const questionnaire = await observeAndUnderstand(
        browser,
        understanding,
        `${started.origin}/questionnaire`,
      );
      assert.equal(
        [...profile.observation.targets, ...questionnaire.observation.targets]
          .some(({ name }) => /submit/iu.test(name)),
        false,
      );
      firstProfile ??= profile.understanding;
      firstQuestionnaire ??= questionnaire.understanding;
      firstAgeTarget ??= questionnaire.observation.targets.find(
        ({ token }) => token === "target-s1-field-age-requirement",
      );
      surfaceHashes.push(createHash("sha256").update(JSON.stringify([
        profile.understanding,
        questionnaire.understanding,
      ])).digest("hex"));
    }

    assert.equal(new Set(resetHashes).size, 1);
    assert.equal(new Set(surfaceHashes).size, 1);
    assert.deepEqual(firstAgeTarget, {
      token: "target-s1-field-age-requirement",
      name: "I am at least 18 years of age.",
      required: true,
      control: {
        kind: "choice",
        element: "input",
        choice: "checkbox",
        group: "Are you at least 18 years of age?",
        checked: false,
      },
      state: { visibility: "visible", enabled: true, actionable: true },
      readback: { kind: "checked", checked: false },
    });
    assert.deepEqual(fieldShape(firstProfile!), [
      ["s1-field-country", "target-s1-field-country", "listbox", [
        "s1-option-country-us",
        "s1-option-country-ca",
      ]],
      ["s1-field-family-name", "target-s1-field-family-name", "text", []],
      ["s1-field-given-name", "target-s1-field-given-name", "text", []],
      ["s1-field-phone-number", "target-s1-field-phone-number", "text", []],
      ["s1-field-resume", "target-s1-field-resume", "file_upload", []],
      ["s1-field-start-date", "target-s1-field-start-date", "date", []],
    ]);
    assert.deepEqual(fieldShape(firstQuestionnaire!), [
      ["s1-field-age-requirement", "target-s1-field-age-requirement", "checkbox", []],
      ["s1-field-interest", "target-s1-field-interest", "textarea", []],
      ["s1-field-sponsorship", "target-s1-field-sponsorship", "select", [
        "s1-option-sponsorship-yes",
        "s1-option-sponsorship-no",
      ]],
      ["s1-field-work-authorization", "target-s1-field-work-authorization", "radio", [
        "s1-option-work-authorization-yes",
        "s1-option-work-authorization-no",
      ]],
    ]);
    assert.equal(context.pages().length, 0);
  } finally {
    await fixture.close();
    await context.close();
    await engine.close();
  }
});

test("real F3 observations preserve F5 unknown and ambiguous page facts", async () => {
  const fixture = new FixtureServer(fixtureRoot);
  const engine = await chromium.launch();
  const context = await engine.newContext();
  const browser = new PlaywrightBrowserSession({ context, ids: createIds() });
  const understanding = createWorkdayPageUnderstanding();
  const started = requireValue(await fixture.start(
    { fixtureRunId: fixtureRunId("surface-facts-run") },
    signal,
  ));
  const opened = requireValue(await browser.start({
    journeyId: surfaceJourneyId,
    target: `${started.origin}/profile`,
  }, signal));

  try {
    const page = context.pages()[0]!;
    await page.evaluate(() => history.replaceState({}, "", "/candidate-home"));
    const unknown = requireValue(await browser.observe(opened, signal));
    assert.deepEqual(
      await understanding.understand({ observation: unknown }, signal),
      { ok: true, value: { kind: "unknown" } },
    );

    await page.evaluate(() => history.replaceState({}, "", "/profile/questionnaire"));
    const ambiguous = requireValue(await browser.observe(opened, signal));
    assert.deepEqual(
      await understanding.understand({ observation: ambiguous }, signal),
      { ok: true, value: { kind: "ambiguous" } },
    );
  } finally {
    requireValue(await browser.close({ sessionId: opened.sessionId }, signal));
    assert.equal(context.pages().length, 0);
    await fixture.close();
    await context.close();
    await engine.close();
  }
});

test("provider errors and cancellation remain exact across the real surface", async () => {
  const fixture = new FixtureServer(fixtureRoot);
  const browser = new PlaywrightBrowserSession({ ids: createIds() });
  const understanding = createWorkdayPageUnderstanding();
  const fixtureRun = fixtureRunId("surface-error-run");
  const started = requireValue(await fixture.start({ fixtureRunId: fixtureRun }, signal));

  try {
    assert.deepEqual(
      await fixture.start({ fixtureRunId: fixtureRunId("different-run") }, signal),
      { ok: false, error: providerError("fixture_already_started") },
    );
    assert.deepEqual(
      await fixture.reset({ fixtureRunId: fixtureRunId("missing-run") }, signal),
      { ok: false, error: providerError("fixture_not_found") },
    );
    assert.deepEqual(
      await browser.start({ journeyId: surfaceJourneyId, target: "file:///private" }, signal),
      { ok: false, error: providerError("browser_target_invalid") },
    );
    assert.deepEqual(
      await understanding.understand(null as never, signal),
      { ok: false, error: providerError("page_observation_invalid") },
    );
    assert.deepEqual(
      await fixture.reset({ fixtureRunId: fixtureRun }, AbortSignal.abort()),
      { ok: false, error: providerError("operation_cancelled") },
    );
    assert.deepEqual(
      await browser.start(
        { journeyId: surfaceJourneyId, target: `${started.origin}/profile` },
        AbortSignal.abort(),
      ),
      { ok: false, error: providerError("operation_cancelled") },
    );
    assert.deepEqual(
      await understanding.understand(null as never, AbortSignal.abort()),
      { ok: false, error: providerError("operation_cancelled") },
    );
  } finally {
    await fixture.close();
  }

  await assert.rejects(fetch(`${started.origin}/profile`, {
    signal: AbortSignal.timeout(1_000),
  }));
});

test("a configured F2 fault reaches the real F3-owned browser page", async () => {
  const fixture = new FixtureServer(fixtureRoot);
  const engine = await chromium.launch();
  const context: BrowserContext = await engine.newContext();
  const browser = new PlaywrightBrowserSession({ context, ids: createIds() });
  const fixtureRun = fixtureRunId("surface-fault-run");
  const started = requireValue(await fixture.start({ fixtureRunId: fixtureRun }, signal));
  const opened = requireValue(await browser.start({
    journeyId: surfaceJourneyId,
    target: `${started.origin}/profile`,
  }, signal));

  try {
    requireValue(await fixture.setFault({
      fixtureRunId: fixtureRun,
      fault: "component_failure",
    }, signal));
    const page = context.pages()[0]!;
    const response = await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(response?.status(), 503);
    assert.equal(
      await page.locator("html").getAttribute("data-fixture-fault"),
      "component_failure",
    );
    assert.equal(await page.getByRole("heading").textContent(), "Synthetic fixture fault");
    const observed = requireValue(await browser.observe(opened, signal));
    assert.equal(observed.path, "/profile");
    assert.deepEqual(observed.targets, []);
  } finally {
    requireValue(await browser.close({ sessionId: opened.sessionId }, signal));
    assert.equal(context.pages().length, 0);
    await fixture.close();
    await context.close();
    await engine.close();
  }
});
