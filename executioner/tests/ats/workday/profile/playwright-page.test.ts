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
