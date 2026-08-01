import type { ClassifiedAccountObservationSource } from "../ats/workday/live/index.ts";
import type { AccountEntryTraceEvent } from "../account/entry/index.ts";
import type { PlaywrightPersistentBrowserSession } from "../browser/playwright-live/session.ts";
import { createAccountEntryCredentialMutationAdapter } from "../account/entry/index.ts";
import type { CredentialMutationAdapter } from "../contracts/live/index.ts";
import type { RealRunAccountMode } from "../live/preflight/types.ts";
import type { AccountCredentialResolver } from "../secrets/windows-dpapi/private/resolver.ts";

export function createStage2AccountEntryCredentialMutationAdapter(
  browser: Pick<PlaywrightPersistentBrowserSession, "withOwnedAccountPageAccess">,
  classifiedAccount: ClassifiedAccountObservationSource,
  credentials: AccountCredentialResolver,
  accountMode: RealRunAccountMode,
  trace?: (event: AccountEntryTraceEvent) => void,
): CredentialMutationAdapter {
  if (accountMode !== "fresh_create" && accountMode !== "sign_in") {
    throw new RangeError("account mode is outside the admitted preflight set");
  }
  const entry = createAccountEntryCredentialMutationAdapter({
    accountPage: browser,
    classifiedAccount,
    credentials,
    trace,
  });
  const adapter: CredentialMutationAdapter = {
    mutate: (request, signal) => entry.mutate({
      ...request,
      mode: accountMode === "fresh_create" ? "create_account" : "sign_in",
    }, signal),
  };
  return Object.freeze(adapter);
}
