import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { chromium, type Page } from "playwright";

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
  bindQuestionnaireTargets,
  hydrateQuestionnairePopupOptions,
  questionnairePopupHydrationTargets,
} from "../../../src/browser/playwright-live/private/workday-application-runtime.ts";
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

const popupPreparationPageId = browserPageId("page-questionnaire-popup-preparation");

function popupPreparedApplication(
  page: Page,
  navigationSettleTimeoutMs: number,
): PlaywrightWorkdayApplicationPage {
  return new PlaywrightWorkdayApplicationPage(page, {
    timeoutMs: Math.min(navigationSettleTimeoutMs, 500),
    navigationSettleTimeoutMs,
    prepareQuestionnaireSnapshot: async (signal) => {
      if (signal.aborted) return;
      await bindQuestionnaireTargets(page, popupPreparationPageId);
      for (let count = 0; count < 16; count += 1) {
        const target = (await questionnairePopupHydrationTargets(page))[0];
        if (target === undefined) return;
        await hydrateQuestionnairePopupOptions(
          page,
          popupPreparationPageId,
          target,
          Math.min(navigationSettleTimeoutMs, 500),
        );
      }
      throw new TypeError("fixture popup preparation exceeded");
    },
  });
}

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
              aria-describedby="country-description" aria-valuetext="Canada">Canada</button>
            <span id="country-description">Select your country of residence.</span>
            <input style="display:none">
          </div>
          <label>City<input id="addresss--city" name="city" value="Edmonton"></label>
          <div data-automation-id="formField-phoneNumber--phoneType">
            <label>Phone Device Type<span data-automation-id="required">*</span></label>
            <button data-automation-id="phoneNumber--phoneType" type="button"
              aria-required="true" aria-valuetext="Mobile">Mobile</button>
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
            replacement.innerHTML = '<div data-automation-id="formField"><label for="repeated-remounted">Repeated question*</label><input id="repeated-remounted" required value="committed"></div><div data-automation-id="formField"><label for="conditional">Conditional detail*</label><input id="conditional" required></div><div data-automation-id="applyFlowLoadingPage" hidden>Loading</div>';
            oldRoot.replaceWith(replacement);
          } else {
            const loader = oldRoot.querySelector('[data-automation-id="applyFlowLoadingPage"]');
            loader.hidden = false;
            const repeated = oldRoot.querySelector('#repeated-remounted');
            const repeatedLabel = oldRoot.querySelector('label[for="repeated-remounted"]');
            repeated.id = 'repeated';
            repeatedLabel.htmlFor = 'repeated';
            oldRoot.insertAdjacentHTML('beforeend', '<div data-automation-id="formField"><label for="destination-detail">Destination detail*</label><input id="destination-detail" required value="committed"></div>');
            loader.hidden = true;
          }
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

test("does not advance a questionnaire occurrence for a same-count remount and reorder", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div data-automation-id="progressBarActiveStep">Application Questions</div>
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField"><label for="one">Repeated question*</label>
          <input id="one" required value="committed"></div>
        <div data-automation-id="formField"><label for="two">Repeated question*</label>
          <input id="two" required value="committed"></div>
      </main>
      <button id="next" type="button">Save and Continue</button>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          const root = document.querySelector('main');
          const replacement = root.cloneNode(true);
          replacement.prepend(replacement.children[1]);
          root.replaceWith(replacement);
          const unrelated = document.createElement('div');
          unrelated.dataset.automationId = 'applyFlowLoadingPage';
          document.body.append(unrelated);
          unrelated.remove();
        });
      </script>
    `);
    const application = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 600,
      navigationSettleTimeoutMs: 600,
    });
    const before = await application.observe(new AbortController().signal);
    assert.equal(before.ok, true, JSON.stringify(before));
    if (!before.ok) return;
    const result = await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: before.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal);
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain");
    const after = await application.observe(new AbortController().signal);
    assert.equal(after.ok, true, JSON.stringify(after));
    if (after.ok) assert.equal(after.value.pageId, before.value.pageId);
  } finally {
    await browser.close();
  }
});

test("synchronous pre-mounted loader aria, style, and class cycles prove same-page advancement", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of [
      {
        name: "aria-hidden",
        initial: 'aria-hidden="true"',
        show: "loader.removeAttribute('aria-hidden')",
        hide: "loader.setAttribute('aria-hidden', 'true')",
        hideDeferred: false,
        destinationDeferred: false,
      },
      {
        name: "style",
        initial: 'style="display:none"',
        show: "loader.removeAttribute('style')",
        hide: "loader.setAttribute('style', 'display:none')",
        hideDeferred: false,
        destinationDeferred: false,
      },
      {
        name: "class",
        initial: 'class="loader-a"',
        show: "loader.className = 'loader-visible'",
        hide: "loader.className = 'loader-b'",
        hideDeferred: false,
        destinationDeferred: true,
      },
      {
        name: "nonclass-show-class-hide",
        initial: 'hidden class="loader-visible"',
        show: "loader.removeAttribute('hidden')",
        hide: "loader.className = 'loader-b'",
        hideDeferred: false,
        destinationDeferred: true,
      },
      {
        name: "class-list-value",
        initial: 'class="loader-a"',
        show: "loader.classList.value = 'loader-visible'",
        hide: "loader.classList.value = 'loader-b'",
        hideDeferred: false,
        destinationDeferred: true,
      },
      {
        name: "attribute-node-value",
        initial: 'class="loader-a"',
        show: "const nextClass = document.createAttribute('class'); nextClass.value = 'loader-visible'; loader.setAttributeNode(nextClass)",
        hide: "loader.getAttributeNode('class').value = 'loader-b'",
        hideDeferred: false,
        destinationDeferred: true,
      },
    ]) {
      const page = await browser.newPage();
      await page.setContent(`<style>
        .hidden, .loader-a, .loader-b, [aria-hidden="true"] { display: none; }
        .loader-visible { display: block; }
      </style>
        <div data-automation-id="applyFlowPage">
          <main data-automation-id="applyFlowApplicationQuestionsPage">
            <div data-automation-id="formField"><label>Repeated question*<input required value="committed"></label></div>
          </main>
          <div data-automation-id="applyFlowLoadingPage" ${variant.initial}>Loading</div>
          <button id="next">Save and Continue</button>
        </div>
        <script>
          document.querySelector('#next').addEventListener('click', () => {
            const loader = document.querySelector('[data-automation-id="applyFlowLoadingPage"]');
            ${variant.show};
            const destination = () => {
              document.querySelector('main').insertAdjacentHTML('beforeend',
                '<div data-automation-id="formField"><label>Destination detail*<input required value="committed"></label></div>');
            };
            const finish = () => {
              ${variant.hide};
              if (${variant.destinationDeferred}) setTimeout(destination, 100);
              else destination();
            };
            if (${variant.hideDeferred}) setTimeout(finish, 0);
            else finish();
          });
        </script>`);
      const application = new PlaywrightWorkdayApplicationPage(page, {
        timeoutMs: 4_000,
        navigationSettleTimeoutMs: 4_000,
      });
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, `${variant.name}:${JSON.stringify(before)}`);
      if (!before.ok) continue;
      assert.deepEqual(await application.next({
        journeyId: walkFixture.journeyId,
        from: "questionnaire",
        fromPageId: before.value.pageId,
        allowed: ["questionnaire"],
      }, new AbortController().signal), { ok: true, value: { advanced: true } }, variant.name);
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, `${variant.name}:${JSON.stringify(after)}`);
      const witnessState = await page.evaluate(() => {
        const state = (globalThis as unknown as Record<string, unknown>).__huntWorkdayNavigationAction;
        return JSON.parse(JSON.stringify(state, (key, value) =>
          ["controller", "observer", "restoreInstrumentation"].includes(key) ? undefined : value
        ));
      });
      if (after.ok) assert.notEqual(
        after.value.pageId,
        before.value.pageId,
        `${variant.name}:${JSON.stringify(witnessState)}`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("a mixed loader pair is revoked when its class-show context later changes", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<style id="loader-style">
        .loader-hidden { display:none } .loader-visible { display:block }
      </style><div data-automation-id="applyFlowPage">
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <label>Repeated question*<input required value="committed"></label>
      </main><div data-automation-id="applyFlowLoadingPage" class="loader-hidden">Loading</div>
      <button id="next">Save and Continue</button><script>
        document.querySelector('#next').addEventListener('click', () => {
          const loader = document.querySelector('[data-automation-id="applyFlowLoadingPage"]');
          loader.className = 'loader-visible';
          setTimeout(() => {
            loader.hidden = true;
            setTimeout(() => {
              const declaration = document.querySelector('#loader-style').sheet.cssRules[1].style;
              declaration.setProperty('color', 'red');
              declaration.removeProperty('color');
              document.querySelector('main').insertAdjacentHTML('beforeend',
                '<label>Conditional detail*<input required value="committed"></label>');
            }, 0);
          }, 0);
        });
      </script></div>`);
    const application = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 1_000,
      navigationSettleTimeoutMs: 1_000,
    });
    const before = await application.observe(new AbortController().signal);
    assert.equal(before.ok, true, JSON.stringify(before));
    if (!before.ok) return;
    const result = await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: before.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal);
    if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain");
    const after = await application.observe(new AbortController().signal);
    assert.equal(after.ok, true, JSON.stringify(after));
    if (after.ok) assert.equal(after.value.pageId, before.value.pageId);
  } finally {
    await browser.close();
  }
});

