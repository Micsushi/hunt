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
import { retainedProfileTextSha256 } from
  "../../../../src/ats/workday/application/profile/catalog.ts";

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

test("indexed Workday dates bind month and year inputs instead of legacy date containers", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyExpPage">
          <input id="workExperience-4--jobTitle" required>
          <input id="workExperience-4--companyName" required>
          <div id="workExperience-4--startDate">
            <input id="workExperience-4--startDate-dateSectionMonth-input"
              role="spinbutton" required>
            <input id="workExperience-4--startDate-dateSectionYear-input"
              role="spinbutton" required>
          </div>
          <div id="workExperience-4--endDate">
            <input id="workExperience-4--endDate-dateSectionMonth-input"
              role="spinbutton" required>
            <input id="workExperience-4--endDate-dateSectionYear-input"
              role="spinbutton" required>
          </div>
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });

    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const experience = snapshot.rows.find(({ section }) => section === "experience");
    assert.deepEqual(experience?.controls.map(({ fieldId, uiBehavior }) => [
      fieldId,
      uiBehavior,
    ]), [
      ["experience.company", "text"],
      ["experience.title", "text"],
      ["experience.start_month", "month"],
      ["experience.start_year", "year"],
      ["experience.end_month", "month"],
      ["experience.end_year", "year"],
    ]);
  } finally {
    await browser.close();
  }
});

test("Workday month commit accepts the spinbutton's unpadded numeric readback", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyExpPage">
          <input id="workExperience-4--startDate-dateSectionMonth-input"
            role="spinbutton" required
            onblur="this.value = this.value === '' ? '' : String(Number(this.value))">
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const initial = await adapter.inspect(AbortSignal.any([]));
    const month = initial.rows[0]!.controls[0]!;

    await adapter.commit({
      controlId: month.controlId,
      uiBehavior: "month",
      value: "09",
    }, AbortSignal.any([]));

    assert.equal(adapter.interaction(month.controlId)?.backingValueCommitted, true);
    assert.equal((await adapter.inspect(AbortSignal.any([]))).rows[0]!.controls[0]!.readback, "9");
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
          <div data-automation-id="formField-country">
            <button id="country--country" name="country" aria-haspopup="listbox"
              aria-label="Country Canada Required" aria-valuetext="Canada">Canada</button>
            <input>
          </div>
          <label>First Name*<input id="name--legalName--firstName"
            name="legalName--firstName" required></label>
          <label>Last Name*<input id="name--legalName--lastName"
            name="legalName--lastName" required></label>
          <label><input id="name--preferredCheck" name="preferredCheck"
            type="checkbox">I have a preferred name</label>
          <label>Middle Name<input id="name--legalName--middleName" name="middleName"></label>
          <label>Address Line 1<input id="address--addressLine1" name="addressLine1"></label>
          <label>Address Line 2<input id="address--addressLine2" name="addressLine2"></label>
          <label>City<input id="address--city" name="city"></label>
          <button id="address--countryRegion" name="countryRegion" aria-haspopup="listbox"
            aria-label="Province or Territory Not Required">Select One</button>
          <label>Postal Code<input id="address--postalCode" name="postalCode"></label>
          <label>Email*<input id="emailAddress--emailAddress" required></label>
          <button id="phoneNumber--phoneType" name="phoneType" aria-haspopup="listbox"
            aria-label="Phone Device Type Mobile Required" aria-valuetext="Mobile">Mobile</button>
          <label data-automation-id="formField">Country Phone Code*
            <span data-automation-id="selectedItem">Canada (+1)</span>
            <input id="phoneNumber--countryPhoneCode" role="combobox"
              aria-controls="phone-codes" required>
          </label>
          <div id="phone-codes" role="listbox" hidden>
            <div role="option">Canada (+1)</div>
          </div>
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
      "identity.middle_name",
      "identity.family_name",
      "identity.has_preferred_name",
      "address.line1",
      "address.line2",
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
    assert.equal(controls.get("phone.country_code")?.uiBehavior, "search_select");
    assert.equal(controls.get("phone.country_code")?.readback, "Canada (+1)");
    assert.equal(controls.get("phone.number")?.uiBehavior, "phone");

    await adapter.commit({
      controlId: controls.get("identity.has_preferred_name")!.controlId,
      uiBehavior: "checkbox",
      value: "true",
    }, AbortSignal.any([]));

    await adapter.commit({
      controlId: controls.get("identity.given_name")!.controlId,
      uiBehavior: "text",
      value: "Ada",
    }, AbortSignal.any([]));
    await adapter.commit({
      controlId: controls.get("phone.number")!.controlId,
      uiBehavior: "phone",
      value: "5550100",
    }, AbortSignal.any([]));

    const readback = new Map((await adapter.inspect(AbortSignal.any([]))).controls
      .map((control) => [control.fieldId, control.readback]));
    assert.equal(readback.get("identity.given_name"), "Ada");
    assert.equal(readback.get("phone.country_code"), "Canada (+1)");
    assert.equal(readback.get("phone.number"), "5550100");
    assert.equal(readback.get("identity.has_preferred_name"), "true");
  } finally {
    await browser.close();
  }
});

test("reports the exact catalog identity for ambiguous visible scalar controls", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main data-automation-id="applyFlowMyExperiencePage">
        <input id="skills--skills"><input id="skills--skills">
      </main>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    await assert.rejects(() => adapter.inspect(AbortSignal.any([])), /profile inspection failed/u);
    assert.deepEqual(adapter.inspectionFailure()?.bindingIds, ["skills.values"]);
    assert.equal(adapter.inspectionFailure()?.phase, "scalar");
  } finally {
    await browser.close();
  }
});

test("reports the exact catalog identity when control observation loses its target", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main data-automation-id="applyFlowMyExperiencePage">
        <label>LinkedIn<input id="socialNetworkAccounts--linkedInAccount"></label>
      </main>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const linkedIn = snapshot.controls.find(({ fieldId }) => fieldId === "social.linkedin")!;
    await page.locator('[id="socialNetworkAccounts--linkedInAccount"]')
      .evaluate((element) => element.remove());

    await assert.rejects(
      () => adapter.observeControl(linkedIn.controlId, AbortSignal.any([])),
      /profile inspection failed/u,
    );
    assert.deepEqual(adapter.inspectionFailure()?.bindingIds, ["social.linkedin"]);
    assert.deepEqual(adapter.inspectionFailure()?.bindingPaths, ["profile.control.observation"]);
    assert.equal(adapter.inspectionFailure()?.phase, "unknown_controls");
  } finally {
    await browser.close();
  }
});

test("observes an empty Workday skills prompt without opening it", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main data-automation-id="applyFlowMyExperiencePage">
        <label>Type to Add Skills
          <input id="skills--skills"
            onfocus="this.setAttribute('aria-invalid', 'true')">
        </label>
      </main>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const skills = snapshot.controls.find(({ fieldId }) => fieldId === "skills.values")!;

    const observed = await adapter.observeControl(skills.controlId, AbortSignal.any([]));

    assert.equal(observed.optionCatalogState, "unknown");
    assert.deepEqual(observed.visibleOptionIds, []);
    assert.equal(await page.locator('[id="skills--skills"]').getAttribute("aria-invalid"), null);
  } finally {
    await browser.close();
  }
});

