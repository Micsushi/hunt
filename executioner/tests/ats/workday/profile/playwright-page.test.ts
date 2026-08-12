import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { chromium } from "playwright";

import {
  PlaywrightWorkdayProfilePage,
  completeWorkdayProfilePage,
  type ProfileFieldPlan,
  type WorkdayProfilePagePort,
} from "../../../../src/ats/workday/application/profile/index.ts";

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
  answer: { kind: "answered", value, provenance: "owner_provided" },
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

test("Playwright adapter owns repeatables on the My Experience root", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyExperiencePage">
          <section data-automation-id="workExperienceSection">
            <div data-row-id="experience-1">
              <label>Company<input data-automation-id="workExperience-1--company"
                value="Analytical Engines"></label>
            </div>
          </section>
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    assert.equal(snapshot.rows[0]?.section, "experience");
    assert.equal(snapshot.rows[0]?.controls[0]?.fieldId, "experience.company");
    assert.equal(snapshot.rows[0]?.controls[0]?.readback, "Analytical Engines");
  } finally {
    await browser.close();
  }
});

test("Playwright adapter proves reviewed text, phone, date, and active-listbox variants", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(fixture);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const initial = await adapter.inspect(AbortSignal.any([]));
    const byField = new Map(initial.controls.map((item) => [item.fieldId, item]));
    assert.equal(byField.get("identity.given_name")?.uiBehavior, "text");
    assert.equal(byField.get("address.country")?.uiVariant, "workday_search_select_v1");
    assert.equal(byField.get("phone.number")?.uiBehavior, "phone");
    assert.equal(initial.rows.find(({ section }) => section === "experience")
      ?.controls.find(({ fieldId }) => fieldId === "experience.start_date")
      ?.uiBehavior, "date");

    await adapter.commit({
      controlId: byField.get("identity.given_name")!.controlId,
      uiBehavior: "text",
      value: "Ada",
    }, AbortSignal.any([]));
    await adapter.commit({
      controlId: byField.get("address.country")!.controlId,
      uiBehavior: "search_select",
      value: "Canada",
    }, AbortSignal.any([]));
    await adapter.commit({
      controlId: byField.get("phone.number")!.controlId,
      uiBehavior: "phone",
      value: "+1 555 0100",
    }, AbortSignal.any([]));

    const actual = await adapter.inspect(AbortSignal.any([]));
    const committed = new Map(actual.controls.map((item) => [item.fieldId, item.readback]));
    assert.equal(committed.get("identity.given_name"), "Ada");
    assert.equal(committed.get("address.country"), "Canada");
    assert.equal(committed.get("phone.number"), "+1 555 0100");
  } finally {
    await browser.close();
  }
});

test("v2 semantic ids bind exact profile controls and accessible required wording", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <button id="country--country" name="country" aria-haspopup="listbox"
            aria-label="Country Canada Required" aria-valuetext="Canada">Canada</button>
          <label>First Name*<input id="name--legalName--firstName"
            name="legalName--firstName" required></label>
          <label>Last Name*<input id="name--legalName--lastName"
            name="legalName--lastName" required></label>
          <label><input id="name--preferredCheck" name="preferredCheck"
            type="checkbox">I have a preferred name</label>
          <label>Address Line 1<input id="address--addressLine1" name="addressLine1"></label>
          <label>City<input id="address--city" name="city"></label>
          <button id="address--countryRegion" name="countryRegion" aria-haspopup="listbox"
            aria-label="Province or Territory Not Required">Select One</button>
          <label>Postal Code<input id="address--postalCode" name="postalCode"></label>
          <label>Email*<input id="emailAddress--emailAddress" required></label>
          <button id="phoneNumber--phoneType" name="phoneType" aria-haspopup="listbox"
            aria-label="Phone Device Type Mobile Required" aria-valuetext="Mobile">Mobile</button>
          <label>Country Phone Code*<input id="phoneNumber--countryPhoneCode" required></label>
          <label>Phone Number*<input id="phoneNumber--phoneNumber"
            name="phoneNumber" required></label>
          <label>Phone Extension<input id="phoneNumber--extension" name="extension"></label>
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const controls = new Map(snapshot.controls.map((control) => [control.fieldId, control]));

    assert.deepEqual([...controls.keys()], [
      "identity.given_name",
      "identity.family_name",
      "identity.has_preferred_name",
      "address.line1",
      "address.city",
      "address.country",
      "address.region",
      "address.postal_code",
      "contact.email",
      "phone.device_type",
      "phone.country_code",
      "phone.number",
      "phone.extension",
    ]);
    assert.equal(controls.get("address.country")?.required, true);
    assert.equal(controls.get("address.country")?.readback, "Canada");
    assert.equal(controls.get("address.region")?.required, false);
    assert.equal(controls.get("contact.email")?.required, true);
    assert.equal(controls.get("phone.device_type")?.required, true);
    assert.equal(controls.get("phone.number")?.uiBehavior, "phone");

    await adapter.commit({
      controlId: controls.get("identity.given_name")!.controlId,
      uiBehavior: "text",
      value: "Ada",
    }, AbortSignal.any([]));
    await adapter.commit({
      controlId: controls.get("phone.country_code")!.controlId,
      uiBehavior: "text",
      value: "+1",
    }, AbortSignal.any([]));
    await adapter.commit({
      controlId: controls.get("phone.number")!.controlId,
      uiBehavior: "phone",
      value: "5550100",
    }, AbortSignal.any([]));

    const readback = new Map((await adapter.inspect(AbortSignal.any([]))).controls
      .map((control) => [control.fieldId, control.readback]));
    assert.equal(readback.get("identity.given_name"), "Ada");
    assert.equal(readback.get("phone.country_code"), "+1");
    assert.equal(readback.get("phone.number"), "5550100");
  } finally {
    await browser.close();
  }
});

