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
      ["applyFlowMyExpPage", "profile", "My Experience"],
      ["applyFlowPrimaryQuestionsPage", "questionnaire", "Primary Questions"],
      ["applyFlowPrimaryQuestionnairePage", "questionnaire", "Primary Questionnaire"],
      ["applyFlowApplicationQuestionsPage", "questionnaire", "Application Questions"],
      ["applyFlowVoluntaryDisclosuresPage", "questionnaire", "Voluntary Disclosures"],
      ["applyFlowSelfIdentifyPage", "questionnaire", "Self Identify"],
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

test("observation treats nested Workday roots as components of one physical state", async () => {
  await withPage(async (page) => {
    const application = new PlaywrightWorkdayApplicationPage(page);
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage">
        <input type="file" required data-hunt-field-id="resume-artifact"
          data-automation-id="file-upload-input-ref">
        <section data-automation-id="applyFlowMyExperiencePage">
          <input required data-hunt-field-id="experience-company" value="ready">
        </section>
      </main>
    `);

    const observed = await application.observe(new AbortController().signal);
    assert.equal(observed.ok, true, JSON.stringify(observed));
    assert.equal(observed.ok && observed.value.page, "resume");
    assert.deepEqual(observed.ok && observed.value.lanes, ["resume", "profile"]);
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

test("navigation selects Workday Save and Continue from the sticky footer", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage">
        <label>First name Required <input value="Lane"></label>
      </main>
      <footer><button id="next">Save and Continue</button></footer>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          document.body.innerHTML = '<main data-automation-id="applyFlowMyExperiencePage"><label><input required value="ready"></label></main>';
        });
      </script>
    `);
    const result = await application(page).next(request("profile", ["profile"]), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
  });
});

test("navigation tolerates a bounded Workday loading page before the destination", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage"><input required value="ready"></main>
      <footer><button id="next">Save and Continue</button></footer>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          document.body.innerHTML = '<main data-automation-id="applyFlowLoadingPage"></main>';
          setTimeout(() => {
            document.body.innerHTML = '<main data-automation-id="applyFlowMyExpPage"><input required value="ready"></main>';
          }, 150);
        });
      </script>
    `);
    const adapter = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 50,
      navigationSettleTimeoutMs: 2_000,
    });
    const result = await adapter.next(request("profile", ["profile"]), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
  });
});

test("navigation waits for the sticky footer to remount before clicking", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage"><input required value="ready"></main>
      <footer id="footer"></footer>
      <script>
        setTimeout(() => {
          document.querySelector('#footer').innerHTML = '<button id="next">Save and Continue</button>';
          document.querySelector('#next').addEventListener('click', () => {
            document.body.innerHTML = '<main data-automation-id="applyFlowMyExpPage"><input required value="ready"></main>';
          });
        }, 150);
      </script>
    `);
    const adapter = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 50,
      navigationSettleTimeoutMs: 500,
    });
    const result = await adapter.next(request("profile", ["profile"]), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
  });
});

test("navigation keeps ownership through Workday's hidden-root loading composite", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main id="source" data-automation-id="applyFlowMyInfoPage">
        <input required value="ready">
      </main>
      <main id="loading" hidden style="height:10px" data-automation-id="applyFlowLoadingPage"></main>
      <footer><button id="next">Save and Continue</button></footer>
      <script>
        const nativeRects = Element.prototype.getClientRects;
        let scheduled = false;
        Element.prototype.getClientRects = function() {
          const value = nativeRects.call(this);
          if (!scheduled && this.id === 'source') {
            scheduled = true;
            queueMicrotask(() => {
              document.querySelector('#source').hidden = true;
              document.querySelector('#loading').hidden = false;
            });
          }
          return value;
        };
        document.querySelector('#next').addEventListener('click', () => {
          document.body.innerHTML = '<main data-automation-id="applyFlowMyExpPage"><input required value="ready"></main>';
        });
      </script>
    `);
    const result = await application(page).next(request("profile", ["profile"]), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
  });
});

test("navigation atomically activates the admitted sticky button that detaches on click", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main id="source" data-automation-id="applyFlowMyInfoPage">
        <input required value="ready">
      </main>
      <main id="loading" hidden style="height:10px" data-automation-id="applyFlowLoadingPage"></main>
      <footer id="footer"><button id="next">Save and Continue</button></footer>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          document.querySelector('#source').hidden = true;
          document.querySelector('#loading').hidden = false;
          document.querySelector('#footer').remove();
          setTimeout(() => {
            document.body.innerHTML = '<main data-automation-id="applyFlowMyExpPage"><input required value="ready"></main>';
          }, 100);
        });
      </script>
    `);
    const adapter = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 50,
      navigationSettleTimeoutMs: 500,
    });
    const result = await adapter.next(request("profile", ["profile"]), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
  });
});

