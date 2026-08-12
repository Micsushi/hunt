import assert from "node:assert/strict";
import test from "node:test";

import { chromium, type Browser, type Page } from "playwright";

import {
  PlaywrightWorkdayApplicationPage,
} from "../../../src/ats/workday/application/playwright-page.ts";
import {
  isAllowedApplicationTransition,
  isValidApplicationPageSequence,
} from "../../../src/ats/workday/application/page-walk-contract.ts";
import {
  browserPageId,
  journeyId,
} from "../../../src/contracts/index.ts";

const testJourney = journeyId("journey_navigation_fixture");

test("observes each exact Workday application root and rejects unknown roots", async () => {
  await withPage(async (page) => {
    const cases = [
      ["applyFlowMyInfoPage", "profile", "My Information"],
      ["applyFlowMyExperiencePage", "profile", "Experience"],
      ["applyFlowPrimaryQuestionsPage", "questionnaire", "Primary Questions"],
      ["applyFlowPrimaryQuestionnairePage", "questionnaire", "Primary Questionnaire"],
      ["applyFlowApplicationQuestionsPage", "questionnaire", "Application Questions"],
      ["applyFlowVoluntaryDisclosuresPage", "questionnaire", "Voluntary Disclosures"],
      ["applyFlowVoluntaryDisclosuresPage", "questionnaire", "Self Identify"],
      ["applyFlowReviewPage", "pre_review", "Review"],
    ] as const;
    const application = new PlaywrightWorkdayApplicationPage(page);
    for (const [root, expected, title] of cases) {
      await page.setContent(`
        <main data-automation-id="${root}">
          <div data-automation-id="progressBarActiveStep">${title}</div>
        </main>
      `);
      const result = await application.observe(new AbortController().signal);
      assert.equal(result.ok && result.value.page, expected, root);
    }

    await page.setContent('<main data-automation-id="applyFlowUnknownPage"></main>');
    const unknown = await application.observe(new AbortController().signal);
    assert.equal(unknown.ok, false);
    assert.equal(!unknown.ok && unknown.error.code, "browser_target_ambiguous");
  });
});

test("observation ignores hidden duplicate roots but rejects two visible roots", async () => {
  await withPage(async (page) => {
    const application = new PlaywrightWorkdayApplicationPage(page);
    await page.setContent(`
      <main hidden data-automation-id="applyFlowMyInfoPage"></main>
      <main data-automation-id="applyFlowMyExperiencePage"><input value="ready"></main>
    `);
    const oneVisible = await application.observe(new AbortController().signal);
    assert.equal(oneVisible.ok && oneVisible.value.page, "profile");

    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage"><input value="ready"></main>
      <main data-automation-id="applyFlowMyExperiencePage"><input value="ready"></main>
    `);
    const ambiguous = await application.observe(new AbortController().signal);
    assert.equal(ambiguous.ok, false);
    assert.equal(!ambiguous.ok && ambiguous.error.code, "browser_target_ambiguous");
  });
});

test("navigation selects the only visible enabled Next clone", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage">
        <label>First name Required <input value="Lane"></label>
        <button hidden>Next</button>
        <button disabled>Next</button>
        <button aria-disabled="true">Next</button>
        <button id="next">Next</button>
      </main>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          document.body.innerHTML = '<main data-automation-id="applyFlowApplicationQuestionsPage"><label><input type="radio" name="answer" required checked>Yes</label></main>';
        });
      </script>
    `);
    const result = await application(page).next(request("profile", ["questionnaire"]), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
  });
});

test("navigation rejects multiple actionable Next clones", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage">
        <input required value="ready">
        <button>Next</button><button>Next</button>
      </main>
    `);
    const result = await application(page, 100).next(request("profile", ["questionnaire"]), signal());
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, "navigation_uncertain");
  });
});

test("same-page conditional reveals remain admissible and independently observable", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <label><input type="radio" name="authorization" required checked>Yes</label>
        <button id="next">Next</button>
      </main>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          const label = document.createElement('label');
          label.textContent = 'Please explain Required ';
          const input = document.createElement('input');
          input.dataset.huntFieldId = 'authorization-explanation';
          label.append(input);
          document.querySelector('main').prepend(label);
        });
      </script>
    `);
    const adapter = application(page);
    const result = await adapter.next(request(
      "questionnaire",
      ["questionnaire", "pre_review"],
    ), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
    const revealed = await adapter.observe(signal());
    assert.deepEqual(revealed.ok && revealed.value.requiredFields.find(
      ({ fieldId }) => fieldId === "authorization-explanation",
    ), {
      fieldId: "authorization-explanation",
      page: "questionnaire",
      verification: "unverified",
    });
  });
});