test("search-select refuses an unrelated visible listbox without an ownership link", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <input role="combobox" data-automation-id="addressSection_countryRegion">
          <div role="listbox"><div role="option">Canada</div></div>
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const country = snapshot.controls.find(({ fieldId }) => fieldId === "address.country")!;

    await assert.rejects(
      adapter.commit({
        controlId: country.controlId,
        uiBehavior: "search_select",
        value: "Canada",
      }, AbortSignal.any([])),
      /listbox ownership/iu,
    );
  } finally {
    await browser.close();
  }
});

test("exact owner inputs commit the reviewed source button leaf and previous-worker radio", async () => {
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
            <div role="option" data-automation-id="promptCategory">Company Website</div>
            <div role="option" data-automation-id="promptLeafNode"
              data-value="company-website">Company Website</div>
          </div>
          <fieldset role="radiogroup" aria-required="true">
            <legend>Have you previously worked for the organization?</legend>
            <input id="previous-yes" type="radio"
              name="candidateIsPreviousWorker" value="true"><label for="previous-yes">Yes</label>
            <input id="previous-no" type="radio"
              name="candidateIsPreviousWorker" value="false"><label for="previous-no">No</label>
          </fieldset>
        </main>
        <script>
          const source = document.querySelector('[data-automation-id="sourcePrompt"]');
          const listbox = document.querySelector('#source-options');
          source.addEventListener('click', () => {
            listbox.hidden = false;
            source.setAttribute('aria-expanded', 'true');
          });
          document.querySelector('[data-automation-id="promptLeafNode"]')
            .addEventListener('click', event => {
              source.setAttribute('data-selected-label', event.currentTarget.textContent.trim());
              source.setAttribute('aria-expanded', 'false');
              listbox.hidden = true;
            });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const before = await adapter.inspect(AbortSignal.any([]));
    const source = before.controls.find(
      ({ fieldId }) => fieldId === "source.how_did_you_hear",
    )!;
    const previousWorker = before.controls.find(
      ({ fieldId }) => fieldId === "employment.previously_worked_for_organization",
    )!;
    assert.equal(previousWorker.required, true);
    assert.equal(before.controls.some(({ fieldId }) => fieldId.startsWith("unknown.")), false);

    const result = await completeWorkdayProfilePage({
      pageType: "profile",
      fields: [
        field(
          "source.how_did_you_hear",
          "application_source",
          "option",
          "company-website",
          "Company Website",
        ),
        field(
          "employment.previously_worked_for_organization",
          "prior_employment",
          "option",
          "false",
          "No",
        ),
      ],
      repeatables: [],
    }, adapter, AbortSignal.any([]));

    assert.equal(result.kind, "verified", JSON.stringify(result));
    assert.equal(await page.locator('[data-automation-id="sourcePrompt"]')
      .getAttribute("data-selected-label"), "Company Website");
    assert.equal(await page.locator('#previous-no').isChecked(), true);
    assert.deepEqual(adapter.interaction(source.controlId), {
      popupBound: true,
      optionFocused: false,
      optionActivated: true,
      popupClosed: true,
      backingValueCommitted: true,
      validationCleared: true,
      visibleOptionCount: 1,
      selectedOptionOrdinal: 1,
    });
    assert.deepEqual(adapter.interaction(previousWorker.controlId), {
      popupBound: null,
      optionFocused: null,
      optionActivated: true,
      popupClosed: null,
      backingValueCommitted: true,
      validationCleared: true,
      visibleOptionCount: 2,
      selectedOptionOrdinal: 2,
    });
  } finally {
    await browser.close();
  }
});

