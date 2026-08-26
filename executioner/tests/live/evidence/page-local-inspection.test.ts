import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import { createPageLocalInspection } from
  "../../../src/live/evidence/page-local-inspection.ts";

test("page-local inspection retains Workday checkbox ownership and React evidence", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const evidenceRoot = mkdtempSync(join(tmpdir(), "workday-checkbox-inspection-"));
  try {
    await page.setContent(`<!doctype html><html><body>
      <div data-automation-id="formField-disabilityStatus">
        <label>Please check one of the boxes below:<span data-automation-id="required">*</span></label>
        <fieldset data-automation-id="disabilityStatus-CheckboxGroup"
          aria-required="true" aria-owns="disability-help">
          <label><input type="checkbox" aria-label="Yes" checked>Yes</label>
          <label><input type="checkbox" aria-label="No">No</label>
          <label><input type="checkbox" aria-label="I do not want to answer">I do not want to answer</label>
        </fieldset>
      </div>
      <div id="disability-help" role="note">Self-identification help</div>
      <script>
        const group = document.querySelector('[data-automation-id="disabilityStatus-CheckboxGroup"]');
        Object.defineProperty(group, '__reactProps$retainedOwner', {
          enumerable: true,
          value: {
            onSelect: option => option,
            onRemove: option => option,
            options: [
              { id: 'yes', label: 'Yes', required: true },
              { id: 'no', label: 'No', required: true },
              { id: 'decline', label: 'I do not want to answer', required: true },
            ],
          },
        });
      </script>
    </body></html>`);
    const inspection = createPageLocalInspection(evidenceRoot);
    await inspection.prepare(page);
    await page.locator('input[aria-label="No"]').focus();
    await page.locator("fieldset").evaluate((element) =>
      element.setAttribute("aria-invalid", "false")
    );
    await inspection.capture(page);

    const evidence = JSON.parse(readFileSync(
      join(evidenceRoot, "page-local-inspection.json"),
      "utf8",
    )) as {
      readonly evidenceRevision: string;
      readonly ariaSnapshots: readonly string[];
      readonly checkboxGroups: readonly {
        readonly ownerAutomationId: string | null;
        readonly label: string;
        readonly group: {
          readonly automationId: string | null;
          readonly role: string | null;
          readonly requiredMarker: boolean;
          readonly aria: Readonly<Record<string, string | null>>;
          readonly visible: boolean;
          readonly bounds: Readonly<Record<string, number>>;
          readonly inputCount: number;
          readonly checkedCount: number;
          readonly reactLayers: readonly {
            readonly handlers: readonly { readonly name: string; readonly arity: number }[];
          }[];
        };
        readonly inputs: readonly {
          readonly optionLabel: string;
          readonly checked: boolean;
          readonly active: boolean;
        }[];
        readonly ownedPortals: readonly {
          readonly id: string;
          readonly present: boolean;
          readonly tag?: string;
          readonly role?: string | null;
          readonly automationId?: string | null;
          readonly visible?: boolean;
          readonly bounds?: Readonly<Record<string, number>>;
          readonly descendantCount?: number;
        }[];
      }[];
      readonly mutations: readonly { readonly attribute?: string | null }[];
    };
    assert.equal(evidence.evidenceRevision, "s2-page-local-inspection-v2");
    assert.equal(evidence.ariaSnapshots.length, 1);
    assert.equal(evidence.checkboxGroups.length, 1);
    const group = evidence.checkboxGroups[0]!;
    assert.equal(group.ownerAutomationId, "formField-disabilityStatus");
    assert.equal(group.label, "Please check one of the boxes below:*");
    assert.deepEqual(group.group, {
      automationId: "disabilityStatus-CheckboxGroup",
      role: null,
      requiredMarker: true,
      aria: {
        label: null,
        labelledby: null,
        describedby: null,
        controls: null,
        owns: "disability-help",
        invalid: "false",
        required: "true",
      },
      visible: true,
      bounds: group.group.bounds,
      inputCount: 3,
      checkedCount: 1,
      reactLayers: group.group.reactLayers,
    });
    assert.deepEqual(group.inputs.map(({ optionLabel, checked, active }) => ({
      optionLabel, checked, active,
    })), [
      { optionLabel: "Yes", checked: true, active: false },
      { optionLabel: "No", checked: false, active: true },
      { optionLabel: "I do not want to answer", checked: false, active: false },
    ]);
    assert.deepEqual(group.ownedPortals, [{
      id: "disability-help",
      present: true,
      tag: "div",
      role: "note",
      automationId: null,
      visible: true,
      bounds: group.ownedPortals[0]!.bounds,
      descendantCount: 0,
    }]);
    assert.ok(group.group.reactLayers.some(({ handlers }) =>
      handlers.some(({ name, arity }) => name === "onSelect" && arity === 1)
    ));
    assert.ok(evidence.mutations.some(({ attribute }) => attribute === "aria-invalid"));
  } finally {
    await browser.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});
