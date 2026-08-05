import assert from "node:assert/strict";
import test from "node:test";

import { isExactWorkdayMaintenancePage } from "../../../../../src/browser/playwright-live/private/workday-structural-catalog.ts";
import { frozenVariantFixture } from "../private.ts";

const fixture = frozenVariantFixture("wd-page-external-state-v1");

test("WD-PAGE-EXTERNAL-STATE-V1 admits only the exact value-free maintenance signature", async () => {
  assert.equal(fixture.semanticHash, "sha256.ae067b70ab976b95fe2c451e37ed494d8616fc6305fc3f8f3e2cfd882ff32cae");
  assert.deepEqual(fixture.provingSlots, [
    "WD40-001", "WD40-003", "WD40-005", "WD40-007", "WD40-014", "WD40-022",
    "WD40-026", "WD40-028", "WD40-033", "WD40-035", "WD40-037",
  ]);
  const signatures = new Set([
    ':text-is("Workday is currently unavailable.")',
    ':text-is("We are experiencing a service interruption.")',
  ]);
  const page = {
    locator: (selector: string) => ({
      count: async () => signatures.has(selector) ? 1 : 0,
      isVisible: async () => true,
    }),
  };
  assert.equal(
    await isExactWorkdayMaintenancePage(page, "https://community.workday.com/maintenance-page?d=5&s=1&e=1&o="),
    true,
  );
  assert.equal(await isExactWorkdayMaintenancePage(page, "https://community.workday.com/other"), false);
  assert.equal(await isExactWorkdayMaintenancePage(page, "https://example.invalid/maintenance-page"), false);
  assert.equal(JSON.stringify({ kind: "posting_unavailable", reason: "maintenance" }).includes("Workday is currently"), false);
});