test("source control binds through the exact Workday form-field container without sourcePrompt", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <div data-automation-id="formField-source--source">
            <button type="button" role="combobox" aria-required="true"
              aria-controls="source-options" aria-valuetext="Company Website">
              Company Website
            </button>
          </div>
          <div id="source-options" role="listbox" hidden></div>
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const snapshot = await adapter.inspect(AbortSignal.any([]));

    assert.deepEqual(snapshot.controls.map(({ fieldId, uiBehavior, required, readback }) => ({
      fieldId,
      uiBehavior,
      required,
      readback,
    })), [{
      fieldId: "source.how_did_you_hear",
      uiBehavior: "search_select",
      required: true,
      readback: "Company Website",
    }]);
  } finally {
    await browser.close();
  }
});

test("source-specific native action controls are never bound or activated", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const unsafeControls = [
      '<button id="source--default-submit" role="combobox" aria-required="true">Select One</button>',
      '<button type="submit" id="source--submit" role="combobox" aria-required="true">Select One</button>',
      '<input type="submit" id="source--input-submit" role="combobox" aria-required="true">',
      '<input type="image" id="source--image" role="combobox" aria-required="true">',
      '<input type="reset" id="source--reset" role="combobox" aria-required="true">',
    ];
    for (const unsafeControl of unsafeControls) {
      await page.setContent(`
        <body data-hunt-profile-page-type="profile">
          <main data-automation-id="applyFlowMyInfoPage">
            <form id="application-form">
              <div data-automation-id="formField-source--unsafe">${unsafeControl}</div>
            </form>
          </main>
          <script>
            globalThis.submitCount = 0;
            globalThis.resetCount = 0;
            document.querySelector('#application-form').addEventListener('submit', (event) => {
              event.preventDefault();
              globalThis.submitCount += 1;
            });
            document.querySelector('#application-form').addEventListener('reset', () => {
              globalThis.resetCount += 1;
            });
          </script>
        </body>
      `);
      const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
      let sourceBound = false;
      try {
        sourceBound = (await adapter.inspect(AbortSignal.any([]))).controls.some(
          ({ fieldId }) => fieldId === "source.how_did_you_hear",
        );
      } catch (error) {
        assert.match(String(error), /unknown required control identity denied/iu);
      }
      assert.equal(sourceBound, false);
      assert.deepEqual(await page.evaluate(() => ({
        reset: (globalThis as { resetCount?: number }).resetCount,
        submit: (globalThis as { submitCount?: number }).submitCount,
      })), { reset: 0, submit: 0 });
    }
  } finally {
    await browser.close();
  }
});

test("the source selector never activates an exact category row as an option", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <button type="button" role="combobox" aria-required="true"
            aria-controls="source-options" data-automation-id="sourcePrompt">Select One</button>
          <div id="source-options" role="listbox">
            <div role="option" data-automation-id="promptCategory">Company Website</div>
          </div>
        </main>
        <script>
          globalThis.optionClicks = 0;
          document.querySelector('[role="option"]').addEventListener('click', () => {
            globalThis.optionClicks += 1;
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
    }, AbortSignal.any([])), /selectable leaf/iu);
    assert.equal(await page.evaluate(() =>
      (globalThis as typeof globalThis & { optionClicks: number }).optionClicks
    ), 0);
  } finally {
    await browser.close();
  }
});

