import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium, type Locator } from "playwright";

import {
  PlaywrightWorkdayProfilePage,
  completeWorkdayProfilePage,
  type ProfileFieldPlan,
  type WorkdayProfilePagePort,
} from "../../../../src/ats/workday/application/profile/index.ts";
import { retainedProfileTextSha256 } from
  "../../../../src/ats/workday/application/profile/catalog.ts";
import { admitProfileFieldLearningEvidence, createProfileFieldLearningCapture } from
  "../../../../src/live/evidence/profile-field-learning.ts";
import { liveApplicationExecutionPolicy } from
  "../../../../src/contracts/application-execution-policy.ts";

const fixture = await readFile(
  new URL("./fixtures/profile-contact.html", import.meta.url),
  "utf8",
);

const field = (
  fieldId: string,
  questionType: ProfileFieldPlan["questionType"],
  answerType: ProfileFieldPlan["answerType"],
  value: string,
  visibleOption?: string,
): ProfileFieldPlan => ({
  fieldId,
  questionType,
  answerType,
  allowedOptions: visibleOption === undefined ? [] : [visibleOption],
  answer: {
    kind: "answered",
    value,
    provenance: "owner_provided",
    lane: "live_owner_fact",
  },
  ...(visibleOption === undefined
    ? {}
    : {
        optionMapping: {
          canonicalValue: value,
          visibleOption,
          provenance: "visible_option" as const,
        },
      }),
});

test("a highlighted source leaf without backing selection is never a commit", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <button type="button" role="combobox" aria-required="true"
            aria-controls="source-options" aria-expanded="false"
            data-automation-id="sourcePrompt">Select One</button>
          <div id="source-options" role="listbox" hidden>
            <div id="source-highlight" role="option"
              data-automation-id="promptLeafNode">Company Website</div>
          </div>
        </main>
        <script>
          const source = document.querySelector('[data-automation-id="sourcePrompt"]');
          const listbox = document.querySelector('#source-options');
          source.addEventListener('click', () => {
            listbox.hidden = false;
            source.setAttribute('aria-expanded', 'true');
          });
          document.querySelector('#source-highlight').addEventListener('click', event => {
            source.setAttribute('aria-activedescendant', event.currentTarget.id);
            source.setAttribute('aria-expanded', 'false');
            listbox.hidden = true;
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const source = (await adapter.inspect(AbortSignal.any([]))).controls.find(
      ({ fieldId }) => fieldId === "source.how_did_you_hear",
    )!;

    await assert.rejects(() => adapter.commit({
      controlId: source.controlId,
      uiBehavior: "search_select",
      value: "Company Website",
    }, AbortSignal.any([])), /backing value did not commit/u);
    assert.deepEqual(adapter.interaction(source.controlId), {
      popupBound: true,
      optionFocused: false,
      optionActivated: true,
      popupClosed: true,
      backingValueCommitted: false,
      validationCleared: true,
      visibleOptionCount: 1,
      selectedOptionOrdinal: 1,
    });
  } finally {
    await browser.close();
  }
});

test("real adapter and handler reconcile every profile section without owned duplicates", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(fixture.replace('data-automation-id="skillsSection"', 'data-automation-id="skillsSection" aria-required="true"'));
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const experience = [
      field("experience.company", "experience", "text", "Analytical Engines"),
      field("experience.title", "experience", "text", "Programmer"),
      field("experience.start_date", "experience", "date", "2021-03-01"),
    ];
    const portErrors: string[] = [];
    const result = await completeWorkdayProfilePage({
      mode: "live",
      pageType: "profile",
fields: [
        field("identity.given_name", "identity", "text", "Ada"),
        field("identity.family_name", "identity", "text", "Lovelace"),
        field("address.line1", "address", "text", "123 Example Street"),
        field("address.city", "address", "text", "Calgary"),
        field("address.country", "address", "option", "CA", "Canada"),
        field("address.postal_code", "address", "text", "T2P 1J9"),
        field("phone.country_code", "phone", "option", "CA-1", "Canada (+1)"),
        field("phone.number", "phone", "phone", "+1 555 0100"),
      ],
      repeatables: [
        { section: "experience", rows: [{ rowKey: "experience-1", fields: experience }] },
        { section: "education", rows: [{ rowKey: "education-1", fields: [
          field("education.school", "education", "text", "University of London"),
          field("education.degree", "education", "single_select", "mathematics", "Mathematics"),
          field("education.end_date", "education", "date", "1835-06-01"),
        ] }] },
        { section: "skills", rows: [{ rowKey: "skill-1", fields: [
          field("skills.name", "skill", "option", "typescript", "TypeScript"),
        ] }] },
      ],
    }, traced(adapter, portErrors), AbortSignal.any([]));

    assert.equal(result.kind, "verified", JSON.stringify({ result, portErrors }));
    if (result.kind === "verified") assert.equal(result.ownedDuplicateRows, 0);
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    assert.equal(snapshot.rows.some(({ rowId }) => rowId === "education-empty"), false);
    assert.equal(snapshot.rows.filter(({ section }) => section === "skills").length, 1);
    assert.equal(snapshot.rows.find(({ section }) => section === "skills")
      ?.controls[0]?.readback, "TypeScript");
  } finally {
    await browser.close();
  }
});

