import assert from "node:assert/strict";
import { test } from "node:test";

import {
  inspectWorkdayStructure,
  type WorkdaySemanticAccountInspector,
  type WorkdayStructuralPage,
} from "../../../src/browser/playwright-live/private/workday-structural-catalog.ts";
import { classifyWorkdayAccountNavigation } from "../../../src/browser/playwright-live/private/workday-account-navigation.ts";
import { classifyLiveAccountState } from "../../../src/ats/workday/live/index.ts";

const LIVE_VERIFICATION_REQUIRED_SELECTOR =
  ':text-is("Verify your account before you sign in or request a verification email.")';
const ACCOUNT_CREATED_VERIFICATION_SELECTOR =
  ':text-is("An email has been sent to you. Please verify your account.")';

test("an inline verification gate outranks retained sign-in controls", async () => {
  const messages = [
    "An email has been sent to you. Please verify your account.",
    "verify your account before you sign in",
    "request a verification email",
  ];

  for (const message of messages) {
    const page: WorkdayStructuralPage = {
      locator: (selector) => ({
        count: async () =>
          selector === '[data-automation-id="signInPage"]' ||
            selector.includes(message)
            ? 1
            : 0,
      }),
    };

    const result = await inspectWorkdayStructure(page, false, signInInspector());

    assert.equal(result.kind, "snapshot");
    const traits = result.kind === "snapshot" ? result.snapshot.traitIds : [];
    assert.deepEqual(traits, [
      "structural_trait_ats_workday_family_v1",
      "structural_trait_page_email_verification_v1",
    ]);
    assert.equal(
      classifyLiveAccountState("email_verification", traits).kind,
      "verification_required",
    );
    assert.equal(JSON.stringify(result).includes(message), false);
  }
});

test("the live verification-required alert does not depend on stale sign-in-page ownership", async () => {
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () => selector === LIVE_VERIFICATION_REQUIRED_SELECTOR ? 1 : 0,
      isVisible: async () => true,
    }),
  };

  const result = await inspectWorkdayStructure(page, false, signInInspector());

  assert.equal(result.kind, "snapshot");
  assert.deepEqual(result.kind === "snapshot" ? result.snapshot.traitIds : [], [
    "structural_trait_ats_workday_family_v1",
    "structural_trait_page_email_verification_v1",
  ]);
});

test("an account-created verification notice outside the retained sign-in root wins", async () => {
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () =>
        selector === '[data-automation-id="signInPage"]' ||
          selector === ACCOUNT_CREATED_VERIFICATION_SELECTOR
          ? 1
          : 0,
      isVisible: async () => true,
    }),
  };

  const result = await inspectWorkdayStructure(page, false, signInInspector());

  assert.equal(result.kind, "snapshot");
  assert.deepEqual(result.kind === "snapshot" ? result.snapshot.traitIds : [], [
    "structural_trait_ats_workday_family_v1",
    "structural_trait_page_email_verification_v1",
  ]);
});

test("hidden or ambiguous inline messages do not overclaim verification", async () => {
  for (const [count, visible] of [[1, false], [2, true]] as const) {
    const page: WorkdayStructuralPage = {
      locator: (selector) => ({
        count: async () =>
          selector === '[data-automation-id="signInPage"]'
            ? 1
            : selector.includes("verify your account before you sign in")
              ? count
              : 0,
        isVisible: async () => visible,
      }),
    };

    const result = await inspectWorkdayStructure(page, false, signInInspector());

    assert.equal(result.kind, "snapshot");
    assert.deepEqual(result.kind === "snapshot" ? result.snapshot.traitIds : [], [
      "structural_trait_ats_workday_family_v1",
      "structural_trait_page_account_entry_v1",
      "structural_trait_account_sign_in_v1",
    ]);
  }
});

test("a generic visible alert does not overclaim the semantic account state", async () => {
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () => selector.includes('[role="alert"]') ? 1 : 0,
    }),
  };

  const result = await inspectWorkdayStructure(page, false, signInInspector());

  assert.equal(result.kind, "snapshot");
  assert.deepEqual(result.kind === "snapshot" ? result.snapshot.traitIds : [], [
    "structural_trait_ats_workday_family_v1",
    "structural_trait_page_account_entry_v1",
    "structural_trait_account_sign_in_v1",
  ]);
});

