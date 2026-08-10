import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { chromium } from "playwright";

import {
  createApplicationLaneHandlers,
  createImmutableApplicationLaneSources,
} from "../../../src/ats/workday/application/lane-composition.ts";
import { runApplicationPageWalk } from "../../../src/ats/workday/application/page-walk.ts";
import {
  PlaywrightWorkdayApplicationPage,
} from "../../../src/ats/workday/application/playwright-page.ts";
import {
  PlaywrightWorkdayProfilePage,
} from "../../../src/ats/workday/application/profile/index.ts";
import {
  createConfiguredNarrativeProvider,
  createQuestionnairePageHandler,
  type QuestionnairePageRequest,
} from "../../../src/ats/workday/application/questions/index.ts";
import {
  createWorkdayResumeFileIntent,
  createPlaywrightWorkdayResumePage,
  createWorkdayResumeUploadDriver,
  createWorkdayResumeUploadHandler,
  createWorkdayResumeVerifier,
} from "../../../src/ats/workday/application/resume/index.ts";
import {
  browserPageId,
  browserTargetToken,
  boundedText,
  captureResumeArtifact,
  fieldId,
  guardRevision,
  optionId,
  upstreamProfileId,
  upstreamResumeId,
  type BrowserSessionId,
  type FieldDriver,
  type FieldVerifier,
  type OperationId,
  type ProfileQuery,
} from "../../../src/contracts/index.ts";
import type { UnknownCandidateId } from "../../../src/contracts/live/index.ts";
import { walkFixture } from "./fixtures.ts";

test("walks a real Playwright page through the three verified lanes to pre-Review", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><body></body>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server failed");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.setContent('<body data-hunt-application-page="profile" data-hunt-page-id="s2-profile"></body>');
    await page.evaluate((pages) => {
      const render = (name: keyof typeof pages) => {
        document.body.removeAttribute("data-hunt-application-page");
        document.body.removeAttribute("data-hunt-page-id");
        document.body.innerHTML = pages[name];
      };
      document.addEventListener("change", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.type !== "file") return;
        const item = document.createElement("div");
        item.setAttribute("data-automation-id", "file-upload-item");
        item.innerHTML = '<span data-automation-id="file-upload-success"></span><button type="button" data-automation-id="delete-file" aria-label="Delete file"></button>';
        target.parentElement?.append(item);
      });
      document.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLButtonElement) || target.dataset.action !== "next") return;
        const current = document.querySelector(
          'input[type="file"][data-automation-id="file-upload-input-ref"]',
        ) !== null ? "resume" : document.querySelector(
          '[data-automation-id="applyFlowApplicationQuestionsPage"]',
        ) !== null ? "questionnaire" : "profile";
        render(current === "profile"
          ? "resume"
          : current === "resume"
            ? "questionnaire"
            : "pre_review");
      });
      render("profile");
    }, fixturePages());

    const sources = applicationSources();
    const questionnaire = questionnaireHandler();
    const applicationPage = new PlaywrightWorkdayApplicationPage(page);
    const resumePage = createPlaywrightWorkdayResumePage(page);
    const resumeDriver = createWorkdayResumeUploadDriver(resumePage);
    const resumeVerifier = createWorkdayResumeVerifier(resumePage);
    const resumeHandler = createWorkdayResumeUploadHandler({
      driver: resumeDriver,
      verifier: resumeVerifier,
      replaceExisting: true,
    });
    const progress: string[] = [];
    const result = await runApplicationPageWalk({
      observer: applicationPage,
      handlers: createApplicationLaneHandlers({
        sources,
        resume: {
          async upload(intent, signal) {
            const lane = await resumeHandler.upload(intent, signal);
            assert.equal(lane.ok, true, JSON.stringify(lane));
            return lane;
          },
        },
        profilePage: new PlaywrightWorkdayProfilePage(page, {
          pageType: "profile",
        }),
        questionnaire,
      }),
      navigation: applicationPage,
      progress: {
        async record(value) {
          progress.push(value.checkpoint);
          return { ok: true, value: undefined };
        },
      },
    }, {
      journeyId: walkFixture.journeyId,
      stopAfter: "pre_review",
    }, new AbortController().signal);

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.checkpoint, "pre_review");
    assert.deepEqual(progress, [
      "profile_verified",
      "resume_verified",
      "questionnaire_verified",
      "pre_review",
    ]);
    assert.equal(await page.locator('[data-automation-id="applyFlowReviewPage"]').count(), 1);
    assert.equal(await page.locator('button[type="submit"]').count(), 0);
  } finally {
    await page.close();
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error === undefined ? resolve() : reject(error)
    ));
  }
});

