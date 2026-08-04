import type {
  AccountActionIntent,
  AccountFieldName,
  SemanticControlFact,
} from "./account-page-types.ts";
import type { ValueFreeOwnedPageSnapshot } from "./types.ts";

interface CountableLocator {
  count(): Promise<number>;
  isVisible?(): Promise<boolean>;
}

export interface WorkdayStructuralPage {
  locator(selector: string): CountableLocator;
}

export interface WorkdaySemanticAccountInspector {
  inspect(
    control: AccountFieldName | AccountActionIntent,
  ): Promise<SemanticControlFact>;
}

interface TraitRule {
  readonly traitId: string;
  readonly selector: string;
}

interface UnavailableRule {
  readonly reason:
    | "not_found"
    | "closed"
    | "removed"
    | "unavailable"
    | "maintenance"
    | "runtime_error";
  readonly selector: string;
}

const pageRules = Object.freeze([
  rule("structural_trait_navigation_apply_choice_v1", '[data-automation-id="applyManually"]'),
  rule("structural_trait_navigation_apply_choice_v1", '[data-automation-id="applyManuallyButton"]'),
  rule("structural_trait_navigation_apply_choice_v1", 'a[href$="/apply/applyManually"]'),
  rule("structural_trait_page_account_entry_v1", '[data-automation-id="createAccountPage"]'),
  rule("structural_trait_page_account_entry_v1", '[data-automation-id="signInPage"]'),
  rule("structural_trait_page_account_entry_v1", '[data-automation-id="authPage"]'),
  rule(
    "structural_trait_navigation_email_sign_in_choice_v1",
    '[data-automation-id="signInContent"]:has([data-automation-id="SignInWithEmailButton"])',
  ),
  rule("structural_trait_page_email_verification_v1", '[data-automation-id="emailVerificationPage"]'),
  rule("structural_trait_page_email_verification_v1", '[data-automation-id="verifyEmailPage"]'),
  rule("structural_trait_page_candidate_home_v1", '[data-automation-id="candidateHomePage"]'),
  rule("structural_trait_page_profile_step_v1", '[data-automation-id="applyFlowMyInfoPage"]'),
  rule("structural_trait_page_questionnaire_v1", '[data-automation-id="applyFlowApplicationQuestionsPage"]'),
  rule("structural_trait_page_review_step_v1", '[data-automation-id="applyFlowReviewPage"]'),
] satisfies readonly TraitRule[]);

export const WORKDAY_INLINE_VERIFICATION_SELECTORS = Object.freeze([
  '[data-automation-id="signInPage"]:has-text("An email has been sent to you. Please verify your account.")',
  ':text-is("An email has been sent to you. Please verify your account.")',
  '[data-automation-id="signInPage"]:has-text("verify your account before you sign in")',
  '[data-automation-id="signInPage"]:has-text("request a verification email")',
  ':text-is("Verify your account before you sign in or request a verification email.")',
]);

export const WORKDAY_ACCOUNT_FACT_SELECTORS = Object.freeze({
  absent: '[data-automation-id="accountNotFoundError"]',
  exists: '[data-automation-id="accountAlreadyExistsError"]',
});

export const WORKDAY_SIGN_IN_REJECTION_SELECTORS = Object.freeze({
  credentialsOrLocked:
    ':text-is("You may have entered the wrong email address or password or your account might be locked.")',
});

const accountRules = Object.freeze([
  rule("structural_trait_account_sign_in_v1", '[data-automation-id="signInPage"]'),
  rule("structural_trait_account_sign_in_v1", '[data-automation-id="signInSubmitButton"]'),
  rule("structural_trait_account_create_v1", '[data-automation-id="createAccountPage"]'),
  rule("structural_trait_account_create_v1", '[data-automation-id="createAccountSubmitButton"]'),
] satisfies readonly TraitRule[]);