test("associated Workday labels override aria labels containing selected values", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <label for="source--source">How Did You Hear About Us?</label>
          <button id="source--source" type="button" data-automation-id="sourcePrompt"
            aria-haspopup="listbox" aria-label="How Did You Hear About Us? Select One Required">
            Select One
          </button>
          <label for="country--country">Country</label>
          <button id="country--country" aria-haspopup="listbox"
            aria-label="Country Canada Required" aria-valuetext="Canada">Canada</button>
          <label for="address--countryRegion">Province or Territory</label>
          <button id="address--countryRegion" aria-haspopup="listbox"
            aria-label="Province or Territory Alberta Not Required"
            aria-valuetext="Alberta">Alberta</button>
          <label for="phoneNumber--phoneType">Phone Device Type</label>
          <button id="phoneNumber--phoneType" aria-haspopup="listbox"
            aria-label="Phone Device Type Mobile Required"
            aria-valuetext="Mobile">Mobile</button>
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const controls = await adapter.inspect(AbortSignal.any([]));
    for (const [fieldId, label] of [
      ["source.how_did_you_hear", "How Did You Hear About Us?"],
      ["address.country", "Country"],
      ["address.region", "Province or Territory"],
      ["phone.device_type", "Phone Device Type"],
    ] as const) {
      const control = controls.controls.find((candidate) => candidate.fieldId === fieldId);
      assert.ok(control !== undefined);
      const observed = await adapter.observeControl(
        control.controlId,
        AbortSignal.any([]),
        false,
      );
      assert.equal(observed.sanitizedLabelSha256, retainedProfileTextSha256(label));
    }
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
          <div data-automation-id="formField-previousWorker">
            <span data-automation-id="required">*</span>
            <fieldset role="radiogroup">
              <legend>Have you previously worked for the organization?</legend>
              <input id="previous-yes" type="radio"
                name="candidateIsPreviousWorker" value="true"><label for="previous-yes">Yes</label>
              <input id="previous-no" type="radio"
                name="candidateIsPreviousWorker" value="false"><label for="previous-no">No</label>
            </fieldset>
          </div>
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
      mode: "live",
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

test("Integer source select maps LinkedIn to its unique corporate-page leaf", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <div data-automation-id="formField-source--source">
            <button type="button" aria-label="How Did You Hear About Us? Select One Required"
              aria-haspopup="listbox" name="source" id="source--source">Select One</button>
          </div>
        </main>
        <script>
          const source = document.querySelector('#source--source');
          source.addEventListener('click', () => {
            source.setAttribute('aria-expanded', 'true');
            source.setAttribute('aria-controls', 'source-options');
            const listbox = document.createElement('div');
            listbox.id = 'source-options';
            listbox.setAttribute('role', 'listbox');
            listbox.innerHTML = '<div>LinkedIn corporate page</div>';
            document.body.append(listbox);
            listbox.firstElementChild.addEventListener('click', event => {
              source.textContent = event.currentTarget.textContent.trim();
              source.setAttribute('aria-expanded', 'false');
              listbox.hidden = true;
            });
          }, { once: true });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, {
      pageType: "profile",
      timeoutMs: 500,
    });
    assert.deepEqual(
      (await adapter.inspect(AbortSignal.any([]))).controls.map(
        ({ fieldId, uiBehavior, required }) => ({ fieldId, uiBehavior, required }),
      ),
      [{ fieldId: "source.how_did_you_hear", uiBehavior: "search_select", required: true }],
    );
    const result = await completeWorkdayProfilePage({
      mode: "live",
      pageType: "profile",
fields: [field(
        "source.how_did_you_hear",
        "application_source",
        "option",
        "linkedin",
        "LinkedIn",
      )],
      repeatables: [],
    }, adapter, AbortSignal.any([]));

    const after = await adapter.inspect(AbortSignal.any([]));
    assert.equal(result.kind, "verified", JSON.stringify({ result, after }));
    assert.equal(await page.locator('#source--source').innerText(), "LinkedIn corporate page");
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

test("the source selector may expand but never commits an exact category row", async () => {
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
    ), 1);
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
      mode: "live",
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
      mode: "live",
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

test("search select matches the exact accessible option label when rendered text has adornment", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <button id="phoneNumber--phoneType" role="combobox" aria-haspopup="listbox"
            aria-controls="phone-types" aria-expanded="false">Select One</button>
          <div id="phone-types" role="listbox" hidden>
            <div role="option" aria-label="Mobile">Mobile Selected</div>
          </div>
        </main>
        <script>
          const control = document.querySelector('#phoneNumber--phoneType');
          const popup = document.querySelector('#phone-types');
          control.addEventListener('click', () => {
            popup.hidden = false;
            control.setAttribute('aria-expanded', 'true');
          });
          popup.addEventListener('click', ({ target }) => {
            if (!(target instanceof Element) || target.getAttribute('role') !== 'option') return;
            control.textContent = target.getAttribute('aria-label');
            control.setAttribute('aria-valuetext', target.getAttribute('aria-label'));
            control.setAttribute('aria-expanded', 'false');
            popup.hidden = true;
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const control = snapshot.controls.find(({ fieldId }) => fieldId === "phone.device_type")!;

    await adapter.commit({
      controlId: control.controlId,
      uiBehavior: "search_select",
      value: "Mobile",
    }, AbortSignal.any([]));

    assert.equal((await adapter.inspect(AbortSignal.any([]))).controls
      .find(({ fieldId }) => fieldId === "phone.device_type")?.readback, "Mobile");
  } finally {
    await browser.close();
  }
});

test("search select commits an exact Workday prompt leaf without an option role", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <button id="phoneNumber--phoneType" role="combobox" aria-haspopup="listbox"
            aria-controls="phone-types" aria-expanded="false">Select One</button>
          <div id="phone-types" role="listbox" hidden>
            <div data-automation-id="promptOption">Mobile</div>
          </div>
        </main>
        <script>
          const control = document.querySelector('#phoneNumber--phoneType');
          const popup = document.querySelector('#phone-types');
          control.addEventListener('click', () => {
            popup.hidden = false;
            control.setAttribute('aria-expanded', 'true');
          });
          popup.addEventListener('click', ({ target }) => {
            if (!(target instanceof Element) || target.getAttribute('data-automation-id') !== 'promptOption') return;
            control.textContent = target.textContent;
            control.setAttribute('aria-valuetext', target.textContent);
            control.setAttribute('aria-expanded', 'false');
            popup.hidden = true;
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const control = snapshot.controls.find(({ fieldId }) => fieldId === "phone.device_type")!;

    await adapter.commit({
      controlId: control.controlId,
      uiBehavior: "search_select",
      value: "Mobile",
    }, AbortSignal.any([]));

    assert.equal((await adapter.inspect(AbortSignal.any([]))).controls
      .find(({ fieldId }) => fieldId === "phone.device_type")?.readback, "Mobile");
  } finally {
    await browser.close();
  }
});

test("search select commits one exact visible text leaf inside its owned popup", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <button id="phoneNumber--phoneType" role="combobox" aria-haspopup="listbox"
            aria-controls="phone-types" aria-expanded="false">Select One</button>
          <div id="phone-types" role="listbox" hidden><div class="phone-choice">Mobile</div></div>
        </main>
        <script>
          const control = document.querySelector('#phoneNumber--phoneType');
          const popup = document.querySelector('#phone-types');
          control.addEventListener('click', () => {
            popup.hidden = false;
            control.setAttribute('aria-expanded', 'true');
          });
          popup.addEventListener('click', ({ target }) => {
            if (!(target instanceof Element) || !target.classList.contains('phone-choice')) return;
            control.textContent = target.textContent;
            control.setAttribute('aria-valuetext', target.textContent);
            control.setAttribute('aria-expanded', 'false');
            popup.hidden = true;
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const control = snapshot.controls.find(({ fieldId }) => fieldId === "phone.device_type")!;

    await adapter.commit({
      controlId: control.controlId,
      uiBehavior: "search_select",
      value: "Mobile",
    }, AbortSignal.any([]));

    assert.equal((await adapter.inspect(AbortSignal.any([]))).controls
      .find(({ fieldId }) => fieldId === "phone.device_type")?.readback, "Mobile");
  } finally {
    await browser.close();
  }
});

test("search select uses exact keyboard typeahead when an owned popup exposes no DOM leaf", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <button id="phoneNumber--phoneType" role="combobox" aria-haspopup="listbox"
            aria-controls="phone-types" aria-expanded="false">Select One</button>
          <div id="phone-types" role="listbox" hidden><span>Virtualized choices</span></div>
        </main>
        <script>
          const control = document.querySelector('#phoneNumber--phoneType');
          const popup = document.querySelector('#phone-types');
          let typed = '';
          control.addEventListener('click', () => {
            control.focus();
            popup.hidden = false;
            control.setAttribute('aria-expanded', 'true');
          });
          control.addEventListener('keydown', (event) => {
            const { key } = event;
            if (key.length === 1) typed += key;
            if (key === 'Enter' && typed === 'Mobile') {
              event.preventDefault();
              control.textContent = 'Mobile';
              control.setAttribute('aria-valuetext', 'Mobile');
              control.setAttribute('aria-expanded', 'false');
              popup.hidden = true;
            }
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile", timeoutMs: 500 });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const control = snapshot.controls.find(({ fieldId }) => fieldId === "phone.device_type")!;

    await adapter.commit({
      controlId: control.controlId,
      uiBehavior: "search_select",
      value: "Mobile",
    }, AbortSignal.any([]));

    assert.equal((await adapter.inspect(AbortSignal.any([]))).controls
      .find(({ fieldId }) => fieldId === "phone.device_type")?.readback, "Mobile");
  } finally {
    await browser.close();
  }
});

test("search select clicks the exact active descendant established by typeahead", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <button id="phoneNumber--phoneType" role="combobox" aria-haspopup="listbox"
            aria-controls="phone-types" aria-expanded="false">Select One</button>
          <div id="phone-types" role="listbox" hidden><span>Virtualized choices</span></div>
        </main>
        <script>
          const control = document.querySelector('#phoneNumber--phoneType');
          const popup = document.querySelector('#phone-types');
          control.addEventListener('click', () => {
            control.focus();
            popup.hidden = false;
            control.setAttribute('aria-expanded', 'true');
          });
          control.addEventListener('keydown', ({ key }) => {
            if (key !== 'M') return;
            const option = document.createElement('div');
            option.id = 'active-mobile';
            option.setAttribute('aria-label', 'Mobile');
            option.textContent = 'Mobile Selected';
            option.addEventListener('click', () => {
              control.textContent = 'Mobile';
              control.setAttribute('aria-valuetext', 'Mobile');
              control.setAttribute('aria-expanded', 'false');
              popup.hidden = true;
            });
            popup.append(option);
            control.setAttribute('aria-activedescendant', option.id);
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile", timeoutMs: 500 });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const control = snapshot.controls.find(({ fieldId }) => fieldId === "phone.device_type")!;

    await adapter.commit({
      controlId: control.controlId,
      uiBehavior: "search_select",
      value: "Mobile",
    }, AbortSignal.any([]));

    assert.equal((await adapter.inspect(AbortSignal.any([]))).controls
      .find(({ fieldId }) => fieldId === "phone.device_type")?.readback, "Mobile");
  } finally {
    await browser.close();
  }
});

test("search select activates the option-row ancestor of an exact active descendant", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile"><main data-automation-id="applyFlowMyInfoPage">
        <button id="phoneNumber--phoneType" role="combobox" aria-haspopup="listbox"
          aria-controls="phone-types" aria-expanded="false">Select One</button>
        <div id="phone-types" role="listbox" hidden><span>Virtualized choices</span></div>
      </main><script>
        const control = document.querySelector('#phoneNumber--phoneType');
        const popup = document.querySelector('#phone-types');
        control.addEventListener('click', () => { control.focus(); popup.hidden = false; control.setAttribute('aria-expanded', 'true'); });
        control.addEventListener('keydown', ({ key }) => {
          if (key !== 'M' || document.querySelector('#active-mobile')) return;
          const row = document.createElement('div'); row.setAttribute('role', 'option');
          const label = document.createElement('span'); label.id = 'active-mobile'; label.textContent = 'Mobile';
          row.append(label); row.addEventListener('click', ({ target }) => {
            if (target !== row) return;
            control.textContent = 'Mobile'; control.setAttribute('aria-valuetext', 'Mobile');
            control.setAttribute('aria-expanded', 'false'); popup.hidden = true;
          });
          popup.append(row); control.setAttribute('aria-activedescendant', label.id);
        });
      </script></body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile", timeoutMs: 500 });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const control = snapshot.controls.find(({ fieldId }) => fieldId === "phone.device_type")!;
    await adapter.commit({ controlId: control.controlId, uiBehavior: "search_select", value: "Mobile" }, AbortSignal.any([]));
    assert.equal((await adapter.inspect(AbortSignal.any([]))).controls
      .find(({ fieldId }) => fieldId === "phone.device_type")?.readback, "Mobile");
  } finally { await browser.close(); }
});

