import type {
  AccountActionIntent,
  AccountFieldName,
  SemanticControlFact,
} from "./account-page-types.ts";
import type { ValueFreeOwnedPageSnapshot } from "./types.ts";

interface CountableLocator {
  count(): Promise<number>;
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
  readonly reason: "not_found" | "closed" | "removed" | "unavailable";
  readonly selector: string;
}

const pageRules = Object.freeze([
  rule("structural_trait_navigation_apply_choice_v1", '[data-automation-id="applyManually"]'),
  rule("structural_trait_navigation_apply_choice_v1", '[data-automation-id="applyManuallyButton"]'),
  rule("structural_trait_navigation_apply_choice_v1", 'a[href$="/apply/applyManually"]'),
  rule("structural_trait_page_account_entry_v1", '[data-automation-id="createAccountPage"]'),
  rule("structural_trait_page_account_entry_v1", '[data-automation-id="signInPage"]'),
  rule("structural_trait_page_account_entry_v1", '[data-automation-id="authPage"]'),
  rule("structural_trait_page_email_verification_v1", '[data-automation-id="emailVerificationPage"]'),
  rule("structural_trait_page_email_verification_v1", '[data-automation-id="verifyEmailPage"]'),
  rule("structural_trait_page_candidate_home_v1", '[data-automation-id="candidateHomePage"]'),
  rule("structural_trait_page_profile_step_v1", '[data-automation-id="applyFlowMyInfoPage"]'),
  rule("structural_trait_page_questionnaire_v1", '[data-automation-id="applyFlowApplicationQuestionsPage"]'),
  rule("structural_trait_page_review_step_v1", '[data-automation-id="applyFlowReviewPage"]'),
] satisfies readonly TraitRule[]);

const accountRules = Object.freeze([
  rule("structural_trait_account_sign_in_v1", '[data-automation-id="signInPage"]'),
  rule("structural_trait_account_sign_in_v1", '[data-automation-id="signInSubmitButton"]'),
  rule("structural_trait_account_create_v1", '[data-automation-id="createAccountPage"]'),
  rule("structural_trait_account_create_v1", '[data-automation-id="createAccountSubmitButton"]'),
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
  unavailable("closed", '[data-automation-id="jobClosedPage"]'),
  unavailable("removed", '[data-automation-id="jobRemovedPage"]'),
  unavailable("unavailable", '[data-automation-id="jobUnavailablePage"]'),
] satisfies readonly UnavailableRule[]);

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
  for (const rule of [...pageRules, ...accountRules, ...challengeRules]) {
    if (await present(page, rule.selector)) traitIds.push(rule.traitId);
  }
  const semanticAccount = await inspectSemanticAccount(account);
  if (semanticAccount !== undefined) {
    traitIds.push("structural_trait_page_account_entry_v1");
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

async function inspectSemanticAccount(
  account: WorkdaySemanticAccountInspector,
): Promise<"create" | "sign_in" | undefined> {
  const email = await account.inspect("email");
  const password = await account.inspect("password");
  const confirmation = await account.inspect("password_confirmation");
  const create = await account.inspect("submit_create_account");
  const signIn = await account.inspect("submit_sign_in");
  if (!exactActionable(email) || !exactActionable(password)) return undefined;
  if (
    exactActionable(confirmation) &&
    exactActionable(create) &&
    exactActionable(signIn)
  ) return "create";
  if (
    confirmation.cardinality === 0 &&
    exactActionable(signIn) &&
    exactActionable(create)
  ) return "sign_in";
  return undefined;
}

function exactActionable(fact: SemanticControlFact): boolean {
  return fact.cardinality === 1 && fact.actionable;
}

async function matchingUnavailable(
  page: WorkdayStructuralPage,
): Promise<Array<UnavailableRule["reason"]>> {
  const facts: Array<UnavailableRule["reason"]> = [];
  for (const rule of unavailableRules) {
    if (await present(page, rule.selector)) facts.push(rule.reason);
  }
  return facts;
}

async function present(page: WorkdayStructuralPage, selector: string): Promise<boolean> {
  return await page.locator(selector).count() > 0;
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