test("navigation commits the focused Workday field before activating the sticky footer", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyExpPage">
        <input id="skills" value="">
      </main>
      <footer><button id="next">Save and Continue</button></footer>
      <script>
        let committed = false;
        document.querySelector('#skills').addEventListener('blur', () => { committed = true; });
        document.querySelector('#next').addEventListener('click', () => {
          if (!committed) return;
          document.body.innerHTML = '<main data-automation-id="applyFlowApplicationQuestionsPage"><input required value="ready"></main>';
        });
        document.querySelector('#skills').focus();
      </script>
    `);
    const result = await application(page).next(request("profile", ["questionnaire"]), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
  });
});

test("navigation uses a trusted gesture on the fixed admitted Workday button", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyExpPage">
        <input required value="ready">
      </main>
      <footer><button id="next">Save and Continue</button></footer>
      <script>
        document.querySelector('#next').addEventListener('click', (event) => {
          if (!event.isTrusted) return;
          document.body.innerHTML = '<main data-automation-id="applyFlowApplicationQuestionsPage"><input required value="ready"></main>';
        });
      </script>
    `);
    const result = await application(page).next(request("profile", ["questionnaire"]), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
  });
});

test("navigation retries one trusted gesture when Workday leaves the verified source unchanged", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage">
        <input required value="ready">
      </main>
      <footer><button id="next">Save and Continue</button></footer>
      <script>
        let clicks = 0;
        document.querySelector('#next').addEventListener('click', (event) => {
          if (!event.isTrusted || ++clicks < 2) return;
          document.body.innerHTML = '<main data-automation-id="applyFlowMyExpPage"><input required value="ready"></main>';
        });
      </script>
    `);
    const adapter = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 50,
      navigationSettleTimeoutMs: 500,
    });
    const result = await adapter.next(request("profile", ["profile"]), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
  });
});

test("navigation never activates a final Submit inserted during footer replacement", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage"><input required value="ready"></main>
      <footer><button id="next">Save and Continue</button></footer>
      <script>
        window.name = 'submit-untouched';
        document.querySelector('#next').addEventListener('click', () => {
          document.body.innerHTML = '<main data-automation-id="applyFlowReviewPage"><button id="submit">Submit Application</button></main>';
          document.querySelector('#submit').addEventListener('click', () => { window.name = 'submit-activated'; });
        });
      </script>
    `);
    const result = await application(page).next(request("profile", ["pre_review"]), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
    assert.equal(await page.evaluate(() => window.name), "submit-untouched");
  });
});

test("navigation reloads one owned loading stall and verifies the persisted destination", async () => {
  await withPage(async (page) => {
    await page.addInitScript(() => {
      if (window.name !== "saved-destination-experience") return;
      document.addEventListener("DOMContentLoaded", () => {
        document.body.innerHTML = '<main data-automation-id="applyFlowMyExpPage"><input required value="ready"></main>';
      });
    });
    await page.setContent(`
      <div data-automation-id="applyFlowPage">
        <main id="source" data-automation-id="applyFlowMyInfoPage">
          <input required value="ready">
        </main>
        <main id="loading" hidden style="height:10px" data-automation-id="applyFlowLoadingPage"></main>
        <footer><button id="next">Save and Continue</button></footer>
      </div>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          window.name = 'saved-destination-experience';
          document.querySelector('#source').remove();
          document.querySelector('#loading').hidden = false;
        });
      </script>
    `);
    const adapter = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 50,
      navigationSettleTimeoutMs: 150,
    });
    const result = await adapter.next(request("profile", ["profile"]), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
  });
});

