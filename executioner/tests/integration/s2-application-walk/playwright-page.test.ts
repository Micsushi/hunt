import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { chromium } from "playwright";

import {
  createApplicationLaneHandlers,
  createApplicationLaneAcceptanceCollector,
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

test("Intermountain retained Profile button selects agree with the completion gate", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-application-page="profile" data-hunt-page-id="intermountain-profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <div data-automation-id="formField-country">
            <label>Country<span data-automation-id="required">*</span></label>
            <button id="country--country" type="button" aria-required="true"
              aria-describedby="country-description">Canada</button>
            <span id="country-description">Select your country of residence.</span>
            <input style="display:none">
          </div>
          <label>City<input id="addresss--city" name="city" value="Edmonton"></label>
          <div data-automation-id="formField-phoneNumber--phoneType">
            <label>Phone Device Type<span data-automation-id="required">*</span></label>
            <button data-automation-id="phoneNumber--phoneType" type="button"
              aria-required="true">Mobile</button>
            <input style="display:none">
          </div>
          <button id="continue" type="button">Save and Continue</button>
        </main>
        <script>
          document.querySelector('#continue').addEventListener('click', () => {
            document.body.dataset.huntApplicationPage = 'questionnaire';
            document.body.dataset.huntPageId = 'intermountain-questionnaire';
            document.body.innerHTML = '<main data-automation-id="applyFlowApplicationQuestionsPage"><label><input type="radio" name="answer" required checked>Yes</label><button type="button">Save and Continue</button></main>';
          });
        </script>
      </body>
    `);

    const profile = await new PlaywrightWorkdayProfilePage(page, {
      pageType: "profile",
    }).inspect(new AbortController().signal);
    const readbacks = new Map(profile.controls.map(({ fieldId, readback }) => [fieldId, readback]));
    assert.equal(readbacks.get("address.country"), "Canada");
    assert.equal(readbacks.get("address.city"), "Edmonton");
    assert.equal(readbacks.get("phone.device_type"), "Mobile");

    const application = new PlaywrightWorkdayApplicationPage(page);
    const observed = await application.observe(new AbortController().signal);
    assert.equal(observed.ok, true, JSON.stringify(observed));
    if (!observed.ok) return;
    assert.deepEqual(observed.value.requiredFields, [
      { fieldId: "country--country", page: "profile", verification: "verified" },
      { fieldId: "phoneNumber--phoneType", page: "profile", verification: "verified" },
    ]);
    assert.deepEqual(await application.next({
      journeyId: walkFixture.journeyId,
      from: "profile",
      fromPageId: observed.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal), { ok: true, value: { advanced: true } });
  } finally {
    await browser.close();
  }
});

test("walks a real combined Resume/Profile page through both verified lanes", async () => {
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
      render("combined");
    }, fixturePages());

    const sources = applicationSources();
    const questionnaire = questionnaireHandler();
    const applicationPage = new PlaywrightWorkdayApplicationPage(page);
    const combined = await applicationPage.observe(new AbortController().signal);
    assert.equal(combined.ok, true, JSON.stringify(combined));
    if (!combined.ok) throw new Error("combined fixture observation failed");
    assert.deepEqual(combined.value.lanes, ["resume", "profile"]);
    assert.deepEqual(combined.value.requiredFields.map(({ page: lane }) => lane), [
      "resume", "profile",
    ]);
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
      "resume_verified",
      "profile_verified",
      "questionnaire_verified",
      "pre_review",
    ]);
    assert.deepEqual(result.value.pageChecks.map(({ page }) => page), [
      "resume", "profile", "questionnaire",
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

test("derives distinct stable questionnaire occurrences from physical Workday steps", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const render = async (step: string) => page.setContent(`
      <div data-automation-id="progressBarActiveStep">${step}</div>
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <h2>Application Questions</h2>
        <div data-automation-id="formField"><label for="shared">Repeated question*</label>
          <input id="shared" required value="committed"></div>
      </main>
    `);
    const application = new PlaywrightWorkdayApplicationPage(page);
    await render("Step 2 of 4");
    const first = await application.observe(new AbortController().signal);
    await render("Step 3 of 4");
    const second = await application.observe(new AbortController().signal);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(second.ok, true, JSON.stringify(second));
    if (!first.ok || !second.ok) return;
    assert.notEqual(first.value.pageId, second.value.pageId);
    assert.match(first.value.pageId, /^s2-questionnaire-[0-9a-f]{24}$/u);
    assert.match(second.value.pageId, /^s2-questionnaire-[0-9a-f]{24}$/u);
    const collector = createApplicationLaneAcceptanceCollector();
    for (const pageIdValue of [first.value.pageId, second.value.pageId]) {
      collector.record({
        schemaVersion: 1,
        checkpoint: "questionnaire_verified",
        answers: [{
          pageId: pageIdValue,
          fieldId: "repeated-question" as never,
          questionId: "observed-question-0123456789abcdef01234567" as never,
          provenance: "owner_provided",
          lane: "live_owner_fact",
          protectedCategory: null,
          templateRevision: null,
          verification: "independent",
        }],
        protectedPlaceholderCount: 0,
        independentlyVerified: true,
        submitActivated: false,
        privacyScan: "pass",
      });
    }
    const cumulative = collector.snapshot("pre_review");
    assert.equal(cumulative.length, 1);
    assert.equal(cumulative[0]?.checkpoint === "questionnaire_verified" &&
      cumulative[0].answers.length, 2);
    await render("Step 2 of 4");
    const rebound = await application.observe(new AbortController().signal);
    assert.equal(rebound.ok, true, JSON.stringify(rebound));
    if (rebound.ok) assert.equal(rebound.value.pageId, first.value.pageId);
  } finally {
    await browser.close();
  }
});

test("advances same-semantic questionnaire occurrence only after a proven Next transition", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div data-automation-id="progressBarActiveStep">Application Questions</div>
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField"><label for="repeated">Repeated question*</label>
          <input id="repeated" required value="committed"></div>
      </main>
      <button id="next" type="button">Save and Continue</button>
      <script>
        let phase = 0;
        document.addEventListener('click', event => {
          if (!(event.target instanceof HTMLButtonElement) || event.target.id !== 'next') return;
          const oldRoot = document.querySelector('main');
          const replacement = document.createElement('main');
          replacement.dataset.automationId = 'applyFlowApplicationQuestionsPage';
          if (phase === 0) {
            replacement.innerHTML = '<div data-automation-id="formField"><label for="repeated-remounted">Repeated question*</label><input id="repeated-remounted" required value="committed"></div><div data-automation-id="formField"><label for="conditional">Conditional detail*</label><input id="conditional" required></div>';
          } else {
            replacement.innerHTML = '<div data-automation-id="formField"><label for="repeated">Repeated question*</label><input id="repeated" required value="committed"></div>';
          }
          oldRoot.replaceWith(replacement);
          phase += 1;
        });
      </script>
    `);
    const application = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 4_000,
      navigationSettleTimeoutMs: 4_000,
    });
    const initial = await application.observe(new AbortController().signal);
    assert.equal(initial.ok, true, JSON.stringify(initial));
    if (!initial.ok) return;
    const revealed = await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: initial.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal);
    assert.deepEqual(revealed, { ok: true, value: { advanced: true } });
    const conditional = await application.observe(new AbortController().signal);
    assert.equal(conditional.ok, true, JSON.stringify(conditional));
    if (!conditional.ok) return;
    assert.equal(conditional.value.pageId, initial.value.pageId);
    await page.locator("#conditional").fill("committed");
    const advanced = await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: initial.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal);
    assert.deepEqual(advanced, { ok: true, value: { advanced: true } });
    const second = await application.observe(new AbortController().signal);
    assert.equal(second.ok, true, JSON.stringify(second));
    if (!second.ok) return;
    assert.notEqual(second.value.pageId, initial.value.pageId);
    const collector = createApplicationLaneAcceptanceCollector();
    for (const pageIdValue of [initial.value.pageId, second.value.pageId]) {
      collector.record({
        schemaVersion: 1,
        checkpoint: "questionnaire_verified",
        answers: [{
          pageId: pageIdValue,
          fieldId: "repeated-question" as never,
          questionId: "observed-question-fedcba9876543210fedcba98" as never,
          provenance: "visible_option",
          lane: "synthetic_test_default",
          protectedCategory: null,
          templateRevision: null,
          verification: "independent",
        }],
        protectedPlaceholderCount: 0,
        independentlyVerified: true,
        submitActivated: false,
        privacyScan: "pass",
      });
    }
    const accepted = collector.snapshot("pre_review");
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.checkpoint === "questionnaire_verified" &&
      accepted[0].answers.length, 2);
    assert.equal(await page.locator('[data-automation-id="progressBarActiveStep"]').innerText(),
      "Application Questions");
    assert.equal(await page.locator('main[data-automation-id="applyFlowApplicationQuestionsPage"]')
      .count(), 1);
    assert.equal(await page.locator('label[for="repeated"]').innerText(), "Repeated question*");
  } finally {
    await browser.close();
  }
});