test("v2 phone type commits an activated exact row with Enter", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile"><main data-automation-id="applyFlowMyInfoPage">
        <button id="phoneNumber--phoneType" role="combobox" aria-haspopup="listbox"
          aria-controls="phone-types" aria-expanded="false">Select One</button>
        <div id="phone-types" role="listbox" hidden><span>Virtualized choices</span></div>
      </main><script>
        const control = document.querySelector('#phoneNumber--phoneType');
        const popup = document.querySelector('#phone-types');
        let active;
        control.addEventListener('click', () => { control.focus(); popup.hidden = false; control.setAttribute('aria-expanded', 'true'); });
        control.addEventListener('keydown', ({ key }) => {
          if (key === 'M' && !active) {
            active = document.createElement('div'); active.id = 'active-mobile';
            active.setAttribute('role', 'option'); active.setAttribute('aria-label', 'Mobile');
            active.textContent = 'Mobile'; active.tabIndex = -1;
            active.addEventListener('click', () => active.focus());
            active.addEventListener('keydown', ({ key: optionKey }) => {
              if (optionKey !== 'Enter') return;
              control.textContent = 'Mobile'; control.setAttribute('aria-valuetext', 'Mobile');
              control.setAttribute('aria-expanded', 'false'); popup.hidden = true;
            });
            popup.append(active); control.setAttribute('aria-activedescendant', active.id);
          }
        });
      </script></body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile", timeoutMs: 500 });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const control = snapshot.controls.find(({ fieldId }) => fieldId === "phone.device_type")!;
    await adapter.commit({ controlId: control.controlId, uiBehavior: "search_select", value: "Mobile" }, AbortSignal.any([]));
    assert.equal((await adapter.inspect(AbortSignal.any([]))).controls
      .find(({ fieldId }) => fieldId === "phone.device_type")?.readback, "Mobile");
  } finally { await browser.close(); }
});

