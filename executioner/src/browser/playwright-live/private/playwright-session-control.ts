import type { Locator, Page } from "playwright";

import type {
  SemanticSessionControlAdapter,
  SessionLogoutResult,
} from "./session-control-types.ts";
import type { PersistentPage } from "./types.ts";

const accountMenuTrigger =
  '[data-automation-id="utilityButtonAccountTasksMenu"] ' +
  'button#accountSettingsButton[data-automation-id="utilityMenuButton"][aria-haspopup="true"]';
const accountMenu = '[role="menu"][aria-labelledby="accountSettingsButton"]';
const signOut = 'button[role="menuitem"][aria-label="Sign Out"]';
const signIn = 'button[data-automation-id="utilityButtonSignIn"]';

export type PlaywrightSessionControlTraceEvent =
  | "logout_already_signed_out"
  | "logout_signed_in_observed"
  | "logout_trigger_clicked"
  | "logout_menu_observed"
  | "logout_control_clicked"
  | "logout_network_settle_started"
  | "logout_network_settle_completed"
  | "logout_network_settle_timed_out"
  | "logout_reload_started"
  | "logout_reload_completed"
  | "logout_final_state_signed_in"
  | "logout_final_state_signed_out_hidden"
  | "logout_final_state_signed_out_disabled"
  | "logout_final_state_unknown"
  | "logout_verified";

export interface PlaywrightSessionControlAdapterOptions {
  readonly trace?: (event: PlaywrightSessionControlTraceEvent) => void;
  readonly settleTimeoutMs?: number;
}

export class PlaywrightSessionControlAdapter implements SemanticSessionControlAdapter {
  readonly #trace?: (event: PlaywrightSessionControlTraceEvent) => void;
  readonly #settleTimeoutMs: number;

  constructor(options: PlaywrightSessionControlAdapterOptions = {}) {
    this.#trace = options.trace;
    this.#settleTimeoutMs = settleTimeout(options.settleTimeoutMs ?? 5_000);
  }

  async logout(page: PersistentPage): Promise<SessionLogoutResult> {
    const source = page as unknown as Pick<
      Page,
      "locator" | "getByRole" | "reload" | "waitForLoadState"
    >;
    const trigger = source.locator(accountMenuTrigger);
    const signedOut = source.locator(signIn).and(source.getByRole("button", {
      name: "Sign In",
      exact: true,
    }));
    if (await exactActionable(signedOut) && await trigger.count() === 0) {
      this.#emit("logout_already_signed_out");
      return { kind: "already_signed_out" };
    }
    if (await signedOut.count() !== 0 || !await exactActionable(trigger)) {
      throw new Error("account state is not exactly signed in");
    }
    this.#emit("logout_signed_in_observed");

    await trigger.click();
    this.#emit("logout_trigger_clicked");
    const menu = source.locator(accountMenu);
    await menu.waitFor({ state: "visible", timeout: 10_000 });
    if (!await exactVisible(menu)) throw new Error("account menu is ambiguous");
    this.#emit("logout_menu_observed");
    const logout = menu.locator(signOut);
    if (!await exactActionable(logout)) throw new Error("sign out control is ambiguous");

    await logout.click();
    this.#emit("logout_control_clicked");
    try {
      await signedOut.waitFor({ state: "visible", timeout: this.#settleTimeoutMs });
    } catch {
      this.#emit("logout_network_settle_started");
      try {
        await source.waitForLoadState("networkidle", { timeout: 10_000 });
        this.#emit("logout_network_settle_completed");
      } catch {
        this.#emit("logout_network_settle_timed_out");
      }
      this.#emit("logout_reload_started");
      await source.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
      this.#emit("logout_reload_completed");
      try {
        await signedOut.waitFor({ state: "visible", timeout: 20_000 });
      } catch {
        this.#emit(await finalState(trigger, signedOut));
        throw new Error("signed-out marker did not appear");
      }
    }
    if (!await exactActionable(signedOut) || await trigger.count() !== 0) {
      throw new Error("signed-out state did not settle");
    }
    this.#emit("logout_verified");
    return { kind: "signed_out" };
  }

  #emit(event: PlaywrightSessionControlTraceEvent): void {
    try {
      this.#trace?.(event);
    } catch {
      // Value-free diagnostics cannot affect browser control.
    }
  }
}

function settleTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new TypeError("invalid logout settle timeout");
  }
  return value;
}

async function exactVisible(locator: Locator): Promise<boolean> {
  return await locator.count() === 1 && await locator.isVisible();
}

async function exactActionable(locator: Locator): Promise<boolean> {
  return await exactVisible(locator) && await locator.isEnabled();
}

async function finalState(
  trigger: Locator,
  signedOut: Locator,
): Promise<PlaywrightSessionControlTraceEvent> {
  if (await signedOut.count() === 1) {
    if (!await signedOut.isVisible()) return "logout_final_state_signed_out_hidden";
    if (!await signedOut.isEnabled()) return "logout_final_state_signed_out_disabled";
  }
  return await signedOut.count() === 0 && await exactActionable(trigger)
    ? "logout_final_state_signed_in"
    : "logout_final_state_unknown";
}