const accountFactRules = Object.freeze([
  rule("structural_trait_account_absent_v1", WORKDAY_ACCOUNT_FACT_SELECTORS.absent),
  rule("structural_trait_account_exists_v1", WORKDAY_ACCOUNT_FACT_SELECTORS.exists),
] satisfies readonly TraitRule[]);

const challengeRules = Object.freeze([
  rule("structural_trait_challenge_captcha_v1", '[data-automation-id="captchaChallenge"]'),
  rule("structural_trait_challenge_captcha_v1", 'iframe[title="reCAPTCHA"]'),
  rule("structural_trait_challenge_captcha_v1", 'iframe[title="hCaptcha"]'),
  rule("structural_trait_challenge_mfa_v1", '[data-automation-id="mfaChallenge"]'),
  rule("structural_trait_challenge_access_control_v1", '[data-automation-id="accessDeniedPage"]'),
  rule("structural_trait_challenge_access_control_v1", '[data-automation-id="securityChallenge"]'),
] satisfies readonly TraitRule[]);

const unavailableRules = Object.freeze([
  unavailable("not_found", '[data-automation-id="jobNotFoundPage"]'),
  unavailable("not_found", ':text-is("The page you are looking for doesn\'t exist.")'),
  unavailable("not_found", ':text-is("The page you are looking for doesn’t exist.")'),
  unavailable("closed", '[data-automation-id="jobClosedPage"]'),
  unavailable("removed", '[data-automation-id="jobRemovedPage"]'),
  unavailable("unavailable", '[data-automation-id="jobUnavailablePage"]'),
] satisfies readonly UnavailableRule[]);

const maintenanceSelectors = Object.freeze([
  ':text-is("Workday is currently unavailable.")',
  ':text-is("We are experiencing a service interruption.")',
]);

export const WORKDAY_RUNTIME_ERROR_SELECTORS = Object.freeze([
  ':text-is("Something went wrong")',
  ':text-is("Please refresh the page and then try again.")',
]);

const controlSelector = 'input:not([type="hidden"]), textarea, select, [role="combobox"], [role="radio"], [role="checkbox"]';
const requiredSelector = '[required], [aria-required="true"]';
const optionSelector = '[role="option"]';

export async function inspectWorkdayStructure(
  page: WorkdayStructuralPage,
  routeIsPosting: boolean,
  account: WorkdaySemanticAccountInspector,
): Promise<
  | { readonly kind: "snapshot"; readonly snapshot: ValueFreeOwnedPageSnapshot }
  | {
      readonly kind: "posting_unavailable";
      readonly reason: UnavailableRule["reason"];
    }
  | { readonly kind: "ambiguous" }
> {
  const unavailableFacts = await matchingUnavailable(page);
  if (unavailableFacts.length > 1) return { kind: "ambiguous" };
  if (unavailableFacts.length === 1) {
    return { kind: "posting_unavailable", reason: unavailableFacts[0]! };
  }

  const traitIds = ["structural_trait_ats_workday_family_v1"];
  if (routeIsPosting) traitIds.push("structural_trait_page_job_posting_v1");
  const inlineVerification = await anyExactVisible(
    page,
    WORKDAY_INLINE_VERIFICATION_SELECTORS,
  );
  if (inlineVerification) {
    traitIds.push("structural_trait_page_email_verification_v1");
  }
  const rules = [
    ...pageRules,
    ...(inlineVerification ? [] : accountRules),
    ...challengeRules,
  ];
  for (const rule of rules) {
    if (
      inlineVerification &&
      rule.traitId === "structural_trait_page_account_entry_v1"
    ) continue;
    if (await anyExactVisible(page, [rule.selector])) traitIds.push(rule.traitId);
  }
  if (!inlineVerification) {
    for (const rule of accountFactRules) {
      if (await anyExactVisible(page, [rule.selector])) traitIds.push(rule.traitId);
    }
  }
  const semanticAccount = inlineVerification
    ? undefined
    : await inspectSemanticAccount(account);
  if (semanticAccount !== undefined) {
    const pageTrait = "structural_trait_page_account_entry_v1";
    if (!traitIds.includes(pageTrait)) {
      const accountTraitIndex = traitIds.findIndex((trait) =>
        trait.startsWith("structural_trait_account_")
      );
      if (accountTraitIndex < 0) traitIds.push(pageTrait);
      else traitIds.splice(accountTraitIndex, 0, pageTrait);
    }
    traitIds.push(
      semanticAccount === "create"
        ? "structural_trait_account_create_v1"
        : "structural_trait_account_sign_in_v1",
    );
  }
  const controlCount = await boundedCount(page, controlSelector);
  const requiredControlCount = Math.min(
    controlCount,
    await boundedCount(page, requiredSelector),
  );
  return {
    kind: "snapshot",
    snapshot: Object.freeze({
      schemaVersion: 1,
      traitIds: Object.freeze([...new Set(traitIds)]),
      controlCount,
      requiredControlCount,
      optionCount: await boundedCount(page, optionSelector),
    }),
  };
}