test("v2 phone type maps the canonical Mobile answer to a tenant CELL option", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile"><main data-automation-id="applyFlowMyInfoPage">
        <button id="phoneNumber--phoneType" role="combobox" aria-haspopup="listbox"
          aria-controls="phone-types" aria-expanded="false">Select One</button>
        <div id="phone-types" role="listbox" hidden>
          <div role="option">BUSN</div><div role="option" id="cell-option">CELL</div>
        </div>
      </main><script>
        const control = document.querySelector('#phoneNumber--phoneType');
        const popup = document.querySelector('#phone-types');
        control.addEventListener('click', () => {
          control.focus(); popup.hidden = false; control.setAttribute('aria-expanded', 'true');
        });
        document.querySelector('#cell-option').addEventListener('click', () => {
          control.textContent = 'CELL'; control.setAttribute('aria-valuetext', 'CELL');
          control.setAttribute('aria-expanded', 'false'); popup.hidden = true;
        });
      </script></body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile", timeoutMs: 500 });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const control = snapshot.controls.find(({ fieldId }) => fieldId === "phone.device_type")!;
    await adapter.commit(
      { controlId: control.controlId, uiBehavior: "search_select", value: "Mobile" },
      AbortSignal.any([]),
    );
    assert.equal((await adapter.inspect(AbortSignal.any([]))).controls
      .find(({ fieldId }) => fieldId === "phone.device_type")?.readback, "CELL");
  } finally { await browser.close(); }
});

test("v2 phone type dismisses a Workday popup that remains open after CELL activates", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile"><main data-automation-id="applyFlowMyInfoPage">
        <button id="phoneNumber--phoneType" role="combobox" aria-haspopup="listbox"
          aria-controls="phone-types" aria-expanded="false">Select One</button>
        <div id="phone-types" role="listbox" hidden>
          <div role="option">BUSN</div><div role="option" id="cell-option">CELL</div>
        </div>
      </main><script>
        const control = document.querySelector('#phoneNumber--phoneType');
        const popup = document.querySelector('#phone-types');
        control.addEventListener('click', () => {
          control.focus(); popup.hidden = false; control.setAttribute('aria-expanded', 'true');
        });
        document.querySelector('#cell-option').addEventListener('click', () => {
          control.textContent = 'CELL'; control.setAttribute('aria-valuetext', 'CELL');
        });
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            control.setAttribute('aria-expanded', 'false'); popup.hidden = true;
          }
        });
      </script></body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile", timeoutMs: 250 });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const control = snapshot.controls.find(({ fieldId }) => fieldId === "phone.device_type")!;
    await adapter.commit(
      { controlId: control.controlId, uiBehavior: "search_select", value: "Mobile" },
      AbortSignal.any([]),
    );
    assert.equal(await page.locator("#phone-types").isVisible(), false);
    assert.equal(adapter.interaction(control.controlId)?.popupClosed, true);
    assert.equal((await adapter.inspect(AbortSignal.any([]))).controls
      .find(({ fieldId }) => fieldId === "phone.device_type")?.readback, "CELL");
  } finally { await browser.close(); }
});

test("search select rescans and clicks an exact option virtualized after typeahead", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <button id="phoneNumber--phoneType" role="combobox" aria-haspopup="listbox"
            aria-controls="phone-types" aria-expanded="false">Select One</button>
          <div id="phone-types" role="listbox" hidden><span>Virtualized choices</span></div>
        </main>
        <script>
          const control = document.querySelector('#phoneNumber--phoneType');
          const popup = document.querySelector('#phone-types');
          control.addEventListener('click', () => {
            control.focus(); popup.hidden = false; control.setAttribute('aria-expanded', 'true');
          });
          control.addEventListener('keydown', ({ key }) => {
            if (key !== 'M' || popup.querySelector('[role=option]')) return;
            const option = document.createElement('div');
            option.setAttribute('role', 'option'); option.textContent = 'Mobile';
            option.addEventListener('click', () => {
              control.textContent = 'Mobile'; control.setAttribute('aria-valuetext', 'Mobile');
              control.setAttribute('aria-expanded', 'false'); popup.hidden = true;
            });
            popup.append(option);
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile", timeoutMs: 1_000 });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const control = snapshot.controls.find(({ fieldId }) => fieldId === "phone.device_type")!;
    await adapter.commit({ controlId: control.controlId, uiBehavior: "search_select", value: "Mobile" }, AbortSignal.any([]));
    assert.equal((await adapter.inspect(AbortSignal.any([]))).controls
      .find(({ fieldId }) => fieldId === "phone.device_type")?.readback, "Mobile");
  } finally {
    await browser.close();
  }
});

test("search select reconciles an exact nested leaf revealed by the focused row", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <button id="phoneNumber--phoneType" role="combobox" aria-haspopup="listbox"
            aria-controls="phone-types" aria-expanded="false">Select One</button>
          <div id="phone-types" role="listbox" hidden><span>Virtualized choices</span></div>
        </main>
        <script>
          const control = document.querySelector('#phoneNumber--phoneType');
          const popup = document.querySelector('#phone-types');
          control.addEventListener('click', () => {
            control.focus(); popup.hidden = false; control.setAttribute('aria-expanded', 'true');
          });
          control.addEventListener('keydown', ({ key }) => {
            if (key !== 'M' || document.querySelector('#active-mobile')) return;
            const active = document.createElement('div');
            active.id = 'active-mobile'; active.setAttribute('aria-label', 'Mobile');
            active.textContent = 'Mobile Selected';
            active.addEventListener('click', () => {
              const leaf = document.createElement('div');
              leaf.setAttribute('role', 'option'); leaf.textContent = 'Mobile';
              leaf.addEventListener('click', () => {
                control.textContent = 'Mobile'; control.setAttribute('aria-valuetext', 'Mobile');
                control.setAttribute('aria-expanded', 'false'); popup.hidden = true;
              });
              popup.append(leaf);
            });
            popup.append(active); control.setAttribute('aria-activedescendant', active.id);
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile", timeoutMs: 500 });
    const snapshot = await adapter.inspect(AbortSignal.any([]));
    const control = snapshot.controls.find(({ fieldId }) => fieldId === "phone.device_type")!;
    await adapter.commit({ controlId: control.controlId, uiBehavior: "search_select", value: "Mobile" }, AbortSignal.any([]));
    assert.equal((await adapter.inspect(AbortSignal.any([]))).controls
      .find(({ fieldId }) => fieldId === "phone.device_type")?.readback, "Mobile");
  } finally {
    await browser.close();
  }
});

