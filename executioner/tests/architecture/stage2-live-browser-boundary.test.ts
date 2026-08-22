import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { livePortNames } from "../../src/contracts/live/index.ts";
import {
  exactTestFlag,
  privateTestBrowserMode,
  resolveExternalMonitorOperationTimeoutMs,
  resolveLiveInspectionHoldPolicy,
} from "../../src/browser/playwright-live/factory.ts";

test("private test browser mode is an exact opt-in", () => {
  assert.equal(privateTestBrowserMode(undefined), "persistent");
  assert.equal(privateTestBrowserMode("true"), "persistent");
  assert.equal(privateTestBrowserMode("1"), "private_test");
  assert.equal(exactTestFlag(undefined), false);
  assert.equal(exactTestFlag("true"), false);
  assert.equal(exactTestFlag("1"), true);
});

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
    holdMs: 180_000,
    timeoutMs: 210_000,
  });
  assert.deepEqual(resolveLiveInspectionHoldPolicy("1", 69_999), {
    holdMs: 180_000,
    timeoutMs: 210_000,
  });
  assert.deepEqual(resolveLiveInspectionHoldPolicy("1", 240_000), {
    holdMs: 180_000,
    timeoutMs: 240_000,
  });
});

test("external monitoring gets a separate bounded application-operation budget", () => {
  assert.equal(resolveExternalMonitorOperationTimeoutMs(false, 30_000), undefined);
  assert.equal(resolveExternalMonitorOperationTimeoutMs(true, 30_000), 1_800_000);
  assert.equal(resolveExternalMonitorOperationTimeoutMs(true, 420_000), 1_800_000);
  assert.equal(resolveExternalMonitorOperationTimeoutMs(true, 1_000_000), 1_800_000);
  assert.equal(resolveExternalMonitorOperationTimeoutMs(true, 2_000_000), 2_000_000);
});

test("factory wires the private hold without widening the public browser facade", async () => {
  const factory = await source("factory.ts");
  const session = await source("session.ts");
  const publicFacade = await source("index.ts");
  assert.equal(factory.includes("HUNT_C3_LIVE_INSPECTION_HOLD"), true);
  assert.equal(factory.includes("unsettledInspectionHold"), true);
  assert.match(
    factory,
    /const unsettledInspectionHold = options\.externalMonitor === undefined\s+\? inspectionHold\s+: undefined/u,
  );
  assert.doesNotMatch(
    factory,
    /holdAction === undefined \|\| options\.externalMonitor !== undefined/u,
  );
  assert.match(factory, /inspectionHoldBeforeCleanup: inspectionHold/u);
  assert.match(factory, /applicationOperationTimeoutMs: resolveExternalMonitorOperationTimeoutMs/u);
  assert.match(factory, /applicationRuntime\?\.externalMonitor !== undefined/u);
  assert.match(session, /applicationOperationTimeoutMs \?\? this\.#options\.timeoutMs/u);
  assert.equal(publicFacade.includes("resolveLiveInspectionHoldPolicy"), false);
  assert.equal(publicFacade.includes("unsettledInspectionHold"), false);
});

test("production account access wires the lazy protected monitor hold", async () => {
  const composition = await readFile(
    "src/composition/s2-account-access-runner.ts",
    "utf8",
  );
  const factory = await source("factory.ts");
  assert.match(composition, /createOperatorMonitorInspectionHold/u);
  assert.match(composition, /owner\.roots\.runtime\.path/u);
  assert.doesNotMatch(composition, /writeOperatorMonitorRequest/u);
  assert.match(composition, /inspectionHold/u);
  assert.match(factory, /options\.inspectionHold/u);
});

test("full account verification uses the same lazy target-bound monitor hold", async () => {
  const composition = await readFile(
    "src/composition/s2-account-verified-runner.ts",
    "utf8",
  );
  assert.match(composition, /createOperatorMonitorInspectionHold/u);
  assert.doesNotMatch(composition, /writeOperatorMonitorRequest/u);
  assert.match(composition, /inspectionHold/u);
  assert.match(composition, /owner\.roots\.runtime\.path/u);
});

test("account-submit diagnostics remain fixed, value-free, and private", async () => {
  const accountPage = await source("private/playwright-account-page.ts");
  const publicFacade = await source("index.ts");
  const start = accountPage.indexOf("async function inspectSubmitFailure(");
  const end = accountPage.indexOf("async function exactVisible(", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const diagnostic = accountPage.slice(start, end);
  for (const required of [
    "submit_diagnostic_page_sign_in",
    "submit_diagnostic_alert_credentials_or_locked",
    "submit_diagnostic_create_account_available",
    "submit_diagnostic_action_sign_in",
    "submit_diagnostic_submit_visible",
    "rawPageTextRetained: false",
    "credentialValuesRetained: false",
  ]) assert.equal(accountPage.includes(required), true, required);
  for (const forbidden of [
    "textContent",
    "innerText",
    "screenshot",
    "inputValue",
    ".url(",
    ".evaluate(",
  ]) assert.equal(diagnostic.includes(forbidden), false, forbidden);
  assert.equal(publicFacade.includes("AccountSubmitFailureDiagnostic"), false);
  assert.equal(publicFacade.includes("submit_diagnostic_"), false);
});

test("posting navigation is private, semantic, bounded, and submit-free", async () => {
  const navigator = await source("private/playwright-posting-navigation.ts");
  const capability = await source("private/account-navigation-types.ts");
  const session = await source("session.ts");
  const publicFacade = await source("index.ts");
  for (const required of ["start_application", "apply_manually", "sign_in_with_email"]) {
    assert.equal((navigator + capability).includes(required), true, required);
  }
  for (const forbidden of ["credential", "password", "submit", "rawHtml", "rawText"]) {
    assert.equal((navigator + session).toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  assert.equal(publicFacade.includes("PostingNavigation"), false);
  assert.match(session, /transitionCount < 3/u);
  assert.match(session, /visitedStates\.has/u);
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
  assert.match(factory, /new PlaywrightVerificationNavigationAdapter\(\{[\s\S]*trace:/u);
  assert.equal(publicFacade.includes("VerificationNavigationAccess"), false);
  assert.equal(publicFacade.includes("ByteScopedVerification"), false);
});

async function source(relativePath: string): Promise<string> {
  return readFile(
    new URL(`../../src/browser/playwright-live/${relativePath}`, import.meta.url),
    "utf8",
  );
}