test("navigation rejects a transient destination that falls back into loading", async () => {
  await withPage(async (page) => {
    await page.addInitScript(() => {
      if (window.name !== "saved-after-transient-experience") return;
      document.addEventListener("DOMContentLoaded", () => {
        document.body.innerHTML = '<main data-automation-id="applyFlowMyExpPage"><input required value="ready"></main>';
      });
    });
    await page.setContent(`
      <div data-automation-id="applyFlowPage">
        <main data-automation-id="applyFlowMyInfoPage"><input required value="ready"></main>
        <footer><button id="next">Save and Continue</button></footer>
      </div>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          window.name = 'saved-after-transient-experience';
          document.body.innerHTML = '<main data-automation-id="applyFlowMyExpPage"><input required value="ready"></main>';
          setTimeout(() => {
            document.body.innerHTML = '<div data-automation-id="applyFlowPage"><main data-automation-id="applyFlowLoadingPage"></main></div>';
          }, 300);
        });
      </script>
    `);
    const adapter = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 50,
      navigationSettleTimeoutMs: 1_500,
    });
    const result = await adapter.next(request("profile", ["profile"]), signal());
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, "browser_effect_uncertain");
  });
});

test("navigation waits through a delayed Workday fallback before accepting the destination", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <div data-automation-id="applyFlowPage">
        <main id="source" data-automation-id="applyFlowMyInfoPage"><input required value="ready"></main>
        <footer><button id="next">Save and Continue</button></footer>
      </div>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          document.querySelector('[data-automation-id="applyFlowPage"]').innerHTML =
            '<main data-automation-id="applyFlowMyExpPage"><input required value="ready"></main>';
          setTimeout(() => {
            document.querySelector('[data-automation-id="applyFlowPage"]').innerHTML =
              '<main data-automation-id="applyFlowLoadingPage"></main>';
          }, 1200);
          setTimeout(() => {
            document.querySelector('[data-automation-id="applyFlowPage"]').innerHTML =
              '<main data-automation-id="applyFlowMyExpPage"><input required value="ready"></main>';
          }, 1700);
        });
      </script>
    `);
    const adapter = new PlaywrightWorkdayApplicationPage(page, {
      timeoutMs: 50,
      navigationSettleTimeoutMs: 5_000,
    });
    const started = Date.now();
    const result = await adapter.next(request("profile", ["profile"]), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
    assert.ok(Date.now() - started >= 4_000);
  });
});

test("navigation rejects duplicate actionable sticky-footer controls", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage"><input required value="ready"></main>
      <footer><button>Save and Continue</button><button>Save and Continue</button></footer>
    `);
    const result = await application(page, 100).next(request("profile", ["profile"]), signal());
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, "navigation_uncertain");
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
    const result = await adapter.next(await questionnaireRequest(
      adapter,
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
          const main = document.querySelector('main');
          main.setAttribute('aria-busy', 'true');
          main.dataset.automationId = 'applyFlowSelfIdentifyPage';
          document.querySelector('[data-automation-id="progressBarActiveStep"]').textContent = 'Self Identify';
          document.querySelector('label').innerHTML = '<input required value="ready" data-hunt-field-id="self-identify">';
          main.setAttribute('aria-busy', 'false');
        });
      </script>
    `);
    const adapter = application(page);
    const result = await adapter.next(await questionnaireRequest(
      adapter,
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

test("same-selector questionnaire remount accepts the new active structural step", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowVoluntaryDisclosuresPage">
        <div data-automation-id="progressBarActiveStep">Voluntary Disclosures</div>
        <label>Gender <input required value="ready"></label>
        <label>Race <input required value="ready"></label>
        <button id="next">Save and Continue</button>
      </main>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          const destination = document.createElement('main');
          destination.dataset.automationId = 'applyFlowVoluntaryDisclosuresPage';
          destination.innerHTML = ` + "`" + `
            <div data-automation-id="progressBarActiveStep">Self Identify</div>
            <label>Name <input required value="ready" data-hunt-field-id="self-identify-name"></label>
            <button>Save and Continue</button>
          ` + "`" + `;
          document.querySelector('main').replaceWith(destination);
        });
      </script>
    `);
    const adapter = application(page);
    const result = await adapter.next(await questionnaireRequest(
      adapter,
      ["questionnaire", "pre_review"],
    ), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
    const observed = await adapter.observe(signal());
    assert.equal(
      observed.ok && observed.value.requiredFields[0]?.fieldId,
      "self-identify-name",
    );
  });
});