export async function isExactWorkdayMaintenancePage(
  page: WorkdayStructuralPage,
  value: string,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "community.workday.com" ||
    url.port !== "" ||
    url.pathname !== "/maintenance-page" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) return false;
  for (const selector of maintenanceSelectors) {
    if (!await anyExactVisible(page, [selector])) return false;
  }
  return true;
}

export async function isExactWorkdayRuntimeErrorPage(
  page: WorkdayStructuralPage,
): Promise<boolean> {
  for (const selector of WORKDAY_RUNTIME_ERROR_SELECTORS) {
    if (!await anyExactVisible(page, [selector])) return false;
  }
  return true;
}

async function inspectSemanticAccount(
  account: WorkdaySemanticAccountInspector,
): Promise<"create" | "sign_in" | undefined> {
  const email = await account.inspect("email");
  const password = await account.inspect("password");
  const confirmation = await account.inspect("password_confirmation");
  const create = await account.inspect("submit_create_account");
  const signIn = await account.inspect("submit_sign_in");
  const showSignIn = await account.inspect("show_sign_in");
  const showCreate = await account.inspect("show_create_account");
  if (!exactActionable(email) || !exactActionable(password)) return undefined;
  if (
    exactActionable(confirmation) &&
    exactActionable(create) &&
    exactActionable(showSignIn)
  ) return "create";
  if (
    confirmation.cardinality === 0 &&
    exactActionable(signIn) &&
    exactActionable(showCreate)
  ) return "sign_in";
  return undefined;
}

function exactActionable(fact: SemanticControlFact): boolean {
  return fact.cardinality === 1 && fact.actionable;
}

async function matchingUnavailable(
  page: WorkdayStructuralPage,
): Promise<Array<UnavailableRule["reason"]>> {
  const facts = new Set<UnavailableRule["reason"]>();
  for (const rule of unavailableRules) {
    if (await anyExactVisible(page, [rule.selector])) facts.add(rule.reason);
  }
  return [...facts];
}

async function anyExactVisible(
  page: WorkdayStructuralPage,
  selectors: readonly string[],
): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if (
      await locator.count() === 1 &&
      (locator.isVisible === undefined || await locator.isVisible())
    ) return true;
  }
  return false;
}

async function boundedCount(
  page: WorkdayStructuralPage,
  selector: string,
): Promise<number> {
  const count = await page.locator(selector).count();
  if (!Number.isInteger(count) || count < 0) throw new TypeError("invalid structural count");
  return Math.min(count, 64);
}

function rule(traitId: string, selector: string): TraitRule {
  return Object.freeze({ traitId, selector });
}

function unavailable(
  reason: UnavailableRule["reason"],
  selector: string,
): UnavailableRule {
  return Object.freeze({ reason, selector });
}