test("stylesheet invalidation revokes completed and active non-class loader evidence", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of ["completed", "active-then-removed"] as const) {
      const page = await browser.newPage();
      await page.setContent(`<style id="loader-style">
          .loader-visible { display:block }
        </style><div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowApplicationQuestionsPage">
          <label>Repeated question*<input required value="committed"></label>
        </main><div id="loader" data-automation-id="applyFlowLoadingPage"
          class="loader-visible" hidden>Loading</div>
        <button id="next">Save and Continue</button><script>
          document.querySelector('#next').addEventListener('click', () => {
            const loader = document.querySelector('#loader');
            loader.hidden = false;
            if ('${variant}' === 'completed') loader.hidden = true;
            const declaration = document.querySelector('#loader-style').sheet.cssRules[0].style;
            declaration.color = 'red'; declaration.color = '';
            if ('${variant}' === 'active-then-removed') loader.remove();
            setTimeout(() => document.querySelector('main').insertAdjacentHTML('beforeend',
              '<label>Conditional detail*<input required value="committed"></label>'), 100);
          });
        </script></div>`);
      const application = new PlaywrightWorkdayApplicationPage(page, {
        timeoutMs: 1_000,
        navigationSettleTimeoutMs: 1_000,
      });
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, `${variant}:${JSON.stringify(before)}`);
      if (!before.ok) continue;
      const result = await application.next({
        journeyId: walkFixture.journeyId,
        from: "questionnaire",
        fromPageId: before.value.pageId,
        allowed: ["questionnaire"],
      }, new AbortController().signal);
      if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain", variant);
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, `${variant}:${JSON.stringify(after)}`);
      if (after.ok) assert.equal(after.value.pageId, before.value.pageId, variant);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("loader witnesses pair only the exact physical source and preserve independent controller proof", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of [
      {
        name: "two-loader-overlap",
        script: `
          first.className = 'loader-visible';
          second.className = 'loader-visible';
          first.className = 'loader-hidden';
          second.className = 'loader-hidden';`,
        expectedAdvance: true,
      },
      {
        name: "cross-loader-denied",
        secondInitial: "loader-visible",
        script: `
          first.className = 'loader-visible';
          second.className = 'loader-hidden';`,
        expectedAdvance: false,
      },
      {
        name: "settled-loader-with-open-loader",
        script: `
          first.className = 'loader-visible';
          first.className = 'loader-hidden';
          second.className = 'loader-visible';`,
        expectedAdvance: false,
      },
      {
        name: "settled-loader-with-open-controller",
        script: `
          first.className = 'loader-visible';
          first.className = 'loader-hidden';
          controller.setAttribute('aria-busy', 'true');`,
        expectedAdvance: false,
      },
      {
        name: "loader-settle-then-rebusy",
        script: `
          first.className = 'loader-visible';
          first.className = 'loader-hidden';
          first.className = 'loader-visible';`,
        expectedAdvance: false,
      },
      {
        name: "controller-settle-then-rebusy",
        script: `
          controller.setAttribute('aria-busy', 'true');
          controller.setAttribute('aria-busy', 'false');
          controller.setAttribute('aria-busy', 'true');`,
        expectedAdvance: false,
      },
      {
        name: "controller-survives-class-revocation",
        script: `
          controller.setAttribute('aria-busy', 'true');
          first.className = 'loader-visible';
          first.className = 'loader-hidden';
          const declaration = document.querySelector('#loader-style').sheet.cssRules[1].style;
          declaration.color = 'red'; declaration.color = '';
          controller.setAttribute('aria-busy', 'false');`,
        expectedAdvance: true,
      },
    ]) {
      const page = await browser.newPage();
      await page.setContent(`<style id="loader-style">
          .loader-hidden { display:none } .loader-visible { display:block }
        </style><div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowApplicationQuestionsPage">
          <label>Repeated question*<input required value="committed"></label>
        </main>
        <div id="first" data-automation-id="applyFlowLoadingPage" class="loader-hidden">One</div>
        <div id="second" data-automation-id="applyFlowLoadingPage"
          class="${variant.secondInitial ?? "loader-hidden"}">Two</div>
        <button id="next">Save and Continue</button><script>
          document.querySelector('#next').addEventListener('click', () => {
            const controller = document.querySelector('[data-automation-id="applyFlowPage"]');
            const first = document.querySelector('#first');
            const second = document.querySelector('#second');
            ${variant.script}
            setTimeout(() => document.querySelector('main').insertAdjacentHTML('beforeend',
              '<label>Destination detail*<input required value="committed"></label>'), 100);
          });
        </script></div>`);
      const application = new PlaywrightWorkdayApplicationPage(page, {
        timeoutMs: 1_500,
        navigationSettleTimeoutMs: 1_500,
      });
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, `${variant.name}:${JSON.stringify(before)}`);
      if (!before.ok) continue;
      const result = await application.next({
        journeyId: walkFixture.journeyId,
        from: "questionnaire",
        fromPageId: before.value.pageId,
        allowed: ["questionnaire"],
      }, new AbortController().signal);
      if (variant.expectedAdvance) assert.equal(result.ok, true, variant.name);
      else if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain", variant.name);
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, `${variant.name}:${JSON.stringify(after)}`);
      if (after.ok) assert.equal(
        after.value.pageId !== before.value.pageId,
        variant.expectedAdvance,
        variant.name,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("permanently CSS-hidden loaders cannot synthesize a witness from attribute churn", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of [
      { name: "aria", initial: 'aria-hidden="true"', show: "loader.removeAttribute('aria-hidden')", hide: "loader.setAttribute('aria-hidden', 'true')" },
      { name: "hidden", initial: "hidden", show: "loader.removeAttribute('hidden')", hide: "loader.setAttribute('hidden', '')" },
      { name: "style", initial: 'style="visibility:hidden"', show: "loader.removeAttribute('style')", hide: "loader.setAttribute('style', 'visibility:hidden')" },
    ]) {
      const page = await browser.newPage();
      await page.setContent(`<style>.permanent-loader { display:none !important }</style>
        <div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowApplicationQuestionsPage">
          <label>Repeated question*<input required value="committed"></label>
        </main><div data-automation-id="applyFlowLoadingPage" class="permanent-loader" ${variant.initial}>Loading</div>
        <button id="next">Save and Continue</button><script>
          document.querySelector('#next').addEventListener('click', () => {
            const loader = document.querySelector('[data-automation-id="applyFlowLoadingPage"]');
            ${variant.show}; ${variant.hide};
            document.querySelector('main').insertAdjacentHTML('beforeend',
              '<label>Conditional detail*<input required value="committed"></label>');
          });
        </script></div>`);
      const application = new PlaywrightWorkdayApplicationPage(page, {
        timeoutMs: 1_000,
        navigationSettleTimeoutMs: 1_000,
      });
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, variant.name);
      if (!before.ok) continue;
      const result = await application.next({
        journeyId: walkFixture.journeyId,
        from: "questionnaire",
        fromPageId: before.value.pageId,
        allowed: ["questionnaire"],
      }, new AbortController().signal);
      if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain", variant.name);
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, variant.name);
      if (after.ok) assert.equal(after.value.pageId, before.value.pageId, variant.name);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("an always-hidden loader ancestor cannot advance a conditional semantic superset", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>.always-hidden { display: none; }</style>
      <div data-automation-id="applyFlowPage">
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField"><label>Repeated question*<input required value="committed"></label></div>
      </main>
      <div class="always-hidden"><div data-automation-id="applyFlowLoadingPage" hidden>Loading</div></div>
      <button id="next">Save and Continue</button>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          const loader = document.querySelector('[data-automation-id="applyFlowLoadingPage"]');
          loader.hidden = false;
          document.querySelector('main').insertAdjacentHTML('beforeend',
            '<div data-automation-id="formField"><label>Conditional detail*<input required value="committed"></label></div>');
          loader.hidden = true;
        });
      </script></div>`);
    const application = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 4_000,
      navigationSettleTimeoutMs: 4_000,
    });
    const before = await application.observe(new AbortController().signal);
    assert.equal(before.ok, true, JSON.stringify(before));
    if (!before.ok) return;
    assert.deepEqual(await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: before.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal), { ok: true, value: { advanced: true } });
    const after = await application.observe(new AbortController().signal);
    assert.equal(after.ok, true, JSON.stringify(after));
    if (after.ok) assert.equal(after.value.pageId, before.value.pageId);
  } finally {
    await browser.close();
  }
});

test("two computed-hidden loader classes cannot advance a conditional semantic superset", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>.loader-a, .loader-b { display: none; }</style>
      <div data-automation-id="applyFlowPage">
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField"><label>Repeated question*<input required value="committed"></label></div>
      </main>
      <div data-automation-id="applyFlowLoadingPage" class="loader-a">Loading</div>
      <button id="next">Save and Continue</button>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          const loader = document.querySelector('[data-automation-id="applyFlowLoadingPage"]');
          loader.className = 'loader-b';
          document.querySelector('main').insertAdjacentHTML('beforeend',
            '<div data-automation-id="formField"><label>Conditional detail*<input required value="committed"></label></div>');
          loader.className = 'loader-a';
        });
      </script></div>`);
    const application = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 4_000,
      navigationSettleTimeoutMs: 4_000,
    });
    const before = await application.observe(new AbortController().signal);
    assert.equal(before.ok, true, JSON.stringify(before));
    if (!before.ok) return;
    assert.deepEqual(await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: before.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal), { ok: true, value: { advanced: true } });
    const after = await application.observe(new AbortController().signal);
    assert.equal(after.ok, true, JSON.stringify(after));
    if (after.ok) assert.equal(after.value.pageId, before.value.pageId);
  } finally {
    await browser.close();
  }
});

