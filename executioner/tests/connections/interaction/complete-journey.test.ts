import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  captureResumeArtifact,
  disposeResumeArtifact,
  upstreamResumeId,
  type BrowserSessionResult,
  type VerificationResult,
} from "../../../src/contracts/index.ts";
import { createFieldDriver } from "../../../src/interaction/drivers/registry.ts";
import { createCompletionNavigation } from "../../../src/interaction/navigation/completion-navigation.ts";
import { createFieldVerifier } from "../../../src/interaction/verification/field-verifier.ts";
import { requiredFieldFlowCases } from "../../../src/testing/contracts/field-flow-cases.ts";
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

test("all frozen controls reach Review through independent real readback", async () => {
  const opened = await openInteractionFixture("complete");
  const answers = answerContext("complete");
  const safety = admittingSafety();
  const driver = createFieldDriver(opened.browser, safety.port);
  const verifier = createFieldVerifier(opened.browser, { maxAttempts: 1 });
  const navigation = createCompletionNavigation();
  const fieldResults: Array<{
    readonly fieldId: string;
    readonly behavior: string;
    readonly verification: VerificationResult;
  }> = [];
  let session: BrowserSessionResult = opened.session;
  let nextOperation = 100;

  try {
    for (const expectedPage of ["profile", "questionnaire"] as const) {
      const page = await understand(opened.browser, session);
      assert.deepEqual(page.snapshot.pageIdentity, {
        kind: "workday",
        page: expectedPage,
      });
      const verification: VerificationResult[] = [];

      for (const field of page.snapshot.fields) {
        const intent = await resolveField(answers, field);
        const receipt = value(await driver.drive({
          journeyId: interactionJourneyId,
          sessionId: session.sessionId,
          pageId: session.pageId,
          guardRevision: interactionRevision,
          operationId: operationId(nextOperation += 1),
          intent,
        }, signal));
        assert.deepEqual(Object.keys(receipt).sort(), [
          "attempted",
          "behavior",
          "fieldId",
          "operationId",
        ]);

        if (intent.kind === "resume_upload") {
          const wrongBytes = new TextEncoder().encode("different verified resume");
          const wrongArtifact = value(captureResumeArtifact({
            resumeId: upstreamResumeId("resume-interaction-complete"),
            sha256: createHash("sha256").update(wrongBytes).digest("hex"),
          }, wrongBytes));
          const wrongDigest = value(await verifier.verify({
            sessionId: session.sessionId,
            pageId: session.pageId,
            intent: { ...intent, artifact: wrongArtifact },
            receipt,
          }, signal));
          assert.deepEqual(wrongDigest, {
            kind: "rejected",
            fieldId: intent.fieldId,
            reason: "mismatch",
          });
          value(disposeResumeArtifact(wrongArtifact));
        }

        const checked = value(await verifier.verify({
          sessionId: session.sessionId,
          pageId: session.pageId,
          intent,
          receipt,
        }, signal));
        assert.deepEqual(checked, {
          kind: "verified",
          fieldId: field.fieldId,
        });
        verification.push(checked);
        fieldResults.push({
          fieldId: field.fieldId,
          behavior: field.behavior,
          verification: checked,
        });
      }

      const completion = value(await navigation.complete({
        page: page.snapshot,
        verification,
      }, signal));
      assert.equal(completion.kind, "complete");
      if (completion.kind !== "complete" || completion.decision.kind !== "next") {
        throw new Error("filled page was not approved for navigation");
      }
      const admitted = navigationRequest(session, nextOperation += 1);
      const moved = value(await opened.browser.navigate(admitted, signal));
      const nextSession = {
        sessionId: session.sessionId,
        pageId: moved.pageId,
      };
      const nextPage = await understand(opened.browser, nextSession);
      const reconciled = value(await navigation.reconcile({
        operationId: admitted.snapshot.effect.operationId,
        decision: completion.decision,
        observation: moved,
        sourcePage: page.snapshot.pageIdentity,
        expected: {
          kind: "workday",
          page: completion.decision.expectedPage,
        },
        observed: nextPage.snapshot.pageIdentity,
      }, signal));
      assert.equal(
        reconciled.kind,
        completion.decision.expectedPage === "review" ? "review_reached" : "advanced",
      );
      session = nextSession;
    }

    assert.deepEqual(
      fieldResults
        .map(({ fieldId, behavior, verification }) => ({
          fieldId,
          behavior,
          verification: verification.kind,
        }))
        .sort((left, right) => left.fieldId.localeCompare(right.fieldId)),
      requiredFieldFlowCases
        .map(({ fieldId, behavior }) => ({
          fieldId,
          behavior,
          verification: "verified",
        }))
        .sort((left, right) => left.fieldId.localeCompare(right.fieldId)),
    );

    const review = await understand(opened.browser, session);
    assert.deepEqual(review.snapshot.pageIdentity, {
      kind: "workday",
      page: "review",
    });
    assert.deepEqual(
      value(await navigation.complete({
        page: review.snapshot,
        verification: [],
      }, signal)),
      { kind: "complete", decision: { kind: "stop_review" } },
    );
    const observedReview = value(await opened.browser.observe(session, signal));
    assert.equal(observedReview.targets.some(({ name }) => /submit/iu.test(name)), false);
    const browserPage = opened.context.pages()[0];
    assert.ok(browserPage !== undefined);
    assert.equal(await browserPage.getByRole("button", { name: /submit application/iu }).isDisabled(), true);
    assert.equal(safety.calls.length, requiredFieldFlowCases.length);
  } finally {
    await opened.close();
  }
});

test("a driver receipt cannot hide a changed real DOM value", async () => {
  const opened = await openInteractionFixture("false-success");
  const answers = answerContext("false-success");
  const page = await understand(opened.browser, opened.session);
  const field = page.snapshot.fields.find(({ fieldId }) => fieldId === "s1-field-given-name");
  assert.ok(field !== undefined);
  const intent = await resolveField(answers, field);
  const receipt = value(await createFieldDriver(
    opened.browser,
    admittingSafety().port,
  ).drive({
    journeyId: interactionJourneyId,
    sessionId: opened.session.sessionId,
    pageId: opened.session.pageId,
    guardRevision: interactionRevision,
    operationId: operationId(900),
    intent,
  }, signal));

  try {
    const browserPage = opened.context.pages()[0];
    assert.ok(browserPage !== undefined);
    await browserPage.locator('[data-hunt-target-token="target-s1-field-given-name"]').fill("Changed after receipt");
    assert.deepEqual(
      value(await createFieldVerifier(opened.browser, { maxAttempts: 1 }).verify({
        sessionId: opened.session.sessionId,
        pageId: opened.session.pageId,
        intent,
        receipt,
      }, signal)),
      {
        kind: "rejected",
        fieldId: "s1-field-given-name",
        reason: "mismatch",
      },
    );
  } finally {
    await opened.close();
  }
});
