import assert from "node:assert/strict";
import { test } from "node:test";

import {
  inspectWorkdayStructure,
  WORKDAY_VERIFICATION_EMAIL_SENT_SELECTORS,
  type WorkdaySemanticAccountInspector,
  type WorkdayStructuralPage,
} from "../../../src/browser/playwright-live/private/workday-structural-catalog.ts";
import { classifyWorkdayAccountNavigation } from "../../../src/browser/playwright-live/private/workday-account-navigation.ts";
import { classifyLiveAccountState } from "../../../src/ats/workday/live/index.ts";

const LIVE_VERIFICATION_REQUIRED_SELECTOR =
  ':text-is("Verify your account before you sign in or request a verification email.")';
const ACCOUNT_CREATED_VERIFICATION_SELECTOR =
  ':text-is("An email has been sent to you. Please verify your account.")';
const SHORT_ACCOUNT_CREATED_VERIFICATION_SELECTOR =
  ':text-is("An email has been sent to you.")';
const PASSWORD_RESET_REQUIRED_SELECTOR =
  '[role="alert"]:has(:text-is("You need to reset your password due to an administrator request. Click Forgot Password to continue."))';
const EMAIL_SIGN_IN_CHOICE_SELECTOR =
  '[data-automation-id="signInContent"]:has([data-automation-id="SignInWithEmailButton"])';
const MODERN_SIGN_IN_SELECTOR =
  '[data-automation-id="signInContent"]:has([data-automation-id="signInSubmitButton"]):has([data-automation-id="createAccountLink"])';
const POSTING_SIGN_IN_SELECTOR = '[data-automation-id="navigationItem-Sign In"]';
const CANDIDATE_HOME_SELECTOR = '[data-automation-id="candidateHomePage"]';

test("the exact posting header Sign In trait stays a job page and enables account-first navigation", async () => {
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () => selector === POSTING_SIGN_IN_SELECTOR ? 1 : 0,
      isVisible: async () => true,
    }),
  };

  const result = await inspectWorkdayStructure(page, true, emptyInspector());

  assert.equal(result.kind, "snapshot");
  const snapshot = result.kind === "snapshot" ? result.snapshot : undefined;
  assert.deepEqual(snapshot?.traitIds, [
    "structural_trait_ats_workday_family_v1",
    "structural_trait_page_job_posting_v1",
    "structural_trait_account_sign_in_v1",
  ]);
  assert.deepEqual(snapshot && classifyWorkdayAccountNavigation(snapshot), {
    kind: "job_posting",
  });
});

test("the exact modern sign-in owner is an account sign-in boundary", async () => {
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () => selector === MODERN_SIGN_IN_SELECTOR ? 1 : 0,
      isVisible: async () => true,
    }),
  };

  const result = await inspectWorkdayStructure(page, false, emptyInspector());

  assert.equal(result.kind, "snapshot");
  const snapshot = result.kind === "snapshot" ? result.snapshot : undefined;
  assert.deepEqual(snapshot?.traitIds, [
    "structural_trait_ats_workday_family_v1",
    "structural_trait_page_account_entry_v1",
    "structural_trait_account_sign_in_v1",
  ]);
  assert.deepEqual(snapshot && classifyWorkdayAccountNavigation(snapshot), {
    kind: "account_boundary",
  });
});

