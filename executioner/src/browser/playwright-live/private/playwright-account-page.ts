import type { Locator, Page } from "playwright";

import type {
  AccountActionIntent,
  AccountFieldName,
  SemanticAccountPageAdapter,
  SemanticControlFact,
} from "./account-page-types.ts";
import type { PersistentPage } from "./types.ts";
import {
  WORKDAY_ACCOUNT_FACT_SELECTORS,
  WORKDAY_INLINE_VERIFICATION_SELECTORS,
  WORKDAY_SIGN_IN_REJECTION_SELECTORS,
} from "./workday-structural-catalog.ts";

export type PlaywrightAccountPageTraceEvent =
  | "submit_click_started"
  | "submit_click_succeeded"
  | "submit_click_failed"
  | "submit_click_timeout"
  | "submit_click_detached"
  | "submit_click_intercepted"
  | "submit_click_loading_overlay"
  | "submit_click_privacy_overlay"
  | "submit_click_modal_overlay"
  | "submit_click_iframe_overlay"
  | "submit_click_layout_overlay"
  | "submit_click_unstable"
  | "submit_click_not_visible"
  | "submit_click_disabled"
  | "submit_click_closed"
  | "submit_click_ambiguous"
  | "submit_click_other"
  | "submit_hit_target_clear"
  | "submit_hit_target_fixed_overlay"
  | "submit_hit_target_dialog_overlay"
  | "submit_hit_target_iframe_overlay"
  | "submit_hit_target_generic_overlay"
  | "submit_hit_target_ancestor_overlay"
  | "submit_hit_target_sibling_overlay"
  | "submit_hit_target_same_form_overlay"
  | "submit_hit_target_large_overlay"
  | "submit_hit_target_small_overlay"
  | "submit_hit_target_unavailable"
  | "submit_control_remained_visible"
  | "submit_diagnostic_page_sign_in"
  | "submit_diagnostic_page_create_account"
  | "submit_diagnostic_page_unknown"
  | "submit_diagnostic_alert_credentials_or_locked"
  | "submit_diagnostic_alert_unknown"
  | "submit_diagnostic_alert_none"
  | "submit_diagnostic_create_account_available"
  | "submit_diagnostic_create_account_unavailable"
  | "submit_diagnostic_submit_visible"
  | "submit_diagnostic_submit_hidden"
  | "submit_diagnostic_action_sign_in"
  | "submit_diagnostic_action_create_account"
  | "submit_inspection_hold_started"
  | "submit_inspection_hold_ended"
  | "submit_exact_fact_observed"
  | "submit_destination_observed"
  | "submit_rejection_reappeared"
  | "submit_rejection_submit_owner_wait_failed"
  | "submit_rejection_email_wait_failed"
  | "submit_rejection_password_wait_failed"
  | "submit_rejection_password_confirmation_wait_failed"
  | "submit_stabilization_failed";

interface AccountSubmitFailureDiagnosticV1 {
  readonly schemaVersion: 1;
  readonly action: "submit_sign_in" | "submit_create_account";
  readonly page: "sign_in" | "create_account" | "unknown";
  readonly alert: "credentials_or_locked" | "unknown_visible" | "none";
  readonly createAccountActionAvailable: boolean;
  readonly submitControlVisible: boolean;
  readonly rawPageTextRetained: false;
  readonly credentialValuesRetained: false;
}

export interface PlaywrightAccountPageAdapterOptions {
  readonly trace?: (event: PlaywrightAccountPageTraceEvent) => void;
  readonly unsettledInspectionHold?: () => Promise<void>;
}

const WORKDAY_VISIBLE_ALERT_SELECTOR = '[role="alert"]';