test("My Experience leaves a large optional owner skill set untouched", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyExperiencePage">
          <div data-automation-id="formField-skills">
            <input id="skills--skills" role="combobox" aria-controls="skills-options"
              aria-expanded="false" placeholder="Search">
            <div id="selected-skills"></div>
            <div id="skills-options" role="listbox" hidden><div role="option">Skill 01</div></div>
          </div>
        </main>
        <script>
          const input = document.getElementById("skills--skills");
          const listbox = document.getElementById("skills-options");
          input.addEventListener("click", () => {
            listbox.hidden = false;
            input.setAttribute("aria-expanded", "true");
          });
          listbox.addEventListener("click", (event) => {
            const option = event.target.closest('[role="option"]');
            if (!option) return;
            const pill = document.createElement("div");
            pill.setAttribute("data-automation-id", "selectedItem");
            pill.textContent = option.textContent;
            document.getElementById("selected-skills").append(pill);
            listbox.hidden = true;
            input.setAttribute("aria-expanded", "false");
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const options = JSON.stringify(Array.from({ length: 9 }, (_, index) =>
      `Skill ${String(index + 1).padStart(2, "0")}`
    ));
    const result = await completeWorkdayProfilePage({
      mode: "live",
      pageType: "profile",
      fields: [field("skills.values", "skill", "multi_select", options, options)],
      repeatables: [],
    }, adapter, AbortSignal.any([]));

    assert.equal(result.kind, "verified", JSON.stringify(result));
    if (result.kind !== "verified") return;
    assert.deepEqual(result.verifiedFields, []);
    assert.deepEqual(result.committedFields, []);
    assert.equal(await page.locator('#skills--skills').inputValue(), "");
    assert.equal(await page.locator('#skills-options').isVisible(), false);
    assert.deepEqual(
      await page.locator('[data-automation-id="selectedItem"]').allTextContents(),
      [],
    );
  } finally {
    await browser.close();
  }
});

test("a failed optional Workday multi-select search leaves no blocking draft text", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyExperiencePage">
          <div data-automation-id="formField-skills">
            <div data-automation-id="multiSelectContainer">
              <input id="skills--skills" placeholder="Search">
              <span data-automation-id="promptSearchButton"><svg></svg></span>
            </div>
            <div id="skills-error" role="alert" hidden>Choose a valid skill</div>
          </div>
        </main>
        <script>
          const skill = document.querySelector('#skills--skills');
          const error = document.querySelector('#skills-error');
          let resetArmed = false;
          skill.addEventListener('keydown', (event) => {
            if (['Enter', 'Tab', ','].includes(event.key)) {
              skill.setAttribute('aria-invalid', 'true');
              error.hidden = false;
            }
          });
          skill.addEventListener('input', () => {
            if (skill.value === ' ') resetArmed = true;
            if (resetArmed && skill.value === '') {
              skill.removeAttribute('aria-invalid');
              error.hidden = true;
            }
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, {
      pageType: "profile",
      timeoutMs: 100,
    });
    const control = (await adapter.inspect(AbortSignal.any([]))).controls.find(
      ({ fieldId }) => fieldId === "skills.values",
    )!;

    await assert.rejects(() => adapter.commit({
      controlId: control.controlId,
      uiBehavior: "multi_select",
      value: '["Unlisted Skill"]',
    }, AbortSignal.any([])));

    assert.equal(await page.locator('#skills--skills').inputValue(), "");
    assert.notEqual(await page.locator('#skills--skills').getAttribute('aria-invalid'), "true");
    assert.equal(await page.locator('#skills-error').isVisible(), false);
  } finally {
    await browser.close();
  }
});

function traced(
  port: WorkdayProfilePagePort,
  errors: string[],
): WorkdayProfilePagePort {
  return new Proxy(port, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      if (property === "interaction") return (...args: unknown[]) =>
        Reflect.apply(value, target, args);
      return async (...args: unknown[]) => {
        try {
          return await Reflect.apply(value, target, args);
        } catch (error) {
          errors.push(`${String(property)}:${error instanceof Error ? error.message : "unknown"}`);
          throw error;
        }
      };
    },
  });
}

