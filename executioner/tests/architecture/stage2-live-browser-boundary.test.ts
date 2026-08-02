import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { livePortNames } from "../../src/contracts/live/index.ts";
import { resolveLiveInspectionHoldPolicy } from "../../src/browser/playwright-live/factory.ts";

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
  assert.equal(
    factory.includes("new PlaywrightAccountPageAdapter({"),
    true,
  );
  assert.equal(factory.includes("trace: options.accountTrace"), true);
});

test("live inspection hold is exact opt-in with a bounded operation-timeout floor", () => {
  assert.deepEqual(resolveLiveInspectionHoldPolicy(undefined, undefined), {
    holdMs: 0,
    timeoutMs: 30_000,
  });
  assert.deepEqual(resolveLiveInspectionHoldPolicy("true", 12_000), {
    holdMs: 0,
    timeoutMs: 12_000,
  });
  assert.deepEqual(resolveLiveInspectionHoldPolicy("1", undefined), {
    holdMs: 45_000,
    timeoutMs: 70_000,
  });
  assert.deepEqual(resolveLiveInspectionHoldPolicy("1", 69_999), {
    holdMs: 45_000,
    timeoutMs: 70_000,
  });
  assert.deepEqual(resolveLiveInspectionHoldPolicy("1", 90_000), {
    holdMs: 45_000,
    timeoutMs: 90_000,
  });
});

test("factory wires the private hold without widening the public browser facade", async () => {
  const factory = await source("factory.ts");
  const publicFacade = await source("index.ts");
  assert.equal(factory.includes("HUNT_C3_LIVE_INSPECTION_HOLD"), true);
  assert.equal(factory.includes("unsettledInspectionHold"), true);
  assert.equal(publicFacade.includes("resolveLiveInspectionHoldPolicy"), false);
  assert.equal(publicFacade.includes("unsettledInspectionHold"), false);
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

test("verification navigation is private, byte-scoped, one-shot, and value-free", async () => {
  const capability = await source("private/verification-navigation-types.ts");
  const scope = await source("private/owned-verification-navigation-access.ts");
  const coordinator = await source("private/owned-verification-navigation-coordinator.ts");
  const factory = await source("factory.ts");
  const publicFacade = await source("index.ts");
  for (const required of [
    "verificationTarget",
    "approvedHost",
    "approvedTenant",
    "navigateVerificationTarget",
  ]) assert.equal(capability.includes(required), true, required);
  for (const forbidden of [
    "readonly page",
    "readonly url",
    "readonly href",
    "readonly token",
    "readonly text",
    "accountState",
  ]) {
    assert.equal(capability.includes(forbidden), false, forbidden);
  }
  assert.match(scope, /targetBytes\.fill\(0\)/u);
  assert.match(scope, /hostBytes\.fill\(0\)/u);
  assert.match(scope, /tenantBytes\.fill\(0\)/u);
  assert.match(coordinator, /isStablePostVerificationState/u);
  assert.equal(factory.includes("new PlaywrightVerificationNavigationAdapter()"), true);
  assert.equal(publicFacade.includes("VerificationNavigationAccess"), false);
  assert.equal(publicFacade.includes("ByteScopedVerification"), false);
});

async function source(relativePath: string): Promise<string> {
  return readFile(
    new URL(`../../src/browser/playwright-live/${relativePath}`, import.meta.url),
    "utf8",
  );
}