function fixturePages() {
  return {
    resume: `
      <main data-automation-id="applyFlowMyInfoPage">
        <div>
          <input type="file" required data-hunt-field-id="resume-artifact" data-automation-id="file-upload-input-ref">
        </div>
        <button type="button" data-action="next">Next</button>
      </main>`,
    profile: `
      <main data-automation-id="applyFlowMyInfoPage">
        <input required data-hunt-field-id="contact-email" data-automation-id="legalNameSection_firstName">
        <button type="button" data-action="next">Next</button>
      </main>`,
    questionnaire: `
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <label><input type="radio" required checked data-hunt-field-id="authorization-answer" name="authorization">Yes</label>
        <button type="button" data-action="next">Save and Continue</button>
      </main>`,
    pre_review: '<main data-automation-id="applyFlowReviewPage"><h1>Review</h1></main>',
  } as const;
}

function applicationSources() {
  const bytes = new TextEncoder().encode("S2 F3 Playwright resume fixture");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const resumeId = upstreamResumeId("resume-s2-f3-playwright");
  const artifact = captureResumeArtifact({ resumeId, sha256 }, bytes);
  assert.equal(artifact.ok, true);
  if (!artifact.ok) throw new Error("fixture artifact failed");
  const intent = createWorkdayResumeFileIntent({
    artifactId: resumeId,
    artifact: artifact.value,
    fileType: "pdf",
  });
  assert.equal(intent.ok, true);
  if (!intent.ok) throw new Error("fixture intent failed");
  const questionField = {
    fieldId: fieldId("authorization-answer"),
    target: browserTargetToken("target-authorization-answer"),
    label: boundedText("Are you authorized to work in this location?"),
    required: true,
    behavior: "radio" as const,
    state: "empty" as const,
    options: [
      { id: optionId("authorization-yes"), label: boundedText("Yes") },
      { id: optionId("authorization-no"), label: boundedText("No") },
    ],
  };
  const questionnaireRequest = {
    journeyId: walkFixture.journeyId,
    sessionId: "browser_session_s2f3playwright01" as BrowserSessionId,
    pageId: walkFixture.pages.questionnaire,
    guardRevision: guardRevision("guard-s2-f3-playwright"),
    profileId: upstreamProfileId("profile-s2-f3-playwright"),
    profileRevision: 1,
    resume: { resumeId, sha256 },
    resumeArtifact: artifact.value,
    page: {
      pageIdentity: { kind: "workday", page: "questionnaire" } as const,
      fields: [questionField],
    },
  } as unknown as QuestionnairePageRequest;
  return createImmutableApplicationLaneSources({
    resumeIntent: intent.value,
    profilePlan: {
      pageType: "profile",
      fields: [{
        fieldId: "identity.given_name",
        questionType: "identity",
        answerType: "text",
        answer: { kind: "answered", value: "Ada", provenance: "owner_provided" },
      }],
      repeatables: [],
    },
    questionnaireRequest,
  });
}

function questionnaireHandler() {
  const profileQuery: ProfileQuery = {
    async query() {
      return {
        ok: true,
        value: { kind: "answered", value: true, provenance: "owner_provided" },
      };
    },
  };
  const driver: FieldDriver = {
    async drive(request) {
      return {
        ok: true,
        value: {
          operationId: request.operationId,
          fieldId: request.intent.fieldId,
          behavior: request.intent.behavior,
          attempted: true,
        },
      };
    },
  };
  const verifier: FieldVerifier = {
    async verify(request) {
      return {
        ok: true,
        value: { kind: "verified", fieldId: request.intent.fieldId },
      };
    },
  };
  let operation = 0;
  return createQuestionnairePageHandler({
    profileQuery,
    driver,
    verifier,
    narrative: createConfiguredNarrativeProvider({
      revision: "narrative-s2-f3-playwright-v1",
      template: "Approved fixture narrative.",
    }),
    nextOperationId() {
      operation += 1;
      return `operation_s2f3_playwright_${operation.toString().padStart(16, "0")}` as OperationId;
    },
    allocateCandidateId() {
      return "unknown_candidate_s2f3_playwright" as UnknownCandidateId;
    },
    observationFor() {
      return undefined;
    },
  });
}