test("an inline verification gate outranks retained sign-in controls", async () => {
  const messages = [
    "An email has been sent to you. Please verify your account.",
    "An email has been sent to you.",
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

test("verification sent selectors admit only the two exact observed variants", () => {
  assert.deepEqual(WORKDAY_VERIFICATION_EMAIL_SENT_SELECTORS, [
    ACCOUNT_CREATED_VERIFICATION_SELECTOR,
    SHORT_ACCOUNT_CREATED_VERIFICATION_SELECTOR,
  ]);
  assert.equal(
    WORKDAY_VERIFICATION_EMAIL_SENT_SELECTORS.some((selector) =>
      selector.includes("has-text") || !selector.startsWith(':text-is("')
    ),
    false,
  );
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

test("the short account-created verification notice outside the sign-in root wins", async () => {
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () => selector === SHORT_ACCOUNT_CREATED_VERIFICATION_SELECTOR ? 1 : 0,
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
      count: async () => selector === '[role="alert"]' ? 1 : 0,
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

test("exact password-recovery pages and alerts classify as recoverable account states", async () => {
  const cases = [
    [PASSWORD_RESET_REQUIRED_SELECTOR, signInInspector(), "password_reset_required"],
    [
      '[data-automation-id="forgotPasswordPage"]:has([data-automation-id="forgotPasswordSubmitButton"])',
      emptyInspector(),
      "password_reset_request",
    ],
    [
      '[data-automation-id="forgotPasswordSubmitButton"]',
      emptyInspector(),
      "password_reset_request",
    ],
    ['[data-automation-id="forgotPasswordConfirmationPage"]', emptyInspector(), "password_reset_email_sent"],
    [
      '[data-automation-id="resetPasswordPage"]:has([data-automation-id="resetPasswordSubmitButton"])',
      emptyInspector(),
      "password_reset_set",
    ],
  ] as const;
  for (const [selector, inspector, expected] of cases) {
  const page: WorkdayStructuralPage = {
      locator: (candidate) => ({
        count: async () => candidate === selector ? 1 : 0,
      isVisible: async () => true,
    }),
  };

    const result = await inspectWorkdayStructure(page, false, inspector);

  assert.equal(result.kind, "snapshot");
    if (result.kind !== "snapshot") continue;
    const state = classifyLiveAccountState("account_entry", result.snapshot.traitIds);
    assert.equal(
      expected === "password_reset_required"
        ? state.kind === "existing_account" && state.accountFact
        : state.kind,
      expected,
    );
  }
});

test("hidden or ambiguous administrator password-reset alerts stay unclassified", async () => {
  for (const [count, visible] of [[1, false], [2, true]] as const) {
    const page: WorkdayStructuralPage = {
      locator: (selector) => ({
        count: async () => selector === PASSWORD_RESET_REQUIRED_SELECTOR ? count : 0,
        isVisible: async () => visible,
      }),
    };

    const result = await inspectWorkdayStructure(page, false, signInInspector());

    assert.equal(result.kind, "snapshot");
    assert.equal(
      result.kind === "snapshot" && result.snapshot.traitIds.includes(
        "structural_trait_account_password_reset_required_v1",
      ),
      false,
    );
  }
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
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () => selector === EMAIL_SIGN_IN_CHOICE_SELECTOR ? 1 : 0,
      isVisible: async () => true,
    }),
  };

  const result = await inspectWorkdayStructure(page, false, emptyInspector());

  assert.equal(result.kind, "snapshot");
  const traits = result.kind === "snapshot" ? result.snapshot.traitIds : [];
  assert.deepEqual(traits, [
    "structural_trait_ats_workday_family_v1",
    "structural_trait_page_account_entry_v1",
    "structural_trait_navigation_email_sign_in_choice_v1",
  ]);
  assert.equal(
    result.kind === "snapshot" &&
      classifyWorkdayAccountNavigation(result.snapshot).kind,
    "email_sign_in_choice",
  );
  assert.equal(classifyLiveAccountState("account_entry", traits).kind, "existing_account");
  assert.equal(traits.includes("structural_trait_account_sign_in_v1"), false);
});

test("an exact Workday provider-choice page is an existing-account entry boundary", async () => {
  const visibleSelectors = new Set([
    '[data-automation-id="authPage"]',
    EMAIL_SIGN_IN_CHOICE_SELECTOR,
  ]);
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () => visibleSelectors.has(selector) ? 1 : 0,
      isVisible: async () => true,
    }),
  };

  const result = await inspectWorkdayStructure(page, false, emptyInspector());

  assert.equal(result.kind, "snapshot");
  const traits = result.kind === "snapshot" ? result.snapshot.traitIds : [];
  assert.deepEqual(traits, [
    "structural_trait_ats_workday_family_v1",
    "structural_trait_page_account_entry_v1",
    "structural_trait_navigation_email_sign_in_choice_v1",
  ]);
  assert.equal(
    result.kind === "snapshot" && classifyWorkdayAccountNavigation(result.snapshot).kind,
    "email_sign_in_choice",
  );
  assert.equal(classifyLiveAccountState("account_entry", traits).kind, "existing_account");
});

test("blank, hidden, or duplicate provider-choice structure stays unresolved", async () => {
  for (const [choiceCount, choiceVisible] of [[0, false], [1, false], [2, true]] as const) {
    const page: WorkdayStructuralPage = {
      locator: (selector) => ({
        count: async () => selector === '[data-automation-id="authPage"]'
          ? 1
          : selector === EMAIL_SIGN_IN_CHOICE_SELECTOR
            ? choiceCount
            : 0,
        isVisible: async () => selector === '[data-automation-id="authPage"]' || choiceVisible,
      }),
    };

    const result = await inspectWorkdayStructure(page, false, emptyInspector());

    assert.equal(result.kind, "snapshot");
    const traits = result.kind === "snapshot" ? result.snapshot.traitIds : [];
    assert.deepEqual(traits, [
      "structural_trait_ats_workday_family_v1",
      "structural_trait_page_account_entry_v1",
    ]);
    assert.equal(classifyLiveAccountState("account_entry", traits).kind, "account_state_unknown");
  }
});

test("a provider choice conflicting with create-account structure stays ambiguous", async () => {
  const visibleSelectors = new Set([
    '[data-automation-id="authPage"]',
    EMAIL_SIGN_IN_CHOICE_SELECTOR,
    '[data-automation-id="createAccountSubmitButton"]',
  ]);
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () => visibleSelectors.has(selector) ? 1 : 0,
      isVisible: async () => true,
    }),
  };

  const result = await inspectWorkdayStructure(page, false, emptyInspector());

  assert.equal(result.kind, "snapshot");
  const traits = result.kind === "snapshot" ? result.snapshot.traitIds : [];
  assert.equal(classifyLiveAccountState("account_entry", traits).kind, "account_state_ambiguous");
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

