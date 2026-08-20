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

test("WD-UI-SCALAR-COMPOSITE-V1 continues past transient checkbox surfaces to the component owner", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-automation-id="checkboxPanel"] { display: block; width: 420px; height: 32px; }
    </style>
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-transient-disability-status">
        <div data-automation-id="checkboxPanel"><input id="transient-yes" type="checkbox"><label for="transient-yes">Yes</label></div>
        <div data-automation-id="checkboxPanel"><input id="transient-no" type="checkbox"><label for="transient-no">No</label></div>
        <div data-automation-id="checkboxPanel"><input id="transient-decline" type="checkbox"><label for="transient-decline">Decline to self-identify</label></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      const selectOnly = input => {
        group.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
          candidate.checked = candidate === input;
        });
      };
      group.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('click', () => {
          setTimeout(() => {
            if (input.dataset.componentAccepted !== 'true') input.checked = false;
          }, 100);
        });
        group.querySelector('label[for="' + input.id + '"]').addEventListener('click', () => {
          selectOnly(input);
          setTimeout(() => {
            if (input.dataset.componentAccepted !== 'true') input.checked = false;
          }, 100);
        });
      });
      group.querySelectorAll('[data-automation-id="checkboxPanel"]').forEach(panel => {
        panel.addEventListener('click', event => {
          if (event.target !== panel) return;
          const input = panel.querySelector('input[type="checkbox"]');
          selectOnly(input);
          input.dataset.componentAccepted = 'true';
          panel.dataset.componentOwnerActivated = 'true';
        });
      });
    </script>
  `, "5950000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-transient-disability-status"),
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
    await variant.page.waitForTimeout(250);
    assert.equal(
      await variant.page.locator('[data-automation-id="checkboxPanel"]:has-text("Decline to self-identify")')
        .getAttribute("data-component-owner-activated"),
      "true",
    );
    assert.equal(await variant.page.locator("#transient-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 activates a left-edge Workday checkbox owner", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-automation-id="checkboxPanel"] { display: block; width: 420px; height: 32px; }
      input[type="checkbox"] { position: absolute; opacity: 0; pointer-events: none; }
    </style>
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-left-edge-disability-status">
        <div data-automation-id="checkboxPanel"><input id="left-yes" type="checkbox"><label for="left-yes">Yes</label></div>
        <div data-automation-id="checkboxPanel"><input id="left-no" type="checkbox"><label for="left-no">No</label></div>
        <div data-automation-id="checkboxPanel"><input id="left-decline" type="checkbox"><label for="left-decline">Decline to self-identify</label></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      const selectOnly = input => {
        group.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
          candidate.checked = candidate === input;
        });
      };
      group.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('click', () => {
          setTimeout(() => {
            if (input.dataset.componentAccepted !== 'true') input.checked = false;
          }, 100);
        });
      });
      group.querySelectorAll('[data-automation-id="checkboxPanel"]').forEach(panel => {
        panel.addEventListener('click', event => {
          const bounds = panel.getBoundingClientRect();
          if (event.clientX - bounds.left > 24) return;
          const input = panel.querySelector('input[type="checkbox"]');
          selectOnly(input);
          input.dataset.componentAccepted = 'true';
          panel.dataset.leftEdgeOwnerActivated = 'true';
        });
      });
    </script>
  `, "5990000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-left-edge-disability-status"),
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
      await variant.page.locator('[data-automation-id="checkboxPanel"]:has-text("Decline to self-identify")')
        .getAttribute("data-left-edge-owner-activated"),
      "true",
    );
    assert.equal(await variant.page.locator("#left-decline").isChecked(), true);
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