test("previous-worker radio recognizes Workday's visible required legend suffix", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <div data-automation-id="formField-previousWorker">
            <fieldset role="radiogroup">
              <legend>Have you worked with us before?*</legend>
              <input id="previous-yes" type="radio"
                name="candidateIsPreviousWorker"><label for="previous-yes">Yes</label>
              <input id="previous-no" type="radio"
                name="candidateIsPreviousWorker"><label for="previous-no">No</label>
            </fieldset>
          </div>
        </main>
      </body>
    `);
    const control = (await new PlaywrightWorkdayProfilePage(page, {
      pageType: "profile",
    }).inspect(AbortSignal.any([]))).controls.find(
      ({ fieldId }) => fieldId === "employment.previously_worked_for_organization",
    );
    assert.equal(control?.required, true);
  } finally {
    await browser.close();
  }
});

test("canonical source closes a committed Workday popup with Escape", async () => {
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
            <div role="option" data-automation-id="promptLeafNode">Company Website</div>
          </div>
        </main>
        <script>
          const source = document.querySelector('[data-automation-id="sourcePrompt"]');
          const listbox = document.querySelector('#source-options');
          globalThis.escapeCount = 0;
          source.addEventListener('click', () => {
            source.setAttribute('aria-expanded', 'true');
            listbox.hidden = false;
          });
          listbox.firstElementChild.addEventListener('click', event => {
            source.setAttribute('aria-valuetext', event.currentTarget.textContent.trim());
          });
          document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            globalThis.escapeCount += 1;
            source.setAttribute('aria-expanded', 'false');
            listbox.hidden = true;
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const result = await completeWorkdayProfilePage({
      mode: "live",
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
      (globalThis as typeof globalThis & { escapeCount: number }).escapeCount
    ), 1);
  } finally {
    await browser.close();
  }
});

test("the source selector expands the uniquely matching category before selecting its leaf", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <button type="button" role="combobox" aria-required="true"
            aria-controls="source-options" data-automation-id="sourcePrompt">Select One</button>
          <div id="source-options" role="listbox">
            <div role="option" data-automation-id="promptCategory">Career Site</div>
            <div role="option" data-automation-id="promptCategory">Referral</div>
          </div>
        </main>
        <script>
          const source = document.querySelector('[data-automation-id="sourcePrompt"]');
          const listbox = document.querySelector('#source-options');
          globalThis.categoryClicks = 0;
          listbox.firstElementChild.addEventListener('click', () => {
            globalThis.categoryClicks += 1;
            listbox.innerHTML = '<div role="option" data-automation-id="promptLeafNode">Career Site: BMO Careers (Canada)</div>';
            listbox.firstElementChild.addEventListener('click', event => {
              source.setAttribute('aria-valuetext', event.currentTarget.textContent.trim());
              source.setAttribute('aria-expanded', 'false');
              listbox.hidden = true;
            });
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const result = await completeWorkdayProfilePage({
      mode: "live",
      pageType: "profile",
fields: [field(
        "source.how_did_you_hear",
        "application_source",
        "option",
        "career-site-bmo-careers-canada",
        "Career Site: BMO Careers (Canada)",
      )],
      repeatables: [],
    }, adapter, AbortSignal.any([]));

    assert.equal(result.kind, "verified", JSON.stringify(result));
    assert.equal(await page.evaluate(() =>
      (globalThis as typeof globalThis & { categoryClicks: number }).categoryClicks
    ), 1);
  } finally {
    await browser.close();
  }
});

test("BMO source button binds its listbox after opening and commits a flat option", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <div data-automation-id="formField-source--source">
            <button aria-haspopup="listbox" type="button"
              aria-label="How Did You Hear About Us? Select One Required"
              name="source" id="source--source">Select One</button>
          </div>
        </main>
        <script>
          const source = document.querySelector('#source--source');
          source.addEventListener('click', () => {
            source.setAttribute('aria-expanded', 'true');
            source.setAttribute('aria-controls', 'source-options');
            const listbox = document.createElement('ul');
            listbox.id = 'source-options';
            listbox.setAttribute('role', 'listbox');
            listbox.innerHTML = '<li role="option">Career Site: BMO Careers (Canada)</li>';
            document.body.append(listbox);
            listbox.firstElementChild.addEventListener('click', event => {
              source.textContent = event.currentTarget.textContent.trim();
              source.removeAttribute('aria-expanded');
              source.removeAttribute('aria-controls');
              listbox.hidden = true;
            });
          }, { once: true });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const result = await completeWorkdayProfilePage({
      mode: "live",
      pageType: "profile",
fields: [field(
        "source.how_did_you_hear",
        "application_source",
        "option",
        "career-site-bmo-careers-canada",
        "Career Site: BMO Careers (Canada)",
      )],
      repeatables: [],
    }, adapter, AbortSignal.any([]));

    assert.equal(result.kind, "verified", JSON.stringify(result));
    assert.equal(await page.locator('#source--source').innerText(),
      "Career Site: BMO Careers (Canada)");
  } finally {
    await browser.close();
  }
});

test("a roleless source search input remains a known application-source control", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <div data-automation-id="formField-source">
            <label for="source--source">How Did You Hear About Us?</label>
            <input id="source--source" placeholder="Search" aria-required="true">
          </div>
        </main>
      </body>
    `);
    const snapshot = await new PlaywrightWorkdayProfilePage(
      page,
      { pageType: "profile" },
    ).inspect(AbortSignal.any([]));

    assert.deepEqual(
      snapshot.controls.map(({ fieldId, uiBehavior }) => ({ fieldId, uiBehavior })),
      [{ fieldId: "source.how_did_you_hear", uiBehavior: "search_select" }],
    );
  } finally {
    await browser.close();
  }
});

test("a roleless source search input opens its Workday prompt and commits an exact option", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <div data-automation-id="formField-source">
            <label for="source--source">How Did You Hear About Us?</label>
            <div data-automation-id="multiSelectContainer">
              <input id="source--source" placeholder="Search" aria-required="true">
              <div data-automation-id="responsiveMonikerPrompt">
                <span data-automation-id="promptSearchButton"><svg><path></path></svg></span>
              </div>
              <div id="selected-source"></div>
            </div>
          </div>
        </main>
        <div id="source-prompt" role="listbox" hidden>
          <div role="option">LinkedIn</div>
        </div>
        <script>
          const input = document.querySelector('#source--source');
          const prompt = document.querySelector('#source-prompt');
          let promptMode = false;
          document.querySelector('[data-automation-id="responsiveMonikerPrompt"] svg')
            .addEventListener('click', () => { promptMode = true; input.value = ''; });
          input.addEventListener('input', () => {
            prompt.hidden = !(promptMode && input.value === 'LinkedIn');
          });
          prompt.addEventListener('click', ({ target }) => {
            if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'option') return;
            const pill = document.createElement('div');
            pill.setAttribute('data-automation-id', 'selectedItem');
            pill.textContent = target.textContent;
            document.querySelector('#selected-source').append(pill);
            input.value = '';
            prompt.hidden = true;
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const control = (await adapter.inspect(AbortSignal.any([]))).controls.find(
      ({ fieldId }) => fieldId === "source.how_did_you_hear",
    )!;

    await adapter.commit({
      controlId: control.controlId,
      uiBehavior: "search_select",
      value: "LinkedIn",
    }, AbortSignal.any([]));

    assert.equal(
      (await adapter.inspect(AbortSignal.any([]))).controls.find(
        ({ fieldId }) => fieldId === "source.how_did_you_hear",
      )?.readback,
      "LinkedIn",
    );
  } finally {
    await browser.close();
  }
});