test("repeated Voluntary Disclosures and Self Identify pages verify distinct transitions", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowVoluntaryDisclosuresPage">
        <div data-automation-id="progressBarActiveStep">Voluntary Disclosures</div>
        <label><input required value="ready"></label>
        <button id="next">Next</button>
      </main>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          document.querySelector('[data-automation-id="progressBarActiveStep"]').textContent = 'Self Identify';
          document.querySelector('label').innerHTML = '<input required value="ready" data-hunt-field-id="self-identify">';
        });
      </script>
    `);
    const adapter = application(page);
    const result = await adapter.next(request(
      "questionnaire",
      ["questionnaire", "pre_review"],
    ), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
    const observed = await adapter.observe(signal());
    assert.equal(observed.ok && observed.value.page, "questionnaire");
    assert.equal(
      observed.ok && observed.value.requiredFields[0]?.fieldId,
      "self-identify",
    );
  });
});

test("navigation reports a validation downgrade instead of claiming a transition", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <label>Answer Required <input id="answer" required value="ready"></label>
        <button id="next">Next</button>
      </main>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          document.querySelector('#answer').setAttribute('aria-invalid', 'true');
          document.querySelector('main').insertAdjacentHTML('beforeend', '<div role="alert" data-automation-id="inputAlert">Required</div>');
        });
      </script>
    `);
    const result = await application(page).next(request(
      "questionnaire",
      ["questionnaire", "pre_review"],
    ), signal());
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, "page_incomplete");
  });
});

test("hidden DOM churn is not accepted as transition evidence", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <input required value="ready">
        <button id="next">Next</button>
        <div id="hidden" hidden></div>
      </main>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          document.querySelector('#hidden').innerHTML = '<input data-automation-id="hidden-churn">';
        });
      </script>
    `);
    const result = await application(page, 100).next(request(
      "questionnaire",
      ["questionnaire", "pre_review"],
    ), signal());
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, "browser_effect_uncertain");
  });
});

test("visible optional churn is not accepted as semantic transition evidence", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <h2 id="heading">Application Questions</h2>
        <input required value="ready">
        <button id="next">Next</button>
      </main>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          document.querySelector('#heading').textContent = 'Updated Questions';
          document.querySelector('main').insertAdjacentHTML('afterbegin', '<input data-hunt-field-id="optional-churn">');
        });
      </script>
    `);
    const result = await application(page, 100).next(request(
      "questionnaire",
      ["questionnaire", "pre_review"],
    ), signal());
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, "browser_effect_uncertain");
  });
});

test("accessible Required markers and unknown required controls fail closed", async () => {
  await withPage(async (page) => {
    const adapter = application(page);
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage">
        <div data-automation-id="formField-given-name">
          <label>First name Required <input data-hunt-field-id="given-name"></label>
        </div>
        <div data-automation-id="formField-unknown">
          <span aria-label="Required"></span>
          <div role="slider" tabindex="0" data-hunt-field-id="unknown-required"></div>
        </div>
      </main>
    `);
    const observed = await adapter.observe(signal());
    assert.equal(observed.ok, true);
    assert.deepEqual(observed.ok && observed.value.requiredFields, [
      { fieldId: "given-name", page: "profile", verification: "unverified" },
      { fieldId: "unknown-required", page: "profile", verification: "unverified" },
    ]);
  });
});

test("My Experience composes resume upload with profile repeatables", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyExperiencePage">
        <label>Resume Required
          <input type="file" required data-automation-id="file-upload-input-ref" style="display:none"
            data-hunt-field-id="resume-file">
        </label>
        <section data-automation-id="workExperienceSection">
          <label>Company Required
            <input required data-hunt-field-id="experience-company" value="Acme">
          </label>
        </section>
      </main>
    `);
    const observed = await application(page).observe(signal());
    assert.equal(observed.ok && observed.value.page, "resume");
    assert.deepEqual(observed.ok && observed.value.lanes, ["resume", "profile"]);
    assert.deepEqual(observed.ok && observed.value.requiredFields, [
      { fieldId: "resume-file", page: "resume", verification: "unverified" },
      { fieldId: "experience-company", page: "profile", verification: "verified" },
    ]);
  });
});

test("accessible Not Required labels remain optional", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage">
        <label>Province or Territory Not Required
          <input aria-label="Province or Territory Not Required">
        </label>
      </main>
    `);
    const observed = await application(page).observe(signal());
    assert.deepEqual(observed.ok && observed.value.requiredFields, []);
  });
});

test("the physical My Information then My Experience lane sequence is valid", () => {
  assert.equal(isAllowedApplicationTransition("resume", "profile", ["profile", "resume"]), true);
  assert.equal(isValidApplicationPageSequence(["profile", "resume", "profile"]), true);
  assert.equal(isValidApplicationPageSequence(["profile", "resume", "profile", "resume"]), false);
});

function application(page: Page, timeoutMs = 1_000) {
  return new PlaywrightWorkdayApplicationPage(page, { timeoutMs });
}

function request(
  from: "profile" | "questionnaire",
  allowed: readonly ("profile" | "resume" | "questionnaire" | "pre_review")[],
) {
  return {
    journeyId: testJourney,
    from,
    fromPageId: browserPageId(`s2-${from}`),
    allowed,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await run(page);
  } finally {
    await browser?.close();
  }
}