test("combined detection includes optional profile controls and keeps tenant files in Profile", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const application = new PlaywrightWorkdayApplicationPage(page);
    await page.setContent(`
      <body data-hunt-page-id="combined-optional">
        <main data-automation-id="applyFlowMyInfoPage">
          <input type="file" required data-hunt-field-id="resume-artifact"
            data-automation-id="file-upload-input-ref">
          <input data-automation-id="optionalProfileControl">
        </main>
      </body>
    `);
    const optional = await application.observe(new AbortController().signal);
    assert.equal(optional.ok, true, JSON.stringify(optional));
    assert.deepEqual(optional.ok && optional.value.lanes, ["resume", "profile"]);

    await page.setContent(`
      <body data-hunt-page-id="combined-tenant-file">
        <main data-automation-id="applyFlowMyInfoPage">
          <input type="file" required data-hunt-field-id="resume-artifact"
            data-automation-id="file-upload-input-ref">
          <input type="file" required data-hunt-field-id="tenant-document"
            data-automation-id="tenant-required-document">
        </main>
      </body>
    `);
    const tenantFile = await application.observe(new AbortController().signal);
    assert.equal(tenantFile.ok, true, JSON.stringify(tenantFile));
    assert.deepEqual(tenantFile.ok && tenantFile.value.lanes, ["resume", "profile"]);
    assert.deepEqual(
      tenantFile.ok && tenantFile.value.requiredFields.map(({ page: owner }) => owner),
      ["resume", "profile"],
    );
  } finally {
    await browser.close();
  }
});

function fixturePages() {
  return {
    combined: `
      <main data-automation-id="applyFlowMyInfoPage">
        <div>
          <input type="file" required data-hunt-field-id="resume-artifact" data-automation-id="file-upload-input-ref">
        </div>
        <input required data-hunt-field-id="contact-email" data-automation-id="legalNameSection_firstName">
        <button type="button" data-action="next">Next</button>
      </main>`,
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
    mode: "live",
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
      mode: "live",
      pageType: "profile",
fields: [{
        fieldId: "identity.given_name",
        questionType: "identity",
        answerType: "text",
        allowedOptions: [],
        answer: {
          kind: "answered",
          value: "Ada",
          provenance: "owner_provided",
          lane: "live_owner_fact",
        },
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
        value: {
          kind: "answered",
          value: true,
          provenance: "owner_provided",
          lane: "live_owner_fact",
        },
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