test("WD-UI-SCALAR-COMPOSITE-V1 commits a stable native choice through its React owner", async () => {
  const variant = await openVariantPage(`
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-controlled-disability-status">
        <div data-automation-id="checkboxPanel"><input id="controlled-yes" type="checkbox"><label for="controlled-yes">Yes</label></div>
        <div data-automation-id="checkboxPanel"><input id="controlled-no" type="checkbox"><label for="controlled-no">No</label></div>
        <div data-automation-id="checkboxPanel"><input id="controlled-decline" type="checkbox"><label for="controlled-decline">Decline to self-identify</label></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      group.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('click', () => {
          group.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
            candidate.checked = candidate === input;
          });
        });
        Object.defineProperty(input, '__reactProps$controlled', {
          enumerable: true,
          value: {
            onChange: event => { group.dataset.committedOption = event.target.id; },
          },
        });
      });
    </script>
  `, "5980000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-controlled-disability-status"),
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
    await variant.page.locator(
      '[data-automation-id="disabilityStatus-CheckboxGroup"]',
    ).evaluate(owner => {
      const committed = (owner as HTMLElement).dataset.committedOption;
      owner.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => {
        input.checked = input.id === committed;
      });
    });
    assert.equal(
      await variant.page.locator(
        '[data-automation-id="disabilityStatus-CheckboxGroup"]',
      ).getAttribute("data-committed-option"),
      "controlled-decline",
    );
    assert.equal(await variant.page.locator("#controlled-decline").isChecked(), true);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 presents checked state to a controlled React fallback", async () => {
  const variant = await openVariantPage(`
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-react-checked-disability-status">
        <div data-automation-id="checkboxPanel"><input id="react-yes" type="checkbox"><label for="react-yes">Yes</label></div>
        <div data-automation-id="checkboxPanel"><input id="react-no" type="checkbox"><label for="react-no">No</label></div>
        <div data-automation-id="checkboxPanel"><input id="react-decline" type="checkbox"><label for="react-decline">Decline to self-identify</label></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      group.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('click', () => {
          setTimeout(() => {
            if (group.dataset.committedOption !== input.id) input.checked = false;
          }, 100);
        });
        Object.defineProperty(input, '__reactProps$controlledChecked', {
          enumerable: true,
          value: {
            onChange: event => {
              group.dataset.reactTargetChecked = String(event.target.checked);
              if (!event.target.checked) return;
              group.dataset.committedOption = event.target.id;
              group.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
                candidate.checked = candidate === event.target;
              });
            },
          },
        });
      });
    </script>
  `, "5985000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-react-checked-disability-status"),
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
      ).getAttribute("data-react-target-checked"),
      "true",
    );
    assert.equal(
      await variant.page.locator(
        '[data-automation-id="disabilityStatus-CheckboxGroup"]',
      ).getAttribute("data-committed-option"),
      "react-decline",
    );
    assert.equal(await variant.page.locator("#react-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 presents the native checkbox target to a React change handler", async () => {
  const variant = await openVariantPage(`
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-react-native-event-disability-status">
        <div data-automation-id="checkboxPanel"><input id="native-event-yes" type="checkbox"><label for="native-event-yes">Yes</label></div>
        <div data-automation-id="checkboxPanel"><input id="native-event-no" type="checkbox"><label for="native-event-no">No</label></div>
        <div data-automation-id="checkboxPanel"><input id="native-event-decline" type="checkbox"><label for="native-event-decline">Decline to self-identify</label></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      group.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('click', () => {
          setTimeout(() => {
            if (group.dataset.committedOption !== input.id) input.checked = false;
          }, 100);
        });
        Object.defineProperty(input, '__reactProps$controlledNativeEvent', {
          enumerable: true,
          value: {
            checked: false,
            onChange: event => {
              const nativeTarget = event.nativeEvent?.target;
              group.dataset.nativeTargetMatched = String(nativeTarget === event.target);
              if (nativeTarget !== input || nativeTarget.checked !== true) return;
              group.dataset.committedOption = input.id;
              group.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
                candidate.checked = candidate === input;
              });
            },
          },
        });
      });
    </script>
  `, "5985500000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-react-native-event-disability-status"),
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
      ).getAttribute("data-native-target-matched"),
      "true",
    );
    assert.equal(
      await variant.page.locator(
        '[data-automation-id="disabilityStatus-CheckboxGroup"]',
      ).getAttribute("data-committed-option"),
      "native-event-decline",
    );
    assert.equal(await variant.page.locator("#native-event-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 continues from the input host event to its checkbox fiber owner", async () => {
  const variant = await openVariantPage(`
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-react-fiber-owner-disability-status">
        <div data-automation-id="checkboxPanel"><input id="fiber-owner-yes" type="checkbox"><label for="fiber-owner-yes">Yes</label></div>
        <div data-automation-id="checkboxPanel"><input id="fiber-owner-no" type="checkbox"><label for="fiber-owner-no">No</label></div>
        <div data-automation-id="checkboxPanel"><input id="fiber-owner-decline" type="checkbox"><label for="fiber-owner-decline">Decline to self-identify</label></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      group.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('click', () => {
          setTimeout(() => {
            if (group.dataset.committedOption !== input.id) input.checked = false;
          }, 100);
        });
        const hostProps = {
          checked: false,
          onChange: event => {
            group.dataset.hostEventChecked = String(event.target.checked);
          },
        };
        const ownerChange = event => {
          group.dataset.ownerArgument = typeof event + ':' + String(event.target?.checked);
          if (event.target !== input || event.target.checked !== true) return;
          group.dataset.committedOption = input.id;
          hostProps.checked = true;
          group.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
            candidate.checked = candidate === input;
          });
        };
        Object.defineProperty(input, '__reactProps$fiberOwner', {
          enumerable: true,
          value: hostProps,
        });
        Object.defineProperty(input, '__reactFiber$fiberOwner', {
          enumerable: true,
          value: {
            memoizedProps: hostProps,
            return: { memoizedProps: { checked: false, onChange: ownerChange } },
          },
        });
      });
    </script>
  `, "5985750000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-react-fiber-owner-disability-status"),
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
      ).getAttribute("data-host-event-checked"),
      "true",
    );
    assert.equal(
      await variant.page.locator(
        '[data-automation-id="disabilityStatus-CheckboxGroup"]',
      ).getAttribute("data-owner-argument"),
      "object:true",
    );
    assert.equal(
      await variant.page.locator(
        '[data-automation-id="disabilityStatus-CheckboxGroup"]',
      ).getAttribute("data-committed-option"),
      "fiber-owner-decline",
    );
    assert.equal(await variant.page.locator("#fiber-owner-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 presents a resolved boolean to the Workday checkbox owner", async () => {
  const variant = await openVariantPage(`
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-react-boolean-disability-status">
        <div data-automation-id="checkboxPanel"><div id="boolean-yes-owner"><input id="boolean-yes" type="checkbox"></div><label for="boolean-yes">Yes</label></div>
        <div data-automation-id="checkboxPanel"><div id="boolean-no-owner"><input id="boolean-no" type="checkbox"></div><label for="boolean-no">No</label></div>
        <div data-automation-id="checkboxPanel"><div id="boolean-decline-owner"><input id="boolean-decline" type="checkbox"></div><label for="boolean-decline">Decline to self-identify</label></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      group.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('click', () => {
          setTimeout(() => {
            if (group.dataset.committedOption !== input.id) input.checked = false;
          }, 100);
        });
        const owner = input.parentElement;
        Object.defineProperty(owner, '__reactProps$controlledBoolean', {
          enumerable: true,
          value: {
            onChange: checked => {
              group.dataset.ownerArgument = typeof checked + ':' + String(checked);
              if (checked !== true) return;
              group.dataset.committedOption = input.id;
              group.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
                candidate.checked = candidate === input;
              });
            },
          },
        });
      });
    </script>
  `, "5986000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-react-boolean-disability-status"),
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
      ).getAttribute("data-owner-argument"),
      "boolean:true",
    );
    assert.equal(await variant.page.locator("#boolean-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 tries native DOM activation after trusted rollback", async () => {
  const variant = await openVariantPage(`
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-native-after-transient-disability-status">
        <div data-automation-id="checkboxPanel"><input id="native-after-transient-yes" type="checkbox"><label for="native-after-transient-yes">Yes</label></div>
        <div data-automation-id="checkboxPanel"><input id="native-after-transient-no" type="checkbox"><label for="native-after-transient-no">No</label></div>
        <div data-automation-id="checkboxPanel"><input id="native-after-transient-decline" type="checkbox"><label for="native-after-transient-decline">Decline to self-identify</label></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      group.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('click', event => {
          group.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
            candidate.checked = candidate === input;
          });
          if (event.isTrusted) {
            input.dataset.trustedTransient = 'true';
            setTimeout(() => { input.checked = false; }, 100);
            return;
          }
          input.dataset.nativeDomAccepted = 'true';
        });
      });
    </script>
  `, "5987000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-native-after-transient-disability-status"),
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
      await variant.page.locator("#native-after-transient-decline")
        .getAttribute("data-trusted-transient"),
      "true",
    );
    assert.equal(
      await variant.page.locator("#native-after-transient-decline")
        .getAttribute("data-native-dom-accepted"),
      "true",
    );
    assert.equal(await variant.page.locator("#native-after-transient-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 activates the option row outside a no-op checkbox visual", async () => {
  const variant = await openVariantPage(`
    <style>
      .option-row { display: flex; align-items: center; width: 420px; height: 32px; }
      .decorative-owner { width: 24px; }
      .option-copy { flex: 1; }
    </style>
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-option-row-disability-status">
        <div class="option-row"><div class="decorative-owner"><input data-automation-id="checkboxPanel" id="row-yes" type="checkbox" aria-label="Yes"></div><span class="option-copy">Yes</span></div>
        <div class="option-row"><div class="decorative-owner"><input data-automation-id="checkboxPanel" id="row-no" type="checkbox" aria-label="No"></div><span class="option-copy">No</span></div>
        <div class="option-row"><div class="decorative-owner"><input data-automation-id="checkboxPanel" id="row-decline" type="checkbox" aria-label="Decline to self-identify"></div><span class="option-copy">Decline to self-identify</span></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      group.querySelectorAll('.option-row').forEach(row => {
        const input = row.querySelector('input');
        input.addEventListener('click', event => {
          event.stopPropagation();
          setTimeout(() => {
            if (group.dataset.committedOption !== input.id) input.checked = false;
          }, 100);
        });
        Object.defineProperty(input, '__reactProps$noopVisual', {
          enumerable: true,
          value: { checked: false, onChange: () => { input.dataset.noopChange = 'true'; } },
        });
        row.addEventListener('click', () => {
          group.dataset.optionRowActivated = input.id;
          group.dataset.committedOption = input.id;
          group.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
            candidate.checked = candidate === input;
          });
        });
      });
    </script>
  `, "5988000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-option-row-disability-status"),
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
      ).getAttribute("data-option-row-activated"),
      "row-decline",
    );
    assert.equal(await variant.page.locator("#row-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
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

test("WD-UI-SCALAR-COMPOSITE-V1 invokes the index-bound Workday list selection owner", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-uxi-widget-type="multiselectlistitem"] { display: flex; width: 420px; height: 32px; }
    </style>
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-list-selection-owner-disability-status">
        <div data-uxi-widget-type="multiselectlistitem" data-uxi-multiselectlistitem-index="0"><div data-automation-id="checkboxPanel"><input id="selection-owner-yes" type="checkbox" aria-label="Yes"></div><span>Yes</span></div>
        <div data-uxi-widget-type="multiselectlistitem" data-uxi-multiselectlistitem-index="1"><div data-automation-id="checkboxPanel"><input id="selection-owner-no" type="checkbox" aria-label="No"></div><span>No</span></div>
        <div data-uxi-widget-type="multiselectlistitem" data-uxi-multiselectlistitem-index="2"><div data-automation-id="checkboxPanel"><input id="selection-owner-decline" type="checkbox" aria-label="Decline to self-identify"></div><span>Decline to self-identify</span></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      group.querySelectorAll('[data-uxi-widget-type="multiselectlistitem"]').forEach((row, index) => {
        const input = row.querySelector('input');
        input.addEventListener('click', event => {
          event.stopPropagation();
          setTimeout(() => {
            if (group.dataset.committedOption !== input.id) input.checked = false;
          }, 100);
        });
        row.addEventListener('click', () => {
          setTimeout(() => {
            if (group.dataset.committedOption !== input.id) input.checked = false;
          }, 100);
        });
        const hostProps = { checked: false, onChange: () => {} };
        const rowProps = {
          id: input.id,
          index,
          isSelected: false,
          onSelect: (item, event, node) => {
            group.dataset.selectionArgument = [
              String(item === rowProps),
              event.type,
              String(node === row),
            ].join(':');
            if (item !== rowProps || event.type !== 'click' || node !== row) return;
            group.dataset.committedOption = input.id;
            rowProps.isSelected = true;
            hostProps.checked = true;
            group.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
              candidate.checked = candidate === input;
            });
          },
        };
        Object.defineProperty(input, '__reactProps$listSelectionHost', {
          enumerable: true,
          value: hostProps,
        });
        Object.defineProperty(input, '__reactFiber$listSelectionOwner', {
          enumerable: true,
          value: {
            memoizedProps: hostProps,
            return: { memoizedProps: rowProps },
          },
        });
      });
    </script>
  `, "5989500000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-list-selection-owner-disability-status"),
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
      ).getAttribute("data-selection-argument"),
      "true:click:true",
    );
    assert.equal(
      await variant.page.locator(
        '[data-automation-id="disabilityStatus-CheckboxGroup"]',
      ).getAttribute("data-committed-option"),
      "selection-owner-decline",
    );
    assert.equal(await variant.page.locator("#selection-owner-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 invokes the exact Workday list row React host", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-uxi-widget-type="multiselectlistitem"] { display: flex; width: 420px; height: 32px; }
    </style>
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-list-row-react-host-disability-status">
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="row-host-yes" type="checkbox" aria-label="Yes"></div><span>Yes</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="row-host-no" type="checkbox" aria-label="No"></div><span>No</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="row-host-decline" type="checkbox" aria-label="Decline to self-identify"></div><span>Decline to self-identify</span></div>
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
        row.addEventListener('click', event => {
          event.stopPropagation();
          setTimeout(() => {
            if (group.dataset.committedOption !== input.id) input.checked = false;
          }, 100);
        });
        Object.defineProperty(row, '__reactProps$listRowHost', {
          enumerable: true,
          value: {
            onClick: event => {
              group.dataset.rowHostArgument = [event.type, String(event.currentTarget === row)].join(':');
              if (event.type !== 'click' || event.currentTarget !== row) return;
              group.dataset.committedOption = input.id;
              group.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
                candidate.checked = candidate === input;
              });
            },
          },
        });
        Object.defineProperty(input, '__reactProps$listRowNestedCheckbox', {
          enumerable: true,
          value: { checked: false, onChange: () => {} },
        });
      });
    </script>
  `, "5989750000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-list-row-react-host-disability-status"),
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
      ).getAttribute("data-row-host-argument"),
      "click:true",
    );
    assert.equal(await variant.page.locator("#row-host-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 binds an unindexed Workday row by its exact group position", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-uxi-widget-type="multiselectlistitem"] { display: flex; width: 420px; height: 32px; }
    </style>
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-unindexed-list-owner-disability-status">
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="unindexed-yes" type="checkbox" aria-label="Yes"></div><span>Yes</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="unindexed-no" type="checkbox" aria-label="No"></div><span>No</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="unindexed-decline" type="checkbox" aria-label="Decline to self-identify"></div><span>Decline to self-identify</span></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      group.querySelectorAll('[data-uxi-widget-type="multiselectlistitem"]').forEach((row, index) => {
        const input = row.querySelector('input');
        input.addEventListener('click', event => {
          event.stopPropagation();
          setTimeout(() => {
            if (group.dataset.committedOption !== input.id) input.checked = false;
          }, 100);
        });
        row.addEventListener('click', event => {
          event.stopPropagation();
          setTimeout(() => {
            if (group.dataset.committedOption !== input.id) input.checked = false;
          }, 100);
        });
        const hostProps = { checked: false, onChange: () => {} };
        const rowProps = {
          index,
          onSelect: (item, event, node) => {
            group.dataset.unindexedSelectionArgument = [
              String(item === rowProps),
              event.type,
              String(node === row),
            ].join(':');
            if (item !== rowProps || event.type !== 'click' || node !== row) return;
            group.dataset.committedOption = input.id;
            hostProps.checked = true;
            group.querySelectorAll('input[type="checkbox"]').forEach(candidate => {
              candidate.checked = candidate === input;
            });
          },
        };
        Object.defineProperty(input, '__reactProps$unindexedHost', {
          enumerable: true,
          value: hostProps,
        });
        Object.defineProperty(input, '__reactFiber$unindexedOwner', {
          enumerable: true,
          value: {
            memoizedProps: hostProps,
            return: { memoizedProps: rowProps },
          },
        });
      });
    </script>
  `, "5989875000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-unindexed-list-owner-disability-status"),
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
      ).getAttribute("data-unindexed-selection-argument"),
      "true:click:true",
    );
    assert.equal(await variant.page.locator("#unindexed-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SCALAR-COMPOSITE-V1 joins a row index to its shared Workday selection owner", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-uxi-widget-type="multiselectlistitem"] { display: flex; width: 420px; height: 32px; }
    </style>
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-shared-list-owner-disability-status">
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="shared-yes" type="checkbox" aria-label="Yes"></div><span>Yes</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="shared-no" type="checkbox" aria-label="No"></div><span>No</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="shared-decline" type="checkbox" aria-label="Decline to self-identify"></div><span>Decline to self-identify</span></div>
      </fieldset>
    </div>
    <script>
      const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
      const inputs = [...group.querySelectorAll('input[type="checkbox"]')];
      const hostProps = inputs.map(() => ({ checked: false, onChange: () => {} }));
      const sharedProps = {
        onRemove: index => { group.dataset.removedIndex = String(index); },
        onSelect: index => {
          group.dataset.sharedSelectedIndex = String(index);
          if (!Number.isSafeInteger(index) || index < 0 || index >= inputs.length) return;
          hostProps.forEach((props, candidateIndex) => { props.checked = candidateIndex === index; });
          inputs.forEach((input, candidateIndex) => { input.checked = candidateIndex === index; });
        },
      };
      inputs.forEach((input, index) => {
        const row = input.closest('[data-uxi-widget-type="multiselectlistitem"]');
        input.addEventListener('click', event => {
          event.stopPropagation();
          setTimeout(() => {
            if (group.dataset.sharedSelectedIndex !== String(index)) input.checked = false;
          }, 100);
        });
        row.addEventListener('click', event => {
          event.stopPropagation();
          setTimeout(() => {
            if (group.dataset.sharedSelectedIndex !== String(index)) input.checked = false;
          }, 100);
        });
        Object.defineProperty(input, '__reactProps$sharedHost', {
          enumerable: true,
          value: hostProps[index],
        });
        Object.defineProperty(input, '__reactFiber$sharedOwner', {
          enumerable: true,
          value: {
            memoizedProps: hostProps[index],
            return: {
              memoizedProps: { index },
              return: { memoizedProps: sharedProps },
            },
          },
        });
      });
    </script>
  `, "5989900000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-shared-list-owner-disability-status"),
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
      ).getAttribute("data-shared-selected-index"),
      "2",
    );
    assert.equal(await variant.page.locator("#shared-decline").isChecked(), true);
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

test("WD-UI-SCALAR-COMPOSITE-V1 verifies the exact shared option after owner replacement", async () => {
  const variant = await openVariantPage(`
    <style>
      [data-uxi-widget-type="multiselectlistitem"] { display: flex; width: 420px; height: 32px; }
    </style>
    <div data-automation-id="formField-disabilityStatus">
      <span data-automation-id="required">*</span>
      <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
        data-hunt-target-token="target-shared-option-owner-disability-status">
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="option-yes" type="checkbox" aria-label="Yes"></div><span>Yes</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="option-no" type="checkbox" aria-label="No"></div><span>No</span></div>
        <div data-uxi-widget-type="multiselectlistitem"><div data-automation-id="checkboxPanel"><input id="option-decline" type="checkbox" aria-label="Decline to self-identify"></div><span>Decline to self-identify</span></div>
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
        onRemove: option => { group.dataset.removedOption = String(option?.id ?? ''); },
        onSelect: option => {
          const selectedIndex = options.indexOf(option);
          if (selectedIndex < 0) return;
          const replacement = group.cloneNode(true);
          replacement.dataset.selectedOption = String(option?.id ?? '');
          replacement.querySelectorAll('input[type="checkbox"]').forEach((input, candidateIndex) => {
            input.checked = candidateIndex === selectedIndex;
          });
          group.replaceWith(replacement);
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
        Object.defineProperty(input, '__reactProps$sharedOptionHost', {
          enumerable: true,
          value: hostProps[index],
        });
        Object.defineProperty(input, '__reactFiber$sharedOptionOwner', {
          enumerable: true,
          value: {
            memoizedProps: hostProps[index],
            return: {
              memoizedProps: { index, onSelect: sharedProps.onSelect },
              return: { memoizedProps: sharedProps },
            },
          },
        });
      });
    </script>
  `, "5990000000000000");
  try {
    const before = await inspectPage(variant.page, variant.sessionId, variant.pageId, new Map());
    const target = before.targets.get(
      browserTargetToken("target-shared-option-owner-disability-status"),
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
      "option-decline",
    );
    assert.equal(await variant.page.locator("#option-decline").isChecked(), true);
    assert.equal(await variant.page.locator('input[type="checkbox"]:checked').count(), 1);
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
          if (typeof optionId !== 'string') return;
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
