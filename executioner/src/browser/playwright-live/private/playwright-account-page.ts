import type { Locator, Page } from "playwright";

import type {
  AccountActionIntent,
  AccountFieldName,
  SemanticAccountPageAdapter,
  SemanticControlFact,
} from "./account-page-types.ts";
import type { PersistentPage } from "./types.ts";

export class PlaywrightAccountPageAdapter implements SemanticAccountPageAdapter {
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
    await semanticLocator(page, field).locator.clear();
  }

  async isEmpty(page: PersistentPage, field: AccountFieldName): Promise<boolean> {
    return await semanticLocator(page, field).locator.inputValue() === "";
  }

  async activate(page: PersistentPage, action: AccountActionIntent): Promise<void> {
    await semanticLocator(page, action).locator.click();
  }
}

function playwrightPage(page: PersistentPage): Pick<Page, "getByLabel" | "getByRole"> {
  return page as unknown as Pick<Page, "getByLabel" | "getByRole">;
}

function semanticLocator(
  page: PersistentPage,
  control: AccountFieldName | AccountActionIntent,
): { readonly locator: Locator; readonly field: boolean } {
  const semanticPage = playwrightPage(page);
  switch (control) {
    case "email":
      return {
        locator: semanticPage.getByLabel("Email Address", { exact: true }),
        field: true,
      };
    case "password":
      return {
        locator: semanticPage.getByLabel("Password", { exact: true }),
        field: true,
      };
    case "password_confirmation":
      return {
        locator: semanticPage.getByLabel("Verify New Password", { exact: true }),
        field: true,
      };
    case "show_sign_in":
      return {
        locator: semanticPage.getByRole("link", { name: "Sign In", exact: true }),
        field: false,
      };
    case "show_create_account":
      return {
        locator: semanticPage.getByRole("link", { name: "Create Account", exact: true }),
        field: false,
      };
    case "submit_sign_in":
      return {
        locator: semanticPage.getByRole("button", { name: "Sign In", exact: true }),
        field: false,
      };
    case "submit_create_account":
      return {
        locator: semanticPage.getByRole("button", { name: "Create Account", exact: true }),
        field: false,
      };
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}