test("Self Identify counts composite date and exclusive disability status once", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowSelfIdentifyPage">
        <div data-automation-id="formField-dateSignedOn">
          <span data-automation-id="required">*</span>
          <div data-automation-id="dateSection" data-hunt-target-token="target-date">
            <input data-automation-id="dateSectionMonth" value="08">
            <input data-automation-id="dateSectionDay" value="16">
            <input data-automation-id="dateSectionYear" value="2026">
          </div>
        </div>
        <div data-automation-id="formField-disabilityStatus">
          <span data-automation-id="required">*</span>
          <div data-automation-id="disabilityStatus-CheckboxGroup"
            data-hunt-target-token="target-disability">
            <label><input type="checkbox">Yes</label>
            <label><input type="checkbox" checked>No</label>
            <label><input type="checkbox">Decline to self-identify</label>
          </div>
        </div>
      </main>
    `);
    const observed = await application(page).observe(signal());
    assert.equal(observed.ok, true, JSON.stringify(observed));
    assert.equal(observed.ok && observed.value.page, "questionnaire");
    assert.equal(observed.ok && observed.value.requiredFields.length, 2);
    assert.equal(
      observed.ok && observed.value.requiredFields.every(({ verification }) => verification === "verified"),
      true,
    );
  });
});

test("Self Identify reports value-free checkbox React handler structure", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowSelfIdentifyPage">
        <div data-automation-id="formField-disabilityStatus">
          <span data-automation-id="required">*</span>
          <div data-automation-id="disabilityStatus-CheckboxGroup"
            data-hunt-target-token="target-disability">
            <label><input type="checkbox" value="sensitive-option-value">First option</label>
            <label><input type="checkbox">Second option</label>
          </div>
        </div>
      </main>
      <script>
        const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
        Object.defineProperty(group, '__reactProps$fixture', {
          enumerable: true,
          value: {
            onBlur() {},
            onChange(event, checked) {},
            value: 'sensitive-option-value',
          },
        });
      </script>
    `);
    const previousTrace = process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE;
    const previousWrite = process.stderr.write;
    const writes: string[] = [];
    process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE = "1";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      const observed = await application(page).observe(signal());
      assert.equal(observed.ok, true, JSON.stringify(observed));
    } finally {
      process.stderr.write = previousWrite;
      if (previousTrace === undefined) delete process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE;
      else process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE = previousTrace;
    }
    const diagnostic = writes.find((line) => line.includes("applicationRequiredFieldDiagnostics"));
    assert.ok(diagnostic);
    assert.match(diagnostic, /"hostAutomationId":"disabilityStatus-CheckboxGroup"/u);
    assert.match(diagnostic, /"propsKeys":\["onBlur","onChange","value"\]/u);
    assert.match(diagnostic, /"name":"onBlur","arity":0/u);
    assert.match(diagnostic, /"name":"onChange","arity":2/u);
    assert.match(diagnostic, /"functionId":\d+/u);
    assert.match(diagnostic, /"objects":\[\]/u);
    assert.doesNotMatch(diagnostic, /sensitive-option-value|First option|Second option/u);
  });
});

