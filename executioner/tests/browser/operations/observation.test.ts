import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { PlaywrightBrowserSession } from "../../../src/browser/session.ts";
import { dataPage, testIds, testJourneyId } from "../playwright-fixture.ts";

test("observes bounded structural controls without exposing selectors or handles", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const provider = new PlaywrightBrowserSession({ context, ids: testIds("aaaaaaaaaaaaaaaa") });
  try {
    const started = await provider.start({ journeyId: testJourneyId, target: dataPage(`
      <label>Given name <input required data-hunt-target-token="target-given-name"></label>
      <label>Cover letter <textarea data-hunt-target-token="target-cover-letter">hello</textarea></label>
      <label>Start date <input type="date" value="2026-08-01" data-hunt-target-token="target-start-date"></label>
      <fieldset data-field-id="s1-field-work-authorization" data-hunt-target-token="target-s1-field-work-authorization" data-question-id="s1-question-work-authorization" data-question-label="Are you authorized to work in this location?">
        <legend>Are you authorized to work in this location?</legend>
        <label><input data-option-id="s1-option-work-authorization-yes" name="workAuthorization" required type="radio" value="yes" checked>Yes</label>
        <label><input data-option-id="s1-option-work-authorization-no" name="workAuthorization" required type="radio" value="no">No</label>
      </fieldset>
      <label><input type="checkbox" checked data-hunt-target-token="target-authorized"> Authorized</label>
      <label>Country <select data-hunt-target-token="target-country"><option>Canada</option><option selected>United States</option></select></label>
      <div role="listbox" aria-label="Department" data-hunt-target-token="target-department"><div role="option" aria-selected="true">Engineering</div><div role="option">Sales</div></div>
      <label>Resume <input type="file" data-hunt-target-token="target-resume"></label>
      <input data-hunt-target-token="target-sensitive" aria-label="${"é".repeat(600)}">
      <button data-hunt-target-token="target-next">Next</button><button>Submit</button>
    `, "page-profile") }, new AbortController().signal);
    if (!started.ok) throw new Error("start failed");

    const observed = await provider.observe(started.value, new AbortController().signal);
    if (!observed.ok) throw new Error(`observe failed: ${observed.error.code}`);
    assert.equal(observed.value.pageId, "page-profile");
    assert.equal(observed.value.targets.length, 10);
    const byName = new Map<string, (typeof observed.value.targets)[number]>(observed.value.targets.map((target) => [target.name, target]));
    assert.deepEqual(byName.get("Given name")?.control, { kind: "text", element: "input" });
    assert.deepEqual(byName.get("Cover letter")?.control, { kind: "text", element: "textarea" });
    assert.deepEqual(byName.get("Start date")?.control, { kind: "date", element: "input" });
    const radio = byName.get("Are you authorized to work in this location?");
    assert.equal(radio?.token, "target-s1-field-work-authorization");
    assert.deepEqual(radio?.control, {
      kind: "choice",
      element: "input",
      choice: "radio",
      group: "Are you authorized to work in this location?",
      checked: true,
    });
    assert.deepEqual(radio?.readback, { kind: "selected", option: "Yes" });
    assert.deepEqual(byName.get("Authorized")?.readback, { kind: "checked", checked: true });
    assert.deepEqual(byName.get("Country")?.control, { kind: "select", element: "select", options: ["Canada", "United States"] });
    assert.deepEqual(byName.get("Department")?.readback, { kind: "selected", option: "Engineering" });
    assert.deepEqual(byName.get("Resume")?.readback, { kind: "upload", resumeId: null, sha256: null });
    assert.equal(byName.has("Submit"), false);
    const boundedUnicode = observed.value.targets.find((target) => [...target.name].length > 100);
    assert.equal([...(boundedUnicode?.name ?? "")].length, 512);
    assert.equal(boundedUnicode?.token, "target-sensitive");
    assert.equal(JSON.stringify(observed.value).includes("selector"), false);
  } finally {
    if ((await provider.close({ sessionId: "browser_session_aaaaaaaaaaaaaaaa" as never }, new AbortController().signal)).ok) {}
    await context.close();
    await browser.close();
  }
});
