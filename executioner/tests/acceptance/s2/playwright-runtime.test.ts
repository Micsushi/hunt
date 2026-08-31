import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { chromium, type BrowserContext, type Page } from "playwright";
import { PlaywrightWorkdayApplicationPage } from
  "../../../src/ats/workday/application/playwright-page.ts";
import { applyMutation, inspectPage } from "../../../src/browser/adapter.ts";
import { discoverFields } from "../../../src/form/discovery/discover-fields.ts";
import type {
  PersistentContext,
  PersistentPage,
} from "../../../src/browser/playwright-live/private/types.ts";
import {
  ownedApplicationPageAccess,
  releaseOwnedApplicationSession,
  retainOwnedApplicationSession,
  suspendOwnedApplicationSession,
  type OwnedApplicationOperation,
} from "../../../src/browser/playwright-live/private/application-page-types.ts";
import { PlaywrightPersistentBrowserSession } from
  "../../../src/browser/playwright-live/session.ts";
import { createQuestionAnswerLearningCapture } from
  "../../../src/live/evidence/question-answer-learning.ts";
import { liveApplicationExecutionPolicy } from
  "../../../src/contracts/application-execution-policy.ts";
import {
  bindQuestionnaireTargets,
  enrichQuestionnaireFields,
  finalizeQuestionnaireReconciliation,
  hydrateQuestionnairePopupOptions,
  isReviewExpectedField,
  isWorkdayReviewOmittedProfileField,
  monitorQuestionnaireCoverage,
  OwnedWorkdayApplicationRuntime,
  questionnairePopupHydrationTargets,
  reviewAnswerCandidates,
  seedCanonicalBinaryQuestionnaireOptions,
} from
  "../../../src/browser/playwright-live/private/workday-application-runtime.ts";

test("questionnaire finalization preserves causal order and always attempts learning evidence", async () => {
  const earliest = new Error("operation cancelled");
  const monitor = new Error("monitor rejected");
  const semantic = new Error("semantic close rejected");
  let writes = 0;
  const traces: object[] = [];
  await finalizeQuestionnaireReconciliation({
    causalError: earliest,
    closeBatch: async () => { throw monitor; },
    closeSemantic: async () => { throw semantic; },
    writeLearning: () => { writes += 1; return "a".repeat(64); },
    trace: (details) => traces.push(details),
  });
  assert.equal(writes, 1);
  assert.deepEqual(traces, [{
    learningPresent: true,
    closeFailure: true,
    secondaryFailureCount: 2,
    secondaryFailures: ["Error", "Error"],
  }]);

  await assert.rejects(finalizeQuestionnaireReconciliation({
    causalError: undefined,
    closeBatch: async () => { throw monitor; },
    closeSemantic: async () => undefined,
    writeLearning: () => { writes += 1; return null; },
  }), (error) => error === monitor);
  await assert.rejects(finalizeQuestionnaireReconciliation({
    causalError: undefined,
    closeBatch: async () => { throw monitor; },
    closeSemantic: async () => { throw semantic; },
    writeLearning: () => { writes += 1; return null; },
  }), (error) => error instanceof AggregateError &&
    error.errors[0] === monitor && error.errors[1] === semantic);
  assert.equal(writes, 3);
});

test("known binary questionnaire choices defer discovery to the exact selection popup", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<main data-automation-id="applyFlowApplicationQuestionsPage">
      <div data-automation-id="formField-referral">
        <label>Have you been referred by an Integer associate? <span data-automation-id="required">*</span></label>
        <button type="button" aria-haspopup="listbox">Select One</button>
      </div>
    </main>`);
    const pageId = "page-deferred-binary-question" as never;
    await bindQuestionnaireTargets(page, pageId);

    await seedCanonicalBinaryQuestionnaireOptions(page);

    const button = page.locator('button[aria-haspopup="listbox"]');
    assert.equal(await button.getAttribute("data-hunt-popup-options"), null);
    assert.equal(await button.getAttribute("data-hunt-deferred-options"), '["Yes","No"]');
    assert.deepEqual(await questionnairePopupHydrationTargets(page), []);
    const semantic = await inspectPage(
      page,
      "live_session_deferred_binary_01" as never,
      pageId,
      new Map(),
    );
    const target = semantic.observation.targets[0];
    assert.equal(target?.control.kind, "select");
    assert.deepEqual(
      target?.control.kind === "select" ? target.control.options : [],
      ["Yes", "No"],
    );
  } finally {
    await browser.close();
  }
});

test("conditional visa-status choice is not seeded as a binary sponsorship question", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<main data-automation-id="applyFlowApplicationQuestionsPage">
      <div data-automation-id="formField-visa-status">
        <label>If you will require sponsorship, do you currently hold either of the following: <span data-automation-id="required">*</span></label>
        <button type="button" aria-haspopup="listbox">Select One</button>
      </div>
    </main>`);
    const pageId = "page-conditional-visa-status" as never;
    await bindQuestionnaireTargets(page, pageId);

    await seedCanonicalBinaryQuestionnaireOptions(page);

    const button = page.locator('button[aria-haspopup="listbox"]');
    assert.equal(await button.getAttribute("data-hunt-deferred-options"), null);
    assert.equal((await questionnairePopupHydrationTargets(page)).length, 1);
  } finally {
    await browser.close();
  }
});

test("answered conditional choice remains eligible for catalog recovery after remount", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<main data-automation-id="applyFlowApplicationQuestionsPage">
      <div data-automation-id="formField-visa-status">
        <label>If you will require sponsorship, do you currently hold either of the following: <span data-automation-id="required">*</span></label>
        <button type="button" aria-haspopup="listbox">H-1B</button>
      </div>
    </main>`);
    const pageId = "page-answered-conditional-visa-status" as never;
    await bindQuestionnaireTargets(page, pageId);

    const hydrationTargets = await questionnairePopupHydrationTargets(page);
    assert.equal(hydrationTargets.length, 1);
    assert.match(hydrationTargets[0] ?? "", /^target-workday-[a-f0-9]{8}-1$/u);
    const semantic = await inspectPage(
      page,
      "live_session_answered_conditional_01" as never,
      pageId,
      new Map(),
    );
    const target = semantic.observation.targets[0];
    assert.equal(target?.readback.kind, "selected");
    assert.deepEqual(
      target?.control.kind === "select" ? target.control.options : [],
      ["H-1B"],
    );
  } finally {
    await browser.close();
  }
});

test("retained Integer questionnaire date marker agrees across all coverage observers", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const selectLabels = [
      "Do you certify that you are 18 years of age or older?",
      "Have you been referred by an Integer associate?",
      "Are you a current Integer associate (this does not apply to contingent/contract work)?",
      "Have you previously applied for a position with our company?",
      "Do you have any relatives currently employed by Integer?",
      "Do you now, or will you in the future, require sponsorship to work legally for Integer in the U.S.?",
      "Based on your understanding of this role, do you believe you are physically able to perform the essential functions of the job?",
      "Are you currently subject to any company agreement that would prevent you from working with Integer?",
    ];
    await page.setContent(`<main data-automation-id="applyFlowApplicationQuestionsPage">
      ${selectLabels.map((label, index) => `<div data-automation-id="formField-select-${index}">
        <label>${label}<span data-automation-id="required">*</span></label>
        <button aria-haspopup="listbox">Select One</button>
      </div>`).join("")}
      <div data-automation-id="formField-start-date">
        <label>When are you available to start?*</label>
        <div data-automation-id="dateInputWrapper">
          <input data-automation-id="dateSectionMonth-input">
          <input data-automation-id="dateSectionDay-input">
          <input data-automation-id="dateSectionYear-input">
        </div>
      </div>
      <div data-automation-id="formField-salary">
        <label>Salary expectations<span data-automation-id="required">*</span></label>
        <textarea required></textarea>
      </div>
    </main>`);
    const pageId = "page-integer-required-date" as never;
    await bindQuestionnaireTargets(page, pageId);
    await page.locator('button[aria-haspopup="listbox"]').evaluateAll((buttons) =>
      buttons.forEach((button) =>
        button.setAttribute("data-hunt-popup-options", JSON.stringify(["Yes", "No"]))
      )
    );

    const semantic = await inspectPage(
      page,
      "live_session_integer_required_date_01" as never,
      pageId,
      new Map(),
    );
    const monitor = await monitorQuestionnaireCoverage(page);
    const application = await new PlaywrightWorkdayApplicationPage(page).observe(
      new AbortController().signal,
    );

    assert.equal(semantic.observation.targets.length, 10);
    assert.equal(semantic.observation.targets.filter(({ required }) => required).length, 10);
    assert.deepEqual(monitor, {
      fieldCount: 10,
      requiredFieldCount: 10,
      typeCounts: { select: 8, date: 1, textarea: 1 },
    });
    assert.equal(application.ok, true);
    assert.equal(application.ok && application.value.requiredFields.length, 10);
  } finally {
    await browser.close();
  }
});

test("retained Intermountain long acknowledgement agrees across questionnaire observers", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const acknowledgement =
      "By applying for a position with Intermountain, I acknowledge that I will comply " +
      "with all applicable Intermountain policies and expectations. If applying for a " +
      "remote or hybrid role, this includes remote work expectations related to " +
      "confidentiality, information security, work schedules, conflicts of interest, and " +
      "use of company equipment. I further acknowledge that outside employment or " +
      "activities may not interfere with job responsibilities or create a conflict of " +
      "interest with Intermountain. Actual or reasonably perceived conflicts may be " +
      "grounds for disqualification from consideration or, if hired, corrective action " +
      "up to and including termination of employment.";
    assert.ok([...acknowledgement].length > 512);
    const selectLabels = [
      "Are you currently employed with a company of Intermountain Health?",
      "Do you meet all minimum qualifications listed in this job posting?",
      "Can you perform the essential functions of this job?",
      "Can you meet all immunization requirements?",
      "Are you at least 18 years of age?",
      acknowledgement,
      "Will you now or in the future require visa sponsorship for employment?",
      "Are you disqualified from working in a federally funded program?",
      "Do you have relatives employed by an Intermountain Health company?",
    ];
    await page.setContent(`<main data-automation-id="applyFlowApplicationQuestionsPage">
      ${selectLabels.map((label, index) => `<div data-automation-id="formField-${index}">
        <label>${label}<span data-automation-id="required">*</span></label>
        <button type="button" aria-haspopup="listbox">Select One</button>
      </div>`).join("")}
      <div data-automation-id="formField-salary">
        <label>What is your minimum acceptable salary?<span data-automation-id="required">*</span></label>
        <textarea required></textarea>
      </div>
    </main>`);
    const pageId = "page-intermountain-long-acknowledgement" as never;
    await bindQuestionnaireTargets(page, pageId);
    await page.locator('button[aria-haspopup="listbox"]').evaluateAll((buttons) =>
      buttons.forEach((button) =>
        button.setAttribute("data-hunt-popup-options", JSON.stringify(["Yes", "No"]))
      )
    );

    const semantic = await inspectPage(
      page,
      "live_session_inter_long_ack_01" as never,
      pageId,
      new Map(),
    );
    const monitor = await monitorQuestionnaireCoverage(page);
    const application = await new PlaywrightWorkdayApplicationPage(page).observe(
      new AbortController().signal,
    );

    assert.equal(semantic.observation.targets.length, 10);
    assert.equal(semantic.observation.targets.filter(({ required }) => required).length, 10);
    assert.ok(semantic.observation.targets.some(({ name }) =>
      name.startsWith("By applying for a position with Intermountain") &&
      [...name].length <= 512
    ));
    assert.deepEqual(monitor, {
      fieldCount: 10,
      requiredFieldCount: 10,
      typeCounts: { select: 9, textarea: 1 },
    });
    assert.equal(application.ok, true);
    assert.equal(application.ok && application.value.requiredFields.length, 10);
  } finally {
    await browser.close();
  }
});

test("questionnaire popup hydration ignores a stale unrelated portal across control remount", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField">
          <label>Have you been referred by an Integer associate? <span data-automation-id="required">*</span></label>
          <button id="mcvf1" type="button" aria-haspopup="listbox" aria-controls="target-popup">Select One</button>
        </div>
      </main>
      <div id="stale-popup" role="listbox"><div role="option">Unrelated stale option</div></div>
      <script>
        const bind = (button) => button.addEventListener('click', () => {
          const popup = document.createElement('div');
          popup.id = 'target-popup';
          popup.setAttribute('role', 'listbox');
          popup.innerHTML = '<div role="option">Yes</div><div role="option">No</div>';
          document.body.append(popup);
          button.setAttribute('aria-expanded', 'true');
        });
        bind(document.querySelector('#mcvf1'));
        document.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          document.querySelector('#target-popup')?.remove();
          const button = document.querySelector('[aria-controls="target-popup"]');
          const replacement = button.cloneNode(true);
          replacement.id = 'mcvf101';
          replacement.setAttribute('aria-expanded', 'false');
          replacement.removeAttribute('data-hunt-target-token');
          replacement.removeAttribute('data-hunt-popup-options');
          button.replaceWith(replacement);
          bind(replacement);
        });
      </script>
    `);
    const pageId = "questionnaire-stale-portal-fixture" as never;
    await bindQuestionnaireTargets(page, pageId);
    const token = await page.locator('[aria-controls="target-popup"]')
      .getAttribute("data-hunt-target-token");
    assert.match(token ?? "", /^target-workday-[a-f0-9]{8}-1$/u);

    await hydrateQuestionnairePopupOptions(page, pageId, token!, 5_000);

    const rebound = page.locator('[aria-controls="target-popup"]');
    assert.notEqual(await rebound.getAttribute("data-hunt-target-token"), token);
    assert.match(await rebound.getAttribute("data-hunt-target-token") ?? "",
      /^target-workday-[a-f0-9]{8}-1$/u);
    assert.deepEqual(
      JSON.parse(await rebound.getAttribute("data-hunt-popup-options") ?? "[]"),
      ["Yes", "No"],
    );
    assert.equal(await page.locator("#stale-popup").isVisible(), true);
    assert.equal(await page.locator("#target-popup").count(), 0);
  } finally {
    await browser.close();
  }
});

test("eight questionnaire hydrations close the exact owned portal before semantic inspection", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        ${Array.from({ length: 8 }, (_, index) => `
          <div data-automation-id="formField-${index + 1}">
            <label>Integer question ${index + 1} <span data-automation-id="required">*</span></label>
            <button id="mcvf${index + 1}" type="button" aria-haspopup="listbox"
              aria-controls="target-popup-${index + 1}" aria-expanded="false">Select One</button>
          </div>
        `).join("")}
      </main>
      <div id="stale-popup" role="listbox"><div role="option">Unrelated stale option</div></div>
      <script>
        let openIndex = 0;
        let eighthToggleCount = 0;
        const close = index => {
          document.querySelector('#target-popup-' + index)?.remove();
          const button = document.querySelector('#mcvf' + index);
          button?.setAttribute('aria-expanded', 'false');
          if (openIndex === index) openIndex = 0;
        };
        document.querySelectorAll('button[aria-haspopup="listbox"]').forEach((button, offset) => {
          const index = offset + 1;
          button.addEventListener('click', () => {
            if (openIndex === index) {
              if (index === 8) eighthToggleCount += 1;
              close(index);
              return;
            }
            if (openIndex !== 0) close(openIndex);
            const popup = document.createElement('div');
            popup.id = 'target-popup-' + index;
            popup.setAttribute('role', 'listbox');
            popup.innerHTML = '<div role="option">Yes</div><div role="option">No</div>';
            document.body.append(popup);
            button.setAttribute('aria-expanded', 'true');
            openIndex = index;
          });
        });
        document.addEventListener('keydown', event => {
          if (event.key !== 'Escape' || openIndex === 8) return;
          close(openIndex);
        });
        window.fixtureState = () => ({ openIndex, eighthToggleCount });
      </script>
    `);
    const pageId = "questionnaire-eight-portal-fixture" as never;
    await bindQuestionnaireTargets(page, pageId);
    const tokens = await page.locator('main button').evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-hunt-target-token"))
    );
    assert.equal(tokens.length, 8);
    for (const token of tokens) {
      assert.notEqual(token, null);
      await hydrateQuestionnairePopupOptions(page, pageId, token!, 5_000);
    }

    assert.deepEqual(await page.evaluate(() =>
      (window as unknown as { fixtureState(): { openIndex: number; eighthToggleCount: number } })
        .fixtureState()
    ), { openIndex: 0, eighthToggleCount: 1 });
    assert.equal(await page.locator('[id^="target-popup-"]').count(), 0);
    assert.equal(await page.locator('[data-hunt-popup-hydration-owner]').count(), 0);
    assert.equal(await page.locator('[data-hunt-popup-hydration-preexisting]').count(), 0);
    assert.equal(await page.locator('#stale-popup').isVisible(), true);
    for (const button of await page.locator('main button').all()) {
      assert.deepEqual(
        JSON.parse(await button.getAttribute("data-hunt-popup-options") ?? "[]"),
        ["Yes", "No"],
      );
      assert.equal(await button.getAttribute("aria-expanded"), "false");
    }
  } finally {
    await browser.close();
  }
});

test("questionnaire mutation selects only from its newly opened portal", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField-current">
          <label>Are you currently subject to a company agreement? <span data-automation-id="required">*</span></label>
          <button id="mcvf1" type="button" aria-haspopup="listbox">Select One</button>
        </div>
      </main>
      <div id="stale-popup" data-automation-id="promptMenu">
        <div data-automation-id="promptOption" data-stale="true">No</div>
      </div>
      <script>
        let staleClicks = 0;
        document.querySelector('[data-stale="true"]').addEventListener('click', () => { staleClicks += 1; });
        const field = document.querySelector('[data-automation-id="formField-current"]');
        const bind = (button) => button.addEventListener('click', () => {
          if (document.querySelector('#target-popup') !== null) return;
          const popup = document.createElement('div');
          popup.id = 'target-popup';
          popup.dataset.automationId = 'promptMenu';
          popup.innerHTML = '<div data-automation-id="promptOption">Yes</div><div data-automation-id="promptOption">No</div>';
          popup.addEventListener('click', (event) => {
            const option = event.target.closest('[data-automation-id="promptOption"]');
            if (option === null) return;
            const replacement = button.cloneNode(true);
            replacement.id = 'mcvf101';
            replacement.textContent = option.textContent.trim();
            replacement.removeAttribute('data-hunt-target-token');
            button.replaceWith(replacement);
            bind(replacement);
          });
          document.body.append(popup);
        });
        bind(document.querySelector('#mcvf1'));
        window.fixtureState = () => ({ staleClicks });
      </script>
    `);
    const pageId = "questionnaire-target-portal-fixture" as never;
    const sessionId = "browser_session_target_portal_fixture" as never;
    await bindQuestionnaireTargets(page, pageId);
    const inspected = await inspectPage(page, sessionId, pageId, new Map());
    const target = inspected.observation.targets.find(({ name }) =>
      name === "Are you currently subject to a company agreement? *"
    );
    assert.notEqual(target, undefined);
    const resolved = inspected.targets.get(target!.token)?.[0];
    assert.notEqual(resolved, undefined);

    const mutationResult = await applyMutation(
      page,
      resolved!,
      { kind: "select", target: target!.token, option: "No" as never },
      undefined,
      5_000,
    );
    const mutationDiagnostics = await page.locator("body").evaluate((body) => ({
      interaction: body.querySelector('[data-hunt-target-token]')?.getAttribute("data-hunt-target-token"),
      owners: [...body.querySelectorAll('[data-hunt-field-popup-owner]')].map((owner) => owner.id),
      preexisting: [...body.querySelectorAll('[data-hunt-field-popup-preexisting]')].map((owner) => owner.id),
      popups: [...body.querySelectorAll('[data-automation-id="promptMenu"]')].map((popup) => ({
        id: popup.id,
        text: popup.textContent?.trim(),
      })),
      buttonText: body.querySelector('[data-automation-id="formField-current"] button')?.textContent?.trim(),
    }));
    assert.equal(mutationResult, "applied", JSON.stringify({
      interaction: resolved!.interaction,
      mutationDiagnostics,
    }));

    assert.equal(await page.locator('[data-automation-id="formField-current"] button').innerText(), "No");
    assert.equal(await page.locator('[data-automation-id="formField-current"] button')
      .getAttribute("data-hunt-target-token"), target!.token);
    assert.deepEqual(await page.evaluate(() =>
      (window as unknown as { fixtureState(): { staleClicks: number } }).fixtureState()
    ), { staleClicks: 0 });
    assert.equal(await page.locator("#stale-popup").isVisible(), true);
  } finally {
    await browser.close();
  }
});

