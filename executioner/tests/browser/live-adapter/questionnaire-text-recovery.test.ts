import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { PlaywrightBrowserSession } from "../../../src/browser/session.ts";
import { createFieldDriver } from "../../../src/interaction/drivers/registry.ts";
import { createFieldVerifier } from "../../../src/interaction/verification/field-verifier.ts";
import { createSafetyGuard } from "../../../src/safety/guards.ts";
import {
  createConfiguredNarrativeProvider, createQuestionnairePageHandler,
} from "../../../src/ats/workday/application/questions/index.ts";
import {
  boundedText, browserPageId, browserTargetToken, fieldId, guardRevision, journeyId,
  upstreamProfileId, type BrowserSessionId, type OperationId, type UnknownCandidateId,
} from "../../../src/contracts/index.ts";
import { createResumeArtifactFixture } from "../../../src/testing/contracts/index.ts";
import { testIds } from "../playwright-fixture.ts";

test("real questionnaire text remount recovers once and repeated loss remains blocked", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const behavior of ["text", "textarea"] as const) {
      for (const losses of [1, 2]) {
        const page = await browser.newPage();
        const tag = behavior === "text" ? "input" : "textarea";
        await page.setContent(`<html data-hunt-page-id="page-recovery"><body>
          <label>Expected weekly hours<${tag} data-hunt-target-token="target-hours"></${tag}></label>
          <button>Continue</button></body></html>`);
        const sessionId = "browser_session_questionnaire_recovery" as BrowserSessionId;
        const pageId = browserPageId("page-recovery");
        const makeSession = () => new PlaywrightBrowserSession({
          attached: { page, sessionId, pageId }, ids: testIds(), timeoutMs: 5_000,
        });
        const driverBrowser = makeSession();
        const verifierBrowser = makeSession();
        const driver = createFieldDriver(driverBrowser, createSafetyGuard());
        const verifier = createFieldVerifier(verifierBrowser);
        let attempts = 0;
        let remainingLosses = losses;
        const failures: boolean[] = [];
        const handler = createQuestionnairePageHandler({
          profileQuery: { async query() { return { ok: true as const, value: { kind: "profile_answer_missing" as const } }; } },
          narrative: createConfiguredNarrativeProvider({ revision: "recovery-v1", template: undefined }),
          nextOperationId: () => `operation_recovery_${String(++attempts).padStart(16, "0")}` as OperationId,
          allocateCandidateId: () => "unknown_candidate_recovery" as UnknownCandidateId,
          observationFor: () => undefined,
          fieldPresent: async () => await page.locator('[data-hunt-target-token="target-hours"]').count() === 1,
          recordFailure: ({ retryable }) => { failures.push(retryable); },
          driver: { async drive(input, signal) {
            await driverBrowser.observe({ sessionId, pageId }, signal);
            return driver.drive(input, signal);
          } },
          verifier: { async verify(input, signal) {
            if (remainingLosses-- > 0) {
              // Replace the field after mutation completed, before the independent readback.
              await page.locator('[data-hunt-target-token="target-hours"]').evaluate(element => {
                const replacement = element.cloneNode(true) as HTMLInputElement | HTMLTextAreaElement;
                replacement.value = "";
                element.replaceWith(replacement);
              });
            }
            return verifier.verify(input, signal);
          } },
        });
        const resume = createResumeArtifactFixture();
        const result = await handler.complete({
          mode: "synthetic_test_non_submittable", answerFallbackPolicy: "deterministic_site_valid_editable",
          journeyId: journeyId("journey_questionnaire_recovery_1"),
          sessionId, pageId, guardRevision: guardRevision("policy-s1"),
          profileId: upstreamProfileId("profile-recovery"), profileRevision: 1,
          resume: { resumeId: resume.resumeId, sha256: resume.sha256 }, resumeArtifact: resume,
          page: { pageIdentity: { kind: "workday", page: "questionnaire" }, fields: [{
            fieldId: fieldId("field-hours"), target: browserTargetToken("target-hours"),
            label: boundedText("Expected weekly hours"), required: false, behavior,
            options: [], state: "empty",
          }] },
        }, new AbortController().signal);
        assert.equal(result.ok && result.value.kind, losses === 1 ? "verified" : "blocked", JSON.stringify(result));
        assert.equal(attempts, 2);
        assert.deepEqual(failures, losses === 1 ? [true] : [true, false]);
        assert.equal(await page.locator(tag).inputValue(), losses === 1 ? "40" : "");
        await driverBrowser.close({ sessionId }, new AbortController().signal);
        await verifierBrowser.close({ sessionId }, new AbortController().signal);
        await page.close();
      }
    }
  } finally { await browser.close(); }
});
