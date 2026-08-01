import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import {
  fixtureRunId,
  providerError,
  type BrowserSession,
  type VerificationResult,
} from "../../../src/contracts/index.ts";
import { createFieldDriver } from "../../../src/interaction/drivers/registry.ts";
import { createCompletionNavigation } from "../../../src/interaction/navigation/completion-navigation.ts";
import { createFieldVerifier } from "../../../src/interaction/verification/field-verifier.ts";
import { FixtureServer } from "../../../src/testing/fixture-server.ts";
import {
  admittingSafety,
  answerContext,
  interactionJourneyId,
  interactionRevision,
  navigationRequest,
  openInteractionFixture,
  operationId,
  resolveField,
  signal,
  understand,
  value,
} from "./support.ts";

type ReconciliationDecision =
  | { readonly kind: "continue"; readonly session: "valid" }
  | { readonly kind: "reconciliation_required"; readonly session: "invalidated" };

function classifyVerification(result: VerificationResult): ReconciliationDecision {
  return result.kind === "verified"
    ? { kind: "continue", session: "valid" }
    : { kind: "reconciliation_required", session: "invalidated" };
}

function countedBrowser(browser: BrowserSession) {
  const calls = { mutation: 0, navigation: 0 };
  const port: BrowserSession = {
    start: (request, abort) => browser.start(request, abort),
    close: (request, abort) => browser.close(request, abort),
    observe: (request, abort) => browser.observe(request, abort),
    mutate: (request, abort) => {
      calls.mutation += 1;
      return browser.mutate(request, abort);
    },
    navigate: (request, abort) => {
      calls.navigation += 1;
      return browser.navigate(request, abort);
    },
  };
  return { port, calls };
}

for (const scenario of [
  {
    name: "rejected",
    alter: async (page: import("playwright").Page) => {
      await page.locator('[data-hunt-target-token="target-s1-field-given-name"]').fill("Changed");
    },
    expected: {
      kind: "rejected",
      fieldId: "s1-field-given-name",
      reason: "mismatch",
    },
  },
  {
    name: "ambiguous",
    alter: async (page: import("playwright").Page) => {
      await page.locator('[data-hunt-target-token="target-s1-field-given-name"]').evaluate((element) => {
        element.parentElement?.append(element.cloneNode(true));
      });
    },
    expected: {
      kind: "ambiguous",
      fieldId: "s1-field-given-name",
    },
  },
  {
    name: "unavailable",
    alter: async (page: import("playwright").Page) => {
      await page.locator('[data-hunt-target-token="target-s1-field-given-name"]').evaluate((element) => element.remove());
    },
    expected: {
      kind: "unavailable",
      fieldId: "s1-field-given-name",
    },
  },
] as const) {
  test(`final ${scenario.name} readback requires reconciliation with no later effect`, async () => {
    const opened = await openInteractionFixture(`readback-${scenario.name}`);
    const counted = countedBrowser(opened.browser);
    const page = await understand(opened.browser, opened.session);
    const field = page.snapshot.fields.find(({ fieldId }) => fieldId === "s1-field-given-name");
    assert.ok(field !== undefined);
    const intent = await resolveField(answerContext(`readback-${scenario.name}`), field);
    const receipt = value(await createFieldDriver(counted.port, admittingSafety().port).drive({
      journeyId: interactionJourneyId,
      sessionId: opened.session.sessionId,
      pageId: opened.session.pageId,
      guardRevision: interactionRevision,
      operationId: operationId(1_000),
      intent,
    }, signal));

    try {
      const browserPage = opened.context.pages()[0];
      assert.ok(browserPage !== undefined);
      await scenario.alter(browserPage);
      const verification = value(await createFieldVerifier(
        counted.port,
        { maxAttempts: 1 },
      ).verify({
        sessionId: opened.session.sessionId,
        pageId: opened.session.pageId,
        intent,
        receipt,
      }, signal));
      assert.deepEqual(verification, scenario.expected);
      assert.deepEqual(classifyVerification(verification), {
        kind: "reconciliation_required",
        session: "invalidated",
      });
      assert.deepEqual(counted.calls, { mutation: 1, navigation: 0 });
    } finally {
      await opened.close();
    }
  });
}