test("questionnaire mutation reclaims one retained portal for the next exact field", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField-relative">
          <label>Do you have any relatives currently employed by Integer? <span data-automation-id="required">*</span></label>
          <button id="relative" type="button" aria-haspopup="listbox">Select One</button>
        </div>
        <div data-automation-id="formField-essential">
          <label>Based on your understanding of this role, do you believe you are physically able to perform the essential functions of the job? <span data-automation-id="required">*</span></label>
          <button id="essential" type="button" aria-haspopup="listbox">Select One</button>
        </div>
      </main>
      <div id="retained-prompt" data-automation-id="promptMenu" hidden>
        <div data-automation-id="promptOption">Yes</div>
        <div data-automation-id="promptOption">No</div>
      </div>
      <script>
        let activeButton;
        const popup = document.querySelector('#retained-prompt');
        document.querySelectorAll('button[aria-haspopup="listbox"]').forEach(button => {
          button.addEventListener('click', () => {
            activeButton = button;
            popup.hidden = false;
          });
        });
        popup.addEventListener('click', event => {
          const option = event.target.closest('[data-automation-id="promptOption"]');
          if (option === null || activeButton === undefined) return;
          activeButton.textContent = option.textContent.trim();
          // Workday can retain and retarget the same portal for the next field.
        });
      </script>
    `);
    const pageId = "questionnaire-retained-portal-fixture" as never;
    const sessionId = "browser_session_retained_portal_fixture" as never;
    await bindQuestionnaireTargets(page, pageId);
    const inspected = await inspectPage(page, sessionId, pageId, new Map());
    const relative = inspected.observation.targets.find(({ name }) =>
      name.startsWith("Do you have any relatives")
    );
    const essential = inspected.observation.targets.find(({ name }) =>
      name.startsWith("Based on your understanding")
    );
    assert.notEqual(relative, undefined);
    assert.notEqual(essential, undefined);
    const relativeTarget = inspected.targets.get(relative!.token)?.[0];
    const essentialTarget = inspected.targets.get(essential!.token)?.[0];
    assert.notEqual(relativeTarget, undefined);
    assert.notEqual(essentialTarget, undefined);

    assert.equal(await applyMutation(
      page,
      relativeTarget!,
      { kind: "select", target: relative!.token, option: "No" as never },
      undefined,
      500,
    ), "applied");
    assert.equal(await page.locator('#retained-prompt').isVisible(), true);
    assert.equal(await applyMutation(
      page,
      essentialTarget!,
      { kind: "select", target: essential!.token, option: "Yes" as never },
      undefined,
      500,
    ), "applied");
    assert.equal(await page.locator('#essential').innerText(), "Yes");
  } finally {
    await browser.close();
  }
});

test("questionnaire mutation follows the visible Workday control across a retained hidden remount", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField-relocation">
          <label>Will you require relocation to accept this position?<span data-automation-id="required">*</span></label>
          <button id="mcvf1" type="button" aria-haspopup="listbox">Select One</button>
        </div>
      </main>
    `);
    const pageId = "questionnaire-retained-hidden-remount" as never;
    const sessionId = "browser_session_retained_hidden_remount" as never;
    await bindQuestionnaireTargets(page, pageId);
    await page.locator('button[aria-haspopup="listbox"]').evaluate((button) =>
      button.setAttribute("data-hunt-popup-options", JSON.stringify(["Yes", "No"]))
    );
    await bindQuestionnaireTargets(page, pageId);
    const admitted = await inspectPage(page, sessionId, pageId, new Map());
    const target = admitted.observation.targets.find(({ name }) =>
      name === "Will you require relocation to accept this position?*"
    );
    assert.notEqual(target, undefined);
    const resolved = admitted.targets.get(target!.token)?.[0];
    assert.notEqual(resolved, undefined);

    await page.evaluate(() => {
      const retained = document.querySelector("main")! as HTMLElement;
      retained.hidden = true;
      const replacement = document.createElement("main");
      replacement.dataset.automationId = "applyFlowApplicationQuestionsPage";
      replacement.innerHTML = `
        <div data-automation-id="formField-relocation">
          <label>Will you require relocation to accept this position?<span data-automation-id="required">*</span></label>
          <button id="mcvf101" type="button" aria-haspopup="listbox"
            data-hunt-popup-options='["Yes","No"]'>Select One</button>
        </div>`;
      const button = replacement.querySelector("button")!;
      button.addEventListener("click", () => {
        const popup = document.createElement("div");
        popup.dataset.automationId = "promptMenu";
        popup.innerHTML = '<div data-automation-id="promptOption">Yes</div>' +
          '<div data-automation-id="promptOption">No</div>';
        popup.addEventListener("click", (event) => {
          const option = (event.target as Element).closest('[data-automation-id="promptOption"]');
          if (option === null) return;
          button.textContent = option.textContent;
          popup.remove();
        });
        document.body.append(popup);
      });
      document.body.append(replacement);
    });
    await bindQuestionnaireTargets(page, pageId);

    const mutation = await applyMutation(
      page,
      resolved!,
      { kind: "select", target: target!.token, option: "No" as never },
      undefined,
      5_000,
    );
    assert.equal(mutation, "applied");

    const semantic = await inspectPage(page, sessionId, pageId, new Map());
    const monitor = await monitorQuestionnaireCoverage(page);
    const application = await new PlaywrightWorkdayApplicationPage(page).observe(
      new AbortController().signal,
    );
    const matching = semantic.observation.targets.filter(({ token }) => token === target!.token);
    assert.equal(matching.length, 1);
    assert.deepEqual(matching[0]!.state, {
      visibility: "visible",
      enabled: true,
      actionable: true,
    });
    assert.deepEqual(matching[0]!.readback, { kind: "selected", option: "No" });
    assert.deepEqual(monitor, {
      fieldCount: 1,
      requiredFieldCount: 1,
      typeCounts: { select: 1 },
    });
    assert.equal(application.ok, true);
    assert.equal(application.ok && application.value.requiredFields[0]?.verification, "verified");
  } finally {
    await browser.close();
  }
});

test("Workday Review admits only its exact omitted composites and canonical display aliases", () => {
  assert.deepEqual([
    "identity.middle_name",
    "address.line2",
    "address.postal_code",
    "address.region",
    "phone.device_type",
    "phone.country_code",
  ].map((fieldId) => isWorkdayReviewOmittedProfileField(fieldId)), Array(6).fill(true));
  assert.equal(isWorkdayReviewOmittedProfileField("address.city"), false);
  assert.equal(isWorkdayReviewOmittedProfileField("social.linkedin"), false);
  assert.equal(
    reviewAnswerCandidates("https://www.linkedin.com/in/wjshi")
      .has("https://linkedin.com/in/wjshi"),
    true,
  );
  assert.equal(reviewAnswerCandidates("https://example.com/in/wjshi").has(
    "https://linkedin.com/in/wjshi",
  ), false);
  assert.equal(reviewAnswerCandidates("Direct Sourcing").has("Recruiter"), true);
  assert.equal(reviewAnswerCandidates("Recruiter Outreach").has("Recruiter"), true);
  assert.equal(reviewAnswerCandidates("Direct Mail").has("Recruiter"), false);
});

test("questionnaire binding owns every admitted visible Workday question root", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    for (const root of [
      "applyFlowPrimaryQuestionsPage",
      "applyFlowPrimaryQuestionnairePage",
      "applyFlowApplicationQuestionsPage",
      "applyFlowVoluntaryDisclosuresPage",
      "applyFlowSelfIdentifyPage",
    ]) {
      await page.setContent(`
        <main data-automation-id="${root}">
          <label>Brief interest statement
            <textarea required aria-label="Brief interest statement"></textarea>
          </label>
        </main>
      `);
      await bindQuestionnaireTargets(page, "questionnaire-root-fixture" as never);
      assert.equal(
        await page.locator("textarea").getAttribute("data-hunt-target-token"),
        "target-s1-field-interest",
        root,
      );
    }
  } finally {
    await context.close();
    await browser.close();
  }
});

test("questionnaire binding excludes navigation buttons from semantic field ownership", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField-age">
          <label>Do you certify that you are 18 years of age or older?
            <span data-automation-id="required">*</span>
          </label>
          <button type="button" aria-haspopup="listbox">Select One</button>
        </div>
        <button type="button" data-automation-id="pageFooterNextButton">Next</button>
      </main>
    `);
    await bindQuestionnaireTargets(page, "questionnaire-navigation-fixture" as never);
    assert.match(
      await page.locator('button[aria-haspopup="listbox"]').getAttribute("data-hunt-target-token") ?? "",
      /^target-workday-[a-f0-9]{8}-1$/u,
    );
    assert.equal(
      await page.locator('[data-automation-id="pageFooterNextButton"]')
        .getAttribute("data-hunt-target-token"),
      null,
    );
  } finally {
    await browser.close();
  }
});

test("questionnaire binding gives unknown questions stable value-free target identities", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <fieldset><legend>Tenant-specific question</legend>
          <label><input type="radio" name="tenant" value="yes">Yes</label>
          <label><input type="radio" name="tenant" value="no">No</label>
        </fieldset>
      </main>
    `);
    await bindQuestionnaireTargets(page, "questionnaire-unknown-fixture" as never);
    const token = await page.locator("fieldset").getAttribute("data-hunt-target-token");
    assert.match(token ?? "", /^target-workday-[a-f0-9]{8}-1$/u);
    assert.doesNotMatch(token ?? "", /tenant|question/u);
  } finally {
    await browser.close();
  }
});

test("questionnaire adapter fills Workday segmented signed dates", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main data-automation-id="applyFlowSelfIdentifyPage">
        <div data-automation-id="formField-dateSignedOn">
          <label>Date Signed <span data-automation-id="required">*</span></label>
          <div data-automation-id="dateInputWrapper">
            <input role="spinbutton" data-automation-id="dateSectionMonth-input">
            <input role="spinbutton" data-automation-id="dateSectionDay-input">
            <input role="spinbutton" data-automation-id="dateSectionYear-input">
          </div>
        </div>
      </main>
    `);
    await bindQuestionnaireTargets(page, "page-self-identify-segmented-date" as never);
    const wrapper = page.locator('[data-automation-id="dateInputWrapper"]');
    assert.match(
      await wrapper.getAttribute("data-hunt-target-token") ?? "",
      /^target-workday-[a-f0-9]{8}-1$/u,
    );
    assert.equal(await wrapper.locator("input[data-hunt-target-token]").count(), 0);

    const inspection = await inspectPage(
      page,
      "live_session_segmented_date_01" as never,
      "page-self-identify-segmented-date" as never,
      new Map(),
    );
    const dateTargets = [...inspection.targets.values()].flat()
      .filter(({ control }) => control.kind === "date");
    assert.equal(dateTargets.length, 1);
    assert.equal(dateTargets[0]!.interaction, "composite-date");
    assert.equal(dateTargets[0]!.readback.kind, "empty");
    assert.equal(
      await applyMutation(page, dateTargets[0]!, {
        kind: "set_date",
        target: dateTargets[0]!.token,
        isoDate: "2026-08-21" as never,
      }, undefined, 1_000),
      "applied",
    );

    const verified = await inspectPage(
      page,
      "live_session_segmented_date_01" as never,
      "page-self-identify-segmented-date" as never,
      new Map(),
    );
    const readback = [...verified.targets.values()].flat()
      .find(({ control }) => control.kind === "date")?.readback;
    assert.deepEqual(readback, { kind: "text", value: "2026-08-21" });
  } finally {
    await browser.close();
  }
});

test("conditional Workday dates retain distinct required target identities", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div id="questions">
          <div id="availability-field" data-automation-id="formField-availability">
            <label>When are you available to start?*</label>
            <div data-automation-id="dateInputWrapper">
              <input data-automation-id="dateSectionMonth-input">
              <input data-automation-id="dateSectionDay-input">
              <input data-automation-id="dateSectionYear-input">
            </div>
          </div>
        </div>
      </main>
    `);
    const pageId = "page-conditional-workday-dates" as never;
    await bindQuestionnaireTargets(page, pageId);
    const availability = page.locator("#availability-field [data-automation-id=dateInputWrapper]");
    const originalAvailabilityToken = await availability.getAttribute("data-hunt-target-token");

    await page.locator("#questions").evaluate((questions) => {
      questions.insertAdjacentHTML("afterbegin", `
        <div id="niv-field" data-automation-id="formField-finalNiv">
          <label>What is your final NIV date?*</label>
          <div data-automation-id="dateInputWrapper">
            <input data-automation-id="dateSectionMonth-input">
            <input data-automation-id="dateSectionDay-input">
            <input data-automation-id="dateSectionYear-input">
          </div>
        </div>
      `);
    });
    await bindQuestionnaireTargets(page, pageId);

    const niv = page.locator("#niv-field [data-automation-id=dateInputWrapper]");
    assert.equal(
      await availability.getAttribute("data-hunt-target-token"),
      originalAvailabilityToken,
    );
    assert.notEqual(
      await niv.getAttribute("data-hunt-target-token"),
      originalAvailabilityToken,
    );
    const inspection = await inspectPage(
      page,
      "live_session_conditional_dates_01" as never,
      pageId,
      new Map(),
    );
    const dates = [...inspection.targets.values()].flat()
      .filter(({ control }) => control.kind === "date");
    assert.deepEqual(
      dates.map(({ name, required }) => ({ name, required })),
      [
        { name: "What is your final NIV date?*", required: true },
        { name: "When are you available to start?*", required: true },
      ],
    );
    await availability.locator("input").evaluateAll((inputs) => {
      ["08", "25", "2026"].forEach((value, index) => {
        (inputs[index] as HTMLInputElement).value = value;
      });
    });
    const oneCommitted = await new PlaywrightWorkdayApplicationPage(page).observe(
      new AbortController().signal,
    );
    assert.deepEqual(
      oneCommitted.ok && oneCommitted.value.requiredFields.map(({ verification }) => verification),
      ["unverified", "verified"],
    );
    await niv.locator("input").evaluateAll((inputs) => {
      ["08", "26", "2026"].forEach((value, index) => {
        (inputs[index] as HTMLInputElement).value = value;
      });
    });
    const bothCommitted = await new PlaywrightWorkdayApplicationPage(page).observe(
      new AbortController().signal,
    );
    assert.deepEqual(
      bothCommitted.ok && bothCommitted.value.requiredFields.map(({ verification }) => verification),
      ["verified", "verified"],
    );
  } finally {
    await browser.close();
  }
});

test("repeated questionnaire navigation distinguishes the destination by exact field truth", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html data-hunt-submit-activated="false"><body data-hunt-application-page="questionnaire">
    <main data-automation-id="applyFlowApplicationQuestionsPage">
      <div data-automation-id="formField-source"><label>Source question
        <textarea required data-hunt-field-id="source-question">verified source answer</textarea>
      </label></div>
      <button type="button">Save and Continue</button>
    </main>
    <script>
      document.querySelector('button').addEventListener('click', () => {
        document.querySelector('main').outerHTML =
          '<main data-automation-id="applyFlowVoluntaryDisclosuresPage">' +
          '<div data-automation-id="formField-destination"><label>Destination question' +
          '<input required data-hunt-field-id="destination-question" value="verified destination answer"></label></div>' +
          '<button type="button">Save and Continue</button></main>';
      });
    </script>
  </body></html>`);
  const monitored: string[] = [];
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {} as never,
    acceptances: { record() {} },
    nextOperationId: () => generatedOperationId("operation_repeated_questionnaire_next_01"),
    timeoutMs: 1_000,
    initialReviewExpected: [],
    externalMonitor: {
      async auth() {},
      async application(_page, _pageName, moment) { monitored.push(moment); },
    },
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_repeated_questionnaire_01"),
    sessionId: "live_session_repeated_questionnaire_01" as LiveSessionId,
    profileLeaseId: "profile_lease_repeated_questionnaire_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  });
  try {
    const sourceTruth = await new PlaywrightWorkdayApplicationPage(page).observe(
      new AbortController().signal,
    );
    assert.equal(sourceTruth.ok, true, JSON.stringify(sourceTruth));
    if (!sourceTruth.ok) return;
    const result = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_repeated_questionnaire_01"),
      operationId: generatedOperationId("operation_repeated_questionnaire_run_01"),
      sessionId: "live_session_repeated_questionnaire_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "next",
      input: {
        journeyId: journeyId("journey_repeated_questionnaire_01"),
        from: "questionnaire",
        fromPageId: sourceTruth.value.pageId,
        allowed: ["questionnaire", "pre_review"],
      },
    }, new AbortController().signal) as {
      readonly ok: boolean;
      readonly value?: { readonly destination?: { readonly page: string } };
    };

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value?.destination?.page, "questionnaire");
    assert.deepEqual(monitored, ["before_navigation", "transition"]);
  } finally {
    runtime.dispose();
    await context.close();
    await browser.close();
  }
});

test("a profile preflight owner-input block remains a deterministic page failure before mutation", async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), "hunt-s2-profile-learning-runtime-"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html data-hunt-page-id="page-profile" data-hunt-submit-activated="false"><body data-hunt-application-page="profile"><main data-automation-id="applyFlowMyInfoPage"><label for="name--legalName--firstName">First Name</label><input id="name--legalName--firstName" required><input required data-automation-id="unreviewedRequiredControl"></main></body></html>`);
  const traces: { readonly event: string; readonly details?: object }[] = [];
  let nextOperation = 0;
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {
      owner: { roots: { evidence: { path: evidenceRoot } } },
      ownerSources: {
        profilePlan: {
          mode: "live",
          pageType: "profile",
fields: [{
            fieldId: "identity.given_name",
            questionType: "identity",
            answerType: "text",
            allowedOptions: [],
            answer: { kind: "answered", value: "Ada", provenance: "owner_provided", lane: "live_owner_fact" },
          }],
          repeatables: [],
        },
        sensitiveValues: ["Ada"],
      },
    } as never,
    acceptances: { record() {} },
    nextOperationId: () => generatedOperationId(
      `operation_profile_preflight_${String(++nextOperation).padStart(8, "0")}`,
    ),
    timeoutMs: 1_000,
    initialReviewExpected: [],
    externalMonitor: { async auth() {}, async application() {} },
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
    trace: (event, details) => traces.push({ event, ...(details === undefined ? {} : { details }) }),
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_profile_preflight_01"),
    sessionId: "live_session_profile_preflight_01" as LiveSessionId,
    profileLeaseId: "profile_lease_preflight_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  });
  try {
    const result = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_profile_preflight_01"),
      operationId: generatedOperationId("operation_profile_preflight_02"),
      sessionId: "live_session_profile_preflight_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_profile",
      input: { attempt: 1, pageId: "page-profile" } as never,
    }, new AbortController().signal);

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "page_incomplete",
        classifier: "profile_page",
        primitive: "profile_control",
        unknownLayer: "required_field",
      },
    });
    assert.equal(
      await page.locator('#name--legalName--firstName').inputValue(),
      "",
    );
    const learning = readFileSync(join(evidenceRoot, "profile-field-learning.json"), "utf8");
    assert.equal(learning.includes("Ada"), false);
    assert.equal(learning.includes("unreviewedRequiredControl"), false);
    assert.equal(JSON.parse(learning).fields[1].prefillDisposition, "needs_owner_input");
    assert.deepEqual(traces, [{
      event: "profile_reconciliation_blocked",
      details: {
        pageId: "page-profile",
        code: "answer_type_unknown",
        fieldId: "unknown.required.1",
        uiBehavior: "text",
        uiVariant: "workday_unknown_required_v1",
        mutationAttempted: false,
        retryable: false,
      },
    }]);
  } finally {
    runtime.dispose();
    await context.close();
    await browser.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test("generated prior-employment defaults fail closed before mutation", async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), "hunt-s2-prior-employment-runtime-"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html data-hunt-page-id="page-profile" data-hunt-submit-activated="false"><body data-hunt-application-page="profile" data-hunt-profile-page-type="profile"><main data-automation-id="applyFlowMyInfoPage">
    <div data-automation-id="formField-previousWorker"><span data-automation-id="required">*</span><fieldset role="radiogroup"><legend>Have you previously worked for this organization? If Yes, please answer the questions below. If No, please continue to the next page.</legend>
      <input id="previous-yes" type="radio" name="candidateIsPreviousWorker" value="true"><label for="previous-yes">Yes</label>
      <input id="previous-no" type="radio" name="candidateIsPreviousWorker" value="false"><label for="previous-no">No</label>
    </fieldset></div>
  </main></body></html>`);
  const accepted: string[] = [];
  const monitored: string[] = [];
  const traces: { readonly event: string; readonly details?: object }[] = [];
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {
      owner: { roots: { evidence: { path: evidenceRoot } } },
      ownerSources: {
        profilePlan: {
          mode: "live",
          pageType: "profile",
fields: [{
            fieldId: "employment.previously_worked_for_organization",
            questionType: "prior_employment",
            answerType: "option",
            allowedOptions: ["Yes", "No"],
            answer: { kind: "answered", value: "false", provenance: "generated_default", lane: "synthetic_test_default" },
            optionMapping: {
              canonicalValue: "false",
              visibleOption: "No",
              provenance: "visible_option",
            },
          }],
          repeatables: [],
        },
        sensitiveValues: ["false", "No"],
      },
    } as never,
    acceptances: { record(value) { accepted.push(value.checkpoint); } },
    nextOperationId: () => generatedOperationId("operation_prior_employment_01"),
    timeoutMs: 1_000,
    initialReviewExpected: [],
    externalMonitor: {
      async auth() {},
      async application(_page, _pageName, moment) { monitored.push(moment); },
    },
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
    trace: (event, details) => traces.push({ event, ...(details === undefined ? {} : { details }) }),
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_prior_employment_01"),
    sessionId: "live_session_prior_employment_01" as LiveSessionId,
    profileLeaseId: "profile_lease_prior_employment_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  });
  try {
    const result = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_prior_employment_01"),
      operationId: generatedOperationId("operation_prior_employment_02"),
      sessionId: "live_session_prior_employment_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_profile",
      input: { attempt: 1, pageId: "page-profile" } as never,
    }, new AbortController().signal);

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "page_incomplete",
        classifier: "profile_page",
        primitive: "profile_control",
        unknownLayer: "required_field",
      },
    });
    assert.equal(await page.locator("#previous-yes").isChecked(), false);
    assert.equal(await page.locator("#previous-no").isChecked(), false);
    assert.equal(await page.getByRole("button", { name: /^Submit(?: application)?$/iu }).count(), 0);
    assert.equal(await page.locator("html").getAttribute("data-hunt-submit-activated"), "false");
    assert.deepEqual(accepted, []);
    assert.deepEqual(monitored, ["state_observed"]);
    const learning = JSON.parse(readFileSync(
      join(evidenceRoot, "profile-field-learning.json"),
      "utf8",
    ));
    assert.deepEqual(learning.fields, [{
      fieldIdentity: "profile.employment.previously_worked_for_organization",
      uiType: "radio_group",
      uiVariant: "workday_previous_worker_radio_v1",
      questionCategory: "prior_employment",
      answerCategory: "single_select",
      required: true,
      answerState: "unset",
      lane: null,
      binderStrategy: "catalog_selector_exact",
      sanitizedLabelSha256: "cb8a534730a85fc9b2d2ae0ba130d05cdd5300666fac5bcc82c29fa0b7655fd8",
      metadataReconciliation: "matched",
      backingState: "unset",
      validationState: "clear",
      optionCatalogState: "observed",
      observationBinding: {
        operationId: "operation_prior_employment_01",
        attempt: 1,
        stateObservedAck: true,
      },
      visibleOptionIds: [
        "option_sha256_8a798890fe93817163b10b5f7bd2ca4d25d84c52739a645a889c173eee7d9d3d",
        "option_sha256_9390298f3fb0c5b160498935d79cb139aef28e1c47358b4bbba61862b9c26e59",
      ],
      selectedOptionId: null,
      optionMapping: "owner_visible_option",
      prefillDisposition: "needs_owner_input",
      driverAttempt: "none",
      monitorBinding: null,
      terminalDisposition: "required_unset",
      mechanics: {
        popupBound: "not_applicable",
        optionFocused: "not_applicable",
        optionActivated: "not_observed",
        popupClosed: "not_applicable",
        backingValueCommitted: "not_observed",
        validationCleared: "not_observed",
        persistentReadback: "not_attempted",
      },
    }]);
    assert.deepEqual(traces, [{
      event: "profile_reconciliation_blocked",
      details: {
        pageId: "page-profile",
        code: "profile_answer_provenance_denied",
        fieldId: "employment.previously_worked_for_organization",
        mutationAttempted: false,
        retryable: false,
      },
    }]);
  } finally {
    runtime.dispose();
    await context.close();
    await browser.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test("a profile block after a commit remains browser-effect uncertain", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html data-hunt-page-id="page-profile" data-hunt-submit-activated="false"><body data-hunt-application-page="profile"><main data-automation-id="applyFlowMyInfoPage"><label for="name--legalName--firstName">First Name</label><input id="name--legalName--firstName" required><label for="name--legalName--lastName">Last Name</label><input id="name--legalName--lastName" required><input hidden required data-automation-id="unreviewedConditional"></main><script>document.querySelector('#name--legalName--firstName').addEventListener('input',()=>document.querySelector('[data-automation-id="unreviewedConditional"]').hidden=false)</script></body></html>`);
  let nextOperation = 0;
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {
      ownerSources: {
        profilePlan: {
          mode: "live",
          pageType: "profile",
fields: [
            {
              fieldId: "identity.given_name",
              questionType: "identity",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "Ada", provenance: "owner_provided", lane: "live_owner_fact" },
            },
            {
              fieldId: "identity.family_name",
              questionType: "identity",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "Lovelace", provenance: "owner_provided", lane: "live_owner_fact" },
            },
          ],
          repeatables: [],
        },
      },
    } as never,
    acceptances: { record() {} },
    nextOperationId: () => generatedOperationId(
      `operation_profile_effect_${String(++nextOperation).padStart(8, "0")}`,
    ),
    timeoutMs: 1_000,
    initialReviewExpected: [],
    externalMonitor: { async auth() {}, async application() {} },
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_profile_effect_01"),
    sessionId: "live_session_profile_effect_01" as LiveSessionId,
    profileLeaseId: "profile_lease_effect_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  });
  try {
    await assert.rejects(() => runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_profile_effect_01"),
      operationId: generatedOperationId("operation_profile_effect_02"),
      sessionId: "live_session_profile_effect_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_profile",
      input: { attempt: 1, pageId: "page-profile" } as never,
    }, new AbortController().signal), /profile reconciliation denied/u);
    assert.equal(
      await page.locator('#name--legalName--firstName').inputValue(),
      "Ada",
    );
    assert.equal(
      await page.locator('#name--legalName--lastName').inputValue(),
      "",
    );
  } finally {
    runtime.dispose();
    await context.close();
    await browser.close();
  }
});