test("a visible sign-in overlay suppresses its backing candidate page", async () => {
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () =>
        selector === MODERN_SIGN_IN_SELECTOR || selector === CANDIDATE_HOME_SELECTOR
          ? 1
          : 0,
      isVisible: async () => true,
    }),
  };

  const result = await inspectWorkdayStructure(page, false, emptyInspector());

  assert.equal(result.kind, "snapshot");
  const snapshot = result.kind === "snapshot" ? result.snapshot : undefined;
  assert.deepEqual(snapshot?.traitIds, [
    "structural_trait_ats_workday_family_v1",
    "structural_trait_page_account_entry_v1",
    "structural_trait_account_sign_in_v1",
  ]);
  assert.deepEqual(snapshot && classifyWorkdayAccountNavigation(snapshot), {
    kind: "account_boundary",
  });
});

test("a modern sign-in modal over its posting route is an account boundary", async () => {
  const page: WorkdayStructuralPage = {
    locator: (selector) => ({
      count: async () => selector === MODERN_SIGN_IN_SELECTOR ? 1 : 0,
      isVisible: async () => true,
    }),
  };

  const result = await inspectWorkdayStructure(page, true, emptyInspector());

  assert.equal(result.kind, "snapshot");
  const snapshot = result.kind === "snapshot" ? result.snapshot : undefined;
  assert.deepEqual(snapshot && classifyWorkdayAccountNavigation(snapshot), {
    kind: "account_boundary",
  });
});

test("all observed Workday application roots are exact application boundaries", async () => {
  for (const selector of [
    '[data-automation-id="applyFlowMyInfoPage"]',
    '[data-automation-id="applyFlowMyExperiencePage"]',
    '[data-automation-id="applyFlowMyExpPage"]',
    '[data-automation-id="applyFlowPrimaryQuestionsPage"]',
    '[data-automation-id="applyFlowPrimaryQuestionnairePage"]',
    '[data-automation-id="applyFlowApplicationQuestionsPage"]',
    '[data-automation-id="applyFlowVoluntaryDisclosuresPage"]',
    '[data-automation-id="applyFlowSelfIdentifyPage"]',
    '[data-automation-id="applyFlowReviewPage"]',
  ]) {
    const page: WorkdayStructuralPage = {
      locator: (candidate) => ({
        count: async () => candidate === selector ? 1 : 0,
        isVisible: async () => true,
      }),
    };

    const result = await inspectWorkdayStructure(page, false, emptyInspector());

    assert.equal(result.kind, "snapshot");
    if (result.kind !== "snapshot") continue;
    assert.equal(
      result.snapshot.traitIds.some((trait) =>
        trait === "structural_trait_page_profile_step_v1" ||
        trait === "structural_trait_page_questionnaire_v1" ||
        trait === "structural_trait_page_review_step_v1"
      ),
      true,
      selector,
    );
  }
});

function signInInspector(): WorkdaySemanticAccountInspector {
  return {
    inspect: async (control) => ({
      cardinality: control === "password_confirmation" ||
          control === "submit_create_account" ||
          control === "submit_password_reset_request" ||
          control === "submit_password_reset" ||
          control === "show_sign_in"
        ? 0
        : 1,
      actionable: control !== "password_confirmation" &&
        control !== "submit_create_account" &&
        control !== "submit_password_reset_request" &&
        control !== "submit_password_reset" &&
        control !== "show_sign_in",
    }),
  };
}

function createInspector(): WorkdaySemanticAccountInspector {
  return {
    inspect: async (control) => ({
      cardinality: control === "submit_sign_in" || control === "show_create_account" ||
          control === "show_password_reset" || control === "submit_password_reset_request" ||
          control === "submit_password_reset"
        ? 0
        : 1,
      actionable: control !== "submit_sign_in" && control !== "show_create_account" &&
        control !== "show_password_reset" && control !== "submit_password_reset_request" &&
        control !== "submit_password_reset",
    }),
  };
}

function emptyInspector(): WorkdaySemanticAccountInspector {
  return { inspect: async () => ({ cardinality: 0, actionable: false }) };
}
