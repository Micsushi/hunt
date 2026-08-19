import assert from "node:assert/strict";
import test from "node:test";

import { applyMutation, inspectPage } from "../../../../../src/browser/adapter.ts";
import {
  admitContractSnapshot,
  boundedText,
  browserTargetToken,
  fieldId,
  generatedOperationId,
  guardRevision,
  optionId,
  type FieldIntent,
} from "../../../../../src/contracts/index.ts";
import { createFieldDriver } from "../../../../../src/interaction/drivers/registry.ts";
import { createFieldVerifier } from "../../../../../src/interaction/verification/field-verifier.ts";
import { createSafetyGuardFake } from "../../../../../src/testing/contracts/index.ts";
import { testJourneyId } from "../../../../browser/playwright-fixture.ts";
import { frozenVariantFixture, openVariantPage } from "../private.ts";

const fixture = frozenVariantFixture("wd-ui-scalar-composite-v1");

test("WD-UI-SCALAR-COMPOSITE-V1 commits phone and composite date with normalized readback", async () => {
  assert.equal(fixture.semanticHash, "sha256.720d8ffd931fd9255304a1eb8a57a3285d9cf3f11f76f065dded6ef96eb454e6");
  assert.deepEqual(fixture.provingSlots, ["WD40-007"]);
  const variant = await openVariantPage(`
    <div data-automation-id="formField">
      <button role="combobox" aria-label="Phone Country Code" aria-controls="phone-countries"
        aria-expanded="true" data-hunt-target-token="target-phone-country"></button>
      <div id="phone-countries" role="listbox">
        <div role="option" data-value="CA">Canada (+1)</div>
        <div role="option" data-value="GB">United Kingdom (+44)</div>
      </div>
      <label>Phone Number <input data-automation-id="phone-number" data-hunt-target-token="target-phone-number"></label>
      <output id="phone-commits">0</output>
    </div>
    <div data-automation-id="dateSection" aria-label="Self Identify Date"
      data-hunt-target-token="target-self-identify-date">
      <input aria-label="Month" data-automation-id="dateSectionMonth" inputmode="numeric">
      <input aria-label="Day" data-automation-id="dateSectionDay" inputmode="numeric">
      <input aria-label="Year" data-automation-id="dateSectionYear" inputmode="numeric">
    </div>
    <script>
      document.querySelector('#phone-countries [data-value=CA]').addEventListener('click', event => {
        event.currentTarget.setAttribute('aria-selected', 'true');
        document.querySelector('[aria-label="Phone Country Code"]').setAttribute('data-selected-label', event.currentTarget.textContent.trim());
      });
      document.querySelector('[data-automation-id="phone-number"]').addEventListener('blur', () => {
        document.querySelector('#phone-commits').value = Number(document.querySelector('#phone-commits').value) + 1;
      });
    </script>
  `, "5300000000000000");
  try {
    const before = await variant.observe();
    for (const name of ["Phone Country Code", "Phone Number", "Self Identify Date"]) {
      assert.ok(before.targets.some((target) => target.name === name), `missing ${name}`);
    }
    const intents: readonly FieldIntent[] = [
      {
        kind: "choice",
        behavior: "listbox",
        fieldId: fieldId("s3-phone-country"),
        target: browserTargetToken("target-phone-country"),
        optionId: optionId("phone-country-canada"),
        expectedOption: boundedText("Canada (+1)"),
        provenance: "visible_option",
      },
      {
        kind: "text",
        behavior: "text",
        fieldId: fieldId("s3-phone-number"),
        target: browserTargetToken("target-phone-number"),
        value: boundedText(" 403 555 0100 "),
        provenance: "owner_provided",
      },
      {
        kind: "date",
        behavior: "date",
        fieldId: fieldId("s3-self-identify-date"),
        target: browserTargetToken("target-self-identify-date"),
        isoDate: "2026-08-05",
        provenance: "owner_provided",
      },
    ];
    const safety = createSafetyGuardFake({
      admit: (request) => admitContractSnapshot(request.input, "safety", request.binding) as never,
    });
    const driver = createFieldDriver(variant.browser, safety.port);
    const verifier = createFieldVerifier(variant.browser, { maxAttempts: 1 });
    for (const [index, intent] of intents.entries()) {
      const receipt = await driver.drive({
        journeyId: testJourneyId,
        sessionId: variant.sessionId,
        pageId: variant.pageId,
        guardRevision: guardRevision("policy-s3-page-ui"),
        operationId: generatedOperationId(`operation_530000000000000${index + 1}`),
        intent,
      }, variant.signal);
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      if (!receipt.ok) throw new Error("scalar driver failed");
      assert.deepEqual(await verifier.verify({
        sessionId: variant.sessionId,
        pageId: variant.pageId,
        intent,
        receipt: receipt.value,
      }, variant.signal), {
        ok: true,
        value: { kind: "verified", fieldId: intent.fieldId },
      });
    }
    const after = await variant.observe();
    const values = new Map(after.targets.map(({ name, readback }) => [String(name), readback] as const));
    assert.deepEqual(values.get("Phone Country Code"), { kind: "selected", option: "Canada (+1)" });
    assert.deepEqual(values.get("Phone Number"), { kind: "text", value: " 403 555 0100 " });
    assert.deepEqual(values.get("Self Identify Date"), { kind: "text", value: "2026-08-05" });
    assert.equal(await variant.page.locator("#phone-commits").textContent(), "1");
    assert.deepEqual(
      await variant.page.locator('[data-automation-id="dateSection"] input').evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value)
      ),
      ["08", "05", "2026"],
    );
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 preflights every date leaf before changing any part", async () => {
  const variant = await openVariantPage(`
    <div data-automation-id="dateSection" aria-label="Self Identify Date"
      data-hunt-target-token="target-self-identify-date">
      <input data-automation-id="dateSectionMonth" value="01">
      <input data-automation-id="dateSectionDay" value="02" disabled>
      <input data-automation-id="dateSectionYear" value="2000">
    </div>
  `, "5700000000000000");
  try {
    const target = (await inspectPage(
      variant.page,
      variant.sessionId,
      variant.pageId,
      new Map(),
    )).targets.get(browserTargetToken("target-self-identify-date"))?.[0];
    assert.ok(target !== undefined);
    assert.equal(await applyMutation(
      variant.page,
      target,
      { kind: "set_date", target: target.token, isoDate: "2026-08-05" },
      undefined,
      500,
    ), "invalid");
    assert.deepEqual(
      await variant.page.locator('[data-automation-id="dateSection"] input').evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value)
      ),
      ["01", "02", "2000"],
    );
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 rebinds a virtualized Workday CheckboxGroup as one exclusive choice", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-automation-id="checkboxPanel"] { display: block; width: 420px; }
      .option { width: 320px; }
      .visual { display: inline-block; width: 18px; height: 18px; }
    </style>
    <div data-automation-id="formField-disabilityStatus">
      <label>Disability Status</label>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-disability-status" aria-required="true">
        <div role="grid">
          <div role="row"><div role="cell"><div data-automation-id="checkboxPanel"><div class="option"><div class="choice-owner"><input id="yes" type="checkbox" checked aria-checked="true" aria-required="true"><span class="visual"></span><div class="decoration"></div></div><label for="yes"><span>Yes</span></label></div></div></div></div>
          <div role="row"><div role="cell"><div data-automation-id="checkboxPanel"><div class="option"><div class="choice-owner"><input id="no" type="checkbox" checked aria-checked="true" aria-required="true"><span class="visual"></span><div class="decoration"></div></div><label for="no"><span>No</span></label></div></div></div></div>
          <div role="row"><div role="cell"><div data-automation-id="checkboxPanel"><div class="option"><div class="choice-owner"><input id="decline" type="checkbox" aria-checked="false" aria-required="true"><span class="visual"></span><div class="decoration"></div></div><label for="decline"><span>Decline to self-identify</span></label></div></div></div></div>
        </div>
      </fieldset>
    </div>
    <script>
      document.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('click', () => {
          input.setAttribute('aria-checked', String(input.checked));
          setTimeout(() => {
            if (input.dataset.componentAccepted !== 'true') {
              input.checked = false;
              input.setAttribute('aria-checked', 'false');
            }
          }, 1600);
        });
        document.querySelector('label[for="' + input.id + '"]').addEventListener('click', () => {
          document.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
            candidate.checked = false;
            candidate.setAttribute('aria-checked', String(candidate.checked));
            delete candidate.dataset.componentAccepted;
          });
        });
      });
      document.querySelectorAll('[data-automation-id="checkboxPanel"]').forEach(panel => {
        panel.addEventListener('click', event => {
          if (event.target !== panel) return;
          const input = panel.querySelector('input[type="checkbox"]');
          input.checked = true;
          input.setAttribute('aria-checked', 'true');
          setTimeout(() => {
            if (input.dataset.componentAccepted !== 'true') {
              input.checked = false;
              input.setAttribute('aria-checked', 'false');
            }
          }, 1600);
        });
      });
      document.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.closest('[data-automation-id="checkboxPanel"]').__reactProps$fixture = {
          onClick: () => {
            document.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
              candidate.checked = candidate === input;
              candidate.setAttribute('aria-checked', String(candidate.checked));
              delete candidate.dataset.componentAccepted;
            });
            input.dataset.componentAccepted = 'true';
            input.closest('[data-automation-id="checkboxPanel"]')
              .dataset.reactActivated = 'true';
            input.closest('[data-automation-id="checkboxPanel"]')
              .dataset.reactEventType = 'click';
            setTimeout(() => {
            const owner = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
            const replacement = owner.cloneNode(true);
            replacement.removeAttribute('data-hunt-target-token');
            replacement.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
              candidate.checked = candidate.id === input.id;
              candidate.setAttribute('aria-checked', String(candidate.checked));
            });
            replacement.querySelectorAll('[data-hunt-option-label], [data-hunt-checkbox-surface]')
              .forEach(element => {
                element.removeAttribute('data-hunt-option-label');
                element.removeAttribute('data-hunt-checkbox-surface');
            });
            owner.replaceWith(replacement);
            }, 0);
          },
        };
      });
    </script>
  `, "5800000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    assert.equal(before.observation.targets.length, 1);
    const target = before.targets.get(browserTargetToken("target-disability-status"))?.[0];
    assert.ok(target !== undefined);
    assert.deepEqual(target.control, {
      kind: "choice",
      element: "input",
      choice: "radio",
      group: "Disability Status",
      checked: false,
    });
    assert.deepEqual(target.radioOptions, ["Yes", "No", "Decline to self-identify"]);
    await variant.page.evaluate(() => {
      document.body.insertAdjacentHTML("afterbegin", '<button type="button">Late control</button>');
      document.querySelectorAll(
        '[data-automation-id="disabilityStatus-CheckboxGroup"] [data-hunt-option-label], ' +
        '[data-automation-id="disabilityStatus-CheckboxGroup"] [data-hunt-checkbox-surface]',
      ).forEach((element) => {
        element.removeAttribute("data-hunt-option-label");
        element.removeAttribute("data-hunt-checkbox-surface");
      });
    });
    assert.equal(await applyMutation(
      variant.page,
      target,
      {
        kind: "select",
        target: target.token,
        option: boundedText("Decline to self-identify"),
      },
      undefined,
      5_000,
    ), "applied");
    await variant.page.locator('[data-automation-id="disabilityStatus-CheckboxGroup"]')
      .evaluate((element) => element.setAttribute(
        'data-hunt-target-token',
        'target-disability-status',
      ));
    const after = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    assert.deepEqual(after.observation.targets[0]?.readback, {
      kind: "selected",
      option: "Decline to self-identify",
    });
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
    assert.equal(
      await variant.page.locator('[data-automation-id="checkboxPanel"]:has-text("Decline to self-identify")')
        .getAttribute('data-react-activated'),
      "true",
    );
    assert.equal(
      await variant.page.locator('[data-automation-id="checkboxPanel"]:has-text("Decline to self-identify")')
        .getAttribute('data-react-event-type'),
      "click",
    );
  } finally {
    await variant.close();
  }
});