test("profile batches external proof once while every field keeps independent readback", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html data-hunt-page-id="page-profile" data-hunt-submit-activated="false"><body data-hunt-application-page="profile"><main data-automation-id="applyFlowMyInfoPage"><label>First Name<input required id="name--legalName--firstName"></label><label>Middle Name<input id="name--legalName--middleName"></label><label>Last Name<input required id="name--legalName--lastName"></label><label>Address Line 2<input id="address--addressLine2"></label><label>Postal Code<input id="address--postalCode"></label><div data-automation-id="formField-source"><label for="profile-source">How Did You Hear About Us?</label><button id="profile-source" type="button" role="combobox" data-automation-id="sourcePrompt" aria-controls="source-options">Select One</button><div id="source-options" role="listbox" hidden><div role="option">Referral</div></div></div></main><script>const source = document.querySelector('#profile-source'); const options = document.querySelector('#source-options'); source?.addEventListener('click', () => { options?.removeAttribute('hidden'); source.setAttribute('aria-expanded', 'true'); }); options?.addEventListener('click', (event) => { const option = event.target instanceof Element ? event.target.closest('[role="option"]') : null; if (option === null) return; source.textContent = option.textContent; source.setAttribute('aria-expanded', 'false'); options.setAttribute('hidden', ''); });</script></body></html>`);
  let nextOperation = 0;
  const monitored: { readonly moment: string; readonly operationId: string }[] = [];
  await page.locator("#profile-source").evaluate((element) =>
    element.setAttribute("aria-required", "true")
  );
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {
      ownerSources: {
        profilePlan: {
          mode: "live",
          pageType: "profile",
fields: [
            {
              fieldId: "identity.given_name",
              questionType: "identity",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "Ada", provenance: "owner_provided", lane: "live_owner_fact" },
            },
            {
              fieldId: "identity.family_name",
              questionType: "identity",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "Lovelace", provenance: "owner_provided", lane: "live_owner_fact" },
            },
            {
              fieldId: "identity.middle_name",
              questionType: "identity",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "Byron", provenance: "owner_provided", lane: "live_owner_fact" },
            },
            {
              fieldId: "address.line2",
              questionType: "address",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "Unit 1", provenance: "owner_provided", lane: "live_owner_fact" },
            },
            {
              fieldId: "address.postal_code",
              questionType: "address",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "T2P 1A1", provenance: "owner_provided", lane: "live_owner_fact" },
            },
            {
              fieldId: "source.how_did_you_hear",
              questionType: "application_source",
              answerType: "option",
              allowedOptions: ["Referral"],
              answer: { kind: "answered", value: "Referral", provenance: "owner_provided", lane: "live_owner_fact" },
              optionMapping: {
                canonicalValue: "Referral",
                visibleOption: "Referral",
                provenance: "visible_option",
              },
            },
          ],
          repeatables: [],
        },
        sensitiveValues: ["Ada", "Byron", "Lovelace", "Unit 1", "T2P 1A1"],
      },
    } as never,
    acceptances: { record() {} },
    nextOperationId: () => {
      nextOperation += 1;
      return generatedOperationId(`operation_profile_monitor_${nextOperation.toString().padStart(8, "0")}`);
    },
    timeoutMs: 1_000,
    initialReviewExpected: [],
    externalMonitor: {
      async auth() {},
      async application(_page, _pageName, moment, taxonomy, event) {
        monitored.push({ moment, operationId: event.operationId });
        assert.equal(taxonomy.questionTypes.includes("identity"), true);
        assert.equal(taxonomy.submitPresent, false);
      },
    },
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_profile_monitor_01"),
    sessionId: "live_session_profile_monitor_01" as LiveSessionId,
    profileLeaseId: "profile_lease_profile_monitor_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  });
  const runOperation = generatedOperationId("operation_profile_monitor_run_01");
  try {
    const result = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_profile_monitor_01"),
      operationId: runOperation,
      sessionId: "live_session_profile_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_profile",
      input: { attempt: 1, pageId: "page-profile" } as never,
    }, new AbortController().signal);

    assert.equal((result as { ok: boolean }).ok, true);
    assert.deepEqual(monitored.filter(({ operationId }) =>
      operationId === runOperation
    ), []);
    const observationEvents = monitored.filter(({ moment }) => moment === "state_observed");
    assert.equal(observationEvents.length, 1);
    const mutationEvents = monitored.filter(({ moment }) => moment !== "state_observed");
    const operations = [...new Set(mutationEvents.map(({ operationId }) => operationId))];
    assert.equal(operations.length, 1);
    for (const operationId of operations) {
      assert.deepEqual(
        mutationEvents.filter((event) => event.operationId === operationId).map(({ moment }) => moment),
        ["before_mutation", "after_readback"],
      );
    }
    assert.equal(monitored.length, 3);
    assert.equal(monitored.length * 2_500 < 60_000, true);
    assert.equal(await page.locator('#name--legalName--middleName').inputValue(), "Byron");
    assert.equal(await page.locator('#address--addressLine2').inputValue(), "Unit 1");
    assert.equal(await page.locator('#address--postalCode').inputValue(), "T2P 1A1");
    const expectations = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_profile_monitor_01"),
      operationId: generatedOperationId("operation_profile_monitor_review_01"),
      sessionId: "live_session_profile_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, { kind: "review_expectations" } as never, new AbortController().signal) as readonly {
      readonly fieldId: string;
    }[];
    assert.deepEqual(expectations.map(({ fieldId }) => fieldId), [
      "identity.given_name",
      "identity.family_name",
      "source.how_did_you_hear",
    ]);
  } finally {
    runtime.dispose();
    await context.close();
    await browser.close();
  }
});

test("questionnaire batches external proof once while every field keeps independent readback", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const questionEvidenceRoot = mkdtempSync(join(tmpdir(), "hunt-questionnaire-remount-learning-"));
  const questionLearning = createQuestionAnswerLearningCapture({
    root: questionEvidenceRoot,
    mode: "live",
    executionPolicy: liveApplicationExecutionPolicy("live"),
  });
  const profilePlan = {
    mode: "live" as "live" | "synthetic_test_non_submittable",
  };
  await page.setContent(`<!doctype html><html data-hunt-page-id="page-questionnaire" data-hunt-submit-activated="false"><body data-hunt-application-page="questionnaire"><main data-automation-id="applyFlowApplicationQuestionsPage">
    <div data-automation-id="formField-authorization"><label>Are you legally authorized to work in this country? <span aria-hidden="true">*</span></label><button id="mcvf1" type="button" aria-label="Select One Required" aria-haspopup="listbox">Yes</button><div class="options" hidden><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">Yes</div></div><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">No</div></div></div></div>
    <div data-automation-id="formField-sponsorship"><label>Will you now or in the future require sponsorship? <span aria-hidden="true">*</span></label><button id="mcvf2" type="button" aria-label="Select One Required" aria-haspopup="listbox">No</button><div class="options" hidden><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">Yes</div></div><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">No</div></div></div></div>
    <label>Brief interest statement<textarea id="mcvf3" required aria-label="Brief interest statement"></textarea></label>
    <div data-automation-id="formField-source"><label>How Did You Hear About Us? <span aria-hidden="true">*</span></label><button id="mcvf4" type="button" aria-label="Select One Required" aria-haspopup="listbox">Select One</button><div class="options" hidden><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">LinkedIn</div></div><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">Indeed</div></div></div></div>
    <div id="conditional-age" data-automation-id="formField-age" hidden><label>Are you at least 18 years of age? <span aria-hidden="true">*</span></label><button id="mcvf5" type="button" aria-label="Select One Required" aria-haspopup="listbox">Select One</button><div class="options" hidden><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">Yes</div></div><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">No</div></div></div></div>
    <script>
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function(options) {
        if (this.matches('button[aria-haspopup="listbox"]')) {
          this.dataset.scrollBlock = options?.block ?? '';
        }
        return originalScrollIntoView.call(this, options);
      };
      document.addEventListener('click', event => {
        const button = event.target.closest('button[aria-haspopup="listbox"]');
        if (button !== null) {
          button.closest('[data-automation-id^="formField-"]').querySelector('.options').hidden = false;
          return;
        }
        const option = event.target.closest('[data-automation-id="promptOption"]');
        if (option === null) return;
        const field = option.closest('[data-automation-id^="formField-"]');
        const owner = field.querySelector('button[aria-haspopup="listbox"]');
        owner.textContent = option.textContent.trim();
        owner.dataset.committed = 'true';
        field.querySelector('.options').hidden = true;
        if (owner.id === 'mcvf2') document.querySelector('#conditional-age').hidden = false;
      });
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        document.querySelectorAll('.options').forEach(options => { options.hidden = true; });
      });
    </script>
  </main></body></html>`);
  const artifact = resumeArtifact();
  const intent = createWorkdayResumeFileIntent({
    artifactId: artifact.resumeId,
    artifact,
    fileType: "pdf",
  });
  if (!intent.ok) throw new Error("resume fixture invalid");
  let nextOperation = 0;
  const accepted: string[] = [];
  const traces: { readonly event: string; readonly details?: object }[] = [];
  const monitored: {
    readonly moment: string;
    readonly operationId: string;
    readonly attempt: number;
  }[] = [];
  let finalQuestionnaireRemounted = false;
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {
      owner: { revisionId: "revision_questionnaire_monitor" },
      ownerSources: {
        resumeIntent: intent.value,
        profileId: upstreamProfileId("profile-questionnaire-monitor"),
        profileRevision: 1,
        profileQuery: {
          async query(input: ProfileQueryRequest) {
            const facts = {
              work_authorization: { value: true, provenance: "owner_provided" },
              sponsorship_required: { value: false, provenance: "owner_provided" },
              age_requirement_met: { value: true, provenance: "owner_provided" },
              application_source: { value: "LinkedIn", provenance: "owner_provided" },
              configured_narrative: {
                value: "Exact configured interest statement.",
                provenance: "configured_template",
              },
              gender_disclosure: { value: "Prefer not to answer", provenance: "owner_provided" },
              ethnicity_disclosure: { value: "Prefer not to answer", provenance: "owner_provided" },
              veteran_disclosure: { value: "Prefer not to answer", provenance: "owner_provided" },
            } as const;
            const fact = facts[input.factId as keyof typeof facts];
            return fact === undefined
              ? { ok: true as const, value: { kind: "profile_answer_missing" as const } }
              : {
                ok: true as const,
                value: { kind: "answered" as const, ...fact, lane: "live_owner_fact" as const },
              };
          },
        },
        narrative: createConfiguredNarrativeProvider({
          revision: "narrative-questionnaire-monitor-v1",
          template: "Exact configured interest statement.",
        }),
        sensitiveValues: ["Exact configured interest statement."],
        profilePlan,
      },
      questionLearning,
    } as never,
    acceptances: { record(value) { accepted.push(value.checkpoint); } },
    nextOperationId: () => {
      nextOperation += 1;
      return generatedOperationId(`operation_questionnaire_monitor_${nextOperation.toString().padStart(8, "0")}`);
    },
    // This scenario exercises three questionnaire pages and a checkbox that
    // must remain stable for most of the operation window. Leave headroom for
    // Playwright scheduling when the complete browser suite runs concurrently.
    timeoutMs: 10_000,
    trace: (event, details) => traces.push({ event, ...(details === undefined ? {} : { details }) }),
    initialReviewExpected: [],
    externalMonitor: {
      async auth() {},
      async application(_page, _pageName, moment, taxonomy, event) {
        monitored.push({ moment, operationId: event.operationId, attempt: event.attempt });
        if (
          !finalQuestionnaireRemounted && moment === "after_readback" &&
          await page.locator('button[data-committed="true"]').count() === 4 &&
          await page.locator("textarea").inputValue() === "Exact configured interest statement."
        ) {
          finalQuestionnaireRemounted = true;
          await page.locator('[data-automation-id="applyFlowApplicationQuestionsPage"]')
            .evaluate((root) => {
              const replacement = root.cloneNode(true) as HTMLElement;
              const sourceValues = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
                "input, textarea",
              )].map((control) => control.value);
              replacement.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")
                .forEach((control, index) => {
                  control.value = sourceValues[index] ?? "";
                });
              replacement.querySelectorAll("[data-hunt-target-token]").forEach((control) =>
                control.removeAttribute("data-hunt-target-token")
              );
              replacement.querySelectorAll<HTMLElement>("[id^=mcvf]").forEach((control, index) => {
                control.id = `mcvf${index + 101}`;
              });
              root.replaceWith(replacement);
            });
        }
        if (taxonomy.fieldCount === 4 && taxonomy.questionTypes.includes("authorization")) {
          assert.deepEqual(taxonomy.questionTypes, ["authorization", "narrative", "unknown"]);
          assert.equal(taxonomy.requiredFieldCount, 4);
        } else if (taxonomy.fieldCount === 5 && taxonomy.questionTypes.includes("authorization")) {
          assert.deepEqual(taxonomy.questionTypes, ["authorization", "narrative", "unknown"]);
          assert.equal(taxonomy.requiredFieldCount, 5);
        } else if (taxonomy.fieldCount === 4 && taxonomy.requiredFieldCount === 0) {
          assert.deepEqual(taxonomy.questionTypes, ["demographic"]);
          assert.equal(taxonomy.requiredFieldCount, 0);
        } else if (taxonomy.fieldCount === 4) {
          assert.deepEqual(taxonomy.questionTypes, ["demographic", "unknown"]);
          assert.equal(taxonomy.requiredFieldCount, 4);
        } else if (taxonomy.fieldCount === 5) {
          assert.deepEqual(taxonomy.questionTypes, ["demographic", "legal"]);
          assert.equal(taxonomy.requiredFieldCount, 1);
        } else if (taxonomy.fieldCount === 1 || taxonomy.fieldCount === 3) {
          assert.equal(
            taxonomy.questionTypes.includes("legal") || taxonomy.questionTypes.includes("education") ||
              taxonomy.questionTypes.includes("demographic") || taxonomy.questionTypes.includes("identity"),
            true,
          );
          assert.equal(taxonomy.requiredFieldCount, taxonomy.fieldCount);
        } else {
          assert.equal(taxonomy.questionTypes.includes("unknown"), true);
          assert.equal(taxonomy.questionTypes.every((value) =>
            value === "unknown" || value === "demographic"), true);
          assert.equal(taxonomy.requiredFieldCount, taxonomy.fieldCount);
        }
        assert.equal(taxonomy.submitPresent, false);
      },
    },
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_questionnaire_monitor_01"),
    sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
    profileLeaseId: "profile_lease_questionnaire_monitor_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  });
  const runOperation = generatedOperationId("operation_questionnaire_monitor_run_01");
  try {
    const result = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: runOperation,
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt: 1, pageId: "page-questionnaire" } as never,
    }, new AbortController().signal);

    assert.equal(
      (result as { ok: boolean }).ok,
      true,
      JSON.stringify(result),
    );
    assert.equal(finalQuestionnaireRemounted, true);
    assert.equal(await page.locator("textarea").inputValue(), "Exact configured interest statement.");
    assert.equal(await page.locator('button[data-committed="true"]').count(), 4);
    assert.deepEqual(
      await page.locator('button[data-committed="true"]').evaluateAll((buttons) =>
        buttons.map((button) => button.dataset.scrollBlock)
      ),
      ["center", "center", "center", "center"],
    );
    assert.deepEqual(
      monitored.filter(({ operationId }) => operationId === runOperation).map(({ moment }) => moment),
      ["state_observed"],
    );
    const fieldEvents = monitored.filter(({ operationId }) => operationId !== runOperation);
    const operations = [...new Set(fieldEvents.map(({ operationId }) => operationId))];
    assert.equal(operations.length, 1);
    for (const operationId of operations) {
      assert.deepEqual(
        fieldEvents.filter((event) => event.operationId === operationId).map(({ moment }) => moment),
        ["before_mutation", "after_readback"],
      );
    }
    assert.equal(monitored.length, 3);
    assert.equal(monitored.length * 2_500 < 60_000, true);
    assert.equal(accepted.filter((checkpoint) => checkpoint === "questionnaire_verified").length, 1);

    const restoreMonitorStart = monitored.length;
    const restoreTraceStart = traces.length;
    profilePlan.mode = "synthetic_test_non_submittable";
    await page.locator('[data-automation-id="formField-sponsorship"] button')
      .evaluate((button) => {
        const owner = button.closest('[data-automation-id="formField-sponsorship"]');
        const options = owner?.querySelector<HTMLElement>('.options');
        button.textContent = "Select One";
        button.removeAttribute("data-committed");
        button.addEventListener("click", () => {
          if (options !== null && options !== undefined) options.hidden = false;
        });
        options?.addEventListener("click", (event) => {
          const option = (event.target as Element).closest('[data-automation-id="promptOption"]');
          if (option === null) return;
          button.textContent = option.textContent?.trim() ?? "";
          (button as HTMLElement).dataset.committed = "true";
          options.hidden = true;
        });
      });
    const restored = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: generatedOperationId("operation_questionnaire_monitor_restore_01"),
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt: 2, pageId: "page-questionnaire" } as never,
    }, new AbortController().signal);
    assert.equal((restored as { ok: boolean }).ok, true, JSON.stringify(restored));
    profilePlan.mode = "live";
    assert.equal(
      await page.locator('[data-automation-id="formField-sponsorship"] button').innerText(),
      "No",
    );
    const restoreTraces = traces.slice(restoreTraceStart);
    assert.equal(
      restoreTraces.filter(({ event }) => event === "questionnaire_field_drive_started").length,
      1,
    );
    assert.equal(
      restoreTraces.filter(({ event }) => event === "questionnaire_field_verified_reused").length,
      4,
    );
    assert.equal(
      restoreTraces.some(({ event }) => event === "questionnaire_reconciliation_exception"),
      false,
    );
    assert.equal(
      restoreTraces.filter(({ event }) => event === "questionnaire_field_verified_reused")
        .every(({ details }) => (details as { remountGeneration?: number })?.remountGeneration === 2),
      true,
    );
    const restoreOperationIds = new Set(
      monitored.slice(restoreMonitorStart).map(({ operationId }) => operationId),
    );

    await page.setContent(`<!doctype html><html data-hunt-page-id="page-voluntary" data-hunt-submit-activated="false"><body data-hunt-application-page="questionnaire"><main data-automation-id="applyFlowVoluntaryDisclosuresPage">
      <div data-automation-id="formField-gender"><label>What is your gender?</label><button type="button" aria-haspopup="listbox">Select One</button></div>
      <div data-automation-id="formField-hispanic"><label>Are you Hispanic or Latino?</label><button type="button" aria-haspopup="listbox">Select One</button></div>
      <div data-automation-id="formField-race"><label>What is your race/ethnicity?</label><button type="button" aria-haspopup="listbox">Select One</button></div>
      <div data-automation-id="formField-military"><label>Were you ever in the military?</label><button type="button" aria-haspopup="listbox">Select One</button></div>
      <script>
        const choices = [
          ['Prefer not to answer', 'Woman', 'Man'],
          ['No', 'Yes', 'Prefer not to answer'],
          ['Prefer not to answer', 'Asian', 'White'],
          ['No', 'Yes', 'Prefer not to answer'],
        ];
        let popup;
        const close = () => { popup?.remove(); popup = undefined; };
        document.querySelectorAll('button[aria-haspopup="listbox"]').forEach((button, index) => {
          button.addEventListener('click', () => {
            close();
            popup = document.createElement('div');
            popup.dataset.automationId = 'promptMenu';
            popup.innerHTML = choices[index].map((choice) => '<div data-automation-id="promptOption">' + choice + '</div>').join('');
            popup.addEventListener('click', (event) => {
              const option = event.target.closest('[data-automation-id="promptOption"]');
              if (option === null) return;
              button.textContent = option.textContent.trim();
              button.dataset.committed = 'true';
              close();
            });
            document.body.append(popup);
          });
        });
        document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
      </script>
    </main></body></html>`);
    const voluntaryOperation = generatedOperationId("operation_questionnaire_voluntary_01");
    const voluntaryResult = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: voluntaryOperation,
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt: 1, pageId: "page-voluntary" } as never,
    }, new AbortController().signal) as { ok: boolean; error?: { code: string } };
    assert.equal(voluntaryResult.ok, true);
    assert.equal(await page.locator('button[data-committed="true"]').count(), 4);
    assert.deepEqual(await page.locator('button[aria-haspopup="listbox"]').allInnerTexts(), [
      "Prefer not to answer",
      "Prefer not to answer",
      "Prefer not to answer",
      "Prefer not to answer",
    ]);
    assert.deepEqual(
      monitored.filter(({ operationId }) => operationId === voluntaryOperation)
        .map(({ moment, attempt }) => ({ moment, attempt })),
      [{ moment: "state_observed", attempt: 3 }],
    );
    const voluntaryFieldEvents = monitored.filter(({ operationId }) =>
      operationId !== voluntaryOperation &&
      operationId !== runOperation &&
      !restoreOperationIds.has(operationId) &&
      !fieldEvents.some((event) => event.operationId === operationId)
    );
    const voluntaryOperations = [...new Set(voluntaryFieldEvents.map(({ operationId }) => operationId))];
    assert.equal(voluntaryOperations.length, 1);
    assert.deepEqual(
      voluntaryOperations.map((operationId) => voluntaryFieldEvents
        .filter((event) => event.operationId === operationId)
        .map(({ moment }) => moment)),
      [["before_mutation", "after_readback"]],
    );
    assert.deepEqual(
      [...new Set(voluntaryFieldEvents.map(({ attempt }) => attempt))],
      [3],
    );

    await page.setContent(`<!doctype html><html data-hunt-page-id="page-self-identify" data-hunt-submit-activated="false"><head><style>.visual { display: inline-block; width: 18px; height: 18px; }.date-shell { display: flex; align-items: center; }.date-opener { margin-left: 48px; }</style></head><body data-hunt-application-page="questionnaire"><main data-automation-id="applyFlowSelfIdentifyPage">
      <div data-automation-id="formField-selfIdentifiedDisabilityData--disabilityForm">
        <label>Language <span data-automation-id="required">*</span></label>
        <button type="button" aria-haspopup="listbox">Select One</button>
      </div>
      <div data-automation-id="formField-selfIdentifiedDisabilityData--name">
        <label>Name <span data-automation-id="required">*</span><input type="text" id="selfIdentifiedDisabilityData--name"></label>
      </div>
      <div data-automation-id="formField-selfIdentifiedDisabilityData--date">
        <label>Date <span data-automation-id="required">*</span></label>
        <div data-automation-id="dateInputWrapper">
          <input role="spinbutton" data-automation-id="dateSectionMonth-input">
          <input role="spinbutton" data-automation-id="dateSectionDay-input">
          <input role="spinbutton" data-automation-id="dateSectionYear-input">
        </div>
      </div>
      <div data-automation-id="formField-disabilityStatus">
        <label>Disability Status <span data-automation-id="required">*</span></label>
        <div class="disability-options">
          <div role="grid">
            <div role="row"><div role="cell"><div class="option"><div class="choice-owner"><input id="has-disability" type="checkbox" aria-checked="false"><span class="visual"></span><div class="decoration"></div></div><label for="has-disability">Yes, I have a disability, or have had one in the past</label></div></div></div>
            <div role="row"><div role="cell"><div class="option"><div class="choice-owner"><input id="no-disability" type="checkbox" aria-checked="false"><span class="visual"></span><div class="decoration"></div></div><label for="no-disability">No, I do not have a disability and have not had one in the past</label></div></div></div>
            <div role="row"><div role="cell"><div class="option"><div class="choice-owner"><input id="decline-disability-input" type="checkbox" aria-checked="false" aria-labelledby="decline-disability disability-context"><span class="visual"></span><div class="decoration"></div></div><label for="decline-disability-input"><span id="decline-disability">I do not want to answer</span></label></div></div></div>
          </div>
          <span id="disability-context">Please check one of the boxes below</span>
        </div>
      </div>
      <script>
        const languageField = document.querySelector('[data-automation-id="formField-selfIdentifiedDisabilityData--disabilityForm"]');
        const bindLanguage = (button) => button.addEventListener('click', () => {
          const popup = document.createElement('div');
          popup.dataset.automationId = 'promptMenu';
          popup.innerHTML = '<div data-automation-id="promptOption">English</div><div data-automation-id="promptOption">Spanish</div>';
          popup.addEventListener('click', (event) => {
            const option = event.target.closest('[data-automation-id="promptOption"]');
            if (option === null) return;
            const replacement = button.cloneNode(true);
            replacement.textContent = option.textContent.trim();
            replacement.removeAttribute('data-hunt-target-token');
            replacement.removeAttribute('data-hunt-popup-options');
            button.replaceWith(replacement);
            bindLanguage(replacement);
            popup.remove();
          });
          document.body.append(popup);
        });
        bindLanguage(languageField.querySelector('button'));
        document.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          document.querySelector('[data-automation-id="promptMenu"]')?.remove();
          const button = languageField.querySelector('button');
          const replacement = button.cloneNode(true);
          replacement.removeAttribute('data-hunt-target-token');
          replacement.removeAttribute('data-hunt-popup-options');
          button.replaceWith(replacement);
          bindLanguage(replacement);
        });
        const name = document.querySelector('#selfIdentifiedDisabilityData--name');
        name.addEventListener('blur', () => {
          const replacement = name.cloneNode(true);
          replacement.value = name.value;
          replacement.removeAttribute('data-hunt-target-token');
          name.replaceWith(replacement);
        });
        document.querySelectorAll('[data-automation-id="formField-disabilityStatus"] input').forEach(input => {
          input.addEventListener('click', () => {
            input.setAttribute('aria-checked', String(input.checked));
            setTimeout(() => {
              if (input.dataset.componentAccepted !== 'true') {
                input.checked = false;
                input.setAttribute('aria-checked', 'false');
              }
            }, 0);
          });
          document.querySelector('label[for="' + input.id + '"]').addEventListener('click', () => {
            document.querySelectorAll('[data-automation-id="formField-disabilityStatus"] input').forEach(candidate => {
              candidate.checked = false;
              candidate.setAttribute('aria-checked', String(candidate.checked));
              delete candidate.dataset.componentAccepted;
            });
            input.dataset.componentAccepted = 'true';
          });
        });
      </script>
    </main></body></html>`);
    const selfIdentifyOperation = generatedOperationId("operation_questionnaire_self_identify_01");
    const selfIdentifyResult = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: selfIdentifyOperation,
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt: 1, pageId: "page-self-identify" } as never,
    }, new AbortController().signal) as { ok: boolean; error?: { code: string } };
    assert.equal(selfIdentifyResult.ok, false, JSON.stringify(selfIdentifyResult));
    assert.equal(selfIdentifyResult.error?.code, "page_incomplete");
    assert.equal(
      await page.locator('[data-automation-id="formField-selfIdentifiedDisabilityData--disabilityForm"] button').innerText(),
      "Select One",
    );
    assert.equal(await page.locator("#selfIdentifiedDisabilityData--name").inputValue(), "");
    assert.deepEqual(
      await page.locator('[data-automation-id="dateInputWrapper"] input').evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value)
      ),
      ["", "", ""],
    );
    assert.deepEqual(
      await page.locator('[data-automation-id="formField-disabilityStatus"] input:checked')
        .evaluateAll((inputs) => inputs.map((input) => input.closest('[role="row"]')?.textContent?.trim())),
      [],
    );
    const selfIdentifyExpectations = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: generatedOperationId("operation_questionnaire_review_expectations_01"),
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, { kind: "review_expectations" } as never, new AbortController().signal) as readonly {
      readonly valueSha256: string;
    }[];
    const englishSha256 = createHash("sha256").update("English", "utf8").digest("hex");
    assert.equal(selfIdentifyExpectations.some(({ valueSha256 }) => valueSha256 === englishSha256), false);

    await page.setContent(`<!doctype html><html data-hunt-page-id="page-learning-gap" data-hunt-submit-activated="false"><body data-hunt-application-page="questionnaire"><main data-automation-id="applyFlowApplicationQuestionsPage">
      <div data-automation-id="formField-highestEducation">
        <label for="highestEducation">Highest Level of Education <span data-automation-id="required">*</span></label>
        <select id="highestEducation" required><option>Select One</option></select>
      </div>
    </main></body></html>`);
    const learningGap = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: generatedOperationId("operation_questionnaire_learning_gap_01"),
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt: 1, pageId: "page-learning-gap" } as never,
    }, new AbortController().signal) as { ok: boolean; error?: { code: string } };
    assert.equal(learningGap.ok, false);
    assert.equal(learningGap.error?.code, "page_incomplete");
    const blockedTraces = traces.filter(({ event }) =>
      event === "questionnaire_reconciliation_blocked"
    );
    assert.equal(blockedTraces.length, 2);
    assert.deepEqual(blockedTraces.map(({ details }) => {
      const value = details as {
        pageId: string;
        fieldId: string;
        code: string;
        protectedCategory: string | null;
        candidatePresent: boolean;
        retryable: boolean;
      };
      assert.match(value.fieldId, /^field-workday-[0-9a-f]{8}-1$/u);
      return {
        pageId: value.pageId,
        code: value.code,
        protectedCategory: value.protectedCategory,
        candidatePresent: value.candidatePresent,
        retryable: value.retryable,
      };
    }), [
      {
        pageId: "page-self-identify",
        code: "profile_answer_missing",
        protectedCategory: "legal",
        candidatePresent: false,
        retryable: false,
      },
      {
        pageId: "page-learning-gap",
        code: "profile_answer_missing",
        protectedCategory: "legal",
        candidatePresent: false,
        retryable: false,
      },
    ]);

    await page.setContent(`<!doctype html><html data-hunt-page-id="page-questionnaire-gap" data-hunt-submit-activated="false"><body data-hunt-application-page="questionnaire"><main data-automation-id="applyFlowApplicationQuestionsPage">
      <div data-automation-id="formField-unsupported"><label>Required unsupported control</label><span data-automation-id="required">*</span><div role="slider" tabindex="0" data-hunt-field-id="unsupported-required"></div></div>
    </main></body></html>`);
    await assert.rejects(runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: generatedOperationId("operation_questionnaire_monitor_gap_01"),
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt: 1, pageId: "page-questionnaire-gap" } as never,
    }, new AbortController().signal), /questionnaire field coverage mismatch/u);
    assert.equal(accepted.filter((checkpoint) => checkpoint === "questionnaire_verified").length, 3);
  } finally {
    runtime.dispose();
    disposeResumeArtifact(artifact);
    rmSync(questionEvidenceRoot, { recursive: true, force: true });
    await context.close();
    await browser.close();
  }
});

test("application taxonomy reports real numeric structure and rejects validation or Submit drift", async (t) => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scenario of [
      {
        name: "numeric questionnaire",
        body: '<body data-hunt-application-page="questionnaire"><main data-automation-id="applyFlowApplicationQuestionsPage"><label>Years of experience<input type="number"></label></main></body>',
        denied: false,
        expected: {
          fieldCount: 1,
          requiredFieldCount: 0,
          controlTypes: ["number"],
          answerTypes: ["number"],
          questionTypes: ["employment"],
        },
      },
      {
        name: "My Experience component taxonomy",
        body: `<body data-hunt-application-page="resume"><main data-automation-id="applyFlowMyExpPage">
          <h1>My Experience</h1>
          <section><h2>Work Experience</h2>
            <label>Job Title *<input required></label><label>Company *<input required></label><label>Location<input></label>
            <label>I currently work here<input type="checkbox"></label>
            <input role="spinbutton" data-automation-id="dateSectionMonth-input"><input placeholder="YYYY">
            <input role="spinbutton" data-automation-id="dateSectionMonth-input"><input placeholder="YYYY">
            <textarea aria-label="Role Description"></textarea><button>Add Another</button>
          </section>
          <section><h2>Education</h2>
            <label>School or University *<input required></label>
            <div data-automation-id="formField-degree">Degree *<button aria-haspopup="listbox">Select One</button></div>
            <button data-automation-id="sourcePrompt">Field of Study</button>
            <label>Overall Result (GPA)<input type="number"></label>
            <input placeholder="YYYY"><input placeholder="YYYY"><button>Add Another</button>
          </section>
          <section><h2>Languages</h2><button>Add</button></section>
          <section><h2>Skills</h2><button data-automation-id="sourcePrompt">Type to Add Skills</button></section>
          <section><h2>Resume/CV</h2><label>Upload a file *<input type="file" required></label></section>
          <section><h2>Websites</h2><button>Add</button></section>
          <section><h2>Social Network URLs</h2><label>Please provide your LinkedIn profile<input></label></section>
        </main></body>`,
        denied: false,
        expected: {
          fieldCount: 18,
          requiredFieldCount: 5,
          controlTypes: [
            "text", "checkbox", "month", "year", "textarea", "select", "search_select",
            "number", "file_upload", "repeatable",
          ],
          answerTypes: [
            "text", "boolean", "month", "year", "single_select", "multi_select", "number",
            "file", "url",
          ],
          questionTypes: [
            "employment", "education", "language", "skill", "attachment", "website",
            "social_network",
          ],
        },
      },
      {
        name: "My Experience with no required controls",
        body: `<body data-hunt-application-page="resume"><main data-automation-id="applyFlowMyExperiencePage">
          <h1>My Experience</h1>
          <section><h2>Work Experience</h2><label>Job Title<input></label></section>
          <section><h2>Resume/CV</h2><label>Upload a file<input type="file"></label></section>
        </main></body>`,
        denied: false,
        expected: {
          fieldCount: 2,
          requiredFieldCount: 0,
          controlTypes: ["text", "file_upload"],
          answerTypes: ["text", "file"],
          questionTypes: ["employment", "attachment"],
        },
      },
      {
        name: "visible validation error",
        body: '<body data-hunt-application-page="profile"><main data-automation-id="applyFlowMyInfoPage"><label>Given name<input aria-invalid="true"></label><div role="alert">Required</div></main></body>',
        denied: true,
        expected: undefined,
      },
      {
        name: "unexpected Submit outside Review",
        body: '<body data-hunt-application-page="profile"><main data-automation-id="applyFlowMyInfoPage"><label>Given name<input></label><button>Submit application</button></main></body>',
        denied: true,
        expected: undefined,
      },
      {
        name: "missing Submit on Review",
        body: '<body data-hunt-application-page="pre_review"><div data-automation-id="progressBarActiveStep">Review</div><main data-automation-id="applyFlowReviewPage"></main></body>',
        denied: true,
        expected: undefined,
      },
    ] as const) await t.test(scenario.name, async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(`<!doctype html><html data-hunt-page-id="page-taxonomy" data-hunt-submit-activated="false">${scenario.body}</html>`);
      let monitorCalls = 0;
      const taxonomies: {
        readonly fieldCount: number;
        readonly requiredFieldCount: number;
        readonly controlTypes: readonly string[];
        readonly answerTypes: readonly string[];
        readonly questionTypes: readonly string[];
      }[] = [];
      const runtime = new OwnedWorkdayApplicationRuntime({
        request: {} as never,
        acceptances: { record() {} },
        nextOperationId: () => generatedOperationId("operation_taxonomy_next_0001"),
        timeoutMs: 1_000,
        initialReviewExpected: [],
        externalMonitor: {
          async auth() {},
          async application(_page, _pageName, _moment, taxonomy) {
            monitorCalls += 1;
            taxonomies.push(taxonomy);
          },
        },
        authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
        now: () => "2026-08-05T12:00:00.000Z",
      });
      runtime.bindSession({
        schemaVersion: 1,
        journeyId: journeyId("journey_taxonomy_monitor_01"),
        sessionId: "live_session_taxonomy_monitor_01" as LiveSessionId,
        profileLeaseId: "profile_lease_taxonomy_monitor_01" as ProfileLeaseId,
        target: {} as never,
        leaseExpiresAt: "2026-08-05T13:00:00.000Z",
      });
      const run = () => runtime.run(page as never, {
        schemaVersion: 1,
        journeyId: journeyId("journey_taxonomy_monitor_01"),
        operationId: generatedOperationId("operation_taxonomy_monitor_0001"),
        sessionId: "live_session_taxonomy_monitor_01" as LiveSessionId,
        target: {} as never,
        now: "2026-08-05T12:00:00.000Z",
      }, { kind: "inspect_recovery" }, new AbortController().signal);
      try {
        if (scenario.denied) {
          await assert.rejects(run, /application monitor taxonomy denied/u);
          assert.equal(monitorCalls, 0);
        } else {
          const result = await run();
          assert.equal((result as { ok: boolean }).ok, true);
          assert.equal(monitorCalls, 1);
          assert.equal(taxonomies[0]?.fieldCount, scenario.expected?.fieldCount);
          assert.equal(
            taxonomies[0]?.requiredFieldCount,
            scenario.expected?.requiredFieldCount,
          );
          assert.deepEqual(taxonomies[0]?.controlTypes, scenario.expected?.controlTypes);
          assert.deepEqual(taxonomies[0]?.answerTypes, scenario.expected?.answerTypes);
          assert.deepEqual(taxonomies[0]?.questionTypes, scenario.expected?.questionTypes);
        }
      } finally {
        runtime.dispose();
        await context.close();
      }
    });
  } finally {
    await browser.close();
  }
});

test("profile cancellation before mutation remains operation_cancelled", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html data-hunt-page-id="page-profile" data-hunt-submit-activated="false"><body data-hunt-application-page="profile"><main data-automation-id="applyFlowMyInfoPage"><input required data-automation-id="legalNameSection_firstName"></main></body></html>`);
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {
      ownerSources: {
        profilePlan: {
          mode: "live",
          pageType: "profile",
fields: [{
            fieldId: "identity.given_name",
            questionType: "identity",
            answerType: "text",
            allowedOptions: [],
            answer: { kind: "answered", value: "Ada", provenance: "owner_provided", lane: "live_owner_fact" },
          }],
          repeatables: [],
        },
        sensitiveValues: ["Ada"],
      },
    } as never,
    acceptances: { record() {} },
    nextOperationId: () => generatedOperationId("operation_profile_cancel_01"),
    timeoutMs: 1_000,
    initialReviewExpected: [],
    externalMonitor: { async auth() {}, async application() {} },
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_profile_cancel_01"),
    sessionId: "live_session_profile_cancel_01" as LiveSessionId,
    profileLeaseId: "profile_lease_cancel_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  });
  let abortReads = 0;
  const signal = {
    get aborted() {
      abortReads += 1;
      return abortReads > 2;
    },
  } as AbortSignal;
  try {
    const result = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_profile_cancel_01"),
      operationId: generatedOperationId("operation_profile_cancel_02"),
      sessionId: "live_session_profile_cancel_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_profile",
      input: { attempt: 1, pageId: "page-profile" } as never,
    }, signal);

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "operation_cancelled",
        classifier: "profile_page",
        primitive: "profile_control",
        unknownLayer: "none",
      },
    });
    assert.equal(
      await page.locator('[data-automation-id="legalNameSection_firstName"]').inputValue(),
      "",
    );
  } finally {
    runtime.dispose();
    await context.close();
    await browser.close();
  }
});

