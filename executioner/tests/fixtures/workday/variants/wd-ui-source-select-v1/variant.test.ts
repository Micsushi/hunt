import assert from "node:assert/strict";
import test from "node:test";

import {
  admitContractSnapshot,
  boundedText,
  browserTargetToken,
  fieldId,
  generatedOperationId,
  guardRevision,
  optionId,
} from "../../../../../src/contracts/index.ts";
import { createFieldDriver } from "../../../../../src/interaction/drivers/registry.ts";
import { createFieldVerifier } from "../../../../../src/interaction/verification/field-verifier.ts";
import { createSafetyGuardFake } from "../../../../../src/testing/contracts/index.ts";
import { admittedMutation, testJourneyId } from "../../../../browser/playwright-fixture.ts";
import { frozenVariantFixture, openVariantPage } from "../private.ts";

const fixture = frozenVariantFixture("wd-ui-source-select-v1");

test("WD-UI-SOURCE-SELECT-V1 commits one exact leaf through its owned active listbox", async () => {
  assert.equal(fixture.semanticHash, "sha256.08cc212000db98025bba5d57c72c707bbcd96bd1b2e20add24b2eeae95de49fb");
  assert.deepEqual(fixture.provingSlots, ["WD40-002", "WD40-007"]);
  const variant = await openVariantPage(`
    <div data-automation-id="formField">
      <label id="source-label">How Did You Hear About Us?</label>
      <button role="combobox" aria-labelledby="source-label" aria-controls="source-options"
        aria-expanded="true" data-hunt-target-token="target-source"></button>
      <input id="source-backing" type="hidden">
    </div>
    <div id="source-options" role="listbox" data-automation-id="promptSearchResultList">
      <div role="option" data-value="employee-referral">Employee Referral</div>
      <div role="option" data-value="company-website">Company Website</div>
    </div>
    <script>
      document.querySelectorAll('#source-options [role=option]').forEach(option => option.addEventListener('click', () => {
        document.querySelectorAll('#source-options [role=option]').forEach(item => item.setAttribute('aria-selected', 'false'));
        option.setAttribute('aria-selected', 'true');
        document.querySelector('[role=combobox]').setAttribute('aria-valuetext', option.textContent.trim());
        document.querySelector('#source-backing').value = option.getAttribute('data-value');
      }));
    </script>
  `, "5100000000000000");
  try {
    const before = await variant.observe();
    const source = before.targets.find(({ token }) => token === browserTargetToken("target-source"));
    assert.ok(source !== undefined);
    assert.deepEqual(source.control, {
      kind: "select",
      element: "listbox",
      options: ["Employee Referral", "Company Website"],
    });
    const intent = {
      kind: "choice",
      behavior: "listbox",
      fieldId: fieldId("s3-source"),
      target: browserTargetToken("target-source"),
      optionId: optionId("source-company-website"),
      expectedOption: boundedText("Company Website"),
      provenance: "visible_option",
    } as const;
    const safety = createSafetyGuardFake({
      admit: (request) => admitContractSnapshot(request.input, "safety", request.binding) as never,
    });
    const receipt = await createFieldDriver(variant.browser, safety.port).drive({
      journeyId: testJourneyId,
      sessionId: variant.sessionId,
      pageId: variant.pageId,
      guardRevision: guardRevision("policy-s3-page-ui"),
      operationId: generatedOperationId("operation_5100000000000001"),
      intent,
    }, variant.signal);
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    if (!receipt.ok) throw new Error("Source driver failed");
    const verified = await createFieldVerifier(variant.browser, { maxAttempts: 1 }).verify({
      sessionId: variant.sessionId,
      pageId: variant.pageId,
      intent,
      receipt: receipt.value,
    }, variant.signal);
    assert.deepEqual(verified, { ok: true, value: { kind: "verified", fieldId: "s3-source" } });
    const after = await variant.observe();
    assert.deepEqual(
      after.targets.find(({ token }) => token === browserTargetToken("target-source"))?.readback,
      { kind: "selected", option: "Company Website" },
    );
    assert.equal(await variant.page.locator("#source-backing").inputValue(), "company-website");
  } finally {
    await variant.close();
  }
});

test("WD-UI-SOURCE-SELECT-V1 refuses duplicate exact options without clicking", async () => {
  const variant = await openVariantPage(`
    <button role="combobox" aria-label="Source" aria-controls="duplicate-options"
      aria-expanded="true" data-hunt-target-token="target-source"></button>
    <div id="duplicate-options" role="listbox">
      <div role="option" onclick="globalThis.clicks += 1">Company Website</div>
      <div role="option" onclick="globalThis.clicks += 1">Company Website</div>
    </div>
    <script>globalThis.clicks = 0;</script>
  `, "5200000000000000");
  try {
    await variant.observe();
    const result = await variant.browser.mutate(admittedMutation(
      variant.sessionId,
      variant.pageId,
      { kind: "select", target: browserTargetToken("target-source"), option: "Company Website" as never },
      "5200000000000001",
    ), variant.signal);
    assert.equal(result.ok ? "ok" : result.error.code, "browser_target_ambiguous");
    assert.equal(await variant.page.evaluate(() => (globalThis as typeof globalThis & { clicks: number }).clicks), 0);
  } finally {
    await variant.close();
  }
});