test("historical loader class visibility is measured at the exact structural position", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of [
      {
        name: "positional-visible",
        css: ".loader-hidden { display:none } .loader-visible:only-child { display:block }",
        extra: "",
        contextMutation: "",
        expectedAdvance: true,
      },
      {
        name: "positional-hidden",
        css: ".loader-hidden { display:none } .loader-visible:only-child { display:none } .loader-visible:not(:only-child) { display:block }",
        extra: "",
        contextMutation: "",
        expectedAdvance: false,
      },
      {
        name: "changed-ancestor",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: "",
        contextMutation: "loader.parentElement.className = 'changed-context'",
        expectedAdvance: false,
      },
      {
        name: "changed-stylesheet",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: "",
        contextMutation: "document.querySelector('#loader-style').textContent += ' .unrelated { color: blue }'",
        expectedAdvance: false,
      },
      {
        name: "remote-has-state",
        css: ".loader-hidden { display:none } body:has(.remote-active) .loader-visible { display:block }",
        extra: '<div id="remote-state"></div>',
        contextMutation: "document.querySelector('#remote-state').className = 'remote-active'",
        expectedAdvance: false,
      },
      {
        name: "remote-has-structure",
        css: ".loader-hidden { display:none } body:has(#remote-state > .remote-active) .loader-visible { display:block }",
        extra: '<div id="remote-state"></div>',
        contextMutation: "document.querySelector('#remote-state').insertAdjacentHTML('beforeend', '<span class=\"remote-active\"></span>')",
        expectedAdvance: false,
      },
      {
        name: "ancestor-id-data",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: "",
        contextMutation: "loader.parentElement.id = 'changed-owner'; loader.parentElement.dataset.mode = 'changed'",
        expectedAdvance: false,
      },
      {
        name: "style-media-attribute",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: "",
        contextMutation: "document.querySelector('#loader-style').setAttribute('media', 'all')",
        expectedAdvance: false,
      },
      {
        name: "link-attribute",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: '<link id="style-link" rel="stylesheet" href="data:text/css,.unused%7Bcolor:red%7D">',
        contextMutation: "document.querySelector('#style-link').disabled = true",
        expectedAdvance: false,
      },
      {
        name: "cssom-insert-rule",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: "",
        contextMutation: "document.querySelector('#loader-style').sheet.insertRule('.inserted { color: red }')",
        expectedAdvance: false,
      },
      {
        name: "cssom-delete-rule",
        css: ".loader-hidden { display:none } .loader-visible { display:block } .throwaway { color:red }",
        extra: "",
        contextMutation: "document.querySelector('#loader-style').sheet.deleteRule(2)",
        expectedAdvance: false,
      },
      {
        name: "adopted-stylesheet",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: "",
        contextMutation: "const adopted = new CSSStyleSheet(); adopted.replaceSync('.adopted { color:red }'); document.adoptedStyleSheets = [...document.adoptedStyleSheets, adopted]",
        expectedAdvance: false,
      },
      {
        name: "nested-rule-restored",
        css: ".loader-hidden { display:none } .loader-visible { display:block } @media all { .nested { color:red } }",
        extra: "",
        contextMutation: "const group = document.querySelector('#loader-style').sheet.cssRules[2]; group.insertRule('.temporary { color: blue }', group.cssRules.length); group.deleteRule(group.cssRules.length - 1)",
        expectedAdvance: false,
      },
      {
        name: "declaration-restored",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: "",
        contextMutation: "const declaration = document.querySelector('#loader-style').sheet.cssRules[1].style; declaration.setProperty('color', 'red'); declaration.removeProperty('color')",
        expectedAdvance: false,
      },
      {
        name: "direct-declaration-property-restored",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: "",
        contextMutation: "const declaration = document.querySelector('#loader-style').sheet.cssRules[1].style; declaration.color = 'red'; declaration.color = ''",
        expectedAdvance: false,
      },
      {
        name: "disabled-restored",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: "",
        contextMutation: "const sheet = document.querySelector('#loader-style').sheet; sheet.disabled = true; sheet.disabled = false",
        expectedAdvance: false,
      },
      {
        name: "link-disabled-restored",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: '<link id="disabled-link" rel="stylesheet" href="data:text/css,.unused%7Bcolor:red%7D">',
        contextMutation: "const link = document.querySelector('#disabled-link'); link.disabled = true; link.disabled = false",
        expectedAdvance: false,
      },
      {
        name: "media-restored",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: "",
        contextMutation: "const media = document.querySelector('#loader-style').sheet.media; media.mediaText = 'not all'; media.mediaText = ''",
        expectedAdvance: false,
      },
      {
        name: "selector-restored",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: "",
        contextMutation: "const rule = document.querySelector('#loader-style').sheet.cssRules[1]; rule.selectorText = '.temporary-visible'; rule.selectorText = '.loader-visible'",
        expectedAdvance: false,
      },
      {
        name: "keyframe-rule-restored",
        css: ".loader-hidden { display:none } .loader-visible { display:block } @keyframes pulse { from { opacity: 0 } to { opacity: 1 } }",
        extra: "",
        contextMutation: "const keyframes = document.querySelector('#loader-style').sheet.cssRules[2]; const frame = keyframes.cssRules[0]; frame.keyText = '25%'; frame.keyText = 'from'",
        expectedAdvance: false,
      },
      {
        name: "keyframes-append-delete-restored",
        css: ".loader-hidden { display:none } .loader-visible { display:block } @keyframes pulse { from { opacity: 0 } to { opacity: 1 } }",
        extra: "",
        contextMutation: "const keyframes = document.querySelector('#loader-style').sheet.cssRules[2]; keyframes.appendRule('50% { opacity: .5 }'); keyframes.deleteRule('50%')",
        expectedAdvance: false,
      },
      {
        name: "inaccessible-link",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: `<link id="inaccessible-link" rel="stylesheet" href="data:text/css,.unused%7Bcolor:red%7D">
          <script>Object.defineProperty(document.querySelector('#inaccessible-link').sheet, 'cssRules', {
            configurable: true,
            get() { throw new DOMException('inaccessible', 'SecurityError'); },
          });</script>`,
        contextMutation: "",
        expectedAdvance: false,
      },
      {
        name: "adopted-list-restored",
        css: ".loader-hidden { display:none } .loader-visible { display:block }",
        extra: `<script>
          const adoptedList = [];
          Object.defineProperty(document, 'adoptedStyleSheets', {
            configurable: true,
            enumerable: false,
            get() { return adoptedList; },
            set(value) { adoptedList.splice(0, adoptedList.length, ...value); },
          });
        </script>`,
        contextMutation: "const temporary = new CSSStyleSheet(); document.adoptedStyleSheets.push(temporary); document.adoptedStyleSheets.pop()",
        expectedAdvance: false,
      },
    ] as const) {
      const page = await browser.newPage();
      await page.setContent(`<style id="loader-style">${variant.css}</style>
        ${variant.extra}
        <div data-automation-id="applyFlowPage">
          <main data-automation-id="applyFlowApplicationQuestionsPage">
            <label>Repeated question*<input required value="committed"></label>
          </main>
          <div class="loader-owner"><div data-automation-id="applyFlowLoadingPage" class="loader-hidden">Loading</div></div>
          <button id="next">Save and Continue</button>
        </div><script>
          document.querySelector('#next').addEventListener('click', () => {
            const loader = document.querySelector('[data-automation-id="applyFlowLoadingPage"]');
            loader.className = 'loader-visible';
            ${variant.contextMutation};
            loader.className = 'loader-hidden';
            setTimeout(() => document.querySelector('main').insertAdjacentHTML('beforeend',
              '<label>Destination detail*<input required value="committed"></label>'), 0);
          });
        </script>`);
      const application = new PlaywrightWorkdayApplicationPage(page, {
        timeoutMs: 1_000,
        navigationSettleTimeoutMs: 1_000,
      });
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, `${variant.name}:${JSON.stringify(before)}`);
      if (!before.ok) continue;
      assert.deepEqual(await application.next({
        journeyId: walkFixture.journeyId,
        from: "questionnaire",
        fromPageId: before.value.pageId,
        allowed: ["questionnaire"],
      }, new AbortController().signal), { ok: true, value: { advanced: true } }, variant.name);
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, `${variant.name}:${JSON.stringify(after)}`);
      const witnessState = await page.evaluate(() => {
        const state = (globalThis as unknown as Record<string, unknown>)
          .__huntWorkdayNavigationAction as {
            instrumentationComplete?: boolean;
            busySeen?: boolean;
            settled?: boolean;
            frozen?: boolean;
            activeBusy?: Map<object, unknown>;
            settledPairs?: readonly unknown[];
            styleContextVersion?: number;
            armedStyleContextToken?: string;
          } | undefined;
        return {
          instrumentationComplete: state?.instrumentationComplete,
          busySeen: state?.busySeen,
          settled: state?.settled,
          frozen: state?.frozen,
          activeCount: state?.activeBusy?.size,
          pairCount: state?.settledPairs?.length,
          styleContextVersion: state?.styleContextVersion,
          styleContextArmed: state?.armedStyleContextToken !== undefined,
        };
      });
      if (after.ok) assert.equal(after.value.pageId !== before.value.pageId,
        variant.expectedAdvance, `${variant.name}:${JSON.stringify(witnessState)}`);
      if (variant.name === "adopted-list-restored") {
        assert.equal(await page.evaluate(() => Object.prototype.hasOwnProperty.call(
          document, "adoptedStyleSheets",
        )), true, "pre-existing adoptedStyleSheets descriptor restored");
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("exact loader captures reject direct adopted stylesheet index and length drift", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of ["index", "length"] as const) {
      const page = await browser.newPage();
      await page.setContent(`<style>.loader-hidden { display:none } .loader-visible { display:block }</style>
        <script>
          const base = new CSSStyleSheet(); base.replaceSync('.base { color: black }');
          const second = new CSSStyleSheet(); second.replaceSync('.second { color: blue }');
          const replacement = new CSSStyleSheet(); replacement.replaceSync('.replacement { color: red }');
          const adoptedList = [base, second];
          Object.defineProperty(document, 'adoptedStyleSheets', {
            configurable: true,
            get() { return adoptedList; },
            set(value) { adoptedList.splice(0, adoptedList.length, ...value); },
          });
        </script><div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowApplicationQuestionsPage">
          <label>Repeated question*<input required value="committed"></label>
        </main><div data-automation-id="applyFlowLoadingPage" class="loader-hidden">Loading</div>
        <button id="next">Save and Continue</button><script>
          document.querySelector('#next').addEventListener('click', () => {
            const loader = document.querySelector('[data-automation-id="applyFlowLoadingPage"]');
            if ('${variant}' === 'index') adoptedList[0] = replacement;
            else adoptedList.length = 1;
            loader.className = 'loader-visible';
            loader.className = 'loader-hidden';
            if ('${variant}' === 'index') adoptedList[0] = base;
            else { adoptedList.length = 2; adoptedList[1] = second; }
            document.querySelector('main').insertAdjacentHTML('beforeend',
              '<label>Conditional detail*<input required value="committed"></label>');
          });
        </script></div>`);
      const application = new PlaywrightWorkdayApplicationPage(page, {
        timeoutMs: 1_000,
        navigationSettleTimeoutMs: 1_000,
      });
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, `${variant}:${JSON.stringify(before)}`);
      if (!before.ok) continue;
      const result = await application.next({
        journeyId: walkFixture.journeyId,
        from: "questionnaire",
        fromPageId: before.value.pageId,
        allowed: ["questionnaire"],
      }, new AbortController().signal);
      if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain", variant);
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, `${variant}:${JSON.stringify(after)}`);
      if (after.ok) assert.equal(after.value.pageId, before.value.pageId, variant);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("freezing a style-dependent witness resamples direct adopted stylesheet drift", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of ["unchanged", "index", "length"] as const) {
      const page = await browser.newPage();
      await page.setContent(`<style>.loader-hidden { display:none } .loader-visible { display:block }</style>
        <script>
          const base = new CSSStyleSheet(); base.replaceSync('.base { color: black }');
          const second = new CSSStyleSheet(); second.replaceSync('.second { color: blue }');
          const replacement = new CSSStyleSheet(); replacement.replaceSync('.replacement { color: red }');
          const adoptedList = [base, second];
          Object.defineProperty(document, 'adoptedStyleSheets', {
            configurable: true,
            get() { return adoptedList; },
            set(value) { adoptedList.splice(0, adoptedList.length, ...value); },
          });
        </script><div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowApplicationQuestionsPage">
          <label>Repeated question*<input required value="committed"></label>
        </main><div data-automation-id="applyFlowLoadingPage" class="loader-hidden">Loading</div>
        <button id="next">Save and Continue</button><script>
          document.querySelector('#next').addEventListener('click', () => {
            const loader = document.querySelector('[data-automation-id="applyFlowLoadingPage"]');
            loader.className = 'loader-visible';
            loader.className = 'loader-hidden';
            queueMicrotask(() => {
              if ('${variant}' === 'index') adoptedList[0] = replacement;
              if ('${variant}' === 'length') adoptedList.length = 1;
            });
          }, { once: true });
        </script></div>`);
      const application = new PlaywrightWorkdayApplicationPage(page, {
        timeoutMs: 750,
        navigationSettleTimeoutMs: 750,
      });
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, `${variant}:${JSON.stringify(before)}`);
      if (!before.ok) continue;
      const result = await application.next({
        journeyId: walkFixture.journeyId,
        from: "questionnaire",
        fromPageId: before.value.pageId,
        allowed: ["questionnaire"],
      }, new AbortController().signal);
      assert.equal(result.ok, variant === "unchanged", `${variant}:${JSON.stringify(result)}`);
      if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain", variant);
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, `${variant}:${JSON.stringify(after)}`);
      if (after.ok) assert.equal(after.value.pageId !== before.value.pageId,
        variant === "unchanged", variant);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("freeze-time style drift preserves an independent settled controller witness", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of ["index", "length"] as const) {
      const page = await browser.newPage();
      await page.setContent(`<style>.loader-hidden { display:none } .loader-visible { display:block }</style>
        <script>
          const base = new CSSStyleSheet(); base.replaceSync('.base { color: black }');
          const second = new CSSStyleSheet(); second.replaceSync('.second { color: blue }');
          const replacement = new CSSStyleSheet(); replacement.replaceSync('.replacement { color: red }');
          const adoptedList = [base, second];
          Object.defineProperty(document, 'adoptedStyleSheets', {
            configurable: true,
            get() { return adoptedList; },
            set(value) { adoptedList.splice(0, adoptedList.length, ...value); },
          });
        </script><div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowApplicationQuestionsPage">
          <label>Repeated question*<input required value="committed"></label>
        </main><div data-automation-id="applyFlowLoadingPage" class="loader-hidden">Loading</div>
        <button id="next">Save and Continue</button><script>
          document.querySelector('#next').addEventListener('click', () => {
            const controller = document.querySelector('[data-automation-id="applyFlowPage"]');
            const loader = document.querySelector('[data-automation-id="applyFlowLoadingPage"]');
            controller.setAttribute('aria-busy', 'true');
            controller.setAttribute('aria-busy', 'false');
            loader.className = 'loader-visible';
            loader.className = 'loader-hidden';
            queueMicrotask(() => {
              if ('${variant}' === 'index') adoptedList[0] = replacement;
              else adoptedList.length = 1;
            });
          }, { once: true });
        </script></div>`);
      const application = new PlaywrightWorkdayApplicationPage(page, {
        timeoutMs: 750,
        navigationSettleTimeoutMs: 750,
      });
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, `${variant}:${JSON.stringify(before)}`);
      if (!before.ok) continue;
      assert.deepEqual(await application.next({
        journeyId: walkFixture.journeyId,
        from: "questionnaire",
        fromPageId: before.value.pageId,
        allowed: ["questionnaire"],
      }, new AbortController().signal), { ok: true, value: { advanced: true } }, variant);
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, `${variant}:${JSON.stringify(after)}`);
      if (after.ok) assert.notEqual(after.value.pageId, before.value.pageId, variant);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("unrelated controller attributes cannot settle an aria-busy interval", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<div data-automation-id="applyFlowPage" data-state="true">
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <label>Repeated question*<input required value="committed"></label>
      </main><button id="next">Save and Continue</button><script>
        document.querySelector('#next').addEventListener('click', () => {
          const controller = document.querySelector('[data-automation-id="applyFlowPage"]');
          controller.setAttribute('aria-busy', 'true');
          controller.setAttribute('data-state', 'false');
        }, { once: true });
      </script></div>`);
    const application = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 750,
      navigationSettleTimeoutMs: 750,
    });
    const before = await application.observe(new AbortController().signal);
    assert.equal(before.ok, true, JSON.stringify(before));
    if (!before.ok) return;
    const result = await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: before.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal);
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain");
    const after = await application.observe(new AbortController().signal);
    assert.equal(after.ok, true, JSON.stringify(after));
    if (after.ok) assert.equal(after.value.pageId, before.value.pageId);
  } finally {
    await browser.close();
  }
});

test("remote sibling selector mutations revoke style-dependent loader evidence", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of [
      { name: "adjacent", selector: "+", mutate: true, expectedAdvance: false },
      { name: "general-sibling", selector: "~", mutate: true, expectedAdvance: false },
      { name: "unchanged-context", selector: "+", mutate: false, expectedAdvance: true },
    ] as const) {
      const page = await browser.newPage();
      await page.setContent(`<style>
          .loader-hidden { display:none }
          .remote-active ${variant.selector} .loader-owner .loader-visible { display:block }
        </style><div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowApplicationQuestionsPage">
          <label>Repeated question*<input required value="committed"></label>
        </main><div id="remote" class="remote-active"></div><div class="loader-owner">
          <div id="loader" data-automation-id="applyFlowLoadingPage" class="loader-hidden">Loading</div>
        </div><button id="next">Save and Continue</button><script>
          document.querySelector('#next').addEventListener('click', () => {
            const loader = document.querySelector('#loader');
            loader.className = 'loader-visible';
            loader.className = 'loader-hidden';
            if (${variant.mutate}) document.querySelector('#remote').className = '';
          }, { once: true });
        </script></div>`);
      const application = new PlaywrightWorkdayApplicationPage(page, {
        timeoutMs: 750,
        navigationSettleTimeoutMs: 750,
      });
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, `${variant.name}:${JSON.stringify(before)}`);
      if (!before.ok) continue;
      const result = await application.next({
        journeyId: walkFixture.journeyId,
        from: "questionnaire",
        fromPageId: before.value.pageId,
        allowed: ["questionnaire"],
      }, new AbortController().signal);
      assert.equal(result.ok, variant.expectedAdvance, `${variant.name}:${JSON.stringify(result)}`);
      if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain", variant.name);
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, `${variant.name}:${JSON.stringify(after)}`);
      if (after.ok) assert.equal(after.value.pageId !== before.value.pageId,
        variant.expectedAdvance, variant.name);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("owned loading plus an unchanged reload cannot synthesize questionnaire advancement", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      if (window.name !== "reload-unchanged-questionnaire") return;
      document.addEventListener("DOMContentLoaded", () => {
        document.body.innerHTML = `<div data-automation-id="applyFlowPage">
          <main data-automation-id="applyFlowApplicationQuestionsPage">
            <div data-automation-id="formField"><label>Repeated question*<input required value="committed"></label></div>
          </main><button>Save and Continue</button></div>`;
      });
    });
    await page.setContent(`<div data-automation-id="applyFlowPage">
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField"><label>Repeated question*<input required value="committed"></label></div>
      </main><button id="next">Save and Continue</button>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          window.name = 'reload-unchanged-questionnaire';
          document.querySelector('main').remove();
          document.querySelector('[data-automation-id="applyFlowPage"]').insertAdjacentHTML(
            'afterbegin', '<main data-automation-id="applyFlowLoadingPage">Loading</main>');
        });
      </script></div>`);
    const application = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 100,
      navigationSettleTimeoutMs: 250,
    });
    const before = await application.observe(new AbortController().signal);
    assert.equal(before.ok, true, JSON.stringify(before));
    if (!before.ok) return;
    const result = await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: before.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal);
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain");
    const after = await application.observe(new AbortController().signal);
    assert.equal(after.ok, true, JSON.stringify(after));
    if (after.ok) assert.equal(after.value.pageId, before.value.pageId);
  } finally {
    await browser.close();
  }
});

test("popup catalog preparation distinguishes unchanged, changed, and transient reloads", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of [
      { name: "unchanged", destination: ["Shared", "Source only"], outcome: "uncertain" },
      { name: "changed", destination: ["Shared", "Destination only"], outcome: "advanced" },
      { name: "transient", destination: ["Shared", "Transient only"], outcome: "uncertain" },
    ] as const) {
      const page = await browser.newPage();
      await page.addInitScript(({ declaredVariant, destination }) => {
        const install = (options: readonly string[], hydrated: boolean) => {
          document.body.innerHTML = `<div data-automation-id="applyFlowPage">
            <main data-automation-id="applyFlowApplicationQuestionsPage">
              <div data-automation-id="formField"><label for="choice">Popup question*</label>
                <button id="choice" required aria-required="true" aria-haspopup="listbox"
                  aria-controls="portal" aria-valuetext="Shared" data-selected-label="Shared"
                  ${hydrated ? `data-hunt-popup-options='${JSON.stringify(options)}'` : ""}>Shared</button>
              </div>
            </main><div id="portal" role="listbox" hidden>${options.map((option) =>
              `<div role="option">${option}</div>`).join("")}</div>
            <button>Save and Continue</button></div>`;
          const button = document.querySelector<HTMLButtonElement>("#choice")!;
          const portal = document.querySelector<HTMLElement>("#portal")!;
          button.addEventListener("click", () => { portal.hidden = !portal.hidden; });
        };
        if (window.name !== `popup-reload-${declaredVariant}`) return;
        document.addEventListener("DOMContentLoaded", () => {
          install(destination, false);
          if (declaredVariant === "transient") {
            setTimeout(() => install(["Shared", "Source only"], true), 1_000);
          }
        });
      }, { declaredVariant: variant.name, destination: variant.destination });
      await page.setContent(`<div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowApplicationQuestionsPage">
          <div data-automation-id="formField"><label for="choice">Popup question*</label>
            <button id="choice" required aria-required="true" aria-haspopup="listbox"
              aria-controls="portal" aria-valuetext="Shared" data-selected-label="Shared"
              data-hunt-popup-options='["Shared","Source only"]'>Shared</button>
          </div>
        </main><div id="portal" role="listbox" hidden>
          <div role="option">Shared</div><div role="option">Source only</div></div>
        <button id="next">Save and Continue</button>
        <script>
          document.querySelector('#choice').addEventListener('click', () => {
            const portal = document.querySelector('#portal'); portal.hidden = !portal.hidden;
          });
          document.querySelector('#next').addEventListener('click', () => {
            window.name = 'popup-reload-${variant.name}';
            document.querySelector('main').remove();
            document.querySelector('#portal').remove();
            document.querySelector('[data-automation-id="applyFlowPage"]').insertAdjacentHTML(
              'afterbegin', '<main data-automation-id="applyFlowLoadingPage">Loading</main>');
          });
        </script></div>`);
      const application = popupPreparedApplication(page, 1_500);
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, `${variant.name}:${JSON.stringify(before)}`);
      if (!before.ok) continue;
      const result = await application.next({
        journeyId: walkFixture.journeyId,
        from: "questionnaire",
        fromPageId: before.value.pageId,
        allowed: ["questionnaire"],
      }, new AbortController().signal);
      assert.equal(result.ok, variant.outcome === "advanced",
        `${variant.name}:${JSON.stringify(result)}`);
      if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain", variant.name);
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, `${variant.name}:${JSON.stringify(after)}`);
      if (after.ok) {
        assert.equal(after.value.pageId === before.value.pageId,
          variant.outcome === "uncertain", variant.name);
      }
      assert.equal(await page.locator("#choice").getAttribute("aria-valuetext"), "Shared");
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("post-click popup hydration busy cycles cannot authorize unchanged-page advancement", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<div data-automation-id="applyFlowPage">
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField"><label for="choice">Popup question*</label>
          <button id="choice" required aria-required="true" aria-haspopup="listbox"
            aria-controls="portal" aria-valuetext="Shared" data-selected-label="Shared"
            data-hunt-popup-options='["Shared","Other"]'>Shared</button></div>
      </main><div id="portal" role="listbox" hidden><div role="option">Shared</div>
        <div role="option">Other</div></div><button id="next">Save and Continue</button>
      </div><script>
        window.hydrationClicks = 0;
        const installPopupMechanics = () => {
          const choice = document.querySelector('#choice');
          const portal = document.querySelector('#portal');
          choice.addEventListener('click', () => {
            window.hydrationClicks += 1;
            const controller = document.querySelector('[data-automation-id="applyFlowPage"]');
            controller.setAttribute('aria-busy', 'true');
            portal.hidden = false;
            controller.removeAttribute('aria-busy');
          });
        };
        installPopupMechanics();
        document.querySelector('#next').addEventListener('click', () => {
          const old = document.querySelector('#choice');
          const replacement = old.cloneNode(true);
          replacement.removeAttribute('data-hunt-popup-options');
          old.replaceWith(replacement);
          installPopupMechanics();
        });
      </script>`);
    const application = popupPreparedApplication(page, 600);
    const before = await application.observe(new AbortController().signal);
    assert.equal(before.ok, true, JSON.stringify(before));
    if (!before.ok) return;
    const result = await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: before.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal);
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain");
    assert.equal(await page.evaluate(() => (window as unknown as { hydrationClicks: number }).hydrationClicks), 0);
    const after = await new PlaywrightWorkdayApplicationPage(page).observe(
      new AbortController().signal,
    );
    assert.equal(after.ok, true, JSON.stringify(after));
    if (after.ok) assert.equal(after.value.pageId, before.value.pageId);
  } finally {
    await browser.close();
  }
});