test("Intermountain source search uses the prompt button beside its responsive prompt sibling", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyInfoPage">
          <div data-automation-id="formField-source">
            <label for="source--source">How Did You Hear About Us?</label>
            <div data-automation-id="multiSelectContainer">
              <div data-automation-id="multiselectInputContainer">
                <div data-automation-id="monikerSearchBox">
                  <input id="source--source" data-automation-id="searchBox"
                    placeholder="Search" aria-required="true">
                </div>
                <div data-automation-id="promptSelectionLabel"></div>
                <div data-automation-id="promptAriaInstruction"></div>
                <span data-automation-id="promptSearchButton">
                  <svg role="presentation" style="display:block;width:20px;height:20px"></svg>
                </span>
                <div data-automation-id="responsiveMonikerPrompt">Responsive prompt surface</div>
              </div>
            </div>
          </div>
        </main>
        <div id="source-catalog" role="listbox" hidden>
          <div role="option">Partial list (first 500 entries)</div>
          <div role="option">All</div>
        </div>
        <div id="source-prompt" role="listbox" hidden>
          <div role="option">LinkedIn</div>
        </div>
        <script>
          const input = document.querySelector('#source--source');
          const catalog = document.querySelector('#source-catalog');
          const prompt = document.querySelector('#source-prompt');
          let promptMode = false;
          document.querySelector('[data-automation-id="promptSearchButton"]')
            .addEventListener('click', () => {
              promptMode = true; input.value = ''; catalog.hidden = true;
            });
          input.addEventListener('click', () => {
            if (!promptMode) catalog.hidden = false;
          });
          input.addEventListener('input', () => {
            prompt.hidden = !(promptMode && input.value === 'LinkedIn');
          });
          prompt.addEventListener('click', ({ target }) => {
            if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'option') return;
            const pill = document.createElement('div');
            pill.setAttribute('data-automation-id', 'selectedItem');
            pill.textContent = target.textContent;
            document.querySelector('[data-automation-id="monikerSearchBox"]').append(pill);
            input.value = '';
            prompt.hidden = true;
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, {
      pageType: "profile",
      timeoutMs: 500,
    });
    const control = (await adapter.inspect(AbortSignal.any([]))).controls.find(
      ({ fieldId }) => fieldId === "source.how_did_you_hear",
    )!;

    await adapter.commit({
      controlId: control.controlId,
      uiBehavior: "search_select",
      value: "LinkedIn",
    }, AbortSignal.any([]));

    assert.equal(
      (await adapter.inspect(AbortSignal.any([]))).controls.find(
        ({ fieldId }) => fieldId === "source.how_did_you_hear",
      )?.readback,
      "LinkedIn",
    );
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
        mode: "live",
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

test("learns and fills a generic Workday Website repeatable row", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyExpPage">
          <section data-automation-id="websitesSection">
            <div data-automation-id="website-1">
              <label>Website
                <input data-automation-id="website-1--website">
              </label>
            </div>
            <button type="button" data-automation-id="addWebsite">Add</button>
          </section>
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const result = await completeWorkdayProfilePage({
      mode: "live",
      pageType: "profile",
fields: [],
      repeatables: [{
        section: "websites",
        rows: [{
          rowKey: "website-1",
          fields: [field(
            "website.url",
            "website",
            "url",
            "https://portfolio.example.com",
          )],
        }],
      }],
    }, adapter, AbortSignal.any([]));

    assert.equal(result.kind, "verified", JSON.stringify(result));
    assert.equal(
      await page.locator('[data-automation-id="website-1--website"]').inputValue(),
      "https://portfolio.example.com",
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
        mode: "live",
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

test("recognizes optional Adient social account controls by stable Workday ids", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyExperiencePage">
          <label for="socialNetworkAccounts--linkedInAccount">LinkedIn</label>
          <input id="socialNetworkAccounts--linkedInAccount">
          <label for="socialNetworkAccounts--facebookAccount">Facebook</label>
          <input id="socialNetworkAccounts--facebookAccount">
          <label for="socialNetworkAccounts--twitterAccount">Twitter</label>
          <input id="socialNetworkAccounts--twitterAccount">
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
      { fieldId: "social.linkedin", uiBehavior: "text", required: false },
      { fieldId: "social.facebook", uiBehavior: "text", required: false },
      { fieldId: "social.twitter", uiBehavior: "text", required: false },
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
      mode: "live",
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
      mode: "live",
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
      mode: "live",
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
        mode: "live",
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

test("My Experience native degree select commits the unique exact tenant label", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyExperiencePage">
          <label for="education-1--degree">Degree Required</label>
          <select id="education-1--degree" required>
            <option value="">Select One</option>
            <option value="high-school">(High School Diploma/GED (11 years))</option>
            <option value="bachelors">(Bachelor's Degree (16 years))</option>
          </select>
        </main>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const control = (await adapter.inspect(AbortSignal.any([]))).rows
      .flatMap(({ controls }) => controls)
      .find(({ fieldId }) => fieldId === "education.degree")!;

    await adapter.commit({
      controlId: control.controlId,
      uiBehavior: "select",
      value: "(Bachelor's Degree (16 years))",
    }, AbortSignal.any([]));

    assert.equal(
      (await adapter.inspect(AbortSignal.any([]))).rows
        .flatMap(({ controls }) => controls)
        .find(({ fieldId }) => fieldId === "education.degree")?.readback,
      "(Bachelor's Degree (16 years))",
    );
  } finally {
    await browser.close();
  }
});

test("My Experience unowned degree popup commits one exact field-local option", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyExperiencePage">
          <div data-automation-id="formField-education-degree">
            <button id="education-1--degree" aria-haspopup="listbox"
              aria-expanded="false" aria-required="true">Select One</button>
            <div id="degree-options" hidden>
              <div role="option">(High School Diploma/GED (11 years))</div>
              <div role="option">(Bachelor's Degree (±16 years))</div>
            </div>
          </div>
        </main>
        <script>
          const control = document.querySelector('#education-1--degree');
          const options = document.querySelector('#degree-options');
          control.addEventListener('click', () => {
            options.hidden = false;
            control.setAttribute('aria-expanded', 'true');
          });
          options.addEventListener('click', ({ target }) => {
            if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'option') return;
            control.textContent = target.textContent;
            control.setAttribute('aria-expanded', 'false');
            options.hidden = true;
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const control = (await adapter.inspect(AbortSignal.any([]))).rows
      .flatMap(({ controls }) => controls)
      .find(({ fieldId }) => fieldId === "education.degree")!;

    await adapter.commit({
      controlId: control.controlId,
      uiBehavior: "select",
      value: "(Bachelor's Degree (±16 years))",
    }, AbortSignal.any([]));

    assert.equal(
      (await adapter.inspect(AbortSignal.any([]))).rows
        .flatMap(({ controls }) => controls)
        .find(({ fieldId }) => fieldId === "education.degree")?.readback,
      "(Bachelor's Degree (±16 years))",
    );
  } finally {
    await browser.close();
  }
});

test("My Experience multi-select commits every exact visible skill without comma splitting", async () => {
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
            <div id="skills-options" role="listbox" hidden>
              <div role="option">C++</div>
              <div role="option">REST API</div>
              <div role="option">TypeScript</div>
            </div>
          </div>
        </main>
        <script>
          const input = document.getElementById("skills--skills");
          const listbox = document.getElementById("skills-options");
          const selected = document.getElementById("selected-skills");
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
            selected.append(pill);
            input.value = "";
            listbox.hidden = true;
            input.setAttribute("aria-expanded", "false");
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const options = JSON.stringify(["C++", "REST API", "TypeScript"]);
    const result = await completeWorkdayProfilePage({
      mode: "live",
      pageType: "profile",
fields: [field("skills.values", "skill", "multi_select", options, options)],
      repeatables: [],
    }, adapter, AbortSignal.any([]));

    assert.equal(result.kind, "verified");
    assert.deepEqual(
      await page.locator('[data-automation-id="selectedItem"]').allTextContents(),
      ["C++", "REST API", "TypeScript"],
    );
  } finally {
    await browser.close();
  }
});

test("My Experience field of study opens its prompt and commits an exact option token", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyExperiencePage">
          <div data-automation-id="formField-education-fieldOfStudy">
            <div data-automation-id="multiSelectContainer">
              <input id="education-1--fieldOfStudy" placeholder="Search">
              <div data-automation-id="responsiveMonikerPrompt">
                <span data-automation-id="promptSearchButton"><svg><path></path></svg></span>
              </div>
              <div id="selected"></div>
            </div>
          </div>
        </main>
        <div id="prompt" role="listbox" hidden>
          <div role="option">Computer Science</div>
        </div>
        <script>
          const input = document.querySelector('#education-1--fieldOfStudy');
          const prompt = document.querySelector('#prompt');
          let promptMode = false;
          document.querySelector('[data-automation-id="responsiveMonikerPrompt"] svg')
            .addEventListener('click', () => { promptMode = true; input.value = ''; });
          input.addEventListener('input', () => {
            prompt.hidden = !(promptMode && input.value === 'Computer Science');
          });
          prompt.addEventListener('click', ({ target }) => {
            if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'option') return;
            const pill = document.createElement('div');
            pill.setAttribute('data-automation-id', 'selectedItem');
            pill.textContent = target.textContent;
            document.querySelector('#selected').append(pill);
            input.value = '';
            prompt.hidden = true;
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const control = (await adapter.inspect(AbortSignal.any([]))).rows
      .flatMap(({ controls }) => controls)
      .find(({ fieldId }) => fieldId === "education.field_of_study")!;

    await adapter.commit({
      controlId: control.controlId,
      uiBehavior: "multi_select",
      value: '["Computer Science"]',
    }, AbortSignal.any([]));

    assert.equal(
      (await adapter.inspect(AbortSignal.any([]))).rows
        .flatMap(({ controls }) => controls)
        .find(({ fieldId }) => fieldId === "education.field_of_study")?.readback,
      "Computer Science",
    );
  } finally {
    await browser.close();
  }
});

test("My Experience submits a multi-select search before choosing the exact result", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyExperiencePage">
          <div data-automation-id="formField-skills">
            <div data-automation-id="multiSelectContainer">
              <input id="skills--skills" placeholder="Search">
              <div id="selected"></div>
            </div>
          </div>
        </main>
        <div id="results" role="listbox" hidden></div>
        <script>
          const input = document.querySelector('#skills--skills');
          const results = document.querySelector('#results');
          input.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            results.hidden = false;
            results.innerHTML = '<div role="option"><input type="checkbox" role="checkbox">JavaScript</div>';
          });
          results.addEventListener('click', event => {
            const checkbox = event.target.closest('[role="checkbox"]');
            if (!checkbox) return;
            const pill = document.createElement('div');
            pill.setAttribute('data-automation-id', 'selectedItem');
            pill.textContent = 'JavaScript';
            document.querySelector('#selected').append(pill);
            input.value = '';
            results.hidden = true;
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const options = JSON.stringify(["JavaScript"]);
    const result = await completeWorkdayProfilePage({
      mode: "live",
      pageType: "profile",
fields: [field("skills.values", "skill", "multi_select", options, options)],
      repeatables: [],
    }, adapter, AbortSignal.any([]));

    assert.equal(result.kind, "verified", JSON.stringify(result));
    assert.deepEqual(
      await page.locator('[data-automation-id="selectedItem"]').allTextContents(),
      ["JavaScript"],
    );
  } finally {
    await browser.close();
  }
});

