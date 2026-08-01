import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { livePortNames } from "../../src/contracts/live/index.ts";

test("F1-T2 remains inside F3 ownership and does not widen the frozen live ports", async () => {
  assert.deepEqual(livePortNames, [
    "PersistentBrowserSession",
    "SecretStore",
    "CredentialMutationAdapter",
    "PrivilegedGmailAuthExecutor",
    "MailboxProvider",
    "VerificationArtifact",
    "PrivilegedVerificationNavigator",
    "LiveCheckpointStore",
    "LiveEvidenceSink",
  ]);
  const session = await source("session.ts");
  const factory = await source("factory.ts");
  for (const forbidden of [
    "/ats/",
    "/form/",
    "/testing/",
    "/live/preflight/",
    "connectOverCDP",
    "bringToFront",
  ]) {
    assert.equal((session + factory).includes(forbidden), false, forbidden);
  }
});

test("owned inspection remains a class capability with value-free fields", async () => {
  const liveTypes = await source("private/types.ts");
  const publicFacade = await source("index.ts");
  assert.match(liveTypes, /ValueFreeOwnedPageSnapshot/u);
  assert.match(liveTypes, /traitIds/u);
  for (const forbidden of ["rawHtml", "rawText", "origin", "pathname", "href"]) {
    assert.equal(liveTypes.includes(forbidden), false, forbidden);
  }
  assert.equal(publicFacade.includes("OwnedTargetProbe"), false);
  assert.equal(publicFacade.includes("ValueFreeOwnedPageSnapshot"), false);
});

test("account-page access remains private, semantic, and value-free", async () => {
  const capability = await source("private/account-page-types.ts");
  const scope = await source("private/owned-account-page-access.ts");
  const factory = await source("factory.ts");
  const publicFacade = await source("index.ts");
  for (const semanticName of [
    "email",
    "password",
    "password_confirmation",
    "show_sign_in",
    "show_create_account",
    "submit_sign_in",
    "submit_create_account",
  ]) assert.equal(capability.includes(semanticName), true, semanticName);
  for (const forbidden of [
    "readonly page",
    "readonly locator",
    "readonly url",
    "readonly dom",
    "readonly selector",
    "readonly text",
    "readonly plaintext",
  ]) {
    assert.equal(capability.toLowerCase().includes(forbidden), false, forbidden);
  }
  assert.equal(scope.includes("bytes.slice()"), true);
  assert.equal(scope.includes("transient.fill(0)"), true);
  assert.equal(publicFacade.includes("OwnedAccountPageAccess"), false);
  assert.equal(publicFacade.includes("AccountFieldName"), false);
  assert.equal(publicFacade.includes("SemanticAccountPageAdapter"), false);
  assert.equal(factory.includes("new PlaywrightAccountPageAdapter()"), true);
});

test("posting navigation is private, semantic, bounded, and submit-free", async () => {
  const navigator = await source("private/playwright-posting-navigation.ts");
  const capability = await source("private/account-navigation-types.ts");
  const session = await source("session.ts");
  const publicFacade = await source("index.ts");
  for (const required of ["start_application", "apply_manually"]) {
    assert.equal((navigator + capability).includes(required), true, required);
  }
  for (const forbidden of ["credential", "password", "submit", "rawHtml", "rawText"]) {
    assert.equal((navigator + session).toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  assert.equal(publicFacade.includes("PostingNavigation"), false);
  assert.match(session, /transitionCount < 2/u);
});

async function source(relativePath: string): Promise<string> {
  return readFile(
    new URL(`../../src/browser/playwright-live/${relativePath}`, import.meta.url),
    "utf8",
  );
}