test("a revealed required popup may hydrate without turning its loading cycle into page advancement", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<div data-automation-id="applyFlowPage">
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <label>Stable question*<input required value="committed"></label>
        <div id="conditional" data-automation-id="formField-popup" hidden>
          <label for="revealed-popup">Revealed popup*</label>
          <button id="revealed-popup" required aria-required="true" aria-haspopup="listbox"
            aria-controls="revealed-portal" aria-valuetext="Shared" data-selected-label="Shared">Shared</button>
        </div>
      </main><div id="revealed-portal" role="listbox" hidden>
        <div role="option">Shared</div><div role="option">Other</div></div>
      <button id="next">Save and Continue</button></div><script>
        window.hydrationClicks = 0;
        const popup = document.querySelector('#revealed-popup');
        const portal = document.querySelector('#revealed-portal');
        popup.addEventListener('click', () => {
          window.hydrationClicks += 1;
          const controller = document.querySelector('[data-automation-id="applyFlowPage"]');
          controller.setAttribute('aria-busy', 'true');
          portal.hidden = false;
          popup.setAttribute('aria-expanded', 'true');
          controller.removeAttribute('aria-busy');
        });
        document.addEventListener('keydown', event => {
          if (event.key !== 'Escape') return;
          portal.hidden = true;
          popup.setAttribute('aria-expanded', 'false');
        });
        document.querySelector('#next').addEventListener('click', () => {
          document.querySelector('#conditional').hidden = false;
        });
      </script>`);
    const application = popupPreparedApplication(page, 1_000);
    const before = await application.observe(new AbortController().signal);
    assert.equal(before.ok, true, JSON.stringify(before));
    if (!before.ok) return;
    assert.deepEqual(await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: before.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal), { ok: true, value: { advanced: true } });
    assert.equal(await page.evaluate(() => (window as unknown as { hydrationClicks: number }).hydrationClicks), 1);
    const after = await application.observe(new AbortController().signal);
    assert.equal(after.ok, true, JSON.stringify(after));
    if (after.ok) assert.equal(after.value.pageId, before.value.pageId);
  } finally {
    await browser.close();
  }
});

test("owned reload accepts a stable same-label destination with changed answer semantics", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      if (window.name !== "reload-answer-semantics") return;
      document.addEventListener("DOMContentLoaded", () => {
        document.body.innerHTML = `<div data-automation-id="applyFlowPage">
          <main data-automation-id="applyFlowApplicationQuestionsPage">
            <div data-automation-id="formField"><label for="choice">Repeated question*</label>
              <select id="choice" required multiple><option value="shared">Shared</option>
                <option value="destination" selected>Destination only</option></select></div>
            <div data-automation-id="formField"><label for="detail">Repeated detail*</label>
              <input id="detail" required minlength="5" maxlength="12" pattern="[a-z]+"
                value="committed"></div>
          </main><button>Save and Continue</button></div>`;
      });
    });
    await page.setContent(`<div data-automation-id="applyFlowPage">
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField"><label for="choice">Repeated question*</label>
          <select id="choice" required><option value="shared" selected>Shared</option>
            <option value="source">Source only</option></select></div>
        <div data-automation-id="formField"><label for="detail">Repeated detail*</label>
          <input id="detail" required minlength="2" maxlength="4" value="done"></div>
      </main><button id="next">Save and Continue</button>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          window.name = 'reload-answer-semantics';
          document.querySelector('main').remove();
          document.querySelector('[data-automation-id="applyFlowPage"]').insertAdjacentHTML(
            'afterbegin', '<main data-automation-id="applyFlowLoadingPage">Loading</main>');
        });
      </script></div>`);
    const application = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 150,
      navigationSettleTimeoutMs: 750,
    });
    const before = await application.observe(new AbortController().signal);
    assert.equal(before.ok, true, JSON.stringify(before));
    if (!before.ok) return;
    const result = await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: before.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal);
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
    const after = await application.observe(new AbortController().signal);
    assert.equal(after.ok, true, JSON.stringify(after));
    if (after.ok) assert.notEqual(after.value.pageId, before.value.pageId);
  } finally {
    await browser.close();
  }
});

test("owned reload detects optional-only and non-first radio-option semantic changes", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of ["optional", "radio"] as const) {
      const page = await browser.newPage();
      await page.addInitScript((declaredVariant) => {
        if (window.name !== `reload-${declaredVariant}-semantics`) return;
        document.addEventListener("DOMContentLoaded", () => {
          const changed = declaredVariant === "optional"
            ? `<div data-automation-id="formField"><label for="required">Required question*</label>
                <input id="required" required value="committed"></div>
              <div data-automation-id="formField"><label for="optional">Optional question</label>
                <select id="optional"><option selected>Shared</option>
                  <option>Destination only</option></select></div>`
            : `<div data-automation-id="formField"><span>Radio question*</span>
                <label><input type="radio" name="answer" required checked value="shared">Shared</label>
                <label><input type="radio" name="answer" required value="destination">Destination only</label>
              </div>`;
          document.body.innerHTML = `<div data-automation-id="applyFlowPage">
            <main data-automation-id="applyFlowApplicationQuestionsPage">${changed}</main>
            <button>Save and Continue</button></div>`;
        });
      }, variant);
      const source = variant === "optional"
        ? `<div data-automation-id="formField"><label for="required">Required question*</label>
            <input id="required" required value="committed"></div>
          <div data-automation-id="formField"><label for="optional">Optional question</label>
            <select id="optional"><option selected>Shared</option><option>Source only</option></select></div>`
        : `<div data-automation-id="formField"><span>Radio question*</span>
            <label><input type="radio" name="answer" required checked value="shared">Shared</label>
            <label><input type="radio" name="answer" required value="source">Source only</label>
          </div>`;
      await page.setContent(`<div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowApplicationQuestionsPage">${source}</main>
        <button id="next">Save and Continue</button>
        <script>
          document.querySelector('#next').addEventListener('click', () => {
            window.name = 'reload-${variant}-semantics';
            document.querySelector('main').remove();
            document.querySelector('[data-automation-id="applyFlowPage"]').insertAdjacentHTML(
              'afterbegin', '<main data-automation-id="applyFlowLoadingPage">Loading</main>');
          });
        </script></div>`);
      const application = new PlaywrightWorkdayApplicationPage(page, {
        timeoutMs: 150,
        navigationSettleTimeoutMs: 750,
      });
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, `${variant}:${JSON.stringify(before)}`);
      if (!before.ok) continue;
      assert.deepEqual(await application.next({
        journeyId: walkFixture.journeyId,
        from: "questionnaire",
        fromPageId: before.value.pageId,
        allowed: ["questionnaire"],
      }, new AbortController().signal), { ok: true, value: { advanced: true } }, variant);
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, `${variant}:${JSON.stringify(after)}`);
      if (after.ok) assert.notEqual(after.value.pageId, before.value.pageId, variant);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("the supported-control semantic registry detects only answer-affecting changes", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of [
      {
        name: "unsupported-actions",
        source: '<input required value="committed"><div tabindex="0">Source helper</div><button type="button">Source action</button>',
        destination: '<input required value="committed"><div tabindex="0">Destination helper</div><button type="button">Destination action</button>',
        advanced: false,
      },
      {
        name: "optional-aria-multiselect",
        source: '<input required value="committed"><div role="listbox" aria-multiselectable="true" aria-label="Skills"><div role="option">Source only</div></div>',
        destination: '<input required value="committed"><div role="listbox" aria-multiselectable="true" aria-label="Skills"><div role="option">Destination only</div></div>',
        advanced: true,
      },
      {
        name: "optional-empty-radiogroup",
        source: '<input required value="committed"><div role="radiogroup" aria-label="Source empty group"></div>',
        destination: '<input required value="committed"><div role="radiogroup" aria-label="Destination empty group"></div>',
        advanced: true,
      },
      {
        name: "two-native-names-one-field",
        source: '<div data-automation-id="formField"><label><input type="radio" name="first" checked value="shared">Shared</label><label><input type="radio" name="first" value="source">Source A</label><label><input type="radio" name="second" checked value="shared">Shared</label><label><input type="radio" name="second" value="stable">Stable B</label></div>',
        destination: '<div data-automation-id="formField"><label><input type="radio" name="first" checked value="shared">Shared</label><label><input type="radio" name="first" value="destination">Destination A</label><label><input type="radio" name="second" checked value="shared">Shared</label><label><input type="radio" name="second" value="stable">Stable B</label></div>',
        advanced: true,
      },
      {
        name: "equivalent-numeric-constraints",
        source: '<label for="number">Number*</label><input id="number" required type="number" min="01" max="010" step="01" value="5">',
        destination: '<label for="number">Number*</label><input id="number" required type="number" min="1" max="10" step="1" value="5">',
        advanced: false,
      },
      {
        name: "optional-labelledby-name",
        source: '<input required value="committed"><span id="optional-name">Source optional</span><input aria-labelledby="optional-name">',
        destination: '<input required value="committed"><span id="optional-name">Destination optional</span><input aria-labelledby="optional-name">',
        advanced: true,
      },
      {
        name: "non-first-aria-radio-labelledby",
        source: '<input required value="committed"><div role="radiogroup" aria-label="Choice"><span id="one">One</span><span id="two">Source two</span><div role="radio" aria-checked="true" aria-labelledby="one" data-value="one"></div><div role="radio" aria-checked="false" aria-labelledby="two" data-value="two"></div></div>',
        destination: '<input required value="committed"><div role="radiogroup" aria-label="Choice"><span id="one">One</span><span id="two">Destination two</span><div role="radio" aria-checked="true" aria-labelledby="one" data-value="one"></div><div role="radio" aria-checked="false" aria-labelledby="two" data-value="two"></div></div>',
        advanced: true,
      },
    ] as const) {
      const page = await browser.newPage();
      await page.addInitScript(({ name, destination }) => {
        if (window.name !== `registry-${name}`) return;
        document.addEventListener("DOMContentLoaded", () => {
          document.body.innerHTML = `<div data-automation-id="applyFlowPage"><main data-automation-id="applyFlowApplicationQuestionsPage">${destination}</main><button>Save and Continue</button></div>`;
        });
      }, { name: variant.name, destination: variant.destination });
      await page.setContent(`<div data-automation-id="applyFlowPage"><main data-automation-id="applyFlowApplicationQuestionsPage">${variant.source}</main><button id="next">Save and Continue</button></div><script>
        document.querySelector('#next').addEventListener('click', () => {
          window.name = 'registry-${variant.name}';
          document.querySelector('main').remove();
          document.querySelector('[data-automation-id="applyFlowPage"]').insertAdjacentHTML('afterbegin', '<main data-automation-id="applyFlowLoadingPage">Loading</main>');
        });
      </script>`);
      const application = new PlaywrightWorkdayApplicationPage(page, {
        timeoutMs: 150,
        navigationSettleTimeoutMs: 750,
      });
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, `${variant.name}:${JSON.stringify(before)}`);
      if (!before.ok) continue;
      const result = await application.next({
        journeyId: walkFixture.journeyId,
        from: "questionnaire",
        fromPageId: before.value.pageId,
        allowed: ["questionnaire"],
      }, new AbortController().signal);
      assert.equal(result.ok, variant.advanced, `${variant.name}:${JSON.stringify(result)}`);
      if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain", variant.name);
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, `${variant.name}:${JSON.stringify(after)}`);
      if (after.ok) assert.equal(after.value.pageId !== before.value.pageId,
        variant.advanced, variant.name);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("native radio semantics follow form ownership across harmless Workday wrappers", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const fieldsetSource = `<fieldset><legend>Employment status</legend>
      <label><input type="radio" name="status" required checked value="shared">Shared</label>
      <label><input type="radio" name="status" required value="source">Source only</label></fieldset>`;
    const ariaSource = `<span id="status-question">Employment status</span>
      <span id="shared-option">Shared</span><span id="source-option">Source only</span>
      <input type="radio" name="status" required checked value="shared"
        aria-labelledby="status-question shared-option">
      <input type="radio" name="status" required value="source"
        aria-labelledby="status-question source-option">`;
    const radiogroupSource = `<div role="radiogroup" aria-label="Employment status">
      <label><input type="radio" name="status" required checked value="shared">Shared</label>
      <label><input type="radio" name="status" required value="source">Source only</label></div>`;
    for (const variant of [
      {
        name: "wrapper-equivalent",
        source: fieldsetSource,
        destination: `<fieldset><legend>Employment status</legend>
          <div data-automation-id="formField-second"><label><input type="radio" name="status" required value="source">Source only</label></div>
          <div data-automation-id="formField-first"><label><input type="radio" name="status" required checked value="shared">Shared</label></div></fieldset>`,
        advanced: false,
      },
      {
        name: "non-first-option-changed",
        source: fieldsetSource,
        destination: `<fieldset><legend>Employment status</legend>
          <div data-automation-id="formField-second"><label><input type="radio" name="status" required value="destination">Destination only</label></div>
          <div data-automation-id="formField-first"><label><input type="radio" name="status" required checked value="shared">Shared</label></div></fieldset>`,
        advanced: true,
      },
      {
        name: "legend-only-changed",
        source: fieldsetSource,
        destination: `<fieldset><legend>Changed employment status</legend>
          <div data-automation-id="formField-second"><label><input type="radio" name="status" required value="source">Source only</label></div>
          <div data-automation-id="formField-first"><label><input type="radio" name="status" required checked value="shared">Shared</label></div></fieldset>`,
        advanced: true,
      },
      {
        name: "shared-aria-wrapper-equivalent",
        source: ariaSource,
        destination: `<span id="status-question">Employment status</span>
          <div data-automation-id="formField-second"><span id="source-option">Source only</span>
            <input type="radio" name="status" required value="source"
              aria-labelledby="status-question source-option"></div>
          <div data-automation-id="formField-first"><span id="shared-option">Shared</span>
            <input type="radio" name="status" required checked value="shared"
              aria-labelledby="status-question shared-option"></div>`,
        advanced: false,
      },
      {
        name: "shared-aria-question-changed",
        source: ariaSource,
        destination: `<span id="status-question">Changed employment status</span>
          <span id="shared-option">Shared</span><span id="source-option">Source only</span>
          <input type="radio" name="status" required checked value="shared"
            aria-labelledby="status-question shared-option">
          <input type="radio" name="status" required value="source"
            aria-labelledby="status-question source-option">`,
        advanced: true,
      },
      {
        name: "native-radiogroup-name-changed",
        source: radiogroupSource,
        destination: `<div role="radiogroup" aria-label="Changed employment status">
          <label><input type="radio" name="status" required checked value="shared">Shared</label>
          <label><input type="radio" name="status" required value="source">Source only</label></div>`,
        advanced: true,
      },
    ] as const) {
      const page = await browser.newPage();
      await page.addInitScript(({ name, destination }) => {
        if (window.name !== `native-radio-${name}`) return;
        document.addEventListener("DOMContentLoaded", () => {
          document.body.innerHTML = `<form id="application-form"><div data-automation-id="applyFlowPage"><main data-automation-id="applyFlowApplicationQuestionsPage">${destination}</main><button type="button">Save and Continue</button></div></form>`;
        });
      }, variant);
      await page.setContent(`<form id="application-form"><div data-automation-id="applyFlowPage"><main data-automation-id="applyFlowApplicationQuestionsPage">${variant.source}</main>
        <button id="next" type="button">Save and Continue</button></div></form><script>
          document.querySelector('#next').addEventListener('click', () => {
            window.name = 'native-radio-${variant.name}';
            document.querySelector('main').remove();
            document.querySelector('[data-automation-id="applyFlowPage"]').insertAdjacentHTML('afterbegin', '<main data-automation-id="applyFlowLoadingPage">Loading</main>');
          });
        </script>`);
      const application = new PlaywrightWorkdayApplicationPage(page, {
        timeoutMs: 150,
        navigationSettleTimeoutMs: 750,
      });
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, `${variant.name}:${JSON.stringify(before)}`);
      if (!before.ok) continue;
      const result = await application.next({
        journeyId: walkFixture.journeyId,
        from: "questionnaire",
        fromPageId: before.value.pageId,
        allowed: ["questionnaire"],
      }, new AbortController().signal);
      assert.equal(result.ok, variant.advanced, `${variant.name}:${JSON.stringify(result)}`);
      if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain", variant.name);
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, `${variant.name}:${JSON.stringify(after)}`);
      if (after.ok) assert.equal(after.value.pageId !== before.value.pageId,
        variant.advanced, variant.name);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("native radio completion and identity use the exact browser-owned member set", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<div data-automation-id="applyFlowPage">
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <form id="first-form"><fieldset><legend>First status</legend>
          <label><input type="radio" name="status" required value="first-local">First local</label>
        </fieldset></form>
        <label><input form="first-form" type="radio" name="status" required checked
          value="first-external">First external</label>
        <form id="second-form"><fieldset><legend>Second status</legend>
          <label><input type="radio" name="status" required checked value="second-one">Second one</label>
          <label><input type="radio" name="status" required value="second-two">Second two</label>
        </fieldset></form>
      </main><button type="button">Save and Continue</button></div>`);
    const application = new PlaywrightWorkdayApplicationPage(page);
    const observed = await application.observe(new AbortController().signal);
    assert.equal(observed.ok, true, JSON.stringify(observed));
    if (!observed.ok) return;
    assert.equal(observed.value.requiredFields.length, 2);
    assert.deepEqual(observed.value.requiredFields.map(({ verification }) => verification), [
      "verified",
      "verified",
    ]);
    assert.equal(new Set(observed.value.requiredFields.map(({ fieldId }) => fieldId)).size, 2);
  } finally {
    await browser.close();
  }
});

