import type { ClassifiedAccountObservationSource } from "../ats/workday/live/index.ts";
import type { PlaywrightPersistentBrowserSession } from "../browser/playwright-live/session.ts";
import { createAccountEntryCredentialMutationAdapter } from "../account/entry/index.ts";
import type { CredentialMutationAdapter } from "../contracts/live/index.ts";
import type { AccountCredentialResolver } from "../secrets/windows-dpapi/private/resolver.ts";

export function createStage2AccountEntryCredentialMutationAdapter(
  browser: Pick<PlaywrightPersistentBrowserSession, "withOwnedAccountPageAccess">,
  classifiedAccount: ClassifiedAccountObservationSource,
  credentials: AccountCredentialResolver,
): CredentialMutationAdapter {
  return createAccountEntryCredentialMutationAdapter({
    accountPage: browser,
    classifiedAccount,
    credentials,
  });
}