test("Review monitor ACK is followed by a fresh semantic field and invariant structure readback", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html data-hunt-page-id="page-review" data-hunt-submit-activated="false"><body data-hunt-application-page="pre_review"><div data-automation-id="progressBarActiveStep">Review</div><main data-automation-id="applyFlowReviewPage"><section data-hunt-review-field-id="s1-field-resume">resume.pdf</section><button id="final-submit">Submit application</button></main></body></html>`);
  let monitorCalls = 0;
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {} as never,
    acceptances: { record() {} },
    nextOperationId: () => generatedOperationId("operation_review_drift_next_01"),
    timeoutMs: 1_000,
    initialReviewExpected: [{
      fieldId: "s1-field-resume",
      provenance: "resume_verified",
      rowIdentity: "formField-s1-field-resume",
      valueSha256: createHash("sha256").update("resume.pdf").digest("hex"),
    }],
    externalMonitor: {
      async auth() {},
      async application() {
        monitorCalls += 1;
        await page.locator('[data-hunt-review-field-id="s1-field-resume"]').evaluate(
          (element) => { element.textContent = "drifted.pdf"; (element as HTMLElement).hidden = true; },
        );
      },
    },
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_review_drift_0001"),
    sessionId: "live_session_review_drift_0001" as LiveSessionId,
    profileLeaseId: "profile_lease_review_drift_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  });
  try {
    await assert.rejects(
      () => runtime.run(page as never, {
        schemaVersion: 1,
        journeyId: journeyId("journey_review_drift_0001"),
        operationId: generatedOperationId("operation_review_drift_0001"),
        sessionId: "live_session_review_drift_0001" as LiveSessionId,
        target: {} as never,
        now: "2026-08-05T12:00:00.000Z",
      }, { kind: "capture_review" }, new AbortController().signal),
      /Review field hidden|Review field mismatch|Review readback drift denied/u,
    );
    assert.equal(monitorCalls, 1);
    assert.equal(await page.locator("html").getAttribute("data-hunt-submit-activated"), "false");
  } finally {
    runtime.dispose();
    await context.close();
    await browser.close();
  }
});

test("optional ARIA comboboxes hydrate only their exact owner and preserve selection", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<main data-automation-id="applyFlowApplicationQuestionsPage">
      <div data-automation-id="formField-skills"><label for="skills">Optional skills</label>
        <input id="skills" role="combobox" aria-controls="skills-popup" aria-expanded="false"
          value="Shared" aria-valuetext="Shared"></div></main>
      <div id="stale-popup" role="listbox"><div role="option">Stale</div></div>
      <div id="skills-popup" role="listbox" hidden><div role="option">Shared</div>
        <div role="option">Destination</div></div><script>
        const input = document.querySelector('#skills');
        const popup = document.querySelector('#skills-popup');
        input.addEventListener('click', () => {
          popup.hidden = false;
          input.setAttribute('aria-expanded', 'true');
        });
        document.addEventListener('keydown', event => {
          if (event.key !== 'Escape') return;
          popup.hidden = true;
          input.setAttribute('aria-expanded', 'false');
        });
      </script>`);
    const pageId = "questionnaire-optional-combobox" as never;
    await bindQuestionnaireTargets(page, pageId);
    const targets = await questionnairePopupHydrationTargets(page);
    assert.equal(targets.length, 1);
    await hydrateQuestionnairePopupOptions(page, pageId, targets[0]!, 5_000);
    const input = page.locator("#skills");
    assert.equal(await input.inputValue(), "Shared");
    assert.deepEqual(JSON.parse(await input.getAttribute("data-hunt-popup-options") ?? "[]"),
      ["Shared", "Destination"]);
    assert.equal(await page.locator("#skills-popup").isVisible(), false);
    assert.equal(await page.locator("#stale-popup").isVisible(), true);
  } finally {
    await browser.close();
  }
});