test("canonical source aria-valuetext prefill is already correct and never reopened", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <button type="button" role="combobox" aria-required="true"
            aria-controls="source-options" aria-valuetext="Company Website"
            data-automation-id="sourcePrompt">Company Website</button>
          <div id="source-options" role="listbox" hidden></div>
        </main>
        <script>
          globalThis.sourceClicks = 0;
          document.querySelector('[data-automation-id="sourcePrompt"]')
            .addEventListener('click', () => { globalThis.sourceClicks += 1; });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const source = (await adapter.inspect(AbortSignal.any([]))).controls.find(
      ({ fieldId }) => fieldId === "source.how_did_you_hear",
    )!;
    const result = await completeWorkdayProfilePage({
      pageType: "profile",
      fields: [field(
        "source.how_did_you_hear",
        "application_source",
        "option",
        "company-website",
        "Company Website",
      )],
      repeatables: [],
    }, adapter, AbortSignal.any([]));

    assert.equal(result.kind, "verified", JSON.stringify(result));
    assert.equal(await page.evaluate(() =>
      (globalThis as typeof globalThis & { sourceClicks: number }).sourceClicks
    ), 0);
    assert.equal(adapter.interaction(source.controlId), undefined);
  } finally {
    await browser.close();
  }
});

test("canonical source waits for its delayed owned listbox leaf", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <button type="button" role="combobox" aria-required="true"
            aria-controls="source-options" aria-expanded="false"
            data-automation-id="sourcePrompt">Select One</button>
        </main>
        <script>
          const source = document.querySelector('[data-automation-id="sourcePrompt"]');
          source.addEventListener('click', () => {
            source.setAttribute('aria-expanded', 'true');
            const listbox = document.createElement('div');
            listbox.id = 'source-options';
            listbox.setAttribute('role', 'listbox');
            document.body.append(listbox);
            setTimeout(() => {
              listbox.innerHTML = '<div role="option" data-automation-id="promptLeafNode">Company Website</div>';
              listbox.firstElementChild.addEventListener('click', event => {
                source.setAttribute('aria-valuetext', event.currentTarget.textContent.trim());
                source.setAttribute('aria-expanded', 'false');
                listbox.hidden = true;
              });
            }, 40);
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, {
      pageType: "profile",
      timeoutMs: 1_000,
    });
    const result = await completeWorkdayProfilePage({
      pageType: "profile",
      fields: [field(
        "source.how_did_you_hear",
        "application_source",
        "option",
        "company-website",
        "Company Website",
      )],
      repeatables: [],
    }, adapter, AbortSignal.any([]));

    assert.equal(result.kind, "verified", JSON.stringify(result));
    assert.equal(await page.locator('[data-automation-id="sourcePrompt"]')
      .getAttribute("aria-valuetext"), "Company Website");
  } finally {
    await browser.close();
  }
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

test("unknown visible required controls block before a reviewed control is mutated", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <input required data-automation-id="legalNameSection_firstName">
          <input required data-automation-id="unreviewedRequiredControl">
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });

    assert.deepEqual(
      await completeWorkdayProfilePage({
        pageType: "profile",
        fields: [field("identity.given_name", "identity", "text", "Ada")],
        repeatables: [],
      }, adapter, AbortSignal.any([])),
      {
        kind: "blocked",
        code: "answer_type_unknown",
        fieldId: "unknown.required.1",
        uiBehavior: "text",
        uiVariant: "workday_unknown_required_v1",
      },
    );
    assert.equal(
      await page.locator('[data-automation-id="legalNameSection_firstName"]').inputValue(),
      "",
    );
  } finally {
    await browser.close();
  }
});

test("custom ARIA required controls block before a reviewed field is mutated", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <input required data-automation-id="legalNameSection_firstName">
          <div role="checkbox" aria-required="true"
            data-automation-id="tenantConsent" tabindex="0">Consent</div>
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });

    assert.deepEqual(
      await completeWorkdayProfilePage({
        pageType: "profile",
        fields: [field("identity.given_name", "identity", "text", "Ada")],
        repeatables: [],
      }, adapter, AbortSignal.any([])),
      {
        kind: "blocked",
        code: "answer_type_unknown",
        fieldId: "unknown.required.1",
        uiBehavior: "checkbox",
        uiVariant: "workday_unknown_required_v1",
      },
    );
    assert.equal(
      await page.locator('[data-automation-id="legalNameSection_firstName"]').inputValue(),
      "",
    );
    const unknown = (await adapter.inspect(AbortSignal.any([]))).controls.find(
      ({ fieldId }) => fieldId.startsWith("unknown.required."),
    );
    assert.equal(unknown?.uiBehavior, "checkbox");
  } finally {
    await browser.close();
  }
});