const POST_SUBMIT_DESTINATIONS = [
  '[data-automation-id="emailVerificationPage"]',
  '[data-automation-id="verifyEmailPage"]',
  '[data-automation-id="candidateHomePage"]',
  '[data-automation-id="applyFlowMyInfoPage"]',
  '[data-automation-id="applyFlowApplicationQuestionsPage"]',
  '[data-automation-id="applyFlowReviewPage"]',
  '[data-automation-id="captchaChallenge"]',
  'iframe[title="reCAPTCHA"]',
  'iframe[title="hCaptcha"]',
  '[data-automation-id="mfaChallenge"]',
  '[data-automation-id="accessDeniedPage"]',
  '[data-automation-id="securityChallenge"]',
];

export class PlaywrightAccountPageAdapter implements SemanticAccountPageAdapter {
  readonly #trace: PlaywrightAccountPageAdapterOptions["trace"];
  readonly #unsettledInspectionHold: PlaywrightAccountPageAdapterOptions[
    "unsettledInspectionHold"
  ];

  constructor(options: PlaywrightAccountPageAdapterOptions = {}) {
    this.#trace = options.trace;
    this.#unsettledInspectionHold = options.unsettledInspectionHold;
  }

  async inspect(
    page: PersistentPage,
    control: AccountFieldName | AccountActionIntent,
  ): Promise<SemanticControlFact> {
    const { locator, field } = semanticLocator(page, control);
    const cardinality = await locator.count();
    const actionable = cardinality === 1 &&
      await locator.isVisible() &&
      await locator.isEnabled() &&
      (!field || await locator.isEditable());
    return { cardinality, actionable };
  }

  async fill(page: PersistentPage, field: AccountFieldName, bytes: Uint8Array): Promise<void> {
    let plaintext = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    try {
      await semanticLocator(page, field).locator.fill(plaintext);
    } finally {
      plaintext = "";
    }
  }

  async matches(page: PersistentPage, field: AccountFieldName, bytes: Uint8Array): Promise<boolean> {
    const actual = new TextEncoder().encode(
      await semanticLocator(page, field).locator.inputValue(),
    );
    try {
      return sameBytes(actual, bytes);
    } finally {
      actual.fill(0);
    }
  }

  async clear(page: PersistentPage, field: AccountFieldName): Promise<void> {
    await semanticLocator(page, field).locator.evaluate((element) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input) as object,
        "value",
      )?.set;
      if (setter === undefined) input.value = "";
      else setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async isEmpty(page: PersistentPage, field: AccountFieldName): Promise<boolean> {
    return await semanticLocator(page, field).locator.inputValue() === "";
  }

  async activate(page: PersistentPage, action: AccountActionIntent): Promise<void> {
    const locator = semanticLocator(page, action).locator;
    if (action === "accept_terms") await locator.check();
    else {
      const submit = action === "submit_sign_in" || action === "submit_create_account";
      let postClickExactFactLocators: readonly Locator[] = [];
      let credentialsOrLockedCanSettle = false;
      if (submit) {
        const factSelectors = postSubmitExactFactSelectors(action);
        const candidates = factSelectors.map((selector) =>
          playwrightPage(page).locator(selector)
        );
        const visibleBeforeClick = await Promise.all(candidates.map((candidate) =>
          candidate.isVisible()
        ));
        postClickExactFactLocators = candidates.filter(
          (_candidate, index) => !visibleBeforeClick[index],
        );
        credentialsOrLockedCanSettle = factSelectors.some((selector, index) =>
          selector === WORKDAY_SIGN_IN_REJECTION_SELECTORS.credentialsOrLocked &&
          !visibleBeforeClick[index]
        );
        const hitTarget = await inspectSubmitHitTarget(locator);
        this.#emit(hitTarget);
        this.#emit("submit_click_started");
      }
      try {
        await locator.click();
      } catch (error) {
        if (submit) {
          this.#emit("submit_click_failed");
          this.#emit(classifyClickFailure(error));
        }
        throw error;
      }
      if (submit) {
        this.#emit("submit_click_succeeded");
        const exactFact = waitForExactFact(postClickExactFactLocators);
        let initial: "transition" | "exact_fact";
        try {
          initial = await Promise.any([
            locator.waitFor({
              state: "hidden",
              timeout: 10_000,
            }).then(() => "transition" as const),
            exactFact,
          ]);
        } catch {
          this.#emit("submit_control_remained_visible");
          const diagnostic = await inspectSubmitFailure(page, action, locator);
          this.#emit(`submit_diagnostic_page_${diagnostic.page}`);
          this.#emit(
            diagnostic.action === "submit_sign_in"
              ? "submit_diagnostic_action_sign_in"
              : "submit_diagnostic_action_create_account",
          );
          this.#emit(
            diagnostic.alert === "credentials_or_locked"
              ? "submit_diagnostic_alert_credentials_or_locked"
              : diagnostic.alert === "unknown_visible"
                ? "submit_diagnostic_alert_unknown"
                : "submit_diagnostic_alert_none",
          );
          this.#emit(
            diagnostic.createAccountActionAvailable
              ? "submit_diagnostic_create_account_available"
              : "submit_diagnostic_create_account_unavailable",
          );
          this.#emit(
            diagnostic.submitControlVisible
              ? "submit_diagnostic_submit_visible"
              : "submit_diagnostic_submit_hidden",
          );
          if (this.#unsettledInspectionHold !== undefined) {
            this.#emit("submit_inspection_hold_started");
            try {
              await this.#unsettledInspectionHold();
            } catch {
              // Diagnostic holding cannot alter the fixed browser outcome.
            }
            this.#emit("submit_inspection_hold_ended");
          }
          throw new Error("submit effect did not settle");
        }
        if (initial === "exact_fact") {
          if (
            credentialsOrLockedCanSettle &&
            await exactVisible(playwrightPage(page).locator(
              WORKDAY_SIGN_IN_REJECTION_SELECTORS.credentialsOrLocked,
            ))
          ) this.#emit("submit_diagnostic_alert_credentials_or_locked");
          this.#emit("submit_exact_fact_observed");
        } else {
          let observed: "destination" | "rejection" | "exact_fact";
          try {
            try {
              observed = await Promise.any([
                exactFact,
                playwrightPage(page).locator(postSubmitDestination(action))
                  .first()
                  .waitFor({ state: "attached", timeout: 10_000 })
                  .then(() => "destination" as const),
                locator.waitFor({ state: "visible", timeout: 10_000 })
                  .then(() => "rejection" as const),
              ]);
            } catch (error) {
              this.#emit("submit_rejection_submit_owner_wait_failed");
              throw error;
            }
            if (observed === "exact_fact") {
              if (
                credentialsOrLockedCanSettle &&
                await exactVisible(playwrightPage(page).locator(
                  WORKDAY_SIGN_IN_REJECTION_SELECTORS.credentialsOrLocked,
                ))
              ) this.#emit("submit_diagnostic_alert_credentials_or_locked");
              this.#emit("submit_exact_fact_observed");
              return;
            }
            if (observed === "rejection") {
              const readinessWaits: Array<readonly [
                Locator,
                PlaywrightAccountPageTraceEvent,
              ]> = [
                [locator, "submit_rejection_submit_owner_wait_failed"],
                [
                  semanticLocator(page, "email").locator,
                  "submit_rejection_email_wait_failed",
                ],
                [
                  semanticLocator(page, "password").locator,
                  "submit_rejection_password_wait_failed",
                ],
              ];
              if (action === "submit_create_account") {
                readinessWaits.push([
                  semanticLocator(page, "password_confirmation").locator,
                  "submit_rejection_password_confirmation_wait_failed",
                ]);
              }
              await Promise.all(readinessWaits.map(async ([readinessLocator, failureEvent]) => {
                try {
                  await readinessLocator.waitFor({ state: "visible", timeout: 10_000 });
                } catch (error) {
                  this.#emit(failureEvent);
                  throw error;
                }
              }));
              try {
                await exactFact;
                this.#emit("submit_exact_fact_observed");
                return;
              } catch {
                // The exact-marker boundary elapsed; F5 may now classify the stable rejection.
              }
            }
          } catch (error) {
            this.#emit("submit_stabilization_failed");
            throw error;
          }
          this.#emit(
            observed === "destination"
              ? "submit_destination_observed"
              : "submit_rejection_reappeared",
          );
        }
      }
    }
  }

  #emit(event: PlaywrightAccountPageTraceEvent): void {
    try {
      this.#trace?.(event);
    } catch {
      // Diagnostic observation cannot affect browser behavior.
    }
  }
}

