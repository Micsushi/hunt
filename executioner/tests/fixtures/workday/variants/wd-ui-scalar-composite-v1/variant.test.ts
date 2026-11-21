import assert from "node:assert/strict";
import test from "node:test";

import { applyMutation, inspectPage } from "../../../../../src/browser/adapter.ts";
import { PlaywrightWorkdayApplicationPage } from
  "../../../../../src/ats/workday/application/playwright-page.ts";
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
          <div role="row"><div role="cell"><div data-automation-id="checkboxPanel"><div class="option"><div class="choice-owner"><input id="yes" type="checkbox" checked aria-checked="true"><span class="visual"></span><div class="decoration"></div></div><label for="yes"><span>Yes</span></label></div></div></div></div>
          <div role="row"><div role="cell"><div data-automation-id="checkboxPanel"><div class="option"><div class="choice-owner"><input id="no" type="checkbox" checked aria-checked="true"><span class="visual"></span><div class="decoration"></div></div><label for="no"><span>No</span></label></div></div></div></div>
          <div role="row"><div role="cell"><div data-automation-id="checkboxPanel"><div class="option"><div class="decoration"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div><div class="choice-owner"><input id="decline" type="checkbox" aria-checked="false"><span class="visual"></span><div class="decoration"></div></div><label for="decline"><span>Decline to self-identify</span></label></div></div></div></div>
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
          }, 3000);
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
          }, 3000);
        });
      });
      document.querySelectorAll('input[type="checkbox"]').forEach(input => {
        const panel = input.closest('[data-automation-id="checkboxPanel"]');
        let accepted = false;
        const onClick = () => {
          accepted = !accepted;
          document.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
            candidate.checked = accepted && candidate === input;
            candidate.setAttribute('aria-checked', String(candidate.checked));
            delete candidate.dataset.componentAccepted;
          });
          if (accepted) input.dataset.componentAccepted = 'true';
          panel.dataset.reactActivated = String(accepted);
          panel.dataset.reactEventType = 'click';
          panel.dataset.reactInvocationCount = String(
            Number(panel.dataset.reactInvocationCount ?? '0') + 1
          );
          if (!accepted) return;
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
        };
        panel.__reactProps$fixture = { onClick: () => {
          panel.dataset.decoyInvocationCount = String(
            Number(panel.dataset.decoyInvocationCount ?? '0') + 1
          );
        } };
        input.__reactProps$fixture = { onChange: onClick };
        document.querySelector('label[for="' + input.id + '"]').addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
        }, { capture: true });
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
    const mutationResult = await applyMutation(
      variant.page,
      target,
      {
        kind: "select",
        target: target.token,
        option: boundedText("Decline to self-identify"),
      },
      undefined,
      5_000,
    );
    const preflightProbe = await variant.page.evaluate(() =>
      (document.documentElement as unknown as Record<string, unknown>).__huntCheckboxProbe
    );
    assert.equal(mutationResult, "applied", JSON.stringify(preflightProbe));
    await variant.page.waitForTimeout(3_200);
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
    assert.equal(
      await variant.page.locator('[data-automation-id="checkboxPanel"]:has-text("Decline to self-identify")')
        .getAttribute('data-react-invocation-count'),
      "1",
    );
    assert.equal(
      await variant.page.locator('[data-automation-id="checkboxPanel"]:has-text("Decline to self-identify")')
        .getAttribute('data-decoy-invocation-count'),
      null,
    );
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 prefers the native Workday checkbox owner before decorative surfaces", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-automation-id="checkboxPanel"] { display: block; width: 420px; }
      .visual { display: inline-block; width: 18px; height: 18px; }
    </style>
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-native-disability-status">
        <div data-automation-id="checkboxPanel"><input id="native-yes" type="checkbox"><label for="native-yes">Yes</label></div>
        <div data-automation-id="checkboxPanel"><input id="native-no" type="checkbox"><label for="native-no">No</label></div>
        <div data-automation-id="checkboxPanel"><input id="native-decline" type="checkbox"><label for="native-decline">Decline to self-identify</label><span class="visual"></span></div>
      </fieldset>
    </div>
    <script>
      document.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('click', event => {
          if (event.isTrusted) {
            document.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
              candidate.checked = candidate === input;
            });
            input.dataset.nativeOwnerAccepted = 'true';
            input.dataset.nativeOwnerEvent = event.detail === 0 ? 'keyboard' : 'pointer';
          }
          setTimeout(() => {
            if (input.dataset.nativeOwnerAccepted !== 'true') input.checked = false;
          }, 6000);
        });
        document.querySelector('label[for="' + input.id + '"]').addEventListener('click', () => {
          input.dataset.decorativeSurfaceActivated = 'true';
        });
      });
    </script>
  `, "5850000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-native-disability-status"),
    )?.[0];
    assert.ok(target !== undefined);
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
    await variant.page.waitForTimeout(6_200);
    assert.equal(
      await variant.page.locator("#native-decline").getAttribute("data-native-owner-accepted"),
      "true",
    );
    assert.equal(
      await variant.page.locator("#native-decline").getAttribute("data-native-owner-event"),
      "keyboard",
    );
    assert.equal(
      await variant.page.locator("#native-decline").getAttribute("data-decorative-surface-activated"),
      null,
    );
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 activates a hidden native checkbox through Workday's delegated change owner", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-automation-id="checkboxPanel"] { display: block; width: 420px; }
      input[type="checkbox"] { pointer-events: none; }
      .visual { display: inline-block; width: 18px; height: 18px; }
    </style>
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-hidden-disability-status">
        <div data-automation-id="checkboxPanel"><div class="choice-owner"><input id="hidden-yes" type="checkbox"><span class="visual"></span></div><label for="hidden-yes">Yes</label></div>
        <div data-automation-id="checkboxPanel"><div class="choice-owner"><input id="hidden-no" type="checkbox"><span class="visual"></span></div><label for="hidden-no">No</label></div>
        <div data-automation-id="checkboxPanel"><div class="choice-owner"><input id="hidden-decline" type="checkbox"><span class="visual"></span></div><label for="hidden-decline">Decline to self-identify</label></div>
      </fieldset>
    </div>
    <script>
      document.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('click', event => {
          if (event.isTrusted) {
            setTimeout(() => {
              if (input.dataset.delegatedAccepted !== 'true') input.checked = false;
            }, 1600);
            return;
          }
          document.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
            candidate.checked = candidate === input;
          });
          input.dataset.delegatedAccepted = 'true';
        });
        document.querySelector('label[for="' + input.id + '"]').addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
        }, { capture: true });
      });
      document.querySelectorAll('[data-automation-id="checkboxPanel"]').forEach(panel => {
        panel.addEventListener('click', event => {
          if (event.target !== panel) return;
          const input = panel.querySelector('input[type="checkbox"]');
          input.checked = true;
          setTimeout(() => { input.checked = false; }, 1600);
        });
      });
    </script>
  `, "5900000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-hidden-disability-status"),
    )?.[0];
    assert.ok(target !== undefined);
    assert.equal(await applyMutation(
      variant.page,
      target,
      {
        kind: "select",
        target: target.token,
        option: boundedText("Decline to self-identify"),
      },
      undefined,
      8_000,
    ), "applied");
    assert.equal(
      await variant.page.locator("#hidden-decline").getAttribute("data-delegated-accepted"),
      "true",
    );
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 rejects a delayed controlled rollback before accepting pointer input", async () => {
  const variant = await openVariantPage(`
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-delayed-rollback-disability-status">
        <div data-automation-id="checkboxPanel"><input id="delayed-yes" type="checkbox"><label for="delayed-yes">Yes</label></div>
        <div data-automation-id="checkboxPanel"><input id="delayed-no" type="checkbox"><label for="delayed-no">No</label></div>
        <div data-automation-id="checkboxPanel"><input id="delayed-decline" type="checkbox"><label for="delayed-decline">Decline to self-identify</label></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      group.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('click', event => {
          group.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
            candidate.checked = candidate === input;
          });
          if (event.detail === 0) {
            input.dataset.keyboardOptimistic = 'true';
            setTimeout(() => { input.checked = false; }, 4100);
            return;
          }
          input.dataset.pointerAccepted = 'true';
        });
      });
    </script>
  `, "5970000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-delayed-rollback-disability-status"),
    )?.[0];
    assert.ok(target !== undefined);
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
    assert.equal(
      await variant.page.locator("#delayed-decline").getAttribute("data-keyboard-optimistic"),
      "true",
    );
    assert.equal(
      await variant.page.locator("#delayed-decline").getAttribute("data-pointer-accepted"),
      "true",
    );
    assert.equal(await variant.page.locator("#delayed-decline").isChecked(), true);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 activates the exact Workday multiselect list item", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-uxi-widget-type="multiselectlistitem"] { display: flex; width: 420px; height: 32px; }
    </style>
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-workday-list-item-disability-status">
        <div data-uxi-widget-type="multiselectlistitem"><div><input id="list-item-yes" type="checkbox" aria-label="Yes"></div><span>Yes</span><span>Not Checked</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div><input id="list-item-no" type="checkbox" aria-label="No"></div><span>No</span><span>Not Checked</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div><input id="list-item-decline" type="checkbox" aria-label="Decline to self-identify"></div><span>Decline to self-identify</span><span>Not Checked</span></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      group.querySelectorAll('[data-uxi-widget-type="multiselectlistitem"]').forEach(row => {
        const input = row.querySelector('input');
        input.addEventListener('click', event => {
          event.stopPropagation();
          setTimeout(() => {
            if (group.dataset.committedOption !== input.id) input.checked = false;
          }, 100);
        });
        row.addEventListener('click', () => {
          group.dataset.workdayListItemActivated = input.id;
          group.dataset.committedOption = input.id;
          group.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
            candidate.checked = candidate === input;
          });
        });
      });
    </script>
  `, "5989000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-workday-list-item-disability-status"),
    )?.[0];
    assert.ok(target !== undefined);
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
    assert.equal(
      await variant.page.locator(
        '[data-automation-id="disabilityStatus-CheckboxGroup"]',
      ).getAttribute("data-workday-list-item-activated"),
      "list-item-decline",
    );
    assert.equal(await variant.page.locator("#list-item-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 passes a virtualized row item through nested selection owners", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-uxi-widget-type="multiselectlistitem"] { display: flex; width: 420px; height: 32px; }
    </style>
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-nested-list-owner-disability-status">
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="nested-yes" type="checkbox" aria-label="Yes"></div><span>Yes</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="nested-no" type="checkbox" aria-label="No"></div><span>No</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="nested-decline" type="checkbox" aria-label="Decline to self-identify"></div><span>Decline to self-identify</span></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      const inputs = [...group.querySelectorAll('input[type="checkbox"]')];
      const items = inputs.map((input, index) => ({ optionId: input.id, index }));
      const hostProps = inputs.map(() => ({ checked: false, onChange: () => {} }));
      const outerProps = {
        onRemove: item => { group.dataset.outerRemoved = String(item?.optionId ?? ''); },
        onSelect: item => { group.dataset.outerSelected = String(item?.optionId ?? ''); },
      };
      const innerProps = {
        onRemove: item => { group.dataset.innerRemoved = String(item?.optionId ?? ''); },
        onSelect: item => {
          group.dataset.nestedSelectedItem = String(item?.optionId ?? '');
          const selectedIndex = items.indexOf(item);
          if (selectedIndex < 0) return;
          hostProps.forEach((props, candidateIndex) => { props.checked = candidateIndex === selectedIndex; });
          inputs.forEach((input, candidateIndex) => { input.checked = candidateIndex === selectedIndex; });
        },
      };
      inputs.forEach((input, index) => {
        const row = input.closest('[data-uxi-widget-type="multiselectlistitem"]');
        input.addEventListener('click', event => {
          event.stopPropagation();
          setTimeout(() => {
            if (group.dataset.nestedSelectedItem !== input.id) input.checked = false;
          }, 100);
        });
        row.addEventListener('click', event => {
          event.stopPropagation();
          setTimeout(() => {
            if (group.dataset.nestedSelectedItem !== input.id) input.checked = false;
          }, 100);
        });
        Object.defineProperty(input, '__reactProps$nestedHost', {
          enumerable: true,
          value: hostProps[index],
        });
        Object.defineProperty(input, '__reactFiber$nestedOwner', {
          enumerable: true,
          value: {
            memoizedProps: hostProps[index],
            return: {
              memoizedProps: { data: { items }, index },
              return: {
                memoizedProps: innerProps,
                return: { memoizedProps: outerProps },
              },
            },
          },
        });
      });
    </script>
  `, "5989950000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-nested-list-owner-disability-status"),
    )?.[0];
    assert.ok(target !== undefined);
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
    assert.equal(
      await variant.page.locator(
        '[data-automation-id="disabilityStatus-CheckboxGroup"]',
      ).getAttribute("data-nested-selected-item"),
      "nested-decline",
    );
    assert.equal(await variant.page.locator("#nested-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 commits an Intermountain disability option through the retained group owner", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-uxi-widget-type="multiselectlistitem"] { display: flex; width: 620px; height: 36px; }
    </style>
    <main data-automation-id="applyFlowSelfIdentifyPage">
    <div data-automation-id="formField-disabilityStatus">
      <label>Please check one of the boxes below:<span data-automation-id="required">*</span></label>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-intermountain-disability-status"
        aria-required="true">
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="intermountain-disability-yes" type="checkbox" aria-label="Yes, I have a disability, or have had one in the past"></div><span>Yes, I have a disability, or have had one in the past</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="intermountain-disability-no" type="checkbox" aria-label="No, I do not have a disability and have not had one in the past"></div><span>No, I do not have a disability and have not had one in the past</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="intermountain-disability-decline" type="checkbox" aria-label="I do not want to answer"></div><span>I do not want to answer</span></div>
      </fieldset>
    </div>
    </main>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      const inputs = [...group.querySelectorAll('input[type="checkbox"]')];
      const options = inputs.map(input => ({
        id: input.id,
        label: input.getAttribute('aria-label'),
        required: true,
      }));
      const commit = option => {
        const selectedIndex = options.indexOf(option);
        if (selectedIndex < 0) return;
        return new Promise(() => {
          setTimeout(() => {
            const replacement = group.cloneNode(true);
            replacement.dataset.selectedOption = option.id;
            replacement.querySelectorAll('input[type="checkbox"]').forEach((input, index) => {
              input.checked = index === selectedIndex;
            });
            group.replaceWith(replacement);
          }, 650);
        });
      };
      Object.defineProperty(group, '__reactProps$retainedIntermountainOwner', {
        enumerable: true,
        value: {
          'data-automation-id': 'disabilityStatus-CheckboxGroup',
          onRemove: () => {},
          onSelect: commit,
          error: null,
          value: {},
          options,
          isMultiSelect: false,
          id: 'disabilityStatus',
          'aria-required': true,
        },
      });
      inputs.forEach(input => {
        const hostProps = { checked: false, onChange: () => {} };
        Object.defineProperty(input, '__reactProps$retainedIntermountainInput', {
          enumerable: true,
          value: hostProps,
        });
        Object.defineProperty(input, '__reactFiber$retainedIntermountainInput', {
          enumerable: true,
          value: { memoizedProps: hostProps, return: null },
        });
        input.addEventListener('click', () => {
          setTimeout(() => {
            if (!document.documentElement.contains(group)) return;
            input.checked = false;
          }, 25);
        });
      });
    </script>
  `, "5990000000000000");
  try {
    await variant.observe();
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-intermountain-disability-status"),
    )?.[0];
    assert.ok(target !== undefined);
    assert.deepEqual(target.radioOptions, [
      "Yes, I have a disability, or have had one in the past",
      "No, I do not have a disability and have not had one in the past",
      "I do not want to answer",
    ]);
    const intent: FieldIntent = {
      kind: "choice",
      behavior: "radio",
      fieldId: fieldId("intermountain-disability-status"),
      target: target.token,
      optionId: optionId("intermountain-disability-yes"),
      expectedOption: boundedText("Yes, I have a disability, or have had one in the past"),
      provenance: "visible_option",
    };
    const safety = createSafetyGuardFake({
      admit: (request) => admitContractSnapshot(request.input, "safety", request.binding) as never,
    });
    const driver = createFieldDriver(variant.browser, safety.port);
    const verifier = createFieldVerifier(variant.browser, { maxAttempts: 1 });
    const startedAt = Date.now();
    const receipt = await driver.drive({
      journeyId: testJourneyId,
      sessionId: variant.sessionId,
      pageId: variant.pageId,
      guardRevision: guardRevision("policy-intermountain-disability"),
      operationId: generatedOperationId("operation_5990000000000001"),
      intent,
    }, variant.signal);
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.ok(Date.now() - startedAt < 6_000);
    if (!receipt.ok) throw new Error("Intermountain disability driver failed");
    assert.deepEqual(await verifier.verify({
      sessionId: variant.sessionId,
      pageId: variant.pageId,
      intent,
      receipt: receipt.value,
    }, variant.signal), {
      ok: true,
      value: { kind: "verified", fieldId: intent.fieldId },
    });
    assert.equal(
      await variant.page.locator(
        '[data-automation-id="disabilityStatus-CheckboxGroup"]',
      ).getAttribute("data-selected-option"),
      "intermountain-disability-yes",
    );
    assert.equal(await variant.page.locator("#intermountain-disability-yes").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
    const after = await inspectPage(
      variant.page,
      variant.sessionId,
      variant.pageId,
      new Map(),
    );
    assert.deepEqual(
      after.targets.get(browserTargetToken("target-intermountain-disability-status"))?.[0]
        ?.readback,
      {
        kind: "selected",
        option: "Yes, I have a disability, or have had one in the past",
      },
    );
    const application = await new PlaywrightWorkdayApplicationPage(
      variant.page,
      { timeoutMs: 1_000 },
    ).observe(variant.signal);
    assert.equal(application.ok, true, JSON.stringify(application));
    assert.deepEqual(
      application.ok
        ? application.value.requiredFields.map(({ verification }) => verification)
        : [],
      ["verified"],
    );
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 verifies the exact shared option after owner replacement", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-uxi-widget-type="multiselectlistitem"] { display: flex; width: 420px; height: 32px; }
    </style>
    <div data-automation-id="formField-disabilityStatus"
      data-hunt-exclusive-checkbox-group="true"
      aria-label="Disability status"
      data-hunt-target-token="target-shared-option-owner-disability-status">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup">
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="option-yes" type="checkbox" aria-label="Yes"></div><span>Yes</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="option-no" type="checkbox" aria-label="No"></div><span>No</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="option-decline" type="checkbox" aria-label="Decline to self-identify"></div><span>Decline to self-identify</span></div>
      </fieldset>
    </div>
    <fieldset data-automation-id="disabilityStatus-CheckboxGroup" hidden>
      <input type="checkbox" aria-label="Decline to self-identify">
    </fieldset>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      const inputs = [...group.querySelectorAll('input[type="checkbox"]')];
      const options = inputs.map((input, index) => ({
        id: input.id,
        label: input.getAttribute('aria-label'),
        required: index === 2,
      }));
      const hostProps = inputs.map(() => ({ checked: false, onChange: () => {} }));
      group.dataset.trustedClickCount = '0';
      const sharedProps = {
        'data-automation-id': 'disabilityStatus',
        onRemove: option => { group.dataset.removedOption = String(option?.id ?? ''); },
        onSelect: option => {
          const selectedIndex = options.indexOf(option);
          if (selectedIndex < 0) return;
          setTimeout(() => {
            const replacement = group.cloneNode(true);
            replacement.dataset.selectedOption = String(option?.id ?? '');
            replacement.querySelectorAll('input[type="checkbox"]').forEach((input, candidateIndex) => {
              input.checked = candidateIndex === selectedIndex;
            });
            group.replaceWith(replacement);
          }, 250);
        },
        value: {},
        options,
        isMultiSelect: false,
        id: 'disabilityStatus',
        'aria-required': true,
      };
      inputs.forEach((input, index) => {
        const row = input.closest('[data-uxi-widget-type="multiselectlistitem"]');
        input.addEventListener('click', event => {
          group.dataset.trustedClickCount = String(Number(group.dataset.trustedClickCount) + 1);
          event.stopPropagation();
          setTimeout(() => {
            if (group.dataset.selectedOption !== input.id) input.checked = false;
          }, 100);
        });
        row.addEventListener('click', event => {
          group.dataset.trustedClickCount = String(Number(group.dataset.trustedClickCount) + 1);
          event.stopPropagation();
          setTimeout(() => {
            if (group.dataset.selectedOption !== input.id) input.checked = false;
          }, 100);
        });
        Object.defineProperty(input, '__reactProps$sharedOptionHost', {
          enumerable: true,
          value: hostProps[index],
        });
        Object.defineProperty(input, '__reactFiber$sharedOptionOwner', {
          enumerable: true,
          value: {
            memoizedProps: hostProps[index],
            return: {
              memoizedProps: null,
              return: {
                memoizedProps: { index, onSelect: sharedProps.onSelect },
                return: { memoizedProps: sharedProps },
              },
            },
          },
        });
      });
      const nativeClosest = Element.prototype.closest;
      Element.prototype.closest = function(selector) {
        const result = nativeClosest.call(this, selector);
        if (
          window.__huntArmCheckboxRemount === true &&
          this.id === 'option-decline' &&
          selector.includes('CheckboxGroup')
        ) {
          window.__huntArmCheckboxRemount = false;
          queueMicrotask(() => {
            group.closest('[data-automation-id="formField-disabilityStatus"]')
              .removeAttribute('data-hunt-target-token');
            inputs.forEach(input => input.removeAttribute('aria-label'));
          });
        }
        return result;
      };
    </script>
  `, "5990000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-shared-option-owner-disability-status"),
    )?.[0];
    assert.ok(target !== undefined);
    assert.deepEqual(target.radioOptions, ["Yes", "No", "Decline to self-identify"]);
    assert.equal(target.control.kind, "choice");
    assert.equal(target.control.kind === "choice" ? target.control.choice : undefined, "radio");
    assert.equal(target.interaction, "exclusive-checkbox-group");
    await variant.page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__huntArmCheckboxRemount = true;
      document.querySelector('#option-decline')?.removeAttribute('aria-label');
      document.querySelector('[data-automation-id="formField-disabilityStatus"]')
        ?.removeAttribute('data-hunt-target-token');
    });
    const reboundGroup = variant.page.locator(
      '[data-automation-id$="-CheckboxGroup"]:visible',
    );
    assert.equal(await reboundGroup.count(), 1);
    assert.equal(await reboundGroup.locator('input[type="checkbox"]').count(), 3);
    const mutationResult = await applyMutation(
      variant.page,
      target,
      {
        kind: "select",
        target: target.token,
        option: boundedText("Decline to self-identify"),
      },
      undefined,
      5_000,
    );
    const preflightProbe = await variant.page.evaluate(() =>
      (document.documentElement as unknown as Record<string, unknown>).__huntCheckboxProbe
    );
    assert.equal(mutationResult, "applied", JSON.stringify(preflightProbe));
    assert.equal(
      await variant.page.locator(
        '[data-automation-id="disabilityStatus-CheckboxGroup"]:visible',
      ).getAttribute("data-selected-option"),
      "option-decline",
    );
    assert.equal(await variant.page.locator("#option-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
    assert.equal(
      await variant.page.locator(
        '[data-automation-id="disabilityStatus-CheckboxGroup"]:visible',
      ).getAttribute("data-trusted-click-count"),
      "0",
    );
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 supports a shared owner that selects by exact option id", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-uxi-widget-type="multiselectlistitem"] { display: flex; width: 420px; height: 32px; }
    </style>
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-shared-id-owner-disability-status">
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="id-option-yes" type="checkbox" aria-label="Yes"></div><span>Yes</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="id-option-no" type="checkbox" aria-label="No"></div><span>No</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="id-option-decline" type="checkbox" aria-label="Decline to self-identify"></div><span>Decline to self-identify</span></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      const inputs = [...group.querySelectorAll('input[type="checkbox"]')];
      const options = inputs.map((input, index) => ({
        id: input.id,
        label: input.getAttribute('aria-label'),
        required: index === 2,
      }));
      const hostProps = inputs.map(() => ({ checked: false, onChange: () => {} }));
      const sharedProps = {
        'data-automation-id': 'disabilityStatus',
        onRemove: optionId => { group.dataset.removedOption = String(optionId ?? ''); },
        onSelect: optionId => {
          if (typeof optionId !== 'string') {
            inputs[2].checked = true;
            setTimeout(() => { inputs[2].checked = false; }, 1200);
            return;
          }
          const selectedIndex = options.findIndex(option => option.id === optionId);
          if (selectedIndex < 0) return;
          const replacement = group.cloneNode(true);
          replacement.dataset.selectedOption = optionId;
          replacement.querySelectorAll('input[type="checkbox"]').forEach((input, candidateIndex) => {
            input.checked = candidateIndex === selectedIndex;
          });
          group.replaceWith(replacement);
        },
        value: new Set(),
        options,
        isMultiSelect: false,
        id: 'disabilityStatus',
      };
      inputs.forEach((input, index) => {
        const row = input.closest('[data-uxi-widget-type="multiselectlistitem"]');
        input.addEventListener('click', event => {
          event.stopPropagation();
          setTimeout(() => {
            if (group.dataset.selectedOption !== input.id) input.checked = false;
          }, 100);
        });
        row.addEventListener('click', event => {
          event.stopPropagation();
          setTimeout(() => {
            if (group.dataset.selectedOption !== input.id) input.checked = false;
          }, 100);
        });
        Object.defineProperty(input, '__reactProps$sharedIdHost', {
          enumerable: true,
          value: hostProps[index],
        });
        Object.defineProperty(input, '__reactFiber$sharedIdOwner', {
          enumerable: true,
          value: {
            memoizedProps: hostProps[index],
            return: { memoizedProps: sharedProps },
          },
        });
      });
    </script>
  `, "5990000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-shared-id-owner-disability-status"),
    )?.[0];
    assert.ok(target !== undefined);
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
    assert.equal(
      await variant.page.locator(
        '[data-automation-id="disabilityStatus-CheckboxGroup"]',
      ).getAttribute("data-selected-option"),
      "id-option-decline",
    );
    assert.equal(await variant.page.locator("#id-option-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await variant.close();
  }
});