test("canonical questionnaire binding survives an identity-losing React remount", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField">
          <label for="react-control-17">Unseen required detail*</label>
          <input id="react-control-17" name="react-name-17" required>
        </div>
      </main>
    `);
    const pageId = "page-react-canonical-remount" as never;
    await bindQuestionnaireTargets(page, pageId);
    const original = await page.locator("input").getAttribute("data-hunt-target-token");

    await page.locator('[data-automation-id="formField"]').evaluate((owner) => {
      owner.innerHTML = `
        <label for="react-control-204">Unseen required detail*</label>
        <input id="react-control-204" name="react-name-204" required value="committed">
      `;
    });
    assert.equal(await page.locator('[data-hunt-target-token]').count(), 0);
    await bindQuestionnaireTargets(page, pageId);

    assert.equal(await page.locator("input").getAttribute("data-hunt-target-token"), original);
    const observed = await inspectPage(
      page,
      "live_session_react_canonical_remount" as never,
      pageId,
      new Map(),
    );
    assert.equal([...observed.targets.values()].flat()[0]?.readback.kind, "text");
  } finally {
    await browser.close();
  }
});

test("canonical discovery survives reorder, delayed reveal, and duplicate-label occurrences", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<main data-automation-id="applyFlowApplicationQuestionsPage">
      <div data-slot="alpha" data-automation-id="formField"><label for="generated-1">Independent alpha*</label><input id="generated-1" required></div>
      <div data-slot="beta" data-automation-id="formField"><label for="generated-2">Independent beta*</label><input id="generated-2" required></div>
      <div data-slot="delayed" data-automation-id="formField" hidden><label for="generated-3">Conditional detail*</label><input id="generated-3" required></div>
      <section data-slot="duplicate-section-1" aria-label="Primary location">
        <div data-slot="duplicate-1" data-automation-id="formField"><label for="generated-4">Country</label><input id="generated-4" required></div>
      </section>
      <section data-slot="duplicate-section-2" aria-label="Secondary location">
        <div data-slot="duplicate-2" data-automation-id="formField"><label for="generated-5">Country</label><input id="generated-5" required></div>
      </section>
    </main>`);
    const pageId = "page-perturbed-canonical-discovery" as never;
    await bindQuestionnaireTargets(page, pageId);
    const original = new Map<string, string | null>();
    for (const slot of ["alpha", "beta"]) {
      original.set(slot, await page.locator(`[data-slot="${slot}"] input`)
        .getAttribute("data-hunt-target-token"));
    }
    const duplicateTokens = await page.locator('[data-slot^="duplicate-"] input')
      .evaluateAll((inputs) => inputs.map((input) => input.getAttribute("data-hunt-target-token")));
    assert.equal(new Set(duplicateTokens).size, 2);
    const beforeMutation = await inspectPage(
      page,
      "live_session_duplicate_label_mutation_01" as never,
      pageId,
      new Map(),
    );
    for (const [index, token] of duplicateTokens.entries()) {
      assert.ok(token !== null);
      const target = beforeMutation.targets.get(token)?.[0];
      assert.ok(target !== undefined);
      assert.equal(await applyMutation(page, target, {
        kind: "set_text",
        target: target.token,
        text: index === 0 ? "Primary answer" : "Secondary answer",
      }, undefined, 1_000), "applied");
    }

    await page.locator("main").evaluate((main) => {
      const alpha = main.querySelector('[data-slot="alpha"]')!;
      const beta = main.querySelector('[data-slot="beta"]')!;
      main.insertBefore(beta, alpha);
      const primary = main.querySelector('[data-slot="duplicate-section-1"]')!;
      const secondary = main.querySelector('[data-slot="duplicate-section-2"]')!;
      main.insertBefore(secondary, primary);
      for (const [index, input] of [...main.querySelectorAll("input")].entries()) {
        input.removeAttribute("data-hunt-target-token");
        const label = input.labels?.[0];
        input.id = `react-remount-${100 + index}`;
        input.setAttribute("name", `react-name-${100 + index}`);
        label?.setAttribute("for", input.id);
      }
      (main.querySelector('[data-slot="delayed"]') as HTMLElement).hidden = false;
    });
    await bindQuestionnaireTargets(page, pageId);

    assert.equal(await page.locator('[data-slot="alpha"] input')
      .getAttribute("data-hunt-target-token"), original.get("alpha"));
    assert.equal(await page.locator('[data-slot="beta"] input')
      .getAttribute("data-hunt-target-token"), original.get("beta"));
    assert.match(await page.locator('[data-slot="delayed"] input')
      .getAttribute("data-hunt-target-token") ?? "", /^target-workday-/u);
    const reboundDuplicates = await page.locator('[data-slot^="duplicate-"] input')
      .evaluateAll((inputs) => inputs.map((input) => input.getAttribute("data-hunt-target-token")));
    assert.equal(new Set(reboundDuplicates).size, 2);
    assert.equal(await page.locator('[data-slot="duplicate-1"] input')
      .getAttribute("data-hunt-target-token"), duplicateTokens[0]);
    assert.equal(await page.locator('[data-slot="duplicate-2"] input')
      .getAttribute("data-hunt-target-token"), duplicateTokens[1]);
    const afterMutation = await inspectPage(
      page,
      "live_session_duplicate_label_mutation_01" as never,
      pageId,
      new Map(),
    );
    assert.deepEqual(duplicateTokens.map((token) => {
      const readback = token === null ? undefined : afterMutation.targets.get(token)?.[0]?.readback;
      return readback?.kind === "text" ? readback.value : undefined;
    }), ["Primary answer", "Secondary answer"]);
    const rebound = await inspectPage(
      page,
      "live_session_duplicate_reviewed_remount" as never,
      pageId,
      new Map(),
    );
    const primary = rebound.observation.targets.find(({ token }) => token === duplicateTokens[0]);
    const primaryTarget = primary === undefined ? undefined : rebound.targets.get(primary.token)?.[0];
    assert.equal(await applyMutation(page, primaryTarget!, {
      kind: "set_text",
      target: primary!.token,
      text: "Primary committed",
    }, undefined, 1_000), "applied");
    assert.equal(await page.locator('[data-slot="duplicate-1"] input').inputValue(), "Primary committed");
    assert.equal(await page.locator('[data-slot="duplicate-2"] input').inputValue(), "Secondary answer");
  } finally {
    await browser.close();
  }
});

test("indistinguishable duplicate remounts preserve every physical answer occurrence", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<main data-automation-id="applyFlowApplicationQuestionsPage">
      <div data-automation-id="formField"><label for="member-a">Unseen detail*</label><input id="member-a" required></div>
      <div data-automation-id="formField"><label for="member-b">Unseen detail*</label><input id="member-b" required></div>
    </main>`);
    const pageId = "page-equivalent-duplicate-remount" as never;
    await bindQuestionnaireTargets(page, pageId);
    const tokens = await page.locator("input").evaluateAll((inputs) =>
      inputs.map((input) => input.getAttribute("data-hunt-target-token"))
    );
    assert.equal(new Set(tokens).size, 2);
    assert.ok(tokens.every((token) => /^target-workday-[a-f0-9]{8}-occurrence-[12]$/u.test(token ?? "")));
    const initial = await inspectPage(
      page, "live_session_equivalent_duplicate_01" as never, pageId, new Map(),
    );
    assert.equal(initial.observation.targets.length, 2);
    for (const target of [...initial.targets.values()].flat()) {
      assert.equal(await applyMutation(page, target, {
        kind: "set_text",
        target: target.token,
        text: "Stable synthetic answer",
      }, undefined, 1_000), "applied");
    }
    assert.deepEqual(await page.locator("input").evaluateAll((inputs) =>
      inputs.map((input) => (input as HTMLInputElement).value)
    ), ["Stable synthetic answer", "Stable synthetic answer"]);

    await page.locator("main").evaluate((main) => {
      const members = [...main.children];
      main.prepend(members[1]!);
      for (const [index, input] of [...main.querySelectorAll("input")].entries()) {
        input.removeAttribute("data-hunt-target-token");
        const label = input.labels?.[0];
        input.id = `remounted-member-${index + 20}`;
        label?.setAttribute("for", input.id);
      }
    });
    await bindQuestionnaireTargets(page, pageId);
    assert.deepEqual(await page.locator("input").evaluateAll((inputs) =>
      inputs.map((input) => input.getAttribute("data-hunt-target-token"))
    ), tokens);
    const rebound = await inspectPage(
      page, "live_session_equivalent_duplicate_01" as never, pageId, new Map(),
    );
    assert.equal(rebound.observation.targets.length, 2);
    assert.deepEqual([...rebound.targets.values()].flat().map(({ readback }) =>
      readback.kind === "text" ? readback.value : undefined
    ), ["Stable synthetic answer", "Stable synthetic answer"]);
  } finally {
    await browser.close();
  }
});

test("duplicate tokenless select, popup, date, and multiselect members mutate independently", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<main data-automation-id="applyFlowApplicationQuestionsPage">
      <div data-automation-id="formField"><label>Native choice*<select required><option>Select One</option><option>Yes</option><option>No</option></select></label></div>
      <div data-automation-id="formField"><label>Native choice*<select required><option>Select One</option><option>Yes</option><option>No</option></select></label></div>
      <div data-automation-id="formField"><label>Popup choice*</label><button type="button" aria-haspopup="listbox" aria-required="true">Select One</button></div>
      <div data-automation-id="formField"><label>Popup choice*</label><button type="button" aria-haspopup="listbox" aria-required="true">Select One</button></div>
      <div data-automation-id="formField"><label>Available date*<input type="date" required></label></div>
      <div data-automation-id="formField"><label>Available date*<input type="date" required></label></div>
      <div data-automation-id="formField"><label>Skills*<select multiple required><option>Assembly</option><option>Quality</option></select></label></div>
      <div data-automation-id="formField"><label>Skills*<select multiple required><option>Assembly</option><option>Quality</option></select></label></div>
      <div id="duplicate-popup" data-automation-id="promptMenu" hidden>
        <div data-automation-id="promptOption">Yes</div><div data-automation-id="promptOption">No</div>
      </div>
      <script>
        let activeButton;
        const popup = document.querySelector('#duplicate-popup');
        document.querySelectorAll('button[aria-haspopup="listbox"]').forEach(button => {
          button.addEventListener('click', () => { activeButton = button; popup.hidden = false; });
        });
        popup.addEventListener('click', event => {
          const option = event.target.closest('[data-automation-id="promptOption"]');
          if (option === null || activeButton === undefined) return;
          activeButton.textContent = option.textContent.trim();
          popup.hidden = true;
        });
      </script>
    </main>`);
    const pageId = "page-equivalent-supported-controls" as never;
    await bindQuestionnaireTargets(page, pageId);
    const inspection = await inspectPage(
      page, "live_session_equivalent_supported_01" as never, pageId, new Map(),
    );
    const groups = new Map<string, typeof inspection.observation.targets>();
    for (const target of inspection.observation.targets) {
      const values = groups.get(target.name) ?? [];
      groups.set(target.name, [...values, target]);
    }
    for (const [name, expected] of [["Native choice*", 2], ["Popup choice*", 2],
      ["Available date*", 2], ["Skills*", 2]] as const) {
      assert.equal(groups.get(name)?.length, expected, name);
    }
    for (const observation of inspection.observation.targets) {
      const target = inspection.targets.get(observation.token)?.[0];
      assert.ok(target !== undefined);
      const mutation = observation.name === "Available date*"
        ? { kind: "set_date" as const, target: observation.token, isoDate: "2026-09-15" }
        : { kind: "select" as const, target: observation.token,
          option: (observation.name === "Skills*" ? "Quality" : "No") as never };
      assert.equal(await applyMutation(page, target, mutation, undefined, 2_000), "applied",
        `${observation.name}:${target.interaction ?? target.control.kind}`);
    }
    assert.deepEqual(await page.locator('select:not([multiple])').evaluateAll((controls) =>
      controls.map((control) => (control as HTMLSelectElement).value)
    ), ["No", "No"]);
    assert.deepEqual(await page.locator('button[aria-haspopup="listbox"]').allInnerTexts(), ["No", "No"]);
    assert.deepEqual(await page.locator('input[type="date"]').evaluateAll((controls) =>
      controls.map((control) => (control as HTMLInputElement).value)
    ), ["2026-09-15", "2026-09-15"]);
    assert.deepEqual(await page.locator('select[multiple]').evaluateAll((controls) =>
      controls.map((control) => [...(control as HTMLSelectElement).selectedOptions]
        .map((option) => option.textContent))
    ), [["Quality"], ["Quality"]]);
    const verified = await inspectPage(
      page, "live_session_equivalent_supported_01" as never, pageId, new Map(),
    );
    assert.equal(verified.observation.targets.length, 8);
  } finally {
    await browser.close();
  }
});

test("full questionnaire reconciliation rehydrates selected same-label popup classes after remount", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const evidenceRoot = mkdtempSync(join(tmpdir(), "hunt-duplicate-question-learning-"));
  const learning = createQuestionAnswerLearningCapture({
    root: evidenceRoot,
    mode: "synthetic_test_non_submittable",
    executionPolicy: liveApplicationExecutionPolicy("synthetic_test_non_submittable"),
  });
  const artifact = resumeArtifact();
  const resumeIntent = createWorkdayResumeFileIntent({
    artifactId: artifact.resumeId,
    artifact,
    fileType: "pdf",
  });
  if (!resumeIntent.ok) throw new Error("resume fixture invalid");
  await page.setContent(`<main data-automation-id="applyFlowApplicationQuestionsPage">
    <div data-automation-id="formField"><label>Unseen popup*</label><button type="button" aria-haspopup="listbox" aria-controls="shared-popup" aria-required="true" data-options='["Shared","Popup alpha"]'>Select One</button></div>
    <div data-automation-id="formField"><label>Unseen popup*</label><button type="button" aria-haspopup="listbox" aria-controls="shared-popup" aria-required="true" data-options='["Shared","Popup beta"]'>Select One</button></div>
    <div id="shared-popup" role="listbox" data-automation-id="promptMenu" hidden><div data-automation-id="promptOption">Shared</div><div data-automation-id="promptOption">Popup beta</div></div>
    <script>
      document.addEventListener('click', event => {
        const button = event.target.closest('button[aria-haspopup="listbox"]');
        const portal = document.querySelector('[data-automation-id="promptMenu"]');
        if (button) {
          document.querySelectorAll('button[aria-haspopup="listbox"]').forEach(item =>
            item.setAttribute('aria-expanded', String(item === button)));
          portal.replaceChildren(...JSON.parse(button.dataset.options).map(label => {
            const option = document.createElement('div');
            option.dataset.automationId = 'promptOption';
            option.textContent = label;
            return option;
          }));
          portal.hidden = false;
          return;
        }
        const option = event.target.closest('[data-automation-id="promptOption"]');
        const activeButton = document.querySelector('button[aria-haspopup="listbox"][aria-expanded="true"]');
        if (!option || !activeButton) return;
        activeButton.textContent = option.textContent.trim();
        activeButton.setAttribute('aria-expanded', 'false');
        portal.hidden = true;
      });
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        document.querySelector('[data-automation-id="promptMenu"]').hidden = true;
        document.querySelectorAll('button[aria-haspopup="listbox"]').forEach(button =>
          button.setAttribute('aria-expanded', 'false'));
      });
    </script>
  </main>`);
  let operation = 0;
  const acceptances: { readonly checkpoint: string; readonly answers?: readonly unknown[] }[] = [];
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {
      owner: { revisionId: "revision_duplicate_physical_occurrences" },
      ownerSources: {
        resumeIntent: resumeIntent.value,
        profileId: upstreamProfileId("profile-duplicate-physical-occurrences"),
        profileRevision: 1,
        profileQuery: {
          async query() {
            return { ok: true as const, value: { kind: "profile_answer_missing" as const } };
          },
        },
        narrative: createConfiguredNarrativeProvider({
          revision: "narrative-duplicate-physical-v1",
          template: "Synthetic duplicate fixture narrative.",
        }),
        sensitiveValues: [],
        profilePlan: { mode: "synthetic_test_non_submittable" },
      },
      questionLearning: learning,
    } as never,
    acceptances: { record(value) { acceptances.push(value); } },
    nextOperationId: () => generatedOperationId(
      `operation_duplicate_physical_${(++operation).toString().padStart(8, "0")}`,
    ),
    timeoutMs: 3_000,
    initialReviewExpected: [],
    externalMonitor: { async auth() {}, async application() {} },
    authorizationExpiresAt: "2026-09-01T12:30:00.000Z",
    now: () => "2026-09-01T12:00:00.000Z",
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_duplicate_physical_01"),
    sessionId: "live_session_duplicate_physical_01" as LiveSessionId,
    profileLeaseId: "profile_lease_duplicate_physical_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-09-01T13:00:00.000Z",
  });
  try {
    const reconcile = (attempt: number) => runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_duplicate_physical_01"),
      operationId: generatedOperationId(`operation_duplicate_run_${attempt.toString().padStart(8, "0")}`),
      sessionId: "live_session_duplicate_physical_01" as LiveSessionId,
      target: {} as never,
      now: "2026-09-01T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt, pageId: "page-duplicate-physical" } as never,
    }, new AbortController().signal);
    const first = await reconcile(1);
    assert.equal((first as { ok: boolean }).ok, true, JSON.stringify(first));
    const assertClassValid = async () => {
      assert.deepEqual(await page.locator('button[aria-haspopup="listbox"]').evaluateAll((controls) =>
        controls.map((control) => {
          const options = JSON.parse(control.getAttribute("data-options") ?? "[]") as string[];
          const hydrated = JSON.parse(control.getAttribute("data-hunt-popup-options") ?? "[]") as string[];
          return options.includes(control.textContent?.trim() ?? "") &&
            JSON.stringify(options) === JSON.stringify(hydrated);
        })
      ), [true, true]);
    };
    await assertClassValid();
    const originalPopupTokens = await page.locator('button[aria-haspopup="listbox"]').evaluateAll((controls) =>
      Object.fromEntries(controls.map((control) => [
        control.getAttribute("data-options"), control.getAttribute("data-hunt-target-token"),
      ]))
    );
    assert.equal(acceptances.at(-1)?.checkpoint, "questionnaire_verified",
      JSON.stringify(acceptances));
    await page.locator("main").evaluate((main) => {
      const replacement = main.cloneNode(true) as HTMLElement;
      replacement.querySelectorAll("*").forEach((element) =>
        [...element.attributes].filter(({ name }) => name.startsWith("data-hunt-"))
          .forEach(({ name }) => element.removeAttribute(name))
      );
      const popupFields = [...replacement.querySelectorAll('button[aria-haspopup="listbox"]')]
        .map((button) => button.closest('[data-automation-id="formField"]'));
      popupFields[0]?.before(popupFields[1]!);
      main.replaceWith(replacement);
    });
    const rebound = await reconcile(2);
    assert.equal((rebound as { ok: boolean }).ok, true, JSON.stringify(rebound));
    assert.deepEqual(await page.locator('button[aria-haspopup="listbox"]').evaluateAll((controls) =>
      Object.fromEntries(controls.map((control) => [
        control.getAttribute("data-options"), control.getAttribute("data-hunt-target-token"),
      ]))
    ), originalPopupTokens);
    await assertClassValid();
    assert.equal(acceptances.length, 2);
    assert.ok(acceptances.every(({ checkpoint }) => checkpoint === "questionnaire_verified"));
    learning.write();
    const pending = JSON.parse(readFileSync(
      join(evidenceRoot, "pending-profile-questions.json"), "utf8",
    )) as { pendingProfileQuestions: readonly { fieldId: string; committedReadback: string }[] };
    assert.equal(pending.pendingProfileQuestions.length, 2);
    assert.equal(new Set(pending.pendingProfileQuestions.map(({ fieldId: occurrence }) => occurrence)).size, 2);
    assert.ok(pending.pendingProfileQuestions.every(({ committedReadback }) => committedReadback.length > 0));
  } finally {
    runtime.dispose();
    disposeResumeArtifact(artifact);
    rmSync(evidenceRoot, { recursive: true, force: true });
    await context.close();
    await browser.close();
  }
});

test("questionnaire binding distinguishes independent, exclusive, and multi checkbox semantics", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<main data-automation-id="applyFlowApplicationQuestionsPage">
      <div data-automation-id="formField-independent">
        <label><input id="ack-one" name="ack-one" type="checkbox" required> Acknowledge one</label>
        <label><input id="ack-two" name="ack-two" type="checkbox" required> Acknowledge two</label>
      </div>
      <div data-automation-id="formField-exclusive" role="group" aria-label="Choose one status">
        <label><input id="exclusive-a" name="status" type="checkbox" required> Status A</label>
        <label><input id="exclusive-b" name="status" type="checkbox" required> Status B</label>
      </div>
      <div data-automation-id="formField-multiple" role="group" aria-label="Select all that apply"
        aria-multiselectable="true">
        <label><input id="multiple-a" name="skills" type="checkbox" required> Skill A</label>
        <label><input id="multiple-b" name="skills" type="checkbox" required> Skill B</label>
      </div>
    </main>`);
    const pageId = "page-checkbox-semantics" as never;
    await bindQuestionnaireTargets(page, pageId);

    assert.equal(await page.locator('[data-automation-id="formField-independent"]')
      .getAttribute("data-hunt-exclusive-checkbox-group"), null);
    assert.equal(await page.locator('[data-automation-id="formField-independent"] input[data-hunt-target-token]')
      .count(), 2);
    assert.equal(await page.locator('[data-automation-id="formField-exclusive"]')
      .getAttribute("data-hunt-checkbox-group-kind"), "exclusive");
    assert.equal(await page.locator('[data-automation-id="formField-multiple"]')
      .getAttribute("data-hunt-checkbox-group-kind"), "multiple");

    const inspected = await inspectPage(
      page,
      "live_session_checkbox_semantics_01" as never,
      pageId,
      new Map(),
    );
    const multiple = inspected.observation.targets.find(({ name }) =>
      String(name).includes("Select all that apply")
    );
    assert.equal(multiple?.control.kind, "select");
    assert.equal(Object.hasOwn(multiple?.control ?? {}, "choice"), false);
    const exclusive = inspected.observation.targets.find(({ name }) =>
      String(name).includes("Choose one status")
    );
    const acknowledgement = inspected.observation.targets.find(({ name }) =>
      String(name).includes("Acknowledge one")
    );
    const multipleTarget = multiple === undefined ? undefined : inspected.targets.get(multiple.token)?.[0];
    const exclusiveTarget = exclusive === undefined ? undefined : inspected.targets.get(exclusive.token)?.[0];
    const acknowledgementTarget = acknowledgement === undefined
      ? undefined
      : inspected.targets.get(acknowledgement.token)?.[0];
    assert.equal(await applyMutation(page, acknowledgementTarget!, {
      kind: "set_checked",
      target: acknowledgement!.token,
      checked: true,
    }, undefined, 1_000), "applied");
    assert.equal(await applyMutation(page, exclusiveTarget!, {
      kind: "select",
      target: exclusive!.token,
      option: "Status A" as never,
    }, undefined, 1_000), "applied");
    assert.equal(await applyMutation(page, multipleTarget!, {
      kind: "select",
      target: multiple!.token,
      option: "Skill A" as never,
    }, undefined, 1_000), "applied");
    assert.equal(await page.locator('[data-automation-id="formField-exclusive"] input:checked').count(), 1);
    assert.equal(await page.locator('[data-automation-id="formField-multiple"] input:checked').count(), 1);
    assert.equal(await page.locator("#ack-one").isChecked(), true);
    const application = await new PlaywrightWorkdayApplicationPage(page).observe(
      AbortSignal.any([]),
    );
    assert.equal(application.ok, true);
    if (application.ok) {
      assert.equal(application.value.requiredFields.length, 4);
      assert.equal(new Set(application.value.requiredFields.map(({ fieldId }) => fieldId)).size, 4);
    }
    const coverage = await monitorQuestionnaireCoverage(page);
    assert.deepEqual(coverage, {
      fieldCount: 4,
      requiredFieldCount: 4,
      typeCounts: { checkbox: 2, radio: 1, select: 1 },
    });
  } finally {
    await browser.close();
  }
});

test("semantic adapter covers ARIA controls, contenteditable, multiselect, and readonly constraints", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<main>
      <div role="radiogroup" aria-label="ARIA radio" data-hunt-target-token="target-workday-11111111-1">
        <div role="radio" aria-label="One" aria-checked="false"></div>
        <div role="radio" aria-label="Two" aria-checked="true"></div>
      </div>
      <div role="checkbox" aria-label="ARIA acknowledgement" aria-checked="false"
        data-hunt-target-token="target-workday-22222222-1"></div>
      <div contenteditable="true" aria-label="Editable narrative"
        data-hunt-target-token="target-workday-33333333-1">Draft</div>
      <select multiple aria-label="Native multiple" data-hunt-target-token="target-workday-44444444-1">
        <option selected>Alpha</option><option>Beta</option>
      </select>
      <input readonly required aria-label="Derived identifier" value="DERIVED-1"
        data-hunt-target-token="target-workday-55555555-1">
      <input type="email" maxlength="64" aria-label="Constrained email"
        data-hunt-target-token="target-workday-66666666-1">
    </main>`);
    const observed = await inspectPage(
      page,
      "live_session_supported_controls_01" as never,
      "page-supported-controls" as never,
      new Map(),
    );
    const controls = new Map(observed.observation.targets.map((target) => [String(target.name), target]));
    assert.equal(controls.get("ARIA radio")?.readback.kind, "selected");
    assert.equal(controls.get("ARIA acknowledgement")?.control.kind, "choice");
    assert.equal(controls.get("Editable narrative")?.control.kind, "text");
    const multiple = controls.get("Native multiple")?.control;
    assert.equal(multiple?.kind, "select");
    assert.equal(Object.hasOwn(multiple ?? {}, "multiple"), false);
    const derived = controls.get("Derived identifier")?.control;
    assert.equal(derived?.kind, "text");
    assert.equal(Object.hasOwn(derived ?? {}, "constraints"), false);
    const email = controls.get("Constrained email")?.control;
    assert.equal(email?.kind, "text");
    assert.equal(Object.hasOwn(email ?? {}, "constraints"), false);

    const applicationFields = await enrichQuestionnaireFields(
      page,
      discoverFields(observed.observation.targets),
    );
    const fields = new Map(applicationFields.map((field) => [String(field.label), field]));
    assert.equal(fields.get("Native multiple")?.selectionMode, "multiple");
    assert.equal(fields.get("Derived identifier")?.readOnly, true);
    assert.equal(fields.get("Derived identifier")?.constraints?.readOnly, true);
    assert.equal(fields.get("Constrained email")?.constraints?.inputType, "email");
    assert.equal(fields.get("Constrained email")?.constraints?.maxLength, 64);
  } finally {
    await browser.close();
  }
});