async function inspectSubmitFailure(
  page: PersistentPage,
  action: "submit_sign_in" | "submit_create_account",
  submit: Locator,
): Promise<AccountSubmitFailureDiagnosticV1> {
  try {
    const source = playwrightPage(page);
    const [signIn, createAccount, knownAlert, anyAlert, createAccountAction, submitVisible] =
      await Promise.all([
        exactVisible(source.locator('[data-automation-id="signInPage"]')),
        exactVisible(source.locator('[data-automation-id="createAccountPage"]')),
        exactVisible(source.locator(WORKDAY_SIGN_IN_REJECTION_SELECTORS.credentialsOrLocked)),
        exactVisible(source.locator(WORKDAY_VISIBLE_ALERT_SELECTOR)),
        exactActionable(source.locator('[data-automation-id="createAccountLink"]')),
        submit.isVisible(),
      ]);
    return Object.freeze({
      schemaVersion: 1,
      action,
      page: signIn === createAccount ? "unknown" : signIn ? "sign_in" : "create_account",
      alert: knownAlert ? "credentials_or_locked" : anyAlert ? "unknown_visible" : "none",
      createAccountActionAvailable: createAccountAction,
      submitControlVisible: submitVisible,
      rawPageTextRetained: false,
      credentialValuesRetained: false,
    });
  } catch {
    return Object.freeze({
      schemaVersion: 1,
      action,
      page: "unknown",
      alert: "none",
      createAccountActionAvailable: false,
      submitControlVisible: true,
      rawPageTextRetained: false,
      credentialValuesRetained: false,
    });
  }
}