test("inventories unknown active form controls by structural UI type without retaining values", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <input required type="date" data-automation-id="tenantStartDate" value="2026-08-11">
          <input type="tel" data-automation-id="tenantPhone" value="555-0100">
          <input type="checkbox" data-automation-id="tenantCheckbox" checked>
          <input required type="file" data-automation-id="tenantDocument">
          <button type="button" role="combobox" aria-required="true"
            aria-controls="tenant-options" data-automation-id="tenantSelect">Select One</button>
          <div id="tenant-options" role="listbox" hidden></div>
        </main>
      </body>
    `);
    const snapshot = await new PlaywrightWorkdayProfilePage(page, {
      pageType: "profile",
    }).inspect(AbortSignal.any([]));

    assert.deepEqual(snapshot.controls.map(({ fieldId, uiBehavior, required, readback }) => ({
      fieldId,
      uiBehavior,
      required,
      readback,
    })), [
      { fieldId: "unknown.required.1", uiBehavior: "date", required: true, readback: null },
      { fieldId: "unknown.optional.2", uiBehavior: "phone", required: false, readback: null },
      { fieldId: "unknown.optional.3", uiBehavior: "checkbox", required: false, readback: null },
      { fieldId: "unknown.required.4", uiBehavior: "file", required: true, readback: null },
      { fieldId: "unknown.required.5", uiBehavior: "search_select", required: true, readback: null },
    ]);
  } finally {
    await browser.close();
  }
});

test("inventories optional custom ARIA and contenteditable controls", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <div role="checkbox" aria-checked="false"
            data-automation-id="tenantOptionalConsent" tabindex="0">Consent</div>
          <div role="radiogroup" data-automation-id="tenantOptionalGroup">Choices</div>
          <div role="radio" aria-checked="false"
            data-automation-id="tenantOptionalRadio" tabindex="0">Choice</div>
          <div contenteditable="true" data-automation-id="tenantOptionalNote">Note</div>
        </main>
      </body>
    `);
    const snapshot = await new PlaywrightWorkdayProfilePage(page, {
      pageType: "profile",
    }).inspect(AbortSignal.any([]));

    assert.deepEqual(snapshot.controls.map(({ fieldId, uiBehavior, required }) => ({
      fieldId,
      uiBehavior,
      required,
    })), [
      { fieldId: "unknown.optional.1", uiBehavior: "checkbox", required: false },
      { fieldId: "unknown.optional.2", uiBehavior: "radio_group", required: false },
      { fieldId: "unknown.optional.3", uiBehavior: "radio_group", required: false },
      { fieldId: "unknown.optional.4", uiBehavior: "text", required: false },
    ]);
  } finally {
    await browser.close();
  }
});