test("production questionnaire coverage uses the shared supported-control registry", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<main data-automation-id="applyFlowApplicationQuestionsPage">
      <div contenteditable="true" aria-required="true" aria-label="Narrative"></div>
      <div role="radiogroup" aria-required="true" aria-label="Status">
        <div role="radio" aria-label="One" aria-checked="false"></div>
        <div role="radio" aria-label="Two" aria-checked="false"></div>
      </div>
      <select required multiple aria-label="Native skills"><option>One</option><option>Two</option></select>
      <div role="combobox" aria-required="true" aria-multiselectable="true"
        aria-label="ARIA skills"></div>
    </main>`);

    const coverage = await monitorQuestionnaireCoverage(page);
    assert.deepEqual(coverage, {
      fieldCount: 4,
      requiredFieldCount: 4,
      typeCounts: { text: 1, radio: 1, select: 2 },
    });
  } finally {
    await page.close();
    await browser.close();
  }
});

test("Review accepts transient Submit enabled drift when semantic invariants remain stable", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html data-hunt-page-id="page-review" data-hunt-submit-activated="false"><body data-hunt-application-page="pre_review"><div data-automation-id="progressBarActiveStep">Review</div><main data-automation-id="applyFlowReviewPage"><section data-hunt-review-field-id="s1-field-resume">resume.pdf</section><button id="final-submit">Submit application</button></main></body></html>`);
  const trace: { event: string; details?: object }[] = [];
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {} as never,
    acceptances: { record() {} },
    nextOperationId: () => generatedOperationId("operation_review_benign_drift_next_01"),
    timeoutMs: 1_000,
    initialReviewExpected: [{
      fieldId: "s1-field-resume",
      provenance: "resume_verified",
      rowIdentity: "formField-s1-field-resume",
      valueSha256: createHash("sha256").update("resume.pdf").digest("hex"),
    }],
    externalMonitor: {
      async auth() {},
      async application() {
        await page.locator("#final-submit").evaluate((element) => {
          (element as HTMLButtonElement).disabled = true;
        });
      },
    },
    trace: (event, details) => trace.push({ event, details }),
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_review_benign_drift_0001"),
    sessionId: "live_session_review_benign_drift_0001" as LiveSessionId,
    profileLeaseId: "profile_lease_review_benign_drift_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  });
  try {
    const result = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_review_benign_drift_0001"),
      operationId: generatedOperationId("operation_review_benign_drift_0001"),
      sessionId: "live_session_review_benign_drift_0001" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, { kind: "capture_review" }, new AbortController().signal);

    assert.equal(
      (result as { structure: { finalSubmit: { enabled: boolean } } }).structure.finalSubmit.enabled,
      false,
    );
    assert.deepEqual(trace.filter(({ event }) => event === "review_structural_drift_warning"), [{
      event: "review_structural_drift_warning",
      details: {
        changes: [{ member: "finalSubmit.enabled", before: true, after: false }],
      },
    }]);
    assert.equal(await page.locator("html").getAttribute("data-hunt-submit-activated"), "false");
  } finally {
    runtime.dispose();
    await context.close();
    await browser.close();
  }
});