async function exactVisible(locator: Locator): Promise<boolean> {
  return await locator.count() === 1 && await locator.isVisible();
}

async function exactActionable(locator: Locator): Promise<boolean> {
  return await locator.count() === 1 && await locator.isVisible() && await locator.isEnabled();
}

async function inspectSubmitHitTarget(
  locator: Locator,
): Promise<PlaywrightAccountPageTraceEvent> {
  try {
    const result = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      if (top === null) return "unavailable";
      if (top === element || element.contains(top)) return "clear";
      if (top.contains(element)) return "ancestor_overlay";
      if (top.parentElement === element.parentElement) return "sibling_overlay";
      const targetForm = element.closest("form");
      if (targetForm !== null && top.closest("form") === targetForm) {
        return "same_form_overlay";
      }
      if (top.closest('[role="dialog"], [aria-modal="true"]') !== null) {
        return "dialog_overlay";
      }
      if (top instanceof HTMLIFrameElement) return "iframe_overlay";
      for (let current: Element | null = top; current !== null; current = current.parentElement) {
        const position = getComputedStyle(current).position;
        if (position === "fixed" || position === "sticky") return "fixed_overlay";
      }
      const topRect = top.getBoundingClientRect();
      const viewportArea = Math.max(1, innerWidth * innerHeight);
      const topArea = Math.max(0, topRect.width * topRect.height);
      return topArea >= viewportArea / 4 ? "large_overlay" : "small_overlay";
    });
    return `submit_hit_target_${result}` as PlaywrightAccountPageTraceEvent;
  } catch {
    return "submit_hit_target_unavailable";
  }
}