test("a combined page excludes only the exact Resume-owned file control", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <input required type="file" data-automation-id="file-upload-input-ref">
          <input required type="file" data-automation-id="tenant-required-document">
        </main>
      </body>
    `);
    const snapshot = await new PlaywrightWorkdayProfilePage(page, {
      pageType: "profile",
    }).inspect(AbortSignal.any([]));

    assert.deepEqual(snapshot.controls.map(({ fieldId }) => fieldId), [
      "unknown.required.1",
    ]);
  } finally {
    await browser.close();
  }
});

test("unknown required control identities survive DOM reordering without retaining labels", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <input required data-automation-id="tenantQuestionAlpha">
          <input required data-automation-id="tenantQuestionBeta">
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const first = (await adapter.inspect(AbortSignal.any([]))).controls.map(
      ({ fieldId }) => fieldId,
    );
    await page.locator('[data-automation-id="tenantQuestionBeta"]').evaluate(
      (element) => element.parentElement?.prepend(element),
    );
    const second = (await adapter.inspect(AbortSignal.any([]))).controls.map(
      ({ fieldId }) => fieldId,
    );

    assert.deepEqual(second, [first[1], first[0]]);
    assert.equal(JSON.stringify([...first, ...second]).includes("tenantQuestion"), false);
  } finally {
    await browser.close();
  }
});

test("unknown required controls without a unique machine identity fail before mutation", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <input required>
          <input required>
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });

    await assert.rejects(
      adapter.inspect(AbortSignal.any([])),
      /unknown required control identity denied/u,
    );
  } finally {
    await browser.close();
  }
});

test("required controls outside the admitted profile container do not block it", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <aside><input required data-automation-id="workdayChromeRequiredControl"></aside>
        <main data-automation-id="applyFlowMyInfoPage">
          <input required data-automation-id="legalNameSection_firstName">
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });

    const result = await completeWorkdayProfilePage({
      pageType: "profile",
      fields: [field("identity.given_name", "identity", "text", "Ada")],
      repeatables: [],
    }, adapter, AbortSignal.any([]));

    assert.equal(result.kind, "verified");
    assert.equal(
      await page.locator('[data-automation-id="legalNameSection_firstName"]').inputValue(),
      "Ada",
    );
    assert.equal(
      await page.locator('[data-automation-id="workdayChromeRequiredControl"]').inputValue(),
      "",
    );
  } finally {
    await browser.close();
  }
});

test("disabled required controls inside the profile container do not block it", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <input required data-automation-id="legalNameSection_firstName">
          <input required disabled data-automation-id="nativeDisabledRequired">
          <input required aria-disabled="true" data-automation-id="ariaDisabledRequired">
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });

    const result = await completeWorkdayProfilePage({
      pageType: "profile",
      fields: [field("identity.given_name", "identity", "text", "Ada")],
      repeatables: [],
    }, adapter, AbortSignal.any([]));

    assert.equal(result.kind, "verified");
    assert.equal(
      await page.locator('[data-automation-id="legalNameSection_firstName"]').inputValue(),
      "Ada",
    );
  } finally {
    await browser.close();
  }
});

test("native readonly required controls inside the profile container do not block it", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <input required data-automation-id="legalNameSection_firstName">
          <input required readonly value="Ada" data-automation-id="preferredNameSection_preferredName">
          <input required readonly value="owner@example.invalid" data-automation-id="prepopulatedEmail">
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });

    const result = await completeWorkdayProfilePage({
      pageType: "profile",
      fields: [field("identity.given_name", "identity", "text", "Ada")],
      repeatables: [],
    }, adapter, AbortSignal.any([]));

    assert.equal(result.kind, "verified");
    assert.equal(
      await page.locator('[data-automation-id="legalNameSection_firstName"]').inputValue(),
      "Ada",
    );
    assert.equal(
      await page.locator('[data-automation-id="preferredNameSection_preferredName"]').inputValue(),
      "Ada",
    );
  } finally {
    await browser.close();
  }
});

test("a required control enabled after an earlier commit blocks the next mutation", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <input required data-automation-id="legalNameSection_firstName">
          <input required data-automation-id="legalNameSection_lastName">
          <input required disabled data-automation-id="conditionalRequired">
        </main>
        <script>
          document.querySelector('[data-automation-id="legalNameSection_firstName"]')
            .addEventListener("input", () => {
              document.querySelector('[data-automation-id="conditionalRequired"]')
                .removeAttribute("disabled");
            });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });

    assert.deepEqual(
      await completeWorkdayProfilePage({
        pageType: "profile",
        fields: [
          field("identity.given_name", "identity", "text", "Ada"),
          field("identity.family_name", "identity", "text", "Lovelace"),
        ],
        repeatables: [],
      }, adapter, AbortSignal.any([])),
      {
        kind: "blocked",
        code: "answer_type_unknown",
        fieldId: "unknown.required.1",
        uiBehavior: "text",
        uiVariant: "workday_unknown_required_v1",
      },
    );
    assert.equal(
      await page.locator('[data-automation-id="legalNameSection_firstName"]').inputValue(),
      "Ada",
    );
    assert.equal(
      await page.locator('[data-automation-id="legalNameSection_lastName"]').inputValue(),
      "",
    );
  } finally {
    await browser.close();
  }
});

test("real adapter and handler reconcile every profile section without owned duplicates", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(fixture);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const experience = [
      field("experience.company", "experience", "text", "Analytical Engines"),
      field("experience.title", "experience", "text", "Programmer"),
      field("experience.start_date", "experience", "date", "2021-03-01"),
    ];
    const portErrors: string[] = [];
    const result = await completeWorkdayProfilePage({
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
          field("education.degree", "education", "text", "Mathematics"),
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

function traced(
  port: WorkdayProfilePagePort,
  errors: string[],
): WorkdayProfilePagePort {
  return new Proxy(port, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
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