test("Self Identify reports value-free formatted-date React handler structure", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowSelfIdentifyPage">
        <div data-automation-id="formField-dateSignedOn">
          <span data-automation-id="required">*</span>
          <label>Date <input type="tel" placeholder="MM/DD/YYYY"></label>
        </div>
      </main>
      <script>
        const input = document.querySelector('input');
        Object.defineProperty(input, '__reactProps$fixture', {
          enumerable: true,
          value: {
            onBlur() {},
            onChange(event) {},
            value: 'sensitive-date-value',
          },
        });
      </script>
    `);
    const previousTrace = process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE;
    const previousWrite = process.stderr.write;
    const writes: string[] = [];
    process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE = "1";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      const observed = await application(page).observe(signal());
      assert.equal(observed.ok, true, JSON.stringify(observed));
    } finally {
      process.stderr.write = previousWrite;
      if (previousTrace === undefined) delete process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE;
      else process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE = previousTrace;
    }
    const diagnostic = writes.find((line) => line.includes("applicationRequiredFieldDiagnostics"));
    assert.ok(diagnostic);
    assert.match(diagnostic, /"dateReactHandlerLayers"/u);
    assert.match(diagnostic, /"propsKeys":\["onBlur","onChange","value"\]/u);
    assert.match(diagnostic, /"name":"onBlur","arity":0/u);
    assert.match(diagnostic, /"name":"onChange","arity":1/u);
    assert.doesNotMatch(diagnostic, /sensitive-date-value/u);
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
    const adapter = application(page);
    const result = await adapter.next(await questionnaireRequest(
      adapter,
      ["questionnaire", "pre_review"],
    ), signal());
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, "page_incomplete");
  });
});

test("navigation does not compare required-field state across physical Workday pages", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage">
        <input required data-hunt-field-id="shared-field" value="ready">
        <button id="next">Next</button>
      </main>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          document.body.innerHTML = '<main data-automation-id="applyFlowMyExpPage"><input type="file" required data-automation-id="file-upload-input-ref" data-hunt-field-id="resume-file"><input required data-hunt-field-id="shared-field"></main>';
        });
      </script>
    `);
    const result = await application(page).next(request("profile", ["resume"]), signal());
    assert.deepEqual(result, { ok: true, value: { advanced: true } });
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
    const adapter = application(page, 100);
    const result = await adapter.next(await questionnaireRequest(
      adapter,
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
    const adapter = application(page, 100);
    const result = await adapter.next(await questionnaireRequest(
      adapter,
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

test("required Workday listbox buttons use non-placeholder visible text as verification", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage">
        <div data-automation-id="formField-region">
          <span data-automation-id="required"></span>
          <button id="region" aria-haspopup="listbox" aria-valuetext="Select One"
            data-selected-label="Alberta"></button>
        </div>
        <div data-automation-id="formField-device">
          <span data-automation-id="required"></span>
          <button id="device" aria-haspopup="listbox" data-selected-label="Select One"></button>
        </div>
      </main>
    `);
    const observed = await application(page).observe(signal());
    assert.deepEqual(observed.ok && observed.value.requiredFields, [
      { fieldId: "region", page: "profile", verification: "verified" },
      { fieldId: "device", page: "profile", verification: "unverified" },
    ]);
  });
});

test("a selected Workday None option is a committed value rather than a placeholder", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowVoluntaryDisclosuresPage">
        <div data-automation-id="formField-gender">
          <span data-automation-id="required"></span>
          <button id="gender" aria-haspopup="listbox" data-selected-label="None">None</button>
        </div>
        <div data-automation-id="formField-unanswered">
          <span data-automation-id="required"></span>
          <button id="unanswered" aria-haspopup="listbox">Select One</button>
        </div>
      </main>
    `);
    const observed = await application(page).observe(signal());
    assert.deepEqual(observed.ok && observed.value.requiredFields, [
      { fieldId: "gender", page: "questionnaire", verification: "verified" },
      { fieldId: "unanswered", page: "questionnaire", verification: "unverified" },
    ]);
  });
});

