import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { UploadedArtifactReadback } from "../../../src/browser/adapter.ts";
import { PlaywrightBrowserSession } from "../../../src/browser/session.ts";
import { createFieldDriver } from "../../../src/interaction/drivers/registry.ts";
import { createFieldVerifier } from "../../../src/interaction/verification/field-verifier.ts";
import { createSafetyGuard } from "../../../src/safety/guards.ts";
import {
  createConfiguredNarrativeProvider, createQuestionnairePageHandler,
} from "../../../src/ats/workday/application/questions/index.ts";
import {
  useResumeArtifactUpload, boundedText, browserPageId, browserTargetToken, fieldId, guardRevision, journeyId,
  upstreamProfileId, type BrowserSessionId, type OperationId, type UnknownCandidateId,
} from "../../../src/contracts/index.ts";
import { createResumeArtifactFixture } from "../../../src/testing/contracts/index.ts";
import { testIds } from "../playwright-fixture.ts";
import { createQuestionnaireSemanticAuthority } from "../../../src/browser/playwright-live/private/questionnaire-semantic-authority.ts";

import { questionnaireTargetPresent } from "../../../src/browser/playwright-live/private/workday-application-runtime.ts";
import { createQuestionAnswerLearningCapture } from "../../../src/live/evidence/question-answer-learning.ts";
import { liveApplicationExecutionPolicy } from "../../../src/contracts/application-execution-policy.ts";

test("questionnaire upload verifies through a separate browser authority after native input clears", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const evidenceRoot = await mkdtemp(join(tmpdir(), "hunt-upload-learning-browser-"));
  const learning = createQuestionAnswerLearningCapture({ root: evidenceRoot,
    mode: "synthetic_test_non_submittable",
    executionPolicy: liveApplicationExecutionPolicy("synthetic_test_non_submittable") });
  try {
    await page.setContent(`<html data-hunt-page-id="page-upload"><body>
      <div data-automation-id="formField-upload">
        <label id="upload-label">Please upload your transcript.</label>
        <div data-automation-id="question-FileUpload" aria-labelledby="upload-label">
          <button type="button">Select files</button>
          <input type="file" required aria-labelledby="upload-label" data-hunt-target-token="target-upload" style="display:none">
        </div>
      </div></body></html>`);
    await page.locator('input').evaluate(node => {
      const element = node as HTMLInputElement;
      element.onchange = () => {
        const name = element.files![0]!.name;
        element.value = "";
        setTimeout(() => element.parentElement!.insertAdjacentHTML("beforeend",
          `<div data-automation-id="file-upload-item"><span data-automation-id="file-upload-item-name">${name}</span><span data-automation-id="file-upload-successful">Successfully Uploaded!</span></div>`), 50);
      };
    });
    const sessionId = "browser_session_questionnaire_upload" as BrowserSessionId;
    const pageId = browserPageId("page-upload");
    const uploadedArtifacts = new Map<string, UploadedArtifactReadback>();
    const makeSession = () => new PlaywrightBrowserSession({
      attached: { page, sessionId, pageId, uploadedArtifacts }, ids: testIds(), timeoutMs: 5000,
    });
    const authority = createQuestionnaireSemanticAuthority({
      sessionId, pageId, createDriverBrowser: makeSession, verifierBrowser: makeSession(),
      captureUploadArtifact: createResumeArtifactFixture,
      createDriver: browser => createFieldDriver(browser, createSafetyGuard()),
      createVerifier: createFieldVerifier, prepare: async () => {},
    });
    let attempts = 0;
    const handler = createQuestionnairePageHandler({
      profileQuery: { async query() { return { ok: true as const, value: { kind: "profile_answer_missing" as const } }; } },
      narrative: createConfiguredNarrativeProvider({ revision: "upload-v1", template: undefined }),
      nextOperationId: () => `operation_upload_${String(++attempts).padStart(16, "0")}` as OperationId,
      allocateCandidateId: () => "unknown_candidate_upload" as UnknownCandidateId,
      observationFor: () => undefined,
      fieldPresent: field => questionnaireTargetPresent(page, field.target),
      driver: authority.driver, verifier: authority.verifier,
      recordAttempt: input => {
        learning.recordAttempt(input);
        learning.monitorAck({ operationId: input.operationId, attempt: 1, moment: "before_mutation" });
      },
      recordAnswer: input => {
        learning.monitorAck({ operationId: input.operationId, attempt: 1, moment: "after_readback" });
        learning.record(input);
      },
    });
    const resume = createResumeArtifactFixture();
    assert.ok((await useResumeArtifactUpload(resume, () => ({ ok: true as const, value: undefined }))).ok);
    const result = await handler.complete({
      mode: "synthetic_test_non_submittable", answerFallbackPolicy: "deterministic_site_valid_editable",
      journeyId: journeyId("journey_questionnaire_upload_1"),
      sessionId, pageId, guardRevision: guardRevision("policy-s1"),
      profileId: upstreamProfileId("profile-upload"), profileRevision: 1,
      resume: { resumeId: resume.resumeId, sha256: resume.sha256 }, resumeArtifact: resume,
      page: { pageIdentity: { kind: "workday", page: "questionnaire" }, fields: [{
        fieldId: fieldId("field-upload"), target: browserTargetToken("target-upload"),
        label: boundedText("Please upload your transcript."), required: true, behavior: "file_upload",
        options: [], state: "empty",
      }] },
    }, new AbortController().signal);
    assert.equal(attempts, 1);
    assert.equal(await page.locator('input').evaluate(element => (element as HTMLInputElement).files!.length), 0);
    assert.equal(result.ok && result.value.kind, "verified", JSON.stringify(result));
    assert.match(learning.write() ?? "", /^[0-9a-f]{64}$/u);
    const learned = JSON.parse(await readFile(join(evidenceRoot, "question-answer-learning.json"), "utf8"));
    assert.equal(learned.questions[0].strategy, "resume");
    assert.equal(learned.questions[0].terminalDisposition, "verified");
    assert.equal(learned.questions[0].replaceWithOwnerAnswer, true);
    const pending = JSON.parse(await readFile(join(evidenceRoot, "pending-profile-questions.json"), "utf8"));
    assert.equal(pending.pendingProfileQuestions[0].needsUserValue, true);
    await authority.close(new AbortController().signal);
    const fresh = makeSession();
    const observed = await fresh.observe({ sessionId, pageId }, new AbortController().signal);
    assert.ok(observed.ok);
    assert.deepEqual(observed.value.targets[0]?.readback, { kind: "upload", resumeId: resume.resumeId, sha256: resume.sha256 });
    await page.locator('[data-automation-id="file-upload-item-name"]').evaluate(element => { element.textContent = "different.pdf"; });
    const changed = await fresh.observe({ sessionId, pageId }, new AbortController().signal);
    assert.ok(changed.ok);
    assert.deepEqual(changed.value.targets[0]?.readback, { kind: "unavailable" });
    await fresh.close({ sessionId }, new AbortController().signal);
  } finally { await browser.close(); await rm(evidenceRoot, { recursive: true, force: true }); }
});
