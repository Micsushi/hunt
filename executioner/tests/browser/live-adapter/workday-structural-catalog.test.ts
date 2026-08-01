import assert from "node:assert/strict";
import { test } from "node:test";

import {
  inspectWorkdayStructure,
  type WorkdaySemanticAccountInspector,
  type WorkdayStructuralPage,
} from "../../../src/browser/playwright-live/private/workday-structural-catalog.ts";

const visibleAccountErrorSelector = ':is([role="alert"], [data-automation-id="errorMessage"], [data-automation-id="inputAlert"]):visible';

test("visible account errors add one value-free fixed structural trait", async () => {
  const inspectedSelectors: string[] = [];
  const page: WorkdayStructuralPage = {
    locator: (selector) => {
      inspectedSelectors.push(selector);
      return {
        count: async () => selector === visibleAccountErrorSelector ? 1 : 0,
      };
    },
  };

  const result = await inspectWorkdayStructure(page, false, signInInspector());

  assert.equal(result.kind, "snapshot");
  assert.deepEqual(result.kind === "snapshot" ? result.snapshot.traitIds : [], [
    "structural_trait_ats_workday_family_v1",
    "structural_trait_page_account_entry_v1",
    "structural_trait_account_sign_in_v1",
    "structural_trait_account_visible_error_v1",
  ]);
  assert.equal(inspectedSelectors.includes(visibleAccountErrorSelector), true);
  assert.doesNotMatch(
    visibleAccountErrorSelector,
    /wrong|locked|password|email address|https?:|href|text\s*=/iu,
  );
});

test("normal noCaptcha ownership alone never creates a CAPTCHA trait", async () => {
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () => selector === '[data-automation-id="noCaptchaWrapper"]' ? 1 : 0,
    }),
  };

  const result = await inspectWorkdayStructure(page, false, signInInspector());

  assert.equal(result.kind, "snapshot");
  assert.equal(
    result.kind === "snapshot" &&
      result.snapshot.traitIds.includes("structural_trait_challenge_captcha_v1"),
    false,
  );
});

function signInInspector(): WorkdaySemanticAccountInspector {
  return {
    inspect: async (control) => ({
      cardinality: control === "password_confirmation" ||
          control === "submit_create_account" ||
          control === "show_sign_in"
        ? 0
        : 1,
      actionable: control !== "password_confirmation" &&
        control !== "submit_create_account" &&
        control !== "show_sign_in",
    }),
  };
}
