import type { Locator, Page } from "playwright";

import type {
  AccountActionIntent,
  AccountFieldName,
  SemanticAccountPageAdapter,
  SemanticControlFact,
} from "./account-page-types.ts";
import type { PersistentPage } from "./types.ts";

export type PlaywrightAccountPageTraceEvent =
  | "submit_click_started"
  | "submit_click_succeeded"
  | "submit_click_failed"
  | "submit_click_timeout"
  | "submit_click_detached"
  | "submit_click_intercepted"
  | "submit_click_unstable"
  | "submit_click_not_visible"
  | "submit_click_disabled"
  | "submit_click_closed"
  | "submit_click_ambiguous"
  | "submit_click_other"
  | "submit_control_remained_visible"
  | "submit_destination_observed"
  | "submit_rejection_reappeared"
  | "submit_stabilization_failed";

export interface PlaywrightAccountPageAdapterOptions {
  readonly trace?: (event: PlaywrightAccountPageTraceEvent) => void;
}

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

  constructor(options: PlaywrightAccountPageAdapterOptions = {}) {
    this.#trace = options.trace;
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
      if (submit) this.#emit("submit_click_started");
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
        const transitioned = await locator.waitFor({
          state: "hidden",
          timeout: 10_000,
        }).then(() => true, () => false);
        if (transitioned) {
          let observed: "destination" | "rejection";
          try {
            observed = await Promise.any([
            playwrightPage(page).locator(postSubmitDestination(action))
              .first()
              .waitFor({ state: "attached", timeout: 10_000 })
                .then(() => "destination" as const),
              locator.waitFor({ state: "attached", timeout: 10_000 })
                .then(() => "rejection" as const),
            ]);
          } catch (error) {
            this.#emit("submit_stabilization_failed");
            throw error;
          }
          this.#emit(
            observed === "destination"
              ? "submit_destination_observed"
              : "submit_rejection_reappeared",
          );
        } else this.#emit("submit_control_remained_visible");
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

function classifyClickFailure(error: unknown): PlaywrightAccountPageTraceEvent {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("detached")) return "submit_click_detached";
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
        locator: semanticPage.locator('[data-automation-id="signInSubmitButton"]'),
        field: false,
      };
    case "submit_create_account":
      return {
        locator: semanticPage.locator('[data-automation-id="createAccountSubmitButton"]'),
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