test("Review still rejects Submit disappearance after monitor readback", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html data-hunt-page-id="page-review" data-hunt-submit-activated="false"><body data-hunt-application-page="pre_review"><div data-automation-id="progressBarActiveStep">Review</div><main data-automation-id="applyFlowReviewPage"><section data-hunt-review-field-id="s1-field-resume">resume.pdf</section><button id="final-submit">Submit application</button></main></body></html>`);
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {} as never,
    acceptances: { record() {} },
    nextOperationId: () => generatedOperationId("operation_review_submit_loss_next_01"),
    timeoutMs: 1_000,
    initialReviewExpected: [{
      fieldId: "s1-field-resume",
      provenance: "resume_verified",
      rowIdentity: "formField-s1-field-resume",
      valueSha256: createHash("sha256").update("resume.pdf").digest("hex"),
    }],
    externalMonitor: {
      async auth() {},
      async application() {
        await page.locator("#final-submit").evaluate((element) => element.remove());
      },
    },
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_review_submit_loss_0001"),
    sessionId: "live_session_review_submit_loss_0001" as LiveSessionId,
    profileLeaseId: "profile_lease_review_submit_loss_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  });
  try {
    await assert.rejects(() => runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_review_submit_loss_0001"),
      operationId: generatedOperationId("operation_review_submit_loss_0001"),
      sessionId: "live_session_review_submit_loss_0001" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, { kind: "capture_review" }, new AbortController().signal), /Review structure denied/u);
    assert.equal(await page.locator("html").getAttribute("data-hunt-submit-activated"), "false");
  } finally {
    runtime.dispose();
    await context.close();
    await browser.close();
  }
});

test("application authority expiring during ACK permits no reconcile, navigation, reload, or Review continuation", async (t) => {
  const cases: readonly [string, OwnedApplicationOperation, string][] = [
    ["resume reconcile", { kind: "reconcile_resume", input: { attempt: 1, pageId: "page-resume" } as never }, "resume"],
    ["profile reconcile", { kind: "reconcile_profile", input: { attempt: 1, pageId: "page-profile" } as never }, "profile"],
    ["questionnaire reconcile", { kind: "reconcile_questionnaire", input: { attempt: 1, pageId: "page-questionnaire" } as never }, "questionnaire"],
    ["forward navigation", { kind: "next", input: { from: "resume", expected: "profile" } as never }, "resume"],
    ["reload", { kind: "reload" }, "resume"],
    ["Review readback", { kind: "capture_review" }, "pre_review"],
  ];
  for (const [name, operation, pageKind] of cases) await t.test(name, async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const review = pageKind === "pre_review"
      ? '<div data-automation-id="progressBarActiveStep">Review</div><main data-automation-id="applyFlowReviewPage"><section data-hunt-review-field-id="s1-field-resume">resume.pdf</section><button>Submit application</button></main>'
      : pageKind === "questionnaire"
      ? '<main data-automation-id="applyFlowApplicationQuestionsPage"><label>Question<textarea required></textarea></label></main>'
      : pageKind === "profile"
      ? '<main data-automation-id="applyFlowMyInfoPage"><label for="name--legalName--firstName">First Name</label><input id="name--legalName--firstName" required></main>'
      : '<main data-automation-id="applyFlowMyInfoPage"><button id="effect">Next</button><input type="file" data-automation-id="file-upload-input-ref"><textarea></textarea></main>';
    await page.setContent(`<!doctype html><html data-hunt-page-id="page-${pageKind}" data-hunt-submit-activated="false"><body data-hunt-application-page="${pageKind}">${review}<script>window.effectCount=0;document.querySelector('#effect')?.addEventListener('click',()=>window.effectCount++);window.addEventListener('beforeunload',()=>window.effectCount++);</script></body></html>`);
    let current = "2026-08-05T12:00:00.000Z";
    const runtime = new OwnedWorkdayApplicationRuntime({
      request: pageKind === "profile" ? {
        ownerSources: {
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
          sensitiveValues: ["Ada"],
        },
      } as never : {} as never,
      acceptances: { record() {} },
      nextOperationId: () => generatedOperationId("operation_expiry_next_000001"),
      timeoutMs: 1_000,
      initialReviewExpected: pageKind === "pre_review" ? [{
        fieldId: "s1-field-resume",
        provenance: "resume_verified",
        rowIdentity: "formField-s1-field-resume",
        valueSha256: createHash("sha256").update("resume.pdf").digest("hex"),
      }] : [],
      externalMonitor: {
        async auth() {},
        async application() { current = "2026-08-05T12:30:00.000Z"; },
      },
      authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
      now: () => current,
    });
    runtime.bindSession({
      schemaVersion: 1,
      journeyId: journeyId("journey_expiry_during_ack_01"),
      sessionId: "live_session_expiry_ack_0001" as LiveSessionId,
      profileLeaseId: "profile_lease_expiry_ack_01" as ProfileLeaseId,
      target: {} as never,
      leaseExpiresAt: "2026-08-05T13:00:00.000Z",
    });
    try {
      await assert.rejects(() => runtime.run(page as never, {
        schemaVersion: 1,
        journeyId: journeyId("journey_expiry_during_ack_01"),
        operationId: generatedOperationId(`operation_expiry_${name.replace(/[^a-z]/gu, "_")}_01`),
        sessionId: "live_session_expiry_ack_0001" as LiveSessionId,
        target: {} as never,
        now: "2026-08-05T12:00:00.000Z",
      }, operation, new AbortController().signal), /application authorization expired/u);
      assert.equal(await page.evaluate(() => (window as unknown as { effectCount: number }).effectCount), 0);
    } finally {
      runtime.dispose();
      await context.close();
      await browser.close();
    }
  });
});

import { runApplicationPageWalk } from "../../../src/ats/workday/application/page-walk.ts";
import { createConfiguredNarrativeProvider } from "../../../src/ats/workday/application/questions/index.ts";
import {
  createWorkdayResumeFileIntent,
  workdayResumeUploadFileName,
} from "../../../src/ats/workday/application/resume/index.ts";
import { createStage2PlaywrightLiveRuntimeBinding } from "../../../src/acceptance/s2-playwright-runtime.ts";
import {
  captureResumeArtifact,
  disposeResumeArtifact,
  generatedOperationId,
  journeyId,
  upstreamProfileId,
  upstreamResumeId,
  type OperationId,
  type ProfileQueryRequest,
} from "../../../src/contracts/index.ts";
import type {
  LiveBrowserSessionV1,
  LiveSessionId,
  ProfileLeaseId,
} from "../../../src/contracts/live/index.ts";
import { inspectWorkdayReview, stopAtVerifiedReview } from "../../../src/interaction/review/index.ts";
import { recoverBrowserInterruption } from "../../../src/journey/recovery/index.ts";

test("external monitor budget outlives the base application operation timeout", async () => {
  const browser = await chromium.launch({ headless: true });
  const html = encodeURIComponent(
    '<!doctype html><html data-hunt-page-id="page-profile" data-hunt-submit-activated="false"><body data-hunt-application-page="profile"><main data-automation-id="applyFlowMyInfoPage"><input required data-automation-id="legalNameSection_firstName"></main></body></html>',
  );
  const run = async (
    applicationOperationTimeoutMs: number | undefined,
    suffix: string,
    abortAfterMs?: number,
  ) => {
    const context = await browser.newContext();
    const monitor = {
      async auth() { await new Promise((resolve) => setTimeout(resolve, 1_250)); },
      async application() {},
    };
    const provider = new PlaywrightPersistentBrowserSession({
      binding: {
        forPersistentBrowser: () => ({
          targetUrl: approvedFixtureTargetUrl,
          profilePath: `C:\\outside\\runtime\\monitor-${suffix}`,
          admittedAt: "2026-08-05T12:00:00.000Z",
          leaseExpiresAt: "2026-08-06T12:00:00.000Z",
        }),
      },
      launcher: {
        async launchPersistentContext() {
          return redirectingContext(context, `data:text/html,${html}`);
        },
      },
      probe: { async inspect() { return ownedMatchedFixture(); } },
      profiles: new FixtureProfiles(),
      applicationRuntime: {
        request: {} as never,
        acceptances: { record() {} },
        nextOperationId: () => generatedOperationId(`operation_monitor_next_${suffix}`),
        timeoutMs: 1_000,
        initialReviewExpected: [],
        externalMonitor: monitor,
        authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
        now: () => "2026-08-05T12:00:00.000Z",
      },
      externalMonitor: monitor,
      ids: () => `live_session_monitor_${suffix}` as LiveSessionId,
      timeoutMs: 1_000,
      applicationOperationTimeoutMs,
    });
    const opened = await provider.open({
      schemaVersion: 1,
      journeyId: journeyId(`journey_monitor_${suffix}`),
      operationId: generatedOperationId(`operation_monitor_open_${suffix}`),
      profileLeaseId: `profile_lease_monitor_${suffix}` as ProfileLeaseId,
      target: {
        schemaVersion: 1,
        host: "approved.wd5.myworkdayjobs.invalid",
        tenant: "approved",
        posting: "R12345",
      } as never,
    }, new AbortController().signal);
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("monitor fixture open failed");
    const controller = new AbortController();
    const abort = abortAfterMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(), abortAfterMs);
    const result = await provider[ownedApplicationPageAccess]({
      schemaVersion: 1,
      journeyId: opened.value.session.journeyId,
      operationId: generatedOperationId(`operation_monitor_access_${suffix}`),
      sessionId: opened.value.session.sessionId,
      target: opened.value.session.target,
      now: "2026-08-05T12:00:00.000Z",
    }, { kind: "monitor_auth_state" }, controller.signal);
    if (abort !== undefined) clearTimeout(abort);
    await context.close();
    return result;
  };
  try {
    assert.deepEqual(await run(2_500, "budgeted_0001"), { ok: true, value: undefined });
    assert.deepEqual(await run(undefined, "base_000000001"), {
      ok: false,
      error: { code: "browser_timeout", retryable: true },
    });
    assert.deepEqual(await run(2_500, "cancelled_00001", 25), {
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    });
  } finally {
    await browser.close();
  }
});

test("one owned Playwright page completes application, recovers, proves Review, and never activates Submit", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-owned-runtime-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureDocument());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server unavailable");
  const url = `http://127.0.0.1:${address.port}/application-questions`;
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  const artifact = resumeArtifact();
  const intent = createWorkdayResumeFileIntent({
    artifactId: artifact.resumeId,
    artifact,
    fileType: "pdf",
  });
  if (!intent.ok) throw new Error("resume fixture invalid");
  const resumeFileName = workdayResumeUploadFileName(intent.value);
  let operation = 0;
  const nextOperationId = () => generatedOperationId(
    `operation_${(++operation).toString().padStart(16, "0")}`,
  );
  let owned: PlaywrightPersistentBrowserSession | undefined;
  const runtimeBinding = createStage2PlaywrightLiveRuntimeBinding({
    browser: (request, applicationRuntime) => owned = new PlaywrightPersistentBrowserSession({
      binding: request.ownerBinding,
      launcher: { async launchPersistentContext() { return redirectingContext(context, url); } },
      probe: { async inspect() { return ownedMatchedFixture(); } },
      profiles: new FixtureProfiles(),
      applicationRuntime,
      ids: () => "live_session_runtime_fixture_01" as LiveSessionId,
      timeoutMs: 5_000,
    }),
    now: () => "2026-08-05T12:00:00.000Z",
    nextOperationId,
    timeoutMs: 5_000,
  });

  try {
    const runtime = await runtimeBinding.bind({
      owner: owner(root, url),
      ownerBinding: {
        forPersistentBrowser: () => ({
          targetUrl: approvedFixtureTargetUrl,
          profilePath: join(root, "profile"),
          admittedAt: "2026-08-05T12:00:00.000Z",
          leaseExpiresAt: "2026-08-06T12:00:00.000Z",
        }),
      } as never,
      ownerSources: {
        resumeIntent: intent.value,
        profilePlan: { mode: "live", pageType: "profile", fields: [], repeatables: [] },
        executionPolicy: {
          browserTransport: "live_browser",
          answerFallbackPolicy: "owner_facts_only",
          submissionPolicy: "forbidden",
          liveProofEligibility: "eligible",
        },
        profileId: upstreamProfileId("profile-runtime-fixture"),
        profileRevision: 1,
        profileQuery: {
          async query(input: ProfileQueryRequest) {
            return input.factId === "configured_narrative"
              ? {
                ok: true as const,
                value: {
                  kind: "answered" as const,
                  value: "Exact configured interest statement.",
                  provenance: "configured_template" as const,
                  lane: "live_owner_fact" as const,
                },
              }
              : { ok: true as const, value: { kind: "profile_answer_missing" as const } };
          },
        },
        narrative: createConfiguredNarrativeProvider({
          revision: "narrative-runtime-v1",
          template: "Exact configured interest statement.",
        }),
        sensitiveValues: [
          "Exact configured interest statement.",
          "No",
          ...Array.from({ length: 48 }, (_value, index) =>
            `owner-sensitive-value-${index.toString().padStart(2, "0")}`
          ),
        ],
      },
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);

    const walked = await runApplicationPageWalk(runtime.walk, {
      journeyId: journeyId("journey_runtime_fixture_01"),
      stopAfter: "pre_review",
    }, new AbortController().signal);
    assert.equal(walked.ok, true, JSON.stringify(walked));
    assert.equal(walked.ok && walked.value.checkpoint, "pre_review");
    assert.deepEqual(runtime.laneAcceptances.snapshot("pre_review").map(({ checkpoint }) => checkpoint), [
      "profile_verified",
      "resume_verified",
      "questionnaire_verified",
    ]);
    const page = context.pages()[0];
    if (page === undefined || owned === undefined) throw new Error("owned fixture page missing");
    const recoveryPath = join(
      root,
      "stage2-acceptance",
      "revision_0123456789abcdef.recovery.json",
    );
    const recoveryText = readFileSync(recoveryPath, "utf8");
    assert.equal(recoveryText.includes("Exact configured interest statement."), false);
    const recoveryArtifact = JSON.parse(recoveryText) as {
      readonly reviewExpected?: readonly {
        readonly fieldId?: string;
        readonly rowIdentity?: string;
        readonly valueSha256?: string;
      }[];
    };
    assert.deepEqual(recoveryArtifact.reviewExpected?.map(({ fieldId }) => fieldId), [
      "s1-field-resume",
      "s1-field-interest",
    ]);
    assert.deepEqual(recoveryArtifact.reviewExpected?.map(({ rowIdentity }) => rowIdentity), [
      "formField-s1-field-resume",
      "formField-s1-field-interest",
    ]);
    assert.match(recoveryArtifact.reviewExpected?.[0]?.valueSha256 ?? "", /^[0-9a-f]{64}$/u);

    const pending = await runtime.recovery.pending(new AbortController().signal);
    assert.notEqual(pending, null);
    if (pending === null) throw new Error("checkpoint missing");
    const recovered = await recoverBrowserInterruption(
      pending.dependencies,
      pending.input,
      new AbortController().signal,
    );
    assert.equal(recovered.ok, true);
    assert.equal(recovered.ok && recovered.value.kind, "resumed");
    if (!recovered.ok || recovered.value.kind !== "resumed") {
      throw new Error("recovery fixture did not resume");
    }
    const continued = await runApplicationPageWalk(runtime.walk, {
      journeyId: journeyId("journey_runtime_fixture_01"),
      stopAfter: "pre_review",
    }, new AbortController().signal, { resume: pending.resume(recovered.value.state) });
    assert.equal(continued.ok, true, JSON.stringify(continued));

    const reviewRoot = page.locator('[data-automation-id="applyFlowReviewPage"]');
    const row = reviewRoot.locator("section").nth(1);
    await row.evaluate((node) => { node.textContent = "corrupted across transition"; });
    await assert.rejects(() => runtime.review.capture(new AbortController().signal));
    await row.evaluate((node) => { node.textContent = "Exact configured interest statement."; });
    await row.evaluate((node) => { node.removeAttribute("data-hunt-review-field-id"); });
    await assert.rejects(() => runtime.review.capture(new AbortController().signal));
    const resumeRow = reviewRoot.locator("section").first();
    await resumeRow.evaluate((node, fileName) => {
      node.removeAttribute("data-hunt-review-field-id");
      node.setAttribute("data-automation-id", "formField-s1-field-resume");
      node.innerHTML = `<span>Resume</span><span>${fileName}</span>`;
    }, resumeFileName);
    await row.evaluate((node) => {
      node.setAttribute("data-automation-id", "formField-s1-field-interest");
      node.innerHTML = '<span>Brief interest statement</span><span>Exact configured interest statement.</span>';
    });
    const realShape = await runtime.review.capture(new AbortController().signal);
    assert.equal(realShape.request.verification.length, 2);
    await reviewRoot.evaluate((root) => {
      const extra = document.createElement("section");
      extra.setAttribute("data-automation-id", "formField-tenantOptionalDisplay");
      extra.innerHTML = "<span>Tenant optional display</span><span>Unrelated value</span>";
      root.prepend(extra);
    });
    const realShapeWithExtra = await runtime.review.capture(new AbortController().signal);
    assert.equal(realShapeWithExtra.request.verification.length, 2);
    await reviewRoot.locator('[data-automation-id="formField-tenantOptionalDisplay"]')
      .evaluate((node) => node.remove());
    await resumeRow.evaluate((node) => { node.removeAttribute("data-automation-id"); });
    await row.evaluate((node) => { node.removeAttribute("data-automation-id"); });
    await reviewRoot.evaluate((root) => {
      const workdaySummaryOwner = document.createElement("div");
      workdaySummaryOwner.setAttribute("data-automation-id", "formField-");
      root.prepend(workdaySummaryOwner);
    });
    const workdaySummaryShape = await runtime.review.capture(new AbortController().signal);
    assert.equal(workdaySummaryShape.request.verification.length, 2);
    await row.locator("span").nth(1).evaluate((node) => { node.textContent = "summary mismatch"; });
    await assert.rejects(() => runtime.review.capture(new AbortController().signal));
    await row.locator("span").nth(1).evaluate((node) => {
      node.textContent = "Exact configured interest statement.";
    });
    await reviewRoot.locator('[data-automation-id="formField-"]').evaluate((node) => node.remove());
    await resumeRow.evaluate((node) => { node.setAttribute("data-automation-id", "formField-s1-field-resume"); });
    await row.evaluate((node) => { node.setAttribute("data-automation-id", "formField-s1-field-interest"); });
    await resumeRow.locator("span").nth(1).evaluate((node) => {
      node.textContent = "Exact configured interest statement.";
    });
    await row.locator("span").nth(1).evaluate((node) => { node.textContent = "resume.pdf"; });
    await assert.rejects(() => runtime.review.capture(new AbortController().signal));
    await resumeRow.locator("span").nth(1).evaluate((node, fileName) => { node.textContent = fileName; }, resumeFileName);
    await row.locator("span").nth(1).evaluate((node) => {
      node.textContent = "Exact configured interest statement.";
    });
    await row.evaluate((node) => {
      node.removeAttribute("data-automation-id");
      node.setAttribute("data-hunt-review-field-id", "s1-field-interest");
      node.textContent = "Exact configured interest statement.";
    });
    await resumeRow.evaluate((node, fileName) => {
      node.removeAttribute("data-automation-id");
      node.setAttribute("data-hunt-review-field-id", "s1-field-resume");
      node.textContent = fileName;
    }, resumeFileName);
    await reviewRoot.evaluate((root) => {
      const extra = document.createElement("section");
      extra.setAttribute("data-hunt-review-field-id", "unknown-extra-field");
      extra.textContent = "unknown";
      root.prepend(extra);
    });
    const extraRowShape = await runtime.review.capture(new AbortController().signal);
    assert.equal(extraRowShape.request.verification.length, 2);
    await reviewRoot.locator('[data-hunt-review-field-id="unknown-extra-field"]').evaluate((node) => node.remove());
    const captured = await runtime.review.capture(new AbortController().signal);
    const structure = await inspectWorkdayReview(captured.page);
    const proof = stopAtVerifiedReview({ ...captured.request, structure });
    assert.equal(proof.kind, "review_confirmed");
    assert.equal(await page.evaluate(() => (window as never as { submitActivations: number }).submitActivations), 0);
    assert.equal(context.pages().length, 1);
    const adversarial = await owned[ownedApplicationPageAccess]({
      schemaVersion: 1,
      journeyId: journeyId("journey_runtime_fixture_01"),
      operationId: nextOperationId(),
      sessionId: "live_session_runtime_fixture_01" as LiveSessionId,
      target: {
        schemaVersion: 1,
        atsFamily: "workday",
        hostId: "host_0123456789abcdef" as never,
        tenantId: "tenant_0123456789abcdef" as never,
        postingId: "posting_0123456789abcdef" as never,
      },
      now: "2026-08-05T12:00:00.000Z",
    }, { kind: "submit", selector: "#final-submit" } as never, new AbortController().signal);
    assert.equal(adversarial.ok, false);
    assert.equal(await page.evaluate(() => (window as never as { submitActivations: number }).submitActivations), 0);
    const forbidden = await runtime.privacy.forbiddenTokens(new AbortController().signal);
    assert.equal(forbidden.includes(url), true);
    assert.equal(forbidden.length <= 32, true);
    assert.equal(forbidden.every((value) => value.length >= 3 && value.length <= 512), true);
    assert.equal(await runtime.cleanup.close(new AbortController().signal, true), true);
    assert.equal(context.pages().length, 0);
    await assert.rejects(() => runtime.privacy.forbiddenTokens(new AbortController().signal));
    const revoked = await runtime.walk.observer.observe(new AbortController().signal);
    assert.equal(revoked.ok, false);
  } finally {
    await context.close();
    await chromiumBrowser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("unexpected auth UI fails closed before any application mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-auth-stop-"));
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  const url = `data:text/html,${encodeURIComponent(
    '<html data-hunt-page-id="page-auth"><body><main data-automation-id="signInPage"><label>Email<input></label><button>Sign In</button></main></body></html>',
  )}`;
  const artifact = resumeArtifact();
  const intent = createWorkdayResumeFileIntent({
    artifactId: artifact.resumeId,
    artifact,
    fileType: "pdf",
  });
  if (!intent.ok) throw new Error("resume fixture invalid");
  let operation = 100;
  let owned: PlaywrightPersistentBrowserSession | undefined;
  try {
    const runtime = await createStage2PlaywrightLiveRuntimeBinding({
      browser: (request, applicationRuntime) => owned = new PlaywrightPersistentBrowserSession({
        binding: request.ownerBinding,
        launcher: { async launchPersistentContext() { return redirectingContext(context, url); } },
        probe: { async inspect() { return ownedMatchedFixture(); } },
        profiles: new FixtureProfiles(),
        applicationRuntime,
        ids: () => "live_session_runtime_fixture_01" as LiveSessionId,
        timeoutMs: 2_000,
      }),
      now: () => "2026-08-05T12:00:00.000Z",
      nextOperationId: () => generatedOperationId(
        `operation_${(++operation).toString().padStart(16, "0")}`,
      ),
      timeoutMs: 2_000,
    }).bind({
      owner: owner(root, url),
      ownerBinding: {
        forPersistentBrowser: () => ({
          targetUrl: approvedFixtureTargetUrl,
          profilePath: join(root, "profile"),
          admittedAt: "2026-08-05T12:00:00.000Z",
          leaseExpiresAt: "2026-08-06T12:00:00.000Z",
        }),
      } as never,
      ownerSources: {
        resumeIntent: intent.value,
        profilePlan: { mode: "live", pageType: "profile", fields: [], repeatables: [] },
        executionPolicy: {
          browserTransport: "live_browser",
          answerFallbackPolicy: "owner_facts_only",
          submissionPolicy: "forbidden",
          liveProofEligibility: "eligible",
        },
        profileId: upstreamProfileId("profile-auth-stop"),
        profileRevision: 1,
        profileQuery: { async query() { return { ok: true as const, value: { kind: "profile_answer_missing" as const } }; } },
        narrative: createConfiguredNarrativeProvider({
          revision: "narrative-auth-stop-v1",
          template: "Exact configured interest statement.",
        }),
        sensitiveValues: ["Exact configured interest statement."],
      },
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);
    const walked = await runApplicationPageWalk(runtime.walk, {
      journeyId: journeyId("journey_runtime_fixture_01"),
      stopAfter: "pre_review",
    }, new AbortController().signal);
    assert.equal(walked.ok, false);
    assert.notEqual(owned, undefined);
    const page = context.pages()[0];
    if (page === undefined) throw new Error("auth fixture page missing");
    assert.equal(await page.locator("input").inputValue(), "");
    assert.equal(await runtime.cleanup.close(new AbortController().signal), true);
  } finally {
    disposeResumeArtifact(artifact);
    await context.close();
    await chromiumBrowser.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("account verification reuses the one opened session and leaves cleanup to the runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-session-"));
  const evidenceRoot = join(root, "evidence");
  mkdirSync(evidenceRoot);
  const accountOwner = authorizedOwner(root);
  const base = closedRecoveryBrowser("resume");
  let openCalls = 0;
  let closeCalls = 0;
  let verifierCalls = 0;
  const browser = {
    ...base,
    async open(...args: Parameters<typeof base.open>) {
      openCalls += 1;
      return base.open(...args);
    },
    async close(...args: Parameters<typeof base.close>) {
      closeCalls += 1;
      return base.close(...args);
    },
  };
  try {
    const runtime = await createStage2PlaywrightLiveRuntimeBinding({
      browser: () => browser,
      accountVerifier: async (request) => {
        verifierCalls += 1;
        assert.equal(request.browser, browser);
        assert.equal(request.session.sessionId, "live_session_runtime_fixture_01");
        assert.deepEqual(request.session.target, request.target);
        assert.equal(request.sourceRevision, "0123456789abcdef0123456789abcdef01234567");
        assert.equal(request.configSha256, "a".repeat(64));
        assert.equal(openCalls, 1);
        assert.equal(closeCalls, 0);
        return {
          ok: true,
          proof: {
            schemaVersion: 1,
            proofRevision: "s2-account-session-proof-v1",
            status: "unsealed",
            sourceRevision: request.sourceRevision,
            configSha256: request.configSha256,
            revisionId: "revision_0123456789abcdef",
            approvalId: "approval_0123456789abcdef",
            journeyId: request.session.journeyId,
            targetHandleId: "target_ref_0123456789abcdef",
            accountState: "application_ready",
            independentlyObservedVerifiedState: true,
            verificationProof: "credential_sign_in",
            provider: "workday-auth",
            consumedCandidateCount: 0,
            messageBodyRetained: false,
            submitActivated: false,
          },
        };
      },
      now: () => "2026-08-05T12:00:00.000Z",
      nextOperationId: operationIds(850),
    }).bind({
      owner: accountOwner as never,
      ownerBinding: {} as never,
      ownerSources: {} as never,
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);

    const verified = runtime.account.verify(new AbortController().signal);
    assert.equal(runtime.account.verify(new AbortController().signal), verified);
    assert.equal((await verified).ok, true);
    assert.equal(openCalls, 1);
    assert.equal(closeCalls, 0);
    assert.equal(verifierCalls, 1);
    assert.equal(existsSync(join(evidenceRoot, "acceptance.json")), false);
    assert.equal(existsSync(join(root, "account-session-proof.json")), true);
    assert.equal(await runtime.cleanup.close(new AbortController().signal), true);
    assert.equal(closeCalls, 1);
    assert.equal(existsSync(join(evidenceRoot, "acceptance.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("suspended post-auth recovery reuses only its exact immutable account proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-restart-"));
  mkdirSync(join(root, "evidence"));
  const accountOwner = authorizedOwner(root);
  let liveVerifierCalls = 0;
  const request = {
    owner: accountOwner,
    ownerBinding: {} as never,
    ownerSources: { sensitiveValues: [] } as never,
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    configSha256: "a".repeat(64),
  };
  try {
    const first = await createStage2PlaywrightLiveRuntimeBinding({
      browser: () => closedRecoveryBrowser("profile"),
      accountVerifier: async ({ sourceRevision, configSha256, session }) => {
        liveVerifierCalls += 1;
        return { ok: true, proof: accountSessionProof(sourceRevision, configSha256, session) };
      },
      now: () => "2026-08-05T12:00:00.000Z",
      nextOperationId: operationIds(860),
    }).bind(request, new AbortController().signal);
    assert.equal((await first.account.verify(new AbortController().signal)).ok, true);
    const recoveryDirectory = join(root, "stage2-acceptance");
    writeFileSync(
      join(recoveryDirectory, "revision_0123456789abcdef.recovery.json"),
      `${JSON.stringify(validRecoveryArtifact("profile", 1))}\n`,
      { flag: "wx", mode: 0o600 },
    );
    assert.equal(await first.cleanup.close(new AbortController().signal, false), true);

    const second = await createStage2PlaywrightLiveRuntimeBinding({
      browser: () => closedRecoveryBrowser("profile"),
      accountVerifier: async () => {
        liveVerifierCalls += 1;
        throw new Error("recovery must not repeat live authentication");
      },
      now: () => "2026-08-05T12:05:00.000Z",
      nextOperationId: operationIds(870),
    }).bind(request, new AbortController().signal);
    assert.equal((await second.account.verify(new AbortController().signal)).ok, true);
    assert.equal(liveVerifierCalls, 1);
    assert.notEqual(await second.recovery.pending(new AbortController().signal), null);
    assert.equal(await second.cleanup.close(new AbortController().signal, false), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const proofCase of ["missing", "crossed"] as const) {
  test(`post-auth recovery denies ${proofCase} account proof without repeating authentication`, async () => {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-account-${proofCase}-`));
    mkdirSync(join(root, "evidence"));
    const recoveryDirectory = join(root, "stage2-acceptance");
    mkdirSync(recoveryDirectory);
    writeFileSync(
      join(recoveryDirectory, "revision_0123456789abcdef.recovery.json"),
      `${JSON.stringify(validRecoveryArtifact("profile", 1))}\n`,
      { mode: 0o600 },
    );
    if (proofCase === "crossed") {
      const crossedSession = closedRecoveryBrowser("profile");
      const opened = await crossedSession.open();
      if (!opened.ok) throw new Error("fixture session unavailable");
      writeFileSync(
        join(root, "account-session-proof.json"),
        `${JSON.stringify(accountSessionProof(
          "0123456789abcdef0123456789abcdef01234567",
          "b".repeat(64),
          opened.value.session,
        ))}\n`,
        { mode: 0o600 },
      );
    }
    let verifierCalls = 0;
    try {
      const runtime = await createStage2PlaywrightLiveRuntimeBinding({
        browser: () => closedRecoveryBrowser("profile"),
        accountVerifier: async () => {
          verifierCalls += 1;
          throw new Error("crossed or missing proof must not trigger authentication");
        },
        now: () => "2026-08-05T12:05:00.000Z",
        nextOperationId: operationIds(880),
      }).bind({
        owner: authorizedOwner(root),
        ownerBinding: {} as never,
        ownerSources: { sensitiveValues: [] } as never,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
        configSha256: "a".repeat(64),
      }, new AbortController().signal);
      assert.deepEqual(await runtime.account.verify(new AbortController().signal), {
        ok: false,
        code: "account_proof_invalid",
      });
      assert.equal(verifierCalls, 0);
      assert.equal(await runtime.cleanup.close(new AbortController().signal, false), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("authorization expiry after account proof closes but never seals acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-expiry-"));
  const evidenceRoot = join(root, "evidence");
  mkdirSync(evidenceRoot);
  let current = "2026-08-05T12:00:00.000Z";
  let suspended = 0;
  const base = closedRecoveryBrowser("resume");
  const browser = {
    ...base,
    async [suspendOwnedApplicationSession](...args: Parameters<typeof base[typeof suspendOwnedApplicationSession]>) {
      suspended += 1;
      return base[suspendOwnedApplicationSession](...args);
    },
  };
  try {
    const runtime = await createStage2PlaywrightLiveRuntimeBinding({
      browser: () => browser,
      accountVerifier: async ({ sourceRevision, configSha256, session }) => ({
        ok: true,
        proof: accountSessionProof(sourceRevision, configSha256, session),
      }),
      now: () => current,
      nextOperationId: operationIds(890),
    }).bind({
      owner: authorizedOwner(root),
      ownerBinding: {} as never,
      ownerSources: { sensitiveValues: [] } as never,
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);
    assert.equal((await runtime.account.verify(new AbortController().signal)).ok, true);
    current = "2026-08-06T12:00:00.000Z";
    assert.equal(await runtime.cleanup.close(new AbortController().signal, false), false);
    assert.equal(suspended, 1);
    assert.equal(existsSync(join(evidenceRoot, "acceptance.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Review accepts repeated equal values only when distinct stable identities bind exactly", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-review-equal-values-"));
  const valueSha256 = createHash("sha256").update("resume.pdf", "utf8").digest("hex");
  const artifact = {
    ...validRecoveryArtifact("pre_review", 3),
    reviewExpected: [
      {
        fieldId: "identity.given_name",
        provenance: "owner_provided",
        rowIdentity: "formField-identity.given_name",
        valueSha256,
      },
      {
        fieldId: "address.line_1",
        provenance: "configured_template",
        rowIdentity: "formField-address.line_1",
        valueSha256,
      },
    ],
  };
  const directory = join(root, "stage2-acceptance");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "revision_0123456789abcdef.recovery.json"),
    `${JSON.stringify(artifact)}\n`,
    { mode: 0o600 },
  );
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(equalValueReviewDocument());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server unavailable");
  const url = `http://127.0.0.1:${address.port}/review`;
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  let owned: PlaywrightPersistentBrowserSession | undefined;
  try {
    const runtime = await createStage2PlaywrightLiveRuntimeBinding({
      browser: (request, applicationRuntime) => owned = new PlaywrightPersistentBrowserSession({
        binding: request.ownerBinding,
        launcher: { async launchPersistentContext() { return redirectingContext(context, url); } },
        probe: { async inspect() { return ownedMatchedFixture(); } },
        profiles: new FixtureProfiles(),
        applicationRuntime,
        ids: () => "live_session_review_equal_01" as LiveSessionId,
        timeoutMs: 5_000,
      }),
      nextOperationId: operationIds(500),
      now: () => "2026-08-05T12:00:00.000Z",
      timeoutMs: 5_000,
    }).bind({
      owner: owner(root, url),
      ownerBinding: {
        forPersistentBrowser: () => ({
          targetUrl: approvedFixtureTargetUrl,
          profilePath: join(root, "profile"),
          admittedAt: "2026-08-05T12:00:00.000Z",
          leaseExpiresAt: "2026-08-06T12:00:00.000Z",
        }),
      } as never,
      ownerSources: {} as never,
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);
    assert.notEqual(owned, undefined);
    const captured = await runtime.review.capture(new AbortController().signal);
    assert.deepEqual(captured.request.verification.map(({ fieldId }) => fieldId).sort(), [
      "address.line_1",
      "identity.given_name",
    ]);
    const page = context.pages()[0];
    if (page === undefined) throw new Error("equal-value Review fixture missing");
    const rows = page.locator('[data-automation-id="applyFlowReviewPage"] section');
    await rows.nth(1).evaluate((node) =>
      node.setAttribute("data-automation-id", "formField-identity.given_name")
    );
    await assert.rejects(() => runtime.review.capture(new AbortController().signal));
    await rows.nth(1).evaluate((node) =>
      node.setAttribute("data-automation-id", "formField-unknown.field")
    );
    await assert.rejects(() => runtime.review.capture(new AbortController().signal));
    await rows.nth(1).evaluate((node) =>
      node.setAttribute("data-automation-id", "formField-address.line_1")
    );
    assert.equal((await runtime.review.capture(new AbortController().signal)).request.verification.length, 2);
    assert.equal(await page.evaluate(() => (window as never as { submitActivations: number }).submitActivations), 0);
    assert.equal(await runtime.cleanup.close(new AbortController().signal, false), true);
  } finally {
    await context.close();
    await chromiumBrowser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("Review expected-field grammar matches every accepted field identifier shape", () => {
  const valueSha256 = "a".repeat(64);
  for (const fieldId of ["a", "identity.given_name", "a0._-"]) {
    assert.equal(isReviewExpectedField({
      fieldId,
      provenance: "owner_provided",
      rowIdentity: `formField-${fieldId}`,
      valueSha256,
    }), true, fieldId);
  }
  for (const fieldId of [
    "A0", "_leading", "-leading", ".leading", "identity/given", "identity given",
    "identity:given", "a".repeat(129),
  ]) {
    assert.equal(isReviewExpectedField({
      fieldId,
      provenance: "owner_provided",
      rowIdentity: `formField-${fieldId}`,
      valueSha256,
    }), false, fieldId);
  }
});

test("Review expected-field grammar accepts every persisted answer provenance", () => {
  const valueSha256 = "a".repeat(64);
  for (const provenance of [
    "owner_provided",
    "resume_verified",
    "configured_template",
    "generated_default",
    "journey_derived",
    "reviewed_catalog",
    "visible_option",
  ]) {
    assert.equal(isReviewExpectedField({
      fieldId: "address.country",
      provenance,
      rowIdentity: "formField-address.country",
      valueSha256,
    }), true, provenance);
  }
});

for (const scenario of [
  { name: "Profile matched", stored: "profile", observed: "profile", checks: 1 },
  { name: "Profile advanced to Resume", stored: "profile", observed: "resume", checks: 1 },
  { name: "Resume matched", stored: "resume", observed: "resume", checks: 2 },
  { name: "Resume advanced to Questionnaire", stored: "resume", observed: "questionnaire", checks: 2 },
  { name: "Questionnaire matched", stored: "questionnaire", observed: "questionnaire", checks: 3 },
  { name: "Questionnaire advanced to pre-Review", stored: "questionnaire", observed: "pre_review", checks: 3 },
  { name: "pre-Review matched", stored: "pre_review", observed: "pre_review", checks: 3 },
] as const) {
  test(`${scenario.name} recovery persists an exact cursor across a second restart`, async () => {
    const root = mkdtempSync(join(tmpdir(), "hunt-s2-restart-recovery-"));
    const directory = join(root, "stage2-acceptance");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "revision_0123456789abcdef.recovery.json"),
      `${JSON.stringify(validRecoveryArtifact(scenario.stored, scenario.checks))}\n`,
      { mode: 0o600 },
    );
    let browserCalls = 0;
    try {
      for (let restart = 1; restart <= 2; restart += 1) {
        const runtime = await createStage2PlaywrightLiveRuntimeBinding({
          browser: () => {
            browserCalls += 1;
            return closedRecoveryBrowser(scenario.observed);
          },
          nextOperationId: operationIds(restart * 100),
          now: () => "2026-08-05T12:00:00.000Z",
        }).bind({
          owner: owner(root, "https://fixture.invalid/application-questions"),
          ownerBinding: {} as never,
          ownerSources: {} as never,
          sourceRevision: "0123456789abcdef0123456789abcdef01234567",
          configSha256: "a".repeat(64),
        }, new AbortController().signal);
        const pending = await runtime.recovery.pending(new AbortController().signal);
        assert.notEqual(pending, null);
        if (pending === null) throw new Error("restart recovery artifact missing");
        const recovered = await recoverBrowserInterruption(
          pending.dependencies,
          pending.input,
          new AbortController().signal,
        );
        assert.equal(recovered.ok, true, JSON.stringify(recovered));
        if (!recovered.ok || recovered.value.kind !== "resumed") {
          throw new Error("restart recovery did not resume");
        }
        const cursor = pending.resume(recovered.value.state);
        assert.equal(cursor.currentPage, scenario.observed);
        assert.equal(cursor.pageChecks.length, scenario.checks);
        assert.deepEqual(
          cursor.pageChecks.map(({ page }) => page),
          ["profile", "resume", "questionnaire"].slice(0, scenario.checks),
        );
        assert.equal(await runtime.cleanup.close(new AbortController().signal, false), true);
      }
      assert.equal(browserCalls, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("combined Resume/Profile recovery preserves the exact physical capabilities", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-combined-recovery-"));
  const directory = join(root, "stage2-acceptance");
  mkdirSync(directory, { recursive: true });
  const artifact = {
    ...validRecoveryArtifact("resume", 1),
    pageChecks: [{
      page: "resume",
      checkpoint: "resume_verified",
      independentlyVerified: true,
      requiredFields: 1,
      verifiedFields: 1,
      duplicateRows: 0,
    }],
    browserLanes: ["resume", "profile"],
  } as const;
  writeFileSync(
    join(directory, "revision_0123456789abcdef.recovery.json"),
    `${JSON.stringify(artifact)}\n`,
    { mode: 0o600 },
  );
  try {
    const runtime = await createStage2PlaywrightLiveRuntimeBinding({
      browser: () => closedRecoveryBrowser("resume", ["resume", "profile"]),
      nextOperationId: operationIds(750),
      now: () => "2026-08-05T12:00:00.000Z",
    }).bind({
      owner: owner(root, "https://fixture.invalid/application-questions"),
      ownerBinding: {} as never,
      ownerSources: {} as never,
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);
    const pending = await runtime.recovery.pending(new AbortController().signal);
    assert.notEqual(pending, null);
    if (pending === null) throw new Error("combined recovery artifact missing");
    const recovered = await recoverBrowserInterruption(
      pending.dependencies,
      pending.input,
      new AbortController().signal,
    );
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    if (!recovered.ok || recovered.value.kind !== "resumed") {
      throw new Error("combined recovery did not resume");
    }
    const cursor = pending.resume(recovered.value.state);
    assert.equal(cursor.currentPage, "resume");
    assert.deepEqual(cursor.currentLanes, ["resume", "profile"]);
    assert.deepEqual(cursor.pageChecks.map(({ page }) => page), ["resume"]);
    assert.equal(await runtime.cleanup.close(new AbortController().signal, false), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery storage rejects a linked checkpoint directory before browser ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-linked-recovery-"));
  const outside = mkdtempSync(join(tmpdir(), "hunt-s2-linked-outside-"));
  const linked = join(root, "stage2-acceptance");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
  let browserCalls = 0;
  try {
    await assert.rejects(() => createStage2PlaywrightLiveRuntimeBinding({
      browser: () => {
        browserCalls += 1;
        throw new Error("browser must not be acquired");
      },
    }).bind({
      owner: owner(root, "https://fixture.invalid/application-questions"),
      ownerBinding: {} as never,
      ownerSources: {} as never,
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal));
    assert.equal(browserCalls, 0);
  } finally {
    if (existsSync(linked)) unlinkSync(linked);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

for (const mismatch of [
  "journeyId", "sourceRevision", "configSha256", "revisionId", "approvalId",
  "targetHandleId", "hostId", "tenantId", "postingId",
] as const) {
  test(`recovery ${mismatch} scope mismatch opens no browser`, async () => {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-scope-${mismatch}-`));
    const directory = join(root, "stage2-acceptance");
    mkdirSync(directory, { recursive: true });
    const artifact = validRecoveryArtifact();
    const scope = { ...artifact.scope, target: { ...artifact.scope.target } };
    if (mismatch === "journeyId") scope.journeyId = "journey_wrong_scope_0001";
    else if (mismatch === "sourceRevision") scope.sourceRevision = "f".repeat(40);
    else if (mismatch === "configSha256") scope.configSha256 = "b".repeat(64);
    else if (mismatch === "revisionId") scope.revisionId = "revision_wrong_scope_0001";
    else if (mismatch === "approvalId") scope.approvalId = "approval_wrong_scope_0001";
    else if (mismatch === "targetHandleId") scope.targetHandleId = "target_ref_wrong_scope_0001";
    else scope.target[mismatch] = `${mismatch.replace("Id", "")}_wrong_scope_0001`;
    writeFileSync(
      join(directory, "revision_0123456789abcdef.recovery.json"),
      `${JSON.stringify({ ...artifact, scope })}\n`,
      { mode: 0o600 },
    );
    let browserCalls = 0;
    try {
      await assert.rejects(() => createStage2PlaywrightLiveRuntimeBinding({
        browser: () => {
          browserCalls += 1;
          throw new Error("browser must not be acquired");
        },
      }).bind({
        owner: owner(root, "https://fixture.invalid/application-questions"),
        ownerBinding: {} as never,
        ownerSources: {} as never,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
        configSha256: "a".repeat(64),
      }, new AbortController().signal));
      assert.equal(browserCalls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const mismatch of [
  "journeyId", "sourceRevision", "hostId", "tenantId", "postingId",
] as const) {
  test(`recovery inner checkpoint ${mismatch} mismatch opens no browser`, async () => {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-inner-scope-${mismatch}-`));
    const directory = join(root, "stage2-acceptance");
    mkdirSync(directory, { recursive: true });
    const artifact = validRecoveryArtifact();
    const checkpoint = {
      ...artifact.checkpoint,
      target: { ...artifact.checkpoint.target },
    };
    if (mismatch === "journeyId") checkpoint.journeyId = "journey_wrong_inner_0001";
    else if (mismatch === "sourceRevision") checkpoint.sourceRevision = "revision_wrong_inner_0001";
    else checkpoint.target[mismatch] = `${mismatch.replace("Id", "")}_wrong_inner_0001`;
    writeFileSync(
      join(directory, "revision_0123456789abcdef.recovery.json"),
      `${JSON.stringify({ ...artifact, checkpoint })}\n`,
      { mode: 0o600 },
    );
    let browserCalls = 0;
    let openCalls = 0;
    try {
      await assert.rejects(() => createStage2PlaywrightLiveRuntimeBinding({
        browser: () => {
          browserCalls += 1;
          const browser = closedRecoveryBrowser("resume");
          return {
            ...browser,
            async open(...args: Parameters<typeof browser.open>) {
              openCalls += 1;
              return browser.open(...args);
            },
          };
        },
      }).bind({
        owner: owner(root, "https://fixture.invalid/application-questions"),
        ownerBinding: {} as never,
        ownerSources: {} as never,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
        configSha256: "a".repeat(64),
      }, new AbortController().signal));
      assert.equal(browserCalls, 0);
      assert.equal(openCalls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [name, contents] of [
  ["empty", Buffer.alloc(0)],
  ["malformed", Buffer.from("{not-json")],
  ["oversized", Buffer.alloc(64 * 1024 + 1, 0x61)],
] as const) {
  test(`${name} recovery state fails closed before browser ownership`, async () => {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-${name}-recovery-`));
    const directory = join(root, "stage2-acceptance");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "revision_0123456789abcdef.recovery.json"),
      contents,
      { mode: 0o600 },
    );
    let browserCalls = 0;
    try {
      await assert.rejects(() => createStage2PlaywrightLiveRuntimeBinding({
        browser: () => {
          browserCalls += 1;
          throw new Error("browser must not be acquired");
        },
      }).bind({
        owner: owner(root, "https://fixture.invalid/application-questions"),
        ownerBinding: {} as never,
        ownerSources: {} as never,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
        configSha256: "a".repeat(64),
      }, new AbortController().signal));
      assert.equal(browserCalls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const orphan of ["reconciliation", "partial"] as const) {
  test(`orphan ${orphan} recovery state fails closed before browser ownership`, async () => {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-orphan-${orphan}-`));
    const directory = join(root, "stage2-acceptance");
    mkdirSync(directory, { recursive: true });
    const base = "revision_0123456789abcdef.recovery.json";
    writeFileSync(
      join(directory, orphan === "reconciliation" ? `${base}.reconciliation` : `${base}.deadbeef.tmp`),
      "{}\n",
      { mode: 0o600 },
    );
    let browserCalls = 0;
    try {
      await assert.rejects(() => createStage2PlaywrightLiveRuntimeBinding({
        browser: () => {
          browserCalls += 1;
          throw new Error("browser must not be acquired");
        },
      }).bind({
        owner: owner(root, "https://fixture.invalid/application-questions"),
        ownerBinding: {} as never,
        ownerSources: {} as never,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
        configSha256: "a".repeat(64),
      }, new AbortController().signal));
      assert.equal(browserCalls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  "terminal_accepted",
  "suspend",
  "close_default",
  "cleanup_failure",
  "cleanup_exception",
  "mutation_exception",
  "failed_open",
  "factory_exception",
] as const) {
  test(`production binding releases owner sources after ${scenario.replaceAll("_", " ")}`, async () => {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-lifecycle-${scenario}-`));
    try {
      await proveOwnerSourcesReleased(root, scenario);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("production retention captures one fresh authority decision and releases its owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-retention-authority-"));
  let nowCalls = 0;
  let retained = false;
  let releaseCalls = 0;
  const base = closedRecoveryBrowser("profile");
  const browser = {
    ...base,
    async [retainOwnedApplicationSession]() {
      retained = true;
      return { ok: true as const, value: undefined };
    },
    async [releaseOwnedApplicationSession]() {
      releaseCalls += 1;
      retained = false;
      return { ok: true as const, value: undefined };
    },
  };
  try {
    const approvedOwner = authorizedOwner(root) as {
      approval: { expiresAt: string };
    };
    approvedOwner.approval.expiresAt = "2026-08-06T11:00:00.000Z";
    const runtime = await createStage2PlaywrightLiveRuntimeBinding({
      browser: () => browser,
      now: () => {
        nowCalls += 1;
        return "2026-08-05T12:00:00.000Z";
      },
      nextOperationId: operationIds(950),
    }).bind({
      owner: approvedOwner as never,
      ownerBinding: {} as never,
      ownerSources: { sensitiveValues: [] } as never,
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);
    assert.equal(await runtime.cleanup.preserve!(new AbortController().signal), true);
    assert.equal(nowCalls, 1);
    assert.equal(retained, true);
    assert.equal(
      runtime.cleanup.retentionExpiresAt?.(),
      "2026-08-06T11:00:00.000Z",
    );
    assert.equal(await runtime.cleanup.release!(new AbortController().signal), true);
    assert.equal(releaseCalls, 1);
    assert.equal(retained, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production retention rejects expired authority before the retain owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-retention-expiry-"));
  let retainCalls = 0;
  const base = closedRecoveryBrowser("profile");
  const browser = {
    ...base,
    async [retainOwnedApplicationSession]() {
      retainCalls += 1;
      return { ok: true as const, value: undefined };
    },
  };
  try {
    const runtime = await createStage2PlaywrightLiveRuntimeBinding({
      browser: () => browser,
      now: () => "2026-08-06T12:00:01.000Z",
      nextOperationId: operationIds(960),
    }).bind({
      owner: authorizedOwner(root),
      ownerBinding: {} as never,
      ownerSources: { sensitiveValues: [] } as never,
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);
    assert.equal(await runtime.cleanup.preserve!(new AbortController().signal), false);
    assert.equal(retainCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class FixtureProfiles {
  marker: unknown;

  async read(): Promise<unknown> { return this.marker; }
  async write(_path: string, marker: unknown): Promise<void> { this.marker = marker; }
  async cleanup(): Promise<void> { this.marker = undefined; }
  async cleanupPartial(): Promise<void> { this.marker = undefined; }
}

function ownedMatchedFixture() {
  return {
    ownership: "owned" as const,
    target: { kind: "matched" as const },
    snapshot: {
      schemaVersion: 1 as const,
      traitIds: Object.freeze([]),
      controlCount: 1,
      requiredControlCount: 0,
      optionCount: 0,
    },
  };
}

function redirectingContext(context: BrowserContext, destination: string): PersistentContext {
  const wrapped = new WeakMap<Page, PersistentPage>();
  const pageFor = (page: Page): PersistentPage => {
    const existing = wrapped.get(page);
    if (existing !== undefined) return existing;
    const proxy = new Proxy(page, {
      get(target, property) {
        if (property === "goto") {
          return (_ignored: string, options?: { readonly waitUntil?: "commit" | "domcontentloaded" }) =>
            target.goto(destination, options);
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as PersistentPage;
    wrapped.set(page, proxy);
    return proxy;
  };
  return {
    pages: () => context.pages().map(pageFor),
    newPage: async () => pageFor(await context.newPage()),
    close: () => context.close(),
  };
}

const approvedFixtureTargetUrl =
  "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345";

function validRecoveryArtifact(
  page: "resume" | "profile" | "questionnaire" | "pre_review" = "profile",
  checkCount = 1,
) {
  const target = {
    schemaVersion: 1,
    atsFamily: "workday",
    hostId: "host_0123456789abcdef",
    tenantId: "tenant_0123456789abcdef",
    postingId: "posting_0123456789abcdef",
  };
  return {
    schemaVersion: 1,
    scope: {
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
      revisionId: "revision_0123456789abcdef",
      approvalId: "approval_0123456789abcdef",
      journeyId: "journey_runtime_fixture_01",
      targetHandleId: "target_ref_0123456789abcdef",
      target,
    },
    checkpoint: {
      schemaVersion: 1,
      journeyId: "journey_runtime_fixture_01",
      sourceRevision: "revision_0123456789abcdef",
      revision: 1,
      target,
      page: {
        id: `page-${page.replace("_", "-")}`,
        kind: page === "pre_review" ? "review" : page,
      },
      verification: "verified",
      terminal: null,
    },
    pageChecks: ["profile", "resume", "questionnaire"].slice(0, checkCount).map((checked) => ({
      page: checked,
      checkpoint: `${checked}_verified`,
      independentlyVerified: true,
      requiredFields: 1,
      verifiedFields: 1,
      duplicateRows: 0,
    })),
    reviewExpected: [],
    browserLanes: page === "pre_review" ? [] : [page],
  };
}

function operationIds(seed: number) {
  let value = seed;
  return () => generatedOperationId(`operation_${(++value).toString().padStart(16, "0")}`);
}

function equalValueReviewDocument(): string {
  return `<!doctype html>
  <html data-hunt-page-id="page-pre-review" data-hunt-submit-activated="false">
    <body data-hunt-application-page="pre_review">
      <div data-automation-id="progressBarActiveStep">Review</div>
      <main data-automation-id="applyFlowReviewPage">
        <section data-automation-id="formField-identity.given_name"><span>First</span><span>resume.pdf</span></section>
        <section data-automation-id="formField-address.line_1"><span>Second</span><span>resume.pdf</span></section>
        <button id="final-submit">Submit application</button>
      </main>
      <script>
        window.submitActivations = 0;
        document.querySelector('#final-submit').addEventListener('click', () => { window.submitActivations += 1; });
      </script>
    </body>
  </html>`;
}

function closedRecoveryBrowser(
  page: "resume" | "profile" | "questionnaire" | "pre_review",
  lanes?: readonly ("resume" | "profile" | "questionnaire")[],
) {
  const target = validRecoveryArtifact().scope.target as never;
  const session: LiveBrowserSessionV1 = {
    schemaVersion: 1,
    journeyId: journeyId("journey_runtime_fixture_01"),
    sessionId: "live_session_runtime_fixture_01" as LiveSessionId,
    profileLeaseId: "profile_lease_runtime_fixture_01" as ProfileLeaseId,
    target,
    leaseExpiresAt: "2026-08-06T12:00:00.000Z",
  };
  return {
    async open() {
      return { ok: true as const, value: { kind: "opened" as const, session } };
    },
    async reconcile() {
      return { ok: true as const, value: { kind: "matched" as const, session } };
    },
    async close() {
      return { ok: true as const, value: undefined };
    },
    async [suspendOwnedApplicationSession]() {
      return { ok: true as const, value: undefined };
    },
    async [ownedApplicationPageAccess](
      _request: unknown,
      operation: OwnedApplicationOperation,
    ) {
      if (operation.kind === "inspect_recovery") {
        return { ok: true as const, value: {
          ok: true as const,
          value: {
            page,
            ...(lanes === undefined ? {} : { lanes }),
            pageId: `page-${page.replace("_", "-")}`,
            requiredFields: [],
            c3OwnedDuplicateRows: 0,
            submitActivated: false,
          },
        } };
      }
      if (operation.kind === "reload") {
        return { ok: true as const, value: undefined };
      }
      return {
        ok: false as const,
        error: { code: "browser_target_invalid" as const, retryable: false as const },
      };
    },
  };
}

type LifecycleScenario =
  | "terminal_accepted"
  | "suspend"
  | "close_default"
  | "cleanup_failure"
  | "cleanup_exception"
  | "mutation_exception"
  | "failed_open"
  | "factory_exception";

async function proveOwnerSourcesReleased(
  root: string,
  scenario: LifecycleScenario,
): Promise<void> {
  let ownerSources: object | undefined = { sensitiveValues: ["private-owner-value"] };
  const reference = new WeakRef(ownerSources);
  const browser = lifecycleBrowser(scenario);
  let runtime: Awaited<ReturnType<ReturnType<typeof createStage2PlaywrightLiveRuntimeBinding>["bind"]>> |
    undefined;
  try {
    runtime = await createStage2PlaywrightLiveRuntimeBinding({
      browser: scenario === "factory_exception"
        ? () => { throw new Error("synthetic factory exception"); }
        : () => browser,
      now: () => "2026-08-05T12:00:00.000Z",
      nextOperationId: operationIds(900),
      timeoutMs: 100,
    }).bind({
      owner: owner(root, "https://fixture.invalid/application-questions"),
      ownerBinding: {} as never,
      ownerSources: ownerSources as never,
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);
  } catch (error) {
    if (scenario !== "failed_open" && scenario !== "factory_exception") throw error;
  } finally {
    ownerSources = undefined;
  }

  if (scenario === "failed_open" || scenario === "factory_exception") {
    assert.equal(runtime, undefined);
  } else {
    assert.notEqual(runtime, undefined);
    if (runtime === undefined) return;
    if (scenario === "terminal_accepted") {
      assert.equal(await runtime.cleanup.close(new AbortController().signal, true), true);
    } else if (scenario === "suspend") {
      assert.equal(await runtime.cleanup.close(new AbortController().signal, false), true);
    } else if (scenario === "close_default") {
      assert.equal(await runtime.cleanup.close(new AbortController().signal), true);
    } else if (scenario === "cleanup_failure") {
      assert.equal(await runtime.cleanup.close(new AbortController().signal), false);
    } else if (scenario === "cleanup_exception") {
      await assert.rejects(() => runtime!.cleanup.close(new AbortController().signal));
    } else {
      await assert.rejects(() => runtime!.walk.navigation.next({
        journeyId: journeyId("journey_runtime_fixture_01"),
        from: "resume",
        fromPageId: "page-resume" as never,
        allowed: ["profile", "questionnaire", "pre_review"],
      }, new AbortController().signal));
      assert.equal(await runtime.cleanup.close(new AbortController().signal), true);
    }
  }

  await assertCollected(reference);
  if (runtime !== undefined) assert.equal(typeof runtime.cleanup.close, "function");
}

function lifecycleBrowser(scenario: LifecycleScenario) {
  const browser = closedRecoveryBrowser("resume");
  return {
    ...browser,
    async open(...args: Parameters<typeof browser.open>) {
      if (scenario === "failed_open") {
        return {
          ok: false as const,
          error: { code: "browser_session_missing" as const, retryable: false as const },
        };
      }
      return browser.open(...args);
    },
    async close(...args: Parameters<typeof browser.close>) {
      if (scenario === "cleanup_failure") {
        return {
          ok: false as const,
          error: { code: "browser_profile_cleanup_failed" as const, retryable: false as const },
        };
      }
      if (scenario === "cleanup_exception") throw new Error("synthetic cleanup exception");
      return browser.close(...args);
    },
    async [ownedApplicationPageAccess](
      request: unknown,
      operation: OwnedApplicationOperation,
    ) {
      if (scenario === "mutation_exception" && operation.kind === "next") {
        throw new Error("synthetic mutation exception");
      }
      return browser[ownedApplicationPageAccess](request, operation);
    },
  };
}

setFlagsFromString("--expose-gc");
const forceGarbageCollection = runInNewContext("gc") as () => void;

async function assertCollected(reference: WeakRef<object>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    forceGarbageCollection();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (reference.deref() === undefined) return;
  }
  assert.equal(reference.deref(), undefined, "returned runtime retained owner sources");
}

function owner(root: string, url: string) {
  mkdirSync(join(root, "evidence"), { recursive: true });
  return {
    journeyId: "journey_runtime_fixture_01",
    revisionId: "revision_0123456789abcdef",
    approval: { approvalId: "approval_0123456789abcdef" },
    profileRef: "profile_ref_0123456789abcdef",
    target: {
      handleId: "target_ref_0123456789abcdef",
      url,
      host: "127.0.0.1",
      tenant: "fixture",
      posting: "fixture-posting",
    },
    roots: {
      runtime: { path: root },
      secrets: { path: join(root, "secrets") },
      evidence: { path: join(root, "evidence") },
    },
  } as never;
}

function authorizedOwner(root: string) {
  const value = owner(
    root,
    "https://fixture.invalid/application-questions",
  ) as unknown as {
    target: { tenant: string; posting: string };
    approval: { expiresAt: string };
  };
  value.target.tenant = "private-tenant";
  value.target.posting = "private-posting";
  value.approval.expiresAt = "2026-08-06T12:00:00.000Z";
  return value as never;
}

function accountSessionProof(
  sourceRevision: string,
  configSha256: string,
  session: LiveBrowserSessionV1,
) {
  return Object.freeze({
    schemaVersion: 1 as const,
    proofRevision: "s2-account-session-proof-v1" as const,
    status: "unsealed" as const,
    sourceRevision,
    configSha256,
    revisionId: "revision_0123456789abcdef",
    approvalId: "approval_0123456789abcdef",
    journeyId: session.journeyId,
    targetHandleId: "target_ref_0123456789abcdef",
    accountState: "application_ready" as const,
    independentlyObservedVerifiedState: true as const,
    verificationProof: "credential_sign_in" as const,
    provider: "workday-auth" as const,
    consumedCandidateCount: 0 as const,
    messageBodyRetained: false as const,
    submitActivated: false as const,
  });
}

function resumeArtifact() {
  const bytes = Buffer.from("%PDF-1.7\nfixture resume\n%%EOF\n");
  const captured = captureResumeArtifact({
    resumeId: upstreamResumeId("resume-runtime-fixture"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }, bytes);
  if (!captured.ok) throw new Error("resume capture failed");
  return captured.value;
}

function fixtureDocument(): string {
  return `<!doctype html>
  <html data-hunt-page-id="page-profile" data-hunt-submit-activated="false">
    <body data-hunt-application-page="profile">
      <script>
        window.submitActivations = 0;
        const render = (kind) => {
          document.body.setAttribute('data-hunt-application-page', kind);
          document.documentElement.setAttribute('data-hunt-page-id', 'page-' + kind.replace('_', '-'));
          if (kind === 'resume') {
            document.body.innerHTML = '<main data-automation-id="applyFlowMyInfoPage"><label>Resume<input required data-hunt-field-id="resume-required" type="file" data-automation-id="file-upload-input-ref"></label><button>Next</button></main>';
            document.querySelector('input').addEventListener('change', () => {
              const item = document.createElement('div');
              item.setAttribute('data-automation-id', 'file-upload-item');
              item.setAttribute('data-upload-state', 'success');
              item.innerHTML = '<button data-automation-id="delete-file" aria-label="Delete resume">Delete</button>';
              document.querySelector('main').append(item);
            });
          } else if (kind === 'profile') {
            document.body.innerHTML = '<main data-automation-id="applyFlowMyInfoPage"><button>Next</button></main>';
          } else if (kind === 'questionnaire') {
            document.body.innerHTML = '<main data-automation-id="applyFlowApplicationQuestionsPage"><label>Brief interest statement<textarea required aria-label="Brief interest statement"></textarea></label><button>Next</button></main>';
          } else {
            document.body.innerHTML = '<div data-automation-id="progressBarActiveStep">Review</div><main data-automation-id="applyFlowReviewPage"><section data-hunt-review-field-id="s1-field-resume">resume.pdf</section><section data-hunt-review-field-id="s1-field-interest">Exact configured interest statement.</section><button id="final-submit">Submit application</button></main>';
            document.querySelector('#final-submit').addEventListener('click', () => { window.submitActivations += 1; document.documentElement.setAttribute('data-hunt-submit-activated', 'true'); });
          }
          const next = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Next');
          next?.addEventListener('click', () => render(kind === 'profile' ? 'resume' : kind === 'resume' ? 'questionnaire' : 'pre_review'));
        };
        render('profile');
      </script>
    </body>
  </html>`;
}