test("only exact Workday account-fact markers produce absence or existence traits", async () => {
  const cases = [
    [
      '[data-automation-id="accountNotFoundError"]',
      "structural_trait_account_absent_v1",
      signInInspector(),
    ],
    [
      '[data-automation-id="accountAlreadyExistsError"]',
      "structural_trait_account_exists_v1",
      createInspector(),
    ],
  ] as const;
  for (const [exactSelector, factTrait, inspector] of cases) {
    const page: WorkdayStructuralPage = {
      locator: (selector) => ({
        count: async () => selector === exactSelector ? 1 : 0,
        isVisible: async () => true,
      }),
    };

    const result = await inspectWorkdayStructure(page, false, inspector);

    assert.equal(result.kind, "snapshot");
    assert.equal(
      result.kind === "snapshot" && result.snapshot.traitIds.includes(factTrait),
      true,
    );
  }
});

test("hidden or ambiguous account-fact markers never become existence evidence", async () => {
  for (const [count, visible] of [[1, false], [2, true]] as const) {
    const page: WorkdayStructuralPage = {
      locator: (selector) => ({
        count: async () => selector === '[data-automation-id="accountNotFoundError"]'
          ? count
          : 0,
        isVisible: async () => visible,
      }),
    };

    const result = await inspectWorkdayStructure(page, false, signInInspector());

    assert.equal(result.kind, "snapshot");
    assert.equal(
      result.kind === "snapshot" && result.snapshot.traitIds.includes(
        "structural_trait_account_absent_v1",
      ),
      false,
    );
  }
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

test("visible email sign-in text alone cannot create a navigation trait", async () => {
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () =>
        selector === '[data-automation-id="authPage"]' ||
          selector === ':text-is("Sign in with email")'
          ? 1
          : 0,
      isVisible: async () => true,
    }),
  };

  const result = await inspectWorkdayStructure(page, false, emptyInspector());

  assert.equal(result.kind, "snapshot");
  assert.deepEqual(result.kind === "snapshot" ? result.snapshot.traitIds : [], [
    "structural_trait_ats_workday_family_v1",
    "structural_trait_page_account_entry_v1",
  ]);
  assert.equal(
    result.kind === "snapshot" &&
      classifyWorkdayAccountNavigation(result.snapshot).kind,
    "invalid",
  );
});

test("a live-shaped standalone email provider choice uses its exact visible owner", async () => {
  const choiceOwner =
    '[data-automation-id="signInContent"]:has([data-automation-id="SignInWithEmailButton"])';
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () => selector === choiceOwner ? 1 : 0,
      isVisible: async () => true,
    }),
  };

  const result = await inspectWorkdayStructure(page, false, emptyInspector());

  assert.equal(result.kind, "snapshot");
  assert.equal(
    result.kind === "snapshot" &&
      classifyWorkdayAccountNavigation(result.snapshot).kind,
    "email_sign_in_choice",
  );
});

test("hidden provider and application markers cannot classify navigation or readiness", async () => {
  const hiddenSelectors = new Set([
    '[data-automation-id="signInContent"]:has([data-automation-id="SignInWithEmailButton"])',
    '[data-automation-id="candidateHomePage"]',
  ]);
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () => hiddenSelectors.has(selector) ? 1 : 0,
      isVisible: async () => false,
    }),
  };

  const result = await inspectWorkdayStructure(page, false, emptyInspector());

  assert.equal(result.kind, "snapshot");
  const snapshot = result.kind === "snapshot" ? result.snapshot : undefined;
  assert.deepEqual(snapshot?.traitIds, ["structural_trait_ats_workday_family_v1"]);
  assert.equal(
    snapshot === undefined ? "invalid" : classifyWorkdayAccountNavigation(snapshot).kind,
    "invalid",
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

function createInspector(): WorkdaySemanticAccountInspector {
  return {
    inspect: async (control) => ({
      cardinality: control === "submit_sign_in" || control === "show_create_account"
        ? 0
        : 1,
      actionable: control !== "submit_sign_in" && control !== "show_create_account",
    }),
  };
}

function emptyInspector(): WorkdaySemanticAccountInspector {
  return { inspect: async () => ({ cardinality: 0, actionable: false }) };
}