test("My Experience traverses the Workday field-of-study catalog and commits its radio", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyExperiencePage">
          <div data-automation-id="formField-education-fieldOfStudy">
            <div data-automation-id="multiSelectContainer">
              <input id="education-1--fieldOfStudy" placeholder="Search">
              <div id="selected"></div>
            </div>
          </div>
        </main>
        <div id="catalog" role="listbox"></div>
        <script>
          const input = document.querySelector('#education-1--fieldOfStudy');
          const catalog = document.querySelector('#catalog');
          const labels = ['Accounting', 'Business', 'Computer and Information Science'];
          let scopeSelected = false;
          let activeIndex = 0;
          const renderScope = () => {
            catalog.innerHTML = '';
            for (const label of ['Partial List (First 500 Entries)', 'All']) {
              const option = document.createElement('div');
              option.setAttribute('role', 'option');
              option.textContent = label;
              option.addEventListener('click', () => {
                scopeSelected = true;
                catalog.innerHTML = '';
              });
              catalog.append(option);
            }
          };
          const renderCatalog = () => {
            catalog.innerHTML = '';
            const option = document.createElement('div');
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'true');
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.setAttribute('role', 'radio');
            const label = document.createElement('span');
            label.textContent = labels[activeIndex];
            radio.addEventListener('click', () => {
              const pill = document.createElement('div');
              pill.setAttribute('data-automation-id', 'selectedItem');
              pill.textContent = labels[activeIndex];
              document.querySelector('#selected').append(pill);
              input.value = '';
              catalog.innerHTML = '';
            });
            option.append(radio, label);
            catalog.append(option);
          };
          input.addEventListener('click', () => scopeSelected ? renderCatalog() : renderScope());
          input.addEventListener('keydown', event => {
            if (!scopeSelected || event.key !== 'ArrowDown') return;
            event.preventDefault();
            activeIndex = Math.min(activeIndex + 1, labels.length - 1);
            renderCatalog();
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const control = (await adapter.inspect(AbortSignal.any([]))).rows
      .flatMap(({ controls }) => controls)
      .find(({ fieldId }) => fieldId === "education.field_of_study")!;

    await adapter.commit({
      controlId: control.controlId,
      uiBehavior: "multi_select",
      value: '["Computer Science"]',
    }, AbortSignal.any([]));

    assert.equal(
      (await adapter.inspect(AbortSignal.any([]))).rows
        .flatMap(({ controls }) => controls)
        .find(({ fieldId }) => fieldId === "education.field_of_study")?.readback,
      "Computer and Information Science",
    );
  } finally {
    await browser.close();
  }
});