test("in-effect listbox cancellation invalidates the old session and stops effects", async () => {
  const opened = await openInteractionFixture("uncertain-cancel", "/profile", 2_000);
  const counted = countedBrowser(opened.browser);
  const page = await understand(opened.browser, opened.session);
  const field = page.snapshot.fields.find(({ fieldId }) => fieldId === "s1-field-country");
  assert.ok(field !== undefined);
  const intent = await resolveField(answerContext("uncertain-cancel"), field);
  const browserPage = opened.context.pages()[0];
  assert.ok(browserPage !== undefined);
  await browserPage.getByRole("option", { name: "Canada", exact: true }).evaluate((element) => {
    element.addEventListener("click", () => {
      const start = performance.now();
      while (performance.now() - start < 1_000) {
        // Keep browser effect in flight until cancellation reaches F3.
      }
    });
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 25);

  try {
    const result = await createFieldDriver(counted.port, admittingSafety().port).drive({
      journeyId: interactionJourneyId,
      sessionId: opened.session.sessionId,
      pageId: opened.session.pageId,
      guardRevision: interactionRevision,
      operationId: operationId(1_100),
      intent,
    }, controller.signal);
    assert.deepEqual(result, {
      ok: false,
      error: providerError("browser_effect_uncertain"),
    });
    assert.deepEqual(
      await opened.browser.observe(opened.session, signal),
      { ok: false, error: providerError("browser_session_invalidated") },
    );
    assert.deepEqual(counted.calls, { mutation: 1, navigation: 0 });
    const decision = result.ok || result.error.code !== "browser_effect_uncertain"
      ? { kind: "continue", session: "valid" }
      : { kind: "reconciliation_required", session: "invalidated" };
    assert.deepEqual(decision, {
      kind: "reconciliation_required",
      session: "invalidated",
    });
  } finally {
    await opened.close();
  }
});

test("blocked validation rereads the same page without navigation", async () => {
  const opened = await openInteractionFixture("validation-reread");
  const counted = countedBrowser(opened.browser);
  try {
    const page = await understand(opened.browser, opened.session);
    const completion = value(await createCompletionNavigation().complete({
      page: page.snapshot,
      verification: [],
    }, signal));
    assert.equal(completion.kind, "blocked");
    if (completion.kind !== "blocked") throw new Error("empty page was not blocked");
    assert.deepEqual(
      [...completion.fieldIds].sort(),
      page.snapshot.fields.map(({ fieldId }) => fieldId).sort(),
    );
    const reread = value(await counted.port.observe(opened.session, signal));
    assert.equal(reread.pageId, opened.session.pageId);
    assert.equal(reread.targets.filter(({ required }) => required).every(({ readback }) =>
      readback.kind === "empty" ||
      (readback.kind === "selected" && readback.option === null) ||
      (readback.kind === "upload" && readback.resumeId === null)
    ), true);
    assert.deepEqual(counted.calls, { mutation: 0, navigation: 0 });
  } finally {
    await opened.close();
  }
});

test("tampered fixture destination is an illegal transition with no second navigation", async () => {
  const opened = await openInteractionFixture("illegal-transition");
  const counted = countedBrowser(opened.browser);
  const answers = answerContext("illegal-transition");
  const safety = admittingSafety();
  const driver = createFieldDriver(counted.port, safety.port);
  const verifier = createFieldVerifier(counted.port, { maxAttempts: 1 });

  try {
    const page = await understand(opened.browser, opened.session);
    const verification: VerificationResult[] = [];
    let next = 1_200;
    for (const field of page.snapshot.fields) {
      const intent = await resolveField(answers, field);
      const receipt = value(await driver.drive({
        journeyId: interactionJourneyId,
        sessionId: opened.session.sessionId,
        pageId: opened.session.pageId,
        guardRevision: interactionRevision,
        operationId: operationId(next += 1),
        intent,
      }, signal));
      verification.push(value(await verifier.verify({
        sessionId: opened.session.sessionId,
        pageId: opened.session.pageId,
        intent,
        receipt,
      }, signal)));
    }
    const completion = value(await createCompletionNavigation().complete({
      page: page.snapshot,
      verification,
    }, signal));
    assert.equal(completion.kind, "complete");
    if (completion.kind !== "complete" || completion.decision.kind !== "next") {
      throw new Error("profile was not complete");
    }
    const browserPage = opened.context.pages()[0];
    assert.ok(browserPage !== undefined);
    await browserPage.locator("form").evaluate((form) => form.setAttribute("action", "/review"));
    const admitted = navigationRequest(opened.session, next += 1);
    const moved = value(await counted.port.navigate(admitted, signal));
    const observedSession = {
      sessionId: opened.session.sessionId,
      pageId: moved.pageId,
    };
    const observed = await understand(opened.browser, observedSession);
    const reconciled = value(await createCompletionNavigation().reconcile({
      operationId: admitted.snapshot.effect.operationId,
      decision: completion.decision,
      observation: moved,
      sourcePage: page.snapshot.pageIdentity,
      expected: { kind: "workday", page: "questionnaire" },
      observed: observed.snapshot.pageIdentity,
    }, signal));
    assert.deepEqual(reconciled, {
      kind: "illegal_transition",
      expected: { kind: "workday", page: "questionnaire" },
      observed: { kind: "workday", page: "review" },
    });
    assert.deepEqual(counted.calls, {
      mutation: page.snapshot.fields.length,
      navigation: 1,
    });
  } finally {
    await opened.close();
  }
});

test("three resets clear visible faults and retain one semantic reset hash", async () => {
  const fixture = new FixtureServer(resolve("fixtures/workday/s1"));
  const run = fixtureRunId("interaction-reset");
  const started = value(await fixture.start({ fixtureRunId: run }, signal));
  const hashes: string[] = [];
  const engine = await chromium.launch();
  const page = await engine.newPage();

  try {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      value(await fixture.setFault({ fixtureRunId: run, fault: "component_failure" }, signal));
      const fault = await page.goto(`${started.origin}/profile`, { waitUntil: "domcontentloaded" });
      assert.equal(fault?.status(), 503);
      hashes.push(value(await fixture.reset({ fixtureRunId: run }, signal)).semanticHash);
      const restored = await page.goto(`${started.origin}/profile`, { waitUntil: "domcontentloaded" });
      assert.equal(restored?.status(), 200);
      assert.equal(await page.getByRole("heading", { name: "Applicant profile" }).count(), 1);
    }
    assert.equal(new Set(hashes).size, 1);
  } finally {
    await page.close();
    await engine.close();
    await fixture.close();
  }
});