test("native radio completion includes hidden external required members and stable owner identity", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const checked of [true, false]) {
      const page = await browser.newPage();
      await page.setContent(`<div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowApplicationQuestionsPage">
          <form id="first-form"><fieldset><legend>First status</legend>
            <label><input type="radio" name="status" value="first-local">First local</label>
          </fieldset></form>
          <input hidden form="first-form" type="radio" name="status" required
            value="first-external" ${checked ? "checked" : ""}>
          <form id="second-form"><div role="radiogroup" aria-label="Second status">
            <label><input type="radio" name="status" required checked value="second-one">Second one</label>
            <label><input type="radio" name="status" required value="second-two">Second two</label>
          </div></form>
        </main><button type="button">Save and Continue</button></div>`);
      const application = new PlaywrightWorkdayApplicationPage(page);
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, JSON.stringify(before));
      if (!before.ok) continue;
      assert.equal(before.value.requiredFields.length, 2);
      assert.deepEqual(
        before.value.requiredFields.map(({ verification }) => verification).sort(),
        checked ? ["verified", "verified"] : ["unverified", "verified"],
      );
      const beforeIdentity = before.value.requiredFields.map((field) => field.fieldId).sort();
      await page.locator('main').evaluate((main) => {
        const forms = [...main.querySelectorAll("form")];
        main.append(forms[1]!, forms[0]!);
        const first = main.querySelector<HTMLInputElement>('#first-form input[name="status"]');
        first?.closest("fieldset")?.setAttribute("data-remounted", "true");
      });
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, JSON.stringify(after));
      if (after.ok) assert.deepEqual(
        after.value.requiredFields.map((field) => field.fieldId).sort(),
        beforeIdentity,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("all-hidden native radio groups retain browser-owned completion evidence", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const checked of [true, false]) {
      const page = await browser.newPage();
      await page.setContent(`<div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowApplicationQuestionsPage">
          <form aria-label="Hidden status"><fieldset><legend>Hidden status</legend>
            <label>Available<input style="display:none" type="radio" name="status" required
              value="available" ${checked ? "checked" : ""}></label>
            <label>Unavailable<input style="display:none" type="radio" name="status" required
              value="unavailable"></label>
          </fieldset></form>
        </main><button type="button">Save and Continue</button></div>`);
      const application = new PlaywrightWorkdayApplicationPage(page);
      const observed = await application.observe(new AbortController().signal);
      assert.equal(observed.ok, true, JSON.stringify(observed));
      if (observed.ok) {
        assert.equal(observed.value.requiredFields.length, 1);
        assert.equal(observed.value.requiredFields[0]?.verification,
          checked ? "verified" : "unverified");
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("a wrapping physical form discovers all-hidden external sibling radios", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const checked of [true, false]) {
      const page = await browser.newPage();
      await page.setContent(`<form aria-label="Application form">
        <div data-automation-id="applyFlowPage">
          <main data-automation-id="applyFlowApplicationQuestionsPage">
            <p>Questionnaire content</p>
          </main><button type="button">Save and Continue</button>
        </div>
        <div hidden><label>Yes<input type="radio" name="external-status" required
          value="yes" ${checked ? "checked" : ""}></label>
          <label>No<input type="radio" name="external-status" required value="no"></label></div>
      </form>`);
      const observed = await new PlaywrightWorkdayApplicationPage(page).observe(
        new AbortController().signal,
      );
      assert.equal(observed.ok, true, JSON.stringify(observed));
      if (observed.ok) {
        assert.equal(observed.value.requiredFields.length, 1);
        assert.equal(observed.value.requiredFields[0]?.verification,
          checked ? "verified" : "unverified");
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("inherited aria-disabled containers cannot contribute native radio evidence", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of ["radiogroup", "container"] as const) {
      const page = await browser.newPage();
      const group = `<div role="radiogroup" aria-label="Disabled status"
          ${variant === "radiogroup" ? 'aria-disabled="true"' : ""}>
        <label><input type="radio" name="status" required checked value="yes">Yes</label>
        <label><input type="radio" name="status" required value="no">No</label></div>`;
      await page.setContent(`<div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowApplicationQuestionsPage">
          ${variant === "container" ? `<section aria-disabled="true">${group}</section>` : group}
        </main><button type="button">Save and Continue</button></div>`);
      const observed = await new PlaywrightWorkdayApplicationPage(page).observe(
        new AbortController().signal,
      );
      assert.equal(observed.ok, true, `${variant}:${JSON.stringify(observed)}`);
      if (observed.ok) assert.equal(observed.value.requiredFields.length, 0, variant);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("disabled fieldset radios cannot contribute requiredness or checked readback", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const activeRequired of [true, false]) {
      const page = await browser.newPage();
      await page.setContent(`<div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowApplicationQuestionsPage">
          <form id="active-form"><fieldset><legend>Employment status</legend>
            <label>Active<input type="radio" name="status" value="active"
              ${activeRequired ? "required" : ""}></label>
          </fieldset></form>
          <fieldset disabled><legend>Disabled backing</legend>
            <input form="active-form" type="radio" name="status" value="disabled"
              required checked>
          </fieldset>
        </main><button type="button">Save and Continue</button></div>`);
      const application = new PlaywrightWorkdayApplicationPage(page);
      const observed = await application.observe(new AbortController().signal);
      assert.equal(observed.ok, true, JSON.stringify(observed));
      if (observed.ok) {
        assert.equal(observed.value.requiredFields.length, activeRequired ? 1 : 0);
        if (activeRequired) {
          assert.equal(observed.value.requiredFields[0]?.verification, "unverified");
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("native radio identity survives regenerated transport attributes and true clone reorder", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<div data-automation-id="applyFlowPage">
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <section id="first-owner"><form id="generated-a" name="transport-a" action="/old-a">
          <fieldset><legend>First status</legend>
            <label><input type="radio" name="status" required checked value="first">First</label>
            <label><input type="radio" name="status" required value="other-first">Other first</label>
          </fieldset></form><input hidden form="generated-a" type="radio" name="status" value="external-first"></section>
        <section id="second-owner"><form id="generated-b" name="transport-b" action="/old-b">
          <fieldset><legend>Second status</legend>
            <label><input type="radio" name="status" required checked value="second">Second</label>
            <label><input type="radio" name="status" required value="other-second">Other second</label>
          </fieldset></form><input hidden form="generated-b" type="radio" name="status" value="external-second"></section>
      </main><button type="button">Save and Continue</button></div>`);
    const application = new PlaywrightWorkdayApplicationPage(page);
    const before = await application.observe(new AbortController().signal);
    assert.equal(before.ok, true, JSON.stringify(before));
    if (!before.ok) return;
    const identities = before.value.requiredFields.map(({ fieldId }) => fieldId).sort();
    assert.equal(identities.length, 2);
    await page.locator("main").evaluate((main) => {
      const sections = [...main.querySelectorAll("section")].map((section, index) => {
        const clone = section.cloneNode(true) as HTMLElement;
        const form = clone.querySelector("form")!;
        const nextId = `remounted-${index}`;
        form.id = nextId;
        form.setAttribute("name", `new-transport-${index}`);
        form.setAttribute("action", `/new-${index}`);
        clone.querySelector('input[form]')?.setAttribute("form", nextId);
        return clone;
      });
      main.replaceChildren(sections[1]!, sections[0]!);
    });
    const after = await application.observe(new AbortController().signal);
    assert.equal(after.ok, true, JSON.stringify(after));
    if (after.ok) assert.deepEqual(
      after.value.requiredFields.map(({ fieldId }) => fieldId).sort(),
      identities,
    );
  } finally {
    await browser.close();
  }
});

test("native radio identity retains distinct semantic ancestor owners through clone reorder", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<div data-automation-id="applyFlowPage">
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <section aria-labelledby="alpha-heading"><h2 id="alpha-heading">Alpha section</h2>
          <form id="generated-alpha" action="/old-alpha"><fieldset><legend>Status</legend>
            <label><input type="radio" name="status" required checked value="yes">Yes</label>
          </fieldset></form>
          <input hidden form="generated-alpha" type="radio" name="status" value="no"></section>
        <section aria-labelledby="beta-heading"><h2 id="beta-heading">Beta section</h2>
          <form id="generated-beta" action="/old-beta"><fieldset><legend>Status</legend>
            <label><input type="radio" name="status" required checked value="yes">Yes</label>
          </fieldset></form>
          <input hidden form="generated-beta" type="radio" name="status" value="no"></section>
      </main><button type="button">Save and Continue</button></div>`);
    const application = new PlaywrightWorkdayApplicationPage(page);
    const before = await application.observe(new AbortController().signal);
    assert.equal(before.ok, true, JSON.stringify(before));
    if (!before.ok) return;
    const beforeIds = before.value.requiredFields.map(({ fieldId }) => fieldId);
    assert.equal(beforeIds.length, 2);
    assert.notEqual(beforeIds[0], beforeIds[1]);
    await page.locator("main").evaluate((main) => {
      const clones = [...main.querySelectorAll("section")].map((section, index) => {
        const clone = section.cloneNode(true) as HTMLElement;
        const form = clone.querySelector("form")!;
        const heading = clone.querySelector("h2")!;
        const nextFormId = `remounted-form-${index}`;
        const nextHeadingId = `remounted-heading-${index}`;
        form.id = nextFormId;
        form.setAttribute("action", `/new-${index}`);
        heading.id = nextHeadingId;
        clone.setAttribute("aria-labelledby", nextHeadingId);
        clone.querySelector('input[form]')?.setAttribute("form", nextFormId);
        return clone;
      });
      main.replaceChildren(clones[1]!, clones[0]!);
    });
    const after = await application.observe(new AbortController().signal);
    assert.equal(after.ok, true, JSON.stringify(after));
    if (after.ok) assert.deepEqual(
      after.value.requiredFields.map(({ fieldId }) => fieldId),
      [beforeIds[1], beforeIds[0]],
    );
  } finally {
    await browser.close();
  }
});

test("native radio semantic owners survive an external member and dedupe ARIA wrappers", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const variant of [
      {
        name: "external-legend-change",
        source: `<form id="application-form"><fieldset><legend>Source status</legend>
          <label><input type="radio" name="status" required checked value="shared">Shared</label>
          <label><input type="radio" name="status" required value="other">Other</label></fieldset></form>
          <input hidden form="application-form" type="radio" name="status" value="external">`,
        destination: `<form id="application-form"><fieldset><legend>Destination status</legend>
          <label><input type="radio" name="status" required checked value="shared">Shared</label>
          <label><input type="radio" name="status" required value="other">Other</label></fieldset></form>
          <input hidden form="application-form" type="radio" name="status" value="external">`,
      },
      {
        name: "native-aria-dedupe",
        source: `<form id="application-form"><div role="radiogroup" aria-label="Source status">
          <label><input type="radio" name="status" required checked value="shared">Shared</label>
          <label><input type="radio" name="status" required value="other">Other</label></div></form>`,
        destination: `<form id="application-form"><div role="radiogroup" aria-label="Destination status">
          <label><input type="radio" name="status" required checked value="shared">Shared</label>
          <label><input type="radio" name="status" required value="other">Other</label></div></form>`,
      },
    ]) {
      const page = await browser.newPage();
      await page.addInitScript(({ name, destination }) => {
        if (window.name !== `radio-owner-${name}`) return;
        document.addEventListener("DOMContentLoaded", () => {
          document.body.innerHTML = `<div data-automation-id="applyFlowPage"><main data-automation-id="applyFlowApplicationQuestionsPage">${destination}</main><button type="button">Save and Continue</button></div>`;
        });
      }, variant);
      await page.setContent(`<div data-automation-id="applyFlowPage"><main data-automation-id="applyFlowApplicationQuestionsPage">${variant.source}</main>
        <button id="next" type="button">Save and Continue</button></div><script>
          document.querySelector('#next').addEventListener('click', () => {
            window.name = 'radio-owner-${variant.name}';
            document.querySelector('main').remove();
            document.querySelector('[data-automation-id="applyFlowPage"]').insertAdjacentHTML(
              'afterbegin', '<main data-automation-id="applyFlowLoadingPage">Loading</main>');
          });
        </script>`);
      const application = new PlaywrightWorkdayApplicationPage(page, {
        timeoutMs: 150,
        navigationSettleTimeoutMs: 750,
      });
      const before = await application.observe(new AbortController().signal);
      assert.equal(before.ok, true, `${variant.name}:${JSON.stringify(before)}`);
      if (!before.ok) continue;
      assert.equal(before.value.requiredFields.length, 1, variant.name);
      assert.deepEqual(await application.next({
        journeyId: walkFixture.journeyId,
        from: "questionnaire",
        fromPageId: before.value.pageId,
        allowed: ["questionnaire"],
      }, new AbortController().signal), { ok: true, value: { advanced: true } }, variant.name);
      const after = await application.observe(new AbortController().signal);
      assert.equal(after.ok, true, `${variant.name}:${JSON.stringify(after)}`);
      if (after.ok) {
        assert.equal(after.value.requiredFields.length, 1, variant.name);
        assert.notEqual(after.value.pageId, before.value.pageId, variant.name);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("owned reload rejects a transient semantic destination that falls back to source", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      if (window.name !== "reload-transient-semantics") return;
      const source = `<div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowApplicationQuestionsPage">
          <div data-automation-id="formField"><label for="choice">Repeated question*</label>
            <select id="choice" required><option selected>Shared</option><option>Source</option></select></div>
        </main><button>Save and Continue</button></div>`;
      document.addEventListener("DOMContentLoaded", () => {
        document.body.innerHTML = `<div data-automation-id="applyFlowPage">
          <main data-automation-id="applyFlowApplicationQuestionsPage">
            <div data-automation-id="formField"><label for="choice">Repeated question*</label>
              <select id="choice" required multiple><option>Shared</option>
                <option selected>Transient</option></select></div>
          </main><button>Save and Continue</button></div>`;
        setTimeout(() => { document.body.innerHTML = source; }, 150);
      });
    });
    await page.setContent(`<div data-automation-id="applyFlowPage">
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField"><label for="choice">Repeated question*</label>
          <select id="choice" required><option selected>Shared</option><option>Source</option></select></div>
      </main><button id="next">Save and Continue</button>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          window.name = 'reload-transient-semantics';
          document.querySelector('main').remove();
          document.querySelector('[data-automation-id="applyFlowPage"]').insertAdjacentHTML(
            'afterbegin', '<main data-automation-id="applyFlowLoadingPage">Loading</main>');
        });
      </script></div>`);
    const application = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 100,
      navigationSettleTimeoutMs: 600,
    });
    const before = await application.observe(new AbortController().signal);
    assert.equal(before.ok, true, JSON.stringify(before));
    if (!before.ok) return;
    const result = await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: before.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal);
    assert.equal(result.ok, false, JSON.stringify(result));
    if (!result.ok) assert.equal(result.error.code, "browser_effect_uncertain");
    const after = await application.observe(new AbortController().signal);
    assert.equal(after.ok, true, JSON.stringify(after));
    if (after.ok) assert.equal(after.value.pageId, before.value.pageId);
  } finally {
    await browser.close();
  }
});

test("a current-action owned-loading reload preserves a same-marker questionnaire transition", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      if (window.name !== "reload-same-questionnaire") return;
      document.addEventListener("DOMContentLoaded", () => {
        document.body.innerHTML = `<div data-automation-id="applyFlowPage">
          <main data-automation-id="applyFlowApplicationQuestionsPage">
            <div data-automation-id="formField"><label>Repeated question*<input required value="committed"></label></div>
            <div data-automation-id="formField"><label>Destination detail*<input required value="committed"></label></div>
            <div data-automation-id="formField"><label>Persisted destination*<input required value="committed"></label></div>
          </main><button>Save and Continue</button></div>`;
      });
    });
    await page.setContent(`<div data-automation-id="applyFlowPage">
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField"><label>Repeated question*<input required value="committed"></label></div>
      </main><button id="next">Save and Continue</button>
      <script>
        let phase = 0;
        document.querySelector('#next').addEventListener('click', () => {
          const shell = document.querySelector('[data-automation-id="applyFlowPage"]');
          const root = document.querySelector('main');
          if (phase === 0) {
            shell.setAttribute('aria-busy', 'true');
            root.insertAdjacentHTML('beforeend', '<div data-automation-id="formField"><label>Destination detail*<input required value="committed"></label></div>');
            shell.setAttribute('aria-busy', 'false');
          } else {
            window.name = 'reload-same-questionnaire';
            root.remove();
            shell.insertAdjacentHTML('afterbegin', '<main data-automation-id="applyFlowLoadingPage">Loading</main>');
          }
          phase += 1;
        });
      </script></div>`);
    const application = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 100,
      navigationSettleTimeoutMs: 250,
    });
    const first = await application.observe(new AbortController().signal);
    assert.equal(first.ok, true, JSON.stringify(first));
    if (!first.ok) return;
    assert.deepEqual(await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: first.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal), { ok: true, value: { advanced: true } });
    const destination = await application.observe(new AbortController().signal);
    assert.equal(destination.ok, true, JSON.stringify(destination));
    if (!destination.ok) return;
    assert.notEqual(destination.value.pageId, first.value.pageId);
    const persisted = await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: destination.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal);
    assert.deepEqual(persisted, { ok: true, value: { advanced: true } });
    const reloaded = await application.observe(new AbortController().signal);
    assert.equal(reloaded.ok, true, JSON.stringify(reloaded));
    if (reloaded.ok) assert.notEqual(reloaded.value.pageId, destination.value.pageId);
  } finally {
    await browser.close();
  }
});