test("WD-UI-SOURCE-SELECT-V1 searches only its owned popup and commits one leaf", async () => {
  const variant = await openVariantPage(`
    <div data-automation-id="formField">
      <input role="combobox" aria-label="Source" aria-controls="searched-options"
        aria-expanded="true" data-hunt-target-token="target-source">
      <input id="source-backing" type="hidden">
    </div>
    <div id="unrelated-options" role="listbox"><div role="option">Company Website</div></div>
    <div id="searched-options" role="listbox"></div>
    <script>
      document.querySelector('[role=combobox]').addEventListener('input', event => {
        const combobox = event.currentTarget;
        document.querySelector('#searched-options').innerHTML =
          '<div role="option" data-automation-id="promptCategory">Company Website</div>' +
          '<div role="option" data-automation-id="promptLeafNode" data-value="company-website">Company Website</div>';
        document.querySelector('[data-automation-id=promptLeafNode]').addEventListener('click', optionEvent => {
          combobox.setAttribute('aria-valuetext', optionEvent.currentTarget.textContent.trim());
          document.querySelector('#source-backing').value = optionEvent.currentTarget.getAttribute('data-value');
        });
      });
    </script>
  `, "5400000000000000");
  try {
    await variant.observe();
    const result = await variant.browser.mutate(admittedMutation(
      variant.sessionId,
      variant.pageId,
      { kind: "select", target: browserTargetToken("target-source"), option: "Company Website" as never },
      "5400000000000001",
    ), variant.signal);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await variant.page.locator("#source-backing").inputValue(), "company-website");
    assert.deepEqual(
      (await variant.observe()).targets.find(({ token }) => token === browserTargetToken("target-source"))?.readback,
      { kind: "selected", option: "Company Website" },
    );
  } finally {
    await variant.close();
  }
});

test("WD-UI-SOURCE-SELECT-V1 opens a closed owned popup and waits for delayed leaves", async () => {
  const variant = await openVariantPage(`
    <input role="combobox" aria-label="Source" aria-controls="delayed-options"
      aria-expanded="false" data-hunt-target-token="target-source">
    <input id="source-backing" type="hidden">
    <script>
      const source = document.querySelector('[role=combobox]');
      source.addEventListener('click', () => {
        if (document.querySelector('#delayed-options')) return;
        const popup = document.createElement('div');
        popup.id = 'delayed-options';
        popup.setAttribute('role', 'listbox');
        document.body.appendChild(popup);
        source.setAttribute('aria-expanded', 'true');
      });
      source.addEventListener('input', () => setTimeout(() => {
        document.querySelector('#delayed-options').innerHTML =
          '<div role="option" data-automation-id="promptLeafNode" data-value="company-website">Company Website</div>';
        document.querySelector('[data-automation-id=promptLeafNode]').addEventListener('click', event => {
          source.setAttribute('aria-valuetext', event.currentTarget.textContent.trim());
          document.querySelector('#source-backing').value = event.currentTarget.getAttribute('data-value');
        });
      }, 40));
    </script>
  `, "5500000000000000");
  try {
    const before = await variant.observe();
    assert.ok(before.targets.some(({ token }) => token === browserTargetToken("target-source")));
    const result = await variant.browser.mutate(admittedMutation(
      variant.sessionId,
      variant.pageId,
      { kind: "select", target: browserTargetToken("target-source"), option: "Company Website" as never },
      "5500000000000001",
    ), variant.signal);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await variant.page.locator("#source-backing").inputValue(), "company-website");
  } finally {
    await variant.close();
  }
});

test("WD-UI-SOURCE-SELECT-V1 never treats an uncommitted search query as selected backing state", async () => {
  const variant = await openVariantPage(`
    <input role="combobox" aria-label="Source" aria-controls="query-options"
      aria-expanded="true" value="Company Website" data-hunt-target-token="target-source">
    <div id="query-options" role="listbox"></div>
  `, "5600000000000000");
  try {
    const source = (await variant.observe()).targets.find(
      ({ token }) => token === browserTargetToken("target-source"),
    );
    assert.deepEqual(source?.readback, { kind: "selected", option: null });
  } finally {
    await variant.close();
  }
});
