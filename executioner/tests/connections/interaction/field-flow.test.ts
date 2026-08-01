import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import { createWorkdayPageUnderstanding } from "../../../src/ats/workday/page-understanding.ts";
import { PlaywrightBrowserSession } from "../../../src/browser/session.ts";
import {
  admitContractSnapshot,
  captureResumeArtifact,
  createGeneratedIdAllocator,
  fixtureRunId,
  generatedOperationId,
  guardRevision,
  journeyId,
  upstreamProfileId,
  upstreamResumeId,
} from "../../../src/contracts/index.ts";
import { createAnswerResolver } from "../../../src/form/answers/resolver.ts";
import { createFieldDriver } from "../../../src/interaction/drivers/registry.ts";
import { createFieldVerifier } from "../../../src/interaction/verification/field-verifier.ts";
import { createProfileQuery } from "../../../src/profile/profile.ts";
import { FixtureServer } from "../../../src/testing/fixture-server.ts";
import { createSafetyGuardFake } from "../../../src/testing/contracts/index.ts";

const fixtureRoot = resolve("fixtures/workday/s1");
const signal = new AbortController().signal;
const connectionJourneyId = journeyId("journey_4444444444444444");
const revision = guardRevision("policy-s1");

function value<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("expected provider success");
  return result.value;
}

test("real custom-listbox mutation is independently readable", async () => {
  let nextId = 0;
  const fixture = new FixtureServer(fixtureRoot);
  const engine = await chromium.launch();
  const context = await engine.newContext();
  const browser = new PlaywrightBrowserSession({
    context,
    ids: createGeneratedIdAllocator({
      next: () => String(nextId += 1).padStart(16, "0"),
    }),
  });
  const startedFixture = value(await fixture.start({
    fixtureRunId: fixtureRunId("interaction-listbox"),
  }, signal));
  const startedBrowser = value(await browser.start({
    journeyId: connectionJourneyId,
    target: `${startedFixture.origin}/profile`,
  }, signal));

  try {
    const observation = value(await browser.observe(startedBrowser, signal));
    const understood = value(await createWorkdayPageUnderstanding().understand({ observation }, signal));
    assert.equal(understood.kind, "understood");
    if (understood.kind !== "understood") throw new Error("profile was not understood");
    const field = understood.snapshot.fields.find(({ fieldId }) => fieldId === "s1-field-country");
    assert.ok(field !== undefined);

    const bytes = new TextEncoder().encode("synthetic listbox resume");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const selection = { resumeId: upstreamResumeId("resume_interaction_listbox"), sha256 };
    const artifact = value(captureResumeArtifact(selection, bytes));
    const resolver = createAnswerResolver(createProfileQuery({
      profileId: upstreamProfileId("profile-interaction-listbox"),
      revision: 1,
      facts: [{ factId: "country", value: "Canada", provenance: "owner_provided" }],
    }), "unused narrative");
    const resolved = value(await resolver.resolve({
      field,
      profileId: upstreamProfileId("profile-interaction-listbox"),
      profileRevision: 1,
      resume: selection,
      resumeArtifact: artifact,
    }, signal));
    assert.equal(resolved.kind, "resolved");
    if (resolved.kind !== "resolved") throw new Error("country was not resolved");

    const safety = createSafetyGuardFake({
      admit: (request) => admitContractSnapshot(
        request.input,
        "safety",
        request.binding,
      ) as never,
    });
    const receipt = value(await createFieldDriver(browser, safety.port).drive({
      journeyId: connectionJourneyId,
      sessionId: startedBrowser.sessionId,
      pageId: startedBrowser.pageId,
      guardRevision: revision,
      operationId: generatedOperationId("operation_4444444444444444"),
      intent: resolved.intent,
    }, signal));
    const verified = value(await createFieldVerifier(browser, { maxAttempts: 1 }).verify({
      sessionId: startedBrowser.sessionId,
      pageId: startedBrowser.pageId,
      intent: resolved.intent,
      receipt,
    }, signal));

    assert.deepEqual(verified, {
      kind: "verified",
      fieldId: "s1-field-country",
    });
  } finally {
    await browser.close({ sessionId: startedBrowser.sessionId }, signal);
    await fixture.close();
    await context.close();
    await engine.close();
  }
});