test("school commit accepts exact saved value after a lost popup-close acknowledgement", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<main data-automation-id="applyFlowMyExpPage">
      <div data-automation-id="formField-school"><label>School or University*</label>
        <input id="education-1--school" aria-controls="school-options" required>
        <div id="school-options" role="listbox" hidden></div>
        <div id="selection"></div>
      </div>
    </main><script>
      const input = document.querySelector('input');
      const popup = document.getElementById('school-options');
      input.onclick = () => { popup.hidden = false; popup.innerHTML = '<div role="option">No items.</div>'; };
      input.onkeydown = event => {
        if (event.key === 'Escape') popup.hidden = true;
        if (event.key === 'Enter' && input.value === 'Other') setTimeout(() => {
          popup.hidden = false; popup.innerHTML = '<div role="option">Other</div>';
        }, 100);
      };
      popup.onclick = event => {
        if (event.target.textContent !== 'Other') throw new Error('status is not selectable');
        document.getElementById('selection').innerHTML = '<span data-automation-id="selectedItem"><span data-automation-id="promptOption">Other</span></span>';
        input.value = ''; popup.hidden = true;
      };
    </script>`);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile", inspectMissingOptions: true });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const school = snapshot.rows.flatMap(row => row.controls).find(control => control.fieldId === "education.school")!;
    assert.deepEqual(school.allowedOptions, ["Other"]);
    assert.equal(school.readback, null);
    const originalPress = page.keyboard.press.bind(page.keyboard);
    let faultInjected = false;
    page.keyboard.press = async (...args: Parameters<typeof page.keyboard.press>) => {
      await originalPress(...args);
      if (!faultInjected && args[0] === "Escape" && await page.locator('[data-automation-id="selectedItem"]').count() === 1) {
        faultInjected = true;
        throw new Error("Synthetic lost popup-close acknowledgement");
      }
    };
    await adapter.commit({ controlId: school.controlId, uiBehavior: "search_select", value: "Other" }, AbortSignal.any([]));
    assert.equal(faultInjected, true);
    assert.equal(adapter.interaction(school.controlId)?.backingValueCommitted, true);
    const observed = await adapter.observeControl(school.controlId, AbortSignal.any([]));
    assert.equal(observed.backingState, "set");
    assert.equal(await page.locator('#school-options').isVisible(), false);
  } finally { await browser.close(); }
});


test("native country initialization is reread without opening, while discovery mutations fail closed", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    for (const scenario of ["initialize_between_reads", "click_changes_selection"] as const) {
      await page.setContent(`<main data-automation-id="applyFlowMyInfoPage">
        <div data-automation-id="formField-country"><label for="country--country">Country</label>
          <button aria-required="true" type="button" id="country--country" name="country" aria-haspopup="listbox"
            aria-controls="countries" aria-expanded="false">Select One</button>
          <div id="countries" role="listbox" hidden><div role="option">Canada</div></div>
        </div></main><script>
          (() => { window.countryClicks = 0;
          const country = document.querySelector('button'), popup = document.querySelector('#countries');
          country.onclick = () => {
            window.countryClicks++;
            country.textContent = 'Canada'; country.setAttribute('aria-valuetext', 'Canada');
            popup.hidden = false; country.setAttribute('aria-expanded', 'true');
          };
          document.addEventListener('keydown', event => {
            if (event.key === 'Escape') { popup.hidden = true; country.setAttribute('aria-expanded', 'false'); }
          }); })();
        </script>`);
      let initialized = false;
      const wrap = (locator: Locator): Locator => new Proxy(locator, {
        get(target, property) {
          if (property === "locator") return (...args: Parameters<Locator["locator"]>) => wrap(target.locator(...args));
          if (property === "nth") return (index: number) => wrap(target.nth(index));
          if (property === "first") return () => wrap(target.first());
          if (property === "innerText") return async (...args: Parameters<Locator["innerText"]>) => {
            const value = await target.innerText(...args);
            if (scenario === "initialize_between_reads" && !initialized &&
                await target.getAttribute("id") === "country--country") {
              initialized = true;
              // Finish the original empty read, then deterministically publish the employer default.
              await target.evaluate(element => {
                element.textContent = "Canada"; element.setAttribute("aria-valuetext", "Canada");
              });
            }
            return value;
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const observedPage = new Proxy(page, {
        get(target, property) {
          if (property === "locator") return (...args: Parameters<typeof page.locator>) => wrap(target.locator(...args));
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const failures: string[] = [];
      const adapter = new PlaywrightWorkdayProfilePage(observedPage, {
        pageType: "profile", inspectMissingOptions: true, timeoutMs: 1000,
        trace: (event, details) => {
          if (event === "profile_option_observation_cleanup_failed" && details && "underlyingError" in details) {
            failures.push(String(details.underlyingError));
          }
        },
      });
      if (scenario === "initialize_between_reads") {
        const snapshot = await adapter.inspect(AbortSignal.any([]));
        const country = snapshot.controls.find(control => control.fieldId === "address.country");
        assert.equal(initialized, true);
        assert.equal(country?.readback, "Canada");
        assert.deepEqual(country?.allowedOptions, ["Canada"]);
        assert.equal(await page.evaluate(() => Reflect.get(window, "countryClicks")), 0);
        assert.deepEqual(failures, []);
      } else {
        await assert.rejects(adapter.inspect(AbortSignal.any([])));
        assert.equal(await page.evaluate(() => Reflect.get(window, "countryClicks")), 1);
        assert.deepEqual(failures, ["backing_state_changed"]);
      }
    }
  } finally { await browser.close(); }
});