test("My Experience multi-select owns a local Workday prompt without aria-controls", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyExperiencePage">
          <div data-automation-id="formField-skills">
            <div data-automation-id="multiSelectContainer">
              <input id="skills--skills" placeholder="Search">
              <button data-automation-id="promptIcon" type="button">Open</button>
              <div id="selected-skills"></div>
              <div id="skills-options" hidden>
                <div role="option">Python</div>
              </div>
            </div>
          </div>
        </main>
        <script>
          const input = document.getElementById("skills--skills");
          const options = document.getElementById("skills-options");
          const selected = document.getElementById("selected-skills");
          const commit = (label) => {
            const pill = document.createElement("div");
            pill.setAttribute("data-automation-id", "selectedItem");
            pill.textContent = label;
            selected.append(pill);
            input.value = "";
            options.hidden = true;
          };
          document.querySelector('[data-automation-id="promptIcon"]')
            .addEventListener("click", () => options.hidden = false);
          input.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && input.value.trim() !== "") {
              event.preventDefault();
              commit(input.value);
            }
          });
          options.addEventListener("click", (event) => {
            const option = event.target.closest('[role="option"]');
            if (!option) return;
            commit(option.textContent);
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const options = JSON.stringify(["Python"]);
    const result = await completeWorkdayProfilePage({
      mode: "live",
      pageType: "profile",
fields: [field("skills.values", "skill", "multi_select", options, options)],
      repeatables: [],
    }, adapter, AbortSignal.any([]));

    assert.equal(result.kind, "verified", JSON.stringify(result));
    assert.deepEqual(
      await page.locator('[data-automation-id="selectedItem"]').allTextContents(),
      ["Python"],
    );
  } finally {
    await browser.close();
  }
});

test("My Experience multi-select types into its field-local Workday prompt search", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <body data-hunt-profile-page-type="profile">
        <main data-automation-id="applyFlowMyExperiencePage">
          <div data-automation-id="formField-skills">
            <div data-automation-id="multiSelectContainer">
              <input id="skills--skills" placeholder="Search">
              <div data-automation-id="responsiveMonikerPrompt">
                <span data-automation-id="promptSearchButton"><svg></svg></span>
                <input data-automation-id="searchBox" hidden>
              </div>
              <div id="selected-skills"></div>
            </div>
          </div>
        </main>
        <div id="skills-options" hidden><div role="option">Python</div></div>
        <script>
          const prompt = document.querySelector('[data-automation-id="searchBox"]');
          const options = document.querySelector('#skills-options');
          document.querySelector('[data-automation-id="promptSearchButton"]')
            .addEventListener('click', () => prompt.hidden = false);
          prompt.addEventListener('input', () => options.hidden = prompt.value !== 'Python');
          options.addEventListener('click', ({ target }) => {
            if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'option') return;
            const pill = document.createElement('div');
            pill.setAttribute('data-automation-id', 'selectedItem');
            pill.textContent = target.textContent;
            document.querySelector('#selected-skills').append(pill);
            prompt.value = '';
            prompt.hidden = true;
            options.hidden = true;
          });
        </script>
      </body>
    `);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const control = (await adapter.inspect(AbortSignal.any([]))).controls.find(
      ({ fieldId }) => fieldId === "skills.values",
    )!;

    await adapter.commit({
      controlId: control.controlId,
      uiBehavior: "multi_select",
      value: '["Python"]',
    }, AbortSignal.any([]));

    assert.deepEqual(
      await page.locator('[data-automation-id="selectedItem"]').allTextContents(),
      ["Python"],
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

test("captures distinct per-frame owner-control relationships as digests", async () => {
  const frameOne = new StructuralFrame([
    new StructuralElement("formField", "owner-one", [
      new StructuralElement("button", "control-one", []),
      new StructuralElement("input", "control-two", []),
    ]),
  ]);
  const frameTwo = new StructuralFrame([
    new StructuralElement("formField", "owner-two", [
      new StructuralElement("button", "control-three", []),
    ]),
  ]);
  const adapter = new PlaywrightWorkdayProfilePage(new StructuralPage([frameOne, frameTwo]) as never, {
    pageType: "profile",
  });

  await assert.rejects(() => adapter.inspect(new AbortController().signal));

  const facts = adapter.inspectionFacts();
  assert.equal(facts?.frameCount, 2);
  assert.deepEqual(facts?.frameDomOwnerCandidateCounts, [1, 1]);
  assert.deepEqual(facts?.frameControlCandidateCounts, [2, 1]);
  assert.equal(facts?.frameOwnerControlTupleDigests.length, 3);
  assert.equal(new Set(facts?.frameOwnerControlTupleDigests).size, 3);
  assert.equal(facts?.frameOwnerControlRelationshipDigests.length, 2);
  assert.notEqual(
    facts?.frameOwnerControlRelationshipDigests[0],
    facts?.frameOwnerControlRelationshipDigests[1],
  );
  for (const digest of facts?.frameOwnerControlTupleDigests ?? []) {
    assert.match(digest, /^[0-9a-f]{64}$/u);
  }
  assert.doesNotMatch(JSON.stringify(facts), /owner-one|control-one|control-two|control-three/iu);
});

class StructuralElement {
  readonly tagName: string;
  readonly id: string;
  private readonly controls: readonly StructuralElement[];

  constructor(
    tagName: string,
    id: string,
    controls: readonly StructuralElement[],
  ) {
    this.tagName = tagName;
    this.id = id;
    this.controls = controls;
  }

  getAttribute(name: string): string | null {
    return name === "data-automation-id" ? this.id : name === "role" ? "button" : null;
  }

  querySelectorAll(): readonly StructuralElement[] {
    return this.controls;
  }
}

class StructuralLocator {
  private readonly elements: readonly StructuralElement[];
  private readonly visible: boolean;

  constructor(elements: readonly StructuralElement[], visible = true) {
    this.elements = elements;
    this.visible = visible;
  }

  async count(): Promise<number> { return this.elements.length; }
  nth(index: number): StructuralLocator { return new StructuralLocator([this.elements[index]!], this.visible); }
  async isVisible(): Promise<boolean> { return this.visible && this.elements.length === 1; }
  async getAttribute(name: string): Promise<string | null> {
    return this.elements[0]?.getAttribute(name) ?? "wrong";
  }
  async evaluateAll<T>(callback: (elements: readonly StructuralElement[], arg: string) => T, arg: string): Promise<T> {
    return callback(this.elements, arg);
  }
}

class StructuralFrame {
  private readonly owners: readonly StructuralElement[];

  constructor(owners: readonly StructuralElement[]) {
    this.owners = owners;
  }

  locator(selector: string): StructuralLocator {
    if (selector.includes("applyFlow")) return new StructuralLocator([new StructuralElement("main", "root", [])]);
    if (selector.includes("formField")) return new StructuralLocator(this.owners);
    return new StructuralLocator(this.owners.flatMap((owner) => owner.querySelectorAll()));
  }
}

class StructuralPage {
  private readonly pageFrames: readonly StructuralFrame[];

  constructor(pageFrames: readonly StructuralFrame[]) {
    this.pageFrames = pageFrames;
  }

  frames(): readonly StructuralFrame[] { return this.pageFrames; }
  locator(selector: string): StructuralLocator {
    if (selector === "body") return new StructuralLocator([]);
    return this.pageFrames[0]!.locator(selector);
  }
}

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