function classifyClickFailure(error: unknown): PlaywrightAccountPageTraceEvent {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("detached")) return "submit_click_detached";
  if (
    message.includes("loading") ||
    message.includes("spinner") ||
    message.includes("progress")
  ) return "submit_click_loading_overlay";
  if (
    message.includes("cookie") ||
    message.includes("privacy") ||
    message.includes("consent")
  ) return "submit_click_privacy_overlay";
  if (
    message.includes("aria-modal=\"true\"") ||
    message.includes("role=\"dialog\"") ||
    message.includes("modal")
  ) return "submit_click_modal_overlay";
  if (message.includes("<iframe")) return "submit_click_iframe_overlay";
  if (
    message.includes("sticky") ||
    message.includes("<header") ||
    message.includes("<footer")
  ) return "submit_click_layout_overlay";
  if (message.includes("intercepts pointer events")) return "submit_click_intercepted";
  if (message.includes("element is not stable")) return "submit_click_unstable";
  if (message.includes("element is not visible")) return "submit_click_not_visible";
  if (message.includes("element is not enabled")) return "submit_click_disabled";
  if (message.includes("page, context or browser has been closed")) {
    return "submit_click_closed";
  }
  if (message.includes("strict mode violation")) return "submit_click_ambiguous";
  if (name === "TimeoutError") return "submit_click_timeout";
  return "submit_click_other";
}

function postSubmitDestination(
  action: "submit_sign_in" | "submit_create_account",
): string {
  const opposingAccountPage = action === "submit_sign_in"
    ? '[data-automation-id="createAccountPage"]'
    : '[data-automation-id="signInPage"]';
  return [opposingAccountPage, ...POST_SUBMIT_DESTINATIONS].join(", ");
}

function postSubmitExactFactSelectors(
  action: "submit_sign_in" | "submit_create_account",
): readonly string[] {
  return action === "submit_sign_in"
    ? [
        WORKDAY_ACCOUNT_FACT_SELECTORS.absent,
        ...WORKDAY_INLINE_VERIFICATION_SELECTORS,
        WORKDAY_SIGN_IN_REJECTION_SELECTORS.credentialsOrLocked,
      ]
    : [WORKDAY_ACCOUNT_FACT_SELECTORS.exists];
}

function waitForExactFact(
  locators: readonly Locator[],
): Promise<"exact_fact"> {
  return Promise.any(locators.map((locator) =>
    locator.waitFor({ state: "visible", timeout: 10_000 })
  )).then(() => "exact_fact" as const);
}

function playwrightPage(page: PersistentPage): Pick<Page, "locator"> {
  return page as unknown as Pick<Page, "locator">;
}

function semanticLocator(
  page: PersistentPage,
  control: AccountFieldName | AccountActionIntent,
): { readonly locator: Locator; readonly field: boolean } {
  const semanticPage = playwrightPage(page);
  switch (control) {
    case "email":
      return {
        locator: semanticPage.locator('[data-automation-id="email"]'),
        field: true,
      };
    case "password":
      return {
        locator: semanticPage.locator('[data-automation-id="password"]'),
        field: true,
      };
    case "password_confirmation":
      return {
        locator: semanticPage.locator('[data-automation-id="verifyPassword"]'),
        field: true,
      };
    case "show_sign_in":
      return {
        locator: semanticPage.locator('[data-automation-id="signInLink"]'),
        field: false,
      };
    case "show_create_account":
      return {
        locator: semanticPage.locator('[data-automation-id="createAccountLink"]'),
        field: false,
      };
    case "submit_sign_in":
      return {
        locator: semanticPage.locator(
          '[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="signInSubmitButton"]) [data-automation-id="click_filter"][role="button"]',
        ),
        field: false,
      };
    case "submit_create_account":
      return {
        locator: semanticPage.locator(
          '[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="createAccountSubmitButton"]) [data-automation-id="click_filter"][role="button"]',
        ),
        field: false,
      };
    case "accept_terms":
      return {
        locator: semanticPage.locator('[data-automation-id="createAccountCheckbox"]'),
        field: false,
      };
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}
