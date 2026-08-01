import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { createStage2AccountEntryCredentialMutationAdapter } from "../../../src/composition/s2-account-entry.ts";
import type { ClassifiedAccountObservationSource } from "../../../src/ats/workday/live/index.ts";
import type { PlaywrightPersistentBrowserSession } from "../../../src/browser/playwright-live/session.ts";
import type { CredentialMutationResult } from "../../../src/contracts/live/index.ts";
import type { AccountCredentialResolver } from "../../../src/secrets/windows-dpapi/private/resolver.ts";

test("composition injects the accepted T2, T3, and T4 private capabilities", () => {
  const browser = {} as Pick<PlaywrightPersistentBrowserSession, "withOwnedAccountPageAccess">;
  const classified = {} as ClassifiedAccountObservationSource;
  const resolver = {} as AccountCredentialResolver;
  const adapter = createStage2AccountEntryCredentialMutationAdapter(
    browser,
    classified,
    resolver,
  );
  const structural: {
    mutate: (...args: never[]) => Promise<unknown>;
  } = adapter as never;
  assert.equal(typeof structural.mutate, "function");
  void (undefined as unknown as CredentialMutationResult);
});

test("account entry consumes classified state and semantic intents, never traits or DOM", () => {
  const source = [
    readFileSync("src/account/entry/adapter.ts", "utf8"),
    readFileSync("src/account/entry/types.ts", "utf8"),
  ].join("\n");
  assert.doesNotMatch(source, /traitIds|locator|selector|getByRole|raw(?:Text|Html)|document\./u);
  assert.match(source, /inspectClassifiedAccount/u);
  assert.match(source, /show_sign_in|show_create_account/u);
});