test("an old action witness cannot authorize a later owned-loading reload", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<div data-automation-id="applyFlowPage">
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField"><label>Repeated question*<input required value="committed"></label></div>
      </main><button id="next">Save and Continue</button>
      <script>
        let phase = 0;
        document.querySelector('#next').addEventListener('click', () => {
          const shell = document.querySelector('[data-automation-id="applyFlowPage"]');
          const root = document.querySelector('main[data-automation-id="applyFlowApplicationQuestionsPage"]');
          if (phase === 0) {
            shell.setAttribute('aria-busy', 'true');
            root.insertAdjacentHTML('beforeend', '<div data-automation-id="formField"><label>Destination detail*<input required value="committed"></label></div>');
            shell.setAttribute('aria-busy', 'false');
          } else {
            root.remove();
          }
          phase += 1;
        });
      </script></div>`);
    const application = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 100,
      navigationSettleTimeoutMs: 250,
    });
    const first = await application.observe(new AbortController().signal);
    assert.equal(first.ok, true, JSON.stringify(first));
    if (!first.ok) return;
    assert.deepEqual(await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: first.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal), { ok: true, value: { advanced: true } });
    const destination = await application.observe(new AbortController().signal);
    assert.equal(destination.ok, true, JSON.stringify(destination));
    if (!destination.ok) return;
    await page.locator('[data-automation-id="applyFlowPage"]').evaluate((shell) => {
      shell.insertAdjacentHTML("afterbegin",
        '<div data-automation-id="applyFlowLoadingPage"></div>');
    });
    const replay = await application.next({
      journeyId: walkFixture.journeyId,
      from: "questionnaire",
      fromPageId: destination.value.pageId,
      allowed: ["questionnaire"],
    }, new AbortController().signal);
    assert.equal(replay.ok, false, JSON.stringify(replay));
    if (!replay.ok) assert.equal(replay.error.code, "browser_effect_uncertain");
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