test("a filled Workday textarea ignores an uncorroborated stale aria-invalid flag", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField-conditional-detail">
          <span data-automation-id="required"></span>
          <textarea id="conditional-detail" required aria-invalid="true">Editable learning answer</textarea>
        </div>
      </main>
    `);
    const observed = await application(page).observe(signal());
    assert.deepEqual(observed.ok && observed.value.requiredFields, [{
      fieldId: "conditional-detail",
      page: "questionnaire",
      verification: "verified",
    }]);
  });
});

test("a filled Workday textarea remains unverified when a visible error corroborates aria-invalid", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowApplicationQuestionsPage">
        <div data-automation-id="formField-conditional-detail">
          <span data-automation-id="required"></span>
          <textarea id="conditional-detail" required aria-invalid="true" aria-errormessage="detail-error">Too long</textarea>
          <div id="detail-error" role="alert">Maximum length exceeded</div>
        </div>
      </main>
    `);
    const observed = await application(page).observe(signal());
    assert.deepEqual(observed.ok && observed.value.requiredFields, [{
      fieldId: "conditional-detail",
      page: "questionnaire",
      verification: "unverified",
    }]);
  });
});

test("required Workday radio groups and tokenized comboboxes verify their committed state", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage">
        <div id="previousWorker--candidateIsPreviousWorker" aria-required="true">
          <label><input hidden type="radio" name="previous" checked>No</label>
          <label><input hidden type="radio" name="previous">Yes</label>
        </div>
        <div data-automation-id="formField-country-phone-code">
          <div data-automation-id="country-phone-code-owner">
            <span data-automation-id="selectedItem">Canada (+1)</span>
            <input id="phoneNumber--countryPhoneCode" aria-required="true"
              data-selected-label="Canada (+1)">
          </div>
          <span data-automation-id="selectedItem">Unrelated outer token</span>
        </div>
      </main>
    `);
    const observed = await application(page).observe(signal());
    assert.deepEqual(observed.ok && observed.value.requiredFields, [
      {
        fieldId: "previousWorker--candidateIsPreviousWorker",
        page: "profile",
        verification: "verified",
      },
      {
        fieldId: "phoneNumber--countryPhoneCode",
        page: "profile",
        verification: "verified",
      },
    ]);
  });
});

test("a token presentation mirror cannot verify an empty controlled backing value", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <main data-automation-id="applyFlowMyInfoPage">
        <div data-automation-id="formField-country-phone-code">
          <div data-automation-id="country-phone-code-owner">
            <span data-automation-id="selectedItem">Canada (+1)</span>
            <input id="phoneNumber--countryPhoneCode" aria-required="true">
          </div>
        </div>
      </main>
    `);
    const observed = await application(page).observe(signal());
    assert.deepEqual(observed.ok && observed.value.requiredFields, [{
      fieldId: "phoneNumber--countryPhoneCode",
      page: "profile",
      verification: "unverified",
    }]);
  });
});

test("the physical My Information then My Experience lane sequence is valid", () => {
  assert.equal(isAllowedApplicationTransition("profile", "profile", ["profile"]), true);
  assert.equal(isValidApplicationPageSequence(["profile", "profile"]), true);
  assert.equal(isValidApplicationPageSequence(["profile", "profile", "profile"]), false);
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

async function questionnaireRequest(
  applicationPage: PlaywrightWorkdayApplicationPage,
  allowed: readonly ("profile" | "resume" | "questionnaire" | "pre_review")[],
) {
  const observed = await applicationPage.observe(signal());
  assert.equal(observed.ok, true, JSON.stringify(observed));
  if (!observed.ok) throw new Error("questionnaire observation failed");
  return {
    journeyId: testJourney,
    from: "questionnaire" as const,
    fromPageId: observed.value.pageId,
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
